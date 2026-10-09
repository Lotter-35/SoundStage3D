"""Liste « Formes » de l'espace Forme : vignettes carrées (2 colonnes), animées si la forme oscille.

Clic : la forme devient la forme en cours ; double-clic : renommer (sur place) ; glisser : vers la timeline
(Show) ou dans la mire (forme placée), même type de données qu'avant (DEF_MIME) ; clic droit : Nouvelle forme,
Renommer, Dupliquer, Placer dans la forme en cours, Supprimer ; Suppr (liste active) : supprimer ; case « + » et
bouton + de l'en-tête : nouvelle forme vide.
"""

from PySide6.QtCore import QMimeData, QPoint, Qt, QTimer
from PySide6.QtGui import QDrag
from PySide6.QtWidgets import QApplication, QLineEdit, QMenu, QScrollArea, QVBoxLayout, QWidget
from shiboken6 import isValid

from ..canvas.view import DEF_MIME
from ..properties.common import PanelHead
from ..widgets import Tile
from ..widgets.tile import STRIP_H
from .thumbs import ANIM_MS, ThumbCache

GAP, PAD = 6, 8


class FormTile(Tile):
    def __init__(self, lib, def_id, name):
        super().__init__(name, None)
        self.lib = lib
        self.def_id = def_id
        self._press = None
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.set_painter(self._paint_preview)
        self.contextRequested.connect(lambda gp: lib.menu(self.def_id, gp))
        self.doubleClicked.connect(lambda: lib.start_rename(self.def_id))
        self.clicked.connect(lambda: lib.choose(self.def_id))

    def _paint_preview(self, p, rect):
        sc = self.lib.cache.scene(self.def_id)
        if sc is not None and not sc.is_empty():
            sc.paint(p, rect.adjusted(4, 4, -4, -STRIP_H), glow=True, width=1.4, margin=2)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._press = e.position().toPoint()
        self.lib.setFocus(Qt.FocusReason.MouseFocusReason)
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        super().mouseMoveEvent(e)
        if self._press is None or not (e.buttons() & Qt.MouseButton.LeftButton):
            return
        if (e.position().toPoint() - self._press).manhattanLength() < QApplication.startDragDistance():
            return
        self._press = None
        self._pressed = False
        md = QMimeData()
        md.setData(DEF_MIME, self.def_id.encode("utf-8"))
        drag = QDrag(self)
        drag.setMimeData(md)
        drag.setPixmap(self.grab().scaledToWidth(64, Qt.TransformationMode.SmoothTransformation))
        drag.setHotSpot(QPoint(32, 32))
        drag.exec(Qt.DropAction.CopyAction)


