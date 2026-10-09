"""Espace Show : aperçu et timeline · réglages du clip."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QHBoxLayout, QSplitter, QWidget

from ..layout import restore_splits, save_splits
from ..properties import PropertiesPanel
from ..timeline import TimelinePanel
from .preview import ShowPreview


class ShowWorkspace(QWidget):
    def __init__(self, win, parent=None):
        super().__init__(parent)
        ed = win.editor
        self.preview = ShowPreview(ed)
        self.timeline = TimelinePanel(ed, win.playback)
        self.inspector = PropertiesPanel(ed)

        self.v_split = QSplitter(Qt.Orientation.Vertical)
        self.v_split.addWidget(self.preview)
        self.v_split.addWidget(self.timeline)
        self.v_split.setStretchFactor(0, 2)
        self.v_split.setStretchFactor(1, 3)
        self.v_split.setChildrenCollapsible(False)
        self.v_split.setSizes([320, 520])

        self.split = QSplitter(Qt.Orientation.Horizontal)
        self.split.addWidget(self.v_split)
        self.split.addWidget(self.inspector)
        self.split.setStretchFactor(0, 1)
        self.split.setStretchFactor(1, 0)
        self.split.setChildrenCollapsible(False)
        self.split.setSizes([1100, 340])

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self.split)

    def splits(self):
        return {"split": self.split, "v": self.v_split}

    def save_layout(self):
        return save_splits(self.splits())

    def restore_layout(self, state):
        restore_splits(self.splits(), state)
