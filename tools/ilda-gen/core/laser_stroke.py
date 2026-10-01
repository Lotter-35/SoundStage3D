import math

try:
    from .constants import BLANK_POINTS, LINE_STEP, CORNER_POINTS, CORNER_ANGLE
except (ImportError, ValueError):
    from core.constants import BLANK_POINTS, LINE_STEP, CORNER_POINTS, CORNER_ANGLE


def is_corner(stroke, i: int) -> bool:
    """Détecte si un point forme un angle supérieur ou égal à CORNER_ANGLE."""
    if i <= 0 or i >= len(stroke) - 1:
        return False
    ax, ay = stroke[i - 1][0], stroke[i - 1][1]
    bx, by = stroke[i][0], stroke[i][1]
    cx, cy = stroke[i + 1][0], stroke[i + 1][1]
    d1 = math.atan2(by - ay, bx - ax)
    d2 = math.atan2(cy - by, cx - bx)
    turn = abs((d2 - d1 + math.pi) % (2 * math.pi) - math.pi)
    return math.degrees(turn) >= CORNER_ANGLE


def prepare_stroke(stroke, out, is_closed=False):
    """Ajoute un tracé prêt à projeter en IDN/ILDA : saut éteint (blanking), points intermédiaires et d'angle."""
    if not stroke:
        return
    fx, fy = stroke[0][0], stroke[0][1]
    if out:
        px, py = out[-1][0], out[-1][1]
        jump = math.hypot(fx - px, fy - py) / 65536
    else:
        jump = 1.0
    for _ in range(BLANK_POINTS + int(jump * 8)):
        out.append((fx, fy, 0, 0, 0, True))

    n_pts = len(stroke)
    for i in range(n_pts):
        x, y, r, g, b = stroke[i]
        if i > 0:
            x0, y0 = stroke[i - 1][0], stroke[i - 1][1]
            dist = math.hypot(x - x0, y - y0)
            if dist > LINE_STEP:
                n = max(1, math.ceil(dist / LINE_STEP))
                for k in range(1, n):
                    t = k / n
                    out.append((round(x0 + (x - x0) * t), round(y0 + (y - y0) * t), r, g, b, False))

        out.append((x, y, r, g, b, False))

        # Points d'arrêt (dwell) : UNIQUEMENT pour les tracés ouverts aux extrémités, ou sur les angles vifs
        # Sur une forme fermée comme un cercle, PAS de répétition d'extrémités (évite le point chaud superposé)
        if not is_closed:
            if i == 0 or i == n_pts - 1:
                for _ in range(CORNER_POINTS):
                    out.append((x, y, r, g, b, False))
            elif is_corner(stroke, i):
                for _ in range(CORNER_POINTS):
                    out.append((x, y, r, g, b, False))
        else:
            if is_corner(stroke, i):
                for _ in range(CORNER_POINTS):
                    out.append((x, y, r, g, b, False))

    if is_closed and n_pts > 2:
        # Fermeture propre du tracé vers le 1er point sans point de dwell dupliqué
        x0, y0 = stroke[-1][0], stroke[-1][1]
        x1, y1 = stroke[0][0], stroke[0][1]
        dist = math.hypot(x1 - x0, y1 - y0)
        if dist > LINE_STEP:
            n = max(1, math.ceil(dist / LINE_STEP))
            for k in range(1, n):
                t = k / n
                out.append((round(x0 + (x1 - x0) * t), round(y0 + (y1 - y0) * t), r, g, b, False))

    lx, ly = stroke[0][0] if is_closed else stroke[-1][0], stroke[0][1] if is_closed else stroke[-1][1]
    out.append((lx, ly, 0, 0, 0, True))
