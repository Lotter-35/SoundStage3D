"""Formes personnalisées : définitions partagées par toutes leurs occurrences (autres formes et timeline).

Les automations d'une forme lui appartiennent : tous les clips liés à la forme les partagent. Un clip
« délié » reçoit une copie cachée de la forme (absente de la liste de gauche), avec ses propres automations.
"""

from .nodes import GroupNode, new_id


class ShapeDef:
    def __init__(self, name="Forme", root=None, def_id=None):
        self.id = def_id or new_id()
        self.name = name
        self.root = root or GroupNode(name)
        self.automations = []     # partagées par tous les clips liés à cette forme
        self.hidden = False       # copie déliée d'une forme (pas dans la liste de gauche)
        self.source_id = None     # forme d'origine d'une copie déliée
        self.legacy = False       # ancien projet : automations encore rangées dans les clips

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
        d = {"id": self.id, "name": self.name, "root": self.root.to_dict(),
             "automations": [a.to_dict() for a in self.automations]}
        if self.hidden:
            d["hidden"] = True
            d["source"] = self.source_id
        return d

    @classmethod
    def from_dict(cls, d):
        from .automation import Automation
        from .nodes import node_from_dict
        sd = cls(d.get("name", "Forme"), node_from_dict(d["root"]), d.get("id"))
        sd.automations = [Automation.from_dict(a) for a in d.get("automations", [])]
        sd.legacy = "automations" not in d
        sd.hidden = bool(d.get("hidden", False))
        sd.source_id = d.get("source")
        return sd


class Library:
    def __init__(self):
        self.defs = []

    def visible(self):
        """Formes de la liste de gauche (sans les copies déliées)."""
        return [d for d in self.defs if not d.hidden]

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


def _autos_sig(autos):
    return [{k: v for k, v in a.to_dict().items() if k != "id"} for a in autos]


def unlink_clip(library, clip):
    """Le clip reçoit sa propre copie de la forme (cachée), avec une copie de ses automations."""
    from .automation import Automation
    from .nodes import new_id, node_from_dict
    src = library.get(clip.def_id)
    if src is None:
        return None
    nd = ShapeDef(src.name, node_from_dict(src.root.to_dict()))     # mêmes identifiants de calques
    nd.hidden = True
    nd.source_id = src.source_id if src.hidden else src.id
    nd.automations = [Automation.from_dict(dict(a.to_dict(), id=new_id())) for a in src.automations]
    library.add(nd)
    clip.def_id = nd.id
    clip.automations = nd.automations
    return nd


def relink_clip(library, clip):
    """Le clip délié reprend la forme d'origine (et ses automations) ; sa copie est oubliée."""
    cur = library.get(clip.def_id)
    if cur is None or not cur.hidden:
        return None
    src = library.get(cur.source_id)
    if src is None:
        return None
    clip.def_id = src.id
    clip.automations = src.automations
    return src


def link_clips(library, timeline):
    """Après chargement : chaque clip partage la liste d'automations de sa forme. Anciens projets : les
    automations des clips remontent dans la forme ; un clip aux automations différentes est délié."""
    for d in list(library.defs):
        clips = [c for _, c in timeline.all_clips() if c.def_id == d.id]
        if d.legacy:
            d.legacy = False
            first = next((c for c in clips if c.automations), None)
            d.automations = list(first.automations) if first is not None else []
            for c in clips:
                if c is not first and c.automations and _autos_sig(c.automations) != _autos_sig(d.automations):
                    own = list(c.automations)
                    nd = unlink_clip(library, c)
                    nd.automations[:] = own
                    c.automations = nd.automations
        for c in timeline.all_clips():
            if c[1].def_id == d.id:
                c[1].automations = d.automations
    # Copies déliées qui ne servent plus à aucun clip : oubliées
    used = {c.def_id for _, c in timeline.all_clips()}
    library.defs = [d for d in library.defs if not d.hidden or d.id in used]
