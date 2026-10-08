"""Socle commun des modifieurs."""

import numpy as np

from ..params import ParamSpec, F
from ..path import strokes_bbox

MIX = F("mix", "Intensité", 100.0, 0.0, 100.0, "%", decimals=0)


class Modifier:
    type_id = ""
    label = ""
    category = ""
    icon = "sliders-horizontal"
    description = ""
    params = []
    blendable = False     # possède un réglage « Intensité » (mélange avec l'entrée)
    self_mix = False      # le modifieur gère lui-même ce mélange

    # Effet d'un sous-modifieur de transformation posé sur ce modifieur (« modifieur sur modifieur »)
    center_keys = None    # (cx, cy) déplacés par une Translation
    phase_key = None      # décalé par la Translation X (décalage de phase)
    phase_scale = 1.0
    angle_key = None      # tourné par une Rotation
    size_keys = ()        # multipliés par une Échelle

    # ── Description des paramètres ──────────────────────────────────────
    def all_params(self):
        return list(self.params) + ([MIX] if self.blendable else [])

    def spec(self, key):
        for p in self.all_params():
            if p.key == key:
                return p
        return None

    def defaults(self):
        return {p.key: p.default_value() for p in self.all_params()}

    # ── Évaluation ──────────────────────────────────────────────────────
    def apply(self, strokes, p, ctx):
        return strokes

    def is_animated(self, p):
        """Vrai si le résultat dépend du temps qui passe (stroboscope, défilement…)."""
        return False

    def absorb(self, sub_type, sp, p):
        """Applique un sous-modifieur (translation, rotation, échelle) aux réglages p."""
        if sub_type == "translate":
            if self.center_keys:
                kx, ky = self.center_keys
                p[kx] = p[kx] + sp.get("x", 0.0)
                p[ky] = p[ky] + sp.get("y", 0.0)
            elif self.phase_key:
                p[self.phase_key] = p[self.phase_key] + sp.get("x", 0.0) * self.phase_scale
        elif sub_type == "rotate" and self.angle_key:
            p[self.angle_key] = p[self.angle_key] + sp.get("angle", 0.0)
        elif sub_type == "scale":
            k = sp.get("scale", 100.0) / 100.0
            for key in self.size_keys:
                p[key] = p[key] * k

    def summary(self, p):
        """Texte court affiché dans la ligne du calque."""
        parts = []
        for spec in self.params[:2]:
            v = p.get(spec.key)
            if spec.kind == "float":
                parts.append(f"{spec.label} {v:.{min(spec.decimals, 2)}f}{spec.unit}")
            elif spec.kind == "int":
                parts.append(f"{spec.label} {v}")
            elif spec.kind == "enum" and spec.options:
                parts.append(spec.options[int(v)])
        return " · ".join(parts)


def blend(src, out, mix):
    """Mélange la sortie avec l'entrée (même structure) selon l'intensité 0..1."""
    if mix >= 1.0:
        return out
    if len(src) != len(out):
        return out
    res = []
    for a, b in zip(src, out):
        if len(a.pts) != len(b.pts):
            res.append(b)
            continue
        s = b.copy()
        s.pts = a.pts + (b.pts - a.pts) * mix
        s.col = a.col + (b.col - a.col) * mix
        res.append(s)
    return res


def pivot_point(mode, strokes, ctx):
    """0 = auto (modifieur Pivot sinon centre), 1 = centre des formes, 2 = centre de la mire."""
    if mode == 2:
        return 0.0, 0.0
    if mode == 0 and ctx.pivot is not None:
        return ctx.pivot
    b = strokes_bbox(strokes)
    if b is None:
        return 0.0, 0.0
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def map_pts(strokes, fn):
    """Applique fn(pts) -> pts à tous les tracés."""
    out = []
    for s in strokes:
        out.append(s.with_pts(fn(s.pts)) if len(s.pts) else s.copy())
    return out


def stroke_rng(seed, i):
    return np.random.default_rng((int(seed) * 7919 + i * 104729) & 0xFFFFFFFF)


__all__ = ["Modifier", "ParamSpec", "blend", "pivot_point", "map_pts", "stroke_rng", "MIX"]
