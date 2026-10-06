"""Géométrie de la timeline : lignes (pistes, modifieurs, automations), correspondance temps ↔ pixels."""

HEADER_W = 190
RULER_H = 28
LOOP_H = 8
WAVE_H = 46
TRACK_H = 58
GROUP_H = 24
LANE_H = 48
CLIP_EDGE = 6
CHEVRON_W = 16


class Row:
    __slots__ = ("kind", "track", "clip", "auto", "y", "h", "node", "label")

    def __init__(self, kind, track, clip, auto, y, h, node=None, label=""):
        self.kind = kind      # "track", "group" (un modifieur du clip) ou "lane" (un réglage animable)
        self.track = track
        self.clip = clip
        self.auto = auto      # automation (éventuellement « virtuelle » : pas encore dans le clip)
        self.y = y
        self.h = h
        self.node = node
        self.label = label

    def contains(self, y):
        return self.y <= y < self.y + self.h

    @property
    def virtual(self):
        return self.kind == "lane" and self.auto not in self.clip.automations


def modifier_specs(node):
    """Réglages animables d'un modifieur (avec « Actif » en premier)."""
    from ..properties.forms import ACTIVE_SPEC
    return [ACTIVE_SPEC] + [s for s in node.modifier.all_params() if s.animatable]


def clip_rows(clip, library, editor):
    """Lignes sous un clip déplié : chaque modifieur de la forme, ses réglages s'il est ouvert,
    puis les autres automations (position de formes, automation en attente…)."""
    from ...core.automation import Automation
    out = []
    d = library.get(clip.def_id)
    shown = set()
    if d is not None:
        for m in d.root.walk():
            if m.kind != "modifier" or m.modifier is None:
                continue
            out.append(("group", None, m, m.name))
            if m.id not in clip.closed_nodes:
                for spec in modifier_specs(m):
                    a = clip.automation_for(m.id, spec.key)
                    if a is None:
                        a = Automation()
                        a.bind(m.id, spec.key, f"{m.name} › {spec.label}", editor.param_is_discrete(m, spec.key))
                    out.append(("lane", a, m, spec.label))
                    shown.add((m.id, spec.key))
    for a in clip.automations:
        if (a.node_id, a.key) not in shown:
            out.append(("lane", a, None, ""))
    return out


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
        tl = editor.doc.timeline
        out = []
        y = self.top - (self.scroll_y if scroll else 0)
        for tr in tl.tracks:
            out.append(Row("track", tr, None, None, y, TRACK_H))
            y += TRACK_H
            for clip in sorted(tr.clips, key=lambda c: c.start):
                if not clip.expanded:
                    continue
                for kind, auto, node, label in clip_rows(clip, editor.doc.library, editor):
                    h = GROUP_H if kind == "group" else LANE_H
                    out.append(Row(kind, tr, clip, auto, y, h, node, label))
                    y += h
        return out

    def content_height(self, editor):
        rows = self.rows(editor, scroll=False)
        return (rows[-1].y + rows[-1].h - self.top) if rows else 0

    def row_at(self, rows, y):
        if y < self.top:
            return None
        return next((r for r in rows if r.contains(y)), None)

    def clip_rect(self, row, clip):
        return (self.x(clip.start), row.y + 3, max(4.0, clip.duration * self.pps), row.h - 6)
