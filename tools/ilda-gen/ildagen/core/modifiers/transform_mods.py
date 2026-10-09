"""Modifieurs de position et de transformation."""

from .. import mathutil as mu
from ..params import F, B, E, MIRE, PIVOT_OPTIONS
from .base import Modifier, map_pts, pivot_point


def mix_of(p):
    """Dosage 0..1. Les modifieurs de position l'appliquent à leurs réglages (½ dosage = ½ rotation,
    ½ déplacement…) : mélanger les points en ligne droite rétrécirait la forme pendant une rotation."""
    return max(0.0, min(1.0, p.get("mix", 100.0) / 100.0))


class Translate(Modifier):
    type_id = "translate"
    label = "Translation"
    category = "Position"
    icon = "move"
    description = "Déplace les formes en X / Y."
    blendable = True
    self_mix = True
    params = [F("x", "X", 0.0, -4.0, 4.0, soft_min=-1.0, soft_max=1.0, decimals=3, **MIRE),
              F("y", "Y", 0.0, -4.0, 4.0, soft_min=-1.0, soft_max=1.0, decimals=3, **MIRE)]
    center_keys = ("x", "y")

    def apply(self, strokes, p, ctx):
        m = mix_of(p)
        dx, dy = p["x"] * m, p["y"] * m
        if dx == 0 and dy == 0:
            return strokes
        return map_pts(strokes, lambda a: a + (dx, dy))


class Rotate(Modifier):
    type_id = "rotate"
    label = "Rotation"
    category = "Position"
    icon = "rotate-cw"
    description = "Tourne les formes autour d'un pivot."
    blendable = True
    self_mix = True
    params = [F("angle", "Angle", 0.0, -360.0, 360.0, "°", 1, soft_min=0, soft_max=360),
              E("pivot", "Pivot", PIVOT_OPTIONS)]
    angle_key = "angle"

    def apply(self, strokes, p, ctx):
        angle = p["angle"] * mix_of(p)
        if angle == 0:
            return strokes
        cx, cy = pivot_point(p["pivot"], strokes, ctx)
        m = mu.about(mu.rotation(angle), cx, cy)
        return map_pts(strokes, lambda a: mu.apply(m, a))


class Tilt3D(Modifier):
    type_id = "tilt3d"
    label = "Inclinaison 3D"
    category = "Position"
    icon = "rotate-3d"
    description = "Bascule les formes en perspective autour des axes X et Y."
    blendable = True
    self_mix = True
    params = [F("tilt_x", "Axe X", 0.0, -89.0, 89.0, "°", 1),
              F("tilt_y", "Axe Y", 0.0, -89.0, 89.0, "°", 1),
              E("pivot", "Pivot", PIVOT_OPTIONS)]

    def apply(self, strokes, p, ctx):
        m = mix_of(p)
        tx, ty = p["tilt_x"] * m, p["tilt_y"] * m
        if tx == 0 and ty == 0:
            return strokes
        cx, cy = pivot_point(p["pivot"], strokes, ctx)
        return map_pts(strokes, lambda a: mu.tilt(a, tx, ty, cx, cy))


class Depth(Modifier):
    type_id = "depth"
    label = "Profondeur Z"
    category = "Position"
    icon = "move-3d"
    description = "Éloigne ou rapproche les formes en perspective."
    blendable = True
    self_mix = True
    params = [F("z", "Z", 0.0, -2.0, 20.0, decimals=2, soft_min=-1.5, soft_max=5.0),
              E("pivot", "Point de fuite", PIVOT_OPTIONS, 2)]

    def apply(self, strokes, p, ctx):
        z = p["z"] * mix_of(p)
        if z == 0:
            return strokes
        cx, cy = pivot_point(p["pivot"], strokes, ctx)
        return map_pts(strokes, lambda a: mu.tilt(a, 0.0, 0.0, cx, cy, z=z))


class Scale(Modifier):
    type_id = "scale"
    label = "Échelle"
    category = "Position"
    icon = "scaling"
    description = "Agrandit ou rétrécit (uniforme, ou X et Y séparés)."
    blendable = True
    self_mix = True
    params = [F("scale", "Taille", 100.0, -1000.0, 1000.0, "%", 1, soft_min=0, soft_max=200),
              F("sx", "Largeur", 100.0, -1000.0, 1000.0, "%", 1, soft_min=0, soft_max=200),
              F("sy", "Hauteur", 100.0, -1000.0, 1000.0, "%", 1, soft_min=0, soft_max=200),
              E("pivot", "Pivot", PIVOT_OPTIONS)]
    size_keys = ("scale",)

    def apply(self, strokes, p, ctx):
        k = p["scale"] / 100.0
        mix = mix_of(p)
        sx, sy = k * p["sx"] / 100.0, k * p["sy"] / 100.0
        sx, sy = 1.0 + (sx - 1.0) * mix, 1.0 + (sy - 1.0) * mix
        if sx == 1 and sy == 1:
            return strokes
        cx, cy = pivot_point(p["pivot"], strokes, ctx)
        m = mu.about(mu.scaling(sx, sy), cx, cy)
        return map_pts(strokes, lambda a: mu.apply(m, a))


class Flip(Modifier):
    type_id = "flip"
    label = "Miroir"
    category = "Position"
    icon = "flip-horizontal-2"
    description = "Retourne horizontalement et / ou verticalement."
    params = [B("h", "Horizontal", True), B("v", "Vertical", False), E("pivot", "Pivot", PIVOT_OPTIONS)]

    def apply(self, strokes, p, ctx):
        if not p["h"] and not p["v"]:
            return strokes
        cx, cy = pivot_point(p["pivot"], strokes, ctx)
        m = mu.about(mu.scaling(-1.0 if p["h"] else 1.0, -1.0 if p["v"] else 1.0), cx, cy)
        return map_pts(strokes, lambda a: mu.apply(m, a))

    def summary(self, p):
        return " + ".join(x for x, on in (("Horizontal", p["h"]), ("Vertical", p["v"])) if on) or "Aucun"


class Pivot(Modifier):
    type_id = "pivot"
    label = "Pivot"
    category = "Position"
    icon = "locate-fixed"
    description = "Fixe le point autour duquel tournent / grandissent les modifieurs placés au-dessus (pivot Auto)."
    params = [F("x", "X", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3, **MIRE),
              F("y", "Y", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3, **MIRE)]
    center_keys = ("x", "y")

    def apply(self, strokes, p, ctx):
        ctx.pivot = (p["x"], p["y"])
        return strokes


MODIFIERS = [Translate, Rotate, Tilt3D, Depth, Scale, Flip, Pivot]
