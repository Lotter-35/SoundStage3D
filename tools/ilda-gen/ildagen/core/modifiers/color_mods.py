"""Modifieurs de couleur."""

import math

import numpy as np

from .. import colorutil as cu
from ..params import F, I, E, C, G, P, FRACTION, MIRE
from ..path import Stroke, closed_pts, cumulative, resample_share, resample_stroke
from .base import Modifier, stroke_rng

COLOR_STEP = 0.02
SCOPES = ["Par tracé", "Global (tous les tracés)"]
GRAD_MODES = ["Le long du tracé", "Linéaire", "Radial", "Angulaire"]
# Centre utile pour les dégradés dans l'espace (pas le long du tracé)
CENTRE = {"mode": (1, 2, 3)}


def prepared(strokes):
    """Tracés rééchantillonnés pour que la couleur puisse varier finement."""
    share = resample_share(strokes)
    return [resample_stroke(s, COLOR_STEP, share) if s.kind == "line" else s.copy() for s in strokes]


def mix_into(src, new_cols, mix):
    """Remplace les couleurs de chaque tracé (mélangées selon l'intensité 0..1)."""
    out = []
    for s, c in zip(src, new_cols):
        r = s.copy()
        r.col = s.col + (np.asarray(c) - s.col) * mix if mix < 1.0 else np.asarray(c, dtype=float)
        out.append(r)
    return out


def path_t(strokes, scope):
    """Position relative 0..1 de chaque point le long de son tracé (ou de tous les tracés)."""
    res = []
    lens = []
    cums = []
    for s in strokes:
        pts = closed_pts(s.pts, s.closed) if s.kind == "line" else s.pts
        cum = cumulative(pts)
        L = float(cum[-1]) if len(cum) else 0.0
        cums.append(cum[:len(s.pts)])
        lens.append(L)
    if scope == 0:
        for cum, L in zip(cums, lens):
            res.append(cum / L if L > 1e-9 else np.zeros(len(cum)))
    else:
        total = sum(lens) or 1.0
        g = 0.0
        for cum, L in zip(cums, lens):
            res.append((g + cum) / total)
            g += L
    return res


def field_t(strokes, p, mode):
    """Coordonnée de dégradé selon le mode (tracé, linéaire, radial, angulaire)."""
    if mode == 0:
        return path_t(strokes, p.get("scope", 0))
    out = []
    a = math.radians(p.get("angle", 0.0))
    size = max(1e-6, p.get("size", 2.0))
    cx, cy = p.get("cx", 0.0), p.get("cy", 0.0)
    for s in strokes:
        x = s.pts[:, 0] - cx
        y = s.pts[:, 1] - cy
        if mode == 1:
            t = (x * math.cos(a) + y * math.sin(a)) / size + 0.5
        elif mode == 2:
            t = np.hypot(x, y) / (size / 2)
        else:
            t = ((np.arctan2(y, x) - a) / (2 * math.pi)) % 1.0
        out.append(t)
    return out


class SolidColor(Modifier):
    type_id = "color"
    label = "Couleur"
    category = "Couleur"
    icon = "palette"
    description = "Colore tous les éléments en dessous."
    blendable = True
    self_mix = True
    params = [C("color", "Couleur", (1.0, 0.0, 0.0))]

    def apply(self, strokes, p, ctx):
        c = np.asarray(p["color"], dtype=float)
        return mix_into(strokes, [np.tile(c, (len(s.pts), 1)) for s in strokes], p["mix"] / 100.0)

    def summary(self, p):
        return cu.to_hex(p["color"]).upper()


