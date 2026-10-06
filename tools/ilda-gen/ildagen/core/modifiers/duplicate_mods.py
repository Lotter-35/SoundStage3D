"""Modifieurs de duplication : symétries et répétition."""

import math

import numpy as np

from .. import mathutil as mu
from ..params import F, I, B
from ..path import strokes_bbox
from .base import Modifier


def reflection(deg, cx, cy):
    """Symétrie par rapport à la droite passant par (cx, cy) d'angle deg."""
    a = math.radians(2 * deg)
    return mu.about(mu.affine(math.cos(a), math.sin(a), math.sin(a), -math.cos(a)), cx, cy)


def copies(strokes, matrices):
    out = []
    for m in matrices:
        for s in strokes:
            out.append(s.with_pts(mu.apply(m, s.pts)) if len(s.pts) else s.copy())
    return out


class MirrorSymmetry(Modifier):
    type_id = "mirror_sym"
    label = "Symétrie miroir"
    category = "Duplication"
    icon = "square-split-horizontal"
    description = "Reflète les formes : 1 axe = x2, 2 axes = x4, 4 axes = x8…"
    params = [I("axes", "Axes", 1, 1, 16),
              F("angle", "Angle de l'axe", 90.0, -360.0, 360.0, "°", 1),
              F("cx", "Centre X", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3),
              F("cy", "Centre Y", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3)]
    center_keys = ("cx", "cy")
    angle_key = "angle"

    def apply(self, strokes, p, ctx):
        n = max(1, int(p["axes"]))
        cx, cy, ang = p["cx"], p["cy"], p["angle"]
        mats = [mu.about(mu.rotation(k * 360.0 / n), cx, cy) for k in range(n)]
        mats += [reflection(ang + k * 180.0 / n, cx, cy) for k in range(n)]
        return copies(strokes, mats)

    def summary(self, p):
        return f"x{2 * int(p['axes'])}"


class RadialSymmetry(Modifier):
    type_id = "radial_sym"
    label = "Symétrie radiale"
    category = "Duplication"
    icon = "flower-2"
    description = "Copies tournées autour d'un centre ; mode kaléidoscope = une copie sur deux en miroir."
    params = [I("count", "Copies", 6, 1, 128),
              F("angle", "Décalage", 0.0, -3600.0, 3600.0, "°", 1, soft_min=-180, soft_max=180),
              B("kaleido", "Kaléidoscope", False),
              F("cx", "Centre X", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3),
              F("cy", "Centre Y", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3)]
    center_keys = ("cx", "cy")
    angle_key = "angle"

    def apply(self, strokes, p, ctx):
        n = max(1, int(p["count"]))
        cx, cy, ang = p["cx"], p["cy"], p["angle"]
        mats = []
        for k in range(n):
            m = mu.about(mu.rotation(ang + k * 360.0 / n), cx, cy)
            if p["kaleido"] and k % 2 == 1:
                m = m @ reflection(90.0 + 180.0 / n, cx, cy)
            mats.append(m)
        return copies(strokes, mats)

    def summary(self, p):
        return f"x{int(p['count'])}" + (" kaléidoscope" if p["kaleido"] else "")


class LinearRepeat(Modifier):
    type_id = "repeat"
    label = "Répétition linéaire"
    category = "Duplication"
    icon = "copy"
    description = "N copies avec un décalage constant de position, rotation et taille."
    params = [I("count", "Copies", 3, 1, 128),
              F("dx", "Décalage X", 0.2, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3),
              F("dy", "Décalage Y", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3),
              F("rot", "Rotation", 0.0, -360.0, 360.0, "°", 1),
              F("scale", "Taille", 100.0, 1.0, 400.0, "%", 1),
              B("centered", "Centrer les copies", False)]
    angle_key = "rot"

    def apply(self, strokes, p, ctx):
        n = max(1, int(p["count"]))
        b = strokes_bbox(strokes)
        if b is None:
            return strokes
        cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        start = -(n - 1) / 2 if p["centered"] else 0.0
        mats = []
        for k in range(n):
            i = start + k
            m = mu.translation(i * p["dx"], i * p["dy"]) @ mu.about(
                mu.rotation(i * p["rot"]) @ mu.scaling((p["scale"] / 100.0) ** i, (p["scale"] / 100.0) ** i), cx, cy)
            mats.append(m)
        return copies(strokes, mats)

    def summary(self, p):
        return f"x{int(p['count'])}"


MODIFIERS = [MirrorSymmetry, RadialSymmetry, LinearRepeat]

__all__ = ["MODIFIERS", "reflection", "np"]
