"""Barre au-dessus de la mire : nom de la forme · nombre de calques, grilles, aimant, symétrie de dessin (et son
mode), zoom ; la mire ; la barre de boucle dessous (espace Forme)."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QToolButton, QVBoxLayout, QWidget

from ...core import draw_symmetry as DS
from .. import icons, theme
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
    b.setFixedSize(26, 24)
    return b


class CanvasHeader(QWidget):
    def __init__(self, editor, view, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.view = view
        self.setObjectName("mireHead")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground)
        self.setFixedHeight(32)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(10, 0, 8, 0)
        lay.setSpacing(2)

        self.name_label = QLabel("")
        self.name_label.setTextFormat(Qt.TextFormat.PlainText)
        self.name_label.setStyleSheet("font-weight: 600;")
        lay.addWidget(self.name_label)
        self.count_label = QLabel("")
        self.count_label.setObjectName("dim")
        lay.addSpacing(4)
        lay.addWidget(self.count_label)
        lay.addStretch(1)
        self.ctx_label = self.name_label          # ancien nom

        self.btn_ortho = tool_button("grid-3x3", "Grille orthogonale (Ctrl+Alt+2)", True)
        self.btn_polar = tool_button("target", "Grille polaire : cercles concentriques (Ctrl+Alt+3)", True)
        self.btn_ortho.clicked.connect(lambda on: editor.set_grid_mode(1 if on else 0))
        self.btn_polar.clicked.connect(lambda on: editor.set_grid_mode(2 if on else 0))
        self.btn_snap = tool_button("magnet", "Aimant : les poignées s'accrochent à la grille (Ctrl+;)", True)
        self.btn_snap.clicked.connect(editor.set_snap)
        self.btn_sym = tool_button("flip-horizontal-2", "", True)
        self.btn_sym.clicked.connect(lambda _=False: editor.toggle_symmetry())
        self.btn_sym_menu = tool_button("chevron-down", "Mode de symétrie de dessin", size=12)
        self.btn_sym_menu.setMenu(build_symmetry_menu(editor, self.btn_sym_menu))
        self.btn_sym_menu.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.btn_sym_menu.setStyleSheet("QToolButton::menu-indicator { image: none; width: 0; }")
        self.btn_sym_menu.setFixedWidth(14)
        for b in (self.btn_ortho, self.btn_polar, self.btn_snap, self.btn_sym):
            lay.addWidget(b)
        lay.addWidget(self.btn_sym_menu)
        self.sep = QFrame()
        self.sep.setFixedSize(1, 16)
        lay.addSpacing(6)
        lay.addWidget(self.sep)
        lay.addSpacing(6)
        zo = tool_button("zoom-out", "Dézoomer (Ctrl+-)")
        fit = tool_button("maximize", "Ajuster la vue (Ctrl+0)")
        zi = tool_button("zoom-in", "Zoomer (Ctrl++)")
        zo.clicked.connect(lambda: view.zoom_by(1 / 1.4))
        zi.clicked.connect(lambda: view.zoom_by(1.4))
        fit.clicked.connect(view.fit_view)
        for b in (zo, fit, zi):
            lay.addWidget(b)

        editor.gridChanged.connect(self.refresh)
        editor.contextChanged.connect(self.refresh)
        editor.projectChanged.connect(self.refresh)
        editor.structureChanged.connect(self.refresh)
        editor.libraryChanged.connect(self.refresh)
        editor.restored.connect(self.refresh)
        theme.notifier.changed.connect(self._restyle)
        self._restyle()
        self.refresh()

    def _restyle(self, *_):
        self.setStyleSheet(f"QWidget#mireHead {{ background: {theme.BG_APP}; }}")
        self.sep.setStyleSheet(f"background: {theme.BORDER};")

    def refresh(self):
        ed = self.editor
        g = ed.doc.grid
        self.btn_ortho.setChecked(g.mode == 1)
        self.btn_polar.setChecked(g.mode == 2)
        self.btn_snap.setChecked(g.snap)
        self.btn_sym.setChecked(bool(g.sym))
        self.btn_sym.setToolTip("Symétrie de dessin (Ctrl+Maj+M) : " + DS.describe(g) +
                                "\nCe qu'on dessine est rangé sous un modifieur Symétrie ajouté automatiquement. "
                                "Flèche à droite : choisir le mode.")
        d = ed.current_form()
        n = len(d.root.children) if d is not None else 0
        self.name_label.setText(d.name if d is not None else "")
        self.count_label.setText(f"· {n} calque{'s' if n > 1 else ''}")


class CanvasArea(QWidget):
    """En-tête + mire (+ barre de boucle posée par l'espace Forme : set_footer)."""

    def __init__(self, editor, live, parent=None):
        super().__init__(parent)
        self.lay = QVBoxLayout(self)
        self.lay.setContentsMargins(0, 0, 0, 0)
        self.lay.setSpacing(0)
        self.view = CanvasView(editor, live)
        self.header = CanvasHeader(editor, self.view)
        self.lay.addWidget(self.header)
        self.lay.addWidget(self.view, 1)

    def set_footer(self, w):
        self.footer = w
        self.lay.addWidget(w)
