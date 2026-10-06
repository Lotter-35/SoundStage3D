"""Arbre des calques : sélection synchronisée avec la mire, glisser-déposer, œil, verrou, réglages en ligne."""

import json

from PySide6.QtCore import QItemSelection, QItemSelectionModel, QPoint, QRect, Qt
from PySide6.QtGui import QPainter, QPen
from PySide6.QtWidgets import QAbstractItemView, QProxyStyle, QStyle, QTreeView

from .. import icons, theme
from ..properties.forms import ParamForm
from .delegate import LayerDelegate, eye_rect, lock_rect
from .model import KIND_ROLE, LAYER_MIME, NODE_ROLE, LayerModel


class DropIndicatorStyle(QProxyStyle):
    """Indicateur d'insertion : ligne couleur accent de 2 px (ou cadre pour un dépôt dans un groupe)."""

    def drawPrimitive(self, element, option, painter, widget=None):
        if element == QStyle.PrimitiveElement.PE_IndicatorItemViewItemDrop:
            painter.save()
            painter.setRenderHint(QPainter.RenderHint.Antialiasing, False)
            r = option.rect
            if r.height() <= 1:
                painter.setPen(QPen(theme.qc(theme.ACCENT), 2))
                painter.drawLine(r.left(), r.top(), r.right(), r.top())
            else:
                painter.setPen(QPen(theme.qc(theme.ACCENT), 1))
                painter.drawRect(r.adjusted(0, 0, -1, -1))
            painter.restore()
            return
        super().drawPrimitive(element, option, painter, widget)


