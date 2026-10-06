"""Formes de base : génération des tracés à partir d'un rectangle englobant."""

import math

import numpy as np

from .path import Path

# Formes proposées dans la barre d'outils : (identifiant, libellé, icône)
BASIC_SHAPES = [
    ("line", "Trait", "slash"),
    ("rect", "Carré", "square"),
    ("ellipse", "Cercle", "circle"),
    ("triangle", "Triangle", "triangle"),
    ("star", "Étoile", "star"),
    ("polygon", "Polygone", "hexagon"),
    ("ilda_test", "Mire ILDA", "scan"),
]

SHAPE_LABELS = {k: label for k, label, _ in BASIC_SHAPES}
SHAPE_LABELS["path"] = "Tracé"

# Paramètres propres à certaines formes : clé → (libellé, défaut, min, max)
SHAPE_PARAMS = {
    "star": {"branches": ("Branches", 5, 3, 24), "ratio": ("Creux (%)", 45, 5, 95)},
    "polygon": {"sides": ("Côtés", 6, 3, 32)},
    "ellipse": {"segments": ("Segments", 96, 8, 256)},
}


def default_params(kind):
    return {k: v[1] for k, v in SHAPE_PARAMS.get(kind, {}).items()}


def _ellipse_pts(cx, cy, rx, ry, n, start=math.pi / 2):
    a = start + np.linspace(0.0, 2 * math.pi, n, endpoint=False)
    return np.column_stack((cx + rx * np.cos(a), cy + ry * np.sin(a)))


def build(kind, rect, params=None):
    """Tracés d'une forme dans le rectangle (x0, y0, x1, y1)."""
    params = params or {}
    x0, y0, x1, y1 = rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = abs(x1 - x0) / 2, abs(y1 - y0) / 2
    if kind == "line":
        return [Path([[x0, y0], [x1, y1]])]
    if kind == "rect":
        return [Path([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed=True)]
    if kind == "ellipse":
        n = int(params.get("segments", 96))
        return [Path(_ellipse_pts(cx, cy, rx, ry, n), closed=True)]
    if kind == "triangle":
        top = max(y0, y1)
        bot = min(y0, y1)
        return [Path([[cx, top], [max(x0, x1), bot], [min(x0, x1), bot]], closed=True)]
    if kind == "polygon":
        n = int(params.get("sides", 6))
        return [Path(_ellipse_pts(cx, cy, rx, ry, n), closed=True)]
    if kind == "star":
        n = int(params.get("branches", 5))
        ratio = float(params.get("ratio", 45)) / 100.0
        outer = _ellipse_pts(cx, cy, rx, ry, n)
        inner = _ellipse_pts(cx, cy, rx * ratio, ry * ratio, n, start=math.pi / 2 + math.pi / n)
        pts = np.empty((2 * n, 2))
        pts[0::2] = outer
        pts[1::2] = inner
        return [Path(pts, closed=True)]
    if kind == "ilda_test":
        return ilda_test_pattern(rect)
    return []


def ilda_test_pattern(rect):
    """Mire de réglage inspirée de la mire de test ILDA : cadre, cercle inscrit, croix et repères."""
    x0, y0, x1, y1 = rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    rx, ry = abs(x1 - x0) / 2, abs(y1 - y0) / 2
    paths = [
        Path([[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry]], closed=True),
        Path(_ellipse_pts(cx, cy, rx, ry, 128), closed=True),
        Path([[cx - rx * 0.25, cy], [cx + rx * 0.25, cy]]),
        Path([[cx, cy - ry * 0.25], [cx, cy + ry * 0.25]]),
        Path(_ellipse_pts(cx, cy, rx * 0.5, ry * 0.5, 64), closed=True),
    ]
    # Repères aux quatre coins (petits angles droits)
    k = 0.12
    for sx in (-1, 1):
        for sy in (-1, 1):
            px, py = cx + sx * rx * 0.85, cy + sy * ry * 0.85
            paths.append(Path([[px - sx * rx * k, py], [px, py], [px, py - sy * ry * k]]))
    return paths
