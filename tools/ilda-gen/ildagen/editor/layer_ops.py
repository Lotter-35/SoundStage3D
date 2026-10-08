"""Opérations sur les calques : ajout, suppression, groupes, déplacement, presse-papiers, formes personnalisées."""

import json

import numpy as np
from PySide6.QtCore import QMimeData
from PySide6.QtGui import QGuiApplication

from ..core import draw_symmetry as DS
from ..core import mathutil as mu
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
        work = self.work_root()
        return (work if work is not None else root), 0

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
        self.mutate(label, do, timeline=True)
        self.set_selection([])

    def delete_selected(self):
        self.delete_nodes(self.top_selected())

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
        parent = root.find(parent_id) if parent_id else self.work_root()
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

    # ── Symétrie de dessin ───────────────────────────────────────────────
    @staticmethod
    def _sym_group(n):
        return (n is not None and n.kind == "group" and n.name == DS.GROUP_NAME and n.children
                and n.children[0].kind == "modifier" and n.children[0].mod_type in DS.SYM_TYPES)

    def draw_insertion_point(self):
        """Où ranger ce qu'on dessine. Symétrie de dessin active : sous le modifieur Symétrie
        correspondant (créé au besoin dans un groupe « Symétrie », centré sur la mire)."""
        parent, idx = self.insertion_point()
        spec = DS.modifier_spec(self.doc.grid)
        sg = parent if self._sym_group(parent) else None
        if sg is not None:
            m = sg.children[0]
            if spec is not None and m.mod_type == spec[0] and all(
                    abs(float(N.get_param(m, k)) - float(v)) < 1e-9 for k, v in spec[1].items()):
                return sg, max(idx, 1)
            # Mode changé (ou symétrie coupée) : on dessine à côté du groupe, pas dedans
            parent, idx = sg.parent, sg.index()
        if spec is None:
            return parent, idx
        g = N.GroupNode(DS.GROUP_NAME)
        m = N.ModifierNode(spec[0], values=dict(spec[1]))
        g.add(m)
        parent.add(g, idx)
        try:
            cx, cy = mu.apply_point(np.linalg.inv(self.parent_matrix(m, self.eval_context())), 0.0, 0.0)
        except np.linalg.LinAlgError:
            cx, cy = 0.0, 0.0
        N.set_param(m, "cx", cx)
        N.set_param(m, "cy", cy)
        g.transform.px, g.transform.py = cx, cy     # le groupe tourne autour du centre de la mire
        return g, 1

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
        """Groupe / modifieur déplié dans la liste : état d'affichage (hors historique, enregistré)."""
        if node.kind == "group" and node.locked:
            expanded = False
        if getattr(node, "expanded", None) != expanded:
            node.expanded = expanded
            self.view_changed()

    # ── Presse-papiers ───────────────────────────────────────────────────
    def copy_selection(self):
        nodes = self.top_selected()
        if not nodes:
            return False
        self.clipboard = [n.to_dict() for n in nodes]     # oscillateurs compris
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
        own_def = self.current_form_id()
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
                c = N.clone_node(n)          # oscillateurs compris
                n.parent.add(c, n.index())
                copies.append(c)
        self.mutate("Dupliquer", do)
        self.set_selection([c.id for c in copies])
        return copies

    # ── Réinitialiser ────────────────────────────────────────────────────
    def reset_params(self, nodes=None):
        """Valeurs par défaut : réglages des modifieurs, transformation et réglages propres des formes."""
        from ..core import shapes
        nodes = [n for n in (nodes if nodes is not None else self.top_selected()) if not n.locked]
        if not nodes:
            return

        def do():
            for n in nodes:
                if n.kind == "modifier":
                    n.values = n.modifier.defaults()
                if n.has_transform:
                    px, py = n.transform.px, n.transform.py
                    n.transform = type(n.transform)()
                    n.transform.px, n.transform.py = px, py
                if n.kind == "shape" and n.shape != "path":
                    n.sparams = shapes.default_params(n.shape)
        self.mutate("Réinitialiser les réglages", do)
        self.statusMessage.emit(f"Réglages réinitialisés ({len(nodes)} calque(s))")

    # ── Modifieurs ───────────────────────────────────────────────────────
    def modifier_targets(self, m):
        """Calques sur lesquels agit un modifieur : ceux en dessous de lui dans son groupe
        (ou, pour un sous-modifieur, le modifieur qui le porte)."""
        p = m.parent
        if p is None:
            return []
        if p.kind == "modifier":
            return [p]
        i = p.children.index(m)
        return [n for n in p.children[i + 1:] if n.kind != "modifier"]

    def modifier_scope(self, mods):
        """Identifiants de tous les calques touchés (contenu des groupes compris)."""
        ids = set()
        for m in mods:
            for t in self.modifier_targets(m):
                ids.update(n.id for n in t.walk() if n.kind != "modifier" or t.kind == "modifier")
        return ids

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
        b["mode"] = 1
        if int(b.get("mode", 1)) not in (1, 2):
            b["mode"] = 1
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
        """Couleur de tracé modifiée (fin du geste) : appliquée aussi aux formes sélectionnées."""
        self.settings.save()
        if self.brush_live():
            self.commit()
        self.brushChanged.emit()

    BRUSH_LABEL = "Couleur de la sélection"

    def brush_live(self):
        """Pendant un réglage (glisser du dégradé, de l'angle) : les formes sélectionnées suivent en direct.
        Renvoie True si une étape « couleur de la sélection » est ouverte."""
        shapes = self.shapes_in(self.top_selected()) if self.editing_visible() else []
        if not shapes:
            return False
        if self.history.pending_label() != self.BRUSH_LABEL:
            self.begin_action(self.BRUSH_LABEL)
        for s in shapes:
            self.apply_brush(s)
        self.notify()
        return True

    def apply_brush(self, node):
        """Donne la couleur de tracé courante à une forme (sans historique : appelé dans un geste)."""
        if node.kind != "shape":
            return
        b = self.brush()
        node.color_mode = 1          # couleur unie (les dégradés passent par le modifieur Dégradé)
        node.color = tuple(b["color"])

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
        self.last_touched = shapes[-1].id
        return len(shapes)

    # ── Formes personnalisées ────────────────────────────────────────────
    def create_custom_shape(self, name):
        nodes = self.top_selected() or list(self.work_root().children)
        if not nodes:
            return None
        own_def = self.current_form_id()
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
        cur = self.current_form_id()
        if cur and (cur == def_id or d.uses_def(cur, self.doc.library)):
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

    def new_form(self, name=None):
        """Bouton « + » de la liste des formes : nouvelle forme vide, sélectionnée."""
        from ..core.document import next_form_name
        d = ShapeDef(name or next_form_name(self.doc.library))
        d.root.name = d.name
        self.mutate("Nouvelle forme", lambda: self.doc.library.add(d), library=True)
        self.enter_def(d.id)
        return d

    def duplicate_form(self, def_id):
        src = self.doc.library.get(def_id)
        if src is None:
            return None
        root = N.clone_node(src.root)
        d = ShapeDef(src.name + " copie", root)
        root.name = d.name

        def do():
            lib = self.doc.library
            lib.defs.insert(lib.defs.index(src) + 1, d)
        self.mutate("Dupliquer la forme", do, library=True)
        self.enter_def(d.id)
        return d

    def delete_def(self, def_id):
        lib = self.doc.library
        if lib.get(def_id) is None:
            return
        removing_current = self.current_form_id() == def_id

        def do():
            lib.remove(def_id)
            for other in lib.defs:
                for n in list(other.root.walk()):
                    if n.kind == "instance" and n.def_id == def_id and n.parent:
                        n.parent.remove(n)
            self.doc.timeline.remove_def(def_id)
            self.doc.live.remove_def(def_id)
            if not lib.defs:
                from ..core.document import ensure_form
                ensure_form(lib)
            if removing_current:
                self.selection = []
                self.form_id = lib.defs[0].id     # la forme en cours doit rester valide
        self.mutate("Supprimer la forme", do, library=True, timeline=True)
        self.liveChanged.emit()
        if removing_current:
            self.contextChanged.emit()
            self.structureChanged.emit()
        self.select_clips([i for i in self.clip_selection if self.doc.timeline.find_clip(i)[1] is not None])
        self.set_selection([])
