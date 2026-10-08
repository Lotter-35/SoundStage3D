"""Préparation des tracés pour la sortie : découpe au champ AVANT d'ajouter des points, nettoyage, plafonds.

Une géométrie démesurée (répétitions géantes…) est d'abord ramenée à ce qui tombe dans la mire (plus une
petite marge) : le nombre de points ne dépend plus de ce qui est hors champ.
"""

import numpy as np

from ..core.path import Stroke, closed_pts

FIELD = 1.0
MARGIN = 0.02               # un tracé qui frôle le bord n'est pas haché
MAX_RAW_POINTS = 200_000    # sommets par image après découpe (au-delà : tracés décimés)
MAX_RAW_STROKES = 5000      # tracés par image après découpe (au-delà : les derniers sont ignorés)
MERGE_EPS = 1e-5            # deux points plus proches sont confondus
COLOR_EPS = 0.5 / 255.0     # deux couleurs plus proches sont identiques


def clip_strokes(strokes, limit=FIELD + MARGIN):
    """Tracés découpés au carré [-limit, limit]² (points non finis retirés)."""
    strokes = [s for s in strokes if len(s.pts)]
    if not strokes:
        return []
    # Boîte de chaque tracé, tous d'un coup : la plupart sont entièrement dedans (rien à faire) ou dehors
    lens = np.array([len(s.pts) for s in strokes])
    allp = np.concatenate([s.pts for s in strokes])
    first = np.cumsum(lens) - lens
    with np.errstate(invalid="ignore"):
        lo = np.minimum.reduceat(allp, first, axis=0)
        hi = np.maximum.reduceat(allp, first, axis=0)
        inside = np.all(lo >= -limit, axis=1) & np.all(hi <= limit, axis=1)
        outside = np.any(hi < -limit, axis=1) | np.any(lo > limit, axis=1)
    result = [[s] if i_in else [] for s, i_in in zip(strokes, inside)]
    cut = [int(i) for i in np.nonzero(~inside & ~outside)[0]]
    lines = [i for i in cut if strokes[i].kind != "dots" and len(strokes[i].pts) > 1]
    for i in cut:
        s = strokes[i]
        if s.kind == "dots" or len(s.pts) == 1:
            with np.errstate(invalid="ignore"):
                keep = np.all(np.abs(s.pts) <= limit, axis=1)
            if keep.any():
                result[i] = [Stroke(s.pts[keep], s.col[keep], False, s.kind, s.dwell)]
    if lines:
        for i, pieces in zip(lines, _clip_lines([strokes[i] for i in lines], limit)):
            result[i] = pieces
    return [x for r in result for x in r]


