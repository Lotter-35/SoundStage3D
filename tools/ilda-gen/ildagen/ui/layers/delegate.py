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
        return "layers" if getattr(node, "main", False) else "folder"
    if node.kind == "instance":
        return "component"
    if node.kind == "modifier":
        return node.modifier.icon if node.modifier else "sliders-horizontal"
    return SHAPE_ICONS.get(getattr(node, "shape", "path"), "pencil")


GAP = 9   # écart entre deux lignes de portée


def mods_before(node):
    """Modifieurs placés au-dessus de node dans son groupe (ceux qui agissent sur lui)."""
    p = node.parent
    if p is None or p.kind == "modifier":
        return []
    sibs = p.children
    return [m for m in sibs[:sibs.index(node)] if m.kind == "modifier"]


def has_targets(m):
    p = m.parent
    if p is None or p.kind == "modifier":
        return False
    sibs = p.children
    return any(n.kind != "modifier" for n in sibs[sibs.index(m) + 1:])


def own_columns(node):
    """Nombre de lignes de portée au niveau de node (modifieurs au-dessus + la sienne si c'est un modifieur)."""
    n = len(mods_before(node))
    if node.kind == "modifier" and has_targets(node):
        n += 1
    return n


def level_shift(node, root):
    """Décalage cumulé des niveaux parents (leurs lignes de portée occupent de la place)."""
    s = 0
    for a in node.ancestors():
        if a is root or a.parent is None:
            break
        s += own_columns(a) * GAP
    return s


def content_offset(node, root=None):
    """Décalage du contenu d'une ligne : à droite de toutes les lignes de portée."""
    return level_shift(node, root) + own_columns(node) * GAP


def draw_scope_lines(p, view, node, rect, start_depth=0):
    """Lignes verticales qui relient chaque modifieur aux calques qu'il modifie (toujours visibles)."""
    indent = view.indentation()
    root = view.editor.current_root()
    sources = view.scope_sources
    L = node
    dd = start_depth
    mid = rect.top() + rect.height() // 2
    while L is not None and L is not root and L.parent is not None:
        base = rect.left() - dd * indent + 7 + level_shift(L, root)
        before = mods_before(L)
        for i, m in enumerate(before):
            if m.kind == "modifier" and has_targets(m):
                strong = m.id in sources
                c = theme.qc(theme.ACCENT, 1.0 if strong else 0.4)
                p.fillRect(QRect(base + i * GAP, rect.top(), 2 if strong else 1, rect.height()), c)
        if L.kind == "modifier" and has_targets(L):
            # Départ de la ligne du modifieur : coude sous son icône, continue jusqu'au bas de sa portée
            x = base + len(before) * GAP
            strong = L.id in sources
            c = theme.qc(theme.ACCENT, 1.0 if strong else 0.4)
            w = 2 if strong else 1
            if dd == 0:
                p.fillRect(QRect(x, mid, w, rect.bottom() - mid + 1), c)
                p.fillRect(QRect(x, mid, 5, w), c)
            else:
                p.fillRect(QRect(x, rect.top(), w, rect.height()), c)
        L = L.parent
        dd += 1


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
        hovered = bool(option.state & QStyle.StateFlag.State_MouseOver)
        p.save()
        in_scope = node.id in self.view.scope
        is_source = node.id in self.view.scope_sources
        if selected:
            p.fillRect(r, theme.accent_soft())
        elif in_scope:
            p.fillRect(r, theme.qc(theme.ACCENT, 0.08))
        elif hovered:
            p.fillRect(r, theme.qc(theme.BG_HOVER))
        if in_scope or is_source:
            # Barre continue à gauche : du modifieur jusqu'au dernier calque qu'il modifie
            p.fillRect(QRect(0, r.top(), 3, r.height()), theme.qc(theme.ACCENT, 1.0 if is_source else 0.55))
        draw_scope_lines(p, self.view, node, r)
        visible = node.effectively_visible()
        dim = not visible
        color = theme.TEXT_OFF if dim else (theme.TEXT if node.kind != "modifier" else theme.TEXT)
        ic_color = theme.TEXT_OFF if dim else (theme.ACCENT if node.kind == "modifier" else theme.TEXT_DIM)
        x = r.left() + 4 + content_offset(node, self.view.editor.current_root())
        pm = icons.pixmap(node_icon(node), ic_color, 14)
        p.drawPixmap(x, r.top() + (r.height() - 14) // 2, pm)
        x += 20
        right_limit = lock_rect(r).left() - 4
        p.setFont(theme.ui_font(12))
        fm = p.fontMetrics()
        name = node.name
        if node.kind == "instance":
            d = self.view.editor.doc.library.get(node.def_id)
            if d is not None and d.name != node.name:
                name = f"{node.name}  ({d.name})"
        name_w = min(fm.horizontalAdvance(name) + 4, max(0, right_limit - x))
        p.setPen(theme.qc(color))
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
        # Verrou (affiché s'il est actif, ou au survol)
        lr = lock_rect(r)
        if node.locked:
            p.drawPixmap(lr.left() + 4, lr.top() + (lr.height() - 14) // 2, icons.pixmap("lock", theme.TEXT, 14))
        elif hovered:
            p.drawPixmap(lr.left() + 4, lr.top() + (lr.height() - 14) // 2, icons.pixmap("lock-open", theme.TEXT_OFF, 14))
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
        off = content_offset(index.data(NODE_ROLE), self.view.editor.current_root())
        editor.setGeometry(QRect(r.left() + 22 + off, r.top() + 2, max(40, lock_rect(r).left() - r.left() - 26), r.height() - 4))