class LayerTreeView(QTreeView):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.context_menu_builder = None
        self.param_widgets = {}
        self.scope = set()          # calques touchés par le modifieur sélectionné ou survolé
        self.scope_sources = set()
        self._hover_mod = None
        self._syncing = False
        self.model_ = LayerModel(editor, self)
        self.setModel(self.model_)
        self.delegate = LayerDelegate(self)
        self.setItemDelegate(self.delegate)
        self._style = DropIndicatorStyle(self.style())
        self.setStyle(self._style)
        self.setHeaderHidden(True)
        self.setIndentation(16)
        self.setUniformRowHeights(False)
        self.setMouseTracking(True)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.setDragDropMode(QAbstractItemView.DragDropMode.DragDrop)
        self.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.setDropIndicatorShown(True)
        self.setDragEnabled(True)
        self.setAcceptDrops(True)
        self.setExpandsOnDoubleClick(False)
        self.setEditTriggers(QAbstractItemView.EditTrigger.EditKeyPressed)
        self.setAutoExpandDelay(600)
        self.setVerticalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
        self.expanded.connect(lambda ix: self._set_expanded(ix, True))
        self.collapsed.connect(lambda ix: self._set_expanded(ix, False))
        editor.structureChanged.connect(self.rebuild)
        editor.contextChanged.connect(self.rebuild)
        editor.selectionChanged.connect(self.sync_from_editor)
        editor.selectionChanged.connect(self.update_scope)
        editor.structureChanged.connect(self.update_scope)
        editor.docChanged.connect(self.viewport().update)
        self.rebuild()

    # ── Construction ─────────────────────────────────────────────────────
    def rebuild(self):
        self._syncing = True
        self.param_widgets = {}
        self.model_.rebuild()
        for nid, it in self.model_.by_id.items():
            n = it.node
            if getattr(n, "expanded", False) and it.children:
                self.setExpanded(self.model_.index_for_id(nid), True)
        for nid in self.model_.params_by_id:
            node = self.editor.find(nid)
            if node is None:
                continue
            form = ParamForm(self.editor, nid, compact=True)
            self.param_widgets[nid] = form
            self.setIndexWidget(self.model_.params_index(nid), form)
        self._syncing = False
        self.sync_from_editor()

    def _set_expanded(self, index, on):
        if self._syncing:
            return
        node = index.data(NODE_ROLE)
        if node is not None and index.data(KIND_ROLE) == "node":
            self.editor.set_expanded(node, on)
            if node.kind == "group" and node.locked and on:
                self.collapse(index)

    # ── Sélection ────────────────────────────────────────────────────────
    def sync_from_editor(self):
        self._syncing = True
        sel = QItemSelection()
        for nid in self.editor.selection:
            ix = self.model_.index_for_id(nid)
            if ix.isValid():
                sel.select(ix, ix)
                p = ix.parent()
                while p.isValid():
                    if not self.isExpanded(p):
                        self.setExpanded(p, True)
                    p = p.parent()
        self.selectionModel().select(sel, QItemSelectionModel.SelectionFlag.ClearAndSelect)
        if self.editor.selection:
            ix = self.model_.index_for_id(self.editor.selection[-1])
            if ix.isValid():
                self.scrollTo(ix)
        self._syncing = False
        self.viewport().update()

    def selectionChanged(self, selected, deselected):
        super().selectionChanged(selected, deselected)
        if self._syncing:
            return
        ids = []
        for ix in self.selectionModel().selectedIndexes():
            if ix.data(KIND_ROLE) == "node":
                ids.append(ix.data(NODE_ROLE).id)
        # Conserve l'ordre de l'arbre
        order = list(self.model_.by_id.keys())
        ids.sort(key=lambda i: order.index(i) if i in order else 0)
        self._syncing = True
        self.editor.set_selection(ids)
        self._syncing = False

    # ── Souris ───────────────────────────────────────────────────────────
    # ── Portée des modifieurs ────────────────────────────────────────────
    def update_scope(self):
        if self._hover_mod is not None and self.editor.find(self._hover_mod) is not None:
            mods = [self.editor.find(self._hover_mod)]
        else:
            mods = [n for n in self.editor.selected_nodes() if n.kind == "modifier"]
        self.scope = self.editor.modifier_scope(mods)
        self.scope_sources = {m.id for m in mods}
        self.viewport().update()

    def mouseMoveEvent(self, e):
        super().mouseMoveEvent(e)
        ix = self.indexAt(e.position().toPoint())
        node = ix.data(NODE_ROLE) if ix.isValid() else None
        hover = node.id if node is not None and node.kind == "modifier" and ix.data(KIND_ROLE) == "node" else None
        if hover != self._hover_mod:
            self._hover_mod = hover
            self.update_scope()

    def leaveEvent(self, e):
        super().leaveEvent(e)
        if self._hover_mod is not None:
            self._hover_mod = None
            self.update_scope()

    def mousePressEvent(self, e):
        ix = self.indexAt(e.position().toPoint())
        if ix.isValid() and ix.data(KIND_ROLE) == "node" and e.button() == Qt.MouseButton.LeftButton:
            r = self.visualRect(ix)
            node = ix.data(NODE_ROLE)
            pos = e.position().toPoint()
            if eye_rect(r).contains(pos):
                self.editor.set_visible(node, not node.visible)
                return
            if lock_rect(r).contains(pos):
                self.editor.set_locked([node], not node.locked)
                return
        if not ix.isValid() and e.button() == Qt.MouseButton.LeftButton:
            self.editor.clear_selection()
        super().mousePressEvent(e)

    def mouseDoubleClickEvent(self, e):
        ix = self.indexAt(e.position().toPoint())
        if ix.isValid() and ix.data(KIND_ROLE) == "node":
            node = ix.data(NODE_ROLE)
            r = self.visualRect(ix)
            if node.kind == "instance" and not QRect(r.left() + 20, r.top(), 200, r.height()).contains(e.position().toPoint()):
                self.editor.enter_def(node.def_id)
                return
            self.edit(ix)
            return
        super().mouseDoubleClickEvent(e)

    def contextMenuEvent(self, e):
        ix = self.indexAt(e.pos())
        if ix.isValid() and ix.data(KIND_ROLE) == "node":
            nid = ix.data(NODE_ROLE).id
            if nid not in self.editor.selection:
                self.editor.set_selection([nid])
        if self.context_menu_builder is not None:
            self.context_menu_builder(self).exec(e.globalPos())

    # ── Glisser-déposer ──────────────────────────────────────────────────
    def dragEnterEvent(self, e):
        if e.mimeData().hasFormat(LAYER_MIME):
            e.acceptProposedAction()
            super().dragEnterEvent(e)
        else:
            e.ignore()

    def dropEvent(self, e):
        md = e.mimeData()
        if not md.hasFormat(LAYER_MIME):
            e.ignore()
            return
        ids = json.loads(bytes(md.data(LAYER_MIME)).decode("utf-8"))
        ix = self.indexAt(e.position().toPoint())
        pos = self.dropIndicatorPosition()
        root = self.editor.current_root()
        DIP = QAbstractItemView.DropIndicatorPosition
        if not ix.isValid() or pos == DIP.OnViewport:
            work = self.editor.work_root()
            parent, index = work, len(work.children)
        else:
            if ix.data(KIND_ROLE) == "params":
                ix = ix.parent()
            node = ix.data(NODE_ROLE)
            if pos == DIP.OnItem and (node.kind in ("group", "modifier")):
                parent, index = node, 0
            elif getattr(node, "main", False):
                # Au-dessus / au-dessous du groupe principal : on reste dedans
                parent, index = node, (0 if pos == DIP.AboveItem else len(node.children))
            else:
                parent = node.parent or root
                index = parent.children.index(node) + (1 if pos == DIP.BelowItem else 0)
        self.editor.move_nodes(ids, None if parent is root else parent.id, index)
        e.setDropAction(Qt.DropAction.CopyAction)   # le modèle est reconstruit : Qt ne doit rien retirer
        e.accept()

    # ── Branches : chevrons ──────────────────────────────────────────────
    def drawBranches(self, painter, rect, index):
        if self.model_.rowCount(index) == 0:
            return
        name = "chevron-down" if self.isExpanded(index) else "chevron-right"
        pm = icons.pixmap(name, theme.TEXT_DIM, 12)
        painter.drawPixmap(QPoint(rect.right() - 13, rect.top() + (theme.ROW_H - 12) // 2), pm)
