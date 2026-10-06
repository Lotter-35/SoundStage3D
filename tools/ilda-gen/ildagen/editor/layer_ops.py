"""Opérations sur les calques : ajout, suppression, groupes, déplacement, presse-papiers, formes personnalisées."""

import json

from PySide6.QtCore import QMimeData
from PySide6.QtGui import QGuiApplication

from ..core import nodes as N
from ..core.evaluator import EvalContext, eval_children
from ..core.library import ShapeDef
from ..core.modifiers import SUB_MODIFIER_TYPES, registry
from ..core.path import strokes_bbox

CLIP_MIME = "application/x-ildagen-nodes"


class LayerOpsMixin:
    # ── Où insérer un nouveau calque : au-dessus du calque sélectionné ───
    def insertion_point(self):
        root = self.current_root()
        sel = self.top_selected()
        if sel:
            n = sel[0]
            parent = n.parent
            if parent is not None and not parent.locked and parent.kind == "group" and not n.locked_ancestor():
                return parent, parent.children.index(n)
        return root, 0

    def add_node(self, node, label="Ajouter un calque", select=True, parent=None, index=None):
        def do():
            p, i = (parent, index) if parent is not None else self.insertion_point()
            p.add(node, i)
        self.mutate(label, do)
        if select:
            self.set_selection([node.id])
        return node

    # ── Suppression ──────────────────────────────────────────────────────
    def delete_nodes(self, nodes, label="Supprimer"):
        nodes = [n for n in nodes if n.parent is not None]
        if not nodes:
            return

        def do():
            for n in nodes:
                if n.parent is not None:
                    n.parent.remove(n)
            self.prune_automations()
        self.mutate(label, do, timeline=True)
        self.set_selection([])

    def delete_selected(self):
        self.delete_nodes(self.top_selected())

    def prune_automations(self):
        """Supprime les automations dont le calque n'existe plus."""
        for _, clip in self.doc.timeline.all_clips():
            d = self.doc.library.get(clip.def_id)
            if d is None:
                continue
            clip.automations = [a for a in clip.automations if a.armed or d.root.find(a.node_id) is not None]

    # ── Déplacement (glisser-déposer) ────────────────────────────────────
    def can_drop(self, node, parent):
        if parent is None or node is parent or parent.is_descendant_of(node):
            return False
        if parent.kind == "group":
            return not parent.locked and not parent.locked_ancestor()
        if parent.kind == "modifier":
            return node.kind == "modifier" and node.mod_type in SUB_MODIFIER_TYPES
        return False

    def move_nodes(self, ids, parent_id, index):
        root = self.current_root()
        parent = root.find(parent_id) if parent_id else root
        nodes = [root.find(i) for i in ids]
        nodes = [n for n in nodes if n is not None]
        ids_set = {n.id for n in nodes}
        nodes = [n for n in nodes if not any(a.id in ids_set for a in n.ancestors())]
        nodes = [n for n in nodes if self.can_drop(n, parent)]
        if not nodes:
            return False

        def do():
            i = index
            for n in nodes:
                if n.parent is parent and parent.children.index(n) < i:
                    i -= 1
            for n in nodes:
                parent.remove(n) if n.parent is parent else n.parent.remove(n)
            for k, n in enumerate(nodes):
                parent.add(n, i + k)
            if parent.kind == "group":
                parent.expanded = True
            if parent.kind == "modifier":
                parent.expanded = True
        self.mutate("Déplacer", do)
        self.set_selection([n.id for n in nodes])
        return True

    # ── Groupes ──────────────────────────────────────────────────────────
    def group_selected(self):
        nodes = self.top_selected()
        if not nodes:
            return
        parent = nodes[0].parent
        if parent is None or parent.kind != "group":
            return
        g = N.GroupNode("Groupe")

        def do():
            idx = min(n.index() for n in nodes if n.parent is parent) if any(n.parent is parent for n in nodes) else 0
            ordered = sorted(nodes, key=lambda n: (n.parent is not parent, n.index()))
            for n in ordered:
                n.parent.remove(n)
                g.add(n)
            parent.add(g, idx)
            self._center_group_pivot(g)
        self.mutate("Grouper", do)
        self.set_selection([g.id])

    def _center_group_pivot(self, g):
        ctx = EvalContext(self.doc.library, 0.0, self.doc.timeline.bpm, self.default_color())
        b = strokes_bbox(eval_children(g.children, ctx))
        if b:
            g.transform.px, g.transform.py = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2

    def ungroup_selected(self):
        groups = [n for n in self.top_selected() if n.kind == "group"]
        if not groups:
            return
        moved = []

        def do():
            for g in groups:
                parent = g.parent
                idx = g.index()
                gm = g.transform
                for k, c in enumerate(list(g.children)):
                    if c.has_transform and not gm.is_identity():
                        self._compose_into(c, gm)
                    g.remove(c)
                    parent.add(c, idx + k)
                    moved.append(c.id)
                parent.remove(g)
        self.mutate("Dégrouper", do)
        self.set_selection(moved)

    def _compose_into(self, child, parent_tf):
        m = parent_tf.affine() @ child.transform.affine()
        child.transform.set_affine(m)
        child.transform.tilt_x += parent_tf.tilt_x
        child.transform.tilt_y += parent_tf.tilt_y

    def new_empty_layer(self):
        """Calque vide : le prochain trait au crayon le remplit."""
        from ..core.nodes import ShapeNode
        n = ShapeNode("path", name="Calque")
        n.paths = []
        self.apply_brush(n)
        self.add_node(n, "Nouveau calque")
        return n

    def empty_selected_layer(self):
        sel = self.top_selected()
        if len(sel) == 1 and sel[0].kind == "shape" and sel[0].shape == "path" and not sel[0].paths \
                and not sel[0].locked:
            return sel[0]
        return None

    def group_or_new_group(self):
        if self.top_selected():
            self.group_selected()
        else:
            self.new_empty_group()

    def new_empty_group(self):
        self.add_node(N.GroupNode("Groupe"), "Nouveau groupe")

    # ── États (œil, verrou, nom, dépliage) ───────────────────────────────
    def set_visible(self, node, visible):
        def do():
            for n in node.walk():
                n.visible = visible
        self.mutate("Afficher" if visible else "Masquer", do, structure=False)
        self.structureChanged.emit()

    def toggle_visible_selected(self):
        sel = self.top_selected()
        if sel:
            v = not sel[0].visible

            def do():
                for s in sel:
                    for n in s.walk():
                        n.visible = v
            self.mutate("Afficher / masquer", do)

    def set_locked(self, nodes, locked):
        def do():
            for n in nodes:
                n.locked = locked
                if locked and n.kind == "group":
                    n.expanded = False
        self.mutate("Verrouiller" if locked else "Déverrouiller", do)

    def rename(self, node, name):
        name = name.strip()
        if name and name != node.name:
            self.mutate("Renommer", lambda: setattr(node, "name", name))

    def set_expanded(self, node, expanded):
        if node.kind == "group" and node.locked:
            expanded = False
        if getattr(node, "expanded", None) != expanded:
            node.expanded = expanded

    # ── Presse-papiers ───────────────────────────────────────────────────
    def copy_selection(self):
        nodes = self.top_selected()
        if not nodes:
            return False
        self.clipboard = [n.to_dict() for n in nodes]
        md = QMimeData()
        md.setData(CLIP_MIME, json.dumps(self.clipboard).encode("utf-8"))
        QGuiApplication.clipboard().setMimeData(md)
        self.statusMessage.emit(f"{len(nodes)} calque(s) copié(s)")
        return True

    def cut_selection(self):
        if self.copy_selection():
            self.delete_nodes(self.top_selected(), "Couper")

    def _clipboard_items(self):
        md = QGuiApplication.clipboard().mimeData()
        if md is not None and md.hasFormat(CLIP_MIME):
            try:
                return json.loads(bytes(md.data(CLIP_MIME)).decode("utf-8"))
            except ValueError:
                pass
        return self.clipboard

    def paste(self):
        items = self._clipboard_items()
        if not items:
            return
        root = self.current_root()
        own_def = self.context[1] if self.context[0] == "def" else None
        new_nodes = []
        for d in items:
            n = N.clone_node(N.node_from_dict(d))
            bad = [x for x in n.walk() if x.kind == "instance" and (
                self.doc.library.get(x.def_id) is None or x.def_id == own_def or
                (own_def and self.doc.library.get(x.def_id).uses_def(own_def, self.doc.library)))]
            if bad:
                continue
            new_nodes.append(n)
        if not new_nodes:
            return

        def do():
            parent, idx = self.insertion_point()
            if parent is None:
                parent, idx = root, 0
            for k, n in enumerate(new_nodes):
                parent.add(n, idx + k)
        self.mutate("Coller", do)
        self.set_selection([n.id for n in new_nodes])

    def duplicate_selection(self):
        nodes = self.top_selected()
        if not nodes:
            return []
        copies = []

        def do():
            for n in nodes:
                c = N.clone_node(n)
                n.parent.add(c, n.index())
                copies.append(c)
        self.mutate("Dupliquer", do)
        self.set_selection([c.id for c in copies])
        return copies

    # ── Modifieurs ───────────────────────────────────────────────────────
    def add_modifier(self, type_id, onto=None):
        if type_id not in registry:
            return None
        m = N.ModifierNode(type_id)
        if onto is not None and onto.kind == "modifier" and type_id in SUB_MODIFIER_TYPES:
            def do():
                onto.add(m, 0)
                onto.expanded = True
            self.mutate("Ajouter un sous-modifieur", do)
        else:
            m.expanded = True
            self.add_node(m, "Ajouter un modifieur", select=False)
        self.set_selection([m.id])
        return m

    # ── Couleur de tracé et seau ─────────────────────────────────────────
    def brush(self):
        b = self.settings.section("brush")
        if int(b.get("mode", 1)) not in (1, 2):
            b["mode"] = 1              # ancien mode « par défaut »
        b.setdefault("bg", [1.0, 0.0, 0.0])
        return b

    def swap_colors(self):
        b = self.brush()
        b["color"], b["bg"] = b["bg"], b["color"]
        b["mode"] = 1
        self.brush_changed()

    def reset_colors(self):
        b = self.brush()
        b["color"], b["bg"], b["mode"] = [1.0, 1.0, 1.0], [1.0, 0.0, 0.0], 1
        self.brush_changed()

    def brush_changed(self):
        self.settings.save()
        self.brushChanged.emit()

    def apply_brush(self, node):
        """Donne la couleur de tracé courante à une forme (sans historique : appelé dans un geste)."""
        if node.kind != "shape":
            return
        b = self.brush()
        node.color_mode = int(b["mode"])
        node.color = tuple(b["color"])
        node.stops = [list(s) for s in b["stops"]]
        node.grad_type = int(b["type"])
        node.grad_angle = float(b["angle"])

    def shapes_in(self, nodes):
        """Formes contenues dans des calques (les groupes sont parcourus, les modifieurs ignorés)."""
        out = []
        for n in nodes:
            for x in n.walk():
                if x.kind == "shape" and x not in out and not (x.locked or x.locked_ancestor()):
                    out.append(x)
        return out

    def paint_nodes(self, nodes, label="Seau"):
        shapes = self.shapes_in(nodes)
        if not shapes:
            return 0

        def do():
            for s in shapes:
                self.apply_brush(s)
        self.mutate(label, do, structure=False)
        self.structureChanged.emit()
        return len(shapes)

    # ── Formes personnalisées ────────────────────────────────────────────
    def create_custom_shape(self, name):
        root = self.current_root()
        nodes = self.top_selected() or [c for c in root.children]
        if not nodes:
            return None
        own_def = self.context[1] if self.context[0] in ("def",) else None
        parent = nodes[0].parent
        d = ShapeDef(name)
        inst = N.InstanceNode(d.id, name)

        def do():
            idx = min(n.index() for n in nodes if n.parent is parent)
            for n in sorted(nodes, key=lambda n: (n.parent is not parent, n.index())):
                n.parent.remove(n)
                d.root.add(n)
            self.doc.library.add(d)
            parent.add(inst, idx)
            ctx = EvalContext(self.doc.library, 0.0, self.doc.timeline.bpm, self.default_color())
            b = strokes_bbox(eval_children(d.root.children, ctx))
            if b:
                inst.transform.px, inst.transform.py = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        if own_def and any(x.kind == "instance" and x.def_id == own_def for n in nodes for x in n.walk()):
            return None
        self.mutate("Créer une forme personnalisée", do, library=True)
        self.set_selection([inst.id])
        return d

    def place_instance(self, def_id, pos=None):
        d = self.doc.library.get(def_id)
        if d is None:
            return None
        if self.context[0] in ("def", "clip"):
            own = self.current_root()
            cur_def = next((x for x in self.doc.library.defs if x.root is own), None)
            if cur_def and (cur_def.id == def_id or d.uses_def(cur_def.id, self.doc.library)):
                self.statusMessage.emit("Impossible : une forme ne peut pas se contenir elle-même")
                return None
        inst = N.InstanceNode(def_id, d.name)
        ctx = EvalContext(self.doc.library, 0.0, self.doc.timeline.bpm, self.default_color())
        b = strokes_bbox(eval_children(d.root.children, ctx))
        if b:
            inst.transform.px, inst.transform.py = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
            if pos is not None:
                inst.transform.tx = pos[0] - inst.transform.px
                inst.transform.ty = pos[1] - inst.transform.py
        return self.add_node(inst, "Placer une forme")

    def rename_def(self, def_id, name):
        d = self.doc.library.get(def_id)
        if d and name.strip():
            def do():
                d.name = name.strip()
                d.root.name = d.name
            self.mutate("Renommer la forme", do, library=True, timeline=True)

    def delete_def(self, def_id):
        if self.context[1] == def_id or (self.context[0] == "clip" and self.current_clip() and
                                          self.current_clip().def_id == def_id):
            self.enter_scene()

        def do():
            self.doc.library.remove(def_id)
            for n in list(self.doc.scene.walk()):
                if n.kind == "instance" and n.def_id == def_id and n.parent:
                    n.parent.remove(n)
            for other in self.doc.library.defs:
                for n in list(other.root.walk()):
                    if n.kind == "instance" and n.def_id == def_id and n.parent:
                        n.parent.remove(n)
            self.doc.timeline.remove_def(def_id)
        self.mutate("Supprimer la forme", do, library=True, timeline=True)
        self.set_selection([])
