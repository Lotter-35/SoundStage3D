"""Opérations sur les formes de la bibliothèque (nouvelle, dupliquer, renommer, supprimer, formes
personnalisées, forme placée dans une autre) et boucle de l'espace Forme (pause, aperçu à un instant donné).

Boucle en pause : l'horloge de la forme s'arrête (aperçu ET laser) ; elle repart d'où elle s'était arrêtée.
L'horloge est celle du maître Vitesse (partagée avec le Live) : la pause ne dure que dans l'espace Forme.
"""

import time

from ..core import nodes as N
from ..core.evaluator import EvalContext, eval_children, evaluate_form
from ..core.library import ShapeDef
from ..core.path import strokes_bbox


class FormOpsMixin:
    # ── Formes personnalisées ────────────────────────────────────────────
    def create_custom_shape(self, name):
        nodes = self.top_selected() or list(self.work_root().children)
        if not nodes:
            return None
        own_def = self.current_form_id()
        parent = nodes[0].parent
        d = ShapeDef(name)
        inst = N.InstanceNode(d.id, name)

        def do():
            idx = min(n.index() for n in nodes if n.parent is parent)
            for n in sorted(nodes, key=lambda n: (n.parent is not parent, n.index())):
                n.parent.remove(n)
                d.root.add(n)
            self.doc.library.add(d)
            parent.add(inst, idx)
            b = strokes_bbox(eval_children(d.root.children, self._static_ctx()))
            if b:
                inst.transform.px, inst.transform.py = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if own_def and any(x.kind == "instance" and x.def_id == own_def for n in nodes for x in n.walk()):
            return None
        self.mutate("Créer une forme personnalisée", do, library=True)
        self.set_selection([inst.id])
        return d

    def _static_ctx(self):
        return EvalContext(self.doc.library, 0.0, self.doc.timeline.bpm, self.default_color())

    def place_instance(self, def_id, pos=None):
        d = self.doc.library.get(def_id)
        if d is None:
            return None
        cur = self.current_form_id()
        if cur and (cur == def_id or d.uses_def(cur, self.doc.library)):
            self.statusMessage.emit("Impossible : une forme ne peut pas se contenir elle-même")
            return None
        inst = N.InstanceNode(def_id, d.name)
        b = strokes_bbox(eval_children(d.root.children, self._static_ctx()))
        if b:
            inst.transform.px, inst.transform.py = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            if pos is not None:
                inst.transform.tx = pos[0] - inst.transform.px
                inst.transform.ty = pos[1] - inst.transform.py
        return self.add_node(inst, "Placer une forme")

    # ── Bibliothèque ─────────────────────────────────────────────────────
    def rename_def(self, def_id, name):
        d = self.doc.library.get(def_id)
        if d and name.strip() and name.strip() != d.name:
            def do():
                d.name = name.strip()
                d.root.name = d.name
            self.mutate("Renommer la forme", do, library=True, timeline=True)

    def new_form(self, name=None):
        """Case « + » de la liste des formes : nouvelle forme vide, sélectionnée."""
        from ..core.document import next_form_name
        d = ShapeDef(name or next_form_name(self.doc.library))
        d.root.name = d.name
        self.mutate("Nouvelle forme", lambda: self.doc.library.add(d), library=True)
        self.enter_def(d.id)
        return d

    def duplicate_form(self, def_id):
        src = self.doc.library.get(def_id)
        if src is None:
            return None
        root = N.clone_node(src.root)
        d = ShapeDef(src.name + " copie", root)
        root.name = d.name

        def do():
            lib = self.doc.library
            lib.defs.insert(lib.defs.index(src) + 1, d)
        self.mutate("Dupliquer la forme", do, library=True)
        self.enter_def(d.id)
        return d

    def delete_def(self, def_id):
        lib = self.doc.library
        if lib.get(def_id) is None:
            return
        removing_current = self.current_form_id() == def_id

        def do():
            lib.remove(def_id)
            for other in lib.defs:
                for n in list(other.root.walk()):
                    if n.kind == "instance" and n.def_id == def_id and n.parent:
                        n.parent.remove(n)
            self.doc.timeline.remove_def(def_id)
            self.doc.live.remove_def(def_id)
            if not lib.defs:
                from ..core.document import ensure_form
                ensure_form(lib)
            if removing_current:
                self.selection = []
                self.form_id = lib.defs[0].id     # la forme en cours doit rester valide
        self.mutate("Supprimer la forme", do, library=True, timeline=True)
        self.liveChanged.emit()
        if removing_current:
            self.contextChanged.emit()
            self.structureChanged.emit()
        self.select_clips([i for i in self.clip_selection if self.doc.timeline.find_clip(i)[1] is not None])
        self.set_selection([])

    def forms_using(self, def_id):
        """Identifiants des formes qui contiennent (directement ou non) la forme def_id, elle comprise."""
        lib = self.doc.library
        return {d.id for d in lib.defs if d.id == def_id or d.uses_def(def_id, lib)}

    # ── Boucle de l'espace Forme ─────────────────────────────────────────
    def loop_paused(self):
        return getattr(self, "_loop_paused", False)

    def set_loop_paused(self, on):
        """Boucle en pause (bouton « Boucle ») : les oscillateurs de la forme s'arrêtent là où ils sont."""
        on = bool(on) and self.workspace == "forme"
        if on == self.loop_paused():
            return
        if not getattr(self, "_loop_hooked", False):
            self._loop_hooked = True
            self.mastersChanged.connect(self._loop_keep)
            self.workspaceChanged.connect(lambda _ws: self.set_loop_paused(False) if _ws != "forme" else None)
            self.projectChanged.connect(self._loop_forget)
        self._loop_paused = on
        self.clock.set_speed(0.0 if on else self.doc.masters.speed, time.perf_counter())
        self._touch(content=False)
        self.docChanged.emit()

    def _loop_keep(self):
        """Maître Vitesse changé pendant la pause : l'horloge reste arrêtée."""
        if self.loop_paused() and self.clock.speed != 0.0:
            self.clock.set_speed(0.0, time.perf_counter())

    def _loop_forget(self):
        """Nouveau projet : nouvelle horloge, la boucle tourne."""
        if self.loop_paused() and self.clock.speed != 0.0:
            self._loop_paused = False

    def form_strokes(self, t):
        """Tracés de la forme en cours à l'instant de boucle t (aperçu de la mire : vitesse de l'aperçu)."""
        d = self.current_form()
        if d is None:
            return []
        key = (self._rev, self.form_id)
        c = getattr(self, "_form_cache", None)
        if c is not None and c[0] == key and (not c[2] or abs(c[3] - t) < 1e-4):
            return c[1]
        strokes, animated = evaluate_form(d, self.doc.library, t, self.doc.timeline.bpm, self.default_color())
        self._animated = animated
        self._form_cache = (key, strokes, animated, t)
        return strokes
