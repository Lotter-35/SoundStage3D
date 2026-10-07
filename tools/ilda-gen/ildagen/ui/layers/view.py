"""Arbre des calques : sélection synchronisée avec la mire, glisser-déposer, œil, verrou, réglages en ligne."""

import json

from PySide6.QtCore import QItemSelection, QItemSelectionModel, QRect, Qt
from PySide6.QtGui import QPainter, QPen
from PySide6.QtWidgets import QAbstractItemView, QProxyStyle, QStyle, QTreeView

from .. import theme
from ..properties.forms import ParamForm
from .delegate import CHEV, IND, LayerDelegate, chevron_rect, eye_rect, level_shift, lock_rect, own_shift
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
        self._syncing = False
        self.model_ = LayerModel(editor, self)
        self.setModel(self.model_)
        self.delegate = LayerDelegate(self)
        self.setItemDelegate(self.delegate)
        # Style propre (« Fusion ») : ne jamais envelopper le style de l'application, il serait détruit deux fois
        self._style = DropIndicatorStyle("Fusion")
        self.setStyle(self._style)
        self.setHeaderHidden(True)
        self.setIndentation(IND)
        self.setUniformRowHeights(False)
        self.setMouseTracking(True)
        self.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.setDragDropMode(QAbstractItemView.DragDropMode.DragDrop)
        self.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.setDropIndicatorShown(False)   # indicateur maison (voir _drop_target)
        self._drop = None
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
            form.heightChanged.connect(self.scheduleDelayedItemsLayout)   # la ligne suit sa hauteur
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
        mods = [n for n in self.editor.selected_nodes() if n.kind == "modifier"]
        self.scope = self.editor.modifier_scope(mods)
        self.scope_sources = {m.id for m in mods}
        self.viewport().update()

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
            if self.model_.rowCount(ix) > 0 and chevron_rect(self, ix, node).contains(pos):
                self.setExpanded(ix, not self.isExpanded(ix))
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

    def dragMoveEvent(self, e):
        if not e.mimeData().hasFormat(LAYER_MIME):
            e.ignore()
            return
        super().dragMoveEvent(e)          # défilement / dépliage automatiques
        self._drop = self._drop_target(e.position().toPoint())
        e.setDropAction(Qt.DropAction.MoveAction)
        e.accept()
        self.viewport().update()

    def dragLeaveEvent(self, e):
        self._drop = None
        self.viewport().update()
        super().dragLeaveEvent(e)

    def _drop_target(self, pos):
        """Où ira le dépôt : (parent, index, ligne ou cadre à dessiner).
        Jamais « dans » un modifieur : au-dessus ou en dessous. Dans un groupe : au milieu de sa ligne."""
        root = self.editor.current_root()
        ix = self.indexAt(pos)
        if not ix.isValid():
            # Sous la dernière ligne : à la fin de la forme
            last = self.model_.index(self.model_.rowCount() - 1, 0)
            y = self.visualRect(last).bottom() + 1 if last.isValid() else 0
            return root, len(root.children), ("line", y, 0)
        params = ix.data(KIND_ROLE) == "params"
        if params:
            ix = ix.parent()
        node = ix.data(NODE_ROLE)
        r = self.visualRect(ix)
        x = r.left() + level_shift(node, root)
        if params:
            pr = self.visualRect(self.model_.params_index(node.id))
            return node.parent or root, node.index() + 1, ("line", pr.bottom() + 1, x)
        frac = (pos.y() - r.top()) / max(1, r.height())
        is_group = node.kind == "group" and not node.locked
        if is_group and 0.25 <= frac <= 0.75:
            return node, 0, ("frame", r, 0)
        parent = node.parent or root
        if frac < 0.5:
            return parent, node.index(), ("line", r.top(), x)
        if is_group and node.children and self.isExpanded(ix):
            # Sous un groupe ouvert : en tête de son contenu
            return node, 0, ("line", r.bottom() + 1, x + self.indentation() + own_shift(node))
        if node.kind == "modifier" and node.id in self.param_widgets:
            pr = self.visualRect(self.model_.params_index(node.id))
            return parent, node.index() + 1, ("line", pr.bottom() + 1, x)
        return parent, node.index() + 1, ("line", r.bottom() + 1, x)

    def paintEvent(self, e):
        super().paintEvent(e)
        if self._drop is None:
            return
        kind, a, x = self._drop[2]
        p = QPainter(self.viewport())
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        if kind == "frame":
            p.setPen(QPen(theme.qc(theme.ACCENT), 1))
            p.drawRect(a.adjusted(0, 0, -1, -1))
        else:
            p.setPen(QPen(theme.qc(theme.ACCENT), 2))
            x0 = x + CHEV
            p.drawLine(x0, a, self.viewport().width() - 4, a)
            p.setBrush(theme.qc(theme.ACCENT))
            p.drawEllipse(x0 - 3, a - 3, 6, 6)
        p.end()

    def dropEvent(self, e):
        md = e.mimeData()
        target = self._drop or self._drop_target(e.position().toPoint())
        self._drop = None
        self.viewport().update()
        if not md.hasFormat(LAYER_MIME) or target is None:
            e.ignore()
            return
        ids = json.loads(bytes(md.data(LAYER_MIME)).decode("utf-8"))
        root = self.editor.current_root()
        parent, index, _ = target
        self.editor.move_nodes(ids, None if parent is root else parent.id, index)
        e.setDropAction(Qt.DropAction.CopyAction)   # le modèle est reconstruit : Qt ne doit rien retirer
        e.accept()

    # ── Branches : chevrons ──────────────────────────────────────────────
    def drawBranches(self, painter, rect, index):
        pass   # la flèche est dessinée dans la ligne, alignée sur le contenu
