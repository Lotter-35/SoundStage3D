import math
import tkinter as tk
import tkinter.font as tkfont

try:
    from ..core.transform import Transform2D
    from ..core.layer import Layer
except (ImportError, ValueError):
    from core.transform import Transform2D
    from core.layer import Layer


class LayerListboxMixin:
    """Gestion de la liste des calques : sélection multiple, drag-and-drop, visibilité œil, pliage/dépliage, menu contextuel."""

    def _sync_legacy_indices(self):
        self.selected_indices = set()
        for layer in getattr(self, "selected_layers", set()):
            if layer in self.layers:
                self.selected_indices.add(self.layers.index(layer))
        cur = getattr(self, "selected_layer", None)
        if cur in self.layers:
            self.selected_idx = self.layers.index(cur)
        else:
            self.selected_idx = -1

    def _sync_listbox_selection(self):
        self.layer_listbox.selection_clear(0, tk.END)
        if not hasattr(self, "_listbox_items_map"):
            return
        selected_layers = getattr(self, "selected_layers", set())
        for lb_idx, (layer, parent_group, depth) in enumerate(self._listbox_items_map):
            if layer in selected_layers or (not selected_layers and layer in self.layers and self.layers.index(layer) in self.selected_indices):
                self.layer_listbox.selection_set(lb_idx)
                if layer is self.get_current_layer():
                    self.layer_listbox.see(lb_idx)

    def _on_listbox_select(self, _event):
        if not hasattr(self, "_listbox_items_map"):
            return
        sel = self.layer_listbox.curselection()
        if not sel:
            self.selected_layers = set()
            self.selected_layer = None
            self.selected_indices.clear()
            self.selected_idx = -1
            self.redraw_canvas()
            return
        new_selected = set()
        for lb_idx in sel:
            if lb_idx < len(self._listbox_items_map):
                layer, parent_group, _ = self._listbox_items_map[lb_idx]
                new_selected.add(layer)

        if new_selected:
            self.selected_layers = new_selected
            if getattr(self, "selected_layer", None) not in self.selected_layers:
                self.selected_layer = next(iter(self.selected_layers))
            self._sync_legacy_indices()
        else:
            self.selected_layers = set()
            self.selected_layer = None
            self.selected_indices.clear()
            self.selected_idx = -1
        self.redraw_canvas()

    def _refresh_layers_ui(self):
        self.layer_listbox.delete(0, tk.END)
        self._listbox_items_map = []

        def add_item(layer: Layer, depth: int, parent_group: Layer | None):
            lb_idx = len(self._listbox_items_map)
            self._listbox_items_map.append((layer, parent_group, depth))
            vis_icon = "👁" if layer.enabled else "🚫"
            indent = "  " * depth

            if layer.shape_type == "group":
                exp_icon = "▼ " if layer.is_expanded else "▶ "
                text = f"{vis_icon}  {indent}{exp_icon}📁 {layer.name} ({len(layer.children)})"
            elif layer.shape_type == "circle":
                text = f"{vis_icon}  {indent}◯ {layer.name}"
            elif layer.shape_type == "line":
                text = f"{vis_icon}  {indent}― {layer.name}"
            elif layer.shape_type == "point":
                text = f"{vis_icon}  {indent}✦ {layer.name}"
            elif layer.shape_type == "pencil":
                text = f"{vis_icon}  {indent}✎ {layer.name}"
            else:
                text = f"{vis_icon}  {indent}• {layer.name}"

            self.layer_listbox.insert(tk.END, f" {text}")
            if not layer.enabled:
                self.layer_listbox.itemconfig(lb_idx, fg="#666666")
            else:
                self.layer_listbox.itemconfig(lb_idx, fg="#ffffff")

            if layer.shape_type == "group" and layer.is_expanded:
                for child in layer.children:
                    add_item(child, depth + 1, layer)

        for l in self.layers:
            add_item(l, 0, None)

        self._sync_listbox_selection()
        self.update_count()

    def toggle_layer_visibility(self, target_layer: Layer | None = None, event=None):
        """Bascule la visibilité (masquer / afficher) d'un calque uniquement en cliquant sur son œil.
        Si la cible est un groupe, propage l'état à tous les éléments enfants."""
        if target_layer is None:
            return "break"

        self.push_undo_state()
        new_state = not target_layer.enabled
        target_layer.enabled = new_state

        if target_layer.shape_type == "group":
            def set_children_visibility(grp: Layer, state: bool):
                for child in grp.children:
                    child.enabled = state
                    if child.shape_type == "group":
                        set_children_visibility(child, state)
            set_children_visibility(target_layer, new_state)
        elif target_layer.enabled:
            # Si un enfant est activé dans un groupe masqué, réactiver également les parents pour qu'il soit visible
            curr = self.find_parent_group(target_layer)
            while curr is not None:
                curr.enabled = True
                curr = self.find_parent_group(curr)

        self._refresh_layers_ui()
        self.redraw_canvas()

        state_str = "affiché" if target_layer.enabled else "masqué"
        if target_layer.shape_type == "group":
            self.lbl_status.config(
                text=f"Groupe '{target_layer.name}' ({len(target_layer.children)} éléments) : {state_str}",
                fg="#66bb6a" if target_layer.enabled else "#ffb74d"
            )
        else:
            self.lbl_status.config(
                text=f"{target_layer.name} : {state_str}",
                fg="#66bb6a" if target_layer.enabled else "#ffb74d"
            )
        return "break"

    def _on_listbox_click(self, event):
        """Clic gauche dans la liste : bascule la visibilité UNIQUEMENT si clic sur l'icône œil."""
        if not hasattr(self, "_listbox_items_map") or not self._listbox_items_map:
            return "break"
        idx = self.layer_listbox.nearest(event.y)
        if not (0 <= idx < len(self._listbox_items_map)):
            return "break"
        bbox = self.layer_listbox.bbox(idx)
        if bbox and not (bbox[1] <= event.y <= bbox[1] + bbox[3]):
            return "break"
        layer, parent_group, depth = self._listbox_items_map[idx]
        # L'icône œil est alignée verticalement sur la première colonne (x <= 24 pixels)
        if event.x <= 24:
            self.toggle_layer_visibility(target_layer=layer)
            return "break"

    def _cancel_hover_expand(self):
        """Annule le délai d'expansion automatique de sur-calque au survol."""
        job = getattr(self, "_lb_hover_expand_job", None)
        if job is not None:
            try:
                self.root.after_cancel(job)
            except Exception:
                pass
            self._lb_hover_expand_job = None
            self._lb_hover_expand_layer = None

    def _auto_expand_group(self, group_layer):
        """Déplie automatiquement un sur-calque survolé pendant le glisser-déposer."""
        self._cancel_hover_expand()
        if group_layer and group_layer.shape_type == "group" and not group_layer.is_expanded:
            group_layer.is_expanded = True
            self._refresh_layers_ui()

    def _is_descendant_of(self, possible_child: Layer | None, ancestor: Layer) -> bool:
        """Vérifie si possible_child est l'ancêtre lui-même ou un descendant de l'ancêtre."""
        if possible_child is None or ancestor is None:
            return False
        if possible_child is ancestor:
            return True
        curr = self.find_parent_group(possible_child)
        visited = set()
        while curr is not None and curr not in visited:
            if curr is ancestor:
                return True
            visited.add(curr)
            curr = self.find_parent_group(curr)
        return False

    def _show_lb_marquee(self, x1: int, y1: int, x2: int, y2: int):
        """Affiche le rectangle de sélection dans la liste des calques."""
        lb_w = self.layer_listbox.winfo_width()
        lb_h = self.layer_listbox.winfo_height()

        cx1 = max(0, min(lb_w - 2, x1))
        cy1 = max(0, min(lb_h - 2, y1))
        cx2 = max(0, min(lb_w - 2, x2))
        cy2 = max(0, min(lb_h - 2, y2))

        rx1, ry1 = min(cx1, cx2), min(cy1, cy2)
        rx2, ry2 = max(cx1, cx2), max(cy1, cy2)
        rw = max(1, rx2 - rx1)
        rh = max(1, ry2 - ry1)

        if hasattr(self, "_lb_mq_top"):
            self._lb_mq_top.place(x=rx1, y=ry1, width=rw, height=1)
            self._lb_mq_bottom.place(x=rx1, y=ry2, width=rw, height=1)
            self._lb_mq_left.place(x=rx1, y=ry1, width=1, height=rh)
            self._lb_mq_right.place(x=rx2, y=ry1, width=1, height=rh)

            for w in (self._lb_mq_top, self._lb_mq_bottom, self._lb_mq_left, self._lb_mq_right):
                w.lift()

    def _hide_lb_marquee(self):
        """Masque le rectangle de sélection de la liste des calques."""
        if hasattr(self, "_lb_mq_top"):
            for w in (self._lb_mq_top, self._lb_mq_bottom, self._lb_mq_left, self._lb_mq_right):
                w.place_forget()

    def _get_listbox_item_at(self, event_x: int, event_y: int) -> int | None:
        """Détecte précisément si (event_x, event_y) est situé directement sur un calque de la liste.
        Retourne l'index de l'élément dans _listbox_items_map, ou None si dans le vide."""
        total = len(self._listbox_items_map) if hasattr(self, "_listbox_items_map") else 0
        if total == 0:
            return None

        nearest_idx = self.layer_listbox.nearest(event_y)
        if not (0 <= nearest_idx < total):
            return None

        bbox = self.layer_listbox.bbox(nearest_idx)
        if bbox:
            bx, by, bw, bh = bbox
        else:
            top_idx = self.layer_listbox.nearest(0)
            top_bbox = self.layer_listbox.bbox(top_idx)
            font = tkfont.Font(font=self.layer_listbox.cget("font"))
            bh = top_bbox[3] if top_bbox else (font.metrics("linespace") + 3)
            top_y = top_bbox[1] if top_bbox else 2
            by = top_y + (nearest_idx - top_idx) * bh
            try:
                text = self.layer_listbox.get(nearest_idx)
                bw = font.measure(text)
            except Exception:
                bw = 120
            bx = 2

        # 1. Vérification verticale : la souris doit être dans la hauteur réelle de cette ligne
        if not (by <= event_y <= by + bh):
            return None

        # 2. Vérification horizontale : la souris doit être sur l'intitulé de la ligne (pas sur l'œil <= 24 et pas dans le vide à droite)
        text_end_x = max(bx + bw + 16, 90)
        if 24 < event_x <= text_end_x:
            return nearest_idx

        return None

    def _on_listbox_press(self, event):
        """Début de clic, sélection par rectangle ou glisser-déposer dans la liste des calques."""
        # Clic sur l'icône œil : basculer la visibilité uniquement
        if event.x <= 24:
            self._lb_drag_idx = None
            self._lb_did_move = False
            return self._on_listbox_click(event)

        self.layer_listbox.focus_set()
        self._cancel_hover_expand()
        self._hide_lb_marquee()
        if hasattr(self, "_lb_drop_line"):
            self._lb_drop_line.place_forget()

        is_shift, is_alt, is_ctrl = self._get_modifiers(event)
        self._lb_press_is_ctrl = is_ctrl
        self._lb_press_is_shift = is_shift

        clicked_idx = self._get_listbox_item_at(event.x, event.y)
        is_in_empty = (clicked_idx is None)

        self._lb_drag_start_x = event.x
        self._lb_drag_start_y = event.y
        self._lb_drag_idx = clicked_idx
        self._lb_drag_is_in_empty = is_in_empty
        self._lb_drag_mode = None
        self._lb_marquee_orig_sel = set(self.selected_layers) if (is_ctrl or is_shift) else set()
        self._lb_did_move = False

        if clicked_idx is not None:
            layer, parent_group, depth = self._listbox_items_map[clicked_idx]
            # Clic direct sur la flèche de pliage/dépliage d'un dossier
            arrow_max_x = 42 + depth * 6
            if layer.shape_type == "group" and 24 < event.x <= arrow_max_x:
                self._lb_drag_idx = None
                self._lb_did_move = False
                layer.is_expanded = not layer.is_expanded
                self._refresh_layers_ui()
                return "break"
            if is_ctrl:
                if layer in self.selected_layers:
                    self.selected_layers.remove(layer)
                    if self.selected_layer is layer:
                        self.selected_layer = next(iter(self.selected_layers)) if self.selected_layers else None
                    self.lbl_status.config(text=f"Désélectionné : {layer.name}", fg="#ffb74d")
                else:
                    self.selected_layers.add(layer)
                    self.selected_layer = layer
                    self.lbl_status.config(text=f"Sélectionné : {layer.name}", fg="#80d8ff")
                self._sync_legacy_indices()
                self._sync_listbox_selection()
                self.redraw_canvas()
                return "break"
            elif is_shift:
                ref_layer = self.get_current_layer()
                ref_idx = clicked_idx
                if ref_layer:
                    for i, (l, _, _) in enumerate(self._listbox_items_map):
                        if l is ref_layer:
                            ref_idx = i
                            break
                start_i, end_i = min(ref_idx, clicked_idx), max(ref_idx, clicked_idx)
                for i in range(start_i, end_i + 1):
                    self.selected_layers.add(self._listbox_items_map[i][0])
                self.selected_layer = layer
                self._sync_legacy_indices()
                self._sync_listbox_selection()
                self.redraw_canvas()
                return "break"
            else:
                if layer not in self.selected_layers:
                    self.select_layer_object(layer)
                return "break"

        return "break"

    def _on_listbox_motion(self, event):
        """Mouvement de souris avec bouton enfoncé : rectangle de sélection ou réarrangement avec trait."""
        if not hasattr(self, "_lb_drag_start_x"):
            return "break"

        dx = event.x - self._lb_drag_start_x
        dy = event.y - self._lb_drag_start_y
        dist = math.hypot(dx, dy)

        if not getattr(self, "_lb_did_move", False) and dist >= 5:
            self._lb_did_move = True
            is_ctrl = getattr(self, "_lb_press_is_ctrl", False)
            is_shift = getattr(self, "_lb_press_is_shift", False)
            is_empty = getattr(self, "_lb_drag_is_in_empty", False)
            drag_idx = getattr(self, "_lb_drag_idx", None)

            # Reorder UNIQUEMENT si on a cliqué DIRECTEMENT sur l'élément (drag_idx valide), pas dans le vide, sans Ctrl/Shift
            if drag_idx is not None and not is_empty and not is_ctrl and not is_shift and abs(dx) < 16:
                self._lb_drag_mode = "reorder"
            else:
                self._lb_drag_mode = "marquee"

        if not getattr(self, "_lb_did_move", False):
            return "break"

        # ── Mode 1 : Rectangle de sélection (Marquee) ─────────────────────
        if self._lb_drag_mode == "marquee":
            lb_h = self.layer_listbox.winfo_height()
            if event.y < 15:
                self.layer_listbox.yview_scroll(-1, "units")
            elif event.y > lb_h - 15:
                self.layer_listbox.yview_scroll(1, "units")

            self._show_lb_marquee(self._lb_drag_start_x, self._lb_drag_start_y, event.x, event.y)
            self.layer_listbox.config(cursor="crosshair")

            ry1 = min(self._lb_drag_start_y, event.y)
            ry2 = max(self._lb_drag_start_y, event.y)

            touched_layers = set()
            total_items = len(self._listbox_items_map) if hasattr(self, "_listbox_items_map") else 0
            for idx in range(total_items):
                bbox = self.layer_listbox.bbox(idx)
                if not bbox:
                    continue
                item_y1 = bbox[1]
                item_y2 = bbox[1] + bbox[3]
                if ry2 >= item_y1 and ry1 <= item_y2:
                    touched_layers.add(self._listbox_items_map[idx][0])

            is_ctrl = getattr(self, "_lb_press_is_ctrl", False)
            is_shift = getattr(self, "_lb_press_is_shift", False)
            orig_sel = getattr(self, "_lb_marquee_orig_sel", set())

            if is_ctrl or is_shift:
                new_sel = orig_sel | touched_layers
            else:
                new_sel = touched_layers

            self.selected_layers = set(new_sel)
            if self.selected_layers:
                if self.selected_layer not in self.selected_layers:
                    self.selected_layer = next(iter(self.selected_layers))
            else:
                self.selected_layer = None

            self._sync_legacy_indices()
            self._sync_listbox_selection()
            self.redraw_canvas()

            count = len(self.selected_layers)
            if count > 0:
                self.lbl_status.config(text=f"{count} calque(s) sélectionné(s) via rectangle", fg="#80d8ff")
            else:
                self.lbl_status.config(text="Aucun calque sélectionné", fg="#888888")

            return "break"

        # ── Mode 2 : Réarrangement de calque (Reorder avec trait de destination) ─
        elif self._lb_drag_mode == "reorder":
            total_items = len(self._listbox_items_map) if hasattr(self, "_listbox_items_map") else 0
            if total_items == 0 or getattr(self, "_lb_drag_idx", None) is None:
                return "break"

            lb_h = self.layer_listbox.winfo_height()
            if event.y < 15:
                self.layer_listbox.yview_scroll(-1, "units")
            elif event.y > lb_h - 15:
                self.layer_listbox.yview_scroll(1, "units")

            target_idx = self.layer_listbox.nearest(event.y)
            target_idx = max(0, min(total_items - 1, target_idx))
            bbox = self.layer_listbox.bbox(target_idx)
            if not bbox:
                return "break"

            drag_layer = self._listbox_items_map[self._lb_drag_idx][0]
            hover_layer, hover_parent, hover_depth = self._listbox_items_map[target_idx]

            last_bbox = self.layer_listbox.bbox(total_items - 1)
            is_below_all = (last_bbox and event.y > (last_bbox[1] + last_bbox[3] + 4))

            if is_below_all:
                self._cancel_hover_expand()
                self._lb_drop_target = ("root_end", False)
                line_y = last_bbox[1] + last_bbox[3]
                target_depth = 0
                is_invalid = False
            else:
                mid_y = bbox[1] + bbox[3] / 2.0
                is_top = (event.y < mid_y)
                self._lb_drop_target = (target_idx, is_top)
                line_y = bbox[1] if is_top else bbox[1] + bbox[3]

                if not is_top and hover_layer.shape_type == "group":
                    target_depth = hover_depth + 1
                else:
                    target_depth = hover_depth

                is_invalid = False
                if drag_layer.shape_type == "group":
                    if hover_layer is drag_layer or self._is_descendant_of(hover_layer, drag_layer):
                        is_invalid = True

                if hover_layer.shape_type == "group" and not hover_layer.is_expanded and not is_invalid:
                    if getattr(self, "_lb_hover_expand_layer", None) != hover_layer:
                        self._cancel_hover_expand()
                        self._lb_hover_expand_layer = hover_layer
                        self._lb_hover_expand_job = self.root.after(600, lambda l=hover_layer: self._auto_expand_group(l))
                else:
                    self._cancel_hover_expand()

            lb_w = self.layer_listbox.winfo_width()
            line_x = min(lb_w - 20, max(0, 24 + target_depth * 14))
            line_w = max(20, lb_w - line_x)
            line_color = "#ff5252" if is_invalid else "#00e5ff"

            if hasattr(self, "_lb_drop_line"):
                self._lb_drop_line.config(bg=line_color)
                self._lb_drop_line.place(x=line_x, y=max(0, line_y - 1), width=line_w, height=2)
                self._lb_drop_line.lift()

            self.layer_listbox.config(cursor="no" if is_invalid else "sb_v_double_arrow")
            return "break"

    def _on_listbox_release(self, event):
        """Relâchement du clic : finalise la sélection par rectangle ou le réarrangement."""
        self._cancel_hover_expand()
        self._hide_lb_marquee()
        if hasattr(self, "_lb_drop_line"):
            self._lb_drop_line.place_forget()
        self.layer_listbox.config(cursor="")

        did_move = getattr(self, "_lb_did_move", False)
        drag_mode = getattr(self, "_lb_drag_mode", None)
        drag_idx = getattr(self, "_lb_drag_idx", None)
        drop_target = getattr(self, "_lb_drop_target", None)
        is_empty = getattr(self, "_lb_drag_is_in_empty", False)
        is_ctrl = getattr(self, "_lb_press_is_ctrl", False)
        is_shift = getattr(self, "_lb_press_is_shift", False)

        self._lb_did_move = False
        self._lb_drag_mode = None
        self._lb_drag_idx = None
        self._lb_drop_target = None

        if not did_move:
            # Clic simple sans glisser
            if is_empty:
                if not (is_ctrl or is_shift):
                    self.selected_layers.clear()
                    self.selected_layer = None
                    self._sync_legacy_indices()
                    self._sync_listbox_selection()
                    self.redraw_canvas()
                    self.lbl_status.config(text="Sélection réinitialisée", fg="#888888")
            elif drag_idx is not None and not (is_ctrl or is_shift):
                if hasattr(self, "_listbox_items_map") and 0 <= drag_idx < len(self._listbox_items_map):
                    layer = self._listbox_items_map[drag_idx][0]
                    self.select_layer_object(layer)
            return "break"

        if drag_mode == "reorder":
            if drag_idx is not None and drop_target is not None:
                self._apply_listbox_drop(drag_idx, drop_target)
            return "break"

        elif drag_mode == "marquee":
            count = len(self.selected_layers)
            if count > 0:
                self.lbl_status.config(text=f"{count} calque(s) sélectionné(s) via rectangle", fg="#80d8ff")
            else:
                self.lbl_status.config(text="Aucun calque sélectionné", fg="#888888")
            return "break"

    def _on_listbox_leave(self, event):
        """Sortie de la souris de la liste des calques."""
        self._cancel_hover_expand()
        if not getattr(self, "_lb_did_move", False):
            self._hide_lb_marquee()
            if hasattr(self, "_lb_drop_line"):
                self._lb_drop_line.place_forget()

    def _apply_listbox_drop(self, drag_idx: int, drop_target):
        """Applique le réarrangement ou le changement de parent avec préservation des coordonnées monde."""
        if not hasattr(self, "_listbox_items_map") or not (0 <= drag_idx < len(self._listbox_items_map)):
            return

        drag_layer, old_parent, _ = self._listbox_items_map[drag_idx]

        if drop_target[0] == "root_end":
            new_parent = None
            target_list = self.layers
            target_gap = len(target_list)
        else:
            target_idx, is_top = drop_target
            if not (0 <= target_idx < len(self._listbox_items_map)):
                return
            hover_layer, hover_parent, hover_depth = self._listbox_items_map[target_idx]

            # Sécurité anti-boucle : impossible d'imbriquer un groupe dans lui-même ou ses enfants
            if drag_layer.shape_type == "group":
                if hover_layer is drag_layer or self._is_descendant_of(hover_layer, drag_layer):
                    self.lbl_status.config(text="Impossible de déplacer un sur-calque dans lui-même", fg="#ff5252")
                    return

            if is_top:
                new_parent = hover_parent
                target_list = new_parent.children if new_parent else self.layers
                target_gap = target_list.index(hover_layer) if hover_layer in target_list else len(target_list)
            else:
                if hover_layer.shape_type == "group":
                    new_parent = hover_layer
                    target_list = hover_layer.children
                    target_gap = 0 if hover_layer.is_expanded else len(hover_layer.children)
                else:
                    new_parent = hover_parent
                    target_list = new_parent.children if new_parent else self.layers
                    target_gap = (target_list.index(hover_layer) + 1) if hover_layer in target_list else len(target_list)

        source_list = old_parent.children if old_parent else self.layers

        if source_list is target_list:
            if drag_layer not in source_list:
                return
            old_pos = source_list.index(drag_layer)
            if target_gap == old_pos or target_gap == old_pos + 1:
                return  # Déjà exactement à cette position
            self.push_undo_state()
            source_list.pop(old_pos)
            if old_pos < target_gap:
                target_gap -= 1
            target_list.insert(target_gap, drag_layer)
        else:
            self.push_undo_state()
            # Préservation absolue des coordonnées monde lors du changement de parent
            world_mat = self.get_layer_world_matrix(drag_layer)
            if drag_layer in source_list:
                source_list.remove(drag_layer)
            if target_gap > len(target_list):
                target_gap = len(target_list)
            target_list.insert(target_gap, drag_layer)

            new_parent_mat = self.get_layer_world_matrix(new_parent) if new_parent else Transform2D()
            inv_parent_mat = new_parent_mat.invert()
            loc_mat = inv_parent_mat.multiply(world_mat)
            lx, ly, lsx, lsy, lrot = loc_mat.decompose()
            drag_layer.x = lx
            drag_layer.y = ly
            drag_layer.scale_x = lsx
            drag_layer.scale_y = lsy
            drag_layer.rotation = lrot

            if new_parent is not None:
                new_parent.is_expanded = True

        self.select_layer_object(drag_layer)
        self.lbl_status.config(text=f"Déplacé : {drag_layer.name}", fg="#66bb6a")

    def _on_listbox_right_click(self, event):
        """Clic droit dans la liste des calques : menu contextuel complet."""
        idx = self.layer_listbox.nearest(event.y)
        clicked_on_item = False
        if hasattr(self, "_listbox_items_map") and 0 <= idx < len(self._listbox_items_map):
            bbox = self.layer_listbox.bbox(idx)
            if bbox and bbox[1] <= event.y <= bbox[1] + bbox[3]:
                clicked_on_item = True

        menu = tk.Menu(self.root, tearoff=0, bg="#252526", fg="#ffffff", activebackground="#007acc", activeforeground="#ffffff")

        if clicked_on_item:
            layer, parent_group, depth = self._listbox_items_map[idx]
            if layer not in getattr(self, "selected_layers", set()):
                self.select_layer_object(layer)

            vis_label = f"👁 Afficher '{layer.name}'" if not layer.enabled else f"🚫 Masquer '{layer.name}'"
            menu.add_command(label=vis_label, command=lambda: self.toggle_layer_visibility(layer))
            menu.add_separator()
            if layer.shape_type == "group":
                menu.add_command(label="📁+ Nouveau sous-groupe vide", command=self.create_empty_group)
            else:
                menu.add_command(label="📁+ Nouveau groupe vide", command=self.create_empty_group)
            menu.add_command(label="📁 Grouper en sur-calque (Ctrl+G)", command=self.group_selected_layers)
            if layer.shape_type == "group" or parent_group is not None:
                menu.add_command(label="📂 Dégrouper (Ctrl+Shift+G)", command=self.ungroup_selected_layer)
            menu.add_separator()
            menu.add_command(label="✓ Tout sélectionner visibles (Ctrl+A)", command=self.select_all_visible_layers)
            menu.add_separator()
            menu.add_command(label="✂ Couper (Ctrl+X)", command=self.cut_selected_layer)
            menu.add_command(label="📋 Copier (Ctrl+C)", command=self.copy_selected_layer)
            menu.add_command(label="📋 Coller (Ctrl+V)", command=self.paste_layer)
            menu.add_command(label="🗑 Supprimer (Suppr)", command=self.delete_selected_layer)
        else:
            menu.add_command(label="📁+ Nouveau groupe vide", command=self.create_empty_group)
            menu.add_separator()
            menu.add_command(label="✓ Tout sélectionner visibles (Ctrl+A)", command=self.select_all_visible_layers)
            menu.add_command(label="📋 Coller (Ctrl+V)", command=self.paste_layer)

        try:
            menu.tk_popup(event.x_root, event.y_root)
        finally:
            menu.grab_release()

    def _on_listbox_double_click(self, event):
        """Double-clic dans la liste : ignore l'œil et la flèche (déjà gérés par simple clic),
        ouvre / ferme le sur-calque si double-clic sur son intitulé."""
        if getattr(event, "x", 999) <= 24:
            return "break"
        idx = self.layer_listbox.nearest(event.y)
        if hasattr(self, "_listbox_items_map") and 0 <= idx < len(self._listbox_items_map):
            layer, parent_group, depth = self._listbox_items_map[idx]
            arrow_max_x = 42 + depth * 6
            if layer.shape_type == "group":
                # Si le double-clic est sur la flèche, le simple clic l'a déjà basculé.
                # Ne pas rebasculer ici pour éviter d'annuler le second clic !
                if event.x <= arrow_max_x:
                    return "break"
                layer.is_expanded = not layer.is_expanded
                self._refresh_layers_ui()
                return "break"
        return "break"

    def _on_listbox_triple_click(self, event):
        """Triple-clic ou clics répétés dans la liste : ne rien faire de superflu."""
        return "break"
