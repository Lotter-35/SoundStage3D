"""Menus de l'espace Live (clic droit sur une case, sur un onglet de page) et choix de la touche d'un cue."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QDialog, QHBoxLayout, QLabel, QMenu, QPushButton, QVBoxLayout

from ...core.live import QUICK_KEYS
from .. import theme
from .keys import MODS, key_name


def cue_menu(parent, editor, slot):
    """Menu d'une case de la page affichée : placer une forme, changer la touche, vider la case."""
    page = editor.live_page()
    cue = page.cues[slot]
    menu = QMenu(parent)
    place = menu.addMenu("Placer une forme")
    for d in editor.doc.library.visible():
        a = place.addAction(d.name)
        a.setCheckable(True)
        a.setChecked(cue is not None and cue.def_id == d.id)
        a.triggered.connect(lambda _=False, i=d.id: editor.set_cue(page.id, slot, i))
    if cue is None:
        return menu
    a = menu.addAction("Changer la touche…")
    a.triggered.connect(lambda: ask_key(parent, editor, cue.id))
    a = menu.addAction("Ouvrir dans Forme")
    a.triggered.connect(lambda: editor.enter_def(cue.def_id))
    menu.addSeparator()
    a = menu.addAction("Vider la case")
    a.triggered.connect(lambda: editor.clear_cue(page.id, slot))
    return menu


def page_menu(tabs, editor, page):
    """Menu d'un onglet de page : renommer, déplacer, supprimer."""
    pages = editor.doc.live.pages
    i = pages.index(page)
    menu = QMenu(tabs)
    menu.addAction("Renommer…").triggered.connect(lambda: tabs.start_rename(page.id))
    a = menu.addAction("Déplacer vers la gauche")
    a.setEnabled(i > 0)
    a.triggered.connect(lambda: editor.move_page(page.id, i - 1))
    a = menu.addAction("Déplacer vers la droite")
    a.setEnabled(i < len(pages) - 1)
    a.triggered.connect(lambda: editor.move_page(page.id, i + 1))
    menu.addSeparator()
    menu.addAction("Nouvelle page").triggered.connect(lambda: editor.add_page())
    menu.addAction("Supprimer la page").triggered.connect(lambda: editor.remove_page(page.id))
    return menu


class KeyDialog(QDialog):
    """« Changer la touche… » : la prochaine touche appuyée devient celle du cue (Échap : annuler)."""

    def __init__(self, cue_name, current, parent=None):
        super().__init__(parent)
        self.key = None
        self.setWindowTitle("Touche du cue")
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 14, 16, 12)
        lay.setSpacing(8)
        lay.addWidget(QLabel(f"Appuyez sur la touche qui lancera « {cue_name} »."))
        self.current = QLabel(current or "—")
        self.current.setFont(theme.mono_font(20))
        self.current.setAlignment(Qt.AlignmentFlag.AlignCenter)
        lay.addWidget(self.current)
        self.msg = QLabel("Les chiffres 1 à 8 sont réservés aux effets rapides.")
        self.msg.setObjectName("dim")
        lay.addWidget(self.msg)
        row = QHBoxLayout()
        row.addStretch(1)
        for text, slot in (("Aucune touche", self._none), ("Annuler", self.reject)):
            b = QPushButton(text)
            b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            b.setAutoDefault(False)
            b.clicked.connect(slot)
            row.addWidget(b)
        lay.addLayout(row)

    def _none(self):
        self.key = ""
        self.accept()

    def showEvent(self, e):
        super().showEvent(e)
        self.setFocus()

    def keyPressEvent(self, e):
        if e.key() == Qt.Key.Key_Escape.value:
            self.reject()
            return
        name = key_name(e) if not e.modifiers() & MODS else ""
        if not name:
            return
        if name in QUICK_KEYS:
            self.msg.setObjectName("warning")
            self.msg.style().unpolish(self.msg)          # nouveau nom d'objet : la feuille de style s'applique
            self.msg.style().polish(self.msg)
            self.msg.setText(f"La touche {name} tient un effet rapide : choisissez-en une autre.")
            return
        self.key = name
        self.accept()


def ask_key(parent, editor, cue_id):
    _, _, cue = editor.doc.live.find_cue(cue_id)
    if cue is None:
        return
    d = editor.doc.library.get(cue.def_id)
    dlg = KeyDialog(d.name if d is not None else "", cue.key, parent)
    if dlg.exec() and dlg.key is not None:
        editor.set_cue_key(cue_id, dlg.key)
