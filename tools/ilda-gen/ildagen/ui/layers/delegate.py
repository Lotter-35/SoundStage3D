"""Dessin d'une ligne de calque (24 px) : flèche de dépliage, icône, nom, verrou, œil.

Ligne sélectionnée : fond de sélection, liseré et icône couleur accent. Calque masqué ou verrouillé : texte en
couleur désactivée. Le verrou ouvert n'apparaît qu'au survol ou sur la ligne sélectionnée ; fermé, il reste.
Le nom est du texte brut, tronqué avant les boutons (jamais de bouton poussé hors de la ligne).
"""

from PySide6.QtCore import QRect, QSize, Qt
from PySide6.QtWidgets import QLineEdit, QStyle, QStyledItemDelegate

from ...core.shapes import BASIC_SHAPES
from .. import icons, theme
from .model import NODE_ROLE

SHAPE_ICONS = {k: ic for k, _, ic in BASIC_SHAPES}
SHAPE_ICONS["path"] = "pencil"
BTN = 22


def node_icon(node):
    if node.kind == "group":
        return "folder"
    if node.kind == "instance":
        return "component"
    if node.kind == "modifier":
        return node.modifier.icon if node.modifier else "sliders-horizontal"
    return SHAPE_ICONS.get(getattr(node, "shape", "path"), "pencil")


IND = 20      # décalage des formes placées sous un ou plusieurs modifieurs (= retrait de l'arbre)
CHEV = 14     # place de la flèche de dépliage
ICON_C = CHEV + 7   # centre de l'icône par rapport au début du contenu


def mods_before(node):
    """Modifieurs placés au-dessus de node dans son groupe (ceux qui agissent sur lui)."""
    p = node.parent
    if p is None or p.kind == "modifier":
        return []
    sibs = p.children
    return [m for m in sibs[:sibs.index(node)] if m.kind == "modifier" and has_targets(m)]


def has_targets(m):
    p = m.parent
    if p is None or p.kind == "modifier":
        return False
    sibs = p.children
    return any(n.kind != "modifier" for n in sibs[sibs.index(m) + 1:])


def own_shift(node):
    """Une forme (ou un groupe) modifiée est décalée d'un cran ; les modifieurs empilés restent alignés."""
    return IND if node.kind != "modifier" and mods_before(node) else 0


def level_shift(node, root):
    """Décalage cumulé dû aux modifieurs des niveaux parents."""
    s = 0
    for a in node.ancestors():
        if a is root or a.parent is None:
            break
        s += own_shift(a)
    return s


def content_offset(node, root=None):
    """Début du contenu d'une ligne : décalé d'un cran quand des modifieurs agissent sur la forme."""
    return level_shift(node, root) + own_shift(node)


def draw_scope_lines(p, view, node, rect):
    """Barre verticale sombre sous les modifieurs, alignée sur leur icône, le long des formes qu'ils modifient.
    Plusieurs modifieurs empilés partagent la même barre."""
    indent = view.indentation()
    root = view.editor.current_root()
    selected = view.scope_sources
    cur = node
    dd = 0
    mid = rect.top() + rect.height() // 2

    def color(mods):
        return theme.qc(theme.WHITE, 0.30 if any(m.id in selected for m in mods) else 0.11)

    while cur is not None and cur is not root and cur.parent is not None:
        x = rect.left() - dd * indent + level_shift(cur, root) + ICON_C
        before = mods_before(cur)
        if cur.kind == "modifier":
            covering = before if has_targets(cur) else []
            own = [cur] if has_targets(cur) else []
            if dd == 0:
                if covering:
                    p.fillRect(QRect(x, rect.top(), 1, mid - 9 - rect.top()), color(covering))
                if covering or own:
                    p.fillRect(QRect(x, mid + 9, 1, rect.bottom() - mid - 8), color(covering + own))
            elif covering or own:
                p.fillRect(QRect(x, rect.top(), 1, rect.height()), color(covering + own))
        elif before:
            p.fillRect(QRect(x, rect.top(), 1, rect.height()), color(before))
        cur = cur.parent
        dd += 1


