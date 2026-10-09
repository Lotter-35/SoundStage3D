"""Colonne d'outils de l'espace Forme (étroite) : Sélection, Crayon, Seau | tracés de base | deux couleurs.

La lettre du raccourci est écrite en petit dans le coin bas droit, dans sa propre place : elle ne recouvre jamais
l'icône (F6). Infobulle : nom de l'outil et touche.
"""

from PySide6.QtCore import QRect, QSize, Qt
from PySide6.QtGui import QPainter
from PySide6.QtWidgets import QButtonGroup, QFrame, QToolButton, QVBoxLayout, QWidget

from ...core.shapes import BASIC_SHAPES
from .. import icons, theme
from ..color_panel import FgBgSwatch

TOOLS = [("select", "Sélection", "mouse-pointer-2", "V"), ("pencil", "Crayon", "pencil", "B"),
         ("bucket", "Seau : colorier une forme ou une zone", "paint-bucket", "G")]
SHAPE_KEYS = {"line": "L", "rect": "R", "ellipse": "E", "triangle": "T", "star": "S", "polygon": "P", "ilda_test": "M"}
BTN_W, BTN_H, ICON = 36, 30, 18
KEY_W = 9            # place de la lettre, à droite de l'icône


class ToolButton(QToolButton):
    """Bouton d'outil : icône à gauche du centre, lettre du raccourci dans sa colonne à droite."""

    def __init__(self, key, parent=None):
        super().__init__(parent)
        self.key = key
        self.setFixedSize(BTN_W, BTN_H)
        self.setCheckable(True)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setIconSize(QSize(ICON, ICON))

    def paintEvent(self, _e):
        p = QPainter(self)
        r = self.rect()
        if self.isChecked():
            p.fillRect(r, theme.qc(theme.SEL))
        elif self.underMouse():
            p.fillRect(r, theme.qc(theme.BG_HOVER))
        col = theme.ACCENT if self.isChecked() else (theme.TEXT if self.underMouse() else theme.TEXT_DIM)
        ix = (BTN_W - KEY_W - ICON) // 2 + 1
        p.drawPixmap(ix, (BTN_H - ICON) // 2, icons.pixmap(self.icon_name, col, ICON, self.devicePixelRatioF()))
        if self.key:
            p.setFont(theme.ui_font(9, True))
            p.setPen(theme.qc(theme.TEXT_DIM if self.isChecked() else theme.TEXT_OFF))
            p.drawText(QRect(BTN_W - KEY_W - 2, 0, KEY_W, BTN_H - 2),
                       Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignBottom, self.key)
        p.end()

    def enterEvent(self, e):
        self.update()
        super().enterEvent(e)

    def leaveEvent(self, e):
        self.update()
        super().leaveEvent(e)


def separator():
    f = QFrame()
    f.setFixedSize(22, 1)
    f.setStyleSheet(f"background: {theme.BORDER};")
    return f


class ToolColumn(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setObjectName("toolColumn")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground)
        self.setFixedWidth(BTN_W + 8)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 6, 4, 6)
        lay.setSpacing(2)
        lay.setAlignment(Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop)
        self.group = QButtonGroup(self)
        self.group.setExclusive(True)
        self.buttons = {}
        for t, label, ic, key in TOOLS:
            lay.addWidget(self._button(t, label, ic, key), 0, Qt.AlignmentFlag.AlignHCenter)
        self.seps = [separator()]
        lay.addSpacing(3)
        lay.addWidget(self.seps[0], 0, Qt.AlignmentFlag.AlignHCenter)
        lay.addSpacing(3)
        for k, label, ic in BASIC_SHAPES:
            lay.addWidget(self._button("shape:" + k, label, ic, SHAPE_KEYS[k]), 0, Qt.AlignmentFlag.AlignHCenter)
        self.seps.append(separator())
        lay.addSpacing(3)
        lay.addWidget(self.seps[1], 0, Qt.AlignmentFlag.AlignHCenter)
        lay.addSpacing(6)
        self.swatch = FgBgSwatch(editor)
        self.swatch.setFixedSize(QSize(34, 32))
        lay.addWidget(self.swatch, 0, Qt.AlignmentFlag.AlignHCenter)
        lay.addStretch(1)
        editor.toolChanged.connect(self._tool_changed)
        editor.brushChanged.connect(self.swatch.update)
        theme.notifier.changed.connect(self._restyle)
        self._tool_changed(editor.tool)

    def _button(self, tool, label, ic, key):
        b = ToolButton(key)
        b.icon_name = ic
        b.setToolTip(f"{label} ({key})")
        b.clicked.connect(lambda _=False, t=tool: self.editor.set_tool(t))
        self.group.addButton(b)
        self.buttons[tool] = b
        return b

    def _restyle(self, *_):
        for s in self.seps:
            s.setStyleSheet(f"background: {theme.BORDER};")

    def _tool_changed(self, tool):
        b = self.buttons.get(tool)
        if b is not None:
            b.setChecked(True)
