"""Zone de la timeline : règle, musique, pistes et clips (affichage, défilement, zoom).

Les gestes sont répartis par sujet : mouse.py (aiguillage de la souris), edit.py (clips), keys.py (clés de
courbe), ruler.py (tête de lecture, repères, boucle), tracks.py (en-têtes des pistes), keyboard.py (touches),
menus.py (clic droit), drops.py (formes et effets déposés), selection.py / clipboard.py (sélection, zone de
temps). Un seul modèle de sélection de clips : celui de l'éditeur (le clip actif en fait partie).

Affichage économe (T5, T6) : la disposition est gardée tant que rien ne change, seules les pistes et les clips
visibles sont peints, les courbes et les vignettes sont en cache ; au repos, rien ne repeint.
"""

import time
from collections import Counter

from PySide6.QtCore import QEvent, QRectF, Qt, QTimer, Signal
from PySide6.QtGui import QPainter, QPixmap
from PySide6.QtWidgets import QWidget

from ...editor.waveform import PEAKS_PER_S
from ..canvas.viewport import wheel_action
from .. import theme
from . import draw as D
from .clipboard import TimelineClipboard
from .draw_clip import ClipStyle, draw_clip, draw_ghost
from .drops import TimelineDrops
from .edit import TimelineEditing
from .geometry import HEADER_W, RULER_H, TimelineGeometry
from .keyboard import TimelineKeyboard
from .keys import KeyEditing
from .lanes import clip_lanes
from .menus import TimelineMenus
from .mouse import TimelineMouse
from .ruler import RulerEditing
from .selection import TimelineSelection
from .snapping import Snapper
from .thumbs import ThumbCache
from .tracks import TrackHeaders

MIN_PPS = 4.0
MAX_PPS = 2000.0


