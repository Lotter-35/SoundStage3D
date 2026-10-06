"""Géométrie de la timeline : lignes (pistes, automations), correspondance temps ↔ pixels."""

HEADER_W = 170
RULER_H = 28
LOOP_H = 8
WAVE_H = 46
TRACK_H = 38
LANE_H = 56
CLIP_EDGE = 6
CHEVRON_W = 16


class Row:
    __slots__ = ("kind", "track", "clip", "auto", "y", "h")

    def __init__(self, kind, track, clip, auto, y, h):
        self.kind = kind      # "track" ou "lane"
        self.track = track
        self.clip = clip
        self.auto = auto
        self.y = y
        self.h = h

    def contains(self, y):
        return self.y <= y < self.y + self.h


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

    def rows(self, timeline):
        out = []
        y = self.top - self.scroll_y
        for tr in timeline.tracks:
            out.append(Row("track", tr, None, None, y, TRACK_H))
            y += TRACK_H
            for clip in sorted(tr.clips, key=lambda c: c.start):
                if clip.expanded:
                    for a in clip.automations:
                        out.append(Row("lane", tr, clip, a, y, LANE_H))
                        y += LANE_H
        return out

    def content_height(self, timeline):
        h = 0
        for tr in timeline.tracks:
            h += TRACK_H
            for clip in tr.clips:
                if clip.expanded:
                    h += LANE_H * len(clip.automations)
        return h

    def row_at(self, rows, y):
        if y < self.top:
            return None
        return next((r for r in rows if r.contains(y)), None)

    def clip_rect(self, row, clip):
        return (self.x(clip.start), row.y + 3, max(4.0, clip.duration * self.pps), row.h - 6)
