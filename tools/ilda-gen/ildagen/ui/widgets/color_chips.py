"""ColorChips : rangée de pastilles de couleur (couleur d'un calque, couleur forcée des maîtres…).

Pastilles carrées de 18 px ; la pastille choisie est entourée de l'accent. Pastille « aucune » (fond de champ,
contour pointillé) si allow_none, en tête (none_first) ou en fin de rangée.
colors : (r, g, b) entre 0 et 1, ou « #rrggbb » (par défaut : couleurs laser du thème).

Signal : colorChosen(object) = choix de l'utilisateur : (r, g, b) ou None (aucune). set_value(c) : sans signal ;
une couleur absente de la rangée n'entoure aucune pastille.
"""

from PySide6.QtCore import QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QWidget

from .. import theme

SIZE, GAP, PAD = 18, 5, 3       # PAD : place du contour de sélection
TOL = 1.5 / 255


def to_rgb(c):
    if isinstance(c, str):
        q = QColor(c)
        return (q.redF(), q.greenF(), q.blueF())
    return tuple(float(x) for x in c[:3])


class ColorChips(QWidget):
    colorChosen = Signal(object)

    def __init__(self, colors=None, allow_none=True, none_first=False, none_tip="Aucune", parent=None):
        super().__init__(parent)
        self.allow_none = allow_none
        self.none_first = none_first
        self.none_tip = none_tip
        self._value = None
        self._hover = -1
        self.set_colors(colors if colors is not None else theme.LASER_COLORS)
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def set_colors(self, colors):
        self._colors = [to_rgb(c) for c in colors]
        self._entries = list(self._colors)
        if self.allow_none:
            self._entries.insert(0 if self.none_first else len(self._entries), None)
        self.updateGeometry()
        self.update()

    def entries(self):
        """Pastilles dans l'ordre affiché : (r, g, b) ou None (aucune)."""
        return list(self._entries)

    def value(self):
        return self._value

    def set_value(self, c):
        self._value = None if c is None else to_rgb(c)
        self.update()

    def selected_index(self):
        if self._value is None:
            return self._entries.index(None) if self.allow_none else -1
        for i, c in enumerate(self._entries):
            if c is not None and all(abs(a - b) <= TOL for a, b in zip(c, self._value)):
                return i
        return -1

    def chip_rect(self, i):
        return QRectF(PAD + i * (SIZE + GAP), (self.height() - SIZE) / 2, SIZE, SIZE)

    def index_at(self, pos):
        hits = (i for i in range(len(self._entries)) if self.chip_rect(i).adjusted(-2, -2, 2, 2).contains(pos))
        return next(hits, -1)

    def sizeHint(self):
        n = len(self._entries)
        return QSize(2 * PAD + n * SIZE + max(0, n - 1) * GAP, SIZE + 2 * PAD)

    def minimumSizeHint(self):
        return self.sizeHint()

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        sel = self.selected_index()
        for i, c in enumerate(self._entries):
            r = self.chip_rect(i)
            if c is None:
                p.setBrush(theme.qc(theme.BG_FIELD))
                pen = QPen(theme.qc(theme.TEXT_OFF), 1, Qt.PenStyle.DashLine)
                pen.setDashPattern([2, 2])
                p.setPen(pen)
                p.drawRoundedRect(r.adjusted(0.5, 0.5, -0.5, -0.5), 2, 2)
            else:
                p.setPen(Qt.PenStyle.NoPen)
                p.setBrush(QColor.fromRgbF(*c))
                p.drawRoundedRect(r, 2, 2)
            if i == sel:
                p.setPen(QPen(theme.qc(theme.ACCENT), 2))
                p.setBrush(Qt.BrushStyle.NoBrush)
                p.drawRoundedRect(r.adjusted(-2, -2, 2, 2), 3, 3)
            elif i == self._hover and self.isEnabled():
                p.setPen(QPen(theme.qc(theme.BORDER_STRONG), 1))
                p.setBrush(Qt.BrushStyle.NoBrush)
                p.drawRoundedRect(r.adjusted(-1.5, -1.5, 1.5, 1.5), 3, 3)
        p.end()

    def mouseMoveEvent(self, e):
        i = self.index_at(e.position())
        if i != self._hover:
            self._hover = i
            c = self._entries[i] if i >= 0 else 0
            self.setToolTip(self.none_tip if c is None else "")
            self.update()

    def leaveEvent(self, e):
        self._hover = -1
        self.update()
        super().leaveEvent(e)

    def mousePressEvent(self, e):
        if e.button() != Qt.MouseButton.LeftButton:
            return
        i = self.index_at(e.position())
        if i < 0:
            return
        c = self._entries[i]
        self._value = c
        self.update()
        self.colorChosen.emit(c)
