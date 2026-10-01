import tkinter as tk

try:
    from ..core.transform import Transform2D
    from ..core.layer import Layer
except (ImportError, ValueError):
    from core.transform import Transform2D
    from core.layer import Layer


class UndoClipboardMixin:
    """Gestion de l'historique Annuler / Rétablir (Undo/Redo) et du Presse-papier (Copier, Couper, Coller)."""

    def get_state_snapshot(self) -> dict:
        """Capture un instantané complet de l'état des calques et sélections."""
        return {
            "layers": [l.clone() for l in self.layers],
            "selected_layer_id": self.selected_layer.id if getattr(self, "selected_layer", None) else None,
            "selected_layer_ids": {l.id for l in getattr(self, "selected_layers", set())},
            "selected_idx": self.selected_idx,
            "selected_indices": set(self.selected_indices),
            "layer_counter": self.layer_counter,
        }

    def _apply_snapshot(self, snapshot: dict):
        """Restaure un instantané complet."""
        self.layers = [l.clone() for l in snapshot["layers"]]
        self.layer_counter = snapshot["layer_counter"]
        self.selected_idx = snapshot["selected_idx"]
        self.selected_indices = set(snapshot.get("selected_indices", set()))

        def find_layer_by_id(layers_list, target_id):
            for l in layers_list:
                if l.id == target_id:
                    return l
                if l.shape_type == "group":
                    found = find_layer_by_id(l.children, target_id)
                    if found is not None:
                        return found
            return None

        sel_id = snapshot.get("selected_layer_id")
        sel_ids = snapshot.get("selected_layer_ids", set())
        self.selected_layers = set()
        for lid in sel_ids:
            found = find_layer_by_id(self.layers, lid)
            if found is not None:
                self.selected_layers.add(found)
        if sel_id is not None:
            self.selected_layer = find_layer_by_id(self.layers, sel_id)
        elif self.selected_layers:
            self.selected_layer = next(iter(self.selected_layers))
        else:
            self.selected_layer = None

        if not self.selected_layers and 0 <= self.selected_idx < len(self.layers):
            self.selected_layer = self.layers[self.selected_idx]
            self.selected_layers = {self.selected_layer}

        self._sync_legacy_indices()
        self._refresh_layers_ui()
        self.redraw_canvas()

    def push_undo_state(self):
        """Enregistre l'état actuel dans la pile d'annulation pour Ctrl+Z."""
        self.undo_stack.append(self.get_state_snapshot())
        if len(self.undo_stack) > self._max_undo:
            self.undo_stack.pop(0)
        self.redo_stack.clear()
        self.set_dirty(True)

    def undo(self, event=None):
        """Ctrl+Z : Annule la dernière action."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        if not self.undo_stack:
            return "break"
        self.redo_stack.append(self.get_state_snapshot())
        snapshot = self.undo_stack.pop()
        self._apply_snapshot(snapshot)
        self.set_dirty(True)
        self.lbl_status.config(text="Annulé (Ctrl+Z)", fg="#ffb74d")
        return "break"

    def redo(self, event=None):
        """Ctrl+Y / Ctrl+Shift+Z : Rétablit la dernière action annulée."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        if not self.redo_stack:
            return "break"
        self.undo_stack.append(self.get_state_snapshot())
        snapshot = self.redo_stack.pop()
        self._apply_snapshot(snapshot)
        self.set_dirty(True)
        self.lbl_status.config(text="Rétabli (Ctrl+Y)", fg="#ba68c8")
        return "break"

    def _layers_match(self, l1: Layer, l2: Layer) -> bool:
        if (abs(l1.x - l2.x) > 1e-4 or
            abs(l1.y - l2.y) > 1e-4 or
            abs(l1.scale_x - l2.scale_x) > 1e-4 or
            abs(l1.scale_y - l2.scale_y) > 1e-4 or
            abs(l1.rotation - l2.rotation) > 1e-4 or
            l1.shape_type != l2.shape_type or
            l1.enabled != l2.enabled or
            len(l1.local_points) != len(l2.local_points) or
            l1.local_points != l2.local_points or
            len(l1.children) != len(l2.children)):
            return False
        for c1, c2 in zip(l1.children, l2.children):
            if not self._layers_match(c1, c2):
                return False
        return True

    def _has_state_changed(self, snap: dict) -> bool:
        """Détecte si l'état des calques ou sommets a changé par rapport à un instantané."""
        if len(self.layers) != len(snap["layers"]):
            return True
        for l_cur, l_old in zip(self.layers, snap["layers"]):
            if not self._layers_match(l_cur, l_old):
                return True
        return False

    def copy_selected_layer(self, event=None):
        """Ctrl+C : Copie le(s) calque(s) sélectionné(s) (depuis le canvas ou la liste des calques)."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        selected = list(getattr(self, "selected_layers", set()))
        if not selected and self.get_current_layer():
            selected = [self.get_current_layer()]
        if not selected:
            return "break"

        # Conserver l'ordre visuel de la liste des calques
        ordered_sel = []
        if hasattr(self, "_listbox_items_map"):
            for item_layer, _, _ in self._listbox_items_map:
                if item_layer in selected and item_layer not in ordered_sel:
                    ordered_sel.append(item_layer)
        if not ordered_sel:
            ordered_sel = selected

        copied_layers = []
        for l in ordered_sel:
            dup = l.clone()
            world_mat = self.get_layer_world_matrix(l)
            wx, wy, wsx, wsy, wrot = world_mat.decompose()
            dup.x = wx
            dup.y = wy
            dup.scale_x = wsx
            dup.scale_y = wsy
            dup.rotation = wrot
            copied_layers.append(dup)

        self.clipboard_layers = copied_layers
        self.clipboard_layer = copied_layers[0] if copied_layers else None
        names_str = f"'{copied_layers[0].name}'" if len(copied_layers) == 1 else f"{len(copied_layers)} calques"
        self.lbl_status.config(text=f"Copié : {names_str} (Ctrl+C)", fg="#80d8ff")
        return "break"

    def cut_selected_layer(self, event=None):
        """Ctrl+X : Coupe le(s) calque(s) sélectionné(s) (presse-papier puis suppression)."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        selected = list(getattr(self, "selected_layers", set()))
        if not selected and self.get_current_layer():
            selected = [self.get_current_layer()]
        if not selected:
            return "break"

        self.copy_selected_layer(event)
        names_str = f"'{selected[0].name}'" if len(selected) == 1 else f"{len(selected)} calques"
        self.delete_selected_layer()
        self.lbl_status.config(text=f"Coupé : {names_str} (Ctrl+X)", fg="#80d8ff")
        return "break"

    def paste_layer(self, event=None):
        """Ctrl+V : Colle le(s) calque(s) copié(s) (dans le canvas et la liste des calques)."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        clip = getattr(self, "clipboard_layers", None)
        if not clip:
            clip = [self.clipboard_layer] if getattr(self, "clipboard_layer", None) else []
        if not clip:
            return "break"

        self.push_undo_state()

        ref_l = self.get_current_layer()
        # Si un groupe est sélectionné, on colle à l'intérieur
        if ref_l and ref_l.shape_type == "group":
            target_parent = ref_l
            target_list = ref_l.children
            insert_idx = len(target_list)
        elif ref_l:
            target_parent = self.find_parent_group(ref_l)
            target_list = target_parent.children if target_parent is not None else self.layers
            insert_idx = target_list.index(ref_l) + 1 if ref_l in target_list else len(target_list)
        else:
            target_parent = None
            target_list = self.layers
            insert_idx = len(target_list)

        parent_mat = self.get_layer_world_matrix(target_parent) if target_parent is not None else Transform2D()
        inv_parent = parent_mat.invert()

        offset = 0.05
        pasted_layers = []

        for clip_layer in clip:
            self.layer_counter += 1
            new_l = clip_layer.clone()
            new_l.id = self.layer_counter

            base_name = clip_layer.name
            if " (Copie" in base_name:
                base_name = base_name.split(" (Copie")[0]
            new_l.name = f"{base_name} (Copie {self.layer_counter})"

            cand_wx = new_l.x + offset
            cand_wy = new_l.y - offset
            cand_world_mat = Transform2D.from_trs(cand_wx, cand_wy, new_l.scale_x, new_l.scale_y, new_l.rotation)
            cand_loc_mat = inv_parent.multiply(cand_world_mat)
            ch_x, ch_y, ch_sx, ch_sy, ch_rot = cand_loc_mat.decompose()
            new_l.x, new_l.y, new_l.scale_x, new_l.scale_y, new_l.rotation = ch_x, ch_y, ch_sx, ch_sy, ch_rot

            if not new_l.fits_in_laser(parent_mat=parent_mat):
                cand_wx = new_l.x - offset
                cand_wy = new_l.y + offset
                cand_world_mat = Transform2D.from_trs(cand_wx, cand_wy, new_l.scale_x, new_l.scale_y, new_l.rotation)
                cand_loc_mat = inv_parent.multiply(cand_world_mat)
                ch_x, ch_y, ch_sx, ch_sy, ch_rot = cand_loc_mat.decompose()
                new_l.x, new_l.y, new_l.scale_x, new_l.scale_y, new_l.rotation = ch_x, ch_y, ch_sx, ch_sy, ch_rot

                if not new_l.fits_in_laser(parent_mat=parent_mat):
                    cand_world_mat = Transform2D.from_trs(clip_layer.x, clip_layer.y, new_l.scale_x, new_l.scale_y, new_l.rotation)
                    cand_loc_mat = inv_parent.multiply(cand_world_mat)
                    ch_x, ch_y, ch_sx, ch_sy, ch_rot = cand_loc_mat.decompose()
                    new_l.x, new_l.y, new_l.scale_x, new_l.scale_y, new_l.rotation = ch_x, ch_y, ch_sx, ch_sy, ch_rot

            target_list.insert(insert_idx, new_l)
            insert_idx += 1
            pasted_layers.append(new_l)

        if target_parent is not None:
            target_parent.is_expanded = True

        self.selected_layers = set(pasted_layers)
        self.selected_layer = pasted_layers[0] if pasted_layers else None
        self._sync_legacy_indices()
        self._sync_listbox_selection()
        self._refresh_layers_ui()
        self.redraw_canvas()

        names_str = f"'{pasted_layers[0].name}'" if len(pasted_layers) == 1 else f"{len(pasted_layers)} calques"
        self.lbl_status.config(text=f"Collé : {names_str} (Ctrl+V)", fg="#66bb6a")
        return "break"
