"""« + Modifieur » : liste des modifieurs à ajouter, avec recherche et catégories visibles.

On tape pour filtrer (nom, description, catégorie ; sans tenir compte des accents) ; ↑ / ↓ choisissent,
Entrée ou un clic ajoute le modifieur au-dessus du calque sélectionné (il agit sur ce qui est en dessous) ;
Échap ferme. Si un modifieur est sélectionné, ses sous-modifieurs (Translation, Rotation, Échelle) sont proposés
dans une catégorie à part.
"""

import unicodedata

from PySide6.QtCore import QPoint, QSize, Qt, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem, QVBoxLayout, QWidget

from ...core.modifiers import SUB_MODIFIER_TYPES, by_category, registry
from .. import icons, theme

ROLE = Qt.ItemDataRole.UserRole
SUB = "sub:"


def norm(text):
    """Texte comparable : minuscules, sans accents."""
    t = unicodedata.normalize("NFD", text or "").lower()
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


def entries(editor):
    """[(catégorie, [(clé, modifieur, sur)…])] proposés selon la sélection."""
    out = [(cat, [(m.type_id, m, None) for m in mods]) for cat, mods in by_category()]
    sel = editor.top_selected()
    one = sel[0] if len(sel) == 1 else None
    if one is not None and one.kind == "modifier":
        out.append((f"Sous-modifieurs de « {one.name} »", [(SUB + t, registry[t], one.id) for t in SUB_MODIFIER_TYPES]))
    return out


class ModifierPicker(QFrame):
    chosen = Signal(str)          # type du modifieur ajouté

    def __init__(self, editor, parent=None):
        super().__init__(parent, Qt.WindowType.Popup)
        self.editor = editor
        self.setObjectName("popup")
        self.setFixedSize(QSize(300, 430))
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 6, 0, 6)
        lay.setSpacing(4)
        row = QWidget()
        h = QHBoxLayout(row)
        h.setContentsMargins(8, 0, 8, 0)
        h.setSpacing(6)
        ic = QLabel()
        ic.setPixmap(icons.pixmap("search", theme.TEXT_OFF, 14, self.devicePixelRatioF()))
        h.addWidget(ic)
        self.search = QLineEdit()
        self.search.setPlaceholderText("Rechercher un modifieur…")
        self.search.textChanged.connect(self._filter)
        self.search.installEventFilter(self)
        h.addWidget(self.search, 1)
        lay.addWidget(row)
        self.list = QListWidget()
        self.list.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.list.setIconSize(QSize(14, 14))
        self.list.setUniformItemSizes(False)
        self.list.itemClicked.connect(self._activate)
        lay.addWidget(self.list, 1)
        self._fill()

    # ── Contenu ──────────────────────────────────────────────────────────
    def _fill(self):
        self.list.clear()
        head_font = QFont(theme.ui_font(11))
        head_font.setWeight(QFont.Weight.DemiBold)
        self._groups = []
        for cat, items in entries(self.editor):
            head = QListWidgetItem(cat)
            head.setFlags(Qt.ItemFlag.NoItemFlags)
            head.setFont(head_font)
            head.setForeground(theme.qc(theme.TEXT_DIM))        # titre de catégorie : toujours lisible
            head.setSizeHint(QSize(0, 24))
            self.list.addItem(head)
            rows = []
            for key, mod, onto in items:
                it = QListWidgetItem(icons.icon(mod.icon, 14), mod.label)
                it.setData(ROLE, (key[len(SUB):] if key.startswith(SUB) else key, onto))
                it.setToolTip(mod.description)
                it.setSizeHint(QSize(0, 24))
                it.setData(ROLE + 1, norm(" ".join((mod.label, mod.description, cat))))
                self.list.addItem(it)
                rows.append(it)
            self._groups.append((head, rows))
        self._select_first()

    def _filter(self, text):
        words = norm(text).split()
        for head, rows in self._groups:
            any_shown = False
            for it in rows:
                hay = it.data(ROLE + 1)
                show = all(w in hay for w in words)
                it.setHidden(not show)
                any_shown = any_shown or show
            head.setHidden(not any_shown)
        self._select_first()

    def visible_items(self):
        return [self.list.item(i) for i in range(self.list.count())
                if not self.list.item(i).isHidden() and self.list.item(i).flags() & Qt.ItemFlag.ItemIsEnabled]

    def _select_first(self):
        """Choix par défaut : le premier dont le NOM correspond à la recherche, sinon le premier montré."""
        items = self.visible_items()
        words = norm(self.search.text()).split()
        best = next((it for it in items if words and all(w in norm(it.text()) for w in words)), None)
        self.list.setCurrentItem(best or (items[0] if items else None))

    def _move(self, step):
        items = self.visible_items()
        if not items:
            return
        cur = self.list.currentItem()
        i = items.index(cur) if cur in items else -1
        it = items[max(0, min(len(items) - 1, i + step))]
        self.list.setCurrentItem(it)
        self.list.scrollToItem(it)

    # ── Choix ────────────────────────────────────────────────────────────
    def _activate(self, it):
        if it is None or not (it.flags() & Qt.ItemFlag.ItemIsEnabled):
            return
        type_id, onto = it.data(ROLE)
        self.close()
        target = self.editor.find(onto) if onto else None
        self.editor.add_modifier(type_id, onto=target)
        self.chosen.emit(type_id)

    def eventFilter(self, obj, e):
        if obj is self.search and e.type() == e.Type.KeyPress:
            k = e.key()
            if k in (Qt.Key.Key_Down, Qt.Key.Key_Up):
                self._move(1 if k == Qt.Key.Key_Down else -1)
                return True
            if k in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
                self._activate(self.list.currentItem())
                return True
            if k == Qt.Key.Key_Escape:
                self.close()
                return True
        return super().eventFilter(obj, e)

    def show_above(self, anchor):
        """Ouvre la liste au-dessus du bouton (ou dessous s'il n'y a pas la place), le champ de recherche actif."""
        g = anchor.mapToGlobal(QPoint(0, 0))
        y = g.y() - self.height() - 4
        screen = anchor.screen().availableGeometry() if anchor.screen() is not None else None
        if screen is not None and y < screen.top():
            y = g.y() + anchor.height() + 4
        self.move(g.x(), y)
        self.show()
        self.search.setFocus()
