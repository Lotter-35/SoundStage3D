"""Section « Couleur » de la barre de gauche, comme dans Photoshop.

- grand carré : couleur active (clic = la changer) ;
- petit carré derrière : seconde couleur (clic = inverser les deux, touche X ; D = couleurs par défaut) ;
- aperçu du dégradé à côté : clic = tracer en dégradé (son éditeur s'affiche dessous).
Les nouvelles formes et le seau utilisent la couleur active, ou le dégradé s'il est choisi.
"""

from PySide6.QtCore import QRectF, QSize, Qt
from PySide6.QtGui import QColor, QLinearGradient, QPainter, QPen
from PySide6.QtWidgets import QColorDialog, QComboBox, QHBoxLayout, QVBoxLayout, QWidget

from ..core.shape_color import GRAD_TYPES
from . import theme
from .properties.widgets import GradientBar, ScrubField

DEFAULT_FG = [1.0, 1.0, 1.0]
DEFAULT_BG = [1.0, 0.0, 0.0]


def pick_color(parent, rgb, title="Couleur"):
    c = QColorDialog.getColor(QColor.fromRgbF(*rgb), parent, title, QColorDialog.ColorDialogOption.DontUseNativeDialog)
    return [c.redF(), c.greenF(), c.blueF()] if c.isValid() else None


class FgBgSwatch(QWidget):
    """Couleur active (grand carré) et seconde couleur (petit carré)."""

    BIG = 28
    SMALL = 18

    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setFixedSize(QSize(42, 40))
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip("Grand carré : couleur active (clic pour la changer)\n"
                        "Petit carré : clic pour inverser les deux couleurs (X)\nD : couleurs par défaut")

    def fg_rect(self):
        return QRectF(1, 1, self.BIG, self.BIG)

    def bg_rect(self):
        return QRectF(self.width() - self.SMALL - 1, self.height() - self.SMALL - 1, self.SMALL, self.SMALL)

    def paintEvent(self, _e):
        b = self.editor.brush()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(QPen(theme.qc(theme.BORDER), 1))
        p.setBrush(QColor.fromRgbF(*b["bg"]))
        p.drawRect(self.bg_rect())
        active = int(b["mode"]) == 1
        p.setPen(QPen(theme.qc(theme.ACCENT) if active else theme.qc(theme.TEXT_DIM), 1.5 if active else 1))
        p.setBrush(QColor.fromRgbF(*b["color"]))
        p.drawRect(self.fg_rect())

    def mousePressEvent(self, e):
        pos = e.position()
        ed = self.editor
        b = ed.brush()
        if self.fg_rect().contains(pos):
            if int(b["mode"]) != 1:
                b["mode"] = 1
            else:
                c = pick_color(self, b["color"])
                if c is not None:
                    b["color"] = c
            ed.brush_changed()
        elif self.bg_rect().contains(pos):
            ed.swap_colors()


class GradientSwatch(QWidget):
    """Aperçu du dégradé : clic = tracer en dégradé."""

    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setFixedHeight(28)
        self.setMinimumWidth(40)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip("Tracer en dégradé")

    def paintEvent(self, _e):
        b = self.editor.brush()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(1, 1, -1, -1)
        g = QLinearGradient(r.left(), 0, r.right(), 0)
        for s in sorted(b["stops"], key=lambda s: s[0]):
            g.setColorAt(max(0.0, min(1.0, s[0])), QColor.fromRgbF(s[1], s[2], s[3]))
        active = int(b["mode"]) == 2
        p.setPen(QPen(theme.qc(theme.ACCENT) if active else theme.qc(theme.TEXT_DIM), 1.5 if active else 1))
        p.setBrush(g)
        p.drawRect(r)

    def mousePressEvent(self, _e):
        self.editor.brush()["mode"] = 2
        self.editor.brush_changed()


class ColorPanel(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 2, 0, 0)
        lay.setSpacing(6)
        row = QHBoxLayout()
        row.setSpacing(8)
        self.fgbg = FgBgSwatch(editor)
        self.gswatch = GradientSwatch(editor)
        row.addWidget(self.fgbg, 0, Qt.AlignmentFlag.AlignTop)
        row.addWidget(self.gswatch, 1, Qt.AlignmentFlag.AlignTop)
        lay.addLayout(row)

        # Éditeur du dégradé (visible quand le dégradé est choisi)
        self.grad = QWidget()
        gl = QVBoxLayout(self.grad)
        gl.setContentsMargins(0, 0, 0, 0)
        gl.setSpacing(4)
        self.bar = GradientBar()
        self.bar.setMinimumWidth(100)
        self.bar.setToolTip("Clic : ajouter une couleur · glisser : déplacer · double-clic : changer · clic droit : retirer")
        self.bar.valueEdited.connect(self._stops)
        self.bar.editFinished.connect(editor.brush_changed)
        gl.addWidget(self.bar)
        self.gtype = QComboBox()
        self.gtype.addItems(GRAD_TYPES)
        self.gtype.activated.connect(lambda i: self._set("type", i))
        gl.addWidget(self.gtype)
        self.angle = ScrubField(1, -3600.0, 3600.0, (-180.0, 180.0), "°")
        self.angle.setToolTip("Angle du dégradé (linéaire / angulaire)")
        self.angle.valueEdited.connect(lambda v: self._set("angle", v, save=False))
        self.angle.editFinished.connect(editor.brush_changed)
        gl.addWidget(self.angle)
        lay.addWidget(self.grad)

        editor.brushChanged.connect(self.refresh)
        self.refresh()

    def _stops(self, v):
        self.editor.brush()["stops"] = v
        self.gswatch.update()

    def _set(self, key, value, save=True):
        self.editor.brush()[key] = value
        if save:
            self.editor.brush_changed()
        else:
            self.refresh()

    def refresh(self):
        b = self.editor.brush()
        self.bar.set_value(b["stops"])
        self.gtype.setCurrentIndex(int(b["type"]))
        self.angle.set_value(float(b["angle"]))
        self.grad.setVisible(int(b["mode"]) == 2)
        self.angle.setVisible(int(b["type"]) in (1, 3))
        self.fgbg.update()
        self.gswatch.update()
