"""Zone de la timeline : affichage et interactions (tête de lecture, boucle, clips, automations)."""

from PySide6.QtCore import QPointF, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import QColor, QPainter, QPixmap
from PySide6.QtWidgets import QColorDialog, QInputDialog, QWidget

from ...core.timeline import Track
from ...editor.waveform import PEAKS_PER_S
from .. import theme
from ..canvas.view import DEF_MIME
from . import draw as D
from . import lanes as L
from .geometry import CHEVRON_W, CLIP_EDGE, HEADER_W, LOOP_H, TimelineGeometry
from .edit import TimelineEditing
from .menus import TimelineMenus
from .thumbs import ThumbCache

MIN_PPS = 4.0
MAX_PPS = 2000.0


class TimelineCanvas(QWidget, TimelineEditing, TimelineMenus):
    scrollChanged = Signal()

    def __init__(self, editor, playback, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.playback = playback
        self.geo = TimelineGeometry()
        self.peaks = None
        self._wave_cache = None
        self.drag = None
        self.sel_key = None
        self.thumbs = ThumbCache(editor)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAcceptDrops(True)
        self.setMinimumHeight(120)
        editor.timelineChanged.connect(self._changed)
        editor.contextChanged.connect(self.update)
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
        self.sel_key = None
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
            if r.kind == "track":
                p.fillRect(QRectF(HEADER_W, r.y, g.width - HEADER_W, r.h),
                           theme.qc("#ffffff", 0.012 if i % 2 else 0.0))
        D.draw_grid(p, g, self.tl, g.top, g.height)
        sel_clip = self.editor.context[1] if self.editor.context[0] == "clip" else None
        for r in rows:
            if r.kind == "lane":
                D.draw_lane(p, g, r, self.editor, self.sel_key)
            elif r.kind == "group":
                D.draw_group(p, g, r)
            else:
                for c in r.track.clips:
                    D.draw_clip(p, g, r, c, self.editor, c.id == sel_clip, r.track.muted, self.thumb)
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

    def clip_hit(self, row, x):
        for c in sorted(row.track.clips, key=lambda c: c.start, reverse=True):
            cx, _, cw, _ = self.geo.clip_rect(row, c)
            if cx - 2 <= x <= cx + cw + 2:
                if x <= cx + CLIP_EDGE and cw > 3 * CLIP_EDGE:
                    if x >= cx + 2 and x <= cx + CHEVRON_W and cw > CHEVRON_W + 4:
                        return c, "chevron"
                    return c, "left"
                if x >= cx + cw - CLIP_EDGE:
                    return c, "right"
                if x <= cx + CHEVRON_W and cw > CHEVRON_W + 4:
                    return c, "chevron"
                return c, "body"
        return None, None

    def key_hit(self, row, x, y):
        node, spec = L.target(self.editor, row.clip, row.auto)
        rng = L.value_range(spec, row.auto)
        for k in row.auto.keys:
            kx = self.geo.x(row.clip.start + k.t)
            ky = row.y + row.h / 2 if L.is_color(spec) else L.v_to_y(k.v, row, rng)
            if abs(kx - x) <= 6 and abs(ky - y) <= 7:
                return k
        return None

    def handle_hit(self, row, x, y):
        if self.sel_key is None or self.sel_key not in row.auto.keys or self.sel_key.curve != "custom":
            return None
        node, spec = L.target(self.editor, row.clip, row.auto)
        h = D.bezier_handles(self.geo, row, row.clip, row.auto, self.sel_key, L.value_range(spec, row.auto))
        if h is None:
            return None
        for i, (hx, hy) in ((0, h[2]), (1, h[3])):
            if abs(hx - x) <= 6 and abs(hy - y) <= 6:
                return i
        return None

    # ── Souris ───────────────────────────────────────────────────────────
    def mousePressEvent(self, e):
        self.setFocus()
        if e.button() != Qt.MouseButton.LeftButton:
            return
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
        rows = self.rows()
        row = g.row_at(rows, y)
        if row is None:
            self._click_empty(x, e)
            return
        if x < HEADER_W:
            self._press_header(row, x, y)
            return
        if row.kind == "group":
            self.toggle_group(row)
            return
        if row.kind == "track":
            clip, part = self.clip_hit(row, x)
            if clip is None:
                self._click_empty(x, e)
                return
            if part == "chevron":
                clip.expanded = not clip.expanded
                self.editor.enter_clip(clip.id)
                self._changed()
                return
            self.editor.enter_clip(clip.id)
            self.editor.begin("Déplacer le clip" if part == "body" else "Durée du clip")
            self.drag = {"kind": "clip_" + part, "clip": clip, "track": row.track, "x0": x,
                         "start": clip.start, "end": clip.end}
            self.update()
            return
        self._press_lane(row, x, y, e)

    def _click_empty(self, x, e):
        if self.editor.context[0] == "clip":
            self.editor.enter_scene()
            self.editor.set_view_source("timeline")
        if x >= HEADER_W:
            self.playback.seek(max(0.0, self.snap(self.geo.t(x), e.modifiers())))
            self.drag = {"kind": "scrub"}

    def mouseMoveEvent(self, e):
        x, y = e.position().x(), e.position().y()
        d = self.drag
        if d is None:
            self._hover(x, y)
            return
        g = self.geo
        tl = self.tl
        kind = d["kind"]
        if kind == "scrub":
            self.playback.seek(max(0.0, self.snap(g.t(x), e.modifiers())))
            return
        if kind in ("loop_start", "loop_end", "loop_move"):
            t = max(0.0, self.snap(g.t(x), e.modifiers()))
            if kind == "loop_start":
                tl.loop_start = min(t, tl.loop_end)
            elif kind == "loop_end":
                tl.loop_end = max(t, tl.loop_start)
            else:
                dt = self.snap(d["a"] + g.t(x) - d["t0"], e.modifiers()) - d["a"]
                tl.loop_start, tl.loop_end = max(0.0, d["a"] + dt), max(0.0, d["b"] + dt)
            self.update()
            return
        if kind.startswith("clip_"):
            self._drag_clip(d, x, y, e.modifiers())
            return
        if kind == "key":
            self._drag_key(d, x, y, e.modifiers())
            return
        if kind == "handle":
            self._drag_handle(d, x, y)

    def mouseReleaseEvent(self, e):
        if self.drag is not None:
            kind = self.drag["kind"]
            self.drag = None
            if kind != "scrub":
                self.editor.commit()
                self.editor.notify(timeline=True)

    def _hover(self, x, y):
        g = self.geo
        cur = Qt.CursorShape.ArrowCursor
        if y >= g.top and x >= HEADER_W:
            row = g.row_at(self.rows(), y)
            if row is not None and row.kind == "track":
                c, part = self.clip_hit(row, x)
                if part in ("left", "right"):
                    cur = Qt.CursorShape.SizeHorCursor
                elif part == "body":
                    cur = Qt.CursorShape.OpenHandCursor
                elif part == "chevron":
                    cur = Qt.CursorShape.PointingHandCursor
        elif y < LOOP_H + 2 and x >= HEADER_W:
            cur = Qt.CursorShape.SizeHorCursor
        self.setCursor(cur)

    def mouseDoubleClickEvent(self, e):
        x, y = e.position().x(), e.position().y()
        row = self.geo.row_at(self.rows(), y)
        if row is None:
            return
        if row.kind == "group":
            return
        if row.kind == "track" and x < HEADER_W:
            name, ok = QInputDialog.getText(self, "Renommer la piste", "Nom :", text=row.track.name)
            if ok and name.strip():
                self.editor.timeline_mutate("Renommer la piste", lambda: setattr(row.track, "name", name.strip()))
            return
        if row.kind == "track":
            clip, _ = self.clip_hit(row, x)
            if clip is not None:
                clip.expanded = not clip.expanded
                self._changed()
            return
        k = self.key_hit(row, x, y)
        node, spec = L.target(self.editor, row.clip, row.auto)
        if k is not None and L.is_color(spec):
            c = QColorDialog.getColor(QColor.fromRgbF(*k.v), self, "Couleur de la clé",
                                      QColorDialog.ColorDialogOption.DontUseNativeDialog)
            if c.isValid():
                self.editor.timeline_mutate("Clé d'automation", lambda: setattr(k, "v", (c.redF(), c.greenF(), c.blueF())))

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
        else:
            # Molette : la timeline défile de gauche à droite
            if not pd.isNull():
                dx = pd.x() if abs(pd.x()) > abs(pd.y()) else pd.y()
            else:
                dx = (ad.x() if abs(ad.x()) > abs(ad.y()) else ad.y()) / 2
            self.geo.t0 = max(0.0, self.geo.t0 - dx / self.geo.pps)
            self.scrollChanged.emit()
            self.update()
        e.accept()

    def scroll_by(self, dy):
        g = self.geo
        max_y = max(0, g.content_height(self.editor) - (self.height() - g.top))
        g.scroll_y = int(min(max_y, max(0, g.scroll_y + dy)))
        self.scrollChanged.emit()
        self.update()

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
            self.delete_selection()
            return
        super().keyPressEvent(e)

    # ── Dépôt d'une forme personnalisée ──────────────────────────────────
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
        track = row.track if row is not None else None
        if track is None:
            track = Track(f"Piste {len(self.tl.tracks) + 1}")
            self.editor.timeline_mutate("Ajouter une piste", lambda: self.tl.tracks.append(track))
        t = max(0.0, self.snap(self.geo.t(max(HEADER_W, pos.x()))))
        clip = self.editor.add_clip(def_id, track.id, t)
        self.editor.enter_clip(clip.id)
        e.acceptProposedAction()


__all__ = ["TimelineCanvas", "QPointF"]
