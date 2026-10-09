"""Description des paramètres réglables (modifieurs, formes) : type, bornes, unité."""

import math


def finite(v, default, lo=None, hi=None):
    """Nombre fini borné ; `default` si la valeur n'est pas un nombre utilisable (texte, infini, NaN…)."""
    if isinstance(v, bool):
        v = float(v)
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(v):
        return default
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


class ParamSpec:
    """kind : float, int, bool, enum, color, gradient.

    Affichage (panneau Réglages) :
    - scale / scale_unit : valeur montrée = valeur × scale, suivie de scale_unit (une distance de la mire,
      en unités de mire, est montrée en % : 100 % = du centre au bord) ; sans scale : la valeur et `unit` ;
    - visible_if : le réglage n'est montré que s'il sert avec les autres réglages du calque :
      {clé: valeur | (valeurs…) | fonction(valeur) -> bool} (toutes les conditions), ou fonction(get) -> bool ;
    - tip : infobulle.
    """

    def __init__(self, key, label, kind="float", default=0.0, min=None, max=None, step=None,
                 unit="", options=None, decimals=2, soft_min=None, soft_max=None, visible_if=None,
                 scale=None, scale_unit=None, tip=""):
        self.key = key
        self.label = label
        self.kind = kind
        self.default = default
        self.min = min
        self.max = max
        self.step = step
        self.unit = unit
        self.options = options or []   # enum : liste de libellés, la valeur est l'index
        self.decimals = decimals
        # Bornes « confortables » pour le glisser à la souris (les bornes strictes restent min / max)
        self.soft_min = soft_min if soft_min is not None else min
        self.soft_max = soft_max if soft_max is not None else max
        self.visible_if = visible_if
        self.scale = scale
        self.scale_unit = scale_unit
        self.tip = tip

    def display(self):
        """(facteur, unité) de l'affichage : valeur montrée = valeur × facteur."""
        if self.scale:
            return float(self.scale), self.scale_unit if self.scale_unit is not None else self.unit
        return 1.0, self.unit

    def shown(self, get):
        """Le réglage sert-il ? get(clé) : valeur actuelle d'un autre réglage du même calque."""
        cond = self.visible_if
        if not cond:
            return True
        if callable(cond):
            return bool(cond(get))
        for k, want in cond.items():
            v = get(k)
            if v is None:
                continue
            if callable(want):
                ok = want(v)
            elif isinstance(want, (tuple, list, set, frozenset)):
                ok = v in want
            else:
                ok = v == want
            if not ok:
                return False
        return True

    @property
    def animatable(self):
        return self.kind in ("float", "int", "bool", "enum", "color")

    def clamp(self, v):
        if self.kind == "float":
            v = float(v)
        elif self.kind in ("int", "enum"):
            v = int(round(float(v)))
        elif self.kind == "bool":
            return bool(v)
        elif self.kind == "color":
            return tuple(min(1.0, max(0.0, float(c))) for c in v)
        elif self.kind == "palette":
            return [tuple(min(1.0, max(0.0, float(c))) for c in col) for col in (v or [])]
        else:
            return v
        if self.min is not None:
            v = max(self.min, v)
        if self.max is not None:
            v = min(self.max, v)
        if self.kind == "enum" and self.options:
            v = min(max(v, 0), len(self.options) - 1)
        return v

    def default_value(self):
        d = self.default
        if self.kind == "gradient":
            return [list(s) for s in d]
        if self.kind == "color":
            return tuple(d)
        return d


def F(key, label, default=0.0, min=None, max=None, unit="", decimals=2, step=None, soft_min=None, soft_max=None,
      **show):
    """Nombre. show : visible_if, scale, scale_unit, tip (affichage, voir ParamSpec)."""
    return ParamSpec(key, label, "float", default, min, max, step, unit, decimals=decimals,
                     soft_min=soft_min, soft_max=soft_max, **show)


def I(key, label, default=0, min=None, max=None, unit="", soft_min=None, soft_max=None, **show):
    return ParamSpec(key, label, "int", default, min, max, 1, unit, decimals=0, soft_min=soft_min, soft_max=soft_max,
                     **show)


def B(key, label, default=False, **show):
    return ParamSpec(key, label, "bool", default, **show)


def E(key, label, options, default=0, **show):
    return ParamSpec(key, label, "enum", default, options=options, **show)


def C(key, label, default=(1.0, 1.0, 1.0), **show):
    return ParamSpec(key, label, "color", tuple(default), **show)


def G(key, label, default):
    return ParamSpec(key, label, "gradient", default)


def P(key, label, default, **show):
    """Liste de couleurs (palette), non animable."""
    return ParamSpec(key, label, "palette", [tuple(c) for c in default], **show)


# Distance ou position dans la mire (unités de mire : 1 = du centre au bord), montrée en %
MIRE = dict(scale=100.0, scale_unit="%", tip="En % de la mire : 100 % = du centre au bord")
# Fraction (0..1) montrée en %
FRACTION = dict(scale=100.0, scale_unit="%")


# Choix de pivot commun aux modifieurs de transformation
# « Auto » : le modifieur Pivot s'il y en a un, sinon le centre des formes
PIVOT_OPTIONS = ["Auto", "Centre des formes", "Centre de la mire"]
