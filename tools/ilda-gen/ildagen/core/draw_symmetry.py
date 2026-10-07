"""Symétrie de dessin : le crayon et les formes créent directement leurs copies miroir / tournées.

Aide au dessin comme la grille (pas un modifieur) : les copies sont de vrais tracés, autour du centre
de la mire.
"""

from . import mathutil as mu

# (identifiant, libellé)
MODES = [
    (0, "Aucune"),
    (1, "Miroir gauche / droite"),
    (2, "Miroir haut / bas"),
    (3, "Miroir 4 quarts"),
    (4, "Radiale"),
    (5, "Kaléidoscope"),
]
LABELS = dict(MODES)
COUNTS = (2, 3, 4, 5, 6, 8, 10, 12, 16)


def matrices(grid):
    """Matrices « monde » des copies (l'original n'en fait pas partie)."""
    mode = getattr(grid, "sym", 0)
    n = max(2, int(getattr(grid, "sym_count", 6)))
    flip_x, flip_y = mu.scaling(-1.0, 1.0), mu.scaling(1.0, -1.0)
    if mode == 1:
        return [flip_x]
    if mode == 2:
        return [flip_y]
    if mode == 3:
        return [flip_x, flip_y, mu.scaling(-1.0, -1.0)]
    rots = [mu.rotation(360.0 * k / n) for k in range(1, n)]
    if mode == 4:
        return rots
    if mode == 5:
        return rots + [r @ flip_y for r in [mu.scaling(1.0, 1.0)] + rots]
    return []


def axes(grid):
    """Angles (degrés) des axes à afficher dans la mire."""
    mode = getattr(grid, "sym", 0)
    n = max(2, int(getattr(grid, "sym_count", 6)))
    if mode == 1:
        return [90.0]
    if mode == 2:
        return [0.0]
    if mode == 3:
        return [0.0, 90.0]
    if mode == 4:
        return [90.0 + 360.0 * k / n for k in range(n)]
    if mode == 5:
        return [180.0 * k / n for k in range(n)]
    return []


def describe(grid):
    mode = getattr(grid, "sym", 0)
    if mode in (4, 5):
        return f"{LABELS[mode]} ×{grid.sym_count}"
    return LABELS.get(mode, "Aucune")
