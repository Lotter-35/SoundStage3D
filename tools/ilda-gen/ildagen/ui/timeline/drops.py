"""Glisser-déposer dans la timeline :
- une forme (bibliothèque de Show ou liste des formes) : un clip à l'endroit visé (place occupée : juste après ;
  sous les pistes : nouvelle piste) ;
- un effet (bibliothèque de Show) : posé sur le clip visé (contour accent pendant le survol)."""

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QPen

from ...core import placement as P
from .. import theme
from ..canvas.view import DEF_MIME
from .geometry import CLIP_HEAD, CLIP_PAD, HEADER_W, STRIP_H

EFFECT_MIME = "application/x-ildagen-effect"


def mime_text(md, fmt):
    return bytes(md.data(fmt)).decode("utf-8")


class TimelineDrops:
    def _drop_target(self, pos):
        """(piste ou None = nouvelle piste, début) d'une forme déposée en pos."""
        g = self.geo
        rows = self.rows()
        row = g.row_at(rows, pos.y())
        t = max(0.0, self.snapper.snap(g.t(max(HEADER_W, pos.x())), Qt.KeyboardModifier.NoModifier))
        self.snapper.clear()
        if row is None:
            return None, t
        return row.track, P.place_after(row.track, t, self.tl.bar_len)

    def _accepts(self, md):
        return md.hasFormat(DEF_MIME) or md.hasFormat(EFFECT_MIME)

    def dragEnterEvent(self, e):
        if self._accepts(e.mimeData()):
            e.acceptProposedAction()

    def dragMoveEvent(self, e):
        md = e.mimeData()
        pos = e.position()
        hint = None
        ok = False
        if md.hasFormat(EFFECT_MIME):
            _, b, _, _ = self.hit(pos.x(), pos.y())
            if b is not None:
                hint, ok = ("effect", b.clip.id), True
        elif md.hasFormat(DEF_MIME):
            tr, t = self._drop_target(pos)
            ok = tr is None or not tr.locked
            if ok and pos.y() >= self.geo.top:
                hint = ("def", tr.id if tr is not None else None, t)
        if hint != self.drop_hint:
            self.drop_hint = hint
            self.update()
        if ok:
            e.acceptProposedAction()
        else:
            e.ignore()

    def dragLeaveEvent(self, e):
        self.drop_hint = None
        self.update()

    def dropEvent(self, e):
        md = e.mimeData()
        pos = e.position()
        self.drop_hint = None
        ed = self.editor
        if md.hasFormat(EFFECT_MIME):
            _, b, _, _ = self.hit(pos.x(), pos.y())
            if b is None:
                e.ignore()
                return
            if self.add_effect_to(b.clip, mime_text(md, EFFECT_MIME)) is not None:
                e.acceptProposedAction()
            self.update()
            return
        if not md.hasFormat(DEF_MIME):
            return
        def_id = mime_text(md, DEF_MIME)
        if ed.doc.library.get(def_id) is None:
            return
        tr, t = self._drop_target(pos)
        if tr is not None and tr.locked:
            ed.statusMessage.emit("Piste verrouillée : déposez la forme sur une autre piste")
            e.ignore()
            return
        if tr is None:
            tr = ed.add_track()
        clip = ed.add_clip(def_id, tr.id, t)
        ed.select_clip(clip.id)
        self.setFocus()
        e.acceptProposedAction()

    def draw_drop_hint(self, p):
        h = self.drop_hint
        if h is None:
            return
        g = self.geo
        pen = QPen(theme.qc(theme.ACCENT), 1.5, Qt.PenStyle.DashLine)
        pen.setDashPattern([3, 2])
        p.setPen(pen)
        p.setBrush(Qt.BrushStyle.NoBrush)
        if h[0] == "effect":
            b = self.find_box(h[1])
            if b is not None:
                p.drawRoundedRect(QRectF(b.x - 1, b.y - 1, b.w + 2, b.h + 2), 3, 3)
            return
        _, tid, t = h
        rows = self.rows()
        row = next((r for r in rows if r.track.id == tid), None)
        y = row.y + CLIP_PAD if row is not None else (rows[-1].y + rows[-1].h + CLIP_PAD if rows else g.top + 5)
        p.drawRoundedRect(QRectF(g.x(t), y, self.tl.bar_len * g.pps, CLIP_HEAD + STRIP_H), 3, 3)