def chevron_rect(view, index, node):
    r = view.visualRect(index)
    x = r.left() + content_offset(node, view.editor.current_root())
    return QRect(x, r.top(), CHEV, r.height())


def eye_rect(rect):
    return QRect(rect.right() - BTN - 2, rect.top(), BTN, rect.height())


def lock_rect(rect):
    return QRect(rect.right() - 2 * BTN - 2, rect.top(), BTN, rect.height())


def is_dim(node):
    return not node.effectively_visible() or node.locked or node.locked_ancestor() is not None


class LayerDelegate(QStyledItemDelegate):
    def __init__(self, view):
        super().__init__(view)
        self.view = view
        self.hover_row = None       # identifiant du calque survolé

    def sizeHint(self, option, index):
        return QSize(option.rect.width(), theme.ROW_H)

    def paint(self, p, option, index):
        node = index.data(NODE_ROLE)
        r = option.rect
        selected = bool(option.state & QStyle.StateFlag.State_Selected)
        hover = self.hover_row == node.id
        p.save()
        if selected:
            p.fillRect(r, theme.qc(theme.SEL))
            p.fillRect(QRect(r.left(), r.top(), 2, r.height()), theme.qc(theme.ACCENT))
        elif hover:
            p.fillRect(r, theme.qc(theme.BG_HOVER))
        draw_scope_lines(p, self.view, node, r)
        dim = is_dim(node)
        dpr = self.view.devicePixelRatioF()
        cx = r.left() + content_offset(node, self.view.editor.current_root())
        if self.view.model().rowCount(index) > 0:
            name = "chevron-down" if self.view.isExpanded(index) else "chevron-right"
            p.drawPixmap(cx + 1, r.top() + (r.height() - 12) // 2, icons.pixmap(name, theme.TEXT_OFF, 12, dpr))
        ic_color = theme.TEXT_OFF if dim else (theme.ACCENT if selected else theme.TEXT_DIM)
        p.drawPixmap(cx + CHEV, r.top() + (r.height() - 14) // 2, icons.pixmap(node_icon(node), ic_color, 14, dpr))
        x = cx + CHEV + 21
        show_lock = node.locked or ((selected or hover) and node.kind != "modifier")
        right_limit = (lock_rect(r).left() if show_lock else eye_rect(r).left()) - 4
        p.setFont(theme.ui_font(12))
        fm = p.fontMetrics()
        name = node.name
        if node.kind == "instance":
            d = self.view.editor.doc.library.get(node.def_id)
            if d is not None and d.name != node.name:
                name = f"{node.name}  ({d.name})"
        w = max(0, right_limit - x)
        p.setPen(theme.qc(theme.TEXT_OFF if dim else theme.TEXT))
        p.drawText(QRect(x, r.top(), w, r.height()), Qt.AlignmentFlag.AlignVCenter | Qt.TextFlag.TextSingleLine,
                   fm.elidedText(name, Qt.TextElideMode.ElideRight, w))
        if show_lock:
            lr = lock_rect(r)
            pm = icons.pixmap("lock", theme.TEXT_DIM, 13, dpr) if node.locked else \
                icons.pixmap("lock-open", theme.TEXT_OFF, 13, dpr)
            p.drawPixmap(lr.left() + 4, lr.top() + (lr.height() - 13) // 2, pm)
        er = eye_rect(r)
        eye = icons.pixmap("eye" if node.visible else "eye-off", theme.TEXT_OFF, 13, dpr)
        p.drawPixmap(er.left() + 4, er.top() + (er.height() - 13) // 2, eye)
        p.restore()

    def createEditor(self, parent, option, index):
        e = QLineEdit(parent)
        e.setFrame(False)
        return e

    def updateEditorGeometry(self, editor, option, index):
        # Champ de saisie du nom : de l'icône jusqu'avant le verrou (il ne le recouvre jamais)
        r = option.rect
        x = r.left() + content_offset(index.data(NODE_ROLE), self.view.editor.current_root()) + CHEV + 18
        editor.setGeometry(QRect(x, r.top() + 2, max(40, lock_rect(r).left() - 4 - x), r.height() - 4))
