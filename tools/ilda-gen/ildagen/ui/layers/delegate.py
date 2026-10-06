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
        visible = node.effectively_visible()
        dim = not visible
        color = theme.TEXT_OFF if dim else (theme.TEXT if node.kind != "modifier" else theme.TEXT)
        ic_color = theme.TEXT_OFF if dim else (theme.ACCENT if node.kind == "modifier" else theme.TEXT_DIM)
        x = r.left() + 4
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
        editor.setGeometry(QRect(r.left() + 22, r.top() + 2, max(40, lock_rect(r).left() - r.left() - 26), r.height() - 4))
