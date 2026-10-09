"""Courbes des réglages d'effet (lignes de la timeline et mini-éditeur de l'inspecteur du clip).

Une courbe se dessine dans un rectangle (x0, x1, haut, bas) : u = 0..1 de la durée du clip en x, valeur
ramenée à 0..1 de la plage du réglage en y. Le tracé est échantillonné une fois par courbe (quelques points par
segment, formule paramétrique de la Bézier) puis gardé en cache : peindre ne réévalue rien (T6).
"""

import numpy as np

from ...core.automation import CURVES

CURVE_MENU = [(c, label) for c, label, _ in CURVES if c != "custom"] + [("custom", "Bézier")]
_cache = {}
_MAX = 4000
SEG_PTS = 14


def value_range(spec):
    """(min, max) affichés : bornes confortables du réglage (jamais élargies par les clés)."""
    if spec is None:
        return -1.0, 1.0
    if spec.kind in ("bool", "color"):
        return 0.0, 1.0
    if spec.kind == "enum":
        return 0.0, float(max(1, len(spec.options) - 1))
    lo = spec.soft_min if spec.soft_min is not None else (spec.min if spec.min is not None else -1.0)
    hi = spec.soft_max if spec.soft_max is not None else (spec.max if spec.max is not None else 1.0)
    if hi - lo < 1e-9:
        hi = lo + 1.0
    return float(lo), float(hi)


def is_color(spec):
    return spec is not None and spec.kind == "color"


def norm(v, rng):
    """Valeur → 0..1 dans la plage affichée (bornée)."""
    if isinstance(v, bool):
        v = 1.0 if v else 0.0
    if isinstance(v, (tuple, list)):
        return 0.5
    try:
        k = (float(v) - rng[0]) / (rng[1] - rng[0])
    except (TypeError, ValueError):
        return 0.5
    return min(1.0, max(0.0, k))


def denorm(k, spec, rng):
    """0..1 → valeur du réglage (entier, oui / non, bornes)."""
    k = min(1.0, max(0.0, k))
    v = rng[0] + k * (rng[1] - rng[0])
    if spec is None:
        return v
    if spec.kind == "bool":
        return v >= 0.5
    if spec.kind in ("int", "enum"):
        v = round(v)
    return spec.clamp(v)


def signature(curve, rng):
    return (curve.discrete, rng, tuple((k.t, _hashable(k.v), k.curve, tuple(k.h)) for k in curve.keys))


def _hashable(v):
    return tuple(v) if isinstance(v, list) else v


def _bezier(x1, y1, x2, y2, n):
    s = np.linspace(0.0, 1.0, n)
    bx = 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s * s * x2 + s ** 3
    by = 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s * s * y2 + s ** 3
    return bx, by


def polyline(curve, rng):
    """Tracé de la courbe en (u, valeur 0..1) : array (N, 2), plat avant la première clé et après la dernière.
    Gardé en cache (même courbe = même tracé, quel que soit le zoom ou le clip lié qui l'affiche)."""
    key = signature(curve, rng)
    pts = _cache.get(key)
    if pts is not None:
        return pts
    ks = curve.keys
    if not ks:
        pts = np.zeros((0, 2))
    else:
        out = [(min(0.0, ks[0].t), norm(ks[0].v, rng))]
        for a, b in zip(ks, ks[1:]):
            na, nb = norm(a.v, rng), norm(b.v, rng)
            out.append((a.t, na))
            if curve.discrete or a.curve == "hold" or b.t - a.t < 1e-9:
                out.append((b.t, na))
            elif a.curve != "linear":
                bx, by = _bezier(*a.handles(), SEG_PTS)
                for x, y in zip(bx[1:-1], by[1:-1]):
                    out.append((a.t + x * (b.t - a.t), na + y * (nb - na)))
            out.append((b.t, nb))
        out.append((max(1.0, ks[-1].t), norm(ks[-1].v, rng)))
        pts = np.array(out, dtype=float)
    if len(_cache) > _MAX:
        _cache.clear()
    _cache[key] = pts
    return pts


