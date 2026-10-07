"""État de l'éditeur : document, contexte d'édition, sélection, annuler / rétablir, évaluation de l'affichage.

Contextes d'édition :
- « scene » : la scène principale (calques dessinés dans la mire) ;
- « def »   : une forme personnalisée ouverte pour être modifiée (toutes ses occurrences suivent) ;
- « clip »  : un clip de la timeline ; la mire montre la timeline à la tête de lecture et les réglages
              touchés alimentent les automations du clip.
"""

import time

from PySide6.QtCore import QObject, Signal

from ..core import nodes as N
from ..core.document import Document
from ..core.evaluator import EvalContext, evaluate, evaluate_timeline
from ..core.history import History
from ..core.transform import TRANSFORM_LABELS
from .layer_ops import LayerOpsMixin
from .timeline_ops import TimelineOpsMixin
from .transform_ops import TransformOpsMixin


class EditorState(QObject, LayerOpsMixin, TimelineOpsMixin, TransformOpsMixin):
    docChanged = Signal()          # contenu modifié (rendu, panneaux)
    structureChanged = Signal()    # arbre des calques modifié
    selectionChanged = Signal()
    toolChanged = Signal(str)
    contextChanged = Signal()
    libraryChanged = Signal()
    timelineChanged = Signal()
    playheadChanged = Signal(float)
    gridChanged = Signal()
    historyChanged = Signal()
    projectChanged = Signal()
    statusMessage = Signal(str)
    clipSelected = Signal(str)
    restored = Signal()            # état remplacé (annuler / rétablir) : abandonner les gestes en cours
    audioChanged = Signal(str)
    brushChanged = Signal()

    def __init__(self, settings):
        super().__init__()
        self.settings = settings
        self.doc = Document()
        self.history = History()
        self.selection = []
        self.tool = "select"
        self.context = ("scene", None)
        self.view_source = "scene"
        self.playhead = 0.0
        self.preview_time = None   # instant prévisualisé pendant le déplacement d'une clé (sinon la tête de lecture)
        self.playing = False
        self.clipboard = []
        self.dirty = False
        self.selected_clip = None
        self.last_touched = None   # dernier calque créé / sélectionné / colorié (repris par l'outil Sélection)
        self.drawn = []            # calques créés depuis qu'on a pris un outil de dessin (crayon, formes)
        self.param_editing = False  # réglage en cours dans un panneau : la mire masque la sélection
        self._rev = 0
        self.content_rev = 0
        self._cache = None
        self._animated = False
        self._t0 = time.perf_counter()

    # ── Document ─────────────────────────────────────────────────────────
    def set_document(self, doc):
        self.doc = doc
        self.history.clear()
        self.selection = []
        self.context = ("scene", None)
        self.view_source = "scene"
        self.selected_clip = None
        self.playhead = 0.0
        self.preview_time = None
        self.dirty = False
        self._touch()
        self.projectChanged.emit()
        self.contextChanged.emit()
        self.structureChanged.emit()
        self.selectionChanged.emit()
        self.libraryChanged.emit()
        self.timelineChanged.emit()
        self.gridChanged.emit()
        self.historyChanged.emit()
        self.docChanged.emit()

    def state_dict(self):
        return self.doc.to_dict()

    def restore(self, d):
        path = self.doc.path
        old_audio = self.doc.timeline.audio_path
        doc = Document()
        doc.load_dict(d)
        doc.path = path
        self.doc = doc
        root = self.current_root()
        if root is None:
            self.context = ("scene", None)
            root = self.current_root()
        self.selection = [i for i in self.selection if root.find(i) is not None]
        self.notify(structure=True, library=True, timeline=True)
        self.selectionChanged.emit()
        self.contextChanged.emit()
        self.gridChanged.emit()
        self.restored.emit()
        if self.doc.timeline.audio_path != old_audio:
            self.audioChanged.emit(self.doc.timeline.audio_path)

    # ── Annuler / rétablir ───────────────────────────────────────────────
    def begin(self, label):
        self.history.begin(label, self.state_dict())

    def commit(self):
        if self.history.commit(self.state_dict()):
            self.dirty = True
            self.historyChanged.emit()
            self.projectChanged.emit()

    def mutate(self, label, fn, structure=True, library=False, timeline=False):
        self.begin(label)
        res = fn()
        self.commit()
        self.notify(structure=structure, library=library, timeline=timeline)
        return res

    def undo(self):
        self.history.cancel()
        d = self.history.undo(self.state_dict())
        if d is not None:
            self.restore(d)
            self.dirty = True
            self.historyChanged.emit()
            self.statusMessage.emit("Annulé")

    def redo(self):
        d = self.history.redo(self.state_dict())
        if d is not None:
            self.restore(d)
            self.dirty = True
            self.historyChanged.emit()
            self.statusMessage.emit("Rétabli")

    # ── Notifications ────────────────────────────────────────────────────
    def _touch(self, content=True):
        self._rev += 1
        self._cache = None
        if content:
            self.content_rev += 1   # le contenu a changé (pas seulement la tête de lecture)

    def notify(self, structure=False, library=False, timeline=False):
        self._touch()
        if structure:
            self.structureChanged.emit()
        if library:
            self.libraryChanged.emit()
        if timeline:
            self.timelineChanged.emit()
        self.docChanged.emit()

    # ── Contexte ─────────────────────────────────────────────────────────
    def current_root(self):
        kind, ref = self.context
        if kind == "scene":
            return self.doc.scene
        if kind == "def":
            d = self.doc.library.get(ref)
            return d.root if d else None
        if kind == "clip":
            _, clip = self.doc.timeline.find_clip(ref)
            d = self.doc.library.get(clip.def_id) if clip else None
            return d.root if d else None
        return None

    def work_root(self):
        """Où vont les nouveaux calques : le groupe principal dans la scène, la racine ailleurs."""
        if self.context[0] == "scene":
            return self.doc.main_group
        return self.current_root()

    def current_clip(self):
        if self.context[0] != "clip":
            return None
        return self.doc.timeline.find_clip(self.context[1])[1]

    def context_label(self):
        kind, ref = self.context
        if kind == "def":
            d = self.doc.library.get(ref)
            return f"Forme personnalisée : {d.name if d else '?'}"
        if kind == "clip":
            clip = self.current_clip()
            d = self.doc.library.get(clip.def_id) if clip else None
            return f"Clip : {d.name if d else '?'}"
        return "Scène"

    def _set_context(self, ctx, view="scene"):
        self.history.cancel()
        self.context = ctx
        self.view_source = view
        self.selection = []
        self.selected_clip = ctx[1] if ctx[0] == "clip" else None
        self._touch()
        self.contextChanged.emit()
        self.structureChanged.emit()
        self.selectionChanged.emit()
        self.docChanged.emit()

    def enter_scene(self):
        self._set_context(("scene", None), "scene")

    def enter_def(self, def_id):
        if self.doc.library.get(def_id):
            self._set_context(("def", def_id), "scene")

    def enter_clip(self, clip_id):
        if self.context == ("clip", clip_id):
            return
        self._set_context(("clip", clip_id), "timeline")
        self.clipSelected.emit(clip_id)

    def set_view_source(self, src):
        if self.context[0] == "clip" and src == "scene":
            self.enter_scene()
            return
        if src != self.view_source:
            self.view_source = src
            self._touch()
            self.contextChanged.emit()
            self.docChanged.emit()

    def display_mode(self):
        if self.context[0] == "def":
            return "def"
        if self.context[0] == "clip" or self.view_source == "timeline" or self.playing:
            return "timeline"
        return "scene"

    def editing_visible(self):
        """La sélection et les outils agissent-ils sur ce que montre la mire ?"""
        mode = self.display_mode()
        return mode in ("scene", "def") or self.context[0] == "clip"

    # ── Évaluation ───────────────────────────────────────────────────────
    def wall_time(self):
        return time.perf_counter() - self._t0

    def view_time(self):
        """Instant montré dans la mire : la tête de lecture, ou le point de courbe en cours de déplacement."""
        return self.playhead if self.preview_time is None else self.preview_time

    def display_time(self):
        return self.view_time() if self.display_mode() == "timeline" else self.wall_time()

    def default_color(self):
        return tuple(self.settings.get("general", "default_color"))

    def clip_local_time(self, clip):
        return min(max(self.view_time() - clip.start, 0.0), clip.duration)

    def eval_context(self):
        overrides = {}
        clip = self.current_clip()
        if clip is not None:
            overrides = clip.overrides_at(self.clip_local_time(clip))
        return EvalContext(self.doc.library, self.display_time(), self.doc.timeline.bpm,
                           self.default_color(), overrides)

    def resolve_display_params(self, mnode):
        """Réglages effectifs d'un modifieur à l'instant affiché (automations comprises)."""
        from ..core.evaluator import resolve_params
        return resolve_params(mnode, self.eval_context())

    def display_strokes(self):
        mode = self.display_mode()
        t = self.display_time()
        key = (self._rev, mode, round(t, 4) if (mode == "timeline" or self._animated) else None)
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        if mode == "timeline":
            strokes, animated = evaluate_timeline(self.doc.timeline, self.doc.library, self.view_time(),
                                                  self.default_color())
        else:
            ctx = self.eval_context()
            root = self.current_root()
            strokes = evaluate(root, ctx) if root is not None else []
            animated = ctx.animated
        self._animated = animated
        self._cache = (key, strokes)
        return strokes

    def is_animated(self):
        return self._animated or self.playing

    # ── Sélection ────────────────────────────────────────────────────────
    def find(self, node_id):
        root = self.current_root()
        return root.find(node_id) if root else None

    def selected_nodes(self):
        out = []
        for i in self.selection:
            n = self.find(i)
            if n is not None:
                out.append(n)
        return out

    def top_selected(self):
        """Nœuds sélectionnés sans ceux déjà contenus dans un autre nœud sélectionné."""
        sel = self.selected_nodes()
        ids = {n.id for n in sel}
        return [n for n in sel if not any(a.id in ids for a in n.ancestors())]

    def set_selection(self, ids):
        ids = list(dict.fromkeys(ids))
        if ids:
            self.last_touched = ids[-1]
        if ids != self.selection:
            self.selection = ids
            self.selectionChanged.emit()

    def toggle_selection(self, node_id):
        if node_id in self.selection:
            self.set_selection([i for i in self.selection if i != node_id])
        else:
            self.set_selection(self.selection + [node_id])

    def select_all(self):
        root = self.work_root()
        if root:
            self.set_selection([c.id for c in root.children])

    def clear_selection(self):
        self.set_selection([])

    # ── Outils / grille ──────────────────────────────────────────────────
    def set_tool(self, tool):
        previous = self.tool
        if tool != self.tool:
            self.tool = tool
            self.toolChanged.emit(tool)
        drawing = tool == "pencil" or tool.startswith("shape:")
        if drawing and not (previous == "pencil" or previous.startswith("shape:")):
            self.drawn = []
        if tool == "select":
            # Outil Sélection : reprend tout ce qui vient d'être dessiné, sinon le dernier calque touché
            drawn = [i for i in self.drawn if self.find(i) is not None]
            self.drawn = []
            if drawn:
                self.set_selection(drawn)
            elif not self.selection and self.last_touched and self.find(self.last_touched):
                self.set_selection([self.last_touched])

    def note_drawn(self, node):
        """Un outil de dessin vient de créer ce calque."""
        if node.id not in self.drawn:
            self.drawn.append(node.id)

    def set_grid_mode(self, mode):
        self.doc.grid.mode = mode
        self.gridChanged.emit()

    def set_symmetry(self, mode=None, count=None):
        """Symétrie de dessin (aide au tracé, comme la grille)."""
        from ..core import draw_symmetry as DS
        g = self.doc.grid
        if mode is not None:
            g.sym = int(mode)
            if g.sym:
                g.sym_last = g.sym
        if count is not None:
            g.sym_count = int(count)
            if g.sym not in (4, 5):
                g.sym = g.sym_last = 4
        self.gridChanged.emit()
        self.statusMessage.emit("Symétrie de dessin : " + DS.describe(g) if g.sym else "Symétrie de dessin désactivée")

    def toggle_symmetry(self):
        g = self.doc.grid
        self.set_symmetry(0 if g.sym else (g.sym_last or 1))

    def set_snap(self, on):
        self.doc.grid.snap = bool(on)
        self.gridChanged.emit()
        self.statusMessage.emit("Aimant activé" if on else "Aimant désactivé")

    # ── Paramètres (avec automations) ────────────────────────────────────
    def param_label(self, node, key):
        if key.startswith("tf."):
            return TRANSFORM_LABELS.get(key[3:], key)
        if key == "__active__":
            return "Actif"
        if key.startswith("col."):
            from ..core import shape_color
            s = shape_color.spec(key)
            return s.label if s else key
        if key.startswith("sp."):
            from ..core.shapes import SHAPE_PARAMS
            spec = SHAPE_PARAMS.get(getattr(node, "shape", ""), {}).get(key[3:])
            return spec[0] if spec else key
        if node.kind == "modifier":
            spec = node.modifier.spec(key)
            return spec.label if spec else key
        return key

    def param_is_discrete(self, node, key):
        if key == "__active__":
            return True
        if node.kind == "modifier":
            spec = node.modifier.spec(key)
            return spec is not None and spec.kind in ("bool", "enum", "int")
        return key.startswith("sp.") or key in ("col.mode", "col.type")

    def effective_param(self, node, key):
        clip = self.current_clip()
        if clip is not None:
            a = clip.automation_for(node.id, key)
            if a is not None and a.keys:
                return a.value_at(self.clip_local_time(clip))
        return N.get_param(node, key)

    def set_param(self, node, key, value):
        """Change un réglage. Dans un clip : écrit une clé d'automation si le réglage est automatisé
        (ou si une automation attend son paramètre), sinon modifie la valeur fixe."""
        clip = self.current_clip()
        if clip is not None:
            auto = clip.automation_for(node.id, key)
            if auto is None:
                armed = clip.armed_automation()
                if armed is not None:
                    current = N.get_param(node, key)
                    armed.bind(node.id, key, f"{node.name} › {self.param_label(node, key)}",
                               self.param_is_discrete(node, key))
                    t = self.clip_local_time(clip)
                    if t > 1e-6 and current is not None:
                        armed.set_key(0.0, current)
                    auto = armed
                    self.statusMessage.emit(f"Automation liée à « {armed.label} »")
            if auto is not None:
                auto.set_key(self.clip_local_time(clip), value)
                self._touch()
                self.timelineChanged.emit()
                self.docChanged.emit()
                return
        N.set_param(node, key, value)
        self._touch()
        self.docChanged.emit()
