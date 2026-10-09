"""Aimant de la timeline : les bords des autres clips, les repères, la tête de lecture et la boucle attirent
(à SNAP_PX près, ligne visible), sinon la grille musicale. Aimant coupé (bouton) ou Alt : aucun accrochage."""

from PySide6.QtCore import Qt

SNAP_PX = 8


class Snapper:
    def __init__(self, canvas):
        self.canvas = canvas
        self.line = None              # instant accroché à montrer (ligne pointillée), ou None

    @property
    def tl(self):
        return self.canvas.editor.doc.timeline

    def active(self, mods):
        return self.tl.snap and not (mods & Qt.KeyboardModifier.AltModifier)

    def targets(self, exclude=(), skip_marker=None):
        """Instants qui attirent : bords des clips (sauf ceux d'exclude), repères (sauf skip_marker), tête de
        lecture, boucle."""
        ex = set(exclude)
        tl = self.tl
        out = [self.canvas.editor.playhead]
        for _, c in tl.all_clips():
            if c.id not in ex:
                out += (c.start, c.end)
        out += [m.t for m in tl.markers if m.id != skip_marker]
        if tl.loop_end > tl.loop_start:
            out += (tl.loop_start, tl.loop_end)
        return out

    def _nearest(self, times, targets):
        """(écart, cible) le plus petit entre un des instants et une cible, à SNAP_PX près."""
        tol = SNAP_PX / max(1e-9, self.canvas.geo.pps)
        best = None
        for t in times:
            for g in targets:
                d = g - t
                if abs(d) <= tol and (best is None or abs(d) < abs(best[0])):
                    best = (d, g)
        return best

    def snap(self, t, mods, exclude=(), objects=True, skip_marker=None):
        """Instant aimanté (un bord, une clé, un repère…)."""
        self.line = None
        if not self.active(mods):
            return t
        if objects:
            hit = self._nearest((t,), self.targets(exclude, skip_marker))
            if hit is not None:
                self.line = hit[1]
                return hit[1]
        return self.tl.snap_time(t, force=True)

    def snap_span(self, start, duration, mods, exclude=()):
        """Début aimanté d'un clip déplacé : son début ou sa fin accroche, sinon son début sur la grille."""
        self.line = None
        if not self.active(mods):
            return start
        hit = self._nearest((start, start + duration), self.targets(exclude))
        if hit is not None:
            self.line = hit[1]
            return start + hit[0]
        return self.tl.snap_time(start, force=True)

    def clear(self):
        self.line = None