class LaneMap:
    """Correspondance (u, valeur) ↔ écran dans le rectangle d'une ligne de courbe."""
    __slots__ = ("x0", "x1", "top", "bottom", "rng", "spec")

    def __init__(self, x0, x1, top, bottom, spec):
        self.x0, self.x1, self.top, self.bottom = x0, x1, top, bottom
        self.spec = spec
        self.rng = value_range(spec)

    def ux(self, u):
        return self.x0 + u * (self.x1 - self.x0)

    def xu(self, x):
        w = self.x1 - self.x0
        return (x - self.x0) / w if w > 1e-9 else 0.0

    def vy(self, v):
        return self.bottom - norm(v, self.rng) * (self.bottom - self.top)

    def ny(self, n):
        return self.bottom - n * (self.bottom - self.top)

    def yv(self, y):
        h = max(1.0, self.bottom - self.top)
        return denorm((self.bottom - y) / h, self.spec, self.rng)

    def screen(self, curve):
        """Tracé à l'écran : array (N, 2)."""
        pts = polyline(curve, self.rng)
        if not len(pts):
            return pts
        out = np.empty_like(pts)
        out[:, 0] = self.x0 + pts[:, 0] * (self.x1 - self.x0)
        out[:, 1] = self.bottom - pts[:, 1] * (self.bottom - self.top)
        return out

    def key_pos(self, k):
        y = (self.top + self.bottom) / 2 if is_color(self.spec) else self.vy(k.v)
        return self.ux(k.t), y

    def key_at(self, curve, x, y, grab=6.0):
        """Indice de la clé la plus proche de (x, y) à grab px près (seulement les clés dans le clip), ou None."""
        best = None
        for i, k in enumerate(curve.keys):
            if not -1e-9 <= k.t <= 1.0 + 1e-9:
                continue
            kx, ky = self.key_pos(k)
            d = max(abs(kx - x), abs(ky - y))
            if d <= grab and (best is None or d < best[0]):
                best = (d, i)
        return best[1] if best is not None else None

    def handles(self, curve, i):
        """Poignées de Bézier de la clé i (vers la suivante) : ((ax, ay), (bx, by), (h1x, h1y), (h2x, h2y))."""
        if i is None or i + 1 >= len(curve.keys):
            return None
        a, b = curve.keys[i], curve.keys[i + 1]
        ax, ay = self.key_pos(a)
        bx, by = self.key_pos(b)
        x1, y1, x2, y2 = a.h
        return (ax, ay), (bx, by), (ax + x1 * (bx - ax), ay + y1 * (by - ay)), (ax + x2 * (bx - ax), ay + y2 * (by - ay))

    def handle_values(self, curve, i, which, x, y):
        """Nouvelles poignées quand on tire la poignée `which` (0 ou 1) de la clé i jusqu'à (x, y)."""
        h = self.handles(curve, i)
        if h is None:
            return None
        (ax, ay), (bx, by) = h[0], h[1]
        hx = min(1.0, max(0.0, (x - ax) / ((bx - ax) or 1.0)))
        hy = (y - ay) / (by - ay) if abs(by - ay) > 2 else (ay - y) / 40.0
        hy = max(-2.0, min(3.0, hy))
        out = list(curve.keys[i].h)
        out[2 * which:2 * which + 2] = [hx, hy]
        return out


def format_value(v, spec):
    if isinstance(v, bool):
        return "Oui" if v else "Non"
    if isinstance(v, (tuple, list)):
        return "#%02x%02x%02x" % tuple(int(min(1.0, max(0.0, c)) * 255) for c in v[:3])
    if spec is not None and spec.kind == "enum" and spec.options:
        i = int(round(v))
        return spec.options[i] if 0 <= i < len(spec.options) else str(i)
    unit = spec.unit if spec is not None else ""
    dec = spec.decimals if spec is not None else 2
    return f"{v:.{dec}f}".replace(".", ",") + (f" {unit}" if unit and not unit.startswith(" ") else unit)
