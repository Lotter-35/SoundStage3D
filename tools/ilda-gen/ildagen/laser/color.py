"""Couleurs de sortie : correction (gain R/V/B, gamma, seuil), décalage couleur, sécurité « anti point fixe »."""

import numpy as np

REF_KPPS = 30.0
STATIC_RADIUS = 0.01      # tous les points allumés dans ce rayon (unités de la mire) = faisceau immobile


def correct(col, c):
    """col (N, 3) 0..1 → couleurs corrigées. c : réglages « color » (valeurs neutres = inchangé)."""
    gains = np.array([c.get("gain_r", 100.0), c.get("gain_g", 100.0), c.get("gain_b", 100.0)], dtype=float) / 100.0
    gamma = max(0.1, float(c.get("gamma", 1.0)))
    out = col
    if np.any(gains != 1.0):
        out = out * gains
    if gamma != 1.0:
        out = np.clip(out, 0.0, 1.0) ** gamma
    thr = float(c.get("min_power", 0.0)) / 100.0
    if thr > 0:
        dim = out.max(axis=1) < thr                 # sous le seuil : la diode ne s'allume pas proprement
        if dim.any():
            out = np.where(dim[:, None], 0.0, out)
    return out


def shift(col, points, kpps):
    """Couleurs retardées de « points » points (réglés à 30 kpps) : le faisceau, en retard sur la commande,
    est allumé au bon endroit. L'image boucle : le décalage est circulaire."""
    n = int(round(float(points) * float(kpps) / REF_KPPS))
    if n == 0 or len(col) < 2:
        return col
    return np.roll(col, n % len(col), axis=0)


def is_static(xy, lit, radius=STATIC_RADIUS):
    """Vrai si tous les points allumés tiennent dans un tout petit disque (faisceau fixe : dangereux)."""
    if not lit.any():
        return False
    p = xy[lit]
    c = (p.min(axis=0) + p.max(axis=0)) / 2
    return float(np.hypot(*(p - c).T).max()) <= radius
