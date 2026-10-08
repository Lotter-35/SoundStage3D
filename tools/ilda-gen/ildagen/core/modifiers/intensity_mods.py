"""Modifieurs d'intensité : luminosité, fondu, stroboscope, pulsation."""

import math

import numpy as np

from ..params import F, E
from .base import Modifier
from .color_mods import prepared, path_t, mix_into, SCOPES

SYNC = ["Libre (Hz)", "Calé sur le tempo"]
DIVISIONS = ["4 temps", "2 temps", "1 temps", "1/2 temps", "1/4 temps", "1/8 temps"]
DIVISION_BEATS = [4.0, 2.0, 1.0, 0.5, 0.25, 0.125]


def period(p, ctx):
    if p["sync"] == 1:
        return 60.0 / max(1.0, ctx.bpm) * DIVISION_BEATS[int(p["division"])]
    return 1.0 / max(1e-3, p["rate"])


def cycle(p, ctx):
    """Position 0..1 dans le cycle ; calé sur le tempo, le cycle part du début de la mesure 1."""
    t = ctx.time - (getattr(ctx, "bar_offset", 0.0) if p["sync"] == 1 else 0.0)
    return (t / period(p, ctx)) % 1.0


def scaled(strokes, k):
    return [s.with_col(s.col * k) for s in strokes]


class Dimmer(Modifier):
    type_id = "dimmer"
    label = "Luminosité"
    category = "Intensité"
    icon = "sun"
    description = "Intensité globale des éléments en dessous."
    params = [F("level", "Niveau", 100.0, 0.0, 100.0, "%", 0)]
    size_keys = ("level",)

    def apply(self, strokes, p, ctx):
        k = p["level"] / 100.0
        return strokes if k == 1.0 else scaled(strokes, k)

    def summary(self, p):
        return f"{p['level']:.0f} %"


class Fade(Modifier):
    type_id = "fade"
    label = "Fondu le long du tracé"
    category = "Intensité"
    icon = "trending-down"
    description = "La ligne s'éteint progressivement d'un bout à l'autre."
    params = [F("start", "Début", 100.0, 0.0, 100.0, "%", 0),
              F("end", "Fin", 0.0, 0.0, 100.0, "%", 0),
              E("scope", "Portée", SCOPES)]

    def apply(self, strokes, p, ctx):
        src = prepared(strokes)
        ts = path_t(src, p["scope"])
        a, b = p["start"] / 100.0, p["end"] / 100.0
        cols = [s.col * (a + (b - a) * t)[:, None] for s, t in zip(src, ts)]
        return mix_into(src, cols, 1.0)


class Strobe(Modifier):
    type_id = "strobe"
    label = "Stroboscope"
    category = "Intensité"
    icon = "zap"
    description = "Clignotement (fréquence libre ou calée sur le BPM)."
    params = [E("sync", "Synchro", SYNC, 1),
              F("rate", "Fréquence", 8.0, 0.1, 60.0, " Hz", 1),
              E("division", "Division", DIVISIONS, 3),
              F("duty", "Allumé", 50.0, 1.0, 99.0, "%", 0)]

    def is_animated(self, p):
        return True

    def apply(self, strokes, p, ctx):
        on = cycle(p, ctx) < p["duty"] / 100.0
        return strokes if on else scaled(strokes, 0.0)

    def summary(self, p):
        return DIVISIONS[int(p["division"])] if p["sync"] else f"{p['rate']:.1f} Hz"


class Pulse(Modifier):
    type_id = "pulse"
    label = "Pulsation"
    category = "Intensité"
    icon = "activity"
    description = "Variation douce et régulière de l'intensité."
    params = [E("sync", "Synchro", SYNC, 1),
              F("rate", "Fréquence", 2.0, 0.05, 60.0, " Hz", 2),
              E("division", "Division", DIVISIONS, 2),
              F("depth", "Profondeur", 100.0, 0.0, 100.0, "%", 0),
              E("shape", "Forme", ["Sinus", "Triangle", "Dent de scie"])]

    def is_animated(self, p):
        return True

    def apply(self, strokes, p, ctx):
        x = cycle(p, ctx)
        if p["shape"] == 0:
            w = 0.5 + 0.5 * math.cos(2 * math.pi * x)
        elif p["shape"] == 1:
            w = 1.0 - abs(2 * x - 1.0)
        else:
            w = 1.0 - x
        k = 1.0 - p["depth"] / 100.0 * (1.0 - w)
        return scaled(strokes, k)

    def summary(self, p):
        return DIVISIONS[int(p["division"])] if p["sync"] else f"{p['rate']:.2f} Hz"


MODIFIERS = [Dimmer, Fade, Strobe, Pulse]

__all__ = ["MODIFIERS", "np"]
