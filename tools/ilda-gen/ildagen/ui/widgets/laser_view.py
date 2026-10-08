"""Rendu « laser » : traits fins de couleur sur fond noir, avec un halo léger désactivable.

LaserScene : tracés préparés une fois (polylignes regroupées par couleur, en coordonnées de mire) puis peints
autant de fois qu'on veut dans n'importe quel rectangle (mire, vignette, aperçu de cue) : paint(p, rect).
Tracés acceptés : objets à la manière de core.path.Stroke (pts (N, 2), col (N, 3) entre 0 et 1, closed,
kind « line » ou « dots ») ; la couleur d'un segment est celle de son point d'arrivée, noir = éteint.

Pour rester léger (aperçus animés, grille de 32 cues), tout passe par le tracé le plus rapide de Qt, le trait
« cosmétique » de 1 px (un trait plus épais est 20 fois plus lent) :
- trait : 1 px, repassé avec un décalage d'une fraction de pixel pour l'épaisseur voulue ;
- halo : les mêmes traits peints dans une image 4 fois plus petite, agrandie en douceur et ajoutée par-dessus
  le fond (mode « Plus », comme la lumière) ; aucun filtre de flou. Désactivable (glow=False).

LaserView : widget qui affiche une LaserScene (fond de mire, mire [-1, 1] centrée ou cadrage sur les tracés).
"""

import numpy as np
from PySide6.QtCore import QPointF, QRectF, QSize, Qt
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPolygonF, QTransform
from PySide6.QtWidgets import QWidget

from .. import theme

LEVELS = 32              # couleurs quantifiées (regroupement des traits)
GLOW_DIV = 4             # le halo est peint à 1/4 de la taille, puis agrandi
GLOW_ALPHA = 0.6


def _closed(a, closed):
    return np.concatenate((a, a[:1])) if closed and len(a) > 2 else a


def _offsets(width):
    """Décalages des passes du trait de 1 px pour obtenir l'épaisseur voulue (en pixels)."""
    if width <= 1.1:
        return ((0.0, 0.0),)
    d = min(1.0, width - 1.0)
    if width <= 2.1:
        return ((0.0, 0.0), (d, d))
    return ((0.0, 0.0), (d, 0.0), (0.0, d), (d, d))


def _pen(color, w=1.0):
    pen = QPen(color, w)
    pen.setCosmetic(True)
    if w > 1:
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    return pen


