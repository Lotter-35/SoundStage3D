"""Grille de cues de l'espace Live : les 8 × 4 cases de la page affichée.

Une case = une forme : aperçu animé, nom, touche du clavier en haut à droite. Clic = lancer (ou arrêter un cue
en cours, annuler un cue en attente) ; clic droit = menu (placer une forme, changer la touche, vider la case) ;
glisser un cue sur une autre case = le déplacer (les deux cases s'échangent) ; déposer une forme venue de la
liste des formes = la placer.

États : en cours (contour et bandeau accent, barre d'avancement de sa boucle), en attente d'un départ calé
(contour pointillé accent, « · en attente »), case vide (pointillés).

Aperçus (tick, appelé par l'espace à chaque image) : un cue en cours montre sa forme au temps écoulé depuis son
départ, à chaque image ; une forme animée qui ne joue pas avance quelques fois par seconde (temps de boucle) ;
une forme fixe est calculée une fois par version du contenu (Thumbs).
"""

import json

from PySide6.QtCore import QMimeData, QPoint, QRectF, Qt
from PySide6.QtGui import QDrag, QPainter, QPen
from PySide6.QtWidgets import QApplication, QGridLayout, QSizePolicy, QWidget

from ...core.live import COLS, ROWS, SLOTS
from .. import theme
from ..canvas.view import DEF_MIME
from ..widgets import LaserScene, Tile
from .menus import cue_menu

CUE_MIME = "application/x-ildagen-cue"
IDLE_EVERY = 6          # forme animée qui ne joue pas : une image sur 6 (≈ 4 images/s)


class CueTile(Tile):
    def __init__(self, grid, slot):
        super().__init__(strip="bar", square=False)
        self.grid = grid
        self.slot = slot
        self.cue = None
        self.def_id = None
        self.rev = None
        self.animated = False
        self.scene = LaserScene()
        self._own = LaserScene()          # tracés propres à la case (cue en cours, forme animée)
        self.drop_target = False
        self._press = None
        self.setAcceptDrops(True)
        self.setMinimumSize(48, 64)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.set_painter(self._paint_scene)

    def _paint_scene(self, p, r):
        self.scene.paint(p, self.scene.square(r), glow=False, width=1.4, margin=2)

    def show_strokes(self, strokes):
        self._own.set_strokes(strokes)
        self.scene = self._own
        self.update()

    def show_scene(self, scene):
        if scene is not self.scene:
            self.scene = scene
            self.update()

    def paintEvent(self, e):
        super().paintEvent(e)
        if self.drop_target:
            p = QPainter(self)
            p.setRenderHint(QPainter.RenderHint.Antialiasing)
            p.setPen(QPen(theme.qc(theme.ACCENT), 2))
            p.drawRoundedRect(QRectF(self.rect()).adjusted(1, 1, -1, -1), theme.RADIUS, theme.RADIUS)
            p.end()

    # ── Souris : clic (Tile), glisser un cue ─────────────────────────────
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._press = e.position().toPoint()
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if (self._press is not None and self.cue is not None and e.buttons() & Qt.MouseButton.LeftButton
                and (e.position().toPoint() - self._press).manhattanLength() >= QApplication.startDragDistance()):
            self._press = None
            self._pressed = False             # le relâché ne sera pas un clic
            self.grid.start_drag(self)
            return
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        self._press = None
        super().mouseReleaseEvent(e)

    def mouseDoubleClickEvent(self, e):
        # Deux clics rapprochés = deux clics (lancer puis arrêter), jamais un double-clic qui en perd un
        if e.button() == Qt.MouseButton.LeftButton:
            self._pressed = True
            self._press = e.position().toPoint()

    # ── Déposer ──────────────────────────────────────────────────────────
    def _set_drop(self, on):
        if on != self.drop_target:
            self.drop_target = on
            self.update()

    def dragEnterEvent(self, e):
        md = e.mimeData()
        if md.hasFormat(CUE_MIME) or md.hasFormat(DEF_MIME):
            e.acceptProposedAction()
            self._set_drop(True)

    def dragMoveEvent(self, e):
        e.acceptProposedAction()

    def dragLeaveEvent(self, e):
        self._set_drop(False)

    def dropEvent(self, e):
        self._set_drop(False)
        if self.grid.drop(self.slot, e.mimeData()):
            e.acceptProposedAction()


