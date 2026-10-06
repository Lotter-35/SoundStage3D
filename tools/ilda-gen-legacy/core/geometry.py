import math

try:
    from .constants import CANVAS_SIZE
except (ImportError, ValueError):
    from core.constants import CANVAS_SIZE


def norm_to_canvas(wx: float, wy: float, zoom: float = 1.0, pan_x: float = 0.0, pan_y: float = 0.0) -> tuple[float, float]:
    """Convertit coordonnées normalisées (-1.0 à +1.0) en coordonnées canvas pixels avec zoom et pan."""
    mid = CANVAS_SIZE / 2.0
    span = mid * zoom
    cx = mid + pan_x + wx * span
    cy = mid + pan_y - wy * span  # Inversion Y : laser Y vers le haut, canvas Y vers le bas
    return cx, cy


def canvas_to_norm(cx: float, cy: float, zoom: float = 1.0, pan_x: float = 0.0, pan_y: float = 0.0) -> tuple[float, float]:
    """Convertit coordonnées canvas pixels en coordonnées normalisées (-1.0 à +1.0) avec zoom et pan."""
    mid = CANVAS_SIZE / 2.0
    span = mid * zoom
    if span == 0:
        return 0.0, 0.0
    wx = (cx - mid - pan_x) / span
    wy = -(cy - mid - pan_y) / span
    return max(-1.0, min(1.0, wx)), max(-1.0, min(1.0, wy))


def dist_pt_seg(px: float, py: float, x1: float, y1: float, x2: float, y2: float) -> float:
    """Distance minimale entre un point (px, py) et un segment [(x1,y1), (x2,y2)]."""
    dx = x2 - x1
    dy = y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(px - x1, py - y1)
    t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    proj_x = x1 + t * dx
    proj_y = y1 + t * dy
    return math.hypot(px - proj_x, py - proj_y)