class Gradient(Modifier):
    type_id = "gradient"
    label = "Dégradé"
    category = "Couleur"
    icon = "blend"
    description = "Dégradé de N couleurs : le long du tracé, linéaire, radial ou angulaire."
    blendable = True
    self_mix = True
    params = [G("stops", "Couleurs", [[0.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 1.0]]),
              E("mode", "Type", GRAD_MODES),
              E("scope", "Portée", SCOPES, visible_if={"mode": 0}),
              F("angle", "Angle", 0.0, -360.0, 360.0, "°", 1, soft_min=0, soft_max=360, visible_if={"mode": (1, 3)}),
              F("size", "Étendue", 2.0, 0.01, 20.0, decimals=2, soft_max=4.0, visible_if={"mode": (1, 2)}, **MIRE),
              F("cx", "Centre X", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3, visible_if=CENTRE, **MIRE),
              F("cy", "Centre Y", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3, visible_if=CENTRE, **MIRE),
              F("offset", "Décalage", 0.0, -100.0, 100.0, decimals=3, soft_min=-1, soft_max=1, **FRACTION),
              E("repeat", "Répétition", ["Étendre", "Répéter", "Miroir"])]
    center_keys = ("cx", "cy")
    angle_key = "angle"
    size_keys = ("size",)

    def absorb(self, sub_type, sp, p):
        if sub_type == "translate" and p["mode"] == 0:
            p["offset"] += sp.get("x", 0.0) / 2.0
        else:
            super().absorb(sub_type, sp, p)

    def apply(self, strokes, p, ctx):
        src = prepared(strokes)
        ts = field_t(src, p, p["mode"])
        cols = [cu.sample_gradient(p["stops"], cu.wrap_t(t + p["offset"], p["repeat"])) for t in ts]
        return mix_into(src, cols, p["mix"] / 100.0)

    def summary(self, p):
        return f"{len(p['stops'])} couleurs · {GRAD_MODES[p['mode']].lower()}"


class ColorScroll(Modifier):
    type_id = "color_scroll"
    label = "Défilement de couleur"
    category = "Couleur"
    icon = "arrow-right-left"
    description = "Fait glisser les couleurs le long du tracé (décalage, et vitesse optionnelle)."
    params = [F("offset", "Décalage", 0.0, -100.0, 100.0, decimals=3, soft_min=-1, soft_max=1, **FRACTION),
              F("speed", "Vitesse", 0.0, -50.0, 50.0, " tours/s", 2, soft_min=-4, soft_max=4),
              E("scope", "Portée", SCOPES)]
    phase_key = "offset"
    phase_scale = 0.5

    def is_animated(self, p):
        return p["speed"] != 0

    def apply(self, strokes, p, ctx):
        src = prepared(strokes)
        shift = p["offset"] + p["speed"] * ctx.time
        ts = path_t(src, p["scope"])
        if p["scope"] == 0:
            out_cols = []
            for s, t in zip(src, ts):
                tt = (t - shift) % 1.0
                out_cols.append(np.column_stack([np.interp(tt, t, s.col[:, k], period=1.0) for k in range(3)])
                                if len(t) > 1 else s.col)
            return mix_into(src, out_cols, 1.0)
        allt = np.concatenate(ts) if ts else np.zeros(0)
        allc = np.vstack([s.col for s in src]) if src else np.zeros((0, 3))
        out_cols = []
        for t in ts:
            tt = (t - shift) % 1.0
            out_cols.append(np.column_stack([np.interp(tt, allt, allc[:, k], period=1.0) for k in range(3)])
                            if len(allt) > 1 else np.ones((len(t), 3)))
        return mix_into(src, out_cols, 1.0)


