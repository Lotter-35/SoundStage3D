"""Champs de réglage : valeur glissable (scrub), couleur, dégradé, liste, case à cocher."""

from PySide6.QtCore import QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QLinearGradient, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QCheckBox, QColorDialog, QComboBox, QLineEdit, QSizePolicy, QToolButton, QWidget

from .. import theme


class ScrubField(QLineEdit):
    """Valeur numérique : glisser horizontalement pour la changer (Maj = fin, Ctrl = rapide), clic pour la taper,
    Alt + clic pour revenir à la valeur par défaut. L'unité est affichée à côté, jamais dans le texte modifiable."""

    editStarted = Signal()
    valueEdited = Signal(float)
    editFinished = Signal()
    resetRequested = Signal()

    def __init__(self, decimals=2, minimum=None, maximum=None, soft=(None, None), unit="", factor=1.0,
                 integer=False, parent=None):
        super().__init__(parent)
        self.decimals = 0 if integer else decimals
        self.minimum, self.maximum = minimum, maximum
        lo = soft[0] if soft[0] is not None else (minimum if minimum is not None else -1.0)
        hi = soft[1] if soft[1] is not None else (maximum if maximum is not None else 1.0)
        self.px_step = max((hi - lo) / 300.0, 10 ** (-self.decimals) if self.decimals else 0.0)
        if integer:
            self.px_step = max(self.px_step, 0.1)
        self.unit = unit
        self.factor = factor
        self.integer = integer
        self.value = 0.0
        self._press = None
        self._scrubbing = False
        self._typing = False
        self._acc = 0.0
        self.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.setCursor(Qt.CursorShape.SizeHorCursor)
        self.setMinimumWidth(48)
        self.setFont(theme.mono_font(11))
        self.unit_text = unit.strip()
        if self.unit_text:
            w = self.fontMetrics().horizontalAdvance(self.unit_text)
            self.setTextMargins(0, 0, w + 6, 0)
        self._reset_click = False
        self.editingFinished.connect(self._typed)

    def _bound(self, v):
        if self.minimum is not None:
            v = max(self.minimum, v)
        if self.maximum is not None:
            v = min(self.maximum, v)
        return v

    def _clamp(self, v):
        v = self._bound(v)
        return round(v) if self.integer else v

    def _fmt(self, v):
        s = f"{v * self.factor:.{self.decimals}f}"
        return s

    def set_value(self, v):
        if v is None:
            return
        self.value = float(v)
        if not self.hasFocus() and not self._scrubbing:
            self.setText(self._fmt(self.value))

    def paintEvent(self, e):
        super().paintEvent(e)
        if self.unit_text:
            p = QPainter(self)
            p.setFont(self.font())
            p.setPen(theme.qc(theme.TEXT_DIM))
            p.drawText(self.rect().adjusted(0, 0, -6, 0), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                       self.unit_text)
            p.end()

    def mousePressEvent(self, e):
        # Clic puis glisser à gauche / à droite = régler (même si le champ est en saisie) ;
        # clic sans bouger = taper une valeur ; Alt + clic = valeur par défaut.
        self._reset_click = bool(e.modifiers() & Qt.KeyboardModifier.AltModifier)
        if e.button() == Qt.MouseButton.LeftButton:
            self._press = e.position().x()
            self._acc = self.value
            self._scrubbing = False
            self._typing = self.hasFocus()
            if self._typing:
                super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._press is None or not (e.buttons() & Qt.MouseButton.LeftButton):
            return
        dx = e.position().x() - self._press
        if not self._scrubbing and abs(dx) < 3:
            return
        if not self._scrubbing:
            self._scrubbing = True
            if self.hasFocus():
                self.clearFocus()
            self.editStarted.emit()
        self._press = e.position().x()
        mods = e.modifiers()
        k = 0.1 if mods & Qt.KeyboardModifier.ShiftModifier else (
            10.0 if mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier) else 1.0)
        self._acc = self._bound(self._acc + dx * self.px_step * k)
        self.value = self._clamp(self._acc)
        self.setText(self._fmt(self.value))
        self.valueEdited.emit(self.value)

    def mouseReleaseEvent(self, e):
        if self._scrubbing:
            self._scrubbing = False
            self._press = None
            self.editFinished.emit()
            return
        self._press = None
        if self._reset_click:
            self._reset_click = False
            self.clearFocus()
            self.resetRequested.emit()
            return
        if self._typing:
            super().mouseReleaseEvent(e)
            return
        self.setFocus()
        self.setText(f"{self.value * self.factor:.{self.decimals}f}")
        self.selectAll()

    def focusOutEvent(self, e):
        super().focusOutEvent(e)
        self.setText(self._fmt(self.value))

    def _typed(self):
        txt = self.text().replace(",", ".").strip()
        if self.unit_text:
            txt = txt.replace(self.unit_text, "").strip()
        try:
            v = self._clamp(float(txt) / self.factor)
        except ValueError:
            self.setText(self._fmt(self.value))
            return
        if abs(v - self.value) > 1e-12:
            self.editStarted.emit()
            self.value = v
            self.valueEdited.emit(v)
            self.editFinished.emit()
        self.clearFocus()

    def keyPressEvent(self, e):
        if e.key() == Qt.Key.Key_Escape:
            self.setText(self._fmt(self.value))
            self.clearFocus()
            return
        super().keyPressEvent(e)


