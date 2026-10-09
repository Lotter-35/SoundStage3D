"""Aperçus des formes de la grille de cues, gardés tant que le contenu du projet ne change pas.

- form(def_id, t) : tracés d'une forme au temps de boucle t ; une forme fixe (sans oscillateur ni modifieur
  qui dépend du temps) n'est calculée qu'une fois, et ses tracés préparés (LaserScene) sont partagés par toutes
  les cases qui la montrent ;
- loop(def_id) : durée d'une boucle d'un cue (barre d'avancement : la plus longue période de ses oscillateurs,
  sinon une mesure).
Tout est oublié quand le contenu change (editor.content_rev), tempo compris.
"""

from ...core.evaluator import evaluate_form
from ...core.live import loop_length
from ..widgets import LaserScene


class Thumbs:
    def __init__(self, editor):
        self.editor = editor
        self._rev = None
        self._forms = {}       # def_id → (tracés, animé)
        self._scenes = {}      # def_id → LaserScene (formes fixes)
        self._loops = {}       # def_id → durée d'une boucle (s)

    def _check(self):
        rev = self.editor.content_rev
        if rev != self._rev:
            self._rev = rev
            self._forms.clear()
            self._scenes.clear()
            self._loops.clear()

    def form(self, def_id, t=0.0):
        """(tracés, animé) de la forme au temps de boucle t."""
        self._check()
        hit = self._forms.get(def_id)
        if hit is not None and not hit[1]:
            return hit
        ed = self.editor
        lib = ed.doc.library
        d = lib.get(def_id)
        if d is None:
            return [], False
        res = evaluate_form(d, lib, t, ed.doc.timeline.bpm, ed.default_color())
        self._forms[def_id] = res
        return res

    def static_scene(self, def_id):
        """Tracés préparés d'une forme fixe (partagés), None si la forme est animée."""
        self._check()
        strokes, animated = self._forms.get(def_id) or self.form(def_id)
        if animated:
            return None
        sc = self._scenes.get(def_id)
        if sc is None:
            sc = self._scenes[def_id] = LaserScene(strokes)
        return sc

    def loop(self, def_id):
        self._check()
        v = self._loops.get(def_id)
        if v is None:
            tl = self.editor.doc.timeline
            v = self._loops[def_id] = loop_length(self.editor.doc.library.get(def_id), self.editor.doc.library,
                                                  tl.bpm, tl.beats_per_bar)
        return v
