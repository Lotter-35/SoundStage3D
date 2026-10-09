"""Espace Forme : outils et liste des formes · mire (en-tête, barre de boucle) · Calques et Réglages.

Tailles d'origine raisonnables (Calques ≈ 1/3 de la hauteur, Réglages le reste), mémorisées par espace."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QHBoxLayout, QSplitter, QWidget

from ..canvas import CanvasArea
from ..layers import LayersPanel
from ..layout import restore_splits, save_splits
from ..tool_panel import ToolPanel
from .loop_bar import LoopBar, PreviewClock
from .reglages import ReglagesPanel

SPLIT = [244, 856, 340]       # outils + formes · mire · calques et réglages (fenêtre de 1440 px)
RIGHT = [300, 540]            # calques · réglages


class FormeWorkspace(QWidget):
    def __init__(self, win, parent=None):
        super().__init__(parent)
        ed = win.editor
        self.clock = PreviewClock(ed)
        self.tools = ToolPanel(ed, self.clock.time)
        self.canvas = CanvasArea(ed, win.live)
        self.canvas.view.time_source = self.clock.time
        self.loop_bar = LoopBar(ed, win.live, self.clock)
        self.canvas.set_footer(self.loop_bar)
        self.layers = LayersPanel(ed)
        self.properties = ReglagesPanel(ed)
        self.reglages = self.properties

        self.right_split = QSplitter(Qt.Orientation.Vertical)
        self.right_split.addWidget(self.layers)
        self.right_split.addWidget(self.properties)
        self.right_split.setStretchFactor(0, 0)
        self.right_split.setStretchFactor(1, 1)
        self.right_split.setChildrenCollapsible(False)
        self.right_split.setSizes(RIGHT)

        self.split = QSplitter(Qt.Orientation.Horizontal)
        self.split.addWidget(self.tools)
        self.split.addWidget(self.canvas)
        self.split.addWidget(self.right_split)
        self.split.setStretchFactor(0, 0)
        self.split.setStretchFactor(1, 1)
        self.split.setStretchFactor(2, 0)
        self.split.setChildrenCollapsible(False)
        self.split.setSizes(SPLIT)

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self.split)

    # ── Disposition (mémorisée par espace) ───────────────────────────────
    def splits(self):
        return {"split": self.split, "right": self.right_split}

    def save_layout(self):
        return save_splits(self.splits())

    def restore_layout(self, state):
        restore_splits(self.splits(), state)

    def reset_layout(self):
        self.split.setSizes(SPLIT)
        self.right_split.setSizes(RIGHT)
