"""Panneau des calques : en-tête (contexte d'édition) + arbre."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QToolButton, QVBoxLayout, QWidget

from .. import icons
from ..context_menu import ask_text

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
        lay.addWidget(self._footer())
        editor.contextChanged.connect(self.refresh)
        editor.libraryChanged.connect(self.refresh)
        self.refresh()

    def _footer(self):
        """Boutons sous les calques (comme Photoshop)."""
        bar = QWidget()
        bar.setObjectName("panelFooter")
        h = QHBoxLayout(bar)
        h.setContentsMargins(6, 2, 6, 2)
        h.setSpacing(2)
        h.addStretch(1)
        ed = self.editor
        for icon_name, tip, slot in (
                ("plus", "Nouveau calque (le prochain trait au crayon le remplit)", ed.new_empty_layer),
                ("folder-plus", "Nouveau groupe (groupe la sélection s'il y en a une)", ed.group_or_new_group),
                ("component", "Créer une forme personnalisée à partir de la sélection (ou de tout)", self._custom),
                ("trash-2", "Supprimer la sélection", ed.delete_selected)):
            b = QToolButton()
            b.setIcon(icons.icon(icon_name, 16))
            b.setIconSize(icons.qsize(16))
            b.setToolTip(tip)
            b.setAutoRaise(True)
            b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            b.clicked.connect(lambda _=False, s=slot: s())
            h.addWidget(b)
        return bar

    def _custom(self):
        root = self.editor.current_root()
        if root is None or not root.children:
            self.editor.statusMessage.emit("Rien à transformer en forme personnalisée")
            return
        name = ask_text(self, "Forme personnalisée", "Nom de la nouvelle forme :",
                        f"Forme {len(self.editor.doc.library.defs) + 1}")
        if name:
            self.editor.create_custom_shape(name)

    def refresh(self):
        kind = self.editor.context[0]
        self.ctx.setText("" if kind == "scene" else self.editor.context_label())
        self.done.setVisible(kind != "scene")
