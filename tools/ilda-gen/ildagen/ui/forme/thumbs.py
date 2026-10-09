"""Aperçus des formes de la bibliothèque (vignettes animées, légères).

Chaque forme a une LaserScene en cache, refaite seulement quand son contenu change (la forme en cours et
celles qui la contiennent). Le cadrage est calculé une fois par changement de contenu, sur quelques instants
de la boucle pour une forme animée : la vignette ne « respire » pas et rien n'est jamais coupé (F3).
Les formes animées sont recalculées à faible cadence (ANIM_MS), seulement pour les vignettes visibles.
"""

from ...core.evaluator import evaluate_form
from ...core.path import strokes_bbox
from ..widgets import LaserScene

ANIM_MS = 100                    # 10 images/s pour les vignettes animées
SAMPLES = (0.0, 0.37, 0.91, 1.53, 2.2)   # instants de boucle pour le cadrage d'une forme animée


def union(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


class ThumbCache:
    def __init__(self, editor, time_fn):
        self.editor = editor
        self.time_fn = time_fn            # temps de boucle de l'aperçu (pause, vitesse)
        self.scenes = {}                  # def_id → LaserScene
        self.boxes = {}                   # def_id → cadrage stable
        self.animated = set()
        self.dirty = set()

    def _eval(self, d, t):
        ed = self.editor
        return evaluate_form(d, ed.doc.library, t, ed.doc.timeline.bpm, ed.default_color())

    def mark(self, ids=None):
        """Formes à recalculer (toutes si ids est None)."""
        if ids is None:
            self.dirty = set(self.scenes) | {d.id for d in self.editor.doc.library.defs}
        else:
            self.dirty |= set(ids)

    def scene(self, def_id):
        """Scène de la vignette (recalculée si son contenu a changé), ou None si la forme n'existe plus."""
        d = self.editor.doc.library.get(def_id)
        if d is None:
            return None
        sc = self.scenes.get(def_id)
        if sc is None or def_id in self.dirty:
            self.dirty.discard(def_id)
            strokes, animated = self._eval(d, self.time_fn())
            box = strokes_bbox(strokes)
            if animated:
                self.animated.add(def_id)
                for t in SAMPLES:
                    box = union(box, strokes_bbox(self._eval(d, t)[0]))
            else:
                self.animated.discard(def_id)
            sc = sc or LaserScene(fit=True)
            sc.set_strokes(strokes)
            self.boxes[def_id] = box
            sc.bbox = box
            self.scenes[def_id] = sc
        return sc

    def advance(self, def_id):
        """Nouvelle image d'une forme animée (même cadrage)."""
        d = self.editor.doc.library.get(def_id)
        sc = self.scenes.get(def_id)
        if d is None or sc is None or def_id in self.dirty:
            return
        sc.set_strokes(self._eval(d, self.time_fn())[0])
        sc.bbox = union(self.boxes.get(def_id), sc.bbox)

    def forget(self, keep_ids):
        for k in list(self.scenes):
            if k not in keep_ids:
                self.scenes.pop(k, None)
                self.boxes.pop(k, None)
                self.animated.discard(k)
