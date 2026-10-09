"""Modèle Qt de l'arbre des calques : une ligne par calque (les réglages sont dans le panneau Réglages, D10).

rebuild() refait le modèle ; relink() garde les lignes quand seule l'identité des objets a changé (annuler :
le document est rechargé) ou qu'un état sans effet sur l'arbre a changé (œil, nom) : pas de remise à zéro, la
vue garde son défilement et ses groupes ouverts.
"""

import json

from PySide6.QtCore import QAbstractItemModel, QMimeData, QModelIndex, Qt

LAYER_MIME = "application/x-ildagen-layer-ids"
NODE_ROLE = Qt.ItemDataRole.UserRole + 1
KIND_ROLE = Qt.ItemDataRole.UserRole + 2


class Item:
    __slots__ = ("node", "parent", "children", "row")

    def __init__(self, node, parent, row):
        self.node = node
        self.parent = parent
        self.children = []
        self.row = row


def tree_children(node, top=False):
    """Calques montrés sous un calque : contenu d'un groupe (sauf groupe verrouillé), sous-modifieurs."""
    if node.kind == "modifier" or (node.kind == "group" and (top or not node.locked)):
        return node.children
    return []


def signature(root):
    """Forme de l'arbre affiché (identifiants, parents, ordre) : s'il ne change pas, pas de reconstruction."""
    out = []

    def walk(n, top):
        for c in tree_children(n, top):
            out.append((c.id, n.id, c.kind))
            walk(c, False)
    if root is not None:
        walk(root, True)
    return tuple(out)


class LayerModel(QAbstractItemModel):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.root_item = Item(None, None, 0)
        self.by_id = {}
        self.sig = None

    # ── Construction ─────────────────────────────────────────────────────
    def rebuild(self):
        self.beginResetModel()
        self.by_id = {}
        root = self.editor.current_root()
        self.root_item = Item(root, None, 0)
        if root is not None:
            self._fill(self.root_item, root, True)
        self.sig = signature(root)
        self.endResetModel()

    def _fill(self, item, node, top=False):
        for row, n in enumerate(tree_children(node, top)):
            child = Item(n, item, row)
            item.children.append(child)
            self.by_id[n.id] = child
            self._fill(child, n)

    def relink(self):
        """Même arbre affiché : les lignes pointent sur les objets actuels. Renvoie False s'il faut rebuild()."""
        root = self.editor.current_root()
        if root is None or signature(root) != self.sig or self.root_item.node is None:
            return False
        nodes = {n.id: n for n in root.walk()}
        self.root_item.node = root
        for nid, it in self.by_id.items():
            it.node = nodes[nid]
        return True

    def item(self, index):
        return index.internalPointer() if index.isValid() else self.root_item

    def index_for_id(self, node_id):
        it = self.by_id.get(node_id)
        return self.createIndex(it.row, 0, it) if it else QModelIndex()

    def order(self):
        """Identifiants dans l'ordre de l'arbre (du haut vers le bas)."""
        return list(self.by_id)

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
            return "node"
        if role in (Qt.ItemDataRole.DisplayRole, Qt.ItemDataRole.EditRole):
            return it.node.name
        if role == Qt.ItemDataRole.ToolTipRole and it.node.kind == "modifier" and it.node.modifier:
            return it.node.modifier.description
        return None

    def setData(self, index, value, role=Qt.ItemDataRole.EditRole):
        if role == Qt.ItemDataRole.EditRole and index.isValid():
            self.editor.rename(index.internalPointer().node, str(value))
            return True
        return False

    def flags(self, index):
        if not index.isValid():
            return Qt.ItemFlag.ItemIsDropEnabled
        n = index.internalPointer().node
        f = Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsEditable
        if not n.locked_ancestor():
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
            nid = ix.internalPointer().node.id
            if nid not in ids:
                ids.append(nid)
        md = QMimeData()
        md.setData(LAYER_MIME, json.dumps(ids).encode("utf-8"))
        return md