class ColorSwatch(QToolButton):
    editStarted = Signal()
    valueEdited = Signal(object)
    editFinished = Signal()
    resetRequested = Signal()

    def mousePressEvent(self, e):
        if e.modifiers() & Qt.KeyboardModifier.AltModifier:
            self.resetRequested.emit()
            return
        super().mousePressEvent(e)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.value = (1.0, 1.0, 1.0)
        self.setFixedSize(44, 18)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.clicked.connect(self._pick)

    def set_value(self, v):
        if v is not None:
            self.value = tuple(v)
            self.update()

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(QPen(theme.qc(theme.BORDER), 1))
        p.setBrush(QColor.fromRgbF(*self.value))
        p.drawRoundedRect(QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5), 3, 3)

    def _pick(self):
        start = self.value
        dlg = QColorDialog(QColor.fromRgbF(*start), self)
        dlg.setOption(QColorDialog.ColorDialogOption.DontUseNativeDialog, True)
        self.editStarted.emit()
        dlg.currentColorChanged.connect(lambda c: self._live(c))
        ok = dlg.exec()
        if not ok:
            self.value = start
            self.valueEdited.emit(start)
        self.update()
        self.editFinished.emit()

    def _live(self, c):
        self.value = (c.redF(), c.greenF(), c.blueF())
        self.update()
        self.valueEdited.emit(self.value)


class GradientBar(QWidget):
    """Dégradé : clic sur la barre = ajouter une couleur, glisser un repère = le déplacer,
    double-clic = changer sa couleur, clic droit = le supprimer."""

    editStarted = Signal()
    valueEdited = Signal(object)
    editFinished = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.stops = [[0.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 1.0]]
        self.drag = None
        self.setMinimumHeight(30)
        self.setMinimumWidth(120)

    def set_value(self, v):
        if v is not None and self.drag is None:
            self.stops = [list(map(float, s)) for s in v]
            self.update()

    def bar_rect(self):
        return QRectF(6, 2, self.width() - 12, 14)

    def stop_x(self, pos):
        r = self.bar_rect()
        return r.left() + pos * r.width()

    def hit_stop(self, x, y):
        if y < self.bar_rect().bottom() - 2:
            return None
        for i, s in enumerate(self.stops):
            if abs(self.stop_x(s[0]) - x) <= 6:
                return i
        return None

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = self.bar_rect()
        g = QLinearGradient(r.left(), 0, r.right(), 0)
        for s in sorted(self.stops, key=lambda s: s[0]):
            g.setColorAt(max(0.0, min(1.0, s[0])), QColor.fromRgbF(s[1], s[2], s[3]))
        p.setPen(QPen(theme.qc(theme.BORDER), 1))
        p.setBrush(g)
        p.drawRoundedRect(r, 2, 2)
        for s in self.stops:
            x = self.stop_x(s[0])
            tri = QPolygonF([QPointF(x, r.bottom() + 1), QPointF(x + 5, r.bottom() + 9), QPointF(x - 5, r.bottom() + 9)])
            p.setPen(QPen(theme.qc(theme.TEXT), 1))
            p.setBrush(QColor.fromRgbF(s[1], s[2], s[3]))
            p.drawPolygon(tri)

    def _emit(self):
        self.valueEdited.emit([list(s) for s in self.stops])
        self.update()

    def mousePressEvent(self, e):
        x, y = e.position().x(), e.position().y()
        i = self.hit_stop(x, y)
        if e.button() == Qt.MouseButton.RightButton:
            if i is not None and len(self.stops) > 2:
                self.editStarted.emit()
                self.stops.pop(i)
                self._emit()
                self.editFinished.emit()
            return
        self.editStarted.emit()
        if i is None:
            r = self.bar_rect()
            pos = max(0.0, min(1.0, (x - r.left()) / r.width()))
            col = self._color_at(pos)
            self.stops.append([pos, *col])
            i = len(self.stops) - 1
            self._emit()
        self.drag = i

    def _color_at(self, pos):
        st = sorted(self.stops, key=lambda s: s[0])
        if pos <= st[0][0]:
            return st[0][1:]
        for a, b in zip(st, st[1:]):
            if a[0] <= pos <= b[0]:
                k = (pos - a[0]) / ((b[0] - a[0]) or 1.0)
                return [a[j] + (b[j] - a[j]) * k for j in (1, 2, 3)]
        return st[-1][1:]

    def mouseMoveEvent(self, e):
        if self.drag is None:
            return
        r = self.bar_rect()
        self.stops[self.drag][0] = max(0.0, min(1.0, (e.position().x() - r.left()) / r.width()))
        self._emit()

    def mouseReleaseEvent(self, e):
        if self.drag is not None:
            self.drag = None
            self.editFinished.emit()

    def mouseDoubleClickEvent(self, e):
        i = self.hit_stop(e.position().x(), e.position().y())
        if i is None:
            return
        s = self.stops[i]
        c = QColorDialog.getColor(QColor.fromRgbF(s[1], s[2], s[3]), self, "Couleur",
                                  QColorDialog.ColorDialogOption.DontUseNativeDialog)
        if c.isValid():
            self.editStarted.emit()
            self.stops[i][1:] = [c.redF(), c.greenF(), c.blueF()]
            self._emit()
            self.editFinished.emit()


