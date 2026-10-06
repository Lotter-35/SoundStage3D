"""Couleur propre d'une forme (choisie au tracé ou au seau) : par défaut, unie ou dégradé.

Le dégradé s'adapte à la forme : le long du tracé, ou en travers de la forme (linéaire, radial, angulaire).
Les modifieurs de couleur placés au-dessus de la forme restent prioritaires.
"""

import math

import numpy as np

from . import colorutil as cu
from .params import C, E
from .path import resample_stroke

COLOR_MODES = ["Par défaut", "Unie"]   # le dégradé se fait avec le modifieur Dégradé
GRAD_TYPES = ["Le long du tracé", "Linéaire", "Radial", "Angulaire"]
DEFAULT_STOPS = [[0.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 1.0]]
STEP = 0.02

# clé de paramètre « col.x » → attribut de ShapeNode
ATTRS = {"mode": "color_mode", "color": "color", "stops": "stops", "type": "grad_type", "angle": "grad_angle"}

SPECS = [
    E("col.mode", "Couleur", COLOR_MODES),
    C("col.color", "Couleur unie", (1.0, 1.0, 1.0)),
]


def spec(key):
    return next((s for s in SPECS if s.key == key), None)


def _path_t(s):
    pts = np.vstack((s.pts, s.pts[:1])) if s.closed and len(s.pts) > 1 else s.pts
    d = np.hypot(*np.diff(pts, axis=0).T) if len(pts) > 1 else np.zeros(0)
    cum = np.concatenate(([0.0], np.cumsum(d)))
    L = cum[-1] if len(cum) else 0.0
    return (cum[:len(s.pts)] / L) if L > 1e-9 else np.zeros(len(s.pts))


def colorize(strokes, mode, color, stops, gtype, angle):
    """Applique la couleur propre d'une forme à ses tracés."""
    if mode == 1:
        c = np.asarray(color, dtype=float)
        return [s.with_col(np.tile(c, (len(s.pts), 1))) for s in strokes]
    if mode != 2 or not strokes:
        return strokes
    src = [resample_stroke(s, STEP) for s in strokes]
    allp = np.vstack([s.pts for s in src if len(s.pts)]) if any(len(s.pts) for s in src) else np.zeros((0, 2))
    if len(allp) == 0:
        return strokes
    cx, cy = (allp[:, 0].min() + allp[:, 0].max()) / 2, (allp[:, 1].min() + allp[:, 1].max()) / 2
    a = math.radians(angle)
    out = []
    if gtype == 1:
        d = np.array([math.cos(a), math.sin(a)])
        proj_all = allp @ d
        lo, hi = proj_all.min(), proj_all.max()
    if gtype == 2:
        rmax = max(1e-9, float(np.hypot(allp[:, 0] - cx, allp[:, 1] - cy).max()))
    for s in src:
        if gtype == 0:
            t = _path_t(s)
        elif gtype == 1:
            t = (s.pts @ d - lo) / max(1e-9, hi - lo)
        elif gtype == 2:
            t = np.hypot(s.pts[:, 0] - cx, s.pts[:, 1] - cy) / rmax
        else:
            t = ((np.arctan2(s.pts[:, 1] - cy, s.pts[:, 0] - cx) - a) / (2 * math.pi)) % 1.0
        out.append(s.with_col(cu.sample_gradient(stops, np.clip(t, 0.0, 1.0))))
    return out
