"""Tracés colorés → suite de points laser (H4 : optimisation des points).

- les tracés sont découpés au champ AVANT d'ajouter des points, puis nettoyés (points confondus fusionnés,
  sauf aux changements nets de couleur) ;
- les segments trop longs sont découpés (le galvo ne doit pas sauter trop loin d'un point à l'autre) ;
- les coins sont répétés (« dwell ») selon leur angle, coin de fermeture des formes fermées compris ;
- les déplacements entre deux tracés sont faits laser éteint (blanking), avec accélération et freinage ;
- les tracés sont ordonnés pour réduire les sauts, sans changer d'ordre d'une image à l'autre ;
- l'image tient dans un BUDGET de points (vitesse de balayage / images par seconde) : au-delà, les points
  sont espacés, les temps d'arrêt raccourcis, les tracés simplifiés, et en dernier recours éclaircis.

Modèle : tous les sommets à la suite sont des « nœuds » (chacun émis 1 fois + son temps d'arrêt) reliés par des
« arêtes » allumées (points intermédiaires interpolés) ou éteintes (trajet accéléré / freiné). Le comptage et
la construction utilisent les mêmes tailles : l'image construite fait exactement le nombre de points compté.
Les nombres de points (coins, extrémités, blanking) sont réglés « à 30 kpps » et suivent la vitesse de balayage.
"""

import numpy as np

from . import ordering
from .batch import from_strokes, simplify
from .clipping import cap_raw, clip_strokes
from .thinning import pre_thin, thin

MIN_LIGHT = 1.0 / 255.0
REF_KPPS = 30.0
Q_MIN = 0.05                     # qualité minimale (pas ×20, temps d'arrêt quasi nuls)
SIMPLIFY = (0.003, 0.01, 0.03)  # tolérances de simplification essayées tour à tour
MAX_SIMPLIFY = 64                # au-delà de tant de lignes à simplifier, on éclaircit directement (plus rapide)
DEFAULTS = {"scan_kpps": 30.0, "max_step": 0.03, "blank_base": 4, "blank_per_unit": 8, "blank_pre": 0,
            "blank_post": 0, "corner_dwell": 3, "corner_angle": 30, "end_dwell": 3, "reorder": True}


class Optimized:
    """Résultat : points (M, 2), couleurs (M, 3) 0..1, image réduite pour tenir le budget, ordre (pour la suivante)."""

    __slots__ = ("pts", "col", "reduced", "order")

    def __init__(self, pts, col, reduced=False, order=None):
        self.pts, self.col, self.reduced, self.order = pts, col, reduced, order


def _cfg(cfg):
    out = dict(DEFAULTS)
    out.update({k: v for k, v in (cfg or {}).items() if k in DEFAULTS})
    return out


class _Plan:
    """Tailles des blocs (nœuds, arêtes) d'une image pour une qualité q, et construction des points."""

    def __init__(self, b, cfg):
        self.b, self.cfg = b, cfg
        self.k = max(0.05, float(cfg["scan_kpps"]) / REF_KPPS)
        n, N = b.n, len(b.P)
        item = b.item_of_vertex()
        self.dot = b.dots[item]
        first = np.zeros(N, dtype=bool)
        first[b.start[:-1]] = True
        last = np.zeros(N, dtype=bool)
        last[b.start[1:] - 1] = True
        self.ends = (first.astype(int) + last) * (~b.dots & ~b.loop)[item]       # extrémités des lignes ouvertes
        # Coin de fermeture d'une boucle : le point de départ (allumé au début) compte déjà pour une répétition
        self.closing = (last & b.loop[item]).astype(int)
        self.corner = np.where(b.turn >= float(cfg["corner_angle"]), np.clip(b.turn / 90.0, 0.0, 2.0), 0.0)
        self.dwell = b.dwell[item].astype(float)
        D = np.diff(b.P, axis=0)
        self.L = np.hypot(D[:, 0], D[:, 1])
        self.lit = (item[1:] == item[:-1]) & ~b.dots[item[:-1]]                  # arête à l'intérieur d'une ligne
        self.wrap = None
        if n and not (n == 1 and b.loop[0]):
            self.wrap = float(np.hypot(*(b.P[0] - b.P[-1])))                    # retour au début : l'image boucle

    def n(self, base, q):
        return int(round(float(base) * self.k * q))

    def _blank(self, d, q):
        c = self.cfg
        m = np.maximum(1, np.round((float(c["blank_base"]) + d * float(c["blank_per_unit"])) * self.k * q))
        return m.astype(int) + self.n(c["blank_pre"], q) + self.n(c["blank_post"], q)

    def sizes(self, q):
        """(points émis par nœud, points de chaque arête, points du retour au début)."""
        c = self.cfg
        step = max(0.002, float(c["max_step"])) / q
        dw = np.round(float(c["corner_dwell"]) * self.k * q * self.corner)
        emit = np.where(self.dot, np.maximum(1, np.round(self.dwell * self.k * q)),
                        1 + np.maximum(0, dw - self.closing) + self.ends * self.n(c["end_dwell"], q)).astype(int)
        edges = np.where(self.lit, np.maximum(1, np.ceil(self.L / step)) - 1, self._blank(self.L, q)).astype(int)
        wrap = int(self._blank(np.array([self.wrap]), q)[0]) if self.wrap is not None else 0
        return emit, edges, wrap

    def count(self, q):
        emit, edges, wrap = self.sizes(q)
        return int(emit.sum() + edges.sum()) + wrap

    def build(self, q):
        b = self.b
        emit, edges, wrap = self.sizes(q)
        N = len(b.P)
        e_all = np.append(edges, wrap)                     # arête i : du nœud i au nœud i + 1 (le dernier : retour)
        blocks = np.empty(2 * N, dtype=int)
        blocks[0::2], blocks[1::2] = emit, e_all
        off = np.cumsum(blocks) - blocks
        total = int(blocks.sum())
        out_p = np.empty((total, 2))
        out_c = np.zeros((total, 3))
        # Nœuds : le sommet, répété (temps d'arrêt)
        node = np.repeat(np.arange(N), emit)
        slot = np.repeat(off[0::2], emit) + np.arange(len(node)) - np.repeat(np.cumsum(emit) - emit, emit)
        out_p[slot], out_c[slot] = b.P[node], b.C[node]
        # Arêtes : points intermédiaires allumés, ou trajet éteint (arrêt, accélération / freinage, arrêt)
        e = np.repeat(np.arange(N), e_all)
        j = np.arange(len(e)) - np.repeat(np.cumsum(e_all) - e_all, e_all)
        slot = np.repeat(off[1::2], e_all) + j
        A, B = b.P[e], b.P[(e + 1) % N]
        lit = np.append(self.lit, False)[e]
        cnt = e_all[e].astype(float)
        post, pre = self.n(self.cfg["blank_post"], q), self.n(self.cfg["blank_pre"], q)
        u = np.clip((j - post + 1) / np.maximum(1.0, cnt - post - pre), 0.0, 1.0)
        t = np.where(lit, (j + 1) / (cnt + 1), u * u * (3.0 - 2.0 * u))
        out_p[slot] = A + (B - A) * t[:, None]
        CA, CB = b.C[e], b.C[(e + 1) % N]
        out_c[slot] = np.where(lit[:, None], CA + (CB - CA) * t[:, None], 0.0)
        return out_p, np.clip(out_c, 0.0, 1.0)


