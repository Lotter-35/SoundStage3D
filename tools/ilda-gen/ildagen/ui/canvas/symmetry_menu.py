"""Menu de la symétrie de dessin (bouton au-dessus de la mire et menu Affichage)."""

from PySide6.QtGui import QAction, QActionGroup
from PySide6.QtWidgets import QMenu

from ...core import draw_symmetry as DS


def build_symmetry_menu(editor, parent, title="Symétrie de dessin"):
    menu = QMenu(title, parent)
    modes = QActionGroup(menu)
    mode_actions = {}
    for mode, label in DS.MODES:
        a = QAction(label, menu, checkable=True)
        a.triggered.connect(lambda _=False, m=mode: editor.set_symmetry(m))
        modes.addAction(a)
        menu.addAction(a)
        mode_actions[mode] = a
    menu.addSeparator()
    sub = menu.addMenu("Branches (radiale / kaléidoscope)")
    counts = QActionGroup(sub)
    count_actions = {}
    for n in DS.COUNTS:
        a = QAction(f"{n}", sub, checkable=True)
        a.triggered.connect(lambda _=False, c=n: editor.set_symmetry(count=c))
        counts.addAction(a)
        sub.addAction(a)
        count_actions[n] = a

    def refresh():
        g = editor.doc.grid
        if g.sym in mode_actions:
            mode_actions[g.sym].setChecked(True)
        if g.sym_count in count_actions:
            count_actions[g.sym_count].setChecked(True)
    menu.aboutToShow.connect(refresh)
    refresh()
    return menu
