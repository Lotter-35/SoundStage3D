"""Dessin d'une ligne de calque : icône, nom, résumé du modifieur, verrou, œil."""

from PySide6.QtCore import QRect, QSize, Qt
from PySide6.QtWidgets import QLineEdit, QStyle, QStyledItemDelegate

from ...core.shapes import BASIC_SHAPES
from .. import icons, theme
from .model import KIND_ROLE, NODE_ROLE

SHAPE_ICONS = {k: ic for k, _, ic in BASIC_SHAPES}
SHAPE_ICONS["path"] = "pencil"
BTN = 22


def node_icon(node):
    if node.kind == "group":
        return "component" if getattr(node, "main", False) else "folder"
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


def draw_scope_lines(p, view, node, rect, start_depth=0):
    """Barre verticale sombre sous les modifieurs, alignée sur leur icône, le long des formes qu'ils modifient.
    Plusieurs modifieurs empilés partagent la même barre."""
    indent = view.indentation()
    root = view.editor.current_root()
    selected = view.scope_sources
    L = node
    dd = start_depth
    mid = rect.top() + rect.height() // 2

    def color(mods):
        return theme.qc("#ffffff", 0.30 if any(m.id in selected for m in mods) else 0.11)

    while L is not None and L is not root and L.parent is not None:
        x = rect.left() - dd * indent + level_shift(L, root) + ICON_C
        before = mods_before(L)
        if L.kind == "modifier":
            covering = before if has_targets(L) else []
            own = [L] if has_targets(L) else []
            if dd == 0:
                if covering:
                    p.fillRect(QRect(x, rect.top(), 1, mid - 9 - rect.top()), color(covering))
                if covering or own:
                    p.fillRect(QRect(x, mid + 9, 1, rect.bottom() - mid - 8), color(covering + own))
            elif covering or own:
                p.fillRect(QRect(x, rect.top(), 1, rect.height()), color(covering + own))
        elif before:
            p.fillRect(QRect(x, rect.top(), 1, rect.height()), color(before))
        L = L.parent
        dd += 1


def chevron_rect(view, index, node):
    r = view.visualRect(index)
    x = r.left() + content_offset(node, view.editor.current_root())
    return QRect(x, r.top(), CHEV, r.height())


def eye_rect(rect):
    return QRect(rect.right() - BTN - 2, rect.top(), BTN, rect.height())


def lock_rect(rect):
    return QRect(rect.right() - 2 * BTN - 2, rect.top(), BTN, rect.height())


class LayerDelegate(QStyledItemDelegate):
    def __init__(self, view):
        super().__init__(view)
        self.view = view
        self.hover_row = None

    def sizeHint(self, option, index):
        if index.data(KIND_ROLE) == "params":
            w = self.view.param_widgets.get(index.data(NODE_ROLE).id)
            h = w.sizeHint().height() if w is not None else 0
            return QSize(option.rect.width(), h + 6)
        return QSize(option.rect.width(), theme.ROW_H)

    def paint(self, p, option, index):
        if index.data(KIND_ROLE) == "params":
            p.fillRect(option.rect, theme.qc(theme.BG_APP))
            p.save()
            draw_scope_lines(p, self.view, index.data(NODE_ROLE), option.rect, start_depth=1)
            p.restore()
            return
        node = index.data(NODE_ROLE)
        r = option.rect
        selected = bool(option.state & QStyle.StateFlag.State_Selected)
        p.save()
        if selected:
            p.fillRect(r, theme.accent_soft())
        draw_scope_lines(p, self.view, node, r)
        dim = not node.effectively_visible()
        cx = r.left() + content_offset(node, self.view.editor.current_root())
        # Flèche de dépliage (dans la ligne, alignée sur le contenu)
        if self.view.model().rowCount(index) > 0:
            name = "chevron-down" if self.view.isExpanded(index) else "chevron-right"
            p.drawPixmap(cx + 1, r.top() + (r.height() - 12) // 2, icons.pixmap(name, theme.TEXT_DIM, 12))
        ic_color = theme.TEXT_OFF if dim else (theme.ACCENT if node.kind == "modifier" else theme.TEXT_DIM)
        p.drawPixmap(cx + CHEV, r.top() + (r.height() - 14) // 2, icons.pixmap(node_icon(node), ic_color, 14))
        x = cx + CHEV + 20
        right_limit = lock_rect(r).left() - 4
        p.setFont(theme.ui_font(12))
        fm = p.fontMetrics()
        name = node.name
        if node.kind == "instance":
            d = self.view.editor.doc.library.get(node.def_id)
            if d is not None and d.name != node.name:
                name = f"{node.name}  ({d.name})"
        name_w = min(fm.horizontalAdvance(name) + 4, max(0, right_limit - x))
        p.setPen(theme.qc(theme.TEXT_OFF if dim else theme.TEXT))
        p.drawText(QRect(x, r.top(), name_w, r.height()), Qt.AlignmentFlag.AlignVCenter,
                   fm.elidedText(name, Qt.TextElideMode.ElideRight, name_w))
        x += name_w + 8
        if node.kind == "modifier" and node.modifier and x < right_limit:
            summary = node.modifier.summary(self.view.editor.resolve_display_params(node))
            p.setPen(theme.qc(theme.TEXT_OFF if dim else theme.TEXT_DIM))
            p.setFont(theme.ui_font(11))
            fm2 = p.fontMetrics()
            p.drawText(QRect(x, r.top(), right_limit - x, r.height()), Qt.AlignmentFlag.AlignVCenter,
                       fm2.elidedText(summary, Qt.TextElideMode.ElideRight, right_limit - x))
        # Cadenas toujours visible à côté de l'œil : ouvert (discret) ou fermé
        lr = lock_rect(r)
        lock = icons.pixmap("lock", theme.TEXT, 14) if node.locked else icons.pixmap("lock-open", theme.TEXT_OFF, 14)
        p.drawPixmap(lr.left() + 4, lr.top() + (lr.height() - 14) // 2, lock)
        er = eye_rect(r)
        eye = icons.pixmap("eye" if node.visible else "eye-off", theme.TEXT_DIM if node.visible else theme.TEXT_OFF, 14)
        p.drawPixmap(er.left() + 4, er.top() + (er.height() - 14) // 2, eye)
        p.restore()

    def createEditor(self, parent, option, index):
        if index.data(KIND_ROLE) == "params":
            return None
        e = QLineEdit(parent)
        e.setFrame(False)
        return e

    def updateEditorGeometry(self, editor, option, index):
        r = option.rect
        off = content_offset(index.data(NODE_ROLE), self.view.editor.current_root()) + CHEV
        editor.setGeometry(QRect(r.left() + 18 + off, r.top() + 2, max(40, lock_rect(r).left() - r.left() - 26), r.height() - 4))
