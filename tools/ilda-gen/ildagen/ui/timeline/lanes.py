"""Lignes d'automation : réglage visé, plage de valeurs, correspondance valeur ↔ hauteur, clés."""

from ..properties.forms import TRANSFORM_SPECS

PAD = 8


def target(editor, clip, auto):
    """(nœud, spec) visés par l'automation, ou (None, None)."""
    d = editor.doc.library.get(clip.def_id)
    if d is None or auto.armed:
        return None, None
    node = d.root.find(auto.node_id)
    if node is None:
        return None, None
    key = auto.key
    if key.startswith("tf."):
        spec = next((s for s, _ in TRANSFORM_SPECS if s.key == key), None)
        return node, spec
    if key == "__active__":
        from ..properties.forms import ACTIVE_SPEC
        return node, ACTIVE_SPEC
    if node.kind == "modifier":
        return node, node.modifier.spec(key)
    return node, None


def value_range(spec, auto):
    """Plage affichée (min, max) ; élargie pour contenir toutes les clés."""
    if auto.key == "__active__" or (spec is not None and spec.kind == "bool"):
        return 0.0, 1.0
    if spec is not None and spec.kind == "enum":
        return 0.0, float(max(1, len(spec.options) - 1))
    if spec is not None and spec.kind == "color":
        return 0.0, 1.0
    lo = spec.soft_min if spec is not None and spec.soft_min is not None else -1.0
    hi = spec.soft_max if spec is not None and spec.soft_max is not None else 1.0
    vals = [k.v for k in auto.keys if isinstance(k.v, (int, float)) and not isinstance(k.v, bool)]
    if vals:
        lo, hi = min(lo, min(vals)), max(hi, max(vals))
    if hi - lo < 1e-9:
        hi = lo + 1.0
    return float(lo), float(hi)


def is_color(spec):
    return spec is not None and spec.kind == "color"


def v_to_y(v, row, rng):
    lo, hi = rng
    if isinstance(v, bool):
        v = 1.0 if v else 0.0
    if isinstance(v, tuple):
        v = 0.5
    k = (float(v) - lo) / (hi - lo)
    return row.y + row.h - PAD - k * (row.h - 2 * PAD)


def y_to_v(y, row, rng, spec, auto):
    lo, hi = rng
    k = (row.y + row.h - PAD - y) / max(1.0, row.h - 2 * PAD)
    v = lo + k * (hi - lo)
    if auto.key == "__active__" or (spec is not None and spec.kind == "bool"):
        return v >= 0.5
    if spec is not None:
        if spec.kind in ("int", "enum"):
            v = round(v)
        if spec.min is not None:
            v = max(spec.min, v)
        if spec.max is not None:
            v = min(spec.max, v)
    return v


def format_value(v, spec):
    if isinstance(v, bool):
        return "Oui" if v else "Non"
    if isinstance(v, tuple):
        return "#%02x%02x%02x" % tuple(int(c * 255) for c in v)
    if spec is not None and spec.kind == "enum" and spec.options:
        i = int(round(v))
        return spec.options[i] if 0 <= i < len(spec.options) else str(i)
    if spec is not None and spec.key in ("tf.sx", "tf.sy"):
        return f"{v * 100:.1f} %"
    unit = spec.unit if spec is not None else ""
    dec = spec.decimals if spec is not None else 2
    return f"{v:.{dec}f}{unit}"
