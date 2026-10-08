"""Panneau des calques : en-tête (contexte d'édition) + arbre."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QHBoxLayout, QLabel, QMenu, QToolButton, QVBoxLayout, QWidget

from ...core.modifiers import SUB_MODIFIER_TYPES, by_category, registry

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
        self.header.extra.addWidget(self.ctx)
        lay.addWidget(self.header)
        self.tree = LayerTreeView(editor)
        lay.addWidget(self.tree, 1)
        self.footer = self._footer()
        lay.addWidget(self.footer)
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
        ed = self.editor
        mod_btn = QToolButton()
        mod_btn.setIcon(icons.icon("sliders-horizontal", 16))
        mod_btn.setIconSize(icons.qsize(16))
        mod_btn.setText(" Modifieur")
        mod_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        mod_btn.setToolTip("Ajouter un modifieur au-dessus du calque sélectionné (agit sur ce qui est en dessous)")
        mod_btn.setAutoRaise(True)
        mod_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        mod_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        menu = QMenu(mod_btn)
        menu.aboutToShow.connect(lambda: self._fill_modifiers(menu))
        mod_btn.setMenu(menu)
        h.insertWidget(0, mod_btn)
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
        h.insertStretch(1, 1)
        return bar

    def _fill_modifiers(self, menu):
        menu.clear()
        sel = self.editor.top_selected()
        one = sel[0] if len(sel) == 1 else None
        for cat, mods in by_category():
            menu.addSection(cat)
            for m in mods:
                a = menu.addAction(icons.icon(m.icon, 14), m.label)
                a.setToolTip(m.description)
                a.triggered.connect(lambda _=False, t=m.type_id: self.editor.add_modifier(t))
        if one is not None and one.kind == "modifier":
            menu.addSection("Sur le modifieur sélectionné")
            for t in SUB_MODIFIER_TYPES:
                m = registry[t]
                a = menu.addAction(icons.icon(m.icon, 14), f"{m.label} (sous-modifieur)")
                a.triggered.connect(lambda _=False, tt=t: self.editor.add_modifier(tt, onto=one))

    def _custom(self):
        root = self.editor.work_root()
        if root is None or not root.children:
            self.editor.statusMessage.emit("Rien à transformer en forme personnalisée")
            return
        from ...core.document import next_form_name
        name = ask_text(self, "Forme personnalisée", "Nom de la nouvelle forme :",
                        next_form_name(self.editor.doc.library))
        if name:
            self.editor.create_custom_shape(name)

    def refresh(self):
        """En-tête : la forme en cours, dont on voit les calques."""
        self.ctx.setText(self.editor.context_label())
