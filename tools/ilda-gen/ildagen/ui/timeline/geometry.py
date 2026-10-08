"""Géométrie de la timeline : lignes des pistes, correspondance temps ↔ pixels."""

HEADER_W = 190
RULER_H = 28
LOOP_H = 8
WAVE_H = 46
TRACK_H = 58
CLIP_EDGE = 6


class Row:
    __slots__ = ("kind", "track", "clip", "y", "h")

    def __init__(self, kind, track, clip, y, h):
        self.kind = kind      # "track" (une piste et ses clips)
        self.track = track
        self.clip = clip
        self.y = y
        self.h = h

    def contains(self, y):
        return self.y <= y < self.y + self.h


def track_blocks(rows):
    """{id de piste: (haut, bas)}."""
    return {r.track.id: (r.y, r.y + r.h) for r in rows}


def link_icon_rect(geo, row, clip):
    """Icône de lien (chaîne) en haut à droite d'un clip."""
    x, y, w, _ = geo.clip_rect(row, clip)
    return (x + w - 18, y + 1, 14, 14)


class TimelineGeometry:
    def __init__(self):
        self.pps = 60.0       # pixels par seconde
        self.t0 = 0.0         # temps au bord gauche de la zone des clips
        self.scroll_y = 0
        self.width = 100
        self.height = 100
        self.has_wave = False

    @property
    def top(self):
        """Haut de la zone des pistes (sous la règle et la forme d'onde)."""
        return RULER_H + (WAVE_H if self.has_wave else 0)

    def x(self, t):
        return HEADER_W + (t - self.t0) * self.pps

    def t(self, x):
        return self.t0 + (x - HEADER_W) / self.pps

    def visible_range(self):
        return self.t0, self.t(self.width)

    def rows(self, editor, scroll=True):
        y = self.top - (self.scroll_y if scroll else 0)
        out = []
        for tr in editor.doc.timeline.tracks:
            out.append(Row("track", tr, None, y, TRACK_H))
            y += TRACK_H
        return out

    def content_height(self, editor):
        return len(editor.doc.timeline.tracks) * TRACK_H

    def row_at(self, rows, y, x=None):
        """Ligne (piste) sous y."""
        if y < self.top:
            return None
        return next((r for r in rows if r.contains(y)), None)

    def clip_rect(self, row, clip):
        return (self.x(clip.start), row.y + 3, max(4.0, clip.duration * self.pps), row.h - 6)
