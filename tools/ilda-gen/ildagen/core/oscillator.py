"""Oscillateurs : un réglage numérique qui varie tout seul, en boucle (onde) ou à vitesse constante.

- mode « onde » : la valeur oscille autour de la valeur réglée (sinus, triangle, carré, dent de scie,
  aléatoire lissé à graine fixe), d'une amplitude `depth` (en unités du réglage) ;
- mode « vitesse » : la valeur avance à vitesse constante (rotation continue, défilement) ; un réglage borné
  des deux côtés (angle, phase…) reboucle au lieu de se bloquer.

Cadence : calée sur le tempo (`sync`, `division` = index dans DIVISIONS, en temps) ou libre (`hz`).
"""

import math

from .params import finite

MODES = [("onde", "Onde"), ("vitesse", "Vitesse")]
WAVES = [("sine", "Sinus"), ("triangle", "Triangle"), ("square", "Carré"), ("saw", "Dent de scie"),
         ("random", "Aléatoire")]
WAVE_IDS = [w for w, _ in WAVES]

# Durée d'un cycle calé sur le tempo, en temps (noires)
DIVISIONS = [16.0, 8.0, 4.0, 2.0, 1.0, 0.5, 0.25, 0.125, 0.0625]
DEFAULT_DIVISION = 4          # 1 temps
SEED = 0x5EED                 # graine fixe de l'aléatoire lissé (même résultat à chaque lecture)
MAX_HZ = 60.0


def _fraction(beats):
    """0.5 → « 1/2 »."""
    n = round(1.0 / beats)
    return f"1/{n}"


def division_label(index, beats_per_bar=4):
    """Libellé d'une division : « 4 mesures », « 1 mesure », « 2 temps », « 1 temps », « 1/8 de temps »…"""
    beats = DIVISIONS[max(0, min(len(DIVISIONS) - 1, int(index)))]
    bpb = max(1, int(beats_per_bar))
    if beats >= 1.0:
        if beats >= bpb and abs(beats / bpb - round(beats / bpb)) < 1e-9:
            bars = int(round(beats / bpb))
            return f"{bars} mesure" if bars == 1 else f"{bars} mesures"
        return f"{int(beats)} temps"
    if beats == 0.5:
        return "1/2 temps"
    return f"{_fraction(beats)} de temps"


def division_labels(beats_per_bar=4):
    return [division_label(i, beats_per_bar) for i in range(len(DIVISIONS))]


def _hash01(n):
    """Valeur pseudo-aléatoire stable (0..1) pour l'entier n."""
    x = (int(n) * 0x9E3779B1 + SEED) & 0xFFFFFFFF
    x ^= x >> 16
    x = (x * 0x85EBCA6B) & 0xFFFFFFFF
    x ^= x >> 13
    x = (x * 0xC2B2AE35) & 0xFFFFFFFF
    x ^= x >> 16
    return x / 0xFFFFFFFF


def wave_value(wave, x):
    """Forme d'onde (−1..1) à la position x (en cycles)."""
    f = x - math.floor(x)
    if wave == "triangle":
        return 4.0 * abs(((x - 0.25) - math.floor(x - 0.25)) - 0.5) - 1.0
    if wave == "square":
        return 1.0 if f < 0.5 else -1.0
    if wave == "saw":
        return 2.0 * f - 1.0
    if wave == "random":
        # Aléatoire lissé : une valeur tirée par cycle, raccordées en douceur (cosinus)
        n = math.floor(x)
        a, b = _hash01(n) * 2.0 - 1.0, _hash01(n + 1) * 2.0 - 1.0
        k = (1.0 - math.cos(math.pi * f)) / 2.0
        return a + (b - a) * k
    return math.sin(2.0 * math.pi * x)


def can_oscillate(spec):
    """Seuls les réglages numériques (nombre, entier) peuvent porter un oscillateur."""
    return spec is not None and spec.kind in ("float", "int")


