"""Formes personnalisées : définitions partagées par toutes leurs occurrences (autres formes, timeline, live).

Une forme n'a pas de notion de temps : ses animations sont dans la timeline (core/animation.py), ses
mouvements cycliques dans les oscillateurs de ses calques. Plus de copies cachées de formes (D5).
"""

from .nodes import GroupNode, new_id


class ShapeDef:
    def __init__(self, name="Forme", root=None, def_id=None):
        self.id = def_id or new_id()
        self.name = name
        self.root = root or GroupNode(name)

    def uses_def(self, def_id, library, seen=None):
        """Vrai si cette forme contient (directement ou non) la forme def_id (évite les boucles)."""
        seen = seen or set()
        if self.id in seen:
            return False
        seen.add(self.id)
        for n in self.root.walk():
            if n.kind == "instance":
                if n.def_id == def_id:
                    return True
                d = library.get(n.def_id)
                if d and d.uses_def(def_id, library, seen):
                    return True
        return False

    def to_dict(self):
        return {"id": self.id, "name": self.name, "root": self.root.to_dict()}

    @classmethod
    def from_dict(cls, d):
        from .nodes import node_from_dict
        return cls(d.get("name", "Forme"), node_from_dict(d["root"]), d.get("id"))


class Library:
    def __init__(self):
        self.defs = []

    def visible(self):
        """Formes de la liste (toutes : il n'y a plus de copies cachées)."""
        return list(self.defs)

    def get(self, def_id):
        return next((d for d in self.defs if d.id == def_id), None)

    def add(self, d):
        self.defs.append(d)
        return d

    def remove(self, def_id):
        self.defs = [d for d in self.defs if d.id != def_id]

    def to_dict(self):
        return [d.to_dict() for d in self.defs]

    @classmethod
    def from_dict(cls, data):
        lib = cls()
        lib.defs = [ShapeDef.from_dict(d) for d in data or []]
        return lib
