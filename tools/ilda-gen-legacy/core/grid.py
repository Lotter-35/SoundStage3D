import math


def snap_polar(wx: float, wy: float, snap_radius_step: float = 0.05, snap_angle_deg: float = 30.0) -> tuple[float, float]:
    """Aimante (wx, wy) sur la grille polaire (cercles de pas 0.05 et rayons à 30°)."""
    r = math.hypot(wx, wy)
    if r < 1e-4:
        return (0.0, 0.0)
    angle = math.atan2(wy, wx)
    step_rad = math.radians(snap_angle_deg)
    snapped_angle = round(angle / step_rad) * step_rad
    snapped_r = round(r / snap_radius_step) * snap_radius_step
    snapped_r = max(0.0, min(1.0, snapped_r))
    return (snapped_r * math.cos(snapped_angle), snapped_r * math.sin(snapped_angle))