class Osc:
    __slots__ = ("mode", "wave", "depth", "phase", "sync", "division", "hz", "speed")

    def __init__(self, mode="onde", wave="sine", depth=1.0, phase=0.0, sync=True, division=DEFAULT_DIVISION,
                 hz=1.0, speed=1.0):
        self.mode = mode if mode in ("onde", "vitesse") else "onde"
        self.wave = wave if wave in WAVE_IDS else "sine"
        self.depth = finite(depth, 1.0)
        self.phase = finite(phase, 0.0, 0.0, 1.0)
        self.sync = bool(sync)
        self.division = int(finite(division, DEFAULT_DIVISION, 0, len(DIVISIONS) - 1))
        self.hz = finite(hz, 1.0, 0.001, MAX_HZ)
        self.speed = finite(speed, 1.0, -1e6, 1e6)

    @classmethod
    def default_for(cls, spec, mode="onde"):
        """Oscillateur de départ pour un réglage : amplitude / vitesse d'un quart de sa plage confortable."""
        lo = spec.soft_min if spec is not None and spec.soft_min is not None else -1.0
        hi = spec.soft_max if spec is not None and spec.soft_max is not None else 1.0
        span = max(1e-6, float(hi) - float(lo))
        if spec is not None and spec.kind == "int":
            span = max(4.0, span)
        return cls(mode=mode, depth=span / 4.0, speed=span / 4.0)

    def copy(self):
        return Osc(self.mode, self.wave, self.depth, self.phase, self.sync, self.division, self.hz, self.speed)

    # ── Cadence ─────────────────────────────────────────────────────────
    def period(self, bpm):
        """Durée d'un cycle (s)."""
        if self.sync:
            return 60.0 / max(1.0, float(bpm)) * DIVISIONS[self.division]
        return 1.0 / max(1e-3, self.hz)

    def cycles(self, t, bpm, bar_offset=0.0):
        """Position (en cycles) à l'instant t ; calé sur le tempo, les cycles partent du début de la mesure 1."""
        t0 = bar_offset if self.sync else 0.0
        return (t - t0) / self.period(bpm) + self.phase

    # ── Valeur ──────────────────────────────────────────────────────────
    def value(self, base, t, spec=None, bpm=120.0, bar_offset=0.0):
        """Valeur du réglage à l'instant t (bornée par spec)."""
        try:
            base = float(base)
        except (TypeError, ValueError):
            return base
        if self.mode == "vitesse":
            if self.sync:
                units = (t - bar_offset) / (60.0 / max(1.0, float(bpm)))      # en temps
            else:
                units = t
            v = base + self.speed * units
            if spec is not None and spec.min is not None and spec.max is not None and spec.max > spec.min:
                # Réglage borné des deux côtés : il reboucle (rotation continue, défilement…)
                span = spec.max - spec.min
                v = spec.min + (v - spec.min) % span
        else:
            v = base + self.depth * wave_value(self.wave, self.cycles(t, bpm, bar_offset))
        if not math.isfinite(v):
            v = base
        return spec.clamp(v) if spec is not None else v

    # ── Fichier ─────────────────────────────────────────────────────────
    def to_dict(self):
        return {"mode": self.mode, "wave": self.wave, "depth": round(self.depth, 6), "phase": round(self.phase, 6),
                "sync": self.sync, "division": self.division, "hz": round(self.hz, 6), "speed": round(self.speed, 6)}

    @classmethod
    def from_dict(cls, d):
        d = d if isinstance(d, dict) else {}
        return cls(d.get("mode", "onde"), d.get("wave", "sine"), d.get("depth", 1.0), d.get("phase", 0.0),
                   d.get("sync", True) is not False, d.get("division", DEFAULT_DIVISION), d.get("hz", 1.0),
                   d.get("speed", 1.0))


def osc_dict_to(oscs):
    """{clé: Osc} → dictionnaire enregistrable."""
    return {k: o.to_dict() for k, o in oscs.items()}


def osc_dict_from(d):
    if not isinstance(d, dict):
        return {}
    return {str(k): Osc.from_dict(v) for k, v in d.items() if isinstance(v, dict)}


def osc_overrides(root, t, ctx, bar_offset=None, out=None, _seen=None):
    """{(node_id, clé): valeur} des oscillateurs d'un arbre (formes placées dedans comprises) à l'instant t.

    Les valeurs partent des réglages des calques ; ctx fournit la bibliothèque et le tempo. Marque ctx.animated
    s'il y a au moins un oscillateur."""
    from .param_specs import param_spec
    from . import nodes as N
    out = {} if out is None else out
    seen = _seen if _seen is not None else set()
    bo = ctx.bar_offset if bar_offset is None else bar_offset
    for n in root.walk():
        if n.osc:
            for key, osc in n.osc.items():
                spec = param_spec(n, key)
                if not can_oscillate(spec):
                    continue
                base = N.get_param(n, key)
                if base is None:
                    continue
                out[(n.id, key)] = osc.value(base, t, spec, ctx.bpm, bo)
                ctx.animated = True
        if n.kind == "instance" and n.def_id not in seen and len(seen) < 64:
            seen.add(n.def_id)
            d = ctx.library.get(n.def_id)
            if d is not None:
                osc_overrides(d.root, t, ctx, bo, out, seen)
    return out