class EnumField(QComboBox):
    editStarted = Signal()
    valueEdited = Signal(int)
    editFinished = Signal()

    def __init__(self, options, parent=None):
        super().__init__(parent)
        self.addItems(options)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        # Prend la largeur disponible sans exiger la place du plus long choix
        self.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
        self.setMinimumContentsLength(4)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.activated.connect(self._chosen)

    def set_value(self, v):
        if v is not None:
            self.blockSignals(True)
            self.setCurrentIndex(int(v))
            self.blockSignals(False)

    def _chosen(self, i):
        self.editStarted.emit()
        self.valueEdited.emit(i)
        self.editFinished.emit()

    def wheelEvent(self, e):
        e.ignore()   # ne change pas la valeur en faisant défiler le panneau


class BoolField(QCheckBox):
    editStarted = Signal()
    valueEdited = Signal(bool)
    editFinished = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.clicked.connect(self._clicked)

    def set_value(self, v):
        if v is not None:
            self.blockSignals(True)
            self.setChecked(bool(v))
            self.blockSignals(False)

    def _clicked(self, on):
        self.editStarted.emit()
        self.valueEdited.emit(on)
        self.editFinished.emit()


class PaletteField(QWidget):
    """Liste de couleurs : clic sur une pastille = changer sa couleur, clic droit = la retirer,
    « + » = en ajouter une."""

    editStarted = Signal()
    valueEdited = Signal(object)
    editFinished = Signal()
    SW = 22
    GAP = 4

    def __init__(self, parent=None):
        super().__init__(parent)
        self.value = []
        self.setFixedHeight(self.SW)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip("Clic : changer la couleur · clic droit : la retirer · + : ajouter une couleur")

    def set_value(self, v):
        if v is not None:
            n = len(self.value)
            self.value = [tuple(c) for c in v]
            if len(self.value) != n:
                self.updateGeometry()
            self.update()

    def sizeHint(self):
        return QSize((len(self.value) + 1) * (self.SW + self.GAP), self.SW)

    def minimumSizeHint(self):
        return self.sizeHint()

    def _rects(self):
        out = [QRectF(i * (self.SW + self.GAP), 0, self.SW, self.SW).adjusted(0.5, 0.5, -0.5, -0.5)
               for i in range(len(self.value))]
        plus = QRectF(len(self.value) * (self.SW + self.GAP), 0, self.SW, self.SW).adjusted(0.5, 0.5, -0.5, -0.5)
        return out, plus

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        rects, plus = self._rects()
        for r, c in zip(rects, self.value):
            p.setPen(QPen(theme.qc(theme.BORDER), 1))
            p.setBrush(QColor.fromRgbF(*c))
            p.drawRoundedRect(r, 3, 3)
        p.setPen(QPen(theme.qc(theme.TEXT_DIM), 1, Qt.PenStyle.DashLine))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRoundedRect(plus, 3, 3)
        c = plus.center()
        p.setPen(QPen(theme.qc(theme.TEXT_DIM), 1.4))
        p.drawLine(QPointF(c.x() - 5, c.y()), QPointF(c.x() + 5, c.y()))
        p.drawLine(QPointF(c.x(), c.y() - 5), QPointF(c.x(), c.y() + 5))

    def _emit(self):
        self.updateGeometry()
        self.update()
        self.valueEdited.emit(list(self.value))

    def mousePressEvent(self, e):
        rects, plus = self._rects()
        pos = e.position()
        hit = next((i for i, r in enumerate(rects) if r.contains(pos)), None)
        if e.button() == Qt.MouseButton.RightButton:
            if hit is not None and len(self.value) > 1:
                self.editStarted.emit()
                del self.value[hit]
                self._emit()
                self.editFinished.emit()
            return
        if e.button() != Qt.MouseButton.LeftButton:
            return
        if plus.contains(pos):
            self.editStarted.emit()
            self.value.append(self.value[-1] if self.value else (1.0, 1.0, 1.0))
            self._emit()
            self._pick(len(self.value) - 1, started=True)
            return
        if hit is not None:
            self.editStarted.emit()
            self._pick(hit, started=True)

    def _pick(self, i, started=False):
        start = self.value[i]
        dlg = QColorDialog(QColor.fromRgbF(*start), self)
        dlg.setOption(QColorDialog.ColorDialogOption.DontUseNativeDialog, True)

        def live(c):
            self.value[i] = (c.redF(), c.greenF(), c.blueF())
            self._emit()
        dlg.currentColorChanged.connect(live)
        if not dlg.exec():
            self.value[i] = start
            self._emit()
        self.editFinished.emit()