class TileGrid(QWidget):
    """Vignettes posées à la main en 2 colonnes carrées (la hauteur suit la largeur)."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.tiles = []

    def place(self):
        w = max(40, self.width())
        side = max(30, (w - 2 * PAD - GAP) // 2)
        for i, t in enumerate(self.tiles):
            r, c = divmod(i, 2)
            t.setGeometry(PAD + c * (side + GAP), 4 + r * (side + GAP), side, side)
        rows = (len(self.tiles) + 1) // 2
        self.setMinimumHeight(4 + rows * (side + GAP) + PAD)

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self.place()


class FormLibrary(QWidget):
    def __init__(self, editor, time_fn=None, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.cache = ThumbCache(editor, time_fn or editor.loop_time)
        self.tiles = {}
        self._editor = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.head = PanelHead("Formes")
        self.btn_new = self.head.add_button("plus", "Nouvelle forme (vide)", lambda: editor.new_form())
        lay.addWidget(self.head)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.grid = TileGrid()
        self.scroll.setWidget(self.grid)
        lay.addWidget(self.scroll, 1)
        self.add_tile = Tile()
        self.add_tile.set_state(add=True)
        self.add_tile.setToolTip("Nouvelle forme (vide)")
        self.add_tile.clicked.connect(lambda: editor.new_form())
        self.add_tile.setParent(self.grid)
        self._later = QTimer(self)
        self._later.setSingleShot(True)
        self._later.timeout.connect(self._repaint_dirty)
        self.anim = QTimer(self)
        self.anim.timeout.connect(self._animate)
        self.anim.start(ANIM_MS)
        editor.libraryChanged.connect(self.rebuild)
        editor.projectChanged.connect(self.rebuild)
        editor.restored.connect(lambda: self.cache.mark())
        editor.docChanged.connect(self._doc_changed)
        editor.contextChanged.connect(self.highlight)
        self.rebuild()

    # ── Vignettes ────────────────────────────────────────────────────────
    def rebuild(self):
        defs = self.editor.doc.library.visible()
        ids = [d.id for d in defs]
        for k in list(self.tiles):
            if k not in ids:
                t = self.tiles.pop(k)
                t.hide()
                t.deleteLater()
        order = []
        for d in defs:
            t = self.tiles.get(d.id)
            if t is None:
                t = FormTile(self, d.id, d.name)
                t.setParent(self.grid)
                t.show()
                self.tiles[d.id] = t
            elif t.name != d.name:
                t.set_name(d.name)
            order.append(t)
        self.grid.tiles = order + [self.add_tile]
        self.add_tile.show()
        self.cache.forget(set(ids))
        self.cache.mark()
        self.grid.place()
        self.highlight()

    def _doc_changed(self):
        cur = self.editor.current_form_id()
        if cur is None:
            return
        self.cache.mark(self.editor.forms_using(cur))
        if not self._later.isActive():
            self._later.start(150)       # vignette recalculée au plus ~7 fois par seconde pendant un geste

    def _repaint_dirty(self):
        for k in list(self.cache.dirty):
            t = self.tiles.get(k)
            if t is not None:
                t.update()

    def _animate(self):
        if not self.isVisible() or not self.cache.animated:
            return
        win = self.window()
        if win is not None and win.isMinimized():
            return
        for k in list(self.cache.animated):
            t = self.tiles.get(k)
            if t is not None and not t.visibleRegion().isEmpty():
                self.cache.advance(k)
                t.update()

    def highlight(self):
        cur = self.editor.current_form_id()
        for k, t in self.tiles.items():
            if t.selected != (k == cur):
                t.set_state(selected=k == cur)
        t = self.tiles.get(cur)
        if t is not None:
            self.scroll.ensureWidgetVisible(t, 0, 0)

    # ── API (fenêtre, tests) ─────────────────────────────────────────────
    def count(self):
        return len(self.tiles)

    def ids(self):
        return [t.def_id for t in self.grid.tiles if isinstance(t, FormTile)]

    def tile(self, def_id):
        return self.tiles.get(def_id)

    def current_id(self):
        return self.editor.current_form_id()

    def choose(self, def_id):
        self.editor.enter_def(def_id)

    def delete_current(self):
        ed = self.editor
        def_id = ed.current_form_id()
        d = ed.doc.library.get(def_id)
        if d is None:
            return
        last = len(ed.doc.library.visible()) == 1
        ed.delete_def(def_id)
        extra = " — le projet garde toujours une forme : une forme vide a été créée" if last else ""
        ed.statusMessage.emit(f"Forme « {d.name} » supprimée{extra} (Ctrl+Z pour annuler)")

    # ── Renommer sur place ───────────────────────────────────────────────
    def start_rename(self, def_id):
        t = self.tiles.get(def_id)
        d = self.editor.doc.library.get(def_id)
        if t is None or d is None:
            return None
        self._end_rename(False)
        e = QLineEdit(t)
        e.setText(d.name)
        e.selectAll()
        e.setGeometry(2, t.height() - STRIP_H - 2, t.width() - 4, STRIP_H)
        e.editingFinished.connect(lambda: self._end_rename(True))
        e.installEventFilter(self)
        e.show()
        e.setFocus()
        self._editor = (e, def_id)
        return e

    def _end_rename(self, keep):
        if self._editor is None:
            return
        e, def_id = self._editor
        self._editor = None
        if isValid(e):
            text = e.text().strip()
            e.blockSignals(True)
            e.hide()
            e.deleteLater()
            if keep and text:
                self.editor.rename_def(def_id, text)

    def eventFilter(self, obj, ev):
        if self._editor is not None and obj is self._editor[0] and ev.type() == ev.Type.KeyPress \
                and ev.key() == Qt.Key.Key_Escape:
            self._end_rename(False)
            return True
        return super().eventFilter(obj, ev)

    # ── Menu ─────────────────────────────────────────────────────────────
    def menu(self, def_id, gpos):
        ed = self.editor
        m = QMenu(self)
        a_new = m.addAction("Nouvelle forme")
        m.addSeparator()
        a_ren = m.addAction("Renommer (double-clic)")
        a_dup = m.addAction("Dupliquer")
        cur = ed.current_form()
        a_place = None
        if cur is not None and cur.id != def_id:
            a_place = m.addAction(f"Placer dans « {cur.name} »")
        m.addSeparator()
        a_del = m.addAction("Supprimer")
        chosen = m.exec(gpos)
        if chosen is None:
            return
        if chosen is a_new:
            ed.new_form()
        elif chosen is a_ren:
            self.start_rename(def_id)
        elif chosen is a_dup:
            ed.duplicate_form(def_id)
        elif chosen is a_place:
            ed.place_instance(def_id)
        elif chosen is a_del:
            ed.enter_def(def_id)
            self.delete_current()
