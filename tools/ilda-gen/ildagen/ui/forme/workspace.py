"""Espace Forme : outils et liste des formes · mire · calques et réglages."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QHBoxLayout, QSplitter, QWidget

from ..canvas import CanvasArea
from ..layers import LayersPanel
from ..properties import PropertiesPanel
from ..tool_panel import ToolPanel
from ..layout import restore_splits, save_splits


class FormeWorkspace(QWidget):
    def __init__(self, win, parent=None):
        super().__init__(parent)
        ed = win.editor
        self.tools = ToolPanel(ed)
        self.canvas = CanvasArea(ed, win.live)
        self.layers = LayersPanel(ed)
        self.properties = PropertiesPanel(ed)

        self.right_split = QSplitter(Qt.Orientation.Vertical)
        self.right_split.addWidget(self.layers)
        self.right_split.addWidget(self.properties)
        self.right_split.setStretchFactor(0, 2)
        self.right_split.setStretchFactor(1, 3)
        self.right_split.setChildrenCollapsible(False)
        self.right_split.setSizes([360, 460])
        self.properties.collapsedChanged.connect(self._properties_collapsed)

        self.split = QSplitter(Qt.Orientation.Horizontal)
        self.split.addWidget(self.tools)
        self.split.addWidget(self.canvas)
        self.split.addWidget(self.right_split)
        self.split.setStretchFactor(0, 0)
        self.split.setStretchFactor(1, 1)
        self.split.setStretchFactor(2, 0)
        self.split.setChildrenCollapsible(False)
        self.split.setSizes([200, 900, 340])

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self.split)

    def _properties_collapsed(self, collapsed):
        if collapsed:
            total = sum(self.right_split.sizes())
            h = self.properties.header.height()
            self.right_split.setSizes([total - h, h])

    # ── Disposition (mémorisée par espace) ───────────────────────────────
    def splits(self):
        return {"split": self.split, "right": self.right_split}

    def save_layout(self):
        return save_splits(self.splits())

    def restore_layout(self, state):
        restore_splits(self.splits(), state)
