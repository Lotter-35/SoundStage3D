"""Automations : courbes de valeurs dans le temps, liées à un paramètre d'un calque."""

from .nodes import new_id

# (identifiant, libellé, poignées de Bézier x1, y1, x2, y2 — comme cubic-bezier en CSS)
CURVES = [
    ("linear", "Linéaire", (0.0, 0.0, 1.0, 1.0)),
    ("ease_in", "Accélération", (0.42, 0.0, 1.0, 1.0)),
    ("ease_out", "Ralentissement", (0.0, 0.0, 0.58, 1.0)),
    ("ease_in_out", "En S", (0.42, 0.0, 0.58, 1.0)),
    ("hold", "Palier", None),
    ("custom", "Bézier personnalisé", None),
]
# Clic simple sur un point (rampe par défaut) : carré → sinusoïdale (S réglable avec les poignées) → rampe…
CLICK_CYCLE = [("linear", "Rampe"), ("hold", "Carré"), ("custom", "Sinusoïdale")]
S_HANDLES = [0.42, 0.0, 0.58, 1.0]
CURVE_HANDLES = {c[0]: c[2] for c in CURVES}
CURVE_LABELS = {c[0]: c[1] for c in CURVES}
# Deux clés plus proches que ceci n'en font qu'une (la nouvelle valeur remplace l'ancienne) :
# 1 ms quand la durée du clip est connue, sinon un millionième de clip (instants en proportion de la durée,
# arrondis à 6 décimales à l'enregistrement)
KEY_MERGE_S = 1e-3
KEY_MERGE_U = 1e-6


def bezier_ease(x, x1, y1, x2, y2):
    """y d'une courbe cubic-bezier (0,0)-(x1,y1)-(x2,y2)-(1,1) pour une abscisse x."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0

    def bx(u):
        return 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3

    def by(u):
        return 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3

    lo, hi = 0.0, 1.0
    u = x
    for _ in range(30):
        u = (lo + hi) / 2
        if bx(u) < x:
            lo = u
        else:
            hi = u
    return by(u)


class Keyframe:
    __slots__ = ("t", "v", "curve", "h")

    def __init__(self, t, v, curve="linear", h=None):
        self.t = float(t)
        self.v = v
        self.curve = curve
        self.h = list(h) if h else [0.33, 0.0, 0.67, 1.0]   # poignées si « custom »

    def handles(self):
        if self.curve == "custom":
            return tuple(self.h)
        return CURVE_HANDLES.get(self.curve) or (0.0, 0.0, 1.0, 1.0)

    def to_dict(self):
        v = list(self.v) if isinstance(self.v, (tuple, list)) else self.v
        return {"t": round(self.t, 6), "v": v, "c": self.curve, "h": [round(x, 4) for x in self.h]}

    @classmethod
    def from_dict(cls, d):
        v = d.get("v", 0.0)
        if isinstance(v, list):
            v = tuple(v)
        return cls(d.get("t", 0.0), v, d.get("c", "linear"), d.get("h"))


def _lerp(a, b, k):
    if isinstance(a, tuple):
        return tuple(x + (y - x) * k for x, y in zip(a, b))
    if isinstance(a, bool):
        return a if k < 1.0 else b
    return a + (b - a) * k


class Automation:
    """Courbe d'un paramètre. node_id vide = automation « en attente » (liée au prochain réglage touché)."""

    def __init__(self, node_id="", key="", label="", auto_id=None):
        self.id = auto_id or new_id()
        self.node_id = node_id
        self.key = key
        self.label = label
        self.keys = []
        self.discrete = False   # bool / liste : pas d'interpolation

    @property
    def armed(self):
        return not self.node_id

    def bind(self, node_id, key, label, discrete=False):
        self.node_id = node_id
        self.key = key
        self.label = label
        self.discrete = discrete

    def sort(self):
        self.keys.sort(key=lambda k: k.t)

    def cycle_curve(self, k):
        """Clic sur un point : la façon d'arriver sur lui change (rampe → carré → sinusoïdale → rampe).
        Le premier point règle le trajet qui part de lui. Renvoie le libellé choisi, ou None."""
        if self.discrete or k not in self.keys:
            return None
        i = self.keys.index(k)
        seg = self.keys[i - 1] if i > 0 else k
        order = [c for c, _ in CLICK_CYCLE]
        cur = seg.curve if seg.curve in order else ("custom" if seg.curve.startswith("ease") else "linear")
        nxt = order[(order.index(cur) + 1) % len(order)]
        seg.curve = nxt
        if nxt == "custom":
            seg.h = list(S_HANDLES)
        return dict(CLICK_CYCLE)[nxt]

    def value_at(self, t):
        ks = self.keys
        if not ks:
            return None
        if t <= ks[0].t:
            return ks[0].v
        if t >= ks[-1].t:
            return ks[-1].v
        for i in range(len(ks) - 1):
            a, b = ks[i], ks[i + 1]
            if a.t <= t < b.t:
                if self.discrete or a.curve == "hold" or b.t - a.t < 1e-9:
                    return a.v
                x = (t - a.t) / (b.t - a.t)
                return _lerp(a.v, b.v, bezier_ease(x, *a.handles()))
        return ks[-1].v

    def set_key(self, t, v, duration=None, tolerance=None):
        """Ajoute ou remplace la clé à l'instant t (proportion du clip) ; renvoie la clé.
        duration : durée du clip (s), pour une tolérance de fusion absolue dans le temps."""
        if tolerance is None:
            tolerance = KEY_MERGE_U
            if duration is not None and duration > 1e-9:
                tolerance = max(KEY_MERGE_U, KEY_MERGE_S / duration)
        for k in self.keys:
            if abs(k.t - t) <= tolerance:
                k.v = v
                return k
        k = Keyframe(t, v, "hold" if self.discrete else "linear")
        self.keys.append(k)
        self.sort()
        return k

    def to_dict(self):
        return {"id": self.id, "node_id": self.node_id, "key": self.key, "label": self.label,
                "discrete": self.discrete, "keys": [k.to_dict() for k in self.keys]}

    @classmethod
    def from_dict(cls, d):
        a = cls(d.get("node_id", ""), d.get("key", ""), d.get("label", ""), d.get("id"))
        a.discrete = d.get("discrete", False)
        a.keys = [Keyframe.from_dict(k) for k in d.get("keys", [])]
        a.sort()
        return a
