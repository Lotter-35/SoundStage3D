"""Arbre des calques : formes, groupes, instances de formes personnalisées, modifieurs.

Ordre : children[0] est en HAUT de la liste (comme dans Photoshop). Un modifieur agit sur
ce qui est en dessous de lui dans le même groupe.
"""

import uuid

from . import shape_color, shapes
from .path import Path
from .transform import Transform
from . import mathutil as mu


def new_id():
    return uuid.uuid4().hex[:12]


class Node:
    kind = "node"
    has_transform = False
    can_contain = False

    def __init__(self, name="", node_id=None):
        self.id = node_id or new_id()
        self.name = name
        self.visible = True
        self.locked = False
        self.parent = None
        self.children = []

    # ── Arbre ────────────────────────────────────────────────────────────
    def add(self, child, index=None):
        if child.parent is not None:
            child.parent.remove(child)
        child.parent = self
        if index is None or index > len(self.children):
            self.children.append(child)
        else:
            self.children.insert(max(0, index), child)

    def remove(self, child):
        if child in self.children:
            self.children.remove(child)
        child.parent = None

    def index(self):
        return self.parent.children.index(self) if self.parent else 0

    def walk(self):
        yield self
        for c in self.children:
            yield from c.walk()

    def ancestors(self):
        p = self.parent
        while p is not None:
            yield p
            p = p.parent

    def is_descendant_of(self, other):
        return any(a is other for a in self.ancestors())

    def find(self, node_id):
        for n in self.walk():
            if n.id == node_id:
                return n
        return None

    def effectively_visible(self):
        return self.visible and all(a.visible for a in self.ancestors())

    def locked_ancestor(self):
        """Groupe verrouillé le plus haut qui contient ce nœud (ou None)."""
        found = None
        for a in self.ancestors():
            if a.locked and a.kind == "group":
                found = a
        return found

    # ── Sérialisation ───────────────────────────────────────────────────
    def base_dict(self):
        return {"kind": self.kind, "id": self.id, "name": self.name, "visible": self.visible, "locked": self.locked}

    def to_dict(self):
        return self.base_dict()

    def load_base(self, d):
        self.id = d.get("id", self.id)
        self.name = d.get("name", self.name)
        self.visible = d.get("visible", True)
        self.locked = d.get("locked", False)


class ShapeNode(Node):
    """Forme dessinée : primitive (rect, cercle…) ou tracé libre."""

    kind = "shape"
    has_transform = True

    def __init__(self, shape="path", rect=(-0.5, -0.5, 0.5, 0.5), paths=None, name="", node_id=None):
        super().__init__(name or shapes.SHAPE_LABELS.get(shape, "Forme"), node_id)
        self.shape = shape
        self.rect = tuple(rect)
        self.sparams = shapes.default_params(shape)
        self.paths = paths or []
        self.transform = Transform()
        # Couleur propre (0 = par défaut, 1 = unie, 2 = dégradé)
        self.color_mode = 0
        self.color = (1.0, 1.0, 1.0)
        self.stops = [list(s) for s in shape_color.DEFAULT_STOPS]
        self.grad_type = 0
        self.grad_angle = 0.0
        self.center_pivot()

    def local_paths(self):
        if self.shape == "path":
            return self.paths
        return shapes.build(self.shape, self.rect, self.sparams)

    def local_bbox(self):
        boxes = [mu.bbox(p.pts) for p in self.local_paths()]
        return mu.union_bbox(boxes)

    def center_pivot(self):
        b = self.local_bbox()
        if b:
            self.transform.px = (b[0] + b[2]) / 2
            self.transform.py = (b[1] + b[3]) / 2

    def bake(self, paths):
        """Remplace la géométrie par des tracés libres (après une déformation)."""
        self.shape = "path"
        self.paths = paths
        self.sparams = {}

    def to_dict(self):
        d = self.base_dict()
        d.update({"shape": self.shape, "rect": list(self.rect), "sparams": dict(self.sparams),
                  "paths": [p.to_dict() for p in self.paths], "transform": self.transform.to_dict()})
        if self.color_mode:
            d["color"] = {"mode": self.color_mode, "color": list(self.color), "stops": [list(s) for s in self.stops],
                          "type": self.grad_type, "angle": self.grad_angle}
        return d

    @classmethod
    def from_dict(cls, d):
        n = cls(d.get("shape", "path"), d.get("rect", (-0.5, -0.5, 0.5, 0.5)),
                [Path.from_dict(p) for p in d.get("paths", [])])
        n.load_base(d)
        n.sparams.update(d.get("sparams", {}))
        n.transform = Transform.from_dict(d.get("transform", {}))
        c = d.get("color")
        if c:
            n.color_mode = int(c.get("mode", 0))
            n.color = tuple(c.get("color", n.color))
            n.stops = [list(s) for s in c.get("stops", n.stops)]
            n.grad_type = int(c.get("type", 0))
            n.grad_angle = float(c.get("angle", 0.0))
        return n


