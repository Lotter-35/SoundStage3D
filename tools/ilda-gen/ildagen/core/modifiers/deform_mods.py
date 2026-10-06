"""Modifieurs de déformation : onde, simplification."""

import math

import numpy as np

from ..params import F, E
from ..path import resample_stroke, rdp
from .base import Modifier

WAVE_STEP = 0.01


class Wave(Modifier):
    type_id = "wave"
    label = "Onde"
    category = "Déformation"
    icon = "audio-waveform"
    description = "Fait onduler les formes (amplitude, fréquence, phase)."
    params = [E("direction", "Direction", ["Horizontale (ondule en Y)", "Verticale (ondule en X)", "Radiale"]),
              F("amp", "Amplitude", 0.08, -2.0, 2.0, soft_min=0.0, soft_max=0.5, decimals=3),
              F("freq", "Fréquence", 3.0, 0.0, 100.0, " cycles", 2, soft_max=20.0),
              F("phase", "Phase", 0.0, -36000.0, 36000.0, "°", 1, soft_min=-360, soft_max=360)]
    phase_key = "phase"
    phase_scale = 180.0
    size_keys = ("amp",)

    def absorb(self, sub_type, sp, p):
        if sub_type == "translate":
            # Une translation de 2 (largeur de la mire) décale de « freq » cycles
            p["phase"] += sp.get("x", 0.0) * 180.0 * p["freq"]
        else:
            super().absorb(sub_type, sp, p)

    def apply(self, strokes, p, ctx):
        amp, freq = p["amp"], p["freq"]
        if amp == 0:
            return strokes
        ph = math.radians(p["phase"])
        k = math.pi * freq   # freq cycles sur la largeur de la mire (2 unités)
        out = []
        for s in strokes:
            r = resample_stroke(s, WAVE_STEP) if s.kind == "line" else s.copy()
            x, y = r.pts[:, 0], r.pts[:, 1]
            if p["direction"] == 0:
                r.pts = np.column_stack((x, y + amp * np.sin(k * x + ph)))
            elif p["direction"] == 1:
                r.pts = np.column_stack((x + amp * np.sin(k * y + ph), y))
            else:
                rad = np.hypot(x, y)
                f = 1.0 + amp * np.sin(k * rad + ph) / np.maximum(rad, 1e-6) * np.minimum(rad / 0.05, 1.0)
                r.pts = np.column_stack((x * f, y * f))
            out.append(r)
        return out


class Simplify(Modifier):
    type_id = "simplify"
    label = "Simplification"
    category = "Déformation"
    icon = "spline"
    description = "Réduit le nombre de points (laser plus stable)."
    params = [F("tol", "Tolérance", 0.01, 0.0, 0.5, decimals=3, soft_max=0.1)]

    def apply(self, strokes, p, ctx):
        tol = p["tol"]
        if tol <= 0:
            return strokes
        out = []
        for s in strokes:
            if s.kind != "line" or len(s.pts) < 3:
                out.append(s.copy())
                continue
            pts = np.vstack((s.pts, s.pts[:1])) if s.closed else s.pts
            col = np.vstack((s.col, s.col[:1])) if s.closed else s.col
            kept = rdp(pts, tol)
            # Retrouve les couleurs des points conservés
            idx = []
            j = 0
            for q in kept:
                while j < len(pts) and not (pts[j][0] == q[0] and pts[j][1] == q[1]):
                    j += 1
                idx.append(min(j, len(pts) - 1))
            c = col[idx]
            if s.closed and len(kept) > 1:
                kept, c = kept[:-1], c[:-1]
            r = s.copy()
            r.pts, r.col = kept, c
            out.append(r)
        return out


MODIFIERS = [Wave, Simplify]
