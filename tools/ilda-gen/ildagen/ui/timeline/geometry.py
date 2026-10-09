"""Géométrie de la timeline : hauteur des pistes (le clip le plus haut de la piste), boîte de chaque clip
(en-tête, bande de vignettes, lignes des réglages en courbe quand il est déplié), correspondance temps ↔ pixels
et zones sensibles d'un clip (chevron, bords, poignées de fondu, lignes, clés).

Repérage d'un clip (T1) : un clip qui contient strictement x passe avant un voisin dont le bord est proche.
Bords (T9) : jamais plus d'un quart de la largeur du clip, un clip étroit reste déplaçable.
"""

HEADER_W = 132        # colonne des pistes
RULER_H = 26          # règle : numéros de mesure, repères, barre de boucle en bas
LOOP_H = 4            # barre de boucle
WAVE_H = 34           # ligne de la musique
CLIP_PAD = 5          # marge au-dessus des clips dans leur piste
CLIP_HEAD = 19        # en-tête du clip (nom, chaîne)
STRIP_H = 34          # bande de vignettes
LANE_H = 40           # ligne d'un réglage en courbe
LANE_SMALL_H = 18     # ligne réduite
LANE_LABEL_H = 14     # bande du nom du réglage (la courbe passe dessous)
TRACK_MIN_H = CLIP_PAD + CLIP_HEAD + STRIP_H + 6
CLIP_EDGE = 6
CHEVRON_W = 14
FADE_GRAB = 6         # demi-largeur de la zone de prise d'une poignée de fondu
KEY_GRAB = 6


class Lane:
    """Ligne d'un réglage d'effet en mode « Courbe » sous un clip déplié."""
    __slots__ = ("effect", "key", "spec", "label", "small", "y", "h")

    def __init__(self, effect, key, spec, label, small=False):
        self.effect = effect
        self.key = key
        self.spec = spec
        self.label = label
        self.small = small
        self.y = 0.0
        self.h = LANE_SMALL_H if small else LANE_H

    @property
    def track(self):
        return self.effect.params.get(self.key)

    def ident(self, clip):
        return (clip.id, self.effect.id, self.key)


class Box:
    """Rectangle d'un clip à l'écran (x, y, largeur, hauteur) et ses lignes."""
    __slots__ = ("clip", "row", "x", "y", "w", "h", "lanes", "foldable")

    def __init__(self, clip, row, x, y, w, lanes, foldable):
        self.clip = clip
        self.row = row
        self.x, self.y, self.w = x, y, w
        self.lanes = lanes
        self.foldable = foldable           # a des réglages en courbe : chevron dans l'en-tête
        ly = y + CLIP_HEAD + STRIP_H
        for ln in lanes:
            ln.y = ly
            ly += ln.h
        self.h = ly - y

    @property
    def right(self):
        return self.x + self.w

    @property
    def strip_top(self):
        return self.y + CLIP_HEAD

    @property
    def lanes_top(self):
        return self.y + CLIP_HEAD + STRIP_H

    def contains(self, x, y):
        return self.x <= x < self.right and self.y <= y < self.y + self.h


class Row:
    """Une piste : sa hauteur suit son clip le plus haut."""
    __slots__ = ("kind", "track", "clip", "y", "h", "boxes", "index")

    def __init__(self, track, y, h, index):
        self.kind = "track"
        self.track = track
        self.clip = None
        self.y = y
        self.h = h
        self.boxes = []
        self.index = index

    def contains(self, y):
        return self.y <= y < self.y + self.h


