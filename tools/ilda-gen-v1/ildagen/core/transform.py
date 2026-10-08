"""Transformation d'un calque : position, rotation, échelle, cisaillement, inclinaison 3D, pivot."""

from dataclasses import dataclass, fields

import numpy as np

from . import mathutil as mu

# Clés exposées comme paramètres (automatables) : préfixe « tf. » dans les automations
TRANSFORM_KEYS = ("tx", "ty", "rot", "sx", "sy", "shear", "tilt_x", "tilt_y")


@dataclass
class Transform:
    tx: float = 0.0
    ty: float = 0.0
    rot: float = 0.0       # degrés, sens trigonométrique
    sx: float = 1.0
    sy: float = 1.0
    shear: float = 0.0
    tilt_x: float = 0.0    # degrés (bascule haut/bas)
    tilt_y: float = 0.0    # degrés (bascule gauche/droite)
    px: float = 0.0        # pivot dans le repère local
    py: float = 0.0

    def copy(self):
        return Transform(**{f.name: getattr(self, f.name) for f in fields(self)})

    def is_identity(self):
        return (self.tx == 0 and self.ty == 0 and self.rot == 0 and self.sx == 1 and self.sy == 1
                and self.shear == 0 and self.tilt_x == 0 and self.tilt_y == 0)

    def has_tilt(self):
        return self.tilt_x != 0.0 or self.tilt_y != 0.0

    def world_pivot(self):
        return self.px + self.tx, self.py + self.ty

    def linear(self):
        """Partie 2x2 sous forme de matrice 3x3."""
        return mu.rotation(self.rot) @ mu.affine(self.sx, self.shear, 0.0, self.sy)

    def affine(self):
        """Matrice affine complète (sans l'inclinaison 3D)."""
        return mu.translation(self.px + self.tx, self.py + self.ty) @ self.linear() @ mu.translation(-self.px, -self.py)

    def apply(self, pts):
        if len(pts) == 0 or self.is_identity():
            return pts
        out = mu.apply(self.affine(), pts)
        if self.has_tilt():
            cx, cy = self.world_pivot()
            out = mu.tilt(out, self.tilt_x, self.tilt_y, cx, cy)
        return out

    def set_affine(self, m):
        """Remplace position / rotation / échelle / cisaillement par la matrice m (pivot inchangé)."""
        rot, sx, sy, sh = mu.decompose(m)
        wx, wy = mu.apply_point(m, self.px, self.py)
        self.rot, self.sx, self.sy, self.shear = rot, sx, sy, sh
        self.tx, self.ty = wx - self.px, wy - self.py

    def set_pivot(self, nx, ny):
        """Déplace le pivot (repère local) sans bouger le résultat affine."""
        lin = self.linear()[:2, :2]
        d = np.array([nx - self.px, ny - self.py])
        shift = lin @ d - d
        self.tx += float(shift[0])
        self.ty += float(shift[1])
        self.px, self.py = nx, ny

    def get(self, key):
        return getattr(self, key)

    def with_overrides(self, values):
        """Copie avec certaines valeurs remplacées (automations)."""
        t = self.copy()
        for k, v in values.items():
            setattr(t, k, float(v))
        return t

    def to_dict(self):
        return {f.name: round(getattr(self, f.name), 6) for f in fields(self)}

    @classmethod
    def from_dict(cls, d):
        t = cls()
        for f in fields(t):
            if f.name in d:
                setattr(t, f.name, float(d[f.name]))
        return t


TRANSFORM_LABELS = {
    "tx": "Position X",
    "ty": "Position Y",
    "rot": "Rotation",
    "sx": "Échelle X",
    "sy": "Échelle Y",
    "shear": "Cisaillement",
    "tilt_x": "Inclinaison X",
    "tilt_y": "Inclinaison Y",
}
