"""Panneau des calques : en-tête (contexte d'édition) + arbre."""

from PySide6.QtWidgets import QLabel, QPushButton, QVBoxLayout, QWidget

from ..properties.panel import PanelHeader
from .view import LayerTreeView


class LayersPanel(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.header = PanelHeader("Calques")
        self.ctx = QLabel("")
        self.ctx.setObjectName("dim")
        self.done = QPushButton("Terminer")
        self.done.setToolTip("Revenir à la scène")
        self.done.clicked.connect(editor.enter_scene)
        self.header.extra.addWidget(self.ctx)
        self.header.extra.addWidget(self.done)
        lay.addWidget(self.header)
        self.tree = LayerTreeView(editor)
        lay.addWidget(self.tree, 1)
        editor.contextChanged.connect(self.refresh)
        editor.libraryChanged.connect(self.refresh)
        self.refresh()

    def refresh(self):
        kind = self.editor.context[0]
        self.ctx.setText("" if kind == "scene" else self.editor.context_label())
        self.done.setVisible(kind != "scene")
