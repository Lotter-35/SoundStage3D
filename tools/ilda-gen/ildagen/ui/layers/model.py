"""Modèle Qt de l'arbre des calques (avec une ligne de réglages sous chaque modifieur déplié)."""

import json

from PySide6.QtCore import QAbstractItemModel, QMimeData, QModelIndex, Qt

LAYER_MIME = "application/x-ildagen-layer-ids"
NODE_ROLE = Qt.ItemDataRole.UserRole + 1
KIND_ROLE = Qt.ItemDataRole.UserRole + 2


class Item:
    __slots__ = ("kind", "node", "parent", "children", "row")

    def __init__(self, kind, node, parent, row):
        self.kind = kind          # "node" ou "params"
        self.node = node
        self.parent = parent
        self.children = []
        self.row = row


class LayerModel(QAbstractItemModel):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.root_item = Item("node", None, None, 0)
        self.by_id = {}
        self.params_by_id = {}

    # ── Construction ─────────────────────────────────────────────────────
    def rebuild(self):
        self.beginResetModel()
        self.by_id = {}
        self.params_by_id = {}
        root = self.editor.current_root()
        self.root_item = Item("node", root, None, 0)
        if root is not None:
            self._fill(self.root_item, root)
        self.endResetModel()

    def _fill(self, item, node):
        kids = []
        if node.kind == "modifier":
            kids.append(("params", node))
            kids += [("node", c) for c in node.children]
        elif node.kind == "group" and (item is self.root_item or not node.locked):
            kids += [("node", c) for c in node.children]
        for row, (kind, n) in enumerate(kids):
            child = Item(kind, n, item, row)
            item.children.append(child)
            if kind == "params":
                self.params_by_id[n.id] = child
            else:
                self.by_id[n.id] = child
                self._fill(child, n)

    def item(self, index):
        return index.internalPointer() if index.isValid() else self.root_item

    def index_for_id(self, node_id):
        it = self.by_id.get(node_id)
        return self.createIndex(it.row, 0, it) if it else QModelIndex()

    def params_index(self, node_id):
        it = self.params_by_id.get(node_id)
        return self.createIndex(it.row, 0, it) if it else QModelIndex()

    # ── Interface QAbstractItemModel ─────────────────────────────────────
    def index(self, row, column, parent=QModelIndex()):
        p = self.item(parent)
        if 0 <= row < len(p.children) and column == 0:
            return self.createIndex(row, 0, p.children[row])
        return QModelIndex()

    def parent(self, index):
        if not index.isValid():
            return QModelIndex()
        p = index.internalPointer().parent
        if p is None or p is self.root_item:
            return QModelIndex()
        return self.createIndex(p.row, 0, p)

    def rowCount(self, parent=QModelIndex()):
        if parent.column() > 0:
            return 0
        return len(self.item(parent).children)

    def columnCount(self, parent=QModelIndex()):
        return 1

    def data(self, index, role=Qt.ItemDataRole.DisplayRole):
        if not index.isValid():
            return None
        it = index.internalPointer()
        if role == NODE_ROLE:
            return it.node
        if role == KIND_ROLE:
            return it.kind
        if it.kind == "params":
            return None
        if role in (Qt.ItemDataRole.DisplayRole, Qt.ItemDataRole.EditRole):
            return it.node.name
        if role == Qt.ItemDataRole.ToolTipRole and it.node.kind == "modifier":
            return it.node.modifier.description
        return None

    def setData(self, index, value, role=Qt.ItemDataRole.EditRole):
        if role == Qt.ItemDataRole.EditRole and index.isValid():
            it = index.internalPointer()
            if it.kind == "node":
                self.editor.rename(it.node, str(value))
                return True
        return False

    def flags(self, index):
        if not index.isValid():
            return Qt.ItemFlag.ItemIsDropEnabled
        it = index.internalPointer()
        if it.kind == "params":
            return Qt.ItemFlag.ItemIsEnabled
        f = Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEditable
        n = it.node
        if not n.locked_ancestor() and not getattr(n, "main", False):
            f |= Qt.ItemFlag.ItemIsDragEnabled
        if (n.kind == "group" and not n.locked) or n.kind == "modifier":
            f |= Qt.ItemFlag.ItemIsDropEnabled
        return f

    # ── Glisser-déposer ──────────────────────────────────────────────────
    def supportedDropActions(self):
        return Qt.DropAction.MoveAction

    def supportedDragActions(self):
        return Qt.DropAction.MoveAction

    def mimeTypes(self):
        return [LAYER_MIME]

    def mimeData(self, indexes):
        ids = []
        for ix in indexes:
            it = ix.internalPointer()
            if it.kind == "node" and it.node.id not in ids:
                ids.append(it.node.id)
        md = QMimeData()
        md.setData(LAYER_MIME, json.dumps(ids).encode("utf-8"))
        return md