def edge_width(w):
    """Largeur de la zone d'un bord : jamais plus du quart d'un clip étroit (il reste déplaçable)."""
    return min(CLIP_EDGE, max(2.0, w * 0.25))


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
        """Haut de la zone des pistes (sous la règle et la ligne de la musique)."""
        return RULER_H + (WAVE_H if self.has_wave else 0)

    def x(self, t):
        return HEADER_W + (t - self.t0) * self.pps

    def t(self, x):
        return self.t0 + (x - HEADER_W) / self.pps

    def visible_range(self):
        return self.t0, self.t(self.width)

    def view_h(self):
        return max(1, self.height - self.top)

    # ── Pistes et clips ──────────────────────────────────────────────────
    def layout(self, tracks, lanes_of, scroll=True):
        """[Row] avec la boîte de chaque clip. lanes_of(clip) → ([Lane], repliable)."""
        y = self.top - (self.scroll_y if scroll else 0)
        rows = []
        for i, tr in enumerate(tracks):
            row = Row(tr, y, TRACK_MIN_H, i)
            h = TRACK_MIN_H
            for c in tr.clips:
                lanes, foldable = lanes_of(c)
                b = Box(c, row, self.x(c.start), y + CLIP_PAD, max(4.0, c.duration * self.pps), lanes, foldable)
                row.boxes.append(b)
                h = max(h, b.h + CLIP_PAD + 6)
            row.boxes.sort(key=lambda b: b.clip.start)
            row.h = h
            rows.append(row)
            y += h
        return rows

    @staticmethod
    def content_height(rows):
        """Hauteur de toutes les pistes (T7 : chaque piste a sa propre hauteur)."""
        return sum(r.h for r in rows)

    def row_at(self, rows, y, x=None):
        if y < self.top:
            return None
        return next((r for r in rows if r.contains(y)), None)

    @staticmethod
    def box_at(row, x, y):
        """Boîte du clip sous (x, y) : celui qui contient strictement x d'abord, sinon un bord à 3 px près."""
        near = None
        for b in row.boxes:
            if not (b.y <= y < b.y + b.h):
                continue
            if b.x <= x < b.right:
                return b
            if b.x - 3 <= x <= b.right + 3 and near is None:
                near = b
        return near

    def clip_rect(self, row, clip):
        """(x, y, largeur, hauteur) d'un clip (compatibilité)."""
        b = next((b for b in row.boxes if b.clip is clip), None)
        if b is None:
            return (self.x(clip.start), row.y + CLIP_PAD, max(4.0, clip.duration * self.pps), CLIP_HEAD + STRIP_H)
        return (b.x, b.y, b.w, b.h)

    # ── Zones d'un clip ──────────────────────────────────────────────────
    def chevron_rect(self, b):
        x = max(b.x, HEADER_W) + 3
        return (x, b.y + 2, CHEVRON_W, CLIP_HEAD - 4)

    def label_x(self, b):
        """Début du nom du clip : reste visible quand le début du clip sort à gauche (T13)."""
        x = max(b.x, HEADER_W) + 6
        return x + CHEVRON_W if b.foldable else x

    def fade_handles(self, b):
        """Positions x des poignées de fondu (entrée, sortie), en haut de la bande de vignettes."""
        c = b.clip
        k = b.w / c.duration if c.duration > 1e-9 else 0.0
        return b.x + max(c.fade_in * k, 5.0), b.right - max(c.fade_out * k, 5.0)

    def zone(self, b, x, y):
        """Partie du clip sous (x, y) : chevron, left, right, fade_in, fade_out, body, lane (avec la ligne)."""
        e = edge_width(b.w)
        if y < b.strip_top:
            if b.foldable:
                cx, cy, cw, ch = self.chevron_rect(b)
                if cx - 2 <= x <= cx + cw and b.w > CHEVRON_W + 2 * e:
                    return "chevron", None
        elif y < b.lanes_top:
            if b.w >= 24 and y <= b.strip_top + 9:
                fi, fo = self.fade_handles(b)
                if abs(x - fi) <= FADE_GRAB and abs(x - fi) <= abs(x - fo):
                    return "fade_in", None
                if abs(x - fo) <= FADE_GRAB:
                    return "fade_out", None
        if x < b.x + e:
            return "left", None
        if x >= b.right - e:
            return "right", None
        if y >= b.lanes_top:
            lane = next((ln for ln in b.lanes if ln.y <= y < ln.y + ln.h), None)
            if lane is not None:
                return "lane", lane
        return "body", None