def _fit(plan, budget):
    """Meilleure qualité q (≤ 1) qui tient dans le budget, ou None."""
    if plan.count(1.0) <= budget:
        return 1.0
    if plan.count(Q_MIN) > budget:
        return None
    lo, hi = Q_MIN, 1.0
    for _ in range(14):
        mid = (lo + hi) / 2
        if plan.count(mid) <= budget:
            lo = mid
        else:
            hi = mid
    return lo


def _lit(strokes):
    """Tracés qui allument au moins un point (tous d'un coup : il peut y en avoir des milliers)."""
    strokes = [s for s in strokes if len(s.pts) and len(s.col) == len(s.pts)]
    if not strokes:
        return []
    lens = np.array([len(s.col) for s in strokes])
    peak = np.maximum.reduceat(np.concatenate([s.col for s in strokes]).max(axis=1), np.cumsum(lens) - lens)
    return [s for s, m in zip(strokes, peak) if m >= MIN_LIGHT]


def _order(b, cfg, previous):
    if b.n < 2 or not cfg["reorder"]:
        return b, None
    first, last = b.start[:-1], b.start[1:] - 1
    order, rev, ref = ordering.plan(b.P[first], b.P[last], ~b.loop, previous)
    return b.take(order, rev), (order, rev, ref)


def optimize(strokes, cfg=None, budget=None, previous=None):
    """Tracés → points laser tenant dans « budget » points (None : pas de limite)."""
    cfg = _cfg(cfg)
    strokes, reduced = cap_raw(clip_strokes(_lit(strokes)))
    if budget is not None:
        budget = max(8, int(budget))
        strokes, thinned = pre_thin(strokes, budget)
        reduced = reduced or thinned
    b = from_strokes(strokes, cfg)
    if b.n == 0:
        return Optimized(np.zeros((0, 2)), np.zeros((0, 3)), reduced)
    b, order = _order(b, cfg, previous)
    plan = _Plan(b, cfg)
    q = 1.0 if budget is None else _fit(plan, budget)
    if q is None:
        reduced = True
        # Tracés simplifiés, de plus en plus fort… sauf si même au mieux cela ne suffirait pas
        # (chaque sommet retiré fait gagner au moins un point ; une ligne garde au moins 2 ou 3 sommets)
        extra = np.maximum(0, b.sizes() - np.where(b.loop, 3, 2)) * ~b.dots
        useful = plan.count(Q_MIN) - int(extra.sum()) <= budget and np.count_nonzero(extra) <= MAX_SIMPLIFY
        for eps in (SIMPLIFY if useful else ()):
            plan = _Plan(simplify(b, eps), cfg)
            q = _fit(plan, budget)
            if q is not None:
                break
        base, ratio = plan.b, 1.0
        while q is None and ratio > 1e-4:          # éclaircissement régulier des tracés / points
            ratio *= min(0.9, budget / max(1, plan.count(Q_MIN)))
            plan = _Plan(thin(base, ratio), cfg)
            q = _fit(plan, budget)
    p, c = plan.build(q if q is not None else Q_MIN)
    if budget is not None and len(p) > budget:     # garde-fou absolu
        idx = np.round(np.linspace(0, len(p) - 1, budget)).astype(int)
        p, c = p[idx], c[idx]
    return Optimized(p, c, reduced or q is None or q < 1.0, order)


def build_points(strokes, cfg=None, budget=None):
    """Renvoie (points (M, 2), couleurs (M, 3) 0..1). Image vide : aucun point."""
    r = optimize(strokes, cfg, budget)
    return r.pts, r.col