class GroupNode(Node):
    kind = "group"
    has_transform = True
    can_contain = True

    def __init__(self, name="Groupe", node_id=None):
        super().__init__(name, node_id)
        self.expanded = True
        self.main = False          # groupe principal de la scène (obligatoire, contient tout)
        self.transform = Transform()

    def to_dict(self):
        d = self.base_dict()
        if self.main:
            d["main"] = True
        d.update({"expanded": self.expanded, "transform": self.transform.to_dict(),
                  "children": [c.to_dict() for c in self.children]})
        return d

    @classmethod
    def from_dict(cls, d):
        n = cls(d.get("name", "Groupe"))
        n.load_base(d)
        n.expanded = d.get("expanded", True)
        n.main = bool(d.get("main", False))
        n.transform = Transform.from_dict(d.get("transform", {}))
        for cd in d.get("children", []):
            n.add(node_from_dict(cd))
        return n


class InstanceNode(Node):
    """Forme personnalisée placée dans la scène (liée à sa définition)."""

    kind = "instance"
    has_transform = True

    def __init__(self, def_id="", name="", node_id=None):
        super().__init__(name, node_id)
        self.def_id = def_id
        self.transform = Transform()

    def to_dict(self):
        d = self.base_dict()
        d.update({"def_id": self.def_id, "transform": self.transform.to_dict()})
        return d

    @classmethod
    def from_dict(cls, d):
        n = cls(d.get("def_id", ""))
        n.load_base(d)
        n.transform = Transform.from_dict(d.get("transform", {}))
        return n


class ModifierNode(Node):
    """Modifieur placé dans la pile. Ses enfants sont des sous-modifieurs qui agissent sur SES réglages."""

    kind = "modifier"
    can_contain = True

    def __init__(self, mod_type="translate", values=None, name="", node_id=None):
        from .modifiers import registry
        mod = registry.get(mod_type)
        super().__init__(name or (mod.label if mod else mod_type), node_id)
        self.mod_type = mod_type
        self.values = mod.defaults() if mod else {}
        if values:
            self.values.update(values)
        self.expanded = False      # sous-modifieurs visibles
        self.show_params = False   # réglages affichés dans la ligne du calque

    @property
    def modifier(self):
        from .modifiers import registry
        return registry.get(self.mod_type)

    def to_dict(self):
        d = self.base_dict()
        vals = {}
        for k, v in self.values.items():
            vals[k] = list(v) if isinstance(v, tuple) else v
        d.update({"mod_type": self.mod_type, "values": vals, "expanded": self.expanded,
                  "show_params": self.show_params, "children": [c.to_dict() for c in self.children]})
        return d

    @classmethod
    def from_dict(cls, d):
        n = cls(d.get("mod_type", "translate"))
        n.load_base(d)
        mod = n.modifier
        for k, v in d.get("values", {}).items():
            spec = mod.spec(k) if mod else None
            if spec is not None and spec.kind == "color":
                v = tuple(v)
            n.values[k] = v
        n.expanded = d.get("expanded", False)
        n.show_params = d.get("show_params", False)
        for cd in d.get("children", []):
            n.add(node_from_dict(cd))
        return n


NODE_CLASSES = {"shape": ShapeNode, "group": GroupNode, "instance": InstanceNode, "modifier": ModifierNode}


def node_from_dict(d):
    cls = NODE_CLASSES.get(d.get("kind"))
    if cls is None:
        raise ValueError(f"Type de calque inconnu : {d.get('kind')}")
    return cls.from_dict(d)


def clone_node(node):
    """Copie profonde avec de nouveaux identifiants."""
    d = node.to_dict()
    d.pop("main", None)

    def renew(x):
        x["id"] = new_id()
        for c in x.get("children", []):
            renew(c)
    renew(d)
    return node_from_dict(d)


# ── Accès générique aux paramètres (automations, panneau Propriétés) ─────────

def get_param(node, key):
    if key.startswith("tf.") and node.has_transform:
        return getattr(node.transform, key[3:])
    if key.startswith("sp.") and isinstance(node, ShapeNode):
        return node.sparams.get(key[3:])
    if key.startswith("col.") and isinstance(node, ShapeNode) and key[4:] in shape_color.ATTRS:
        return getattr(node, shape_color.ATTRS[key[4:]])
    if key == "__active__":
        return node.visible
    if isinstance(node, ModifierNode):
        return node.values.get(key)
    return None


def set_param(node, key, value):
    if key.startswith("tf.") and node.has_transform:
        setattr(node.transform, key[3:], float(value))
    elif key.startswith("sp.") and isinstance(node, ShapeNode):
        node.sparams[key[3:]] = value
    elif key.startswith("col.") and isinstance(node, ShapeNode) and key[4:] in shape_color.ATTRS:
        if key == "col.color":
            value = tuple(value)
        elif key == "col.stops":
            value = [list(s) for s in value]
        setattr(node, shape_color.ATTRS[key[4:]], value)
    elif key == "__active__":
        node.visible = bool(value)
    elif isinstance(node, ModifierNode):
        node.values[key] = value
