"""Timeline : sélection d'une zone de temps (Cmd/Ctrl + glisser) et copier / couper / coller des clips.

La copie garde la longueur de la zone (le vide compris) : coller la pose à la tête de lecture, puis la tête
avance de cette longueur — Cmd/Ctrl + V plusieurs fois enchaîne les copies avec le même écart.
"""

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QPen

from .. import theme
from .geometry import HEADER_W

EPS = 1e-6


def range_modifier(mods):
    return bool(mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier))


class TimelineClipboard:
    range_sel = None     # (début, fin) de la zone de temps sélectionnée

    def start_range(self, x, mods):
        t = max(0.0, self.snap(self.geo.t(x), mods))
        self.range_sel = (t, t)
        self.drag = {"kind": "range", "t0": t}
        self.update()

    def drag_range(self, x, mods):
        t = max(0.0, self.snap(self.geo.t(x), mods))
        a = self.drag["t0"]
        self.range_sel = (min(a, t), max(a, t))
        self.update()

    def end_range(self):
        if self.range_sel and self.range_sel[1] - self.range_sel[0] < EPS:
            self.range_sel = None
        if self.range_sel:
            n = len(self.clips_in_range())
            self.editor.statusMessage.emit(
                f"Zone de {self.range_sel[1] - self.range_sel[0]:.3f} s · {n} clip(s) — Cmd/Ctrl + C pour copier")
        self.update()

    def clear_range(self):
        if self.range_sel is not None:
            self.range_sel = None
            self.update()

    def clips_in_range(self):
        if not self.range_sel:
            return []
        a, b = self.range_sel
        return [(tr, c) for tr, c in self.tl.all_clips() if a - EPS <= c.start < b - EPS]

    def _selection(self):
        """(clips, début, longueur) à copier : la zone de temps, sinon le clip sélectionné."""
        if self.range_sel:
            a, b = self.range_sel
            return self.clips_in_range(), a, b - a
        clip = self.editor.current_clip()
        if clip is not None:
            tr, _ = self.tl.find_clip(clip.id)
            return [(tr, clip)], clip.start, clip.duration
        return None

    def copy_clips(self):
        sel = self._selection()
        if sel is None:
            return False
        self.editor.copy_clips(*sel)
        return True

    def cut_clips(self):
        sel = self._selection()
        if sel is None:
            return False
        self.editor.copy_clips(*sel)
        self.editor.delete_clips(sel[0], "Couper")
        return True

    def paste_clips(self):
        res = self.editor.paste_clips(self.editor.playhead)
        if res is None:
            return False
        a, b, clips = res
        if self.range_sel is not None:
            self.range_sel = (a, b)        # la zone suit : on peut recopier ce qu'on vient de coller
        self.update()
        return True

    def draw_range(self, p):
        if not self.range_sel:
            return
        g = self.geo
        a, b = self.range_sel
        x0, x1 = max(HEADER_W, g.x(a)), min(g.width, g.x(b))
        if x1 <= x0:
            return
        p.fillRect(QRectF(x0, g.top, x1 - x0, g.height - g.top), theme.qc(theme.ACCENT, 0.12))
        p.setPen(QPen(theme.qc(theme.ACCENT, 0.8), 1))
        for x in (g.x(a), g.x(b)):
            if HEADER_W <= x <= g.width:
                p.drawLine(QPointF(x, g.top), QPointF(x, g.height))
