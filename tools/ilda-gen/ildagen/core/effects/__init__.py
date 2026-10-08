"""Registre des effets d'animation (espace Show, effets rapides du Live).

Chaque effet réutilise un modifieur (même code d'application) avec un libellé, une catégorie et la liste de
ses réglages animables. « Masquer » et « Éclatement » ont leur propre code (new_mods.py). « Réglage de la
forme » anime un réglage existant d'un calque (il passe par les remplacements de l'évaluation).
Pour ajouter un effet : une ligne dans EFFECTS.
"""

from ..modifiers import registry as MODS
from ..modifiers.base import blend
from ..params import ParamSpec
from .new_mods import Burst, Hide

CATEGORIES = ["Mouvement", "Apparition", "Division", "Couleur et rythme", "Déformation", "Avancé"]
SHAPE_PARAM = "shape_param"


def _relabel(spec, label, key=None):
    return ParamSpec(key or spec.key, label, spec.kind, spec.default, spec.min, spec.max, spec.step, spec.unit,
                     spec.options, spec.decimals, spec.soft_min, spec.soft_max)


class EffectType:
    def __init__(self, type_id, label, category, mod=None, keys=(), labels=None, fixed=None, icon=None,
                 description="", internal=False):
        self.type_id = type_id
        self.label = label
        self.category = category
        self.mod = MODS.get(mod) if isinstance(mod, str) else mod     # modifieur qui applique l'effet
        self.keys = list(keys)                  # réglages animables (clés du modifieur)
        self.labels = labels or {}              # libellés propres à l'effet ({clé: libellé})
        self.fixed = fixed or {}                # réglages du modifieur imposés par l'effet (non affichés)
        self.icon = icon or (self.mod.icon if self.mod is not None else "sliders-horizontal")
        self.description = description or (self.mod.description if self.mod is not None else "")
        self.internal = internal                # pas proposé dans la bibliothèque (effets rapides seulement)
        self._params = None

    def params(self):
        """ParamSpec des réglages animables, dans l'ordre d'affichage."""
        if self._params is None:
            out = []
            for k in self.keys:
                sp = self.mod.spec(k) if self.mod is not None else None
                if sp is not None:
                    out.append(_relabel(sp, self.labels[k]) if k in self.labels else sp)
            self._params = out
        return self._params

    def spec(self, key):
        return next((s for s in self.params() if s.key == key), None)

    def apply(self, strokes, values, ctx):
        """Applique l'effet avec ces valeurs de réglages (les autres réglages du modifieur : par défaut)."""
        mod = self.mod
        if mod is None:
            return strokes
        p = dict(mod.defaults())
        p.update(self.fixed)
        for k, v in values.items():
            if k in p and v is not None:
                p[k] = v
        if mod.is_animated(p):
            ctx.animated = True
        out = mod.apply(strokes, p, ctx)
        if mod.blendable and not getattr(mod, "self_mix", False):
            out = blend(strokes, out, p.get("mix", 100.0) / 100.0)
        return out


DOSAGE = {"mix": "Dosage"}

EFFECTS = [
    # Mouvement
    EffectType("rotate", "Rotation", "Mouvement", "rotate", ("angle", "pivot")),
    EffectType("scale", "Taille", "Mouvement", "scale", ("scale", "sx", "sy", "pivot")),
    EffectType("translate", "Position", "Mouvement", "translate", ("x", "y")),
    EffectType("tilt3d", "Bascule 3D", "Mouvement", "tilt3d", ("tilt_x", "tilt_y", "pivot")),
    # Apparition
    EffectType("dimmer", "Fondu", "Apparition", "dimmer", ("level",), description="Intensité de la forme."),
    EffectType("trim", "Dessin progressif", "Apparition", "trim", ("start", "end", "offset", "scope")),
    EffectType("hide", "Masquer", "Apparition", Hide(), ("hidden",)),
    # Division
    EffectType("repeat", "Répétition", "Division", "repeat", ("count", "dx", "dy", "rot", "scale", "centered")),
    EffectType("radial_sym", "Symétrie radiale", "Division", "radial_sym", ("count", "angle", "kaleido", "cx", "cy")),
    EffectType("burst", "Éclatement", "Division", Burst(), ("amount", "center")),
    # Couleur et rythme
    EffectType("color", "Couleur", "Couleur et rythme", "color", ("color", "mix"), DOSAGE),
    EffectType("rainbow", "Arc-en-ciel", "Couleur et rythme", "rainbow",
               ("mode", "scope", "cycles", "offset", "speed", "sat", "mix"), DOSAGE),
    EffectType("strobe", "Stroboscope", "Couleur et rythme", "strobe", ("sync", "rate", "division", "duty")),
    EffectType("pulse", "Pulsation", "Couleur et rythme", "pulse", ("sync", "rate", "division", "depth", "shape")),
    # Déformation
    EffectType("wave", "Onde", "Déformation", "wave", ("direction", "amp", "freq", "phase")),
    # Avancé
    EffectType(SHAPE_PARAM, "Réglage de la forme", "Avancé", None, (), icon="sliders-horizontal",
               description="Anime un réglage d'un calque de la forme (cible : un calque et un de ses réglages)."),
    # Effets rapides du Live seulement
    EffectType("dots", "Points", None, "dots", ("spacing", "size", "phase"), internal=True),
]

_BY_ID = {e.type_id: e for e in EFFECTS}


def get(type_id):
    return _BY_ID.get(type_id)


def by_category():
    """[(catégorie, [types d'effets…]), …] proposés dans la bibliothèque de l'espace Show."""
    return [(c, [e for e in EFFECTS if e.category == c and not e.internal]) for c in CATEGORIES]


def effect_specs(effect, root=None):
    """[ParamSpec] des réglages d'un effet posé ; « Réglage de la forme » : celui du réglage visé."""
    if effect.type_id == SHAPE_PARAM:
        sp = effect_spec(effect, "value", root)
        return [sp] if sp is not None else []
    et = get(effect.type_id)
    return list(et.params()) if et is not None else []


def _as_value(sp):
    """Le réglage visé, renommé « value » (clé du seul réglage de « Réglage de la forme »)."""
    return _relabel(sp, sp.label, "value") if sp is not None else None


def effect_spec(effect, key, root=None):
    """ParamSpec d'un réglage d'un effet posé (« value » pour « Réglage de la forme »), ou None."""
    if effect.type_id == SHAPE_PARAM:
        from ..param_specs import param_spec
        node = root.find(effect.target) if root is not None and effect.target else None
        return _as_value(param_spec(node, effect.key)) if node is not None and effect.key else None
    et = get(effect.type_id)
    return et.spec(key) if et is not None else None


__all__ = ["CATEGORIES", "EFFECTS", "EffectType", "SHAPE_PARAM", "by_category", "effect_spec", "effect_specs", "get"]