def _clip_lines(strokes, limit):
    """Liang-Barsky vectorisé, tous les tracés à cheval sur le bord d'un coup : morceaux visibles (ouverts)."""
    Ps = [closed_pts(s.pts, s.closed) for s in strokes]
    P = np.concatenate(Ps)
    C = np.concatenate([closed_pts(s.col, s.closed) for s in strokes])
    lens = np.array([len(x) for x in Ps])
    item = np.repeat(np.arange(len(strokes)), lens)
    A, B = P[:-1], P[1:]
    D = B - A
    t0 = np.zeros(len(A))
    t1 = np.ones(len(A))
    hidden = (item[1:] != item[:-1]) | ~(np.isfinite(A).all(axis=1) & np.isfinite(B).all(axis=1))
    with np.errstate(divide="ignore", invalid="ignore"):
        for p, q in ((-D[:, 0], A[:, 0] + limit), (D[:, 0], limit - A[:, 0]),
                     (-D[:, 1], A[:, 1] + limit), (D[:, 1], limit - A[:, 1])):
            hidden |= (p == 0) & (q < 0)
            r = q / p
            t0 = np.where(p < 0, np.maximum(t0, r), t0)
            t1 = np.where(p > 0, np.minimum(t1, r), t1)
    out = [[] for _ in strokes]
    vis = np.nonzero(~hidden & (t0 <= t1))[0]
    if len(vis) == 0:
        return out
    ta, tb = t0[vis][:, None], t1[vis][:, None]
    S0 = A[vis] + D[vis] * ta
    S1 = A[vis] + D[vis] * tb
    C0 = C[vis] + (C[vis + 1] - C[vis]) * ta
    C1 = C[vis] + (C[vis + 1] - C[vis]) * tb
    # Deux segments visibles consécutifs sont reliés si leur sommet commun est dans le champ
    # (le segment fictif entre deux tracés est caché : jamais de lien d'un tracé à l'autre)
    linked = (np.diff(vis) == 1) & (t1[vis[:-1]] >= 1.0) & (t0[vis[1:]] <= 0.0)
    starts = np.concatenate(([0], np.nonzero(~linked)[0] + 1))
    pts = np.insert(S1, starts, S0[starts], axis=0)
    col = np.insert(C1, starts, C0[starts], axis=0)
    bounds = np.append(starts + np.arange(len(starts)), len(pts))
    first_seg = np.cumsum(lens) - lens               # premier et dernier segment de chaque tracé
    last_seg = np.cumsum(lens) - 2
    run_end = np.append(starts[1:], len(vis)) - 1
    for k in range(len(starts)):
        a, z = vis[starts[k]], vis[run_end[k]]
        i = int(item[a])
        out[i].append((pts[bounds[k]:bounds[k + 1]], col[bounds[k]:bounds[k + 1]],
                       a == first_seg[i] and t0[a] <= 0.0, z == last_seg[i] and t1[z] >= 1.0))
    res = []
    for s, pieces in zip(strokes, out):
        # Tracé fermé coupé ailleurs qu'à son point de départ : le dernier morceau rejoint le premier
        if s.closed and len(pieces) > 1 and pieces[0][2] and pieces[-1][3]:
            (pl, cl, _, _), (pf, cf, _, _) = pieces[-1], pieces[0]
            pieces = [(np.vstack((pl, pf[1:])), np.vstack((cl, cf[1:])), False, False)] + pieces[1:-1]
        res.append([Stroke(p, c, False) for p, c, _, _ in pieces
                    if len(p) >= 2 and np.abs(np.diff(p, axis=0)).sum() > 1e-6])
    return res


def rdp_index(X, eps):
    """Indices conservés par Ramer-Douglas-Peucker sur des points de dimension quelconque."""
    n = len(X)
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a = X[i]
        ab = X[j] - a
        seg = X[i + 1:j] - a
        L2 = float(ab @ ab)
        if L2 < 1e-18:
            d = np.sqrt((seg * seg).sum(axis=1))
        else:
            proj = (seg @ ab) / L2
            d = np.sqrt(((seg - proj[:, None] * ab) ** 2).sum(axis=1))
        k = int(np.argmax(d))
        if d[k] > eps:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return np.nonzero(keep)[0]


def cap_raw(strokes):
    """Plafonds par image : nombre de tracés et de sommets (géométries extrêmes seulement)."""
    if len(strokes) > MAX_RAW_STROKES:
        strokes = strokes[:MAX_RAW_STROKES]
    total = sum(len(s.pts) for s in strokes)
    if total <= MAX_RAW_POINTS:
        return strokes, False
    k = MAX_RAW_POINTS / total
    out = []
    for s in strokes:
        n = len(s.pts)
        m = max(2 if s.kind == "line" else 1, int(n * k))
        if m < n:
            idx = np.unique(np.round(np.linspace(0, n - 1, m)).astype(int))
            s = Stroke(s.pts[idx], s.col[idx], s.closed, s.kind, s.dwell)
        out.append(s)
    return out, True


__all__ = ["clip_strokes", "cap_raw", "rdp_index", "MERGE_EPS", "COLOR_EPS"]
