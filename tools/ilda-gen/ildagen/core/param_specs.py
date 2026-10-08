"""Description (ParamSpec) de n'importe quel réglage d'un calque, d'après sa clé.

Clés : celles des modifieurs, « tf.* » (transformation), « sp.* » (réglages propres d'une forme de base),
« col.* » (couleur propre d'une forme), « __active__ » (calque actif). Sert aux oscillateurs, aux effets
« Réglage de la forme » et au panneau des réglages.
"""

from . import shape_color
from .params import B, F, I
from .shapes import SHAPE_PARAMS

# Réglages de transformation (clés « tf. ») ; facteur d'affichage pour les échelles en %
TRANSFORM_SPECS = [
    (F("tf.tx", "Position X", 0.0, -8.0, 8.0, decimals=3, soft_min=-1, soft_max=1), 1.0),
    (F("tf.ty", "Position Y", 0.0, -8.0, 8.0, decimals=3, soft_min=-1, soft_max=1), 1.0),
    (F("tf.rot", "Rotation", 0.0, -360.0, 360.0, "°", 1, soft_min=0, soft_max=360), 1.0),
    (F("tf.sx", "Échelle X", 1.0, -100.0, 100.0, " %", 1, soft_min=0, soft_max=2), 100.0),
    (F("tf.sy", "Échelle Y", 1.0, -100.0, 100.0, " %", 1, soft_min=0, soft_max=2), 100.0),
    (F("tf.shear", "Cisaillement", 0.0, -10.0, 10.0, decimals=3, soft_min=-1, soft_max=1), 1.0),
    (F("tf.tilt_x", "Inclinaison X", 0.0, -89.0, 89.0, "°", 1), 1.0),
    (F("tf.tilt_y", "Inclinaison Y", 0.0, -89.0, 89.0, "°", 1), 1.0),
]
TRANSFORM_SPEC = {s.key: s for s, _ in TRANSFORM_SPECS}

# Actif / inactif d'un calque ou d'un modifieur
ACTIVE_SPEC = B("__active__", "Actif", True)


def shape_param_spec(shape, key):
    """Réglage propre d'une forme de base (« sp.branches »…), ou None."""
    p = SHAPE_PARAMS.get(shape, {}).get(key[3:] if key.startswith("sp.") else key)
    if p is None:
        return None
    label, default, lo, hi = p
    return I("sp." + (key[3:] if key.startswith("sp.") else key), label, default, lo, hi)


def param_spec(node, key):
    """ParamSpec du réglage `key` du calque `node`, ou None s'il n'existe pas."""
    if node is None:
        return None
    if key == "__active__":
        return ACTIVE_SPEC
    if key.startswith("tf."):
        return TRANSFORM_SPEC.get(key) if getattr(node, "has_transform", False) else None
    if key.startswith("sp."):
        return shape_param_spec(getattr(node, "shape", ""), key) if node.kind == "shape" else None
    if key.startswith("col."):
        return shape_color.spec(key) if node.kind == "shape" else None
    if node.kind == "modifier" and node.modifier is not None:
        return node.modifier.spec(key)
    return None


def node_param_specs(node):
    """[(spec, facteur d'affichage)] de tous les réglages d'un calque (pour les listes de réglages)."""
    out = []
    if node.kind == "modifier":
        out.append((ACTIVE_SPEC, 1.0))
        if node.modifier is not None:
            out += [(s, 1.0) for s in node.modifier.all_params()]
        return out
    if node.has_transform:
        out += TRANSFORM_SPECS
    if node.kind == "shape":
        for k in SHAPE_PARAMS.get(node.shape, {}):
            out.append((shape_param_spec(node.shape, k), 1.0))
        out += [(s, 1.0) for s in shape_color.SPECS]
    return out


def numeric_keys(node):
    """Clés des réglages numériques d'un calque (ceux qui peuvent porter un oscillateur)."""
    return [s.key for s, _ in node_param_specs(node) if s.kind in ("float", "int")]
