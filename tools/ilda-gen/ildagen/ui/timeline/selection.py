"""Timeline : sélection de plusieurs clips (rectangle de sélection, Maj / Cmd + clic), Dupliquer.

Un seul modèle de sélection : celui de l'éditeur (clip_selection ; le clip actif en fait toujours partie)."""

from PySide6.QtCore import QRectF
from PySide6.QtGui import QPen

from .. import theme
from .geometry import HEADER_W

DRAG_START = 4    # pixels avant qu'un clic dans le vide devienne un rectangle de sélection


class TimelineSelection:
    @property
    def sel_clips(self):
        """Identifiants des clips sélectionnés."""
        return frozenset(self.editor.clip_selection)

    def selected_clips(self):
        """[(piste, clip)] sélectionnés (dans l'ordre du temps)."""
        return self.editor.selected_clip_items()

    def set_clip_selection(self, ids):
        self.editor.select_clips(list(ids))
        self.update()

    def toggle_clip(self, clip):
        self.set_clip_selection([i for i in self.editor.clip_selection if i != clip.id]
                                if clip.id in self.sel_clips else list(self.editor.clip_selection) + [clip.id])
        if clip.id in self.sel_clips:
            self.editor.select_clips(self.editor.clip_selection, clip.id)

    def select_all_clips(self):
        self.set_clip_selection(c.id for _, c in self.tl.all_clips())
        self.editor.statusMessage.emit(f"{len(self.sel_clips)} clip(s) sélectionné(s)")

    def duplicate_clips(self):
        """Ctrl+D et menu Dupliquer (T10) : la sélection (ou la zone) recopiée juste après elle-même, les
        copies sélectionnées ; la tête de lecture ne bouge pas."""
        sel = self._selection()
        if sel is None or not sel[0]:
            return False
        clips, start, length = sel
        self.editor.copy_clips(clips, start, length)
        res = self.editor.paste_clips(start + length, move_playhead=False)
        if res is not None:
            a, b, new = res
            if self.range_sel is not None:
                self.range_sel = (a, b)
            self.set_clip_selection(c.id for c in new)
        return True

    # ── Rectangle de sélection ───────────────────────────────────────────
    def start_rect(self, x, y, add):
        self.sel_marker = None
        self.drag = {"kind": "rect", "x0": x, "y0": y, "x1": x, "y1": y, "moved": False,
                     "base": self.sel_clips if add else frozenset()}

    def drag_rect(self, x, y):
        d = self.drag
        d["x1"], d["y1"] = x, y
        if not d["moved"] and abs(x - d["x0"]) < DRAG_START and abs(y - d["y0"]) < DRAG_START:
            return
        d["moved"] = True
        r = self._rect(d)
        hits = {b.clip.id for row in self.rows() for b in row.boxes if r.intersects(QRectF(b.x, b.y, b.w, b.h))}
        self.set_clip_selection(list(d["base"]) + [i for i in hits if i not in d["base"]])

    @staticmethod
    def _rect(d):
        return QRectF(min(d["x0"], d["x1"]), min(d["y0"], d["y1"]), abs(d["x1"] - d["x0"]), abs(d["y1"] - d["y0"]))

    def draw_rect(self, p):
        d = self.drag
        if not d or d.get("kind") != "rect" or not d["moved"]:
            return
        r = self._rect(d)
        r.setLeft(max(HEADER_W, r.left()))
        p.fillRect(r, theme.qc(theme.ACCENT, 0.10))
        p.setPen(QPen(theme.qc(theme.ACCENT, 0.9), 1))
        p.drawRect(r)

    def end_rect(self, e):
        """Relâché sans avoir bougé : simple clic dans le vide (désélectionne, place la tête de lecture)."""
        d = self.drag
        if not d["moved"]:
            if not d["base"]:
                self.set_clip_selection(())
            self.playback.seek(max(0.0, self.snapper.snap(self.geo.t(d["x0"]), e.modifiers())))
            self.snapper.clear()
            return
        n = len(self.sel_clips)
        if n:
            self.editor.statusMessage.emit(f"{n} clip(s) sélectionné(s) — glisser pour les déplacer, "
                                           "flèches, Ctrl+C / Ctrl+V, Suppr")
