"""Tracés préparés pour l'optimiseur, rangés dans des tableaux à la suite (calcul vectorisé, même avec des
centaines de tirets ou de copies).

Un « élément » est une ligne (sommets reliés, allumés) ou une suite de points isolés (Dots, Beams).
"""

import numpy as np

from .clipping import COLOR_EPS, MERGE_EPS, rdp_index
from .corners import corner_turns

DENSE_EPS = 0.0005      # simplification invisible des tracés très denses (masque, onde…)
DENSE_PASSES = 12       # passes de retrait des sommets alignés (chacune retire au plus un sommet sur deux)


class Batch:
    """P (N, 2), C (N, 3) : sommets de tous les éléments à la suite ; start (n + 1,) : début de chaque élément ;
    dots / loop / closed (n,) : nature des éléments ; dwell (n,) : éclat des points ; turn (N,) : virage (°)."""

    def __init__(self, P, C, start, dots, closed, dwell):
        self.P, self.C, self.start = P, C, start
        self.dots, self.closed, self.dwell = dots, closed, dwell
        self.loop = np.zeros(len(dots), dtype=bool)
        self.turn = np.zeros(len(P))

    @property
    def n(self):
        return len(self.dots)

    def sizes(self):
        return np.diff(self.start)

    def item_of_vertex(self):
        return np.repeat(np.arange(self.n), self.sizes())

    def take(self, order, rev=None):
        """Éléments dans l'ordre donné, éventuellement parcourus à l'envers."""
        lens = self.sizes()[order]
        new_start = np.concatenate(([0], np.cumsum(lens)))
        local = np.arange(int(new_start[-1])) - np.repeat(new_start[:-1], lens)
        if rev is not None:
            local = np.where(np.repeat(rev, lens), np.repeat(lens, lens) - 1 - local, local)
        src = np.repeat(self.start[order], lens) + local
        b = Batch(self.P[src], self.C[src], new_start, self.dots[order], self.closed[order], self.dwell[order])
        b.loop, b.turn = self.loop[order], self.turn[src]
        return b

    def keep_vertices(self, keep):
        """Garde certains sommets (les éléments vidés disparaissent)."""
        item = self.item_of_vertex()[keep]
        counts = np.bincount(item, minlength=self.n)
        alive = counts > 0
        b = Batch(self.P[keep], self.C[keep], np.concatenate(([0], np.cumsum(counts[alive]))),
                  self.dots[alive], self.closed[alive], self.dwell[alive])
        b.loop, b.turn = self.loop[alive], self.turn[keep]
        return b


def from_strokes(strokes, cfg):
    """Tracés (déjà découpés au champ) → Batch nettoyé, coins calculés, boucles commençant sur leur coin."""
    if not strokes:
        z = np.zeros(0, dtype=bool)
        return Batch(np.zeros((0, 2)), np.zeros((0, 3)), np.zeros(1, dtype=int), z, z, np.zeros(0, dtype=int))
    lens = np.array([len(s.pts) for s in strokes])
    dots = np.array([s.kind == "dots" for s in strokes])
    closed = np.array([bool(s.closed) and s.kind != "dots" and len(s.pts) > 1 for s in strokes])
    dwell = np.array([max(1, int(s.dwell)) if s.kind == "dots" else 0 for s in strokes])
    P = np.concatenate([s.pts for s in strokes])
    C = np.concatenate([s.col for s in strokes])
    # Formes fermées : le premier point est répété à la fin
    full = lens + closed
    start = np.concatenate(([0], np.cumsum(full)))
    src_start = np.concatenate(([0], np.cumsum(lens)))[:-1]
    local = np.arange(int(start[-1])) - np.repeat(start[:-1], full)
    src = np.repeat(src_start, full) + np.where(local >= np.repeat(lens, full), 0, local)
    b = Batch(P[src], C[src], start, dots, closed, dwell)
    return finish(b, cfg, rotate=True)


def finish(b, cfg, rotate=False):
    """Fusion des points confondus, points isolés, boucles, coins (et départ des boucles sur leur coin)."""
    b = _merge(b)
    single = (b.sizes() == 1) & ~b.dots
    if single.any():
        # Ligne réduite à un point : point isolé bien visible
        b.dots = b.dots | single
        b.dwell = np.where(single, max(int(cfg["end_dwell"]) + 1, 10), b.dwell)
    b = _dense(b, cfg)
    first, last = b.start[:-1], b.start[1:] - 1
    b.loop = ~b.dots & (b.sizes() > 2) & (np.abs(b.P[last] - b.P[first]).max(axis=1) <= MERGE_EPS)
    b.turn = corner_turns(b.P, b.item_of_vertex(), b.start, ~b.dots, b.loop)
    if rotate:
        b = _rotate(b, float(cfg["corner_angle"]))
    return b


