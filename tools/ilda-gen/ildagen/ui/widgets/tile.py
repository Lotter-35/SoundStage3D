"""Tile : vignette d'une forme (liste des formes) ou d'un cue (grille Live).

Aperçu peint par un rappel painter(QPainter, QRectF) sur fond noir ; nom dans un bandeau en bas :
strip="overlay" (bandeau sombre posé sur l'aperçu, vignette carrée) ou "bar" (bandeau sous l'aperçu, cue).
États : selected (contour accent), playing (contour accent, bandeau accent, barre de progression),
waiting (contour accent pointillé, « · en attente »), empty (case vide en pointillés), add (case « + »).
key : touche du clavier écrite en haut à droite.

Signaux : clicked(), doubleClicked(), contextRequested(QPoint) (position globale du clic droit).
"""

from PySide6.QtCore import QPoint, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from .. import icons, theme

STRIP_H = 20


class Tile(QWidget):
    clicked = Signal()
    doubleClicked = Signal()
    contextRequested = Signal(QPoint)

    def __init__(self, name="", painter=None, key="", strip="overlay", square=True, parent=None):
        super().__init__(parent)
        self.name = name
        self.painter = painter
        self.key = key
        self.strip = strip
        self.square = square
        self.selected = self.playing = self.waiting = self.empty = self.add = False
        self.progress = None
        self._hover = False
        self._pressed = False
        self.setMouseTracking(True)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)

    # ── État ─────────────────────────────────────────────────────────────
    def set_name(self, name):
        self.name = name
        self.update()

    def set_painter(self, painter):
        self.painter = painter
        self.update()

    def set_key(self, key):
        self.key = key
        self.update()

    def set_state(self, selected=None, playing=None, waiting=None, empty=None, add=None):
        for k, v in (("selected", selected), ("playing", playing), ("waiting", waiting), ("empty", empty),
                     ("add", add)):
            if v is not None:
                setattr(self, k, bool(v))
        self.update()

    def set_progress(self, v):
        """Avancement du cue en cours (0..1), None = pas de barre."""
        self.progress = v
        self.update()

    # ── Géométrie ────────────────────────────────────────────────────────
    def hasHeightForWidth(self):
        return self.square

    def heightForWidth(self, w):
        return w

    def sizeHint(self):
        return QSize(120, 120)

    def preview_rect(self):
        r = QRectF(self.rect()).adjusted(1, 1, -1, -1)
        if self.strip == "bar":
            return r.adjusted(8, 8, -8, -STRIP_H - 2)
        return r

    # ── Rendu ────────────────────────────────────────────────────────────
    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        outer = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        if self.empty or self.add:
            pen = QPen(theme.qc(theme.BORDER_STRONG if (self.add and self._hover) else theme.BG_FIELD), 1,
                       Qt.PenStyle.DashLine)
            pen.setDashPattern([3, 3])
            p.setPen(pen)
            p.drawRoundedRect(outer, theme.RADIUS, theme.RADIUS)
            if self.add:
                n = 17
                col = theme.TEXT_DIM if self._hover else theme.TEXT_OFF
                pm = icons.pixmap("plus", col, n, self.devicePixelRatioF())
                p.drawPixmap(int(outer.center().x() - n / 2), int(outer.center().y() - n / 2), pm)
            p.end()
            return
        clip = QPainterPath()
        clip.addRoundedRect(outer, theme.RADIUS, theme.RADIUS)
        p.fillPath(clip, theme.qc(theme.BG_MIRE))
        p.save()
        p.setClipPath(clip)
        if self.painter is not None:
            p.save()
            self.painter(p, self.preview_rect())
            p.restore()
        self._paint_strip(p, outer)
        p.restore()
        if self.key:
            p.setFont(theme.mono_font(10))
            p.setPen(theme.qc(theme.TEXT_DIM))
            p.drawText(outer.adjusted(0, 4, -6, 0), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignTop, self.key)
        self._paint_border(p, outer)
        p.end()

    def _paint_strip(self, p, outer):
        sr = QRectF(outer.left(), outer.bottom() - STRIP_H, outer.width(), STRIP_H)
        if self.playing:
            p.fillRect(sr, theme.qc(theme.ACCENT))
        elif self.strip == "bar":
            p.fillRect(sr, theme.qc(theme.BG_CARD))
            p.fillRect(QRectF(sr.left(), sr.top(), sr.width(), 1), theme.qc(theme.BORDER))
        else:
            p.fillRect(sr, theme.qc(theme.BLACK, 0.7))
        f = theme.ui_font(11)
        if self.playing:
            f.setWeight(QFont.Weight.DemiBold)
        p.setFont(f)
        tr = sr.adjusted(6, 0, -6, 0)
        fm = p.fontMetrics()
        suffix = " · en attente" if self.waiting and not self.playing else ""
        name = fm.elidedText(self.name, Qt.TextElideMode.ElideRight, int(tr.width() - fm.horizontalAdvance(suffix)))
        p.setPen(theme.qc(theme.ON_ACCENT if self.playing else theme.TEXT))
        p.drawText(tr, Qt.AlignmentFlag.AlignVCenter, name)
        if suffix:
            p.setPen(theme.qc(theme.TEXT_DIM))
            p.drawText(tr.adjusted(fm.horizontalAdvance(name), 0, 0, 0), Qt.AlignmentFlag.AlignVCenter, suffix)
        if self.playing and self.progress is not None:
            w = sr.width() * min(1.0, max(0.0, self.progress))
            p.fillRect(QRectF(sr.left(), sr.bottom() - 2, w, 2), theme.qc(theme.ON_ACCENT))

    def _paint_border(self, p, outer):
        p.setBrush(Qt.BrushStyle.NoBrush)
        if self.selected or self.playing:
            p.setPen(QPen(theme.qc(theme.ACCENT), 2))
            p.drawRoundedRect(outer.adjusted(0.5, 0.5, -0.5, -0.5), theme.RADIUS, theme.RADIUS)
        elif self.waiting:
            pen = QPen(theme.qc(theme.ACCENT), 1, Qt.PenStyle.DashLine)
            pen.setDashPattern([3, 2])
            p.setPen(pen)
            p.drawRoundedRect(outer, theme.RADIUS, theme.RADIUS)
        else:
            p.setPen(QPen(theme.qc(theme.BORDER_STRONG if self._hover else theme.BORDER), 1))
            p.drawRoundedRect(outer, theme.RADIUS, theme.RADIUS)

    # ── Souris ───────────────────────────────────────────────────────────
    def enterEvent(self, e):
        self._hover = True
        self.update()
        super().enterEvent(e)

    def leaveEvent(self, e):
        self._hover = False
        self.update()
        super().leaveEvent(e)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._pressed = True
        elif e.button() == Qt.MouseButton.RightButton:
            self.contextRequested.emit(e.globalPosition().toPoint())

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self._pressed:
            self._pressed = False
            if self.rect().contains(e.position().toPoint()):
                self.clicked.emit()

    def mouseDoubleClickEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.doubleClicked.emit()