class TimelineCanvas(TimelineMouse, TimelineEditing, KeyEditing, RulerEditing, TrackHeaders, TimelineKeyboard,
                     TimelineMenus, TimelineDrops, TimelineClipboard, TimelineSelection, QWidget):
    scrollChanged = Signal()

    def __init__(self, editor, playback, parent=None):
        QWidget.__init__(self, parent)
        self.editor = editor
        self.playback = playback
        self.geo = TimelineGeometry()
        self.snapper = Snapper(self)
        self.peaks = None
        self._wave_cache = None
        self.drag = None
        self.sel_key = None           # (id du clip, id de l'effet, réglage, clé) : clé sélectionnée
        self.sel_marker = None        # id du repère sélectionné
        self.small_lanes = set()      # lignes réduites (affichage seulement)
        self.hover = {}               # {"box": id de clip, "row": id de piste, "ruler": x}
        self.ghost = None             # place visée mais occupée (contour rouge)
        self.drop_hint = None         # clip visé par un effet glissé, ou ligne de dépôt d'une forme
        self.inline = None            # champ de saisie posé sur un nom (piste, repère)
        self.paints = 0
        self.last_paint_ms = 0.0
        self._layout_rev = 0
        self._layout = None
        self.thumbs = ThumbCache(editor)
        self.thumbs.ready.connect(self.update)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAcceptDrops(True)
        self.setMinimumHeight(120)
        editor.timelineChanged.connect(self._changed)
        editor.docChanged.connect(self._doc_changed)
        editor.clipSelectionChanged.connect(self._selection_changed)
        editor.projectChanged.connect(self._changed)
        editor.playheadChanged.connect(self._playhead)
        editor.restored.connect(self._restored)
        theme.notifier.changed.connect(lambda _: (self.thumbs.clear(), self.update()))

    @property
    def tl(self):
        return self.editor.doc.timeline

    # ── Changements ──────────────────────────────────────────────────────
    def relayout(self):
        self._layout_rev += 1
        self._layout = None

    def _changed(self):
        self.relayout()
        self.clamp_scroll()
        self.scrollChanged.emit()
        self.update()

    def _doc_changed(self):
        self.relayout()
        self.update()

    def _selection_changed(self):
        k = self.sel_key
        if k is not None and k[0] not in self.editor.clip_selection:
            self.sel_key = None          # T4 : la clé d'un clip qui n'est plus sélectionné ne l'est plus
        self.update()

    def _restored(self):
        self.drag = None
        self.sel_key = None
        self.ghost = None
        self.snapper.clear()
        self._changed()

    def set_peaks(self, peaks):
        self.peaks = peaks
        self._wave_cache = None
        self._changed()

    def _playhead(self, t):
        if self.editor.playing:
            x = self.geo.x(t)
            span = (self.width() - HEADER_W) / self.geo.pps
            if x > self.width() - 30 or x < HEADER_W:
                self.geo.t0 = max(0.0, t - span * 0.1)
                self.scrollChanged.emit()
        self.update()

    # ── Disposition ──────────────────────────────────────────────────────
    def rows(self):
        g = self.geo
        g.has_wave = self.peaks is not None
        key = (self._layout_rev, g.t0, g.pps, g.scroll_y, g.top)
        if self._layout is None or self._layout[0] != key:
            small = self.small_lanes
            rows = g.layout(self.tl.tracks, lambda c: clip_lanes(self.editor, c, small))
            self._layout = (key, rows)
        return self._layout[1]

    def content_height(self):
        return self.geo.content_height(self.rows())

    def find_box(self, clip_id):
        for r in self.rows():
            for b in r.boxes:
                if b.clip.id == clip_id:
                    return b
        return None

    def clamp_scroll(self):
        """T8 : après un repli (moins de contenu), la vue ne reste pas dans le vide."""
        g = self.geo
        g.width, g.height = self.width(), self.height()
        max_y = max(0, self.content_height() - g.view_h())
        if g.scroll_y > max_y:
            g.scroll_y = int(max_y)
            self._layout = None
        max_t0 = max(0.0, self.tl.length() - (g.width - HEADER_W) / g.pps * 0.5)
        if g.t0 > max_t0:
            g.t0 = max_t0
            self._layout = None

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self.geo.width, self.geo.height = self.width(), self.height()
        self.clamp_scroll()
        self.scrollChanged.emit()

    # ── Défilement, zoom ─────────────────────────────────────────────────
    def zoom_at(self, factor, x):
        g = self.geo
        x = max(HEADER_W, x)
        t = g.t(x)
        g.pps = min(MAX_PPS, max(MIN_PPS, g.pps * factor))
        g.t0 = max(0.0, t - (x - HEADER_W) / g.pps)
        self.clamp_scroll()
        self.scrollChanged.emit()
        self.update()

    def zoom_to(self, a, b):
        """Montre l'intervalle [a, b] sur toute la largeur (marge de 4 %)."""
        g = self.geo
        span = max(0.05, b - a)
        w = max(50, self.width() - HEADER_W)
        g.pps = min(MAX_PPS, max(MIN_PPS, w / (span * 1.08)))
        g.t0 = max(0.0, a - span * 0.04)
        self.clamp_scroll()
        self.scrollChanged.emit()
        self.update()

    def zoom_fit(self, selection=True):
        """Z : la sélection de clips (s'il y en a), sinon tout le contenu."""
        sel = self.selected_clips() if selection else []
        if sel:
            self.zoom_to(min(c.start for _, c in sel), max(c.end for _, c in sel))
        else:
            self.zoom_to(0.0, max(self.tl.content_end(), self.tl.audio_duration, self.tl.bar_len * 4))

    def scroll_time(self, dx):
        if dx:
            self.geo.t0 = max(0.0, self.geo.t0 - dx / self.geo.pps)
            self.clamp_scroll()
            self.scrollChanged.emit()
            self.update()

    def scroll_by(self, dy):
        g = self.geo
        max_y = max(0, self.content_height() - g.view_h())
        g.scroll_y = int(min(max_y, max(0, g.scroll_y + dy)))
        self.scrollChanged.emit()
        self.update()

    def wheelEvent(self, e):
        """Molette : défilement vertical ; Maj : le temps ; Ctrl / Cmd : zoom. Pavé tactile : deux doigts
        = défilement dans les deux sens (le pincement zoome : event())."""
        mods = e.modifiers()
        pd, ad = e.pixelDelta(), e.angleDelta()
        trackpad = wheel_action(e.device().type() if e.device() else None, e.phase(),
                                Qt.KeyboardModifier.NoModifier) == "pan"
        if mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier):
            self.zoom_at(1.0015 ** (ad.y() or ad.x()), e.position().x())
        elif trackpad:
            d = pd if not pd.isNull() else ad / 2
            self.scroll_time(d.x())
            if d.y():
                self.scroll_by(-d.y())
        elif mods & Qt.KeyboardModifier.ShiftModifier:
            self.scroll_time((ad.y() or ad.x()) / 2)
        else:
            self.scroll_by(-(ad.y() or ad.x()) / 2)
        e.accept()

    def event(self, e):
        if e.type() == QEvent.Type.NativeGesture and e.gestureType() == Qt.NativeGestureType.ZoomNativeGesture:
            self.zoom_at(1.0 + e.value(), e.position().x())
            return True
        if e.type() == QEvent.Type.ShortcutOverride and self.override_shortcut(e):
            e.accept()
            return True
        return super().event(e)

    # ── Dessin ───────────────────────────────────────────────────────────
    def paintEvent(self, _e):
        t_start = time.perf_counter()
        g = self.geo
        g.width, g.height = self.width(), self.height()
        rows = self.rows()
        ed = self.editor
        p = QPainter(self)
        p.fillRect(self.rect(), theme.qc(theme.BG_APP))
        lines, _ = D.grid_lines(self.tl, *g.visible_range(), g.pps)
        self.thumbs.begin_paint()
        p.setClipRect(QRectF(HEADER_W, g.top, g.width - HEADER_W, g.height - g.top))
        D.draw_grid(p, g, lines, g.top, g.height)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        sel = set(ed.clip_selection)
        solo = any(tr.solo for tr in self.tl.tracks)
        dpr = self.devicePixelRatioF()
        lib = ed.doc.library
        hover = self.hover.get("box")
        uses = Counter(c.anim_id for _, c in self.tl.all_clips())      # animations partagées (chaîne)
        for r in rows:
            if r.y > g.height or r.y + r.h < g.top:
                continue                                     # culling vertical
            tr = r.track
            silent = tr.muted or (solo and not tr.solo)
            for b in r.boxes:
                if b.right < HEADER_W or b.x > g.width or b.y > g.height or b.y + b.h < g.top:
                    continue
                c = b.clip
                d = lib.get(c.def_id)
                st = ClipStyle(c.id in sel, silent, c.id == hover, uses[c.anim_id] > 1, tr.locked)
                draw_clip(p, g, b, tr.color, d.name if d else "?", st, self.thumbs.get, self.sel_key, dpr)
            p.fillRect(QRectF(HEADER_W, r.y + r.h - 1, g.width - HEADER_W, 1), theme.qc(theme.BORDER))
        self.draw_range(p)
        self.draw_rect(p)
        if self.ghost is not None:
            draw_ghost(p, *self.ghost)
        self.draw_drop_hint(p)
        self.draw_key_guides(p)
        p.setClipping(False)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        if self.peaks is not None:
            p.drawPixmap(0, 0, self._waveform_pixmap())
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        D.draw_ruler(p, g, self.tl, lines, D.marker_rects(p, g, self.tl), self.sel_marker, self.hover.get("ruler"))
        hover_row = next((r for r in rows if r.track.id == self.hover.get("row")), None)
        p.setClipRect(QRectF(0, g.top, HEADER_W, g.height - g.top))
        D.draw_headers(p, g, rows, solo, hover_row, self.track_drop_y())
        p.setClipping(False)
        D.draw_corner(p, g, self.peaks is not None)
        if self.snapper.line is not None and self.drag is not None:
            D.draw_snap_line(p, g, self.snapper.line)
        D.draw_playhead(p, g, ed.playhead)
        p.end()
        self.thumbs.end_paint()
        self.paints += 1
        self.last_paint_ms = (time.perf_counter() - t_start) * 1000.0

    def _waveform_pixmap(self):
        g = self.geo
        key = (round(g.t0, 5), round(g.pps, 5), g.width, id(self.peaks), theme.CURRENT)
        if self._wave_cache is None or self._wave_cache[0] != key:
            pm = QPixmap(self.size())
            pm.fill(Qt.GlobalColor.transparent)
            p = QPainter(pm)
            D.draw_waveform(p, g, self.peaks, PEAKS_PER_S)
            p.end()
            self._wave_cache = (key, pm)
        return self._wave_cache[1]

    def schedule(self, fn, ms=0):
        QTimer.singleShot(ms, fn)

    def ruler_contains(self, y):
        return y < RULER_H
