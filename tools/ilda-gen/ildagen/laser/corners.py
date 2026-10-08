"""Détection des coins (où le faisceau doit marquer un temps d'arrêt), pour tous les tracés d'un coup.

- les segments de longueur nulle (points doublés pour un changement net de couleur) n'ont pas de direction :
  ils prennent celle du segment précédent, ils ne créent donc pas de faux coin ;
- un coin réparti sur plusieurs segments minuscules (coin arrondi, tracé très dense) est vu comme UN coin :
  on additionne les virages sur une courte longueur et on garde le sommet où ce cumul est le plus fort ;
- boucle (dernier point = premier) : le virage de fermeture est porté par le DERNIER sommet (arrivée du faisceau).
"""

import numpy as np

WINDOW = 0.006          # longueur (unités de la mire) sur laquelle les petits virages s'additionnent
MAX_NEIGHBOURS = 32     # sommets examinés de chaque côté pour garder le plus fort virage
DEGENERATE = 1e-5
GAP = 10.0              # écart fictif entre deux tracés : les fenêtres ne débordent jamais sur le voisin


def _wrap(a):
    return (a + np.pi) % (2 * np.pi) - np.pi


def corner_turns(P, item, start, line, loop):
    """Virage (degrés, ≥ 0) à chaque sommet. P (N, 2) sommets de tous les tracés à la suite ; item (N,) tracé
    de chaque sommet ; start (n + 1,) début de chaque tracé ; line (n,) tracé continu (pas des points) ;
    loop (n,) boucle."""
    N = len(P)
    turn = np.zeros(N)
    if N < 3:
        return turn
    D = np.diff(P, axis=0)
    L = np.hypot(D[:, 0], D[:, 1])
    seg_item = item[:-1]
    valid = (item[1:] == seg_item) & line[seg_item]          # segment à l'intérieur d'une ligne
    good = valid & (L > DEGENERATE)
    if not good.any():
        return turn
    ang = np.arctan2(D[:, 1], D[:, 0])
    # Direction des segments nuls : celle du segment valable précédent du même tracé, sinon du suivant
    idx = np.maximum.accumulate(np.where(good, np.arange(N - 1), -1))
    first_good = np.minimum.reduceat(np.append(np.where(good, np.arange(N - 1), N), N), start[:-1])
    fallback = first_good[np.minimum(seg_item, len(first_good) - 1)]
    ok = (idx >= 0) & (seg_item[np.maximum(idx, 0)] == seg_item)
    ang = ang[np.clip(np.where(ok, idx, fallback), 0, N - 2)]
    t = np.zeros(N)
    inner = np.zeros(N, dtype=bool)
    inner[1:-1] = valid[:-1] & valid[1:]
    t[inner] = _wrap(ang[1:][inner[1:-1]] - ang[:-1][inner[1:-1]])
    first, last = start[:-1], start[1:] - 1
    closing = loop & line & (last - first >= 2)
    t[first[closing]] = _wrap(ang[first[closing]] - ang[last[closing] - 1])
    if (L[good] < WINDOW).any():
        t = _windowed(t, np.where(valid, L, GAP))
    turn = np.degrees(np.abs(t))
    turn[last[closing]] = turn[first[closing]]
    turn[first[closing]] = 0.0
    return turn


def _windowed(t, L):
    """Virages cumulés sur ±WINDOW, en ne gardant que le sommet le plus marqué de chaque coin."""
    s = np.concatenate(([0.0], np.cumsum(L)))
    T = np.concatenate(([0.0], np.cumsum(t)))
    lo = np.searchsorted(s, s - WINDOW, side="left")
    hi = np.searchsorted(s, s + WINDOW, side="right")
    wt = T[hi] - T[lo]
    a = np.abs(wt)
    keep = np.ones(len(t), dtype=bool)
    j = np.arange(len(t))
    span = int(min(MAX_NEIGHBOURS, max(1, int((hi - j).max()), int((j - lo).max()))))
    for off in range(1, span + 1):
        before = j - off
        ok = before >= lo
        keep[ok] &= ~(a[before[ok]] >= a[ok])          # un sommet plus tôt aussi marqué l'emporte
        after = j + off
        ok = after < hi
        keep[ok] &= ~(a[after[ok]] > a[ok])
    return np.where(keep, wt, 0.0)
