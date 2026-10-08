"""Maîtres : réglages qui agissent sur toute la sortie (et les aperçus) — lumière, taille, vitesse, position,
rotation, couleur forcée. État d'affichage : hors annulation, enregistré avec le projet.

La vitesse multiplie le temps des oscillateurs et des cues (pas la lecture de la musique) : voir SpeedClock.
"""

import math

import numpy as np

from .params import finite

# clé → (libellé, défaut, min, max, unité)
FIELDS = {
    "brightness": ("Lumière", 100.0, 0.0, 100.0, "%"),
    "size": ("Taille", 100.0, 10.0, 200.0, "%"),
    "speed": ("Vitesse", 1.0, 0.0, 4.0, "×"),
    "x": ("Position X", 0.0, -1.0, 1.0, ""),
    "y": ("Position Y", 0.0, -1.0, 1.0, ""),
    "rotation": ("Rotation", 0.0, -360.0, 360.0, "°"),
}
KEYS = list(FIELDS) + ["color"]


def valid_color(c):
    """None (pas de couleur forcée) ou (r, g, b) entre 0 et 1."""
    if c is None or not isinstance(c, (list, tuple)) or len(c) != 3:
        return None
    try:
        out = tuple(min(1.0, max(0.0, float(v))) for v in c)
    except (TypeError, ValueError):
        return None
    return out if all(math.isfinite(v) for v in out) else None


class Masters:
    def __init__(self):
        for k, (_, default, _, _, _) in FIELDS.items():
            setattr(self, k, default)
        self.color = None            # couleur forcée de tous les points allumés, ou None

    def set(self, key, value):
        """Change un maître (valeur bornée) ; renvoie la valeur retenue."""
        if key == "color":
            self.color = valid_color(value)
            return self.color
        if key not in FIELDS:
            raise KeyError(key)
        _, default, lo, hi, _ = FIELDS[key]
        v = finite(value, getattr(self, key), lo, hi)
        setattr(self, key, v)
        return v

    def reset(self):
        self.__init__()

    def is_neutral(self):
        """Vrai si les maîtres ne changent rien à l'image (la vitesse n'agit pas sur l'image)."""
        return (self.brightness == 100.0 and self.size == 100.0 and self.x == 0.0 and self.y == 0.0
                and self.rotation == 0.0 and self.color is None)

    def copy(self):
        return Masters.from_dict(self.to_dict())

    def signature(self):
        return tuple(getattr(self, k) for k in KEYS)

    def to_dict(self):
        d = {k: getattr(self, k) for k in FIELDS}
        d["color"] = list(self.color) if self.color is not None else None
        return d

    @classmethod
    def from_dict(cls, d):
        m = cls()
        if isinstance(d, dict):
            for k in FIELDS:
                if k in d:
                    m.set(k, d[k])
            m.color = valid_color(d.get("color"))
        return m


def apply_masters(strokes, masters):
    """Tracés après les maîtres : taille, rotation et position autour du centre de la mire, couleur forcée
    (même intensité), lumière. Toujours de nouveaux tracés quand quelque chose change."""
    if masters is None or masters.is_neutral() or not strokes:
        return strokes
    k = masters.size / 100.0
    a = math.radians(masters.rotation)
    ca, sa = math.cos(a) * k, math.sin(a) * k
    m = np.array([[ca, -sa], [sa, ca]])
    off = np.array([masters.x, masters.y])
    geo = not (k == 1.0 and a == 0.0 and masters.x == 0.0 and masters.y == 0.0)
    lum = masters.brightness / 100.0
    forced = np.asarray(masters.color, dtype=float) if masters.color is not None else None
    out = []
    for s in strokes:
        pts = s.pts @ m.T + off if geo and len(s.pts) else s.pts.copy()
        col = s.col
        if forced is not None and len(col):
            level = col.max(axis=1, keepdims=True)
            col = level * forced
        if lum != 1.0:
            col = col * lum
        r = s.with_pts(pts)
        r.col = np.array(col, dtype=float)
        out.append(r)
    return out


class SpeedClock:
    """Temps accéléré par le maître Vitesse, continu quand la vitesse change (pas de saut de phase).
    at(now) : temps accéléré à l'heure murale `now` (time.perf_counter)."""

    __slots__ = ("base", "anchor", "speed")

    def __init__(self, speed=1.0, now=0.0, base=0.0):
        self.base = base
        self.anchor = now
        self.speed = speed

    def at(self, now):
        return self.base + (now - self.anchor) * self.speed

    def set_speed(self, speed, now):
        self.base = self.at(now)
        self.anchor = now
        self.speed = speed

    def restart(self, now):
        """Le temps repart de 0 (début de boucle)."""
        self.base = 0.0
        self.anchor = now

    def copy(self):
        return SpeedClock(self.speed, self.anchor, self.base)
