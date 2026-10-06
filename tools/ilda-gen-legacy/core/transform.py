import math


class Transform2D:
    """Transformations 2D Affines (Hiérarchie & Imbrication matricielle)."""

    def __init__(self, a=1.0, b=0.0, c=0.0, d=1.0, tx=0.0, ty=0.0):
        self.a = float(a)
        self.b = float(b)
        self.c = float(c)
        self.d = float(d)
        self.tx = float(tx)
        self.ty = float(ty)

    @classmethod
    def from_trs(cls, x: float, y: float, scale_x: float, scale_y: float, rotation_deg: float) -> "Transform2D":
        rad = math.radians(rotation_deg)
        cos_r = math.cos(rad)
        sin_r = math.sin(rad)
        return cls(
            a=cos_r * scale_x,
            b=-sin_r * scale_y,
            c=sin_r * scale_x,
            d=cos_r * scale_y,
            tx=x,
            ty=y
        )

    def multiply(self, other: "Transform2D") -> "Transform2D":
        return Transform2D(
            a=self.a * other.a + self.b * other.c,
            b=self.a * other.b + self.b * other.d,
            c=self.c * other.a + self.d * other.c,
            d=self.c * other.b + self.d * other.d,
            tx=self.a * other.tx + self.b * other.ty + self.tx,
            ty=self.c * other.tx + self.d * other.ty + self.ty
        )

    def apply(self, px: float, py: float) -> tuple[float, float]:
        return (
            self.a * px + self.b * py + self.tx,
            self.c * px + self.d * py + self.ty
        )

    def invert(self) -> "Transform2D":
        det = self.a * self.d - self.b * self.c
        if abs(det) < 1e-9:
            return Transform2D(tx=-self.tx, ty=-self.ty)
        inv_det = 1.0 / det
        return Transform2D(
            a=self.d * inv_det,
            b=-self.b * inv_det,
            c=-self.c * inv_det,
            d=self.a * inv_det,
            tx=(self.b * self.ty - self.d * self.tx) * inv_det,
            ty=(self.c * self.tx - self.a * self.ty) * inv_det
        )

    def decompose(self) -> tuple[float, float, float, float, float]:
        """Décompose la matrice en (x, y, scale_x, scale_y, rotation_deg)."""
        tx = self.tx
        ty = self.ty
        rot_rad = math.atan2(self.c, self.a)
        rot_deg = math.degrees(rot_rad) % 360.0
        sx = math.hypot(self.a, self.c)
        det = self.a * self.d - self.b * self.c
        sy = det / sx if sx > 1e-6 else 1.0
        return tx, ty, sx, sy, rot_deg