def _merge(b):
    """Retire les points d'une ligne confondus avec le précédent, sauf s'ils changent la couleur."""
    if len(b.P) < 2:
        return b
    item = b.item_of_vertex()
    same = ((np.abs(np.diff(b.P, axis=0)).max(axis=1) <= MERGE_EPS)
            & (np.abs(np.diff(b.C, axis=0)).max(axis=1) <= COLOR_EPS)
            & (item[1:] == item[:-1]) & ~b.dots[item[1:]])
    if not same.any():
        return b
    return b.keep_vertices(np.concatenate(([True], ~same)))


def _dense(b, cfg):
    """Lignes très denses (bien plus de sommets que de points à tracer : masque, onde…) : les sommets alignés
    de même couleur sont retirés, sans perte visible. Tout d'un coup, par passes alternées (un sommet sur deux)."""
    sizes = b.sizes()
    item = b.item_of_vertex()
    D = np.diff(b.P, axis=0)
    L = np.where(item[1:] == item[:-1], np.hypot(D[:, 0], D[:, 1]), 0.0)
    length = np.add.reduceat(np.append(L, 0.0), b.start[:-1])
    half = max(0.002, float(cfg["max_step"])) / 2
    dense = ~b.dots & (sizes > 16) & (length < half * np.maximum(1, sizes - 1))
    if not dense.any():
        return b
    pos = np.arange(len(b.P)) - b.start[item]
    cand = dense[item] & (pos > 0) & (pos < sizes[item] - 1)    # extrémités toujours gardées
    keep = np.ones(len(b.P), dtype=bool)
    for k in range(DENSE_PASSES):
        idx = np.flatnonzero(keep)
        p, c, n = idx[:-2], idx[1:-1], idx[2:]
        sel = cand[c] & (np.arange(len(c)) % 2 == k % 2)
        p, c, n = p[sel], c[sel], n[sel]
        if len(c) == 0:
            break
        A, M, B = b.P[p], b.P[c], b.P[n]
        AB = B - A
        L2 = np.maximum((AB * AB).sum(axis=1), 1e-18)
        t = np.clip(((M - A) * AB).sum(axis=1) / L2, 0.0, 1.0)
        far = np.hypot(*(M - A - AB * t[:, None]).T) > DENSE_EPS
        da, db = np.hypot(*(M - A).T), np.hypot(*(B - M).T)
        u = (da / np.maximum(da + db, 1e-18))[:, None]
        tint = np.abs(b.C[c] - (b.C[p] + (b.C[n] - b.C[p]) * u)).max(axis=1) > COLOR_EPS
        drop = ~far & ~tint
        keep[c[drop]] = False
    return b if keep.all() else b.keep_vertices(keep)


def simplify(b, eps, items=None):
    """Ramer-Douglas-Peucker sur les lignes choisies (par défaut : toutes celles de plus de 3 sommets)."""
    if items is None:
        items = np.nonzero(~b.dots & (b.sizes() > 3))[0]
    keep = np.ones(len(b.P), dtype=bool)
    for i in items:
        a, z = b.start[i], b.start[i + 1]
        X = np.hstack((b.P[a:z], b.C[a:z] * 0.05))        # la couleur compte un peu : dégradés gardés
        k = np.zeros(z - a, dtype=bool)
        k[rdp_index(X, eps)] = True
        keep[a:z] = k
    return b if keep.all() else b.keep_vertices(keep)


def _rotate(b, angle):
    """Forme fermée : elle commence (et finit) sur son coin le plus marqué, là où le faisceau s'arrête."""
    sizes = b.sizes()
    first, last = b.start[:-1], b.start[1:] - 1
    item = b.item_of_vertex()
    pos = np.arange(len(b.P)) - b.start[item]
    interior = (pos > 0) & (pos < sizes[item] - 1)
    cand = b.closed & b.loop & (sizes > 3)
    if not cand.any():
        return b
    tin = np.where(interior, b.turn, -1.0)
    best = np.maximum.reduceat(tin, first)
    j = np.minimum.reduceat(np.where(interior & (tin == best[item]), pos, 1 << 30), first)
    go = cand & (best >= angle) & (best > b.turn[last])
    if not go.any():
        return b
    k = sizes - 1                                   # sommets distincts (le dernier répète le premier)
    gi = go[item]
    jj, kk = np.where(gi, j[item], 0), k[item]
    rot = np.where(pos < kk, (pos + jj) % np.maximum(kk, 1), jj)
    src = np.where(gi, b.start[item] + rot, np.arange(len(b.P)))
    # Virages des sommets distincts (le sommet 0 porte le virage de fermeture, rangé sur le dernier)
    uniq_turn = np.where(pos == 0, b.turn[last[item]], b.turn)
    new_turn = np.where(pos == 0, 0.0, np.where(pos < kk, uniq_turn[b.start[item] + rot], uniq_turn[b.start[item] + jj]))
    b.P, b.C = b.P[src], b.C[src]
    b.turn = np.where(gi, new_turn, b.turn)
    return b
