"""Barre au-dessus de la mire : source affichée (Forme / Timeline), grilles, zoom."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QButtonGroup, QHBoxLayout, QLabel, QPushButton, QToolButton, QVBoxLayout, QWidget

from ...core import draw_symmetry as DS
from .. import icons
from .symmetry_menu import build_symmetry_menu
from .view import CanvasView


def tool_button(icon_name, tip, checkable=False, size=16):
    b = QToolButton()
    b.setIcon(icons.icon(icon_name, size))
    b.setIconSize(icons.qsize(size))
    b.setToolTip(tip)
    b.setCheckable(checkable)
    b.setAutoRaise(True)
    b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
    return b


class CanvasHeader(QWidget):
    def __init__(self, editor, view, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.view = view
        self.setObjectName("bar")
        lay = QHBoxLayout(self)
        lay.setContentsMargins(8, 3, 8, 3)
        lay.setSpacing(4)

        self.src_group = QButtonGroup(self)
        self.btn_scene = QPushButton("Forme")
        self.btn_tl = QPushButton("Timeline")
        for i, b in enumerate((self.btn_scene, self.btn_tl)):
            b.setCheckable(True)
            b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            self.src_group.addButton(b, i)
            lay.addWidget(b)
        self.btn_scene.setToolTip("Afficher et éditer la forme sélectionnée à gauche")
        self.btn_tl.setToolTip("Afficher la sortie de la timeline à la tête de lecture")
        self.src_group.idClicked.connect(lambda i: editor.set_view_source("form" if i == 0 else "timeline"))

        self.ctx_label = QLabel("")
        self.ctx_label.setObjectName("dim")
        lay.addSpacing(10)
        lay.addWidget(self.ctx_label)
        lay.addStretch(1)

        self.btn_ortho = tool_button("grid-3x3", "Grille orthogonale", True)
        self.btn_polar = tool_button("target", "Grille polaire (cercles concentriques)", True)
        self.btn_ortho.clicked.connect(lambda on: editor.set_grid_mode(1 if on else 0))
        self.btn_polar.clicked.connect(lambda on: editor.set_grid_mode(2 if on else 0))
        self.btn_snap = tool_button("magnet", "Aimant : les poignées s'accrochent à la grille (Ctrl+;)", True)
        self.btn_snap.clicked.connect(editor.set_snap)
        self.btn_sym = tool_button("flip-horizontal-2", "", True)
        self.btn_sym.clicked.connect(lambda _=False: editor.toggle_symmetry())
        # Flèche des options, séparée du bouton (un peu à sa droite)
        self.btn_sym_menu = tool_button("chevron-down", "Mode de symétrie de dessin", size=12)
        self.btn_sym_menu.setMenu(build_symmetry_menu(editor, self.btn_sym_menu))
        self.btn_sym_menu.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.btn_sym_menu.setStyleSheet("QToolButton::menu-indicator { image: none; width: 0; }")
        self.btn_sym_menu.setFixedWidth(16)
        lay.addWidget(self.btn_ortho)
        lay.addWidget(self.btn_polar)
        lay.addWidget(self.btn_snap)
        lay.addWidget(self.btn_sym)
        lay.addSpacing(2)
        lay.addWidget(self.btn_sym_menu)
        lay.addSpacing(10)
        zo = tool_button("zoom-out", "Dézoomer")
        fit = tool_button("maximize", "Ajuster la vue")
        zi = tool_button("zoom-in", "Zoomer")
        zo.clicked.connect(lambda: view.zoom_by(1 / 1.4))
        zi.clicked.connect(lambda: view.zoom_by(1.4))
        fit.clicked.connect(view.fit_view)
        for b in (zo, fit, zi):
            lay.addWidget(b)

        editor.gridChanged.connect(self.refresh)
        editor.contextChanged.connect(self.refresh)
        editor.projectChanged.connect(self.refresh)
        self.refresh()

    def refresh(self):
        g = self.editor.doc.grid.mode
        self.btn_ortho.setChecked(g == 1)
        self.btn_polar.setChecked(g == 2)
        self.btn_snap.setChecked(self.editor.doc.grid.snap)
        grid = self.editor.doc.grid
        self.btn_sym.setChecked(bool(grid.sym))
        self.btn_sym.setToolTip("Symétrie de dessin (Ctrl+Maj+M) : " + DS.describe(grid) +
                                "\nCe qu'on dessine est rangé sous un modifieur Symétrie ajouté automatiquement. Flèche à droite : choisir le mode.")
        mode = self.editor.display_mode()
        self.btn_scene.setChecked(mode != "timeline")
        self.btn_tl.setChecked(mode == "timeline")
        self.ctx_label.setText(self.editor.context_label())


class CanvasArea(QWidget):
    """En-tête + mire."""

    def __init__(self, editor, live, parent=None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.view = CanvasView(editor, live)
        self.header = CanvasHeader(editor, self.view)
        lay.addWidget(self.header)
        lay.addWidget(self.view, 1)