class Rainbow(Modifier):
    type_id = "rainbow"
    label = "Arc-en-ciel"
    category = "Couleur"
    icon = "rainbow"
    description = "Toutes les teintes réparties le long du tracé ou dans l'espace."
    blendable = True
    self_mix = True
    params = [E("mode", "Type", GRAD_MODES),
              E("scope", "Portée", SCOPES, visible_if={"mode": 0}),
              F("cycles", "Répétitions", 1.0, 0.01, 64.0, " ×", 2, soft_max=8),
              F("offset", "Décalage", 0.0, -100.0, 100.0, decimals=3, soft_min=-1, soft_max=1, **FRACTION),
              F("speed", "Vitesse", 0.0, -50.0, 50.0, " tours/s", 2, soft_min=-4, soft_max=4),
              F("sat", "Saturation", 100.0, 0.0, 100.0, "%", 0),
              F("angle", "Angle", 0.0, -360.0, 360.0, "°", 1, soft_min=0, soft_max=360, visible_if={"mode": (1, 3)}),
              F("cx", "Centre X", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3, visible_if=CENTRE, **MIRE),
              F("cy", "Centre Y", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3, visible_if=CENTRE, **MIRE)]
    center_keys = ("cx", "cy")
    angle_key = "angle"

    def is_animated(self, p):
        return p["speed"] != 0

    def apply(self, strokes, p, ctx):
        src = prepared(strokes)
        q = dict(p, size=2.0)
        ts = field_t(src, q, p["mode"])
        shift = p["offset"] + p["speed"] * ctx.time
        cols = [cu.hue_colors(t * p["cycles"] + shift, p["sat"] / 100.0) for t in ts]
        return mix_into(src, cols, p["mix"] / 100.0)


class HueSatLum(Modifier):
    type_id = "hsl"
    label = "Teinte / saturation / luminosité"
    category = "Couleur"
    icon = "sliders-vertical"
    description = "Ajuste les couleurs existantes."
    blendable = True
    self_mix = True
    params = [F("hue", "Teinte", 0.0, -180.0, 180.0, "°", 0),
              F("sat", "Saturation", 100.0, 0.0, 200.0, "%", 0),
              F("lum", "Luminosité", 100.0, 0.0, 200.0, "%", 0)]
    angle_key = "hue"

    def apply(self, strokes, p, ctx):
        cols = []
        for s in strokes:
            hsv = cu.rgb_to_hsv(s.col) if len(s.col) else np.zeros((0, 3))
            hsv[:, 0] += p["hue"] / 360.0
            hsv[:, 1] *= p["sat"] / 100.0
            hsv[:, 2] *= p["lum"] / 100.0
            cols.append(cu.hsv_to_rgb(hsv) if len(hsv) else s.col)
        return mix_into(strokes, cols, p["mix"] / 100.0)


class AlternateColors(Modifier):
    type_id = "alternate"
    label = "Segments alternés"
    category = "Couleur"
    icon = "columns-2"
    description = "Alterne 2 à 4 couleurs par segment, par tracé ou par longueur."
    params = [I("count", "Nombre de couleurs", 2, 2, 4),
              C("c1", "Couleur 1", (1.0, 0.0, 0.0)), C("c2", "Couleur 2", (0.0, 0.0, 1.0)),
              C("c3", "Couleur 3", (0.0, 1.0, 0.0), visible_if={"count": lambda n: n >= 3}),
              C("c4", "Couleur 4", (1.0, 1.0, 1.0), visible_if={"count": lambda n: n >= 4}),
              E("mode", "Alternance", ["Par segment", "Par tracé", "Par longueur"]),
              F("length", "Longueur", 0.1, 0.005, 4.0, decimals=3, soft_max=0.5, visible_if={"mode": 2}, **MIRE),
              F("offset", "Décalage", 0.0, -100.0, 100.0, decimals=3, soft_min=-1, soft_max=1)]
    phase_key = "offset"
    size_keys = ("length",)

    def apply(self, strokes, p, ctx):
        n = int(p["count"])
        pal = np.array([p["c1"], p["c2"], p["c3"], p["c4"]][:n], dtype=float)
        out = []
        off = int(round(p["offset"]))
        share = resample_share(strokes)
        for i, s in enumerate(strokes):
            if p["mode"] == 1:
                out.append(s.with_col(np.tile(pal[(i + off) % n], (len(s.pts), 1))))
                continue
            if s.kind != "line" or len(s.pts) < 2:
                out.append(s.with_col(pal[(np.arange(len(s.pts)) + off) % n]))
                continue
            if p["mode"] == 0:
                pts = closed_pts(s.pts, s.closed)
                segs = len(pts) - 1
                np_ = np.repeat(pts, 2, axis=0)[1:-1]
                k = (np.repeat(np.arange(segs), 2) + off) % n
                out.append(Stroke(np_, pal[k], False))
            else:
                r = resample_stroke(s, min(COLOR_STEP, p["length"] / 4), share)
                pts = closed_pts(r.pts, r.closed)
                cum = cumulative(pts)
                k = np.floor((cum + p["offset"]) / max(1e-6, p["length"])).astype(int) % n
                out.append(Stroke(pts, pal[k], False))
        return out


