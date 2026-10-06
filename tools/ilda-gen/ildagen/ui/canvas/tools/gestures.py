"""Calcul des transformations (repère mire) à partir des gestes sur les poignées.

Correspondances (comme Photoshop) :
- coin              : redimensionnement libre       | Maj : proportionnel | Alt : depuis le centre
- milieu de côté    : étirement sur un axe          | Alt : symétrique depuis le centre
- Ctrl + coin       : distorsion libre (coin seul)
- Ctrl + Maj + côté : inclinaison (cisaillement)    | Alt : symétrique
- Ctrl + Alt + Maj + coin : perspective
- poignée du haut / autour des coins : rotation     | Maj : pas de 15°
"""

import math

import numpy as np

from ....core import mathutil as mu
from .selection_frame import UNIT

CORNER_EDGES = {"c0": ("c1", "c3"), "c1": ("c0", "c2"), "c2": ("c3", "c1"), "c3": ("c2", "c0")}
CORNER_INDEX = {"c0": 0, "c1": 1, "c2": 2, "c3": 3}
EDGE_CORNERS = {"e0": (0, 1), "e1": (1, 2), "e2": (2, 3), "e3": (3, 0)}
OPPOSITE_EDGE = {"e0": "e2", "e2": "e0", "e1": "e3", "e3": "e1"}


def scale_matrix(frame, hid, mouse, shift, alt):
    f = frame.frame_matrix()
    try:
        finv = np.linalg.inv(f)
    except np.linalg.LinAlgError:
        return np.eye(3)
    hs, ht = UNIT[hid]
    a_s, a_t = (0.5, 0.5) if alt else (1.0 - hs, 1.0 - ht)
    ms, mt = mu.apply_point(finv, *mouse)
    fx = (ms - a_s) / (hs - a_s) if abs(hs - a_s) > 1e-9 else 1.0
    fy = (mt - a_t) / (ht - a_t) if abs(ht - a_t) > 1e-9 else 1.0
    if hid.startswith("e"):
        if hid in ("e0", "e2"):
            fx = fy if shift else 1.0
        else:
            fy = fx if shift else 1.0
    elif shift:
        k = fx if abs(fx) > abs(fy) else fy
        fx = math.copysign(abs(k), fx) if fx != 0 else k
        fy = math.copysign(abs(k), fy) if fy != 0 else k
    s = mu.about(mu.scaling(fx, fy), a_s, a_t)
    return f @ s @ finv


def rotate_matrix(pivot, press, mouse, shift):
    a0 = math.atan2(press[1] - pivot[1], press[0] - pivot[0])
    a1 = math.atan2(mouse[1] - pivot[1], mouse[0] - pivot[0])
    deg = math.degrees(a1 - a0)
    deg = (deg + 180.0) % 360.0 - 180.0
    if shift:
        deg = round(deg / 15.0) * 15.0
    return mu.about(mu.rotation(deg), pivot[0], pivot[1]), deg


def affine_from_points(src, dst):
    """Matrice affine envoyant 3 points sur 3 points."""
    a = np.array([[src[i][0], src[i][1], 1.0] for i in range(3)])
    try:
        mx = np.linalg.solve(a, np.array([dst[i][0] for i in range(3)]))
        my = np.linalg.solve(a, np.array([dst[i][1] for i in range(3)]))
    except np.linalg.LinAlgError:
        return np.eye(3)
    return np.array([[mx[0], mx[1], mx[2]], [my[0], my[1], my[2]], [0.0, 0.0, 1.0]])


def skew_matrix(frame, hid, delta, alt):
    """Inclinaison : le côté saisi glisse parallèlement à lui-même."""
    q = frame.quad.copy()
    i, j = EDGE_CORNERS[hid]
    d = q[j] - q[i]
    n = float(np.hypot(*d))
    if n < 1e-9:
        return np.eye(3)
    dirv = d / n
    shift = dirv * float(np.dot(delta, dirv))
    new = q.copy()
    new[i] += shift
    new[j] += shift
    if alt:
        k, m = EDGE_CORNERS[OPPOSITE_EDGE[hid]]
        new[k] -= shift
        new[m] -= shift
    return affine_from_points([q[0], q[1], q[3]], [new[0], new[1], new[3]])


def distort_quad(frame, hid, mouse):
    new = frame.quad.copy()
    new[CORNER_INDEX[hid]] = mouse
    return new


def perspective_quad(frame, hid, delta):
    """Le coin saisi et son voisin bougent en miroir le long du côté le plus proche du geste."""
    q = frame.quad
    i = CORNER_INDEX[hid]
    best = None
    for other in CORNER_EDGES[hid]:
        j = CORNER_INDEX[other]
        d = q[j] - q[i]
        n = float(np.hypot(*d))
        if n < 1e-9:
            continue
        dirv = d / n
        amount = float(np.dot(delta, dirv))
        if best is None or abs(amount) > abs(best[2]):
            best = (j, dirv, amount)
    new = q.copy()
    if best is None:
        return new
    j, dirv, amount = best
    new[i] += dirv * amount
    new[j] -= dirv * amount
    return new


def homography_between(src_quad, dst_quad):
    return mu.homography([tuple(p) for p in src_quad], [tuple(p) for p in dst_quad])
