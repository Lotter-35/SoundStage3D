"""Section « Couleur » de la barre de gauche : couleur de tracé (par défaut, unie, dégradé)."""

from PySide6.QtCore import QRectF, QSize, Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import (QButtonGroup, QComboBox, QGridLayout, QHBoxLayout, QPushButton, QToolButton,
                               QVBoxLayout, QWidget)

from ..core.colorutil import LASER_COLORS
from ..core.shape_color import GRAD_TYPES
from . import theme
from .properties.widgets import ColorSwatch, GradientBar, ScrubField


class MiniSwatch(QToolButton):
    """Pastille de couleur pure (clic = couleur unie)."""

    def __init__(self, rgb, parent=None):
        super().__init__(parent)
        self.rgb = rgb
        self.setFixedSize(QSize(16, 16))
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(QPen(theme.qc(theme.TEXT) if self.underMouse() else theme.qc(theme.BORDER), 1))
        p.setBrush(QColor.fromRgbF(*self.rgb))
        p.drawRoundedRect(QRectF(self.rect()).adjusted(1.5, 1.5, -1.5, -1.5), 2, 2)


class ColorPanel(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)

        modes = QHBoxLayout()
        modes.setSpacing(2)
        self.mode_group = QButtonGroup(self)
        for i, label in enumerate(("Défaut", "Unie", "Dégradé")):
            b = QPushButton(label)
            b.setCheckable(True)
            b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            b.setStyleSheet("padding: 2px 2px; font-size: 11px;")
            b.setToolTip(["Couleur par défaut (Paramètres)", "Une seule couleur", "Dégradé de plusieurs couleurs"][i])
            self.mode_group.addButton(b, i)
            modes.addWidget(b)
        self.mode_group.idClicked.connect(lambda i: self._set("mode", i))
        lay.addLayout(modes)

        # Couleur unie
        self.solid = QWidget()
        sl = QVBoxLayout(self.solid)
        sl.setContentsMargins(0, 0, 0, 0)
        sl.setSpacing(4)
        self.swatch = ColorSwatch()
        self.swatch.setFixedSize(QSize(120, 20))
        self.swatch.valueEdited.connect(lambda c: self._set("color", list(c), save=False))
        self.swatch.editFinished.connect(self._save)
        sl.addWidget(self.swatch)
        pal = QGridLayout()
        pal.setSpacing(2)
        for i, rgb in enumerate(LASER_COLORS):
            m = MiniSwatch(rgb)
            m.setToolTip("Couleur pure du laser")
            m.clicked.connect(lambda _=False, c=rgb: self._pick(c))
            pal.addWidget(m, 0, i)
        pal.setColumnStretch(len(LASER_COLORS), 1)
        sl.addLayout(pal)
        lay.addWidget(self.solid)

        # Dégradé
        self.grad = QWidget()
        gl = QVBoxLayout(self.grad)
        gl.setContentsMargins(0, 0, 0, 0)
        gl.setSpacing(4)
        self.bar = GradientBar()
        self.bar.setMinimumWidth(100)
        self.bar.setToolTip("Clic : ajouter une couleur · glisser : déplacer · double-clic : changer · clic droit : retirer")
        self.bar.valueEdited.connect(lambda v: self._set("stops", v, save=False))
        self.bar.editFinished.connect(self._save)
        gl.addWidget(self.bar)
        self.gtype = QComboBox()
        self.gtype.addItems(GRAD_TYPES)
        self.gtype.activated.connect(lambda i: self._set("type", i))
        gl.addWidget(self.gtype)
        self.angle = ScrubField(1, -3600.0, 3600.0, (-180.0, 180.0), "°")
        self.angle.setToolTip("Angle du dégradé (linéaire / angulaire)")
        self.angle.valueEdited.connect(lambda v: self._set("angle", v, save=False))
        self.angle.editFinished.connect(self._save)
        gl.addWidget(self.angle)
        lay.addWidget(self.grad)

        self.apply_btn = QPushButton("Appliquer à la sélection")
        self.apply_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.apply_btn.setStyleSheet("padding: 2px 4px; font-size: 11px;")
        self.apply_btn.setToolTip("Colorie les formes sélectionnées avec cette couleur (aussi : outil Seau, touche G)")
        self.apply_btn.clicked.connect(editor.paint_selection)
        lay.addWidget(self.apply_btn)

        editor.brushChanged.connect(self.refresh)
        editor.selectionChanged.connect(self._sel)
        self.refresh()
        self._sel()

    def _pick(self, rgb):
        b = self.editor.brush()
        b["mode"] = 1
        b["color"] = list(rgb)
        self.editor.brush_changed()

    def _set(self, key, value, save=True):
        self.editor.brush()[key] = value
        if save:
            self.editor.brush_changed()
        else:
            self._update_visibility()

    def _save(self):
        self.editor.brush_changed()

    def _sel(self):
        self.apply_btn.setEnabled(bool(self.editor.selection))

    def _update_visibility(self):
        b = self.editor.brush()
        self.solid.setVisible(int(b["mode"]) == 1)
        self.grad.setVisible(int(b["mode"]) == 2)
        self.angle.setVisible(int(b["type"]) in (1, 3))

    def refresh(self):
        b = self.editor.brush()
        self.mode_group.button(int(b["mode"])).setChecked(True)
        self.swatch.set_value(tuple(b["color"]))
        self.bar.set_value(b["stops"])
        self.gtype.setCurrentIndex(int(b["type"]))
        self.angle.set_value(float(b["angle"]))
        self._update_visibility()
