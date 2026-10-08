"""Effets sans modifieur équivalent dans l'espace Forme : Masquer, Éclatement.

Écrits comme des modifieurs (même interface `apply(strokes, p, ctx)`), mais pas proposés dans la liste des
modifieurs : ils servent seulement aux effets d'animation.
"""

import numpy as np

from ..modifiers.base import Modifier
from ..params import B, E, F
from ..path import strokes_bbox

BURST_CENTERS = ["Centre de la forme", "Centre de la mire"]


class Hide(Modifier):
    type_id = "hide"
    label = "Masquer"
    icon = "eye-off"
    description = "Fait disparaître la forme (ou le calque visé) : à animer en courbe pour la faire clignoter."
    params = [B("hidden", "Masqué", True)]

    def apply(self, strokes, p, ctx):
        return [] if p["hidden"] else strokes


class Burst(Modifier):
    type_id = "burst"
    label = "Éclatement"
    icon = "maximize"
    description = "Écarte chaque tracé du centre, d'une même distance."
    params = [F("amount", "Écart", 0.2, -2.0, 4.0, decimals=3, soft_min=0.0, soft_max=1.0),
              E("center", "Centre", BURST_CENTERS)]

    def apply(self, strokes, p, ctx):
        amount = float(p["amount"])
        if amount == 0 or not strokes:
            return strokes
        if int(p["center"]) == 1:
            cx, cy = 0.0, 0.0
        else:
            b = strokes_bbox(strokes)
            if b is None:
                return strokes
            cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        out = []
        for s in strokes:
            if len(s.pts) == 0:
                out.append(s.copy())
                continue
            c = s.pts.mean(axis=0)
            d = np.array([c[0] - cx, c[1] - cy])
            n = float(np.hypot(*d))
            if n < 1e-9:
                out.append(s.copy())        # tracé centré : pas de direction, il reste en place
                continue
            out.append(s.with_pts(s.pts + d / n * amount))
        return out
