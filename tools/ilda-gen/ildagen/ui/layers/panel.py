"""Panneau Calques : en-tête (nouveau calque, groupe, forme personnalisée, supprimer), arbre compact,
bouton « + Modifieur » (liste avec recherche et catégories)."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QHBoxLayout, QToolButton, QVBoxLayout, QWidget

from .. import icons
from ..context_menu import ask_text
from ..properties.common import PanelHead
from .view import LayerTreeView


class LayersPanel(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setMinimumHeight(110)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        ed = editor
        self.header = PanelHead("Calques")
        self.header.add_button("plus", "Nouveau calque (le prochain trait au crayon le remplit)", ed.new_empty_layer)
        self.header.add_button("folder-plus", "Nouveau groupe (groupe la sélection s'il y en a une) — Ctrl+G",
                               ed.group_or_new_group)
        self.header.add_button("component", "Créer une forme personnalisée à partir de la sélection (ou de tout)",
                               self._custom)
        self.header.add_button("trash-2", "Supprimer la sélection (Suppr)", ed.delete_selected)
        lay.addWidget(self.header)
        self.tree = LayerTreeView(editor)
        lay.addWidget(self.tree, 1)
        self.footer = QWidget()
        self.footer.setObjectName("panelFooter")
        h = QHBoxLayout(self.footer)
        h.setContentsMargins(6, 3, 6, 3)
        self.mod_btn = QToolButton()
        self.mod_btn.setIcon(icons.icon("plus", 14))
        self.mod_btn.setIconSize(icons.qsize(14))
        self.mod_btn.setText("Modifieur")
        self.mod_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.mod_btn.setToolTip("Ajouter un modifieur au-dessus du calque sélectionné (il agit sur ce qui est en "
                                "dessous)")
        self.mod_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.mod_btn.clicked.connect(self.open_picker)
        h.addWidget(self.mod_btn)
        h.addStretch(1)
        lay.addWidget(self.footer)
        self.picker = None

    def open_picker(self):
        from ..forme.mod_picker import ModifierPicker
        self.picker = ModifierPicker(self.editor, self)
        self.picker.show_above(self.mod_btn)
        return self.picker

    def _custom(self):
        root = self.editor.work_root()
        if root is None or not root.children:
            self.editor.statusMessage.emit("Rien à transformer en forme personnalisée : la forme est vide")
            return
        from ...core.document import next_form_name
        name = ask_text(self, "Forme personnalisée", "Nom de la nouvelle forme :",
                        next_form_name(self.editor.doc.library))
        if name:
            self.editor.create_custom_shape(name)
