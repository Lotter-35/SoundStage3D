"""Timeline : sélection de plusieurs clips (rectangle de sélection, Maj + clic) et déplacement en bloc."""

from PySide6.QtCore import QRectF
from PySide6.QtGui import QPen

from .. import theme
from .geometry import HEADER_W

DRAG_START = 4    # pixels avant qu'un clic dans le vide devienne un rectangle de sélection


class TimelineSelection:
    sel_clips = frozenset()    # identifiants des clips sélectionnés

    def selected_clips(self):
        """[(piste, clip)] sélectionnés (dans l'ordre du temps)."""
        out = [(tr, c) for tr, c in self.tl.all_clips() if c.id in self.sel_clips]
        return sorted(out, key=lambda tc: tc[1].start)

    def set_clip_selection(self, ids):
        self.sel_clips = frozenset(ids)
        self.update()

    def toggle_clip(self, clip):
        self.set_clip_selection(self.sel_clips ^ {clip.id})

    def select_all_clips(self):
        self.set_clip_selection(c.id for _, c in self.tl.all_clips())
        n = len(self.sel_clips)
        self.editor.statusMessage.emit(f"{n} clip(s) sélectionné(s)")

    def duplicate_clips(self):
        """Cmd/Ctrl + D : la sélection (ou la zone) est recopiée juste après elle-même."""
        sel = self._selection()
        if sel is None or not sel[0]:
            return False
        clips, start, length = sel
        self.editor.copy_clips(clips, start, length)
        res = self.editor.paste_clips(start + length)
        if res is not None:
            a, b, new = res
            if self.range_sel is not None:
                self.range_sel = (a, b)
            self.set_clip_selection(c.id for c in new)
        return True

    # ── Rectangle de sélection ───────────────────────────────────────────
    def start_rect(self, x, y, add):
        self.drag = {"kind": "rect", "x0": x, "y0": y, "x1": x, "y1": y, "moved": False,
                     "base": self.sel_clips if add else frozenset()}

    def drag_rect(self, x, y):
        d = self.drag
        d["x1"], d["y1"] = x, y
        if not d["moved"] and abs(x - d["x0"]) < DRAG_START and abs(y - d["y0"]) < DRAG_START:
            return
        d["moved"] = True
        r = self._rect(d)
        hits = set()
        for row in self.rows():
            if row.kind != "track":
                continue
            for c in row.track.clips:
                cx, cy, cw, ch = self.geo.clip_rect(row, c)
                if r.intersects(QRectF(cx, cy, cw, ch)):
                    hits.add(c.id)
        self.set_clip_selection(d["base"] | hits)

    @staticmethod
    def _rect(d):
        return QRectF(min(d["x0"], d["x1"]), min(d["y0"], d["y1"]),
                      abs(d["x1"] - d["x0"]), abs(d["y1"] - d["y0"]))

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
            self._click_empty(d["x0"], e)
            return
        n = len(self.sel_clips)
        if n:
            self.editor.statusMessage.emit(f"{n} clip(s) sélectionné(s) — glisser pour les déplacer, "
                                           "Ctrl+C / Ctrl+V, Suppr")
