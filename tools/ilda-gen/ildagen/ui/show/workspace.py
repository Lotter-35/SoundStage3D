"""Espace Show : bibliothèque (formes, effets) · aperçu et timeline · inspecteur du clip."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QHBoxLayout, QSplitter, QWidget

from ..layout import restore_splits, save_splits
from ..timeline import TimelinePanel
from .inspector import ClipInspector
from .library import ShowLibrary
from .preview import ShowPreview

SIZES = [224, 886, 330]
V_SIZES = [300, 540]


class ShowWorkspace(QWidget):
    def __init__(self, win, parent=None):
        super().__init__(parent)
        ed = win.editor
        self.library = ShowLibrary(ed)
        self.preview = ShowPreview(ed)
        self.timeline = TimelinePanel(ed, win.playback)
        self.timeline.transport.musicRequested.connect(lambda: win.project.import_music())
        self.inspector = ClipInspector(ed)

        self.v_split = QSplitter(Qt.Orientation.Vertical)
        self.v_split.addWidget(self.preview)
        self.v_split.addWidget(self.timeline)
        self.v_split.setStretchFactor(0, 0)
        self.v_split.setStretchFactor(1, 1)
        self.v_split.setChildrenCollapsible(False)
        self.v_split.setSizes(V_SIZES)

        self.split = QSplitter(Qt.Orientation.Horizontal)
        self.split.addWidget(self.library)
        self.split.addWidget(self.v_split)
        self.split.addWidget(self.inspector)
        self.split.setStretchFactor(0, 0)
        self.split.setStretchFactor(1, 1)
        self.split.setStretchFactor(2, 0)
        self.split.setChildrenCollapsible(False)
        self.split.setSizes(SIZES)

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self.split)

    def splits(self):
        return {"split3": self.split, "v": self.v_split}

    def save_layout(self):
        return save_splits(self.splits())

    def restore_layout(self, state):
        restore_splits(self.splits(), state)

    def reset_layout(self):
        self.split.setSizes(SIZES)
        self.v_split.setSizes(V_SIZES)
