import math
import tkinter as tk

try:
    from ..core.constants import CANVAS_SIZE
except (ImportError, ValueError):
    from core.constants import CANVAS_SIZE


class CanvasRenderMixin:
    """Moteur de rendu graphique du Canvas laser : grille, repères, tracés, poignées de transformation, prévisualisations."""

    def _hex(self, color=None) -> str:
        """Retourne la couleur au format hexadécimal '#rrggbb'."""
        c = color or self.current_color
        return f"#{c[0]:02x}{c[1]:02x}{c[2]:02x}"

    def _draw_axes(self):
        c_min_x, c_max_y = self.norm_to_canvas(-1.0, -1.0)
        c_max_x, c_min_y = self.norm_to_canvas(1.0, 1.0)
        cx0, cy0 = self.norm_to_canvas(0.0, 0.0)

        # Cadre limite de projection laser [-1.0, 1.0]
        self.canvas.create_rectangle(c_min_x, c_min_y, c_max_x, c_max_y, outline="#333333", width=1, dash=(4, 4))

        # Grille de repères et alignement (si activée)
        if self.show_grid_var.get():
            grid_type = getattr(self, "grid_type_var", None)
            is_polar = grid_type and grid_type.get() == "polar"

            if is_polar:
                # ── Grille Polaire : Cercles concentriques (pas de 0.05) & Rayons angulaires à 30° ──
                span = (CANVAS_SIZE / 2.0) * self.view_zoom
                for i in range(1, 21):
                    r_val = i / 20.0
                    r_px = r_val * span
                    if i % 10 == 0:
                        col, d = "#303030", (3, 3)  # R=0.5 et R=1.0
                    elif i % 2 == 0:
                        col, d = "#202020", (2, 3)  # R=0.1, 0.2, ...
                    else:
                        col, d = "#141414", (1, 4)  # R=0.05, 0.15, ...
                    self.canvas.create_oval(cx0 - r_px, cy0 - r_px, cx0 + r_px, cy0 + r_px, outline=col, dash=d)

                # Rayons angulaires à 30° (0°, 30°, 60°, ..., 330°)
                for deg in range(0, 360, 30):
                    rad = math.radians(deg)
                    cos_a = math.cos(rad)
                    sin_a = math.sin(rad)
                    ex = cx0 + span * cos_a
                    ey = cy0 - span * sin_a
                    if deg in (0, 90, 180, 270):
                        col, d = "#2a2a2a", (2, 4)
                    else:
                        col, d = "#1a1a1a", (1, 4)
                    self.canvas.create_line(cx0, cy0, ex, ey, fill=col, dash=d)

                    # Étiquettes d'angles en périphérie
                    lbl_x = cx0 + (span + 14) * cos_a
                    lbl_y = cy0 - (span + 14) * sin_a
                    self.canvas.create_text(lbl_x, lbl_y, text=f"{deg}°", fill="#555555", font=("Segoe UI", 7))
            else:
                # ── Grille Cartésienne standard : Lignes de -1.0 à 1.0 par pas de 0.05 ──
                for i in range(-20, 21):
                    if i == 0:
                        continue  # L'axe central (0, 0) est tracé au premier plan

                    val = i / 20.0
                    gx, _ = self.norm_to_canvas(val, 0.0)
                    _, gy = self.norm_to_canvas(0.0, val)

                    if i % 10 == 0:
                        col, d = "#303030", (3, 3)  # Repères majeurs (+/- 0.5)
                    elif i % 2 == 0:
                        col, d = "#202020", (2, 3)  # Repères principaux (+/- 0.1)
                    else:
                        col, d = "#141414", (1, 4)  # Repères secondaires (+/- 0.05)

                    self.canvas.create_line(gx, c_min_y, gx, c_max_y, fill=col, dash=d)
                    self.canvas.create_line(c_min_x, gy, c_max_x, gy, fill=col, dash=d)

        # Axes centraux X=0 et Y=0
        axis_color = "#383838" if self.show_grid_var.get() else "#1c1c1c"
        self.canvas.create_line(cx0, max(0, c_min_y), cx0, min(CANVAS_SIZE, c_max_y), fill=axis_color, dash=(2, 4))
        self.canvas.create_line(max(0, c_min_x), cy0, min(CANVAS_SIZE, c_max_x), cy0, fill=axis_color, dash=(2, 4))

        # Repères d'alignement magnétiques Shift vers le centre (Smart Guides rose magenta type Photoshop)
        if getattr(self, "_snap_guide_x", False):
            self.canvas.create_line(cx0, 0, cx0, CANVAS_SIZE, fill="#ff007f", width=1.5, dash=(4, 3))
        if getattr(self, "_snap_guide_y", False):
            self.canvas.create_line(0, cy0, CANVAS_SIZE, cy0, fill="#ff007f", width=1.5, dash=(4, 3))

        # ── Rendu des Axes et Centre de Symétrie (si mode miroir actif) ──
        sym_mode, sym_count = self.get_sym_mode()
        if sym_mode != "none":
            scx, scy = self.norm_to_canvas(self.sym_cx, self.sym_cy)
            axis_col = "#ff9800"
            sub_col = "#ffb74d"

            if sym_mode == "x2_horiz":
                # Axe vertical x = sym_cx
                self.canvas.create_line(scx, 0, scx, CANVAS_SIZE, fill=axis_col, width=1.5, dash=(6, 4))
            elif sym_mode == "x2_vert":
                # Axe horizontal y = sym_cy
                self.canvas.create_line(0, scy, CANVAS_SIZE, scy, fill=axis_col, width=1.5, dash=(6, 4))
            elif sym_mode == "x4_quad":
                # Axes en croix X et Y
                self.canvas.create_line(scx, 0, scx, CANVAS_SIZE, fill=axis_col, width=1.5, dash=(6, 4))
                self.canvas.create_line(0, scy, CANVAS_SIZE, scy, fill=axis_col, width=1.5, dash=(6, 4))
            elif sym_mode == "radial":
                # Rayons radiaux à 360° / N
                r_len = CANVAS_SIZE * 1.5
                for k in range(sym_count):
                    th = k * (2.0 * math.pi / sym_count)
                    ex = scx + r_len * math.cos(th)
                    ey = scy - r_len * math.sin(th)
                    self.canvas.create_line(scx, scy, ex, ey, fill=axis_col, width=1.2, dash=(5, 4))

            # Poignée interactive du centre de symétrie (scx, scy)
            self.canvas.create_line(scx - 14, scy, scx + 14, scy, fill=sub_col, width=1)
            self.canvas.create_line(scx, scy - 14, scx, scy + 14, fill=sub_col, width=1)
            self.canvas.create_oval(scx - 8, scy - 8, scx + 8, scy + 8, outline=axis_col, width=1.8)
            self.canvas.create_oval(scx - 3, scy - 3, scx + 3, scy + 3, fill="#ffffff", outline=axis_col)
            self.canvas.create_text(scx + 12, scy - 12, text=f"Axe ({self.sym_cx:+.2f}, {self.sym_cy:+.2f})", fill=sub_col, font=("Segoe UI", 8, "bold"), anchor=tk.W)

    def _request_redraw(self):
        """Planifie un redessin au prochain cycle d'inactivité (60 FPS fluide, zéro latence/backlog souris)."""
        if not getattr(self, "_redraw_pending", False):
            self._redraw_pending = True
            self.root.after_idle(self._flush_redraw)

    def _flush_redraw(self):
        self._redraw_pending = False
        self.redraw_canvas()

    def redraw_canvas(self):
        self._redraw_pending = False
        self.canvas.delete("all")
        self._draw_axes()

        cur_l = self.get_current_layer()

        for idx, l in enumerate(self.layers):
            if not l.enabled:
                continue
            strokes = l.get_render_strokes()
            for wpts, stroke_color, is_closed, shape_type in strokes:
                if not wpts:
                    continue
                cpts = [self.norm_to_canvas(wx, wy) for wx, wy in wpts]
                color_hex = f"#{stroke_color[0]:02x}{stroke_color[1]:02x}{stroke_color[2]:02x}"

                # Tracé du trait laser ou du point unique
                if len(cpts) == 1:
                    px, py = cpts[0]
                    self.canvas.create_oval(px - 3.5, py - 3.5, px + 3.5, py + 3.5, fill=color_hex, outline="#ffffff", width=1.5)
                elif len(cpts) > 1:
                    flat = [coord for pt in cpts for coord in pt]
                    self.canvas.create_line(*flat, fill=color_hex, width=2, capstyle=tk.ROUND, joinstyle=tk.ROUND)
                    if is_closed and len(cpts) > 2:
                        self.canvas.create_line(cpts[-1][0], cpts[-1][1], cpts[0][0], cpts[0][1], fill=color_hex, width=2)

        # Rendu spécifique de sélection pour les calques actifs (Photoshop-like)
        if self.current_tool == "select":
            handles_info = self._get_selection_handles_data()
            if handles_info:
                bx1, by1, bx2, by2, mx, my, handles, (rot_x, rot_y), center_cx, center_cy, is_multi, eff_layers = handles_info

                if is_multi:
                    # Boîte englobante unifiée englobant TOUT ce qui est sélectionné
                    self.canvas.create_rectangle(bx1, by1, bx2, by2, outline="#00e5ff", width=1.2, dash=(4, 3))

                    # 3. Poignée de rotation supérieure (tige + rond supérieur)
                    self.canvas.create_line(mx, by1, rot_x, rot_y, fill="#00e5ff", dash=(2, 2))
                    self.canvas.create_oval(rot_x - 4, rot_y - 4, rot_x + 4, rot_y + 4, fill="#00e5ff", outline="#ffffff")

                    # 4. Poignées de redimensionnement (4 coins + 4 côtés)
                    hs = 4.5
                    for hx, hy in handles.values():
                        self.canvas.create_rectangle(hx - hs, hy - hs, hx + hs, hy + hs, fill="#ffffff", outline="#00a8cc")

                    # 5. Point central d'ancrage / pivot
                    self.canvas.create_oval(center_cx - 3, center_cy - 3, center_cx + 3, center_cy + 3, fill="#00e5ff", outline="#000000")

                else:
                    cur_l = eff_layers[0]
                    if cur_l and cur_l.enabled:
                        if cur_l.shape_type == "point":
                            self.canvas.create_oval(center_cx - 9, center_cy - 9, center_cx + 9, center_cy + 9, outline="#00e5ff", width=1.5, dash=(3, 3))
                        elif cur_l.shape_type == "line":
                            # Ligne : surlignage cyan le long de la ligne
                            hx1, hy1 = handles.get("W", (bx1, by1))
                            hx2, hy2 = handles.get("E", (bx2, by2))
                            self.canvas.create_line(hx1, hy1, hx2, hy2, fill="#00e5ff", width=1.5, dash=(4, 3))

                            # Poignée de rotation (tige + rond)
                            self.canvas.create_line(mx, my, rot_x, rot_y, fill="#00e5ff", dash=(2, 2))
                            self.canvas.create_oval(rot_x - 4, rot_y - 4, rot_x + 4, rot_y + 4, fill="#00e5ff", outline="#ffffff")

                            # Deux poignées d'extrémité (redimensionnement uniquement dans la longueur)
                            hs = 5.0
                            self.canvas.create_rectangle(hx1 - hs, hy1 - hs, hx1 + hs, hy1 + hs, fill="#ffffff", outline="#00a8cc", width=1.5)
                            self.canvas.create_rectangle(hx2 - hs, hy2 - hs, hx2 + hs, hy2 + hs, fill="#ffffff", outline="#00a8cc", width=1.5)

                            # Point central d'ancrage
                            self.canvas.create_oval(center_cx - 3, center_cy - 3, center_cx + 3, center_cy + 3, fill="#00e5ff", outline="#000000")
                        else:
                            # Boîte englobante discrète en tirets cyan
                            self.canvas.create_rectangle(bx1, by1, bx2, by2, outline="#00e5ff", width=1, dash=(3, 3))

                            # Poignée de rotation (tige + rond supérieur)
                            self.canvas.create_line(mx, by1, rot_x, rot_y, fill="#00e5ff", dash=(2, 2))
                            self.canvas.create_oval(rot_x - 4, rot_y - 4, rot_x + 4, rot_y + 4, fill="#00e5ff", outline="#ffffff")

                            # Poignées de redimensionnement (4 coins + 4 côtés)
                            hs = 4.5
                            for hx, hy in handles.values():
                                self.canvas.create_rectangle(hx - hs, hy - hs, hx + hs, hy + hs, fill="#ffffff", outline="#00a8cc")

                            # Point central d'ancrage
                            self.canvas.create_oval(center_cx - 3, center_cy - 3, center_cx + 3, center_cy + 3, fill="#00e5ff", outline="#000000")

        # Prévisualisation dynamique du tracé au crayon / ligne / point
        if self._drag_mode == "pencil":
            is_shift, _, _ = self._get_modifiers()
            color_hex = self._hex(self.current_color)
            if is_shift:
                sx, sy = self._draw_points[0]
                ex, ey = self._draw_last_snap
                sym_branches = self.compute_symmetry_strokes([(sx, sy), (ex, ey)])
                for idx, b_pts in enumerate(sym_branches):
                    bsx, bsy = b_pts[0]
                    bex, bey = b_pts[1]
                    p1 = self.norm_to_canvas(bsx, bsy)
                    p2 = self.norm_to_canvas(bex, bey)
                    b_color = color_hex if idx == 0 else "#ffb74d"
                    self.canvas.create_line(p1[0], p1[1], p2[0], p2[1], fill=b_color, width=2)
                    self.canvas.create_oval(p1[0] - 3, p1[1] - 3, p1[0] + 3, p1[1] + 3, fill=b_color, outline="#ffffff")
                    self.canvas.create_oval(p2[0] - 4, p2[1] - 4, p2[0] + 4, p2[1] + 4, fill="#ffffff", outline=b_color, width=1.5)
            else:
                if len(self._draw_points) == 1:
                    sym_branches = self.compute_symmetry_strokes([self._draw_points[0]])
                    for idx, b_pts in enumerate(sym_branches):
                        p = self.norm_to_canvas(b_pts[0][0], b_pts[0][1])
                        b_color = color_hex if idx == 0 else "#ffb74d"
                        self.canvas.create_oval(p[0] - 3.5, p[1] - 3.5, p[0] + 3.5, p[1] + 3.5, fill=b_color, outline="#ffffff")
                elif len(self._draw_points) > 1:
                    sym_branches = self.compute_symmetry_strokes(self._draw_points)
                    for idx, b_pts in enumerate(sym_branches):
                        cpts = [self.norm_to_canvas(wx, wy) for wx, wy in b_pts]
                        flat = [coord for pt in cpts for coord in pt]
                        b_color = color_hex if idx == 0 else "#ffb74d"
                        self.canvas.create_line(*flat, fill=b_color, width=2, capstyle=tk.ROUND, joinstyle=tk.ROUND)

        # Prévisualisation du point sous la souris en mode crayon avec Shift (sans cliquer)
        elif self.current_tool == "pencil" and getattr(self, "_pencil_hover_pt", None) is not None:
            scx, scy, wx, wy = self._pencil_hover_pt
            color_hex = self._hex(self.current_color)

            # Ligne pointillée fine vers la souris si décalage magnétique
            if hasattr(self, "_last_mouse_cx") and hasattr(self, "_last_mouse_cy"):
                mcx, mcy = self._last_mouse_cx, self._last_mouse_cy
                if math.hypot(mcx - scx, mcy - scy) >= 2.0:
                    self.canvas.create_line(mcx, mcy, scx, scy, fill="#00e5ff", width=1, dash=(1, 2))

            # Réticules et halos d'aimant magnétique pour chaque branche de symétrie
            sym_branches = self.compute_symmetry_strokes([(wx, wy)])
            for idx, b_pts in enumerate(sym_branches):
                bwx, bwy = b_pts[0]
                bscx, bscy = self.norm_to_canvas(bwx, bwy)
                halo_col = "#00e5ff" if idx == 0 else "#ffb74d"
                self.canvas.create_oval(bscx - 9, bscy - 9, bscx + 9, bscy + 9, outline=halo_col, width=1.2, dash=(3, 2))
                self.canvas.create_oval(bscx - 4, bscy - 4, bscx + 4, bscy + 4, fill=color_hex, outline="#ffffff", width=1.5)
                self.canvas.create_text(bscx + 13, bscy - 8, text=f"({bwx:+.2f}, {bwy:+.2f})", fill=halo_col, font=("Segoe UI", 8, "bold"), anchor=tk.W)

        # Rectangle de sélection par glisser-déposer (Marquee)
        if self._drag_mode == "marquee" and getattr(self, "_marquee_moved", False):
            rx1 = min(self._marquee_start_cx, getattr(self, "_marquee_current_cx", self._marquee_start_cx))
            ry1 = min(self._marquee_start_cy, getattr(self, "_marquee_current_cy", self._marquee_start_cy))
            rx2 = max(self._marquee_start_cx, getattr(self, "_marquee_current_cx", self._marquee_start_cx))
            ry2 = max(self._marquee_start_cy, getattr(self, "_marquee_current_cy", self._marquee_start_cy))
            self.canvas.create_rectangle(
                rx1, ry1, rx2, ry2,
                outline="#00e5ff",
                width=1,
                dash=(5, 3),
                fill="#00e5ff",
                stipple="gray12"
            )

        self.update_count()
