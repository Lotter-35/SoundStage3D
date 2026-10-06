"""Registre des modifieurs. Pour en ajouter un : créer la classe et l'ajouter à la liste MODIFIERS de son module."""

from . import transform_mods, duplicate_mods, deform_mods, path_mods, color_mods, intensity_mods

CATEGORIES = ["Position", "Duplication", "Déformation", "Tracé", "Couleur", "Intensité"]

_ORDERED = []
for _mod in (transform_mods, duplicate_mods, deform_mods, path_mods, color_mods, intensity_mods):
    _ORDERED.extend(cls() for cls in _mod.MODIFIERS)

registry = {m.type_id: m for m in _ORDERED}

# Sous-modifieurs acceptés « sur » un autre modifieur
SUB_MODIFIER_TYPES = ("translate", "rotate", "scale")


def by_category():
    """[(catégorie, [modifieurs…]), …] dans l'ordre d'affichage."""
    return [(c, [m for m in _ORDERED if m.category == c]) for c in CATEGORIES]


def get(type_id):
    return registry.get(type_id)
