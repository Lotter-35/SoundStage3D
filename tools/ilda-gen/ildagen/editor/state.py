"""État de l'éditeur : document, espace actif, forme en cours, sélections, évaluation de l'affichage
(annuler / rétablir, gestes et état d'affichage : history_ops.py).

Espaces de travail (D1) :
- « forme » : la forme en cours (`current_form_id`), sans notion de temps ; ses oscillateurs tournent en
  boucle (temps de boucle × maître Vitesse) ; on la dessine et on la règle ;
- « show »  : la timeline (clips, effets d'animation), à la tête de lecture ; aperçu non modifiable ;
- « live »  : les cues en cours et les effets rapides (editor/live_runtime.py).
Ce qui part au laser suit l'espace actif (D11, live_snapshot.py).
"""

import time

from PySide6.QtCore import QObject, Signal

from ..core import nodes as N
from ..core import view_state
from ..core.document import WORKSPACES, Document
from ..core.evaluator import EvalContext, evaluate_form, evaluate_timeline
from ..core.history import History
from ..core.masters import SpeedClock
from ..core.oscillator import Osc, can_oscillate
from ..core.param_specs import param_spec
from ..core.transform import TRANSFORM_LABELS
from .effect_ops import EffectOpsMixin
from .history_ops import HistoryOpsMixin
from .layer_ops import LayerOpsMixin
from .live_ops import LiveOpsMixin
from .live_runtime import LiveRuntime, evaluate_live
from .timeline_ops import TimelineOpsMixin
from .transform_ops import TransformOpsMixin


