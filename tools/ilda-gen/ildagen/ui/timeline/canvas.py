"""Zone de la timeline : affichage et interactions (tête de lecture, boucle, pistes, clips).

Les clips se déplacent et se redimensionnent sans jamais en chevaucher un autre sur leur piste ; leurs effets
d'animation se règlent dans l'espace Show (inspecteur du clip). Double-clic sur un clip : sa forme s'ouvre
dans l'espace Forme.
"""

from PySide6.QtCore import QPointF, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import QPainter, QPen, QPixmap
from PySide6.QtWidgets import QInputDialog, QWidget

from ...editor.waveform import PEAKS_PER_S
from .. import theme
from ..canvas.view import DEF_MIME
from . import draw as D
from .clipboard import TimelineClipboard, range_modifier
from .edit import TimelineEditing
from .geometry import CLIP_EDGE, HEADER_W, LOOP_H, TimelineGeometry, link_icon_rect
from .menus import TimelineMenus
from .selection import TimelineSelection
from .thumbs import ThumbCache

MIN_PPS = 4.0
MAX_PPS = 2000.0


class TimelineCanvas(QWidget, TimelineEditing, TimelineMenus, TimelineClipboard, TimelineSelection):
    scrollChanged = Signal()
    # QWidget est en tête : sa version masquerait celle du mixin, on la relie explicitement
    contextMenuEvent = TimelineMenus.contextMenuEvent

    def __init__(self, editor, playback, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.playback = playback
        self.geo = TimelineGeometry()
        self.peaks = None
        self._wave_cache = None
        self.drag = None
        self.thumbs = ThumbCache(editor)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAcceptDrops(True)
        self.setMinimumHeight(120)
        editor.timelineChanged.connect(self._changed)
        editor.clipSelectionChanged.connect(self.update)
        editor.docChanged.connect(self.update)
        editor.projectChanged.connect(self._changed)
        editor.playheadChanged.connect(self._playhead)
        editor.restored.connect(self._restored)

    @property
    def tl(self):
        return self.editor.doc.timeline

    def _changed(self):
        self.scrollChanged.emit()
        self.update()

    def _restored(self):
        self.drag = None
        self._changed()

    def set_peaks(self, peaks):
        self.peaks = peaks
        self._wave_cache = None
        self.scrollChanged.emit()
        self.update()

    def _playhead(self, t):
        if self.editor.playing:
            x = self.geo.x(t)
            span = (self.width() - HEADER_W) / self.geo.pps
            if x > self.width() - 30 or x < HEADER_W:
                self.geo.t0 = max(0.0, t - span * 0.1)
                self.scrollChanged.emit()
        self.update()

    # ── Temps aimanté ────────────────────────────────────────────────────
    def snap(self, t, mods=Qt.KeyboardModifier.NoModifier):
        if mods & Qt.KeyboardModifier.AltModifier:
            return t
        return self.tl.snap_time(t)

    def zoom_at(self, factor, x):
        t = self.geo.t(x)
        self.geo.pps = min(MAX_PPS, max(MIN_PPS, self.geo.pps * factor))
        self.geo.t0 = max(0.0, t - (x - HEADER_W) / self.geo.pps)
        self.scrollChanged.emit()
        self.update()

    # ── Dessin ───────────────────────────────────────────────────────────
    def paintEvent(self, _e):
        g = self.geo
        g.width, g.height = self.width(), self.height()
        g.has_wave = self.peaks is not None
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(self.rect(), theme.qc(theme.BG_APP))
        rows = g.rows(self.editor)
        self.thumbs.begin_paint()
        p.setClipRect(QRectF(HEADER_W, g.top, g.width - HEADER_W, g.height - g.top))
        for i, r in enumerate(rows):
            if i % 2:
                p.fillRect(QRectF(HEADER_W, r.y, g.width - HEADER_W, r.h), theme.qc("#ffffff", 0.012))
        D.draw_grid(p, g, self.tl, g.top, g.height)
        sel = set(self.editor.clip_selection)
        for r in rows:
            for c in r.track.clips:
                D.draw_clip(p, g, r, c, self.editor, c.id in sel, r.track.muted, self.thumb)
        self.draw_range(p)
        self.draw_rect(p)
        p.setClipping(False)
        if self.peaks is not None:
            p.drawPixmap(0, 0, self._waveform_pixmap())
        D.draw_ruler(p, g, self.tl)
        p.setClipRect(QRectF(0, g.top, HEADER_W + 1, g.height - g.top))
        D.draw_headers(p, g, rows, self.editor)
        p.setClipping(False)
        D.draw_corner(p, g, self.tl)
        D.draw_playhead(p, g, self.editor.playhead)
        p.end()
        if self.thumbs.pending:
            # Vignettes pas encore calculées : on continue juste après (l'interface reste fluide)
            QTimer.singleShot(0, self.update)

    def thumb(self, clip, t_local, size):
        return self.thumbs.get(clip, t_local, size)

    def _waveform_pixmap(self):
        g = self.geo
        key = (round(g.t0, 5), round(g.pps, 5), g.width, id(self.peaks))
        if self._wave_cache is None or self._wave_cache[0] != key:
            pm = QPixmap(self.size())
            pm.fill(Qt.GlobalColor.transparent)
            p = QPainter(pm)
            D.draw_waveform(p, g, self.peaks, PEAKS_PER_S)
            p.end()
            self._wave_cache = (key, pm)
        return self._wave_cache[1]

    # ── Repérage ─────────────────────────────────────────────────────────
    def rows(self):
        return self.geo.rows(self.editor)

    def _link_icon_hit(self, row, clip, x, y):
        linked, shared = self.editor.clip_is_linked(clip)
        if linked and not shared:
            return False
        ix, iy, iw, ih = link_icon_rect(self.geo, row, clip)
        return ix - 2 <= x <= ix + iw + 2 and iy - 2 <= y <= iy + ih + 2

    def clip_hit(self, row, x):
        for c in sorted(row.track.clips, key=lambda c: c.start, reverse=True):
            cx, _, cw, _ = self.geo.clip_rect(row, c)
            if cx - 2 <= x <= cx + cw + 2:
                if x <= cx + CLIP_EDGE and cw > 3 * CLIP_EDGE:
                    return c, "left"
                if x >= cx + cw - CLIP_EDGE:
                    return c, "right"
                return c, "body"
        return None, None

    # ── Souris ───────────────────────────────────────────────────────────
    def mousePressEvent(self, e):
        self.setFocus()
        if e.button() != Qt.MouseButton.LeftButton:
            return
        self.abandon_drag()         # relâchement précédent jamais reçu
        x, y = e.position().x(), e.position().y()
        g = self.geo
        if y < g.top:
            if x < HEADER_W:
                return
            t = g.t(x)
            if y < LOOP_H + 2:
                self._press_loop(t, x)
            else:
                self.drag = {"kind": "scrub"}
                self.playback.seek(max(0.0, self.snap(t, e.modifiers())))
            return
        row = g.row_at(self.rows(), y, x)
        if x >= HEADER_W and range_modifier(e.modifiers()):
            # Cmd/Ctrl + clic sur un clip : l'ajouter / le retirer ; Cmd/Ctrl + glisser : zone de temps à copier
            hit = self.clip_hit(row, x)[0] if row is not None else None
            self.start_range(x, e.modifiers(), hit)
            return
        if x >= HEADER_W:
            self.clear_range()
        shift = bool(e.modifiers() & Qt.KeyboardModifier.ShiftModifier)
        if row is None or (x >= HEADER_W and self.clip_hit(row, x)[0] is None):
            # Glisser dans le vide : rectangle de sélection de clips ; simple clic : tête de lecture
            self.start_rect(x, y, shift)
            return
        if x < HEADER_W:
            self._press_header(row, x, y)
            return
        clip, part = self.clip_hit(row, x)
        if self._link_icon_hit(row, clip, x, y):
            linked, shared = self.editor.clip_is_linked(clip)
            if not linked:
                self.editor.relink_clip(clip.id)
            elif shared:
                self.editor.unlink_clip(clip.id)
            self._changed()
            return
        if shift:
            self.toggle_clip(clip)          # Maj + clic : ajouter / retirer de la sélection
            return
        if clip.id not in self.sel_clips:
            self.set_clip_selection([clip.id])
        self.editor.select_clips(self.editor.clip_selection, clip.id)
        self.editor.begin("Déplacer le clip" if part == "body" else "Durée du clip")
        group = {c.id: c.start for _, c in self.selected_clips()} if part == "body" else {}
        self.drag = {"kind": "clip_" + part, "clip": clip, "x0": x, "start": clip.start, "end": clip.end,
                     "group": group if len(group) > 1 else {}}
        self.update()

    def _click_empty(self, x, e):
        if x >= HEADER_W:
            self.playback.seek(max(0.0, self.snap(self.geo.t(x), e.modifiers())))
            self.drag = {"kind": "scrub"}

    def mouseMoveEvent(self, e):
        x, y = e.position().x(), e.position().y()
        d = self.drag
        if d is not None and not (e.buttons() & Qt.MouseButton.LeftButton):
            self.abandon_drag()     # bouton relâché hors de la fenêtre : le glisser est annulé
            d = None
        if d is None:
            self._hover(x, y)
            return
        g = self.geo
        tl = self.tl
        kind = d["kind"]
        if kind == "scrub":
            self.playback.seek(max(0.0, self.snap(g.t(x), e.modifiers())))
            return
        if kind == "range":
            self.drag_range(x, e.modifiers())
            return
        if kind == "rect":
            self.drag_rect(x, y)
            return
        if kind in ("loop_start", "loop_end", "loop_move"):
            t = max(0.0, self.snap(g.t(x), e.modifiers()))
            if kind == "loop_start":
                tl.loop_start = min(t, tl.loop_end)
            elif kind == "loop_end":
                tl.loop_end = max(t, tl.loop_start)
            else:
                dt = self.snap(d["a"] + g.t(x) - d["t0"], e.modifiers()) - d["a"]
                dt = max(dt, -d["a"])          # la boucle ne commence jamais avant 0
                tl.loop_start, tl.loop_end = d["a"] + dt, d["b"] + dt
            self.update()
            return
        if kind.startswith("clip_"):
            self._drag_clip(d, x, y, e.modifiers())

    def mouseReleaseEvent(self, e):
        if self.drag is None:
            return
        kind = self.drag["kind"]
        if kind == "rect":
            self.end_rect(e)
            self.drag = None
            self.update()
            return
        if kind == "range":
            self.end_range()
            self.drag = None
            return
        d = self.drag
        self.drag = None
        if kind == "clip_body" and d.get("group") and abs(e.position().x() - d["x0"]) < 2:
            self.set_clip_selection([d["clip"].id])     # simple clic dans une sélection : ce clip seul
        if kind != "scrub":
            self.editor.commit()
            self.editor.notify(timeline=True)

    def _hover(self, x, y):
        g = self.geo
        cur = Qt.CursorShape.ArrowCursor
        if y >= g.top and x >= HEADER_W:
            row = g.row_at(self.rows(), y)
            if row is not None:
                _, part = self.clip_hit(row, x)
                if part in ("left", "right"):
                    cur = Qt.CursorShape.SizeHorCursor
                elif part == "body":
                    cur = Qt.CursorShape.OpenHandCursor
        elif y < LOOP_H + 2 and x >= HEADER_W:
            cur = Qt.CursorShape.SizeHorCursor
        self.setCursor(cur)

    def mouseDoubleClickEvent(self, e):
        x, y = e.position().x(), e.position().y()
        row = self.geo.row_at(self.rows(), y, x)
        if row is None:
            return
        if x < HEADER_W:
            name, ok = QInputDialog.getText(self, "Renommer la piste", "Nom :", text=row.track.name)
            if ok and name.strip():
                self.editor.rename_track(row.track.id, name)
            return
        clip, _ = self.clip_hit(row, x)
        if clip is not None:
            self.editor.enter_def(clip.def_id)          # sa forme s'ouvre dans l'espace Forme

    def wheelEvent(self, e):
        mods = e.modifiers()
        pd = e.pixelDelta()
        ad = e.angleDelta()
        if mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier):
            self.zoom_at(1.0015 ** (ad.y() or ad.x()), e.position().x())
        elif mods & Qt.KeyboardModifier.ShiftModifier:
            # Maj + molette : défilement vertical des pistes
            dy = pd.y() if not pd.isNull() else (ad.y() or ad.x()) / 2
            self.scroll_by(-dy)
        elif self._is_trackpad(e):
            # Pavé tactile : glisser à deux doigts = haut / bas (pistes) et gauche / droite (temps)
            d = pd if not pd.isNull() else ad / 2
            self._scroll_time(d.x())
            if d.y():
                self.scroll_by(-d.y())
        else:
            # Molette : la timeline défile de gauche à droite
            dx = (ad.x() if abs(ad.x()) > abs(ad.y()) else ad.y()) / 2
            self._scroll_time(dx)
        e.accept()

    @staticmethod
    def _is_trackpad(e):
        from PySide6.QtGui import QInputDevice
        dev = e.device()
        if dev is not None and dev.type() == QInputDevice.DeviceType.TouchPad:
            return True
        return not e.pixelDelta().isNull() or e.phase() != Qt.ScrollPhase.NoScrollPhase

    def _scroll_time(self, dx):
        if not dx:
            return
        self.geo.t0 = max(0.0, self.geo.t0 - dx / self.geo.pps)
        self.scrollChanged.emit()
        self.update()

    def scroll_by(self, dy):
        g = self.geo
        max_y = max(0, g.content_height(self.editor) - (self.height() - g.top))
        g.scroll_y = int(min(max_y, max(0, g.scroll_y + dy)))
        self.scrollChanged.emit()
        self.update()

    def keyPressEvent(self, e):
        if e.key() == Qt.Key.Key_Escape and self.abandon_drag():
            return
        if e.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            self.delete_selection()
            return
        if e.key() == Qt.Key.Key_Escape and self.range_sel is not None:
            self.clear_range()
            return
        super().keyPressEvent(e)

    # ── Dépôt d'une forme : un clip (place occupée : juste après ; sous les pistes : nouvelle piste) ──
    def dragEnterEvent(self, e):
        if e.mimeData().hasFormat(DEF_MIME):
            e.acceptProposedAction()

    def dragMoveEvent(self, e):
        if e.mimeData().hasFormat(DEF_MIME):
            e.acceptProposedAction()

    def dropEvent(self, e):
        if not e.mimeData().hasFormat(DEF_MIME):
            return
        def_id = bytes(e.mimeData().data(DEF_MIME)).decode("utf-8")
        pos = e.position()
        row = self.geo.row_at(self.rows(), pos.y())
        track = row.track if row is not None else self.editor.add_track()
        t = max(0.0, self.snap(self.geo.t(max(HEADER_W, pos.x()))))
        clip = self.editor.add_clip(def_id, track.id, t)
        self.editor.select_clip(clip.id)
        e.acceptProposedAction()


__all__ = ["TimelineCanvas", "QPointF", "QPen"]
