"""Tracés (géométrie pure) et tracés colorés (sortie de l'évaluation)."""

import numpy as np


class Path:
    """Polyligne ouverte ou fermée, coordonnées normalisées."""

    __slots__ = ("pts", "closed")

    def __init__(self, pts, closed=False):
        self.pts = np.asarray(pts, dtype=float).reshape(-1, 2)
        self.closed = bool(closed)

    def copy(self):
        return Path(self.pts.copy(), self.closed)

    def to_dict(self):
        return {"p": [round(float(v), 5) for v in self.pts.ravel()], "c": self.closed}

    @classmethod
    def from_dict(cls, d):
        return cls(np.array(d.get("p", []), dtype=float).reshape(-1, 2), d.get("c", False))


class Stroke:
    """Tracé coloré prêt pour la sortie laser.

    kind = "line" : polyligne allumée ; kind = "dots" : chaque point est un point isolé
    (le faisceau s'y arrête « dwell » fois, éteint entre deux points).
    """

    __slots__ = ("pts", "col", "closed", "kind", "dwell")

    def __init__(self, pts, col=None, closed=False, kind="line", dwell=0, color=(1.0, 1.0, 1.0)):
        self.pts = np.asarray(pts, dtype=float).reshape(-1, 2)
        if col is None:
            col = np.tile(np.asarray(color, dtype=float), (len(self.pts), 1))
        self.col = np.asarray(col, dtype=float).reshape(-1, 3)
        self.closed = closed
        self.kind = kind
        self.dwell = dwell

    def copy(self):
        return Stroke(self.pts.copy(), self.col.copy(), self.closed, self.kind, self.dwell)

    def with_pts(self, pts):
        return Stroke(pts, self.col.copy(), self.closed, self.kind, self.dwell)

    def with_col(self, col):
        return Stroke(self.pts.copy(), col, self.closed, self.kind, self.dwell)


# ── Mesures le long d'un tracé ───────────────────────────────────────────────

def closed_pts(pts, closed):
    """Points avec le premier répété à la fin si le tracé est fermé."""
    if closed and len(pts) > 1:
        return np.vstack((pts, pts[:1]))
    return pts


def cumulative(pts):
    """Longueurs cumulées (N,) d'une polyligne."""
    if len(pts) < 2:
        return np.zeros(len(pts))
    d = np.hypot(*np.diff(pts, axis=0).T)
    return np.concatenate(([0.0], np.cumsum(d)))


def sample_at(pts, cum, s):
    """Positions (M, 2) aux abscisses curvilignes s (M,)."""
    if len(pts) == 1:
        return np.repeat(pts, len(s), axis=0), np.zeros(len(s), dtype=int), np.zeros(len(s))
    idx = np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(pts) - 2)
    seg = cum[idx + 1] - cum[idx]
    t = np.where(seg > 1e-12, (s - cum[idx]) / np.where(seg > 1e-12, seg, 1.0), 0.0)
    t = np.clip(t, 0.0, 1.0)
    out = pts[idx] + (pts[idx + 1] - pts[idx]) * t[:, None]
    return out, idx, t


def resample_stroke(s, step):
    """Insère des points pour qu'aucun segment ne dépasse « step » (couleurs interpolées)."""
    if s.kind != "line" or len(s.pts) < 2:
        return s.copy()
    pts = closed_pts(s.pts, s.closed)
    col = closed_pts(s.col, s.closed)
    out_p = [pts[:1]]
    out_c = [col[:1]]
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        d = float(np.hypot(*(b - a)))
        n = max(1, int(np.ceil(d / step)))
        t = (np.arange(1, n + 1) / n)[:, None]
        out_p.append(a + (b - a) * t)
        out_c.append(col[i - 1] + (col[i] - col[i - 1]) * t)
    p = np.vstack(out_p)
    c = np.vstack(out_c)
    if s.closed:
        p, c = p[:-1], c[:-1]
    return Stroke(p, c, s.closed, s.kind, s.dwell)


def rdp(pts, eps):
    """Simplification Ramer-Douglas-Peucker."""
    n = len(pts)
    if n < 3 or eps <= 0:
        return pts
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts[i], pts[j]
        ab = b - a
        L = float(np.hypot(*ab))
        seg = pts[i + 1:j]
        if L < 1e-12:
            d = np.hypot(*(seg - a).T)
        else:
            d = np.abs(ab[0] * (seg[:, 1] - a[1]) - ab[1] * (seg[:, 0] - a[0])) / L
        k = int(np.argmax(d))
        if d[k] > eps:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return pts[keep]


def smooth(pts, window):
    """Moyenne glissante (extrémités conservées)."""
    if window < 2 or len(pts) < 3:
        return pts
    w = min(window, len(pts) - 1)
    k = np.ones(w) / w
    pad = w // 2
    padded = np.vstack([np.repeat(pts[:1], pad, axis=0), pts, np.repeat(pts[-1:], w - 1 - pad, axis=0)])
    out = np.column_stack([np.convolve(padded[:, 0], k, mode="valid"), np.convolve(padded[:, 1], k, mode="valid")])
    out[0] = pts[0]
    out[-1] = pts[-1]
    return out


def strokes_bbox(strokes):
    pts = [s.pts for s in strokes if len(s.pts)]
    if not pts:
        return None
    a = np.vstack(pts)
    return float(a[:, 0].min()), float(a[:, 1].min()), float(a[:, 0].max()), float(a[:, 1].max())
