import math
import sys
import tkinter as tk

try:
    from ..core.constants import CANVAS_SIZE
    from ..core.geometry import dist_pt_seg
    from ..core.transform import Transform2D
    from ..core.layer import Layer
except (ImportError, ValueError):
    from core.constants import CANVAS_SIZE
    from core.geometry import dist_pt_seg
    from core.transform import Transform2D
    from core.layer import Layer

try:
    import ctypes
    _user32 = ctypes.windll.user32
except Exception:
    _user32 = None


class CanvasEventsMixin:
    """Gestion des événements souris, clavier, navigation (zoom, pan) et manipulation d'objets sur le Canvas laser."""

    def _reset_modifier_keys(self, _event=None):
        self.key_shift_pressed = False
        self.key_ctrl_pressed = False
        self.key_alt_pressed = False
        if getattr(self, "_pencil_hover_pt", None) is not None:
            self._pencil_hover_pt = None
            self.redraw_canvas()

    def _on_canvas_leave(self, _event=None):
        if getattr(self, "_pencil_hover_pt", None) is not None:
            self._pencil_hover_pt = None
            self.redraw_canvas()

    def _on_shift_press(self, _event=None):
        self.key_shift_pressed = True
        if self.current_tool == "pencil" and not self._drag_mode and hasattr(self, "_last_mouse_cx"):
            raw_wx, raw_wy = self.canvas_to_norm(self._last_mouse_cx, self._last_mouse_cy)
            wx = round(raw_wx / 0.05) * 0.05
            wy = round(raw_wy / 0.05) * 0.05
            wx = max(-1.0, min(1.0, wx))
            wy = max(-1.0, min(1.0, wy))
            scx, scy = self.norm_to_canvas(wx, wy)
            self._pencil_hover_pt = (scx, scy, wx, wy)
            self.canvas.config(cursor="tcross")
            self.redraw_canvas()

    def _on_shift_release(self, _event=None):
        self.key_shift_pressed = False
        if getattr(self, "_pencil_hover_pt", None) is not None:
            self._pencil_hover_pt = None
            if self.current_tool == "pencil":
                self.canvas.config(cursor="pencil")
            self.redraw_canvas()

    def _get_modifiers(self, event=None) -> tuple[bool, bool, bool]:
        """Retourne (is_shift, is_alt, is_ctrl) de manière infaillible sans touches fantômes."""
        shift = self.key_shift_pressed
        ctrl = self.key_ctrl_pressed
        alt = self.key_alt_pressed

        if event is not None:
            state = getattr(event, "state", 0)
            shift = shift or bool(state & 0x0001)
            ctrl = ctrl or bool(state & 0x0004)

        if _user32 is not None and sys.platform == "win32":
            try:
                shift = shift or bool(_user32.GetAsyncKeyState(0x10) & 0x8000)
                ctrl = ctrl or bool(_user32.GetAsyncKeyState(0x11) & 0x8000)
                alt = alt or bool(_user32.GetAsyncKeyState(0x12) & 0x8000)
            except Exception:
                pass

        return shift, alt, ctrl

    def _clamp_pan(self):
        """Limite strictement le pan pour que le viewport ne sorte JAMAIS de la fenêtre laser [-1.0, 1.0]."""
        mid = CANVAS_SIZE / 2.0
        max_pan = max(0.0, mid * (self.view_zoom - 1.0))
        self.view_pan_x = max(-max_pan, min(max_pan, self.view_pan_x))
        self.view_pan_y = max(-max_pan, min(max_pan, self.view_pan_y))

    def _on_mouse_wheel(self, event):
        """Molette de la souris : Zoom dans la forme/vue centré sur le curseur jusqu'au niveau des points."""
        cx, cy = event.x, event.y
        old_zoom = self.view_zoom
        delta = getattr(event, "delta", 0)
        zoom_factor = 1.15 if delta > 0 else (1.0 / 1.15)
        new_zoom = max(1.0, min(50.0, old_zoom * zoom_factor))

        if abs(new_zoom - old_zoom) < 1e-4:
            return

        mid = CANVAS_SIZE / 2.0
        span_old = mid * old_zoom
        span_new = mid * new_zoom

        wx = (cx - mid - self.view_pan_x) / span_old
        wy = -(cy - mid - self.view_pan_y) / span_old

        if new_zoom <= 1.0:
            self.view_zoom = 1.0
            self.view_pan_x = 0.0
            self.view_pan_y = 0.0
        else:
            self.view_zoom = new_zoom
            self.view_pan_x = cx - mid - wx * span_new
            self.view_pan_y = cy - mid + wy * span_new
            self._clamp_pan()

        self.redraw_canvas()

    def _on_mouse_wheel_step(self, direction: int, cx: float, cy: float):
        class DummyWheel:
            def __init__(self, x, y, delta):
                self.x = x
                self.y = y
                self.delta = delta
        self._on_mouse_wheel(DummyWheel(cx, cy, 120 if direction > 0 else -120))

    def _on_pan_press(self, event):
        self._pan_start_x = event.x
        self._pan_start_y = event.y
        self._pan_orig_x = self.view_pan_x
        self._pan_orig_y = self.view_pan_y

    def _on_pan_drag(self, event):
        dx = event.x - self._pan_start_x
        dy = event.y - self._pan_start_y
        self.view_pan_x = self._pan_orig_x + dx
        self.view_pan_y = self._pan_orig_y + dy
        self._clamp_pan()
        self.redraw_canvas()

    def _on_pan_release(self, _event):
        pass

    def reset_zoom(self):
        """Réinitialise le zoom à 100% (fenêtre laser plein cadre) et recentre la vue."""
        self.view_zoom = 1.0
        self.view_pan_x = 0.0
        self.view_pan_y = 0.0
        self.redraw_canvas()

    def zoom_step(self, factor: float, event=None):
        """Zoom centré au milieu du canvas."""
        if event is not None:
            if isinstance(getattr(event, "widget", None), tk.Entry):
                return
            _, _, is_ctrl = self._get_modifiers(event)
            if is_ctrl:
                return "break"
        mid = CANVAS_SIZE / 2.0
        old_zoom = self.view_zoom
        new_zoom = max(1.0, min(50.0, old_zoom * factor))
        if new_zoom <= 1.0:
            self.reset_zoom()
            return
        span_old = mid * old_zoom
        span_new = mid * new_zoom
        wx = (-self.view_pan_x) / span_old
        wy = self.view_pan_y / span_old
        self.view_zoom = new_zoom
        self.view_pan_x = -wx * span_new
        self.view_pan_y = wy * span_new
        self._clamp_pan()
        self.redraw_canvas()

    def _find_layer_at(self, cx: float, cy: float) -> Layer | None:
        """Détecte si un clic est effectué sur un trait de forme ou un point pour le sélectionner."""
        best_dist = 18.0
        best_layer = None

        def check_layer(l: Layer, parent_mat: Transform2D | None):
            nonlocal best_dist, best_layer
            if not l.enabled:
                return

            my_mat = l.get_local_matrix()
            world_mat = parent_mat.multiply(my_mat) if parent_mat else my_mat

            if l.shape_type == "group":
                for child in reversed(l.children):
                    check_layer(child, world_mat)
                return

            # Si forme cercle, détecter aussi le clic à l'intérieur
            if l.shape_type == "circle":
                ccx, ccy = self.norm_to_canvas(*world_mat.apply(0.0, 0.0))
                _, _, sx, sy, _ = world_mat.decompose()
                rx_c = abs(sx * 0.45 * (CANVAS_SIZE / 2.0) * self.view_zoom)
                ry_c = abs(sy * 0.45 * (CANVAS_SIZE / 2.0) * self.view_zoom)
                if rx_c > 1e-3 and ry_c > 1e-3:
                    if ((cx - ccx) / rx_c) ** 2 + ((cy - ccy) / ry_c) ** 2 <= 1.0:
                        best_dist = 0.0
                        best_layer = l
                        return

            pts = l.local_points
            if not pts:
                return
            cpts = [self.norm_to_canvas(*world_mat.apply(lx, ly)) for lx, ly in pts]
            if len(cpts) == 1:
                d = math.hypot(cx - cpts[0][0], cy - cpts[0][1])
                if d < best_dist:
                    best_dist = d
                    best_layer = l
                return

            for i in range(len(cpts) - 1):
                d = dist_pt_seg(cx, cy, cpts[i][0], cpts[i][1], cpts[i + 1][0], cpts[i + 1][1])
                if d < best_dist:
                    best_dist = d
                    best_layer = l

            if l.is_closed and len(cpts) > 2:
                d = dist_pt_seg(cx, cy, cpts[-1][0], cpts[-1][1], cpts[0][0], cpts[0][1])
                if d < best_dist:
                    best_dist = d
                    best_layer = l

        for l in reversed(self.layers):
            check_layer(l, None)

        if best_layer is not None:
            # Si le calque cliqué est déjà sélectionné individuellement, permettre son édition directe
            if self.selected_layer is not None and self.selected_layer == best_layer:
                return best_layer
            locked_anc = self._find_locked_ancestor(best_layer)
            if locked_anc is not None:
                return locked_anc

        return best_layer

    def _find_locked_ancestor(self, layer: Layer) -> Layer | None:
        """Remonte l'arborescence pour trouver si le calque est contenu dans un groupe verrouillé/lié."""
        parent = self.find_parent_group(layer)
        locked_top = None
        visited = set()
        while parent is not None and parent not in visited:
            visited.add(parent)
            if getattr(parent, "locked", False):
                locked_top = parent
            parent = self.find_parent_group(parent)
        return locked_top

    def _get_layer_bbox(self, l: Layer) -> tuple[float, float, float, float]:
        wpts = self.get_layer_world_points(l)
        if not wpts:
            mid = CANVAS_SIZE / 2.0
            return mid - 20, mid - 20, mid + 20, mid + 20
        cpts = [self.norm_to_canvas(wx, wy) for wx, wy in wpts]
        if len(cpts) == 1:
            px, py = cpts[0]
            pad = 12.0
            return px - pad, py - pad, px + pad, py + pad
        xs = [p[0] for p in cpts]
        ys = [p[1] for p in cpts]
        pad = 8.0
        return min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad

    def _layer_intersects_rect(self, l: Layer, rx1: float, ry1: float, rx2: float, ry2: float) -> bool:
        """Vérifie si une forme visible est dans ou intersecte le rectangle de sélection (rx1, ry1, rx2, ry2)."""
        if not l.enabled or l.shape_type == "group":
            return False

        # 1. Vérification par boîte englobante : si la forme est entièrement dans le rectangle
        bx1, by1, bx2, by2 = self._get_layer_bbox(l)
        if rx1 <= bx1 and bx2 <= rx2 and ry1 <= by1 and by2 <= ry2:
            return True

        parent_mat = self.get_parent_world_matrix(l)
        strokes = l.get_render_strokes(parent_mat=parent_mat)
        if not strokes:
            return False

        def line_intersects_box(p1, p2):
            x1, y1 = p1
            x2, y2 = p2
            if (x1 < rx1 and x2 < rx1) or (x1 > rx2 and x2 > rx2):
                return False
            if (y1 < ry1 and y2 < ry1) or (y1 > ry2 and y2 > ry2):
                return False
            if (rx1 <= x1 <= rx2 and ry1 <= y1 <= ry2) or (rx1 <= x2 <= rx2 and ry1 <= y2 <= ry2):
                return True
            dx = x2 - x1
            dy = y2 - y1
            for edge_x in (rx1, rx2):
                if abs(dx) > 1e-6:
                    t = (edge_x - x1) / dx
                    if 0.0 <= t <= 1.0:
                        y = y1 + t * dy
                        if ry1 <= y <= ry2:
                            return True
            for edge_y in (ry1, ry2):
                if abs(dy) > 1e-6:
                    t = (edge_y - y1) / dy
                    if 0.0 <= t <= 1.0:
                        x = x1 + t * dx
                        if rx1 <= x <= rx2:
                            return True
            return False

        pad = 8.0
        for wpts, _, is_closed, _ in strokes:
            if not wpts:
                continue
            cpts = [self.norm_to_canvas(wx, wy) for wx, wy in wpts]
            if len(cpts) == 1:
                px, py = cpts[0]
                if (rx1 <= px + pad and px - pad <= rx2 and
                    ry1 <= py + pad and py - pad <= ry2):
                    return True
                continue

            for px, py in cpts:
                if rx1 <= px <= rx2 and ry1 <= py <= ry2:
                    return True

            n = len(cpts)
            for i in range(n - 1):
                if line_intersects_box(cpts[i], cpts[i + 1]):
                    return True
            if is_closed and n > 2:
                if line_intersects_box(cpts[-1], cpts[0]):
                    return True

        return False

    def get_effective_selected_layers(self) -> list[Layer]:
        """Retourne la liste des calques sélectionnés au niveau hiérarchique le plus haut.
        Si un sur-calque est sélectionné, ses enfants directs ou indirects sont exclus pour éviter
        les doubles transformations (double déplacement / redimensionnement / rotation)."""
        sel = [l for l in getattr(self, "selected_layers", set()) if l.enabled]
        if not sel and self.get_current_layer() and self.get_current_layer().enabled:
            sel = [self.get_current_layer()]

        effective = []
        for l in sel:
            p = self.find_parent_group(l)
            is_child_of_selected = False
            visited = set()
            while p is not None and p not in visited:
                visited.add(p)
                if p in sel:
                    is_child_of_selected = True
                    break
                p = self.find_parent_group(p)
            if not is_child_of_selected:
                effective.append(l)
        return effective

    def _get_handles_data(self, l: Layer):
        if l.shape_type == "point":
            bx1, by1, bx2, by2 = self._get_layer_bbox(l)
            mx = (bx1 + bx2) / 2.0
            my = (by1 + by2) / 2.0
            return bx1, by1, bx2, by2, mx, my, {}, (-999.0, -999.0)

        if l.shape_type == "line":
            parent_mat = self.get_parent_world_matrix(l)
            local_mat = l.get_local_matrix()
            world_mat = parent_mat.multiply(local_mat)
            wx1, wy1 = world_mat.apply(-0.55, 0.0)
            wx2, wy2 = world_mat.apply(0.55, 0.0)
            cx1, cy1 = self.norm_to_canvas(wx1, wy1)
            cx2, cy2 = self.norm_to_canvas(wx2, wy2)
            mx = (cx1 + cx2) / 2.0
            my = (cy1 + cy2) / 2.0

            dx = cx2 - cx1
            dy = cy2 - cy1
            dist_px = math.hypot(dx, dy)
            if dist_px > 1e-4:
                perpx = -dy / dist_px
                perpy = dx / dist_px
            else:
                perpx, perpy = 0.0, -1.0

            rot_handle = (mx + perpx * 22.0, my + perpy * 22.0)
            handles = {
                "W": (cx1, cy1),
                "E": (cx2, cy2),
                "NW": (cx1, cy1),
                "SW": (cx1, cy1),
                "NE": (cx2, cy2),
                "SE": (cx2, cy2),
                "N": (mx, my),
                "S": (mx, my),
            }
            bx1 = min(cx1, cx2) - 8.0
            by1 = min(cy1, cy2) - 8.0
            bx2 = max(cx1, cx2) + 8.0
            by2 = max(cy1, cy2) + 8.0
            return bx1, by1, bx2, by2, mx, my, handles, rot_handle

        bx1, by1, bx2, by2 = self._get_layer_bbox(l)
        mx = (bx1 + bx2) / 2.0
        my = (by1 + by2) / 2.0
        handles = {
            "NW": (bx1, by1), "N": (mx, by1), "NE": (bx2, by1),
            "E": (bx2, my), "SE": (bx2, by2), "S": (mx, by2),
            "SW": (bx1, by2), "W": (bx1, my)
        }
        rot_handle = (mx, by1 - 18)
        return bx1, by1, bx2, by2, mx, my, handles, rot_handle

    def _get_selection_handles_data(self):
        """Calcule la boîte englobante et les poignées de transformation (redimensionnement et rotation)
        pour le calque sélectionné ou l'ensemble des calques multi-sélectionnés (Photoshop/Illustrator style)."""
        eff_layers = self.get_effective_selected_layers()
        if not eff_layers:
            return None

        if len(eff_layers) == 1:
            l = eff_layers[0]
            bx1, by1, bx2, by2, mx, my, handles, rot_handle = self._get_handles_data(l)
            wc_x, wc_y = self.get_layer_world_center(l)
            center_cx, center_cy = self.norm_to_canvas(wc_x, wc_y)
            return bx1, by1, bx2, by2, mx, my, handles, rot_handle, center_cx, center_cy, False, eff_layers

        # Multi-sélection : englober l'ensemble des calques sélectionnés dans une boîte commune
        all_wpts = []
        for sl in eff_layers:
            wpts = self.get_layer_world_points(sl)
            if wpts:
                all_wpts.extend(wpts)
            else:
                all_wpts.append(self.get_layer_world_center(sl))

        cpts = [self.norm_to_canvas(wx, wy) for wx, wy in all_wpts]
        xs = [p[0] for p in cpts]
        ys = [p[1] for p in cpts]
        pad = 8.0
        bx1 = min(xs) - pad
        by1 = min(ys) - pad
        bx2 = max(xs) + pad
        by2 = max(ys) + pad
        mx = (bx1 + bx2) / 2.0
        my = (by1 + by2) / 2.0

        min_wx = min(pt[0] for pt in all_wpts)
        max_wx = max(pt[0] for pt in all_wpts)
        min_wy = min(pt[1] for pt in all_wpts)
        max_wy = max(pt[1] for pt in all_wpts)
        wc_x = (min_wx + max_wx) / 2.0
        wc_y = (min_wy + max_wy) / 2.0
        center_cx, center_cy = self.norm_to_canvas(wc_x, wc_y)

        handles = {
            "NW": (bx1, by1), "N": (mx, by1), "NE": (bx2, by1),
            "E": (bx2, my), "SE": (bx2, by2), "S": (mx, by2),
            "SW": (bx1, by2), "W": (bx1, my)
        }
        rot_handle = (mx, by1 - 18)
        return bx1, by1, bx2, by2, mx, my, handles, rot_handle, center_cx, center_cy, True, eff_layers

    def _on_canvas_motion(self, event):
        """Met à jour le curseur de la souris selon l'élément survolé (Photoshop-like)."""
        if self._drag_mode:
            return
        cx, cy = event.x, event.y

        # 0. Vérification survol de la poignée de l'axe de symétrie (si miroir actif)
        sym_mode, _ = self.get_sym_mode()
        if sym_mode != "none":
            scx, scy = self.norm_to_canvas(self.sym_cx, self.sym_cy)
            if math.hypot(cx - scx, cy - scy) <= 14 or getattr(self, "_sym_move_mode_active", False):
                self.canvas.config(cursor="fleur")
                self.lbl_status.config(text=f"Axe de symétrie ({self.sym_cx:+.2f}, {self.sym_cy:+.2f}) : glisse pour déplacer (ou double-clic pour recentrer)", fg="#ffb74d")
                return

        if self.current_tool == "pencil":
            self._last_mouse_cx = cx
            self._last_mouse_cy = cy
            is_shift, _, _is_ctrl = self._get_modifiers(event)
            if is_shift:
                raw_wx, raw_wy = self.canvas_to_norm(cx, cy)
                grid_type = getattr(self, "grid_type_var", None)
                if grid_type and grid_type.get() == "polar":
                    wx, wy = self.snap_polar(raw_wx, raw_wy)
                else:
                    wx = round(raw_wx / 0.05) * 0.05
                    wy = round(raw_wy / 0.05) * 0.05
                wx = max(-1.0, min(1.0, wx))
                wy = max(-1.0, min(1.0, wy))
                scx, scy = self.norm_to_canvas(wx, wy)
                self._pencil_hover_pt = (scx, scy, wx, wy)
                self.canvas.config(cursor="tcross")
                self._request_redraw()
            else:
                if getattr(self, "_pencil_hover_pt", None) is not None:
                    self._pencil_hover_pt = None
                    self._request_redraw()
                self.canvas.config(cursor="pencil")
            return

        handles_info = self._get_selection_handles_data()
        if not handles_info:
            self.canvas.config(cursor="crosshair")
            return

        bx1, by1, bx2, by2, mx, my, handles, (rot_x, rot_y), center_cx, center_cy, is_multi, eff_layers = handles_info

        # 1. Poignée de rotation supérieure
        if math.hypot(cx - rot_x, cy - rot_y) <= 10.0:
            self.canvas.config(cursor="exchange")
            return

        # 2. Poignées de redimensionnement directes (<= 11 px)
        is_single_line = (not is_multi and eff_layers and eff_layers[0].shape_type == "line")
        for name, (hx, hy) in handles.items():
            if math.hypot(cx - hx, cy - hy) <= 11.0:
                if is_single_line:
                    # Pour une ligne : curseur aligné avec l'orientation de la ligne
                    rot = eff_layers[0].rotation % 180.0
                    if 22.5 <= rot < 67.5: cur_type = "size_ne_sw"
                    elif 67.5 <= rot < 112.5: cur_type = "size_ns"
                    elif 112.5 <= rot < 157.5: cur_type = "size_nw_se"
                    else: cur_type = "size_we"
                    self.canvas.config(cursor=cur_type)
                    return
                elif name in ("NW", "SE"): self.canvas.config(cursor="size_nw_se")
                elif name in ("NE", "SW"): self.canvas.config(cursor="size_ne_sw")
                elif name in ("N", "S"): self.canvas.config(cursor="size_ns")
                elif name in ("W", "E"): self.canvas.config(cursor="size_we")
                return

        # 3. Zone de rotation aux 4 angles (uniquement pour les boîtes rectangulaires, pas pour une ligne unique)
        if not is_single_line:
            for name in ("NW", "NE", "SE", "SW"):
                if name in handles:
                    chx, chy = handles[name]
                    d = math.hypot(cx - chx, cy - chy)
                    if 11.0 < d <= 26.0:
                        is_corner_rot = False
                        if name == "NW" and (cx <= bx1 + 3 or cy <= by1 + 3): is_corner_rot = True
                        elif name == "NE" and (cx >= bx2 - 3 or cy <= by1 + 3): is_corner_rot = True
                        elif name == "SE" and (cx >= bx2 - 3 or cy >= by2 - 3): is_corner_rot = True
                        elif name == "SW" and (cx <= bx1 + 3 or cy >= by2 - 3): is_corner_rot = True

                        if is_corner_rot:
                            self.canvas.config(cursor="exchange")
                            return

        # 4. Survol d'une forme (trait ou point laser) ou intérieur de la boîte de sélection
        hovered_layer = self._find_layer_at(cx, cy)
        is_in_box = (bx1 <= cx <= bx2 and by1 <= cy <= by2) if not is_single_line else (math.hypot(cx - center_cx, cy - center_cy) <= 8.0)
        if hovered_layer is not None or is_in_box:
            self.canvas.config(cursor="fleur")
            return

        self.canvas.config(cursor="crosshair")

    def _on_canvas_double_click(self, event):
        """Double-clic sur le canvas : recentre l'axe de symétrie si double-cliqué sur sa poignée."""
        sym_mode, _ = self.get_sym_mode()
        if sym_mode != "none":
            scx, scy = self.norm_to_canvas(self.sym_cx, self.sym_cy)
            if math.hypot(event.x - scx, event.y - scy) <= 15:
                self.reset_sym_center()
                return

    def _on_canvas_press(self, event):
        cx, cy = event.x, event.y
        _is_shift, is_alt, _is_ctrl = self._get_modifiers(event)

        # 0. Interaction avec le centre ou axe de symétrie (si miroir actif)
        sym_mode, _ = self.get_sym_mode()
        if sym_mode != "none":
            scx, scy = self.norm_to_canvas(self.sym_cx, self.sym_cy)
            is_near_center = math.hypot(cx - scx, cy - scy) <= 14
            if is_near_center or getattr(self, "_sym_move_mode_active", False):
                self._drag_mode = "sym_axis"
                self._sym_move_mode_active = False
                if hasattr(self, "btn_sym_move"):
                    self.btn_sym_move.config(bg="#333333")
                self._drag_start_cx = cx
                self._drag_start_cy = cy
                if not is_near_center:
                    raw_wx, raw_wy = self.canvas_to_norm(cx, cy)
                    grid_type = getattr(self, "grid_type_var", None)
                    if self.show_grid_var.get() or _is_shift or _is_ctrl:
                        if grid_type and grid_type.get() == "polar":
                            nwx, nwy = self.snap_polar(raw_wx, raw_wy)
                        else:
                            nwx = round(raw_wx / 0.05) * 0.05
                            nwy = round(raw_wy / 0.05) * 0.05
                    else:
                        nwx, nwy = raw_wx, raw_wy
                    self.sym_cx = max(-1.0, min(1.0, nwx))
                    self.sym_cy = max(-1.0, min(1.0, nwy))
                    self._update_sym_ui()
                    self.redraw_canvas()
                return

        if self.current_tool == "pencil":
            self._pencil_hover_pt = None
            self._drag_mode = "pencil"
            self._draw_start_cx = cx
            self._draw_start_cy = cy
            self._draw_moved = False
            self._draw_had_shift = False

            raw_wx, raw_wy = self.canvas_to_norm(cx, cy)
            grid_type = getattr(self, "grid_type_var", None)
            if self.show_grid_var.get() or _is_ctrl or _is_shift:
                if grid_type and grid_type.get() == "polar":
                    wx, wy = self.snap_polar(raw_wx, raw_wy)
                else:
                    wx = round(raw_wx / 0.05) * 0.05
                    wy = round(raw_wy / 0.05) * 0.05
            else:
                wx, wy = raw_wx, raw_wy
            wx = max(-1.0, min(1.0, wx))
            wy = max(-1.0, min(1.0, wy))

            self._draw_points = [(wx, wy)]
            self._draw_last_snap = (wx, wy)
            return

        handles_info = self._get_selection_handles_data()
        _is_shift, is_alt, _is_ctrl = self._get_modifiers(event)

        # 1. Poignées de redimensionnement et rotation (calque unique ou multi-sélection, sauf si Ctrl)
        if handles_info and not _is_ctrl:
            bx1, by1, bx2, by2, mx, my, handles, (rot_x, rot_y), center_cx, center_cy, is_multi, eff_layers = handles_info

            # Rotation via la boule supérieure
            if math.hypot(cx - rot_x, cy - rot_y) <= 10.0:
                self._drag_mode = "rotate"
                self._drag_start_cx = cx
                self._drag_start_cy = cy
                self._drag_orig_angle = math.degrees(math.atan2(cy - center_cy, cx - center_cx))
                self._drag_is_multi = is_multi
                self._drag_eff_layers = eff_layers
                self._pre_drag_snapshot = self.get_state_snapshot()
                if not is_multi:
                    cur_l = eff_layers[0]
                    self._drag_orig_rot = cur_l.rotation
                else:
                    wc_x, wc_y = self.canvas_to_norm(center_cx, center_cy)
                    self._drag_pivot_wx = wc_x
                    self._drag_pivot_wy = wc_y
                    self._drag_orig_world_mats = {sl: self.get_layer_world_matrix(sl) for sl in eff_layers}
                return

            # Poignées de redimensionnement (Coins et Côtés <= 11 px)
            for h_name, (hx, hy) in handles.items():
                if math.hypot(cx - hx, cy - hy) <= 11.0:
                    self._drag_mode = "scale"
                    self._drag_handle_name = h_name
                    self._drag_handle_pos = (hx, hy)
                    self._drag_start_cx = cx
                    self._drag_start_cy = cy
                    self._drag_is_multi = is_multi
                    self._drag_eff_layers = eff_layers
                    self._pre_drag_snapshot = self.get_state_snapshot()

                    if not is_multi:
                        cur_l = eff_layers[0]
                        self._drag_orig_scale_x = cur_l.scale_x
                        self._drag_orig_scale_y = cur_l.scale_y
                        self._drag_orig_x = cur_l.x
                        self._drag_orig_y = cur_l.y
                        self._drag_orig_rot = cur_l.rotation

                        # Détermination de la position locale de la poignée et de son ancrage opposé fixe
                        pts = cur_l.get_local_points()
                        min_lx, max_lx = min(p[0] for p in pts), max(p[0] for p in pts)
                        min_ly, max_ly = min(p[1] for p in pts), max(p[1] for p in pts)
                        mid_lx = (min_lx + max_lx) / 2.0
                        mid_ly = (min_ly + max_ly) / 2.0

                        handle_map = {
                            "NW": ((min_lx, max_ly), (max_lx, min_ly)),
                            "N":  ((mid_lx, max_ly), (mid_lx, min_ly)),
                            "NE": ((max_lx, max_ly), (min_lx, min_ly)),
                            "E":  ((max_lx, mid_ly), (min_lx, mid_ly)),
                            "SE": ((max_lx, min_ly), (min_lx, max_ly)),
                            "S":  ((mid_lx, min_ly), (mid_lx, max_ly)),
                            "SW": ((min_lx, min_ly), (max_lx, max_ly)),
                            "W":  ((min_lx, mid_ly), (max_lx, mid_ly)),
                        }

                        if cur_l.shape_type == "line":
                            if "E" in h_name:
                                self._drag_local_handle = (max_lx, 0.0)
                                self._drag_local_anchor = (min_lx, 0.0)
                            elif "W" in h_name:
                                self._drag_local_handle = (min_lx, 0.0)
                                self._drag_local_anchor = (max_lx, 0.0)
                            else:
                                self._drag_local_handle = (max_lx, 0.0)
                                self._drag_local_anchor = (min_lx, 0.0)
                        else:
                            self._drag_local_handle, self._drag_local_anchor = handle_map.get(
                                h_name, ((max_lx, mid_ly), (min_lx, mid_ly))
                            )

                        self._drag_local_mid = (mid_lx, mid_ly)
                    else:
                        # Multi-sélection : calcul des points mondiaux
                        all_wpts = []
                        for sl in eff_layers:
                            wpts = self.get_layer_world_points(sl)
                            all_wpts.extend(wpts if wpts else [self.get_layer_world_center(sl)])
                        min_wx = min(p[0] for p in all_wpts)
                        max_wx = max(p[0] for p in all_wpts)
                        min_wy = min(p[1] for p in all_wpts)
                        max_wy = max(p[1] for p in all_wpts)
                        mid_wx = (min_wx + max_wx) / 2.0
                        mid_wy = (min_wy + max_wy) / 2.0

                        world_handle_map = {
                            "NW": ((min_wx, max_wy), (max_wx, min_wy)),
                            "N":  ((mid_wx, max_wy), (mid_wx, min_wy)),
                            "NE": ((max_wx, max_wy), (min_wx, min_wy)),
                            "E":  ((max_wx, mid_wy), (min_wx, mid_wy)),
                            "SE": ((max_wx, min_wy), (min_wx, max_wy)),
                            "S":  ((mid_wx, min_wy), (mid_wx, max_wy)),
                            "SW": ((min_wx, min_wy), (max_wx, max_wy)),
                            "W":  ((min_wx, mid_wy), (max_wx, mid_wy)),
                        }
                        self._drag_multi_handle_w, self._drag_multi_anchor_w = world_handle_map.get(
                            h_name, ((max_wx, mid_wy), (min_wx, mid_wy))
                        )
                        self._drag_multi_mid_w = (mid_wx, mid_wy)
                        start_mwx, start_mwy = self.canvas_to_norm(cx, cy)
                        self._drag_multi_start_w = (start_mwx, start_mwy)
                        self._drag_orig_world_mats = {sl: self.get_layer_world_matrix(sl) for sl in eff_layers}

                    return

            # 3. Rotation directe depuis les 4 angles (11 px à 26 px à l'extérieur des 4 coins, boîtes seulement)
            if is_multi or (eff_layers and eff_layers[0].shape_type != "line"):
                for name in ("NW", "NE", "SE", "SW"):
                    if name not in handles:
                        continue
                    chx, chy = handles[name]
                    d = math.hypot(cx - chx, cy - chy)
                if 11.0 < d <= 26.0:
                    is_corner_rot = False
                    if name == "NW" and (cx <= bx1 + 3 or cy <= by1 + 3): is_corner_rot = True
                    elif name == "NE" and (cx >= bx2 - 3 or cy <= by1 + 3): is_corner_rot = True
                    elif name == "SE" and (cx >= bx2 - 3 or cy >= by2 - 3): is_corner_rot = True
                    elif name == "SW" and (cx <= bx1 + 3 or cy >= by2 - 3): is_corner_rot = True

                    if is_corner_rot:
                        self._drag_mode = "rotate"
                        self._drag_start_cx = cx
                        self._drag_start_cy = cy
                        self._drag_orig_angle = math.degrees(math.atan2(cy - center_cy, cx - center_cx))
                        self._drag_is_multi = is_multi
                        self._drag_eff_layers = eff_layers
                        self._pre_drag_snapshot = self.get_state_snapshot()
                        if not is_multi:
                            cur_l = eff_layers[0]
                            self._drag_orig_rot = cur_l.rotation
                        else:
                            wc_x, wc_y = self.canvas_to_norm(center_cx, center_cy)
                            self._drag_pivot_wx = wc_x
                            self._drag_pivot_wy = wc_y
                            self._drag_orig_world_mats = {sl: self.get_layer_world_matrix(sl) for sl in eff_layers}
                        return

        # 2. Clic direct sur une forme (trait ou point laser)
        clicked_layer = self._find_layer_at(cx, cy)

        if clicked_layer is not None:
            # Ctrl+Clic ou Shift+Clic : sélectionne ou désélectionne la forme cliquée
            if (_is_ctrl or _is_shift) and self.current_tool == "select":
                has_parent_in_sel = any(self._is_descendant_of(clicked_layer, sl) for sl in self.selected_layers if sl.shape_type == "group")
                if clicked_layer in self.selected_layers:
                    self.selected_layers.remove(clicked_layer)
                    if self.selected_layer is clicked_layer:
                        self.selected_layer = next(iter(self.selected_layers)) if self.selected_layers else None
                    self._sync_legacy_indices()
                    self.lbl_status.config(text=f"Désélectionné : {clicked_layer.name}", fg="#ffb74d")
                elif has_parent_in_sel:
                    new_sel = set()
                    def expand_group_leaves(g: Layer):
                        for c in g.children:
                            if c.shape_type == "group":
                                expand_group_leaves(c)
                            else:
                                if c is not clicked_layer:
                                    new_sel.add(c)
                    for sl in self.selected_layers:
                        if sl.shape_type == "group" and self._is_descendant_of(clicked_layer, sl):
                            expand_group_leaves(sl)
                        else:
                            new_sel.add(sl)
                    self.selected_layers = new_sel
                    self.selected_layer = next(iter(self.selected_layers)) if self.selected_layers else None
                    self._sync_legacy_indices()
                    self.lbl_status.config(text=f"Désélectionné : {clicked_layer.name}", fg="#ffb74d")
                else:
                    self.selected_layers.add(clicked_layer)
                    self.selected_layer = clicked_layer
                    self._sync_legacy_indices()
                    self.lbl_status.config(text=f"Sélectionné : {clicked_layer.name}", fg="#80d8ff")

                p = self.find_parent_group(clicked_layer)
                while p is not None:
                    p.is_expanded = True
                    p = self.find_parent_group(p)
                self._refresh_layers_ui()
                self._sync_listbox_selection()
                self.redraw_canvas()
                return

            is_in_sel = (clicked_layer in self.selected_layers) or any(self._is_descendant_of(clicked_layer, sl) for sl in self.selected_layers)
            was_multi = (len(self.selected_layers) > 1 or (len(self.selected_layers) == 1 and any(sl.shape_type == "group" for sl in self.selected_layers))) and is_in_sel
            if not was_multi:
                self.select_layer_object(clicked_layer)
            else:
                self.selected_layer = clicked_layer
                self._sync_legacy_indices()
                self._sync_listbox_selection()

            l = clicked_layer
            self._drag_mode = "move"
            self._drag_start_cx = cx
            self._drag_start_cy = cy
            eff_layers = self.get_effective_selected_layers()
            self._drag_orig_positions = {
                sl: (sl.x, sl.y)
                for sl in eff_layers
            }
            self._drag_orig_x = l.x
            self._drag_orig_y = l.y
            self._drag_was_multi = was_multi
            self._drag_clicked_layer = clicked_layer
            self._duplicated_during_drag = False
            self._pre_drag_snapshot = self.get_state_snapshot()
            return

        # 2b. Clic à l'intérieur de la boîte de sélection existante -> Déplacement direct de la sélection
        is_single_line = (not is_multi and eff_layers and eff_layers[0].shape_type == "line")
        is_inside_target = (
            (math.hypot(cx - center_cx, cy - center_cy) <= 10.0) if is_single_line
            else (bx1 <= cx <= bx2 and by1 <= cy <= by2)
        )
        if handles_info and not (_is_ctrl or _is_shift) and is_inside_target:
            eff_layers = self.get_effective_selected_layers()
            if eff_layers:
                l = self.get_current_layer() or eff_layers[0]
                self._drag_mode = "move"
                self._drag_start_cx = cx
                self._drag_start_cy = cy
                self._drag_orig_positions = {
                    sl: (sl.x, sl.y)
                    for sl in eff_layers
                }
                self._drag_orig_x = l.x
                self._drag_orig_y = l.y
                self._drag_was_multi = (len(eff_layers) > 1 or is_multi)
                self._drag_clicked_layer = None  # Clic dans la boîte globale : conserve la sélection multiple
                self._duplicated_during_drag = False
                self._pre_drag_snapshot = self.get_state_snapshot()
                return

        # 3. Clic dans le vide -> Début de sélection par rectangle (Marquee)
        self._drag_mode = "marquee"
        self._marquee_start_cx = cx
        self._marquee_start_cy = cy
        self._marquee_current_cx = cx
        self._marquee_current_cy = cy
        self._marquee_is_ctrl = _is_ctrl
        self._marquee_is_shift = _is_shift
        self._marquee_orig_selection = set(self.selected_layers) if (_is_ctrl or _is_shift) else set()
        self._marquee_moved = False
        return

    def _on_canvas_drag(self, event):
        cx, cy = event.x, event.y
        if not self._drag_mode:
            return

        is_shift, is_alt, is_ctrl = self._get_modifiers(event)

        if self._drag_mode == "sym_axis":
            raw_wx, raw_wy = self.canvas_to_norm(cx, cy)
            grid_type = getattr(self, "grid_type_var", None)
            if self.show_grid_var.get() or is_shift or is_ctrl:
                if grid_type and grid_type.get() == "polar":
                    nwx, nwy = self.snap_polar(raw_wx, raw_wy)
                else:
                    nwx = round(raw_wx / 0.05) * 0.05
                    nwy = round(raw_wy / 0.05) * 0.05
            else:
                nwx, nwy = raw_wx, raw_wy
            self.sym_cx = max(-1.0, min(1.0, nwx))
            self.sym_cy = max(-1.0, min(1.0, nwy))
            self._update_sym_ui()
            self._request_redraw()
            return

        if self._drag_mode == "pencil":
            dx = cx - self._draw_start_cx
            dy = cy - self._draw_start_cy
            if math.hypot(dx, dy) >= 4:
                self._draw_moved = True

            sx, sy = self._draw_points[0]

            if is_shift:
                self._draw_had_shift = True
                # Mode Aimant / Ligne droite contrainte par pas d'angle (30° si polaire, 45° si cartésien)
                raw_wx, raw_wy = self.canvas_to_norm(cx, cy)
                ldx = raw_wx - sx
                ldy = raw_wy - sy
                dist = math.hypot(ldx, ldy)
                grid_type = getattr(self, "grid_type_var", None)

                if grid_type and grid_type.get() == "polar":
                    # Si le point initial n'était pas aimanté au polar grid, on l'aimante
                    if not getattr(self, "_draw_snapped_start", False):
                        sx, sy = self.snap_polar(sx, sy)
                        self._draw_points[0] = (sx, sy)
                        self._draw_snapped_start = True

                    # 1. Aimantation par défaut sur les nœuds polaires (rayons 30° et cercles 0.05)
                    snapped_wx, snapped_wy = self.snap_polar(raw_wx, raw_wy)

                    # 2. Contrainte radiale : si on trace le long du rayon partant de (sx, sy)
                    if math.hypot(sx, sy) > 1e-4:
                        theta_ray = math.atan2(sy, sx)
                        theta_cur = math.atan2(raw_wy, raw_wx)
                        diff_ang = abs((theta_cur - theta_ray + math.pi) % (2 * math.pi) - math.pi)
                        if diff_ang < math.radians(15.0):
                            r_cur = round(math.hypot(raw_wx, raw_wy) / 0.05) * 0.05
                            snapped_wx = r_cur * math.cos(theta_ray)
                            snapped_wy = r_cur * math.sin(theta_ray)
                        else:
                            # Contrainte circulaire : si on trace le long du cercle passant par (sx, sy)
                            r_ring = math.hypot(sx, sy)
                            if abs(math.hypot(raw_wx, raw_wy) - r_ring) < 0.035:
                                ang_snap = round(theta_cur / (math.pi / 6.0)) * (math.pi / 6.0)
                                snapped_wx = r_ring * math.cos(ang_snap)
                                snapped_wy = r_ring * math.sin(ang_snap)
                else:
                    if dist > 1e-4:
                        angle = math.atan2(ldy, ldx)
                        snapped_angle = round(angle / (math.pi / 4.0)) * (math.pi / 4.0)
                        snapped_wx = sx + dist * math.cos(snapped_angle)
                        snapped_wy = sy + dist * math.sin(snapped_angle)
                    else:
                        snapped_wx, snapped_wy = sx, sy

                    if self.show_grid_var.get() or is_ctrl:
                        snapped_wx = round(snapped_wx / 0.05) * 0.05
                        snapped_wy = round(snapped_wy / 0.05) * 0.05

                snapped_wx = max(-1.0, min(1.0, snapped_wx))
                snapped_wy = max(-1.0, min(1.0, snapped_wy))
                self._draw_last_snap = (snapped_wx, snapped_wy)
            else:
                # Mode Crayon libre
                cur_wx, cur_wy = self.canvas_to_norm(cx, cy)
                cur_wx = max(-1.0, min(1.0, cur_wx))
                cur_wy = max(-1.0, min(1.0, cur_wy))
                last_wx, last_wy = self._draw_points[-1]
                last_cx, last_cy = self.norm_to_canvas(last_wx, last_wy)
                if math.hypot(cx - last_cx, cy - last_cy) >= 4.0:
                    self._draw_points.append((cur_wx, cur_wy))

            self._request_redraw()
            return

        if self._drag_mode == "marquee":
            self._marquee_current_cx = cx
            self._marquee_current_cy = cy
            dx = cx - self._marquee_start_cx
            dy = cy - self._marquee_start_cy
            if math.hypot(dx, dy) >= 4:
                self._marquee_moved = True

            rx1 = min(self._marquee_start_cx, cx)
            ry1 = min(self._marquee_start_cy, cy)
            rx2 = max(self._marquee_start_cx, cx)
            ry2 = max(self._marquee_start_cy, cy)

            hit_layers = set()
            def collect_canvas_hits(l: Layer):
                if not l.enabled:
                    return
                if l.shape_type == "group":
                    for child in l.children:
                        collect_canvas_hits(child)
                else:
                    if self._layer_intersects_rect(l, rx1, ry1, rx2, ry2):
                        hit_layers.add(l)

            for lay in self.layers:
                collect_canvas_hits(lay)

            # Si des enfants appartiennent à une forme liée verrouillée, sélectionner la forme liée elle-même
            resolved_hits = set()
            for l in hit_layers:
                anc = self._find_locked_ancestor(l)
                resolved_hits.add(anc if anc is not None else l)
            hit_layers = resolved_hits

            expanded_changed = False
            for l in hit_layers:
                p = self.find_parent_group(l)
                while p is not None:
                    if not p.is_expanded:
                        p.is_expanded = True
                        expanded_changed = True
                    p = self.find_parent_group(p)
            if expanded_changed:
                self._refresh_layers_ui()

            if getattr(self, "_marquee_is_ctrl", False) or getattr(self, "_marquee_is_shift", False):
                new_sel = self._marquee_orig_selection | hit_layers
            else:
                new_sel = hit_layers

            self.selected_layers = set(new_sel)
            if self.selected_layers:
                if self.selected_layer not in self.selected_layers:
                    self.selected_layer = next(iter(self.selected_layers))
            else:
                self.selected_layer = None

            self._sync_legacy_indices()
            self._sync_listbox_selection()
            self._request_redraw()
            return

        l = self.get_current_layer()
        if not l:
            return

        if self._drag_mode == "move":
            dx = cx - self._drag_start_cx
            dy = cy - self._drag_start_cy

            # ALT + GLISSER : Duplication uniquement si on glisse activement la souris (> 6 px)
            if is_alt and not self._duplicated_during_drag and math.hypot(dx, dy) >= 6:
                eff_layers = self.get_effective_selected_layers()
                new_selection = []
                new_orig_positions = {}
                for sl in eff_layers:
                    self.layer_counter += 1
                    dup = sl.clone()
                    dup.id = self.layer_counter
                    dup.name = f"{sl.name} (Copie)"
                    orig_pos = self._drag_orig_positions.get(sl, (sl.x, sl.y))
                    dup.x, dup.y = orig_pos
                    parent = self.find_parent_group(sl)
                    if parent is not None:
                        parent.children.append(dup)
                    else:
                        self.layers.append(dup)
                    new_selection.append(dup)
                    new_orig_positions[dup] = orig_pos
                    if sl is l:
                        l = dup
                        self._drag_orig_x, self._drag_orig_y = orig_pos

                self.selected_layers = set(new_selection)
                self.selected_layer = l
                self._drag_orig_positions = new_orig_positions
                self._sync_legacy_indices()
                self._sync_listbox_selection()
                self._refresh_layers_ui()
                self._duplicated_during_drag = True

            span = (CANVAS_SIZE / 2.0) * self.view_zoom
            delta_wx = dx / span
            delta_wy = -dy / span

            parent_mat = self.get_parent_world_matrix(l)
            inv_parent = parent_mat.invert()
            orig_wx, orig_wy = parent_mat.apply(self._drag_orig_x, self._drag_orig_y)

            raw_wx = orig_wx + delta_wx
            raw_wy = orig_wy + delta_wy

            snapped_center_x = False
            snapped_center_y = False

            grid_type = getattr(self, "grid_type_var", None)
            is_polar = (grid_type is not None and grid_type.get() == "polar")

            # SHIFT : Alignement magnétique au quadrillage polaire ou aux axes centraux cartésiens
            if is_shift and is_polar:
                if math.hypot(raw_wx, raw_wy) < (0.05 / self.view_zoom):
                    nwx, nwy = 0.0, 0.0
                    snapped_center_x = True
                    snapped_center_y = True
                else:
                    nwx, nwy = self.snap_polar(raw_wx, raw_wy)
            elif is_shift:
                snap_threshold = 0.07 / self.view_zoom

                # Alignement vertical sur le centre (X = 0)
                if abs(raw_wx) < snap_threshold:
                    nwx = 0.0
                    snapped_center_x = True
                else:
                    nwx = raw_wx

                # Alignement horizontal sur le centre (Y = 0)
                if abs(raw_wy) < snap_threshold:
                    nwy = 0.0
                    snapped_center_y = True
                else:
                    nwy = raw_wy

                # Si on n'est proche d'aucun axe central, appliquer la contrainte orthogonale classique
                if not snapped_center_x and not snapped_center_y:
                    if abs(dx) >= abs(dy):
                        nwy = orig_wy
                    else:
                        nwx = orig_wx
            else:
                nwx = raw_wx
                nwy = raw_wy

            # Snapping à la grille si la case Grille est cochée (ou avec la touche CTRL)
            if self.show_grid_var.get() or is_ctrl:
                if is_polar:
                    if not (snapped_center_x and snapped_center_y):
                        nwx, nwy = self.snap_polar(nwx, nwy)
                else:
                    grid_step = 0.05
                    if not snapped_center_x:
                        if abs(nwx) < 0.035:
                            nwx = 0.0
                        else:
                            nwx = round(nwx / grid_step) * grid_step
                    if not snapped_center_y:
                        if abs(nwy) < 0.035:
                            nwy = 0.0
                        else:
                            nwy = round(nwy / grid_step) * grid_step

            # Déplacement collectif : calculer eff_dwx, eff_dwy et vérifier les limites laser pour TOUS les calques
            eff_dwx = nwx - orig_wx
            eff_dwy = nwy - orig_wy

            # Clamp collectif : aucun calque du groupe ne doit déborder de [-1.0, 1.0]
            if hasattr(self, "_drag_orig_positions") and self._drag_orig_positions:
                for target_l, (orig_ox, orig_oy) in self._drag_orig_positions.items():
                    t_parent_mat = self.get_parent_world_matrix(target_l)
                    t_inv = t_parent_mat.invert()
                    t_orig_wx, t_orig_wy = t_parent_mat.apply(orig_ox, orig_oy)
                    t_cand_wx = t_orig_wx + eff_dwx
                    t_cand_wy = t_orig_wy + eff_dwy
                    t_cand_lx, t_cand_ly = t_inv.apply(t_cand_wx, t_cand_wy)
                    t_min_x, t_min_y, t_max_x, t_max_y = target_l.get_laser_bounds(x=t_cand_lx, y=t_cand_ly, parent_mat=t_parent_mat)
                    if t_min_x < -1.0: eff_dwx += (-1.0 - t_min_x)
                    if t_max_x > 1.0: eff_dwx -= (t_max_x - 1.0)
                    if t_min_y < -1.0: eff_dwy += (-1.0 - t_min_y)
                    if t_max_y > 1.0: eff_dwy -= (t_max_y - 1.0)

                for target_l, (orig_ox, orig_oy) in self._drag_orig_positions.items():
                    t_parent_mat = self.get_parent_world_matrix(target_l)
                    t_inv = t_parent_mat.invert()
                    t_orig_wx, t_orig_wy = t_parent_mat.apply(orig_ox, orig_oy)
                    target_l.x, target_l.y = t_inv.apply(t_orig_wx + eff_dwx, t_orig_wy + eff_dwy)
            else:
                cand_lx, cand_ly = inv_parent.apply(nwx, nwy)
                l.x = cand_lx
                l.y = cand_ly

            self._snap_guide_x = snapped_center_x
            self._snap_guide_y = snapped_center_y
            self._request_redraw()

        elif self._drag_mode == "scale":
            h_name = self._drag_handle_name

            if getattr(self, "_drag_is_multi", False):
                eff_layers = getattr(self, "_drag_eff_layers", self.get_effective_selected_layers())
                hx, hy = getattr(self, "_drag_multi_start_w", self._drag_multi_handle_w)
                ax, ay = self._drag_multi_mid_w if is_alt else self._drag_multi_anchor_w

                # Coordonnées laser actuelles de la souris
                mwx, mwy = self.canvas_to_norm(cx, cy)
                if is_shift:
                    grid_step = 0.05
                    mwx = round(mwx / grid_step) * grid_step
                    mwy = round(mwy / grid_step) * grid_step

                # Vecteur Ancrage -> Souris et Ancrage -> Poignée
                vw_x = mwx - ax
                vw_y = mwy - ay
                span_x = hx - ax
                span_y = hy - ay

                is_corner = len(h_name) == 2

                if is_corner:
                    # Homothétie uniforme proportionnelle
                    denom = span_x * span_x + span_y * span_y
                    ratio = (vw_x * span_x + vw_y * span_y) / denom if denom > 1e-6 else 1.0
                    ratio = max(0.05, ratio)
                    sx = ratio
                    sy = ratio
                elif "E" in h_name or "W" in h_name:
                    ratio_x = max(0.05, vw_x / span_x) if abs(span_x) > 1e-4 else 1.0
                    sx = ratio_x
                    sy = 1.0
                else:
                    ratio_y = max(0.05, vw_y / span_y) if abs(span_y) > 1e-4 else 1.0
                    sx = 1.0
                    sy = ratio_y

                # Snapping CTRL
                if is_ctrl:
                    sx = max(0.05, round(sx * 10.0) / 10.0)
                    sy = max(0.05, round(sy * 10.0) / 10.0)

                def apply_multi_scale(scale_x_val, scale_y_val, dry_run=False):
                    scale_m = Transform2D(
                        a=scale_x_val, b=0.0,
                        c=0.0, d=scale_y_val,
                        tx=ax * (1.0 - scale_x_val),
                        ty=ay * (1.0 - scale_y_val)
                    )
                    all_fit = True
                    for sl in eff_layers:
                        orig_wmat = self._drag_orig_world_mats[sl]
                        cand_wmat = scale_m.multiply(orig_wmat)
                        parent_m = self.get_parent_world_matrix(sl)
                        cand_lmat = parent_m.invert().multiply(cand_wmat)
                        lx, ly, lsx, lsy, lrot = cand_lmat.decompose()
                        if not sl.fits_in_laser(lx, ly, lsx, lsy, lrot, parent_mat=parent_m):
                            all_fit = False
                            if dry_run:
                                return False
                        if not dry_run:
                            sl.x = lx
                            sl.y = ly
                            sl.scale_x = lsx
                            sl.scale_y = lsy
                            sl.rotation = lrot
                    return all_fit

                if apply_multi_scale(sx, sy, dry_run=True):
                    apply_multi_scale(sx, sy, dry_run=False)
                else:
                    low = 0.0
                    high = 1.0
                    for _ in range(12):
                        mid = (low + high) / 2.0
                        mid_sx = 1.0 + (sx - 1.0) * mid
                        mid_sy = 1.0 + (sy - 1.0) * mid
                        if apply_multi_scale(mid_sx, mid_sy, dry_run=True):
                            low = mid
                        else:
                            high = mid
                    best_sx = 1.0 + (sx - 1.0) * low
                    best_sy = 1.0 + (sy - 1.0) * low
                    apply_multi_scale(best_sx, best_sy, dry_run=False)

                self._request_redraw()
            else:
                hlx, hly = self._drag_local_handle
                alx, aly = self._drag_local_mid if is_alt else self._drag_local_anchor

                parent_mat = self.get_parent_world_matrix(l)
                orig_local_mat = Transform2D.from_trs(self._drag_orig_x, self._drag_orig_y, self._drag_orig_scale_x, self._drag_orig_scale_y, self._drag_orig_rot)
                orig_world_mat = parent_mat.multiply(orig_local_mat)

                # Position mondiale fixe de l'ancrage (invariable durant le resize)
                awx, awy = orig_world_mat.apply(alx, aly)

                # Coordonnées laser actuelles de la souris
                mwx, mwy = self.canvas_to_norm(cx, cy)

                # SHIFT : Magnétisme et alignement sur la grille polaire ou cartésienne
                grid_type = getattr(self, "grid_type_var", None)
                if is_shift:
                    if grid_type and grid_type.get() == "polar":
                        mwx, mwy = self.snap_polar(mwx, mwy)
                    else:
                        grid_step = 0.05
                        mwx = round(mwx / grid_step) * grid_step
                        mwy = round(mwy / grid_step) * grid_step

                # Décomposition pour connaître l'orientation et l'échelle globale dans le monde
                _, _, world_sx, world_sy, world_rot = orig_world_mat.decompose()
                world_rad = math.radians(world_rot)
                cos_w = math.cos(world_rad)
                sin_w = math.sin(world_rad)

                # Vecteur Ancrage -> Souris dans l'espace laser mondial
                vw_x = mwx - awx
                vw_y = mwy - awy

                # Rotation du vecteur dans l'espace local de la forme
                vl_x = vw_x * cos_w + vw_y * sin_w
                vl_y = -vw_x * sin_w + vw_y * cos_w

                # Vecteur d'origine Ancrage -> Poignée dans l'espace local
                orig_span_x = (hlx - alx) * world_sx
                orig_span_y = (hly - aly) * world_sy

                is_corner = len(h_name) == 2

                if l.shape_type == "line":
                    # Redimensionnement d'une ligne UNIQUEMENT DANS SA LONGUEUR
                    inv_world = orig_world_mat.invert()
                    mlx, _ = inv_world.apply(mwx, mwy)

                    if is_alt:
                        # Redimensionnement symétrique depuis le centre
                        ratio_x = abs(mlx) / abs(hlx) if abs(hlx) > 1e-4 else 1.0
                    else:
                        # Redimensionnement avec extrémité opposée fixe
                        span_orig = hlx - alx
                        ratio_x = (mlx - alx) / span_orig if abs(span_orig) > 1e-4 else 1.0

                    ratio_x = max(0.02, ratio_x)
                    if is_ctrl:
                        ratio_x = max(0.02, round(ratio_x * 10.0) / 10.0)

                    cand_scale_x = max(0.02, self._drag_orig_scale_x * ratio_x)
                    cand_scale_y = 1.0

                    loc_rad = math.radians(self._drag_orig_rot)
                    cos_l = math.cos(loc_rad)
                    sin_l = math.sin(loc_rad)
                    if is_alt:
                        cand_x = self._drag_orig_x
                        cand_y = self._drag_orig_y
                    else:
                        inv_parent = parent_mat.invert()
                        apx, apy = inv_parent.apply(awx, awy)
                        cand_x = apx - (alx * cand_scale_x * cos_l)
                        cand_y = apy - (alx * cand_scale_x * sin_l)

                    if l.fits_in_laser(cand_x, cand_y, cand_scale_x, 1.0, parent_mat=parent_mat):
                        l.scale_x = cand_scale_x
                        l.scale_y = 1.0
                        l.x = cand_x
                        l.y = cand_y
                    else:
                        low = 0.0
                        high = 1.0
                        best_sx = self._drag_orig_scale_x
                        best_cx = self._drag_orig_x
                        best_cy = self._drag_orig_y
                        for _ in range(16):
                            mid_t = (low + high) / 2.0
                            test_sx = self._drag_orig_scale_x + (cand_scale_x - self._drag_orig_scale_x) * mid_t
                            if is_alt:
                                test_cx = self._drag_orig_x
                                test_cy = self._drag_orig_y
                            else:
                                test_cx = apx - (alx * test_sx * cos_l)
                                test_cy = apy - (alx * test_sx * sin_l)
                            if l.fits_in_laser(test_cx, test_cy, test_sx, 1.0, parent_mat=parent_mat):
                                best_sx = test_sx
                                best_cx = test_cx
                                best_cy = test_cy
                                low = mid_t
                            else:
                                high = mid_t
                        l.scale_x = best_sx
                        l.scale_y = 1.0
                        l.x = best_cx
                        l.y = best_cy

                    self._request_redraw()
                    return
                elif l.shape_type == "circle" or is_corner:
                    # Mode proportionnel : homothétie uniforme (maintient le cercle ou le ratio des coins)
                    if is_corner:
                        denom = orig_span_x * orig_span_x + orig_span_y * orig_span_y
                        ratio = (vl_x * orig_span_x + vl_y * orig_span_y) / denom if denom > 1e-6 else 1.0
                    elif "E" in h_name or "W" in h_name:
                        ratio = vl_x / orig_span_x if abs(orig_span_x) > 1e-4 else 1.0
                    else:
                        ratio = vl_y / orig_span_y if abs(orig_span_y) > 1e-4 else 1.0

                    ratio = max(0.05, ratio)
                    cand_scale_x = self._drag_orig_scale_x * ratio
                    cand_scale_y = self._drag_orig_scale_y * ratio
                else:
                    # Mode libre (étirement par composante X ou Y)
                    if "E" in h_name or "W" in h_name:
                        ratio_x = max(0.05, vl_x / orig_span_x) if abs(orig_span_x) > 1e-4 else 1.0
                        cand_scale_x = self._drag_orig_scale_x * ratio_x
                        cand_scale_y = self._drag_orig_scale_y
                    else:
                        ratio_y = max(0.05, vl_y / orig_span_y) if abs(orig_span_y) > 1e-4 else 1.0
                        cand_scale_x = self._drag_orig_scale_x
                        cand_scale_y = self._drag_orig_scale_y * ratio_y

                # CTRL : Snapping de l'échelle par paliers de 0.1
                if is_ctrl:
                    cand_scale_x = max(0.05, round(cand_scale_x * 10.0) / 10.0)
                    cand_scale_y = max(0.05, round(cand_scale_y * 10.0) / 10.0)

                # Calcul du centre garantissant que le côté opposé (ancrage) reste strictement immobile
                loc_rad = math.radians(self._drag_orig_rot)
                cos_l = math.cos(loc_rad)
                sin_l = math.sin(loc_rad)
                if is_alt:
                    cand_x = self._drag_orig_x
                    cand_y = self._drag_orig_y
                else:
                    inv_parent = parent_mat.invert()
                    apx, apy = inv_parent.apply(awx, awy)
                    cand_x = apx - (alx * cand_scale_x * cos_l - aly * cand_scale_y * sin_l)
                    cand_y = apy - (alx * cand_scale_x * sin_l + aly * cand_scale_y * cos_l)

                # Empêcher la forme de devenir plus grande que la fenêtre du laser [-1.0, 1.0]
                if l.fits_in_laser(cand_x, cand_y, cand_scale_x, cand_scale_y, parent_mat=parent_mat):
                    l.scale_x = cand_scale_x
                    l.scale_y = cand_scale_y
                    l.x = cand_x
                    l.y = cand_y
                else:
                    # Dichotomie pour saturer au bord du laser tout en conservant l'ancrage fixe
                    orig_sx = self._drag_orig_scale_x
                    orig_sy = self._drag_orig_scale_y
                    low = 0.0
                    high = 1.0
                    inv_parent = parent_mat.invert()
                    apx, apy = inv_parent.apply(awx, awy)
                    for _ in range(14):
                        mid = (low + high) / 2.0
                        ts_x = orig_sx + (cand_scale_x - orig_sx) * mid
                        ts_y = orig_sy + (cand_scale_y - orig_sy) * mid
                        if is_alt:
                            tx, ty = self._drag_orig_x, self._drag_orig_y
                        else:
                            tx = apx - (alx * ts_x * cos_l - aly * ts_y * sin_l)
                            ty = apy - (alx * ts_x * sin_l + aly * ts_y * cos_l)
                        if l.fits_in_laser(tx, ty, ts_x, ts_y, parent_mat=parent_mat):
                            low = mid
                        else:
                            high = mid

                    best_mid = low
                    best_sx = max(0.05, orig_sx + (cand_scale_x - orig_sx) * best_mid)
                    best_sy = max(0.05, orig_sy + (cand_scale_y - orig_sy) * best_mid)
                    if is_alt:
                        best_x, best_y = self._drag_orig_x, self._drag_orig_y
                    else:
                        best_x = apx - (alx * best_sx * cos_l - aly * best_sy * sin_l)
                        best_y = apy - (alx * best_sx * sin_l + aly * best_sy * cos_l)

                    l.scale_x = best_sx
                    l.scale_y = best_sy
                    l.x = best_x
                    l.y = best_y

                self._request_redraw()

        elif self._drag_mode == "rotate":
            if getattr(self, "_drag_is_multi", False):
                eff_layers = getattr(self, "_drag_eff_layers", self.get_effective_selected_layers())
                p_wx = self._drag_pivot_wx
                p_wy = self._drag_pivot_wy
                center_cx, center_cy = self.norm_to_canvas(p_wx, p_wy)
                cur_angle = math.degrees(math.atan2(cy - center_cy, cx - center_cx))
                delta_deg = (cur_angle - self._drag_orig_angle + 180.0) % 360.0 - 180.0
                rot_deg = -delta_deg

                if is_shift:
                    rot_deg = round(rot_deg / 15.0) * 15.0

                rad = math.radians(rot_deg)
                cos_t = math.cos(rad)
                sin_t = math.sin(rad)
                rot_m = Transform2D(
                    a=cos_t, b=-sin_t,
                    c=sin_t, d=cos_t,
                    tx=p_wx * (1.0 - cos_t) + p_wy * sin_t,
                    ty=p_wy * (1.0 - cos_t) - p_wx * sin_t
                )

                def apply_multi_rotate(rot_matrix, dry_run=False):
                    all_fit = True
                    for sl in eff_layers:
                        orig_wmat = self._drag_orig_world_mats[sl]
                        cand_wmat = rot_matrix.multiply(orig_wmat)
                        parent_m = self.get_parent_world_matrix(sl)
                        cand_lmat = parent_m.invert().multiply(cand_wmat)
                        lx, ly, lsx, lsy, lrot = cand_lmat.decompose()
                        if not sl.fits_in_laser(lx, ly, lsx, lsy, lrot, parent_mat=parent_m):
                            all_fit = False
                            if dry_run:
                                return False
                        if not dry_run:
                            sl.x = lx
                            sl.y = ly
                            sl.scale_x = lsx
                            sl.scale_y = lsy
                            sl.rotation = lrot
                    return all_fit

                if apply_multi_rotate(rot_m, dry_run=True):
                    apply_multi_rotate(rot_m, dry_run=False)

                self._request_redraw()
            else:
                wc_x, wc_y = self.get_layer_world_center(l)
                center_cx, center_cy = self.norm_to_canvas(wc_x, wc_y)
                cur_angle = math.degrees(math.atan2(cy - center_cy, cx - center_cx))
                # Différence d'angle angulaire continue sur 360°
                delta_deg = (cur_angle - self._drag_orig_angle + 180.0) % 360.0 - 180.0
                # Rotation dans le sens des aiguilles d'une montre quand la souris tourne dans le sens horaire
                new_rot = (self._drag_orig_rot - delta_deg) % 360.0

                # SHIFT : magnétisme par pas de 15° (Photoshop)
                if is_shift:
                    new_rot = round(new_rot / 15.0) * 15.0 % 360.0

                parent_mat = self.get_parent_world_matrix(l)
                if l.fits_in_laser(rotation=new_rot, parent_mat=parent_mat):
                    l.rotation = new_rot

                self._request_redraw()

    def _on_canvas_release(self, _event):
        if self._drag_mode == "sym_axis":
            self._drag_mode = None
            self.canvas.config(cursor="crosshair")
            self.lbl_status.config(text=f"Axe de symétrie positionné en ({self.sym_cx:+.2f}, {self.sym_cy:+.2f})", fg="#ffb74d")
            self.redraw_canvas()
            return

        if self._drag_mode == "pencil":
            self._drag_mode = None
            is_shift, is_alt, is_ctrl = self._get_modifiers(_event)
            is_shift = is_shift or getattr(self, "_draw_had_shift", False)
            sym_mode, sym_count = self.get_sym_mode()

            if not self._draw_moved:
                # Clic simple : place un point unique (ou points symétriques)
                start_wx, start_wy = self._draw_points[0]
                self.push_undo_state()
                pts_base = [(start_wx, start_wy)]
                sym_branches = self.compute_symmetry_strokes(pts_base)

                if len(sym_branches) > 1:
                    self.layer_counter += 1
                    grp = Layer(self.layer_counter, f"Symétrie Point ({self.sym_mode_var.get()})", "group")
                    for b_pts in sym_branches:
                        self.layer_counter += 1
                        l_pt = Layer(self.layer_counter, f"Point {self.layer_counter}", "point", color=self.current_color)
                        l_pt.x = b_pts[0][0]
                        l_pt.y = b_pts[0][1]
                        l_pt.local_points = [(0.0, 0.0)]
                        grp.children.append(l_pt)
                    self._insert_new_layer_in_tree(grp)
                    self.lbl_status.config(text=f"Points symétriques créés ({len(sym_branches)} points)", fg="#66bb6a")
                else:
                    self.layer_counter += 1
                    name = f"Point {self.layer_counter}"
                    layer = Layer(self.layer_counter, name, "point", color=self.current_color)
                    layer.x = start_wx
                    layer.y = start_wy
                    layer.local_points = [(0.0, 0.0)]
                    self._insert_new_layer_in_tree(layer)
                    self.lbl_status.config(text=f"Point {self.layer_counter} créé à ({start_wx:.2f}, {start_wy:.2f})", fg="#66bb6a")

            elif is_shift:
                # Glisser avec Shift : Ligne droite aimantée
                sx, sy = self._draw_points[0]
                ex, ey = self._draw_last_snap
                dist = math.hypot(ex - sx, ey - sy)
                if dist < 0.02:
                    self.push_undo_state()
                    pts_base = [(sx, sy)]
                    sym_branches = self.compute_symmetry_strokes(pts_base)
                    if len(sym_branches) > 1:
                        self.layer_counter += 1
                        grp = Layer(self.layer_counter, f"Symétrie Point ({self.sym_mode_var.get()})", "group")
                        for b_pts in sym_branches:
                            self.layer_counter += 1
                            l_pt = Layer(self.layer_counter, f"Point {self.layer_counter}", "point", color=self.current_color)
                            l_pt.x = b_pts[0][0]
                            l_pt.y = b_pts[0][1]
                            l_pt.local_points = [(0.0, 0.0)]
                            grp.children.append(l_pt)
                        self._insert_new_layer_in_tree(grp)
                        self.lbl_status.config(text=f"Points symétriques créés ({len(sym_branches)} points)", fg="#66bb6a")
                    else:
                        self.layer_counter += 1
                        layer = Layer(self.layer_counter, f"Point {self.layer_counter}", "point", color=self.current_color)
                        layer.x = sx
                        layer.y = sy
                        layer.local_points = [(0.0, 0.0)]
                        self._insert_new_layer_in_tree(layer)
                        self.lbl_status.config(text=f"Point {self.layer_counter} créé", fg="#66bb6a")
                else:
                    self.push_undo_state()
                    pts_base = [(sx, sy), (ex, ey)]
                    sym_branches = self.compute_symmetry_strokes(pts_base)
                    if len(sym_branches) > 1:
                        self.layer_counter += 1
                        grp = Layer(self.layer_counter, f"Symétrie Ligne ({self.sym_mode_var.get()})", "group")
                        for b_pts in sym_branches:
                            p1, p2 = b_pts[0], b_pts[1]
                            b_dist = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
                            b_ang = math.degrees(math.atan2(p2[1] - p1[1], p2[0] - p1[0]))
                            cx_laser = (p1[0] + p2[0]) / 2.0
                            cy_laser = (p1[1] + p2[1]) / 2.0
                            self.layer_counter += 1
                            l_line = Layer(self.layer_counter, f"Ligne {self.layer_counter}", "line", color=self.current_color)
                            l_line.x = cx_laser
                            l_line.y = cy_laser
                            l_line.rotation = b_ang
                            l_line.scale_x = max(0.05, b_dist / 1.10)
                            l_line.scale_y = 1.0
                            l_line.local_points = [(-0.55, 0.0), (0.55, 0.0)]
                            grp.children.append(l_line)
                        self._insert_new_layer_in_tree(grp)
                        self.lbl_status.config(text=f"Lignes symétriques créées ({len(sym_branches)} lignes)", fg="#66bb6a")
                    else:
                        self.layer_counter += 1
                        name = f"Ligne {self.layer_counter}"
                        layer = Layer(self.layer_counter, name, "line", color=self.current_color)
                        cx_laser = (sx + ex) / 2.0
                        cy_laser = (sy + ey) / 2.0
                        dx = ex - sx
                        dy = ey - sy
                        angle_deg = math.degrees(math.atan2(dy, dx))
                        layer.x = cx_laser
                        layer.y = cy_laser
                        layer.rotation = angle_deg
                        layer.scale_x = max(0.05, dist / 1.10)
                        layer.scale_y = 1.0
                        layer.local_points = [(-0.55, 0.0), (0.55, 0.0)]
                        self._insert_new_layer_in_tree(layer)
                        self.lbl_status.config(text=f"Ligne {self.layer_counter} créée", fg="#66bb6a")
            else:
                # Glisser sans Shift : Tracé au crayon libre
                pts = self._draw_points
                if len(pts) <= 1:
                    start_wx, start_wy = pts[0]
                    self.push_undo_state()
                    pts_base = [(start_wx, start_wy)]
                    sym_branches = self.compute_symmetry_strokes(pts_base)
                    if len(sym_branches) > 1:
                        self.layer_counter += 1
                        grp = Layer(self.layer_counter, f"Symétrie Point ({self.sym_mode_var.get()})", "group")
                        for b_pts in sym_branches:
                            self.layer_counter += 1
                            l_pt = Layer(self.layer_counter, f"Point {self.layer_counter}", "point", color=self.current_color)
                            l_pt.x = b_pts[0][0]
                            l_pt.y = b_pts[0][1]
                            l_pt.local_points = [(0.0, 0.0)]
                            grp.children.append(l_pt)
                        self._insert_new_layer_in_tree(grp)
                    else:
                        self.layer_counter += 1
                        layer = Layer(self.layer_counter, f"Point {self.layer_counter}", "point", color=self.current_color)
                        layer.x = start_wx
                        layer.y = start_wy
                        layer.local_points = [(0.0, 0.0)]
                        self._insert_new_layer_in_tree(layer)
                    self.lbl_status.config(text=f"Point {self.layer_counter} créé", fg="#66bb6a")
                else:
                    self.push_undo_state()
                    sym_branches = self.compute_symmetry_strokes(pts)
                    if len(sym_branches) > 1:
                        self.layer_counter += 1
                        grp = Layer(self.layer_counter, f"Symétrie Tracé ({self.sym_mode_var.get()})", "group")
                        for b_pts in sym_branches:
                            self.layer_counter += 1
                            l_penc = Layer(self.layer_counter, f"Tracé {self.layer_counter}", "pencil", color=self.current_color)
                            min_x = min(p[0] for p in b_pts)
                            max_x = max(p[0] for p in b_pts)
                            min_y = min(p[1] for p in b_pts)
                            max_y = max(p[1] for p in b_pts)
                            cx_laser = (min_x + max_x) / 2.0
                            cy_laser = (min_y + max_y) / 2.0
                            l_penc.x = cx_laser
                            l_penc.y = cy_laser
                            l_penc.scale_x = 1.0
                            l_penc.scale_y = 1.0
                            l_penc.rotation = 0.0
                            l_penc.is_closed = False
                            l_penc.local_points = [(p[0] - cx_laser, p[1] - cy_laser) for p in b_pts]
                            grp.children.append(l_penc)
                        self._insert_new_layer_in_tree(grp)
                        self.lbl_status.config(text=f"Tracés symétriques créés ({len(sym_branches)} branches)", fg="#66bb6a")
                    else:
                        self.layer_counter += 1
                        name = f"Tracé {self.layer_counter}"
                        layer = Layer(self.layer_counter, name, "pencil", color=self.current_color)
                        min_x = min(p[0] for p in pts)
                        max_x = max(p[0] for p in pts)
                        min_y = min(p[1] for p in pts)
                        max_y = max(p[1] for p in pts)
                        cx_laser = (min_x + max_x) / 2.0
                        cy_laser = (min_y + max_y) / 2.0
                        layer.x = cx_laser
                        layer.y = cy_laser
                        layer.scale_x = 1.0
                        layer.scale_y = 1.0
                        layer.rotation = 0.0
                        layer.is_closed = False
                        layer.local_points = [(p[0] - cx_laser, p[1] - cy_laser) for p in pts]
                        self._insert_new_layer_in_tree(layer)
                        self.lbl_status.config(text=f"Tracé {self.layer_counter} créé ({len(pts)} pts)", fg="#66bb6a")

            self._draw_points = []
            self._reset_modifier_keys()
            self.redraw_canvas()
            return

        if self._drag_mode == "marquee":
            self._drag_mode = None
            is_shift, is_alt, is_ctrl = self._get_modifiers(_event)
            if not getattr(self, "_marquee_moved", False):
                # Clic simple dans le vide sans glisser
                if not (is_ctrl or is_shift):
                    self.selected_layer = None
                    self.selected_layers.clear()
                    self._sync_legacy_indices()
                    self._sync_listbox_selection()
                    self.lbl_status.config(text="Sélection réinitialisée", fg="#888888")
            else:
                n = len(self.selected_layers)
                if n > 0:
                    self.lbl_status.config(text=f"{n} forme(s) sélectionnée(s) via rectangle", fg="#80d8ff")
                else:
                    self.lbl_status.config(text="Aucune forme dans la zone sélectionnée", fg="#888888")
            self._marquee_moved = False
            self._reset_modifier_keys()
            self.redraw_canvas()
            return

        if self._drag_mode == "move":
            is_shift, is_alt, is_ctrl = self._get_modifiers(_event)
            dx = getattr(_event, "x", self._drag_start_cx) - self._drag_start_cx
            dy = getattr(_event, "y", self._drag_start_cy) - self._drag_start_cy
            if math.hypot(dx, dy) < 4 and getattr(self, "_drag_was_multi", False):
                if not (is_ctrl or is_shift) and getattr(self, "_drag_clicked_layer", None) is not None:
                    self.select_layer_object(self._drag_clicked_layer)

        self._reset_modifier_keys()
        if self._pre_drag_snapshot is not None:
            if self._has_state_changed(self._pre_drag_snapshot):
                self.undo_stack.append(self._pre_drag_snapshot)
                if len(self.undo_stack) > self._max_undo:
                    self.undo_stack.pop(0)
                self.redo_stack.clear()
            self._pre_drag_snapshot = None

        self._drag_mode = None
        self._duplicated_during_drag = False
        if getattr(self, "_snap_guide_x", False) or getattr(self, "_snap_guide_y", False):
            self._snap_guide_x = False
            self._snap_guide_y = False
            self.redraw_canvas()
