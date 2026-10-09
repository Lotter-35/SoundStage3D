"""Bibliothèque de Show, partie « Formes » : vignettes des formes sur 3 colonnes.

Glisser une vignette dans la timeline = un clip (même type de données que la liste des formes de l'espace
Forme) ; double-clic = un clip à la tête de lecture, sur la piste du clip actif. Les vignettes des formes qui
bougent (oscillateurs) s'animent doucement (8 images/s), seulement quand Show est affiché.
"""

from PySide6.QtCore import QMimeData, QPoint, Qt, QTimer
from PySide6.QtGui import QDrag
from PySide6.QtWidgets import QGridLayout, QWidget

from ...core.evaluator import evaluate_form
from ..canvas.view import DEF_MIME
from ..widgets import LaserScene, Tile

COLS = 3
FPS_MS = 125


class FormTile(Tile):
    def __init__(self, def_id, name, parent=None):
        super().__init__(name, None, parent=parent)
        self.def_id = def_id
        self.scene = LaserScene(fit=True)
        self.painter = self._paint
        self._press = None
        self.setToolTip("Glisser dans la timeline pour poser un clip · double-clic : à la tête de lecture")

    def _paint(self, p, rect):
        self.scene.paint(p, rect, glow=True, width=1.2, margin=rect.width() * 0.12)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._press = e.position().toPoint()
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._press is not None and (e.buttons() & Qt.MouseButton.LeftButton) \
                and (e.position().toPoint() - self._press).manhattanLength() > 6:
            self._press = None
            self._pressed = False
            drag = QDrag(self)
            drag.setMimeData(self.mime())
            drag.setPixmap(self.grab().scaled(48, 48, Qt.AspectRatioMode.KeepAspectRatio))
            drag.setHotSpot(QPoint(24, 24))
            drag.exec(Qt.DropAction.CopyAction)
            return
        super().mouseMoveEvent(e)

    def mime(self):
        md = QMimeData()
        md.setData(DEF_MIME, self.def_id.encode("utf-8"))
        return md


class FormTiles(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.tiles = []
        self.grid = QGridLayout(self)
        self.grid.setContentsMargins(8, 2, 8, 8)
        self.grid.setSpacing(5)
        self._animated = set()
        self.timer = QTimer(self)
        self.timer.setInterval(FPS_MS)
        self.timer.timeout.connect(self.tick)
        self._rebuild_timer = QTimer(self)
        self._rebuild_timer.setSingleShot(True)
        self._rebuild_timer.timeout.connect(self.rebuild)
        editor.libraryChanged.connect(self.rebuild)
        editor.projectChanged.connect(self.rebuild)
        editor.docChanged.connect(lambda: self._rebuild_timer.start(300))
        editor.workspaceChanged.connect(lambda _: self._timer_state())
        self.rebuild()

    def rebuild(self):
        defs = self.editor.doc.library.visible()
        ids = [d.id for d in defs]
        if [t.def_id for t in self.tiles] != ids:
            for t in self.tiles:
                t.setParent(None)
                t.deleteLater()
            self.tiles = []
            for i, d in enumerate(defs):
                t = FormTile(d.id, d.name)
                t.doubleClicked.connect(lambda did=d.id: self.add_at_playhead(did))
                self.grid.addWidget(t, i // COLS, i % COLS)
                self.tiles.append(t)
            for c in range(COLS):
                self.grid.setColumnStretch(c, 1)
        for t, d in zip(self.tiles, defs):
            t.set_name(d.name)
        self.tick(full=True)
        self._timer_state()

    def tick(self, full=False):
        """Recalcule les vignettes (toutes, ou seulement celles qui bougent)."""
        ed = self.editor
        lib = ed.doc.library
        t = ed.loop_time()
        for tile in self.tiles:
            if not full and tile.def_id not in self._animated:
                continue
            d = lib.get(tile.def_id)
            if d is None:
                continue
            strokes, animated = evaluate_form(d, lib, t, ed.doc.timeline.bpm, ed.default_color())
            if animated:
                self._animated.add(d.id)
            else:
                self._animated.discard(d.id)
            tile.scene.set_strokes(strokes)
            tile.update()

    def _timer_state(self):
        on = bool(self._animated) and self.isVisible() and self.editor.workspace == "show"
        if on and not self.timer.isActive():
            self.timer.start()
        elif not on:
            self.timer.stop()

    def showEvent(self, e):
        super().showEvent(e)
        self._timer_state()

    def hideEvent(self, e):
        super().hideEvent(e)
        self.timer.stop()

    def add_at_playhead(self, def_id):
        ed = self.editor
        clip = ed.current_clip()
        tr = ed.doc.timeline.find_clip(clip.id)[0] if clip is not None else ed.doc.timeline.tracks[0]
        if tr.locked:
            ed.statusMessage.emit("Piste verrouillée")
            return None
        c = ed.add_clip(def_id, tr.id, ed.playhead)
        ed.select_clip(c.id)
        return c

