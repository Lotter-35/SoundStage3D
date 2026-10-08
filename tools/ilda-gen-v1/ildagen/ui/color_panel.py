"""Section « Couleur » de la barre de gauche, comme dans Photoshop.

- grand carré : couleur active (clic = la changer) ;
- petit carré derrière : seconde couleur (clic = inverser les deux, touche X ; D = couleurs par défaut).
Les nouvelles formes et le seau prennent la couleur active. Les dégradés se font avec le modifieur Dégradé.
"""

from PySide6.QtCore import QRectF, QSize, Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QColorDialog, QHBoxLayout, QWidget

from . import theme


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
        p.setPen(QPen(theme.qc(theme.TEXT_DIM), 1))
        p.setBrush(QColor.fromRgbF(*b["color"]))
        p.drawRect(self.fg_rect())

    def mousePressEvent(self, e):
        pos = e.position()
        ed = self.editor
        if self.fg_rect().contains(pos):
            c = pick_color(self, ed.brush()["color"])
            if c is not None:
                ed.brush()["color"] = c
                ed.brush_changed()
        elif self.bg_rect().contains(pos):
            ed.swap_colors()


class ColorPanel(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 2, 0, 0)
        self.fgbg = FgBgSwatch(editor)
        lay.addWidget(self.fgbg)
        lay.addStretch(1)
        editor.brushChanged.connect(self.fgbg.update)
