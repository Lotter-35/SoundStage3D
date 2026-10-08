"""Animations des clips de la timeline (espace Show) : effets posés sur un clip, réglages fixes, en courbe
ou en oscillateur.

- `Animation` : liste d'effets appliqués dans l'ordre (de haut en bas). Les clips d'une même forme la
  partagent par défaut (`Clip.anim_id`, règles de liaison dans core/timeline.py).
- `Effect` : un effet du registre (core/effects/), qui vise toute la forme (`target` vide) ou un calque.
  « Réglage de la forme » vise un calque et une clé de réglage (`key`).
- `ParamTrack` : valeur d'un réglage d'effet ; « fixe », « courbe » (clés en proportion 0..1 de la durée du
  clip) ou « osc » (oscillateur, temps local du clip).
"""

from .automation import Automation, Keyframe
from .nodes import new_id
from .oscillator import Osc, can_oscillate

TRACK_MODES = [("fixe", "Fixe"), ("courbe", "Courbe"), ("osc", "Oscillateur")]
MODE_IDS = [m for m, _ in TRACK_MODES]


def _value_to_json(v):
    return list(v) if isinstance(v, tuple) else v


def _value_from_json(v):
    return tuple(v) if isinstance(v, list) else v


class ParamTrack:
    def __init__(self, mode="fixe", value=0.0, curve=None, osc=None):
        self.mode = mode if mode in MODE_IDS else "fixe"
        self.value = value
        self.curve = curve if curve is not None else Automation()
        self.osc = osc

    def is_animated(self):
        return (self.mode == "courbe" and bool(self.curve.keys)) or (self.mode == "osc" and self.osc is not None)

    def value_at(self, u, t, spec=None, bpm=120.0, bar_offset=0.0):
        """Valeur à la position u (0..1 du clip) et au temps local t (s) ; bornée par spec."""
        v = self.value
        if self.mode == "courbe" and self.curve.keys:
            v = self.curve.value_at(u)
        elif self.mode == "osc" and self.osc is not None and (spec is None or can_oscillate(spec)):
            v = self.osc.value(self.value, t, spec, bpm, bar_offset)
        if spec is not None and v is not None:
            try:
                v = spec.clamp(v)
            except (TypeError, ValueError):
                v = spec.default_value()
        return v

    def copy(self):
        return ParamTrack.from_dict(self.to_dict(), new_ids=True)

    def to_dict(self):
        d = {"mode": self.mode, "value": _value_to_json(self.value)}
        if self.curve.keys:
            d["curve"] = {"discrete": self.curve.discrete, "keys": [k.to_dict() for k in self.curve.keys]}
        if self.osc is not None:
            d["osc"] = self.osc.to_dict()
        return d

    @classmethod
    def from_dict(cls, d, new_ids=False):
        d = d if isinstance(d, dict) else {}
        curve = Automation()
        c = d.get("curve")
        if isinstance(c, dict):
            curve.discrete = bool(c.get("discrete", False))
            curve.keys = [Keyframe.from_dict(k) for k in c.get("keys", []) if isinstance(k, dict)]
            curve.sort()
        osc = Osc.from_dict(d["osc"]) if isinstance(d.get("osc"), dict) else None
        return cls(d.get("mode", "fixe"), _value_from_json(d.get("value", 0.0)), curve, osc)


class Effect:
    def __init__(self, type_id, target="", key="", effect_id=None, enabled=True, params=None):
        self.id = effect_id or new_id()
        self.type_id = type_id
        self.target = target or ""      # "" = toute la forme, sinon l'id d'un calque de la forme
        self.key = key or ""            # « Réglage de la forme » : clé du réglage animé
        self.enabled = bool(enabled)
        self.params = params if params is not None else {}     # {clé: ParamTrack}

    @property
    def etype(self):
        from .effects import get
        return get(self.type_id)

    def copy(self, new_ids=True):
        e = Effect.from_dict(self.to_dict())
        if new_ids:
            e.id = new_id()
        return e

    def to_dict(self):
        d = {"id": self.id, "type": self.type_id, "target": self.target, "enabled": self.enabled,
             "params": {k: t.to_dict() for k, t in self.params.items()}}
        if self.key:
            d["key"] = self.key
        return d

    @classmethod
    def from_dict(cls, d):
        params = d.get("params") if isinstance(d.get("params"), dict) else {}
        return cls(str(d.get("type", "")), str(d.get("target") or ""), str(d.get("key") or ""), d.get("id"),
                   d.get("enabled", True) is not False,
                   {str(k): ParamTrack.from_dict(v) for k, v in params.items()})


class Animation:
    def __init__(self, anim_id=None, effects=None):
        self.id = anim_id or new_id()
        self.effects = effects if effects is not None else []

    def find(self, effect_id):
        return next((e for e in self.effects if e.id == effect_id), None)

    def is_empty(self):
        return not self.effects

    def copy(self):
        """Copie avec de nouveaux identifiants (animation et effets) : « Délier »."""
        return Animation(None, [e.copy() for e in self.effects])

    def to_dict(self):
        return {"id": self.id, "effects": [e.to_dict() for e in self.effects]}

    @classmethod
    def from_dict(cls, d):
        d = d if isinstance(d, dict) else {}
        effects = [Effect.from_dict(e) for e in d.get("effects", []) if isinstance(e, dict)]
        return cls(d.get("id"), effects)


def new_effect(type_id, target="", key="", base=None, spec=None):
    """Effet neuf : chaque réglage en mode fixe à sa valeur par défaut. « Réglage de la forme » : un seul
    réglage « value », qui part de la valeur actuelle du réglage visé (base)."""
    from .effects import SHAPE_PARAM, get
    et = get(type_id)
    e = Effect(type_id, target, key)
    if type_id == SHAPE_PARAM:
        v = base if base is not None else (spec.default_value() if spec is not None else 0.0)
        e.params["value"] = ParamTrack("fixe", v)
        e.params["value"].curve.discrete = spec is not None and spec.kind in ("bool", "enum")
        return e
    if et is not None:
        for sp in et.params():
            t = ParamTrack("fixe", sp.default_value())
            t.curve.discrete = sp.kind in ("bool", "enum")
            e.params[sp.key] = t
    return e
