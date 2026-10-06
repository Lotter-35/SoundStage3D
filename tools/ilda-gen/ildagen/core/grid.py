"""Grilles de la mire (orthogonale / polaire) : magnétisme et tracés guidés."""

import math

import numpy as np


def ortho_step(grid):
    return 1.0 / max(1, grid.divisions)


def ring_step(grid):
    return 1.0 / max(1, grid.rings)


def ray_step(grid):
    return 360.0 / max(1, grid.rays)


def polar(p):
    return math.hypot(p[0], p[1]), math.degrees(math.atan2(p[1], p[0]))


def from_polar(r, deg):
    a = math.radians(deg)
    return r * math.cos(a), r * math.sin(a)


def snap_point(p, grid):
    """Point de grille le plus proche (intersections orthogonales, ou cercle × rayon en polaire)."""
    x, y = p
    if grid.mode == 1:
        s = ortho_step(grid)
        return round(x / s) * s, round(y / s) * s
    if grid.mode == 2:
        r, a = polar(p)
        rs = ring_step(grid)
        r = round(r / rs) * rs
        if r < 1e-9:
            return 0.0, 0.0
        a = round(a / ray_step(grid)) * ray_step(grid)
        return from_polar(r, a)
    return x, y


def arc_points(r, a0, sweep, step_deg=2.0):
    """Arc de cercle centré sur la mire : rayon r, angle de départ a0, balayage signé (degrés)."""
    n = max(2, int(abs(sweep) / step_deg) + 1)
    angs = np.radians(a0 + np.linspace(0.0, sweep, n))
    return np.column_stack((r * np.cos(angs), r * np.sin(angs)))


def guided_segment(start, cur, grid, sweep=None):
    """Tracé entre un point de départ (déjà aimanté) et la souris, selon la grille.

    Orthogonale : ligne droite vers l'intersection la plus proche.
    Polaire : arc le long du cercle de départ, trait le long d'un rayon, ou ligne droite.
    sweep : angle balayé cumulé (pour dépasser 180° sur un arc), calculé par l'outil.
    Renvoie (points (N, 2), type) avec type dans "line", "arc", "ray".
    """
    end = snap_point(cur, grid)
    if grid.mode != 2:
        return np.array([start, end], dtype=float), "line"
    r0, a0 = polar(start)
    r1, a1 = polar(end)
    rs = ring_step(grid)
    if r0 < 1e-9 or r1 < 1e-9:
        return np.array([start, end], dtype=float), "ray"
    da = (a1 - a0 + 180.0) % 360.0 - 180.0
    if abs(r1 - r0) < rs * 0.5 and abs(da) > 1e-6:
        s = sweep if sweep is not None and abs(sweep) > 1e-6 else da
        s = round(s / ray_step(grid)) * ray_step(grid)
        if abs(s) < 1e-6:
            s = da
        return arc_points(r0, a0, s), "arc"
    if abs(da) < 1e-6:
        return np.array([start, end], dtype=float), "ray"
    return np.array([start, end], dtype=float), "line"


def snap_lines(grid):
    """Lignes de grille utilisées par le magnétisme des formes : (xs, ys)."""
    if grid.mode == 1:
        s = ortho_step(grid)
        n = max(1, grid.divisions)
        vals = [k * s for k in range(-n, n + 1)]
        return vals, vals
    if grid.mode == 2:
        rs = ring_step(grid)
        vals = [0.0] + [k * rs for k in range(1, grid.rings + 1)] + [-k * rs for k in range(1, grid.rings + 1)]
        return vals, vals
    return [0.0], [0.0]


def smart_snap(box, others, grid, threshold):
    """Ajuste un déplacement pour aligner centre et bords d'une boîte sur la grille et les autres formes.

    box : (x0, y0, x1, y1) après déplacement ; others : boîtes des autres formes.
    Renvoie (dx, dy, guides) ; guides = [("v", x) ou ("h", y), …] à dessiner.
    """
    gx, gy = snap_lines(grid)
    tx = list(gx)
    ty = list(gy)
    for b in others:
        tx += [b[0], (b[0] + b[2]) / 2, b[2]]
        ty += [b[1], (b[1] + b[3]) / 2, b[3]]
    w, h = box[2] - box[0], box[3] - box[1]
    mx = [box[0], (box[0] + box[2]) / 2, box[2]]
    my = [box[1], (box[1] + box[3]) / 2, box[3]]
    # Ligne (forme très fine) : dans le sens de sa longueur, seul son centre s'aligne
    if h < 0.05 * w:
        mx = [mx[1]]
    if w < 0.05 * h:
        my = [my[1]]

    def best(ms, ts):
        found = None
        for i, m in enumerate(ms):
            for t in ts:
                d = t - m
                if abs(d) <= threshold and (found is None or abs(d) < abs(found[0]) - 1e-12 or
                                            (abs(abs(d) - abs(found[0])) < 1e-12 and m == ms[len(ms) // 2])):
                    found = (d, t)
        return found

    bx = best(mx, tx)
    by = best(my, ty)
    guides = []
    dx = dy = 0.0
    if bx:
        dx = bx[0]
        guides.append(("v", bx[1]))
    if by:
        dy = by[0]
        guides.append(("h", by[1]))
    return dx, dy, guides