class CueGrid(QWidget):
    def __init__(self, editor, thumbs, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.thumbs = thumbs
        self.tiles = []
        lay = QGridLayout(self)
        lay.setContentsMargins(8, 8, 8, 8)
        lay.setSpacing(6)
        for i in range(SLOTS):
            t = CueTile(self, i)
            t.clicked.connect(lambda i=i: self.click(i))
            t.contextRequested.connect(lambda pos, i=i: self.show_menu(i, pos))
            lay.addWidget(t, i // COLS, i % COLS)
            self.tiles.append(t)
        for c in range(COLS):
            lay.setColumnStretch(c, 1)
        for r in range(ROWS):
            lay.setRowStretch(r, 1)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

    def paintEvent(self, _e):
        p = QPainter(self)
        p.fillRect(self.rect(), theme.qc(theme.BG_APP))
        p.end()

    def page(self):
        return self.editor.live_page()

    # ── Contenu de la page ───────────────────────────────────────────────
    def refresh(self):
        """Formes, noms et touches des cases de la page affichée ; aperçus recalculés si la forme ou le
        contenu ont changé."""
        ed = self.editor
        lib = ed.doc.library
        rev = ed.content_rev
        for t, cue in zip(self.tiles, self.page().cues):
            d = lib.get(cue.def_id) if cue is not None else None
            t.cue = cue if d is not None else None
            name, key = (d.name, cue.key) if d is not None else ("", "")
            # Seulement ce qui change : lancer un cue ne repeint pas toute la grille
            if (t.empty, t.name, t.key) != (d is None, name, key):
                t.name, t.key = name, key
                t.set_state(empty=d is None)
            if d is None:
                t.def_id = t.rev = None
                if t.playing or t.waiting:
                    t.set_state(playing=False, waiting=False)
            elif t.def_id != d.id or t.rev != rev:
                t.def_id, t.rev = d.id, rev
                self.idle_thumb(t)

    def idle_thumb(self, t):
        """Aperçu d'une case qui ne joue pas : la forme au temps de boucle (fixe : tracés partagés)."""
        sc = self.thumbs.static_scene(t.def_id)
        t.animated = sc is None
        if sc is not None:
            t.show_scene(sc)
        else:
            strokes, _ = self.thumbs.form(t.def_id, self.editor.loop_time())
            t.show_strokes(strokes)

    def tick(self, now, s_now, cue_out, frame):
        """Une image : états des cases (en cours, en attente), aperçus des cues en cours (cue_out : tracés de
        chaque cue en cours, par id), formes animées au ralenti."""
        rt = self.editor.runtime
        for t in self.tiles:
            cue = t.cue
            if cue is None:
                continue
            st = rt.state(cue.id, now)
            playing = st == "playing"
            if playing != t.playing or (st == "waiting") != t.waiting:
                t.set_state(playing=playing, waiting=st == "waiting")
                if not playing:
                    t.set_progress(None)
                    self.idle_thumb(t)
            if playing:
                pc = rt.cues.get(cue.id)
                if t.animated and cue.id in cue_out:       # forme fixe : son aperçu partagé suffit
                    t.show_strokes(cue_out[cue.id])
                loop = self.thumbs.loop(t.def_id)
                t.set_progress(((s_now - pc.s_start) % loop) / loop if pc is not None and loop > 0 else None)
            elif t.animated and (frame + t.slot) % IDLE_EVERY == 0:
                self.idle_thumb(t)

    # ── Actions ──────────────────────────────────────────────────────────
    def click(self, slot):
        cue = self.page().cues[slot]
        if cue is not None:
            self.editor.trigger_cue(cue.id)

    def show_menu(self, slot, pos):
        cue_menu(self, self.editor, slot).exec(pos)

    def drag_mime(self, slot):
        md = QMimeData()
        md.setData(CUE_MIME, json.dumps({"page": self.page().id, "slot": slot}).encode("utf-8"))
        return md

    def start_drag(self, tile):
        drag = QDrag(tile)
        drag.setMimeData(self.drag_mime(tile.slot))
        pm = tile.grab()
        w = min(pm.width(), 96)
        drag.setPixmap(pm.scaledToWidth(w, Qt.TransformationMode.SmoothTransformation))
        drag.setHotSpot(QPoint(w // 2, w // 2))
        drag.exec(Qt.DropAction.MoveAction)

    def drop(self, slot, md):
        """Dépôt sur une case : un cue de la page (échange des deux cases) ou une forme (placée ici)."""
        page = self.page()
        if md.hasFormat(CUE_MIME):
            try:
                d = json.loads(bytes(md.data(CUE_MIME)).decode("utf-8"))
                src = int(d["slot"])
            except (ValueError, KeyError, TypeError):
                return False
            if d.get("page") != page.id:
                return False
            self.editor.move_cue(page.id, src, slot)
            return True
        if md.hasFormat(DEF_MIME):
            def_id = bytes(md.data(DEF_MIME)).decode("utf-8")
            return self.editor.set_cue(page.id, slot, def_id) is not None
        return False
