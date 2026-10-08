"""Éclaircissement (dernier recours pour tenir le budget) : on garde une partie des tracés et des points,
répartis régulièrement, plutôt que de couper la fin de l'image.

Une « unité » est une ligne entière ou un point isolé (Dots, Beams) : une ligne coûte au moins 3 points
(début, fin, trajet éteint), un point isolé 2 (allumé, trajet éteint).
"""

import numpy as np

from ..core.path import Stroke


def _chosen(n_units, m):
    keep = np.zeros(n_units, dtype=bool)
    keep[np.unique(np.round(np.linspace(0, n_units - 1, max(1, m))).astype(int))] = True
    return keep


def pre_thin(strokes, budget):
    """Avant toute préparation : pas plus d'unités que le budget n'en permet au minimum (une ligne coûte au
    moins 3 points, un point isolé 2) ; évite de préparer ce qui ne serait de toute façon pas tracé."""
    sizes = [len(s.pts) if s.kind == "dots" else 1 for s in strokes]
    n_units = sum(sizes)
    n_dots = sum(k for s, k in zip(strokes, sizes) if s.kind == "dots")
    min_cost = 3 * (n_units - n_dots) + 2 * n_dots
    if min_cost <= budget:
        return strokes, False
    m = int(n_units * budget / min_cost)
    keep = _chosen(n_units, m)
    out = []
    pos = 0
    for s, k in zip(strokes, sizes):
        sel = keep[pos:pos + k]
        pos += k
        if s.kind == "dots":
            if sel.any():
                out.append(Stroke(s.pts[sel], s.col[sel], False, "dots", s.dwell))
        elif sel[0]:
            out.append(s)
    return out, True


def thin(b, ratio):
    """Garde une fraction « ratio » des unités du Batch (dans l'ordre de tracé)."""
    sizes = b.sizes()
    per_item = np.where(b.dots, sizes, 1)                   # unités par élément
    n_units = int(per_item.sum())
    keep_unit = _chosen(n_units, int(n_units * ratio))
    unit_start = np.cumsum(per_item) - per_item
    item = b.item_of_vertex()
    local = np.arange(len(b.P)) - b.start[item]
    unit = unit_start[item] + np.where(b.dots[item], local, 0)
    return b.keep_vertices(keep_unit[unit])
