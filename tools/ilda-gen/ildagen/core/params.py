"""Description des paramètres réglables (modifieurs, formes) : type, bornes, unité."""


class ParamSpec:
    """kind : float, int, bool, enum, color, gradient."""

    def __init__(self, key, label, kind="float", default=0.0, min=None, max=None, step=None,
                 unit="", options=None, decimals=2, soft_min=None, soft_max=None):
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


def F(key, label, default=0.0, min=None, max=None, unit="", decimals=2, step=None, soft_min=None, soft_max=None):
    return ParamSpec(key, label, "float", default, min, max, step, unit, decimals=decimals,
                     soft_min=soft_min, soft_max=soft_max)


def I(key, label, default=0, min=None, max=None, unit="", soft_min=None, soft_max=None):
    return ParamSpec(key, label, "int", default, min, max, 1, unit, decimals=0, soft_min=soft_min, soft_max=soft_max)


def B(key, label, default=False):
    return ParamSpec(key, label, "bool", default)


def E(key, label, options, default=0):
    return ParamSpec(key, label, "enum", default, options=options)


def C(key, label, default=(1.0, 1.0, 1.0)):
    return ParamSpec(key, label, "color", tuple(default))


def G(key, label, default):
    return ParamSpec(key, label, "gradient", default)


# Choix de pivot commun aux modifieurs de transformation
# « Auto » : le modifieur Pivot s'il y en a un, sinon le centre des formes
PIVOT_OPTIONS = ["Auto", "Centre des formes", "Centre de la mire"]
