"""Ordre de tracé : plus proche voisin (calcul vectorisé), stable d'une image à l'autre.

Chaque tracé a un point d'entrée et un point de sortie ; un tracé ouvert (ou une suite de points) peut être
parcouru à l'envers. L'ordre de l'image précédente est gardé tant qu'il reste presque aussi bon : sans cela
une animation ferait sauter l'ordre (et le sens) d'une image à l'autre, ce qui scintille.
"""

import numpy as np

KEEP_MARGIN = 0.15      # l'ancien ordre est gardé s'il ne fait pas plus de 15 % de trajet éteint en plus
KEEP_SLACK = 0.05       # … ou moins de 0,05 unité de plus (petits trajets)


def greedy(starts, ends, reversible, origin=(0.0, 0.0)):
    """Plus proche voisin depuis origin. Renvoie (ordre, sens inversé)."""
    n = len(starts)
    # Entrées possibles : début de chaque tracé, ou sa fin s'il est réversible ; une entrée prise est
    # « empoisonnée » (infini) et le tableau est compacté de temps en temps
    x = np.concatenate((starts[:, 0], np.where(reversible, ends[:, 0], np.inf)))
    y = np.concatenate((starts[:, 1], ends[:, 1]))
    ids = np.arange(2 * n)
    where = np.arange(2 * n)                         # position de chaque entrée dans x, y
    alive = n + int(reversible.sum())
    order = np.empty(n, dtype=int)
    rev = np.zeros(n, dtype=bool)
    cx, cy = origin
    for k in range(n):
        j = int(np.argmin((x - cx) ** 2 + (y - cy) ** 2))
        c = int(ids[j])
        i, r = (c, False) if c < n else (c - n, True)
        order[k], rev[k] = i, r
        for e in (i, i + n):
            if where[e] >= 0 and np.isfinite(x[where[e]]):
                alive -= 1
            if where[e] >= 0:
                x[where[e]] = np.inf
        cx, cy = (starts[i] if r else ends[i])
        if alive * 2 < len(x) and len(x) > 64:
            keep = np.isfinite(x)
            x, y, ids = x[keep], y[keep], ids[keep]
            where[:] = -1
            where[ids] = np.arange(len(ids))
    return order, rev


def travel(starts, ends, order, rev):
    """Longueur totale des trajets éteints (retour au premier tracé compris : l'image boucle)."""
    rv = rev[:, None]
    entry = np.where(rv, ends[order], starts[order])
    exit_ = np.where(rv, starts[order], ends[order])
    d = np.roll(entry, -1, axis=0) - exit_
    return float(np.hypot(d[:, 0], d[:, 1]).sum())


def plan(starts, ends, reversible, previous=None):
    """(ordre, sens inversé, coût de référence). previous : résultat pour l'image précédente.
    Tant que l'ancien ordre ne coûte pas nettement plus qu'au moment où il a été choisi, il est gardé
    tel quel (pas de recalcul) ; sinon il n'est remplacé que si le nouveau est nettement meilleur."""
    n = len(starts)
    if n == 0:
        return np.zeros(0, dtype=int), np.zeros(0, dtype=bool), 0.0
    old = None
    if previous is not None and len(previous[0]) == n:
        p_order, p_rev, ref = previous
        p_rev = p_rev & reversible[p_order]
        cost_old = travel(starts, ends, p_order, p_rev)
        if cost_old <= ref * (1.0 + KEEP_MARGIN) + KEEP_SLACK:
            return p_order, p_rev, ref
        old = (p_order, p_rev, cost_old)
    order, rev = greedy(starts, ends, reversible)
    cost_new = travel(starts, ends, order, rev)
    if old is not None and old[2] <= cost_new * (1.0 + KEEP_MARGIN) + KEEP_SLACK:
        return old[0], old[1], cost_new
    return order, rev, cost_new
