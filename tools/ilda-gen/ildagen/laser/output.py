"""Étape de sortie : H3 taille / position, H2 trapèze, puissance et correction des couleurs, décalage couleur,
H1 zone de sécurité, puis conversion 16 bits.

Les réglages sont vérifiés ici aussi (fichier de réglages modifié à la main, ancienne version…) :
taille au moins MIN_SCALE %, zone de sécurité jamais retournée ni plus étroite que MIN_ZONE.
"""

import numpy as np

from ..core import mathutil as mu
from . import color as colors

MIN_SCALE = 5.0       # % : en dessous, toute l'image se tasse en un point (faisceau fixe)
MAX_SCALE = 200.0
MIN_ZONE = 0.05       # largeur / hauteur minimale de la zone de sécurité


def _num(v, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return v if np.isfinite(v) else default


def output_matrix(o):
    sx = min(MAX_SCALE, max(MIN_SCALE, _num(o.get("scale_x"), 100.0))) / 100.0 * (-1.0 if o.get("flip_x") else 1.0)
    sy = min(MAX_SCALE, max(MIN_SCALE, _num(o.get("scale_y"), 100.0))) / 100.0 * (-1.0 if o.get("flip_y") else 1.0)
    return (mu.translation(_num(o.get("offset_x"), 0.0), _num(o.get("offset_y"), 0.0))
            @ mu.rotation(_num(o.get("rotation"), 0.0)) @ mu.scaling(sx, sy))


def keystone_matrix(k):
    """Homographie qui resserre chaque bord de k % (haut, bas, gauche, droite)."""
    t, b, l, r = (max(-50.0, min(50.0, _num(k.get(n), 0.0))) / 100.0 for n in ("top", "bottom", "left", "right"))
    if t == b == l == r == 0:
        return None
    src = [(-1, 1), (1, 1), (1, -1), (-1, -1)]
    dst = [(-1 + t, 1 - l), (1 - t, 1 - r), (1 - b, -1 + r), (-1 + b, -1 + l)]
    return mu.homography(src, dst)


def _axis(a, b):
    """Bornes d'une zone toujours dans l'ordre et assez larges."""
    a, b = max(-1.0, min(1.0, a)), max(-1.0, min(1.0, b))
    lo, hi = min(a, b), max(a, b)
    if hi - lo < MIN_ZONE:
        m = min(1.0 - MIN_ZONE / 2, max(-1.0 + MIN_ZONE / 2, (lo + hi) / 2))
        lo, hi = m - MIN_ZONE / 2, m + MIN_ZONE / 2
    return lo, hi


def safety_bounds(sz):
    """(xmin, ymin, xmax, ymax) de la zone de sécurité, ou None si elle est désactivée."""
    if not sz.get("enabled"):
        return None
    x0, x1 = _axis(_num(sz.get("xmin"), -1.0), _num(sz.get("xmax"), 1.0))
    y0, y1 = _axis(_num(sz.get("ymin"), -1.0), _num(sz.get("ymax"), 1.0))
    return x0, y0, x1, y1


def _finite(pts, col):
    ok = np.isfinite(pts).all(axis=1) & np.isfinite(col).all(axis=1)
    return (pts, col) if ok.all() else (pts[ok], col[ok])


def _quantize(p, c, rect):
    """Blanking hors du rectangle, coordonnées ramenées dedans, conversion entière."""
    lo, hi = np.array(rect[:2]), np.array(rect[2:])
    bad = ~np.isfinite(p).all(axis=1)
    if bad.any():
        p = np.where(bad[:, None], 0.0, p)
    outside = bad | np.any((p < lo) | (p > hi), axis=1)
    if outside.any():
        c = np.where(outside[:, None], 0.0, c)
        p = np.clip(p, lo, hi)
    xy = np.clip(np.round(p * 32767.0), -32768, 32767).astype(np.int16)
    rgb = np.clip(np.round(np.clip(c, 0.0, 1.0) * 255.0), 0, 255).astype(np.uint8)
    return xy[:, 0], xy[:, 1], rgb[:, 0], rgb[:, 1], rgb[:, 2]


def apply_output(pts, col, settings):
    """pts (N, 2) normalisés, col (N, 3) 0..1 → (x, y int16, r, g, b uint8), réglages de sortie appliqués.
    Les points non finis (NaN, infini) sont retirés."""
    pts, col = _finite(np.asarray(pts, dtype=float).reshape(-1, 2), np.asarray(col, dtype=float).reshape(-1, 3))
    o = settings.section("output")
    p = mu.apply(output_matrix(o), pts)
    h = keystone_matrix(settings.section("keystone"))
    if h is not None:
        p = mu.apply(h, p)
    c = col * (max(0.0, min(100.0, _num(o.get("power"), 100.0))) / 100.0)
    cs = settings.section("color")
    c = colors.correct(c, cs)
    c = colors.shift(c, _num(cs.get("shift"), 0.0), _num(settings.get("laser", "scan_kpps"), 30.0))
    rect = safety_bounds(settings.section("safety")) or (-1.0, -1.0, 1.0, 1.0)
    return _quantize(p, c, rect)


def plain_output(pts, col):
    """Conversion sans réglages de sortie (export du contenu seul) : champ [-1, 1], couleurs telles quelles."""
    pts, col = _finite(np.asarray(pts, dtype=float).reshape(-1, 2), np.asarray(col, dtype=float).reshape(-1, 3))
    return _quantize(pts, col, (-1.0, -1.0, 1.0, 1.0))


def safety_rect(settings):
    return safety_bounds(settings.section("safety"))
