"""Symétrie de dessin : ce qu'on dessine est rangé automatiquement sous un modifieur de symétrie.

Le tracé reste simple (un trait = un trait) : les copies viennent du modifieur Symétrie, ajouté tout seul
dans un groupe « Symétrie », centré sur la mire. On peut ensuite le régler ou l'animer comme les autres.
"""


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


GROUP_NAME = "Symétrie"
SYM_TYPES = ("mirror_sym", "radial_sym")


def modifier_spec(grid):
    """(type de modifieur, réglages) correspondant au mode choisi, ou None."""
    mode = getattr(grid, "sym", 0)
    n = max(2, int(getattr(grid, "sym_count", 6)))
    if mode == 1:
        return "mirror_sym", {"axes": 1, "angle": 90.0}
    if mode == 2:
        return "mirror_sym", {"axes": 1, "angle": 0.0}
    if mode == 3:
        return "mirror_sym", {"axes": 2, "angle": 90.0}
    if mode == 4:
        return "radial_sym", {"count": n, "angle": 0.0, "kaleido": False}
    if mode == 5:
        return "mirror_sym", {"axes": n, "angle": 0.0}
    return None


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
