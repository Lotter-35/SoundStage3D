"""Étape de sortie : H3 taille / position, H2 trapèze, H1 zone de sécurité, puis conversion 16 bits."""

import numpy as np

from ..core import mathutil as mu


def output_matrix(o):
    sx = o["scale_x"] / 100.0 * (-1.0 if o["flip_x"] else 1.0)
    sy = o["scale_y"] / 100.0 * (-1.0 if o["flip_y"] else 1.0)
    return mu.translation(o["offset_x"], o["offset_y"]) @ mu.rotation(o["rotation"]) @ mu.scaling(sx, sy)


def keystone_matrix(k):
    """Homographie qui resserre chaque bord de k % (haut, bas, gauche, droite)."""
    t, b, l, r = (k[n] / 100.0 for n in ("top", "bottom", "left", "right"))
    if t == b == l == r == 0:
        return None
    src = [(-1, 1), (1, 1), (1, -1), (-1, -1)]
    dst = [(-1 + t, 1 - l), (1 - t, 1 - r), (1 - b, -1 + r), (-1 + b, -1 + l)]
    return mu.homography(src, dst)


def apply_output(pts, col, settings):
    """pts (N, 2) normalisés, col (N, 3) 0..1 → (x, y int16, r, g, b uint8)."""
    o = settings.section("output")
    p = mu.apply(output_matrix(o), pts)
    h = keystone_matrix(settings.section("keystone"))
    if h is not None:
        p = mu.apply(h, p)
    c = col * (o["power"] / 100.0)
    sz = settings.section("safety")
    if sz["enabled"]:
        lo = np.array([sz["xmin"], sz["ymin"]])
        hi = np.array([sz["xmax"], sz["ymax"]])
    else:
        lo = np.array([-1.0, -1.0])
        hi = np.array([1.0, 1.0])
    outside = np.any((p < lo) | (p > hi), axis=1)
    if outside.any():
        c = c.copy()
        c[outside] = 0.0
        p = np.clip(p, lo, hi)
    xy = np.clip(np.round(p * 32767.0), -32768, 32767).astype(np.int16)
    rgb = np.clip(np.round(c * 255.0), 0, 255).astype(np.uint8)
    return xy[:, 0], xy[:, 1], rgb[:, 0], rgb[:, 1], rgb[:, 2]


def safety_rect(settings):
    sz = settings.section("safety")
    if not sz["enabled"]:
        return None
    return sz["xmin"], sz["ymin"], sz["xmax"], sz["ymax"]
