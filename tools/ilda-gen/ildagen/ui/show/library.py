"""Colonne de gauche de Show : « Formes » (vignettes à glisser dans la timeline) puis « Effets »."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QFrame, QLabel, QScrollArea, QVBoxLayout, QWidget

from .effect_list import EffectBrowser
from .form_tiles import FormTiles


def panel_title(text):
    lab = QLabel(text)
    lab.setObjectName("sectionTitle")
    lab.setFixedHeight(28)
    lab.setContentsMargins(10, 0, 10, 0)
    return lab


def separator():
    s = QFrame()
    s.setFixedHeight(1)
    s.setObjectName("sep")
    s.setStyleSheet("")
    s.setFrameShape(QFrame.Shape.HLine)
    return s


class ShowLibrary(QScrollArea):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.setObjectName("showLibrary")
        self.setWidgetResizable(True)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setMinimumWidth(170)
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        lay.addWidget(panel_title("Formes"))
        self.forms = FormTiles(editor)
        lay.addWidget(self.forms)
        lay.addWidget(separator())
        lay.addWidget(panel_title("Effets"))
        self.effects = EffectBrowser(editor)
        lay.addWidget(self.effects)
        lay.addStretch(1)
        self.setWidget(w)
