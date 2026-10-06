"""Tracés colorés → suite de points laser (H4 : optimisation des points).

- les segments trop longs sont découpés (le galvo ne doit pas sauter trop loin d'un point à l'autre) ;
- les angles vifs et les extrémités sont répétés (« dwell ») pour rester nets ;
- les déplacements entre deux tracés sont faits laser éteint (blanking) ;
- les tracés peuvent être réordonnés pour réduire les sauts.
"""

import math

import numpy as np

from ..core.path import closed_pts

MIN_LIGHT = 1.0 / 255.0


def _travel(a, b, cfg):
    """Points éteints de a vers b (b inclus)."""
    d = float(np.hypot(*(b - a)))
    n = int(cfg["blank_base"]) + int(math.ceil(d * float(cfg["blank_per_unit"])))
    n = max(1, n)
    k = (np.arange(1, n + 1) / n)[:, None]
    return a + (b - a) * k, np.zeros((n, 3))


def _line(pts, col, closed, cfg):
    P = closed_pts(pts, closed)
    C = closed_pts(col, closed)
    n = len(P)
    ed = int(cfg["end_dwell"])
    cd = int(cfg["corner_dwell"])
    if n == 1:
        n_pt = max(ed + 1, 10)   # point isolé : bien visible
        return np.repeat(P, n_pt, axis=0), np.repeat(C, n_pt, axis=0)
    step = max(0.002, float(cfg["max_step"]))
    seg = np.diff(P, axis=0)
    L = np.hypot(seg[:, 0], seg[:, 1])
    counts = np.maximum(1, np.ceil(L / step)).astype(int)
    seg_idx = np.repeat(np.arange(n - 1), counts)
    starts = np.cumsum(counts) - counts
    within = np.arange(counts.sum()) - np.repeat(starts, counts) + 1
    t = (within / counts[seg_idx])[:, None]
    out_p = P[seg_idx] + (P[seg_idx + 1] - P[seg_idx]) * t
    out_c = C[seg_idx] + (C[seg_idx + 1] - C[seg_idx]) * t
    reps = np.ones(len(out_p), dtype=int)
    # Angles vifs : le dernier point de chaque segment est le sommet suivant
    ang = np.arctan2(seg[:, 1], seg[:, 0])
    turn = np.degrees(np.abs((np.diff(ang) + np.pi) % (2 * np.pi) - np.pi))
    ends = np.cumsum(counts) - 1
    corner = turn >= float(cfg["corner_angle"])
    reps[ends[:-1][corner]] += cd
    first_rep = ed + 1
    if closed:
        a_last, a_first = ang[-1], ang[0]
        closing_turn = abs((a_first - a_last + math.pi) % (2 * math.pi) - math.pi)
        first_rep = cd + 1 if math.degrees(closing_turn) >= float(cfg["corner_angle"]) else 1
    else:
        reps[-1] += ed
    out_p = np.vstack((np.repeat(P[:1], first_rep, axis=0), np.repeat(out_p, reps, axis=0)))
    out_c = np.vstack((np.repeat(C[:1], first_rep, axis=0), np.repeat(out_c, reps, axis=0)))
    return out_p, out_c


def _lit(s):
    return len(s.pts) > 0 and float(s.col.max(initial=0.0)) >= MIN_LIGHT


def order_strokes(strokes):
    """Ordre glouton du plus proche voisin ; les tracés ouverts peuvent être parcourus à l'envers."""
    left = list(strokes)
    out = []
    cur = np.zeros(2)
    while left:
        best_i, best_d, best_rev = 0, float("inf"), False
        for i, s in enumerate(left):
            d0 = float(np.hypot(*(s.pts[0] - cur)))
            if d0 < best_d:
                best_i, best_d, best_rev = i, d0, False
            if s.kind == "line" and not s.closed:
                d1 = float(np.hypot(*(s.pts[-1] - cur)))
                if d1 < best_d:
                    best_i, best_d, best_rev = i, d1, True
        s = left.pop(best_i)
        if best_rev:
            s = s.copy()
            s.pts = s.pts[::-1].copy()
            s.col = s.col[::-1].copy()
        out.append(s)
        cur = s.pts[-1] if s.kind == "line" and not s.closed else s.pts[0]
    return out


def build_points(strokes, cfg):
    """Renvoie (points (M, 2), couleurs (M, 3) 0..1). Une image vide = un seul point éteint au centre."""
    strokes = [s for s in strokes if _lit(s)]
    if not strokes:
        return np.zeros((0, 2)), np.zeros((0, 3))
    if cfg.get("reorder", True) and len(strokes) > 1:
        strokes = order_strokes(strokes)
    parts_p, parts_c = [], []
    cur = None
    for s in strokes:
        if s.kind == "dots":
            dwell = max(1, int(s.dwell))
            for p, c in zip(s.pts, s.col):
                if cur is not None:
                    tp, tc = _travel(cur, p, cfg)
                    parts_p.append(tp)
                    parts_c.append(tc)
                parts_p.append(np.repeat(p[None], dwell, axis=0))
                parts_c.append(np.repeat(c[None], dwell, axis=0))
                cur = p
            continue
        if cur is not None:
            tp, tc = _travel(cur, s.pts[0], cfg)
            parts_p.append(tp)
            parts_c.append(tc)
        lp, lc = _line(s.pts, s.col, s.closed, cfg)
        parts_p.append(lp)
        parts_c.append(lc)
        cur = lp[-1]
    # Retour éteint vers le premier point : l'image boucle proprement
    first = parts_p[0][0]
    tp, tc = _travel(cur, first, cfg)
    parts_p.append(tp)
    parts_c.append(tc)
    return np.vstack(parts_p), np.clip(np.vstack(parts_c), 0.0, 1.0)