class EditorState(QObject, HistoryOpsMixin, LayerOpsMixin, TimelineOpsMixin, EffectOpsMixin, LiveOpsMixin,
                  TransformOpsMixin):
    docChanged = Signal()          # contenu modifié (rendu, panneaux)
    structureChanged = Signal()    # arbre des calques modifié
    selectionChanged = Signal()
    toolChanged = Signal(str)
    contextChanged = Signal()      # forme en cours ou espace actif changés
    workspaceChanged = Signal(str)
    libraryChanged = Signal()
    timelineChanged = Signal()     # pistes, clips, animations, marqueurs
    clipSelectionChanged = Signal()
    clipSelected = Signal(str)     # clip actif (Show)
    playheadChanged = Signal(float)
    gridChanged = Signal()
    mastersChanged = Signal()
    liveChanged = Signal()         # pages / cues, ou état d'exécution du live (cues lancés, effets rapides)
    historyChanged = Signal()
    projectChanged = Signal()
    statusMessage = Signal(str)
    restored = Signal()            # état remplacé ou geste annulé / terminé : abandonner les gestes en cours
    gestureChanged = Signal(bool)  # un geste (étape d'annulation ouverte) commence / se termine
    viewChanged = Signal()         # état d'affichage modifié (grille, dépliage…) : à enregistrer, hors historique
    audioChanged = Signal(str)
    brushChanged = Signal()

    def __init__(self, settings):
        super().__init__()
        self.settings = settings
        self.doc = Document()
        self.history = History(strip=view_state.strip)
        self.selection = []
        self.tool = "select"
        self.workspace = "forme"
        self.form_id = self.doc.library.visible()[0].id
        self.clip_selection = []    # clips sélectionnés (Show) ; le clip actif en fait toujours partie
        self.selected_clip = None   # clip actif
        self.playhead = 0.0
        self.playing = False
        self.clipboard = []
        self.clip_clipboard = None   # clips copiés dans la timeline (avec la longueur de la zone copiée)
        self.dirty = False
        self.view_dirty = False     # état d'affichage modifié depuis le dernier enregistrement
        self.session = 0            # change à chaque projet ouvert / nouveau (sauvegarde automatique)
        self._gesture_on = False
        self.last_touched = None   # dernier calque créé / sélectionné / colorié (repris par l'outil Sélection)
        self.drawn = []            # calques créés depuis qu'on a pris un outil de dessin (crayon, formes)
        self.param_editing = False  # réglage en cours dans un panneau : la mire masque la sélection
        self._rev = 0
        self.content_rev = 0
        self._cache = None
        self._animated = False
        self._t0 = time.perf_counter()
        # Horloge du maître Vitesse : temps de boucle de la forme, temps des cues et des effets rapides
        self.clock = SpeedClock(self.doc.masters.speed, self._t0)
        self.runtime = LiveRuntime(self.clock, self._t0)

    # ── Document ─────────────────────────────────────────────────────────
    def set_document(self, doc):
        self.doc = doc
        self.history.clear()
        self.param_editing = False
        self.session += 1
        self.selection = []
        self.workspace = doc.view.get("workspace", "forme")
        self.form_id = doc.library.visible()[0].id
        self.clip_selection = []
        self.selected_clip = None
        self.playhead = 0.0
        self.dirty = False
        self.view_dirty = False
        now = time.perf_counter()
        self.clock = SpeedClock(doc.masters.speed, now)
        self.runtime = LiveRuntime(self.clock, now)
        self._touch()
        self._gesture_state()
        self.projectChanged.emit()
        self.workspaceChanged.emit(self.workspace)
        self.contextChanged.emit()
        self.structureChanged.emit()
        self.selectionChanged.emit()
        self.clipSelectionChanged.emit()
        self.libraryChanged.emit()
        self.timelineChanged.emit()
        self.gridChanged.emit()
        self.mastersChanged.emit()
        self.liveChanged.emit()
        self.historyChanged.emit()
        self.docChanged.emit()

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

    # ── Espace actif ─────────────────────────────────────────────────────
    def set_workspace(self, ws):
        """Forme / Show / Live (état d'affichage : aucune étape d'annulation)."""
        if ws not in WORKSPACES or ws == self.workspace:
            return
        self.end_gesture()
        self.workspace = ws
        self.doc.view["workspace"] = ws
        self._touch(content=False)
        self.view_changed()
        self.workspaceChanged.emit(ws)
        self.contextChanged.emit()
        self.docChanged.emit()

    def editing_visible(self):
        """La sélection et les outils agissent-ils sur ce que montre la mire ? (espace Forme seulement)"""
        return self.workspace == "forme"

    # ── Forme en cours ───────────────────────────────────────────────────
    def current_form_id(self):
        return self.form_id

    def current_form(self):
        return self.doc.library.get(self.form_id)

    def current_root(self):
        d = self.current_form()
        return d.root if d else None

    def work_root(self):
        """Où vont les nouveaux calques : la racine de la forme en cours."""
        return self.current_root()

    def context_label(self):
        d = self.current_form()
        return d.name if d else "?"

    def set_current_form(self, def_id):
        """Choisit la forme en cours (calques, réglages, mire de l'espace Forme)."""
        if self.doc.library.get(def_id) is None:
            def_id = self.doc.library.visible()[0].id
        if def_id == self.form_id:
            return
        self.end_gesture()
        self.form_id = def_id
        self.selection = []
        self._touch()
        self.contextChanged.emit()
        self.structureChanged.emit()
        self.selectionChanged.emit()
        self.docChanged.emit()

    def enter_def(self, def_id=None):
        """« Ouvrir dans Forme » : la forme devient la forme en cours et l'espace Forme s'affiche."""
        self.set_current_form(def_id or self.form_id)
        self.set_workspace("forme")

    # ── Évaluation ───────────────────────────────────────────────────────
    def wall_time(self):
        return time.perf_counter() - self._t0

    def loop_time(self, now=None):
        """Temps de boucle de la forme (heure murale × maître Vitesse, sans saut quand la vitesse change)."""
        return self.clock.at(time.perf_counter() if now is None else now)

    def restart_loop(self):
        self.clock.restart(time.perf_counter())
        self._touch(content=False)
        self.docChanged.emit()

    def view_time(self):
        """Instant de la timeline montré dans l'espace Show : la tête de lecture."""
        return self.playhead

    def default_color(self):
        return tuple(self.settings.get("general", "default_color"))

    def eval_context(self):
        """Contexte des outils de la mire : la forme en cours, réglages de base (sans oscillateurs : on règle
        et on déplace les valeurs de base, jamais une valeur oscillante)."""
        return EvalContext(self.doc.library, self.loop_time(), self.doc.timeline.bpm, self.default_color())

    def display_strokes(self):
        """Tracés de la mire : la forme en cours (Forme), la timeline à la tête de lecture (Show), la sortie
        Live (Live)."""
        ws = self.workspace
        if ws == "show":
            t = self.playhead
        elif ws == "live":
            t = time.perf_counter()
        else:
            t = self.loop_time()
        timed = ws != "forme" or self._animated
        key = (self._rev, ws, self.form_id, round(t, 4) if timed else None)
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        if ws == "show":
            strokes, animated = evaluate_timeline(self.doc.timeline, self.doc.library, t, self.default_color(),
                                                  speed=self.doc.masters.speed)
        elif ws == "live":
            strokes, animated = evaluate_live(self.doc, self.runtime, t, self.default_color())
        else:
            d = self.current_form()
            strokes, animated = evaluate_form(d, self.doc.library, t, self.doc.timeline.bpm,
                                              self.default_color()) if d is not None else ([], False)
        self._animated = animated
        self._cache = (key, strokes)
        return strokes

    def is_animated(self):
        """L'affichage change-t-il tout seul avec le temps ?"""
        if self.workspace == "show":
            return self.playing
        if self.workspace == "live":
            return bool(self.runtime.cues or self.runtime.held)
        return self._animated

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

    # ── Outils ───────────────────────────────────────────────────────────
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

    # ── Réglages ─────────────────────────────────────────────────────────
    def param_label(self, node, key):
        if key.startswith("tf."):
            return TRANSFORM_LABELS.get(key[3:], key)
        spec = param_spec(node, key)
        return spec.label if spec is not None else key

    def effective_param(self, node, key):
        """Valeur réglée (de base) d'un réglage : les oscillateurs n'y touchent pas."""
        return N.get_param(node, key)

    def set_param(self, node, key, value):
        """Change un réglage (dans un geste ouvert par l'appelant : begin / commit)."""
        N.set_param(node, key, value)
        self._touch()
        self.docChanged.emit()

    def _edit(self, label, fn, structure=False, timeline=False, library=False):
        """Modification annulable : dans un geste ouvert (glisser un réglage…), sans nouvelle étape ;
        sinon une étape à elle seule."""
        if self.gesture_active():
            res = fn()
            self.notify(structure=structure, library=library, timeline=timeline)
            return res
        return self.mutate(label, fn, structure=structure, library=library, timeline=timeline)

    # ── Oscillateurs (espace Forme) ──────────────────────────────────────
    def set_osc(self, node, key, osc=None):
        """Pose (ou remplace) l'oscillateur d'un réglage numérique ; osc None : un oscillateur par défaut.
        Renvoie l'oscillateur, ou None si le réglage ne peut pas en porter."""
        spec = param_spec(node, key)
        if not can_oscillate(spec):
            self.statusMessage.emit("Seuls les réglages numériques peuvent osciller")
            return None
        osc = osc.copy() if osc is not None else Osc.default_for(spec)
        self._edit("Oscillateur", lambda: node.osc.__setitem__(key, osc))
        return osc

    def clear_osc(self, node, key):
        if key in node.osc:
            self._edit("Retirer l'oscillateur", lambda: node.osc.pop(key, None))

    def osc_of(self, node, key):
        return node.osc.get(key)