class LaserScene:
    def __init__(self, strokes=(), fit=False):
        self.fit = fit
        self.set_strokes(strokes)

    def set_strokes(self, strokes):
        """Prépare les tracés : [(couleur, [QPolygonF…])] et [(couleur, QPolygonF des points isolés)]."""
        lines, dots = {}, {}
        lo, hi = np.array([np.inf, np.inf]), np.array([-np.inf, -np.inf])
        self.count = 0
        for s in strokes:
            pts = np.asarray(s.pts, dtype=float)
            if len(pts) == 0:
                continue
            self.count += len(pts)
            col = np.clip(np.round(np.asarray(s.col, dtype=float) * LEVELS), 0, LEVELS).astype(int)
            lo, hi = np.minimum(lo, pts.min(axis=0)), np.maximum(hi, pts.max(axis=0))
            keys = col[:, 0] * 10000 + col[:, 1] * 100 + col[:, 2]
            if getattr(s, "kind", "line") == "dots" or len(pts) == 1:
                for k in np.unique(keys[keys != 0]):
                    dots.setdefault(int(k), []).extend(QPointF(x, y) for x, y in pts[keys == k])
                continue
            closed = getattr(s, "closed", False)
            pts, keys = _closed(pts, closed), _closed(keys, closed)
            seg = keys[1:]                               # couleur de chaque segment
            start = 0
            for end in list(np.nonzero(np.diff(seg))[0] + 1) + [len(seg)]:
                if seg[start] != 0:
                    run = pts[start:end + 1]
                    lines.setdefault(int(seg[start]), []).append(QPolygonF([QPointF(x, y) for x, y in run]))
                start = end
        self._lines = [(self._color(k), v) for k, v in lines.items()]
        self._dots = [(self._color(k), QPolygonF(v)) for k, v in dots.items()]
        self.bbox = (lo[0], lo[1], hi[0], hi[1]) if self.count else None

    @staticmethod
    def _color(k):
        return QColor.fromRgbF((k // 10000) / LEVELS, (k // 100 % 100) / LEVELS, (k % 100) / LEVELS)

    def is_empty(self):
        return not self._lines and not self._dots

    def square(self, rect):
        side = min(rect.width(), rect.height())
        c = rect.center()
        return QRectF(c.x() - side / 2, c.y() - side / 2, side, side)

    def transform(self, rect, margin=0.0):
        """Mire [-1, 1] (ou boîte des tracés si fit) → carré centré dans rect, marge en px, y vers le haut."""
        side = max(1.0, min(rect.width(), rect.height()) - 2 * margin)
        cx, cy, span = 0.0, 0.0, 2.0
        if self.fit and self.bbox is not None:
            x0, y0, x1, y1 = self.bbox
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            span = max(x1 - x0, y1 - y0, 1e-3) * 1.15
        k = side / span
        c = rect.center()
        return QTransform(k, 0, 0, -k, c.x() - cx * k, c.y() + cy * k)

    def _draw(self, p, base, tr, offsets, dot_w):
        for dx, dy in offsets:
            p.setTransform(tr * QTransform.fromTranslate(dx, dy) * base)
            for color, polys in self._lines:
                p.setPen(_pen(color))
                for poly in polys:
                    p.drawPolyline(poly)
        p.setTransform(tr * base)
        for color, pts in self._dots:
            p.setPen(_pen(color, dot_w))
            p.drawPoints(pts)

    def paint(self, p, rect, glow=True, width=1.5, margin=0.0):
        """Peint les tracés dans rect (le fond n'est pas peint : noir attendu sous le halo)."""
        if self.is_empty():
            return
        p.save()
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setBrush(Qt.BrushStyle.NoBrush)
        if glow:
            self._paint_glow(p, rect, margin)
        self._draw(p, p.transform(), self.transform(rect, margin), _offsets(width), width + 1.5)
        p.restore()

    def _paint_glow(self, p, rect, margin):
        sq = self.square(rect)
        dev = p.device()
        dpr = dev.devicePixelRatioF() if dev is not None else 1.0
        n = max(8, int(sq.width() * dpr / GLOW_DIV))
        img = QImage(n, n, QImage.Format.Format_ARGB32_Premultiplied)
        img.fill(0)
        q = QPainter(img)
        q.setRenderHint(QPainter.RenderHint.Antialiasing)
        k = n / max(1.0, sq.width())
        self._draw(q, QTransform(), self.transform(QRectF(0, 0, n, n), margin * k), ((0.0, 0.0),), 1.5)
        q.end()
        p.save()
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_Plus)
        p.setOpacity(GLOW_ALPHA)
        p.drawImage(sq, img)
        p.restore()


class LaserView(QWidget):
    """Aperçu laser : fond de mire carré, tracés avec halo (glow=False pour l'enlever)."""

    def __init__(self, strokes=(), glow=True, fit=False, width=1.5, margin=6, frame=True, parent=None):
        super().__init__(parent)
        self.scene = LaserScene(strokes, fit)
        self.glow = glow
        self.line_width = width
        self.margin = margin
        self.frame = frame
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent)

    def set_strokes(self, strokes):
        self.scene.set_strokes(strokes)
        self.update()

    def set_glow(self, on):
        self.glow = bool(on)
        self.update()

    def set_fit(self, on):
        self.scene.fit = bool(on)
        self.update()

    def set_line_width(self, w):
        self.line_width = float(w)
        self.update()

    def sizeHint(self):
        return QSize(240, 240)

    def paintEvent(self, _e):
        p = QPainter(self)
        r = QRectF(self.rect())
        p.fillRect(r, theme.qc(theme.BG_APP))
        sq = self.scene.square(r)
        p.fillRect(sq, theme.qc(theme.BG_MIRE))
        if self.frame:
            p.setPen(theme.qc(theme.BG_FIELD))
            p.drawRect(sq.adjusted(0, 0, -1, -1))
        self.scene.paint(p, sq, self.glow, self.line_width, self.margin)
        p.end()
