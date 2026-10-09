"""Espace Forme : dessiner et régler la forme, sans la notion de temps.

FormeWorkspace est chargé à la demande (les briques de ce paquet servent aussi ailleurs sans tout importer)."""

__all__ = ["FormeWorkspace"]


def __getattr__(name):
    if name == "FormeWorkspace":
        from .workspace import FormeWorkspace
        return FormeWorkspace
    raise AttributeError(name)
