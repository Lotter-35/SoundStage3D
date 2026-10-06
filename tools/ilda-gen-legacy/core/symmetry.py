import math

SYM_MODES_MAPPING = {
    "Désactivé": ("none", 1),
    "x2 Gauche / Droite": ("x2_horiz", 2),
    "x2 Haut / Bas": ("x2_vert", 2),
    "x4 Croix (X & Y)": ("x4_quad", 4),
    "x3 Radial (120°)": ("radial", 3),
    "x4 Radial (90°)": ("radial", 4),
    "x5 Radial (72°)": ("radial", 5),
    "x6 Radial (60°)": ("radial", 6),
    "x8 Radial (45°)": ("radial", 8),
    "x12 Radial (30°)": ("radial", 12),
}


def get_sym_mode_info(text: str) -> tuple[str, int]:
    """Retourne (mode_code, count) selon le texte du mode de symétrie."""
    return SYM_MODES_MAPPING.get(text, ("none", 1))


def compute_symmetry(pts: list[tuple[float, float]], mode: str, count: int, cx: float = 0.0, cy: float = 0.0) -> list[list[tuple[float, float]]]:
    """Calcule les tracés symétriques pour une liste de points laser [(wx, wy)] selon l'axe (cx, cy)."""
    if mode == "none" or not pts:
        return [list(pts)]

    strokes = []
    if mode == "x2_horiz":
        strokes.append(list(pts))
        strokes.append([(2.0 * cx - x, y) for x, y in pts])

    elif mode == "x2_vert":
        strokes.append(list(pts))
        strokes.append([(x, 2.0 * cy - y) for x, y in pts])

    elif mode == "x4_quad":
        strokes.append(list(pts))
        strokes.append([(2.0 * cx - x, y) for x, y in pts])
        strokes.append([(x, 2.0 * cy - y) for x, y in pts])
        strokes.append([(2.0 * cx - x, 2.0 * cy - y) for x, y in pts])

    elif mode == "radial":
        N = max(2, count)
        for k in range(N):
            theta = k * (2.0 * math.pi / N)
            cos_t = math.cos(theta)
            sin_t = math.sin(theta)
            branch = []
            for x, y in pts:
                dx = x - cx
                dy = y - cy
                rx = dx * cos_t - dy * sin_t
                ry = dx * sin_t + dy * cos_t
                branch.append((cx + rx, cy + ry))
            strokes.append(branch)

    return strokes