class RandomColor(Modifier):
    type_id = "random_color"
    label = "Couleur aléatoire"
    category = "Couleur"
    icon = "dices"
    description = "Une couleur au hasard par tracé ou par segment (graine réglable)."
    params = [I("seed", "Graine", 1, 0, 99999, soft_max=100, tip="Autre graine = autre tirage des couleurs"),
              E("mode", "Par", ["Tracé", "Segment"]),
              E("palette", "Palette", ["Toutes les teintes", "Couleurs laser pures", "Couleurs choisies"]),
              P("colors", "Couleurs", [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0)], visible_if={"palette": 2}),
              F("sat", "Saturation", 100.0, 0.0, 100.0, "%", 0, visible_if={"palette": 0})]

    def _pick(self, rng, p, n):
        if p["palette"] == 1:
            idx = rng.integers(0, len(cu.LASER_COLORS), n)
            return np.array(cu.LASER_COLORS, dtype=float)[idx]
        if p["palette"] == 2:
            # Tirage au hasard parmi les couleurs choisies (palette « Couleurs »)
            cols = np.array([tuple(c) for c in (p.get("colors") or [(1, 1, 1)])], dtype=float).reshape(-1, 3)
            return cols[rng.integers(0, len(cols), n)]
        return cu.hue_colors(rng.random(n), p["sat"] / 100.0)

    def apply(self, strokes, p, ctx):
        out = []
        for i, s in enumerate(strokes):
            rng = stroke_rng(p["seed"], i)
            if p["mode"] == 0:
                out.append(s.with_col(np.tile(self._pick(rng, p, 1)[0], (len(s.pts), 1))))
                continue
            if s.kind != "line" or len(s.pts) < 2:
                out.append(s.with_col(self._pick(rng, p, len(s.pts))))
                continue
            pts = closed_pts(s.pts, s.closed)
            segs = len(pts) - 1
            cols = self._pick(rng, p, segs)
            out.append(Stroke(np.repeat(pts, 2, axis=0)[1:-1], np.repeat(cols, 2, axis=0), False))
        return out


class ReplaceColor(Modifier):
    type_id = "replace_color"
    label = "Remplacement de couleur"
    category = "Couleur"
    icon = "replace"
    description = "Remplace une couleur par une autre (avec tolérance)."
    blendable = True
    self_mix = True
    params = [C("src", "Couleur à remplacer", (1.0, 1.0, 1.0)),
              C("dst", "Nouvelle couleur", (0.0, 1.0, 0.0)),
              F("tol", "Tolérance", 20.0, 0.0, 100.0, "%", 0)]

    def apply(self, strokes, p, ctx):
        src = np.asarray(p["src"], dtype=float)
        dst = np.asarray(p["dst"], dtype=float)
        tol = max(1e-3, p["tol"] / 100.0 * math.sqrt(3))
        cols = []
        for s in strokes:
            d = np.linalg.norm(s.col - src, axis=1) if len(s.col) else np.zeros(0)
            hit = (d <= tol)[:, None]
            cols.append(np.where(hit, dst, s.col))
        return mix_into(strokes, cols, p["mix"] / 100.0)


MODIFIERS = [SolidColor, Gradient, ColorScroll, Rainbow, HueSatLum, AlternateColors, RandomColor, ReplaceColor]
