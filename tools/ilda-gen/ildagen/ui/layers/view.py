"""Arbre des calques : sélection synchronisée avec la mire, glisser-déposer, œil, verrou, renommage.

- l'arbre ne se reconstruit que si sa forme change (œil, verrou, annuler : simple mise à jour), sans revenir
  à la sélection ni perdre le défilement ; un groupe ouvert pour montrer la sélection le reste ;
- clavier : ↑ / ↓ parcourent les calques, ← / → replient / déplient, F2 / Entrée renomment ;
- double-clic sur l'œil, le verrou ou la flèche = deuxième clic (jamais le renommage) ;
- glisser-déposer : ligne d'insertion accent, cadre pour un dépôt dans un groupe ; dépôt impossible = curseur
  « interdit » et message.
"""

import json

from PySide6.QtCore import QItemSelection, QItemSelectionModel, QRect, Qt
from PySide6.QtGui import QPainter, QPen
from PySide6.QtWidgets import QAbstractItemView, QTreeView

from .. import theme
from .delegate import CHEV, IND, LayerDelegate, chevron_rect, eye_rect, level_shift, lock_rect, own_shift
from .model import LAYER_MIME, NODE_ROLE, LayerModel


class LayerTreeView(QTreeView):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.context_menu_builder = None
        self.scope = set()          # calques touchés par le modifieur sélectionné
        self.scope_sources = set()
        self._syncing = False
        self._shown_sel = None      # sélection déjà amenée à l'écran
        self.model_ = LayerModel(editor, self)
        self.setModel(self.model_)
        self.delegate = LayerDelegate(self)
        self.setItemDelegate(self.delegate)
        self.setHeaderHidden(True)
        self.setIndentation(IND)
        self.setRootIsDecorated(False)      # flèches dessinées dans la ligne (pas de marge perdue)
        self.setUniformRowHeights(True)
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
        editor.restored.connect(self.rebuild)
        editor.selectionChanged.connect(self.sync_from_editor)
        editor.selectionChanged.connect(self.update_scope)
        editor.structureChanged.connect(self.update_scope)
        editor.docChanged.connect(self.viewport().update)
        self.rebuild()

    # ── Construction ─────────────────────────────────────────────────────
    def rebuild(self):
        """Arbre de la forme en cours ; s'il a la même forme qu'avant, simple mise à jour (rapide, sans saut)."""
        if self.model_.relink():
            self.viewport().update()
            self.sync_from_editor()
            return
        bar = self.verticalScrollBar()
        pos = bar.value()
        same_form = getattr(self, "_built_for", None) == self.editor.current_form_id()
        self._syncing = True
        self.model_.rebuild()
        for nid, it in self.model_.by_id.items():
            if getattr(it.node, "expanded", False) and it.children:
                self.setExpanded(self.model_.index_for_id(nid), True)
        self._syncing = False
        self._built_for = self.editor.current_form_id()
        self.sync_from_editor()
        if same_form:
            bar.setValue(pos)        # le défilement reste où il était (clic sur un œil tout en bas…)

    def _set_expanded(self, index, on):
        if self._syncing:
            return
        node = index.data(NODE_ROLE)
        if node is not None:
            self.editor.set_expanded(node, on)
            if node.kind == "group" and node.locked and on:
                self.collapse(index)

    # ── Sélection ────────────────────────────────────────────────────────
    def sync_from_editor(self):
        self._syncing = True
        sel = QItemSelection()
        for nid in self.editor.selection:
            ix = self.model_.index_for_id(nid)
            if not ix.isValid():
                continue
            sel.select(ix, ix)
            p = ix.parent()
            while p.isValid():
                if not self.isExpanded(p):
                    self.setExpanded(p, True)
                    # Ouvert pour montrer la sélection : il le reste à la prochaine reconstruction
                    self.editor.set_expanded(p.data(NODE_ROLE), True)
                p = p.parent()
        self.selectionModel().select(sel, QItemSelectionModel.SelectionFlag.ClearAndSelect)
        cur = tuple(self.editor.selection)
        if cur and cur != self._shown_sel:
            ix = self.model_.index_for_id(cur[-1])
            if ix.isValid():
                self.selectionModel().setCurrentIndex(ix, QItemSelectionModel.SelectionFlag.NoUpdate)
                self.scrollTo(ix, QAbstractItemView.ScrollHint.EnsureVisible)
        self._shown_sel = cur
        self._syncing = False
        self.viewport().update()

    def selectionChanged(self, selected, deselected):
        super().selectionChanged(selected, deselected)
        if self._syncing:
            return
        order = {nid: i for i, nid in enumerate(self.model_.order())}
        ids = sorted({ix.data(NODE_ROLE).id for ix in self.selectionModel().selectedIndexes()},
                     key=lambda i: order.get(i, 0))
        self._syncing = True
        self._shown_sel = tuple(ids)     # choisie dans l'arbre : déjà visible
        self.editor.set_selection(ids)
        self._syncing = False

    # ── Portée des modifieurs ────────────────────────────────────────────
    def update_scope(self):
        mods = [n for n in self.editor.selected_nodes() if n.kind == "modifier"]
        self.scope = self.editor.modifier_scope(mods)
        self.scope_sources = {m.id for m in mods}
        self.viewport().update()

    # ── Souris ───────────────────────────────────────────────────────────
    def _button_at(self, ix, pos):
        """« eye », « lock » ou « chevron » sous la souris dans la ligne ix, ou None."""
        r = self.visualRect(ix)
        node = ix.data(NODE_ROLE)
        if eye_rect(r).contains(pos):
            return "eye"
        if lock_rect(r).contains(pos) and (node.locked or node.kind != "modifier"):
            return "lock"
        if self.model_.rowCount(ix) > 0 and chevron_rect(self, ix, node).contains(pos):
            return "chevron"
        return None

    def _press_button(self, ix, which):
        node = ix.data(NODE_ROLE)
        if which == "eye":
            self.editor.set_visible(node, not node.visible)
        elif which == "lock":
            self.editor.set_locked([node], not node.locked)
        elif which == "chevron":
            self.setExpanded(ix, not self.isExpanded(ix))

    def mousePressEvent(self, e):
        pos = e.position().toPoint()
        ix = self.indexAt(pos)
        if e.button() == Qt.MouseButton.LeftButton:
            if ix.isValid():
                which = self._button_at(ix, pos)
                if which is not None:
                    self._press_button(ix, which)
                    return
            else:
                self.editor.clear_selection()
        super().mousePressEvent(e)

    def mouseDoubleClickEvent(self, e):
        pos = e.position().toPoint()
        ix = self.indexAt(pos)
        if not ix.isValid() or e.button() != Qt.MouseButton.LeftButton:
            return
        which = self._button_at(ix, pos)
        if which is not None:
            self._press_button(ix, which)       # deuxième clic sur un bouton, pas un renommage
            return
        node = ix.data(NODE_ROLE)
        r = self.visualRect(ix)
        if node.kind == "instance" and not QRect(r.left() + 20, r.top(), 200, r.height()).contains(pos):
            self.editor.enter_def(node.def_id)
            return
        self.edit(ix)

    def mouseMoveEvent(self, e):
        ix = self.indexAt(e.position().toPoint())
        hov = ix.data(NODE_ROLE).id if ix.isValid() else None
        if hov != self.delegate.hover_row:
            self.delegate.hover_row = hov
            self.viewport().update()
        super().mouseMoveEvent(e)

    def leaveEvent(self, e):
        self.delegate.hover_row = None
        self.viewport().update()
        super().leaveEvent(e)

    def contextMenuEvent(self, e):
        ix = self.indexAt(e.pos())
        if ix.isValid():
            nid = ix.data(NODE_ROLE).id
            if nid not in self.editor.selection:
                self.editor.set_selection([nid])
        else:
            self.editor.clear_selection()       # clic droit dans le vide : le menu n'agit sur aucun calque
        if self.context_menu_builder is not None:
            self.context_menu_builder(self).exec(e.globalPos())

    # ── Glisser-déposer ──────────────────────────────────────────────────
    def _dragged(self, md):
        try:
            ids = json.loads(bytes(md.data(LAYER_MIME)).decode("utf-8"))
        except ValueError:
            return []
        return [n for n in (self.editor.find(i) for i in ids) if n is not None]

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
        target = self._drop_target(e.position().toPoint())
        nodes = self._dragged(e.mimeData())
        if target is None or not any(self.editor.can_drop(n, target[0]) for n in nodes):
            self._drop = None             # dépôt impossible ici : curseur « interdit », pas de ligne
            e.ignore()
        else:
            self._drop = target
            e.setDropAction(Qt.DropAction.MoveAction)
            e.accept()
        self.viewport().update()

    def dragLeaveEvent(self, e):
        self._drop = None
        self.viewport().update()
        super().dragLeaveEvent(e)

    def _last_visible(self):
        ix = self.model_.index(self.model_.rowCount() - 1, 0)
        while ix.isValid() and self.isExpanded(ix) and self.model_.rowCount(ix):
            ix = self.model_.index(self.model_.rowCount(ix) - 1, 0, ix)
        return ix

    def _drop_target(self, pos):
        """Où ira le dépôt : (parent, index, ligne ou cadre à dessiner), ou None.
        Jamais « dans » un modifieur (sauf un sous-modifieur) : au-dessus ou en dessous. Dans un groupe : au milieu
        de sa ligne. Sous la dernière ligne : à la fin de la forme, ligne au niveau de la forme."""
        root = self.editor.current_root()
        if root is None:
            return None
        ix = self.indexAt(pos)
        if not ix.isValid():
            last = self._last_visible()
            y = self.visualRect(last).bottom() + 1 if last.isValid() else 0
            return root, len(root.children), ("line", y, 0)
        node = ix.data(NODE_ROLE)
        r = self.visualRect(ix)
        x = r.left() + level_shift(node, root)
        frac = (pos.y() - r.top()) / max(1, r.height())
        is_group = node.kind == "group" and not node.locked
        if is_group and 0.25 <= frac <= 0.75:
            return node, 0, ("frame", r, 0)
        parent = node.parent or root
        if frac < 0.5:
            return parent, node.index(), ("line", r.top(), x)
        if (is_group or node.kind == "modifier") and node.children and self.isExpanded(ix):
            # Sous un groupe ouvert (ou un modifieur à sous-modifieurs) : en tête de son contenu
            return node, 0, ("line", r.bottom() + 1, x + self.indentation() + own_shift(node))
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
        root = self.editor.current_root()
        parent, index, _ = target
        nodes = self._dragged(md)
        if not self.editor.move_nodes([n.id for n in nodes], None if parent is root else parent.id, index):
            self.editor.statusMessage.emit("Dépôt impossible ici : un calque ne va pas dans un modifieur ni dans "
                                           "un groupe verrouillé (seuls Translation, Rotation et Échelle se posent "
                                           "sur un modifieur)")
            e.ignore()
            return
        e.setDropAction(Qt.DropAction.CopyAction)   # le modèle est reconstruit : Qt ne doit rien retirer
        e.accept()

    # ── Branches : chevrons ──────────────────────────────────────────────
    def drawBranches(self, painter, rect, index):
        pass   # la flèche est dessinée dans la ligne, alignée sur le contenu
