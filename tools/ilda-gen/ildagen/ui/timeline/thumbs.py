"""Vignettes des clips (aperçu rapide, pas fidèle) : cache, réutilisation, budget de temps.

- une vignette n'est recalculée que si le clip, son animation ou les formes personnalisées changent ;
- un clip qui ne dépend pas du temps (pas d'effet animé, d'oscillateur, de fondu…) n'a qu'une seule vignette,
  répétée tout le long ;
- dessin simplifié : une couleur par tracé, peu de points, sans anticrénelage ;
- au plus BUDGET_S de calcul par affichage : le reste arrive à l'affichage suivant.
"""

import json
import time

import numpy as np
from PySide6.QtCore import QPointF
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap, QPolygonF

from ...core.effects.apply import clip_strokes
from .. import theme

BUDGET_S = 0.012
MAX_POINTS = 48
MAX_ENTRIES = 4000


def draw_fast(pm, strokes, size):
    """Tracés en mire entière : une couleur moyenne par tracé, points décimés."""
    p = QPainter(pm)
    half = size / 2.0
    for s in strokes:
        n = len(s.pts)
        if n == 0:
            continue
        c = s.col.mean(axis=0)
        if c.max() < 0.02:
            continue
        pts = s.pts
        if n > MAX_POINTS:
            pts = pts[np.linspace(0, n - 1, MAX_POINTS).astype(int)]
        sx = half + pts[:, 0] * half
        sy = half - pts[:, 1] * half
        col = QColor.fromRgbF(float(min(1.0, c[0])), float(min(1.0, c[1])), float(min(1.0, c[2])))
        if s.kind == "dots" or len(pts) == 1:
            p.setPen(QPen(col, 2))
            p.drawPoints(QPolygonF([QPointF(x, y) for x, y in zip(sx, sy)]))
            continue
        p.setPen(QPen(col, 1))
        poly = QPolygonF([QPointF(x, y) for x, y in zip(sx, sy)])
        if s.closed:
            p.drawPolygon(poly)
        else:
            p.drawPolyline(poly)
    p.end()




class ThumbCache:
    def __init__(self, editor):
        self.editor = editor
        self.items = {}
        self.sigs = {}            # clip_id → (content_rev, signature)
        self.animated = {}        # signature → le clip dépend du temps (effets, oscillateurs, fondus…)
        self.lib_sig = (None, "")
        self.deadline = 0.0
        self.pending = False

    def begin_paint(self):
        self.deadline = time.perf_counter() + BUDGET_S
        self.pending = False
        if len(self.items) > MAX_ENTRIES:
            self.items.clear()

    def _signature(self, clip):
        rev = self.editor.content_rev
        cached = self.sigs.get(clip.id)
        if cached is not None and cached[0] == rev:
            return cached[1]
        if self.lib_sig[0] != rev:
            self.lib_sig = (rev, json.dumps(self.editor.doc.library.to_dict(), sort_keys=True))
        tl = self.editor.doc.timeline
        d = clip.to_dict()
        d.pop("expanded", None)
        d.pop("id", None)
        anim = tl.animations.get(clip.anim_id)
        sig = str(hash((self.lib_sig[1], json.dumps(d, sort_keys=True),
                        json.dumps(anim.to_dict() if anim else None, sort_keys=True),
                        tl.bpm, tl.bar_offset, tuple(self.editor.default_color()))))
        self.sigs[clip.id] = (rev, sig)
        return sig

    def get(self, clip, t_local, size):
        """Vignette, ou None si le budget de temps est dépassé (elle sera calculée plus tard)."""
        sig = self._signature(clip)
        timed = self.animated.get(sig, True)
        key = (sig, size, round(t_local, 2) if timed else None)
        pm = self.items.get(key)
        if pm is not None:
            return pm
        if time.perf_counter() > self.deadline:
            self.pending = True
            return None
        ed = self.editor
        pm = QPixmap(size, size)
        pm.fill(theme.qc(theme.BG_MIRE))
        strokes, animated = clip_strokes(ed.doc.timeline, ed.doc.library, clip, clip.start + t_local,
                                         ed.default_color())
        self.animated[sig] = animated
        if not animated:
            key = (sig, size, None)
        draw_fast(pm, strokes, size)
        self.items[key] = pm
        return pm
