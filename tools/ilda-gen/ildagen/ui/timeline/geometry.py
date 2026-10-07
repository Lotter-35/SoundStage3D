"""Géométrie de la timeline : lignes (pistes, modifieurs, automations), correspondance temps ↔ pixels."""

HEADER_W = 190
RULER_H = 28
LOOP_H = 8
WAVE_H = 46
TRACK_H = 58
GROUP_H = 24
LANE_H = 48
LANE_SMALL_H = 20     # ligne réduite (réglage pas utilisé, ou repliée à la main)
CLIP_EDGE = 6
CHEVRON_W = 16


class Row:
    __slots__ = ("kind", "track", "clip", "auto", "y", "h", "node", "label", "small", "used", "slot")

    def __init__(self, kind, track, clip, auto, y, h, node=None, label="", small=False, used=True):
        self.kind = kind      # "track", "group" (un modifieur du clip) ou "lane" (un réglage animable)
        self.track = track
        self.clip = clip
        self.auto = auto      # automation (éventuellement « virtuelle » : pas encore dans le clip)
        self.y = y
        self.h = h
        self.node = node
        self.label = label
        self.small = small    # ligne de réglage réduite
        self.used = used      # réglage utilisé (sinon grisé)
        self.slot = [self]    # lignes des autres clips de la piste posées à la même hauteur

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
    mod_ids = set()
    if d is not None:
        for m in d.root.walk():
            if m.kind != "modifier" or m.modifier is None:
                continue
            mod_ids.add(m.id)
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
        # Réglages d'un modifieur replié : cachés avec lui
        if (a.node_id, a.key) not in shown and a.node_id not in mod_ids:
            out.append(("lane", a, None, ""))
    return out


LABEL_H = 14   # bande du nom d'un réglage, en haut de sa ligne (dans le clip)


def lane_toggle_rect(geo, row):
    """Flèche avant le nom d'un réglage (dans le clip) : réduire / agrandir la ligne."""
    x = max(HEADER_W, geo.x(row.clip.start)) + 3
    return (x, row.y + 1, 12, min(LABEL_H, row.h - 2))


def lane_reset_rect(geo, row):
    """Bouton ↺ en haut à droite de la ligne, dans le clip."""
    x = geo.x(row.clip.end) - 3 - 13
    return (x, row.y + 1, 13, min(LABEL_H, row.h - 2))


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
            # Clips dépliés de la piste : leurs lignes sont posées côte à côte (même hauteur pour la
            # même position), chacune dans la plage de temps de son clip — pas d'empilement en escalier
            from . import lanes as L
            expanded = [(c, clip_rows(c, editor.doc.library, editor))
                        for c in sorted(tr.clips, key=lambda c: c.start) if c.expanded]
            n = max((len(e) for _, e in expanded), default=0)
            for i in range(n):
                slot = []
                for clip, entries in expanded:
                    if i >= len(entries):
                        continue
                    kind, auto, node, label = entries[i]
                    if kind == "group":
                        slot.append(Row(kind, tr, clip, auto, y, GROUP_H, node, label))
                    else:
                        slot.append(Row(kind, tr, clip, auto, y, LANE_H, node, label,
                                        L.is_small(editor, clip, auto), L.assigned(editor, clip, auto)))
                lanes_ = [r for r in slot if r.kind == "lane"]
                small = bool(lanes_) and len(lanes_) == len(slot) and all(r.small for r in lanes_)
                h = LANE_SMALL_H if small else (LANE_H if lanes_ else GROUP_H)
                for r in slot:
                    r.h, r.slot = h, slot
                    if r.kind == "lane":
                        r.small = small
                out.extend(slot)
                y += h
        return out

    def content_height(self, editor):
        rows = self.rows(editor, scroll=False)
        return (rows[-1].y + rows[-1].h - self.top) if rows else 0

    def row_at(self, rows, y, x=None):
        """Ligne sous (x, y). Plusieurs clips à la même hauteur : celle du clip sous x (ou le plus proche)."""
        if y < self.top:
            return None
        hits = [r for r in rows if r.contains(y)]
        if len(hits) <= 1 or x is None or x < HEADER_W:
            return hits[0] if hits else None

        def dist(r):
            a, b = self.x(r.clip.start), self.x(r.clip.end)
            return 0.0 if a - 6 <= x <= b + 6 else min(abs(x - a), abs(x - b))
        return min(hits, key=dist)

    def clip_rect(self, row, clip):
        return (self.x(clip.start), row.y + 3, max(4.0, clip.duration * self.pps), row.h - 6)
