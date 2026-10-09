"""Vignettes des clips (aperçu rapide, pas fidèle) : cache, partage, calcul par petits lots.

- signature d'une vignette : la forme (bibliothèque), l'animation, la durée, les fondus, le tempo — pas le début
  ni l'identifiant du clip : déplacer un clip ne refait rien, des clips liés de même durée partagent leurs
  vignettes (T6) ;
- vignette k d'un clip = l'instant u (0..1 de la durée) arrondi à 1/128 : le zoom réutilise les vignettes ;
  un clip qui ne dépend pas du temps n'a qu'une vignette, répétée ;
- peindre ne calcule rien : les vignettes manquantes sont demandées, puis calculées par lots de BUDGET_S hors
  de l'affichage (une minuterie) ; la timeline repeint une fois le lot prêt. Quand tout est là, plus rien ne
  tourne (T5 : aucun affichage en continu au repos, les pistes du bas ont leur tour) ;
- en attendant, la vignette la plus proche déjà calculée de ce clip est montrée.
"""

import json
import time

import numpy as np
from PySide6.QtCore import QObject, QPointF, QTimer, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap, QPolygonF

from ...core.effects.apply import clip_strokes
from .. import theme

BUDGET_S = 0.015
MAX_POINTS = 48
MAX_ENTRIES = 6000
U_STEPS = 128


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
        sx = half + pts[:, 0] * half * 0.92
        sy = half - pts[:, 1] * half * 0.92
        col = QColor.fromRgbF(float(min(1.0, c[0])), float(min(1.0, c[1])), float(min(1.0, c[2])))
        poly = QPolygonF([QPointF(x, y) for x, y in zip(sx, sy)])
        if s.kind == "dots" or len(pts) == 1:
            p.setPen(QPen(col, 2))
            p.drawPoints(poly)
        else:
            p.setPen(QPen(col, 1))
            p.drawPolygon(poly) if s.closed else p.drawPolyline(poly)
    p.end()


class ThumbCache(QObject):
    ready = Signal()          # un lot de vignettes est prêt : repeindre

    def __init__(self, editor):
        super().__init__()
        self.editor = editor
        self.items = {}           # (signature, taille, pas de u ou None) → QPixmap
        self.by_sig = {}          # (signature, taille) → {pas de u: QPixmap}
        self.animated = {}        # signature → le clip dépend du temps
        self.sigs = {}            # id de clip → (rev, signature)
        self.anim_json = {}       # id d'animation → (rev, texte)
        self.lib_sig = (None, "")
        self.queue = {}           # clé → (clip, u)
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.setInterval(5)
        self.timer.timeout.connect(self.work)
        self.computed = 0         # vignettes calculées (tests)

    # ── Signature ────────────────────────────────────────────────────────
    def signature(self, clip):
        rev = self.editor.content_rev
        cached = self.sigs.get(clip.id)
        if cached is not None and cached[0] == rev:
            return cached[1]
        if self.lib_sig[0] != rev:
            self.lib_sig = (rev, json.dumps(self.editor.doc.library.to_dict(), sort_keys=True))
            self.anim_json.clear()
        tl = self.editor.doc.timeline
        aj = self.anim_json.get(clip.anim_id)
        if aj is None:
            anim = tl.animations.get(clip.anim_id)
            aj = json.dumps(anim.to_dict()["effects"] if anim else None, sort_keys=True)
            self.anim_json[clip.anim_id] = aj
        sig = hash((self.lib_sig[1], clip.def_id, aj, round(clip.duration, 6), round(clip.fade_in, 6),
                    round(clip.fade_out, 6), tl.bpm, tuple(self.editor.default_color())))
        self.sigs[clip.id] = (rev, sig)
        return sig

    # ── Lecture (pendant l'affichage : jamais de calcul) ─────────────────
    def begin_paint(self):
        self.queue = {}

    def get(self, clip, u, size):
        """Vignette du clip à la position u (0..1) ; si elle manque : demandée, et la plus proche est montrée."""
        sig = self.signature(clip)
        step = None if not self.animated.get(sig, True) else int(round(min(1.0, max(0.0, u)) * U_STEPS))
        pm = self.items.get((sig, size, step))
        if pm is not None:
            return pm
        key = (sig, size, step)
        if key not in self.queue:
            self.queue[key] = (clip, u)
        near = self.by_sig.get((sig, size))
        if near:
            if step is None:
                return next(iter(near.values()))
            best = min(near, key=lambda s: abs((s if s is not None else 0) - step))
            return near[best]
        return None

    def end_paint(self):
        if self.queue and not self.timer.isActive():
            self.timer.start()

    def pending(self):
        return bool(self.queue)

    # ── Calcul par lots ──────────────────────────────────────────────────
    def work(self):
        deadline = time.perf_counter() + BUDGET_S
        ed = self.editor
        done = 0
        while self.queue and time.perf_counter() < deadline:
            key, (clip, u) = next(iter(self.queue.items()))
            del self.queue[key]
            sig, size, step = key
            if self.animated.get(sig) is False and (sig, size, None) in self.items:
                continue
            if ed.doc.timeline.find_clip(clip.id)[1] is not clip:
                continue
            pm = QPixmap(size, size)
            pm.fill(theme.qc(theme.BG_MIRE))
            strokes, animated = clip_strokes(ed.doc.timeline, ed.doc.library, clip,
                                             clip.start + u * clip.duration, ed.default_color())
            self.animated[sig] = animated
            if not animated:
                step = None
            draw_fast(pm, strokes, size)
            self._store((sig, size, step), pm)
            done += 1
        if done:
            self.ready.emit()
        if self.queue:
            self.timer.start()

    def _store(self, key, pm):
        if len(self.items) > MAX_ENTRIES:
            self.items.clear()
            self.by_sig.clear()
        sig, size, step = key
        self.items[key] = pm
        self.by_sig.setdefault((sig, size), {})[step] = pm
        self.computed += 1

    def clear(self):
        """Thème changé : fond des vignettes à refaire."""
        self.items.clear()
        self.by_sig.clear()
        self.queue = {}
