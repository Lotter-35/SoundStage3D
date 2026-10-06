import math
import time
import tkinter as tk
from tkinter import messagebox

try:
    from ..core.timeline import TimelineModel, TimelineTrack, TimelineClip
except (ImportError, ValueError):
    from core.timeline import TimelineModel, TimelineTrack, TimelineClip


class TimelineWidget(tk.Frame):
    """Widget de Timeline musicale DAW avec grille calée sur le BPM, pistes de calques/groupes et tête de lecture."""

    RULER_HEIGHT = 26
    HEADER_WIDTH = 150
    LANE_HEIGHT = 28
    HANDLE_WIDTH = 8

    def __init__(self, parent: tk.Widget, app, **kwargs):
        super().__init__(parent, bg="#1a1a1a", **kwargs)
        self.app = app
        self.model: TimelineModel = app.timeline

        self.selected_track_id: int | None = None
        self.selected_clip_id: int | None = None

        self._drag_mode: str | None = None  # "scrub", "move_clip", "resize_left", "resize_right"
        self._drag_clip: TimelineClip | None = None
        self._drag_start_x: float = 0.0
        self._drag_orig_start: float = 0.0
        self._drag_orig_dur: float = 0.0
        self._last_perf_time: float = time.perf_counter()

        self._build_ui()
        self.on_model_changed()

    def _build_ui(self):
        # ── Barre d'outils et de transport supérieure ──
        tb = tk.Frame(self, bg="#222222", height=32, padx=6, pady=4)
        tb.pack(side=tk.TOP, fill=tk.X)
        self.tb_frame = tb

        # 1. Play / Pause
        self.btn_play = tk.Button(
            tb, text="▶ Play", command=self.toggle_play,
            bg="#00897b", fg="#ffffff", activebackground="#00796b", activeforeground="#ffffff",
            font=("Segoe UI", 9, "bold"), relief=tk.FLAT, padx=10, pady=1, cursor="hand2"
        )
        self.btn_play.pack(side=tk.LEFT, padx=3)

        # 2. Stop / Rewind
        self.btn_stop = tk.Button(
            tb, text="⏮ Stop", command=self.rewind,
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            font=("Segoe UI", 8), relief=tk.FLAT, padx=8, pady=2, cursor="hand2"
        )
        self.btn_stop.pack(side=tk.LEFT, padx=2)

        # 3. Boucle (Loop)
        self.loop_var = tk.BooleanVar(value=self.model.loop)
        self.chk_loop = tk.Checkbutton(
            tb, text="🔁 Boucle", variable=self.loop_var, command=self._on_loop_change,
            bg="#222222", fg="#cccccc", selectcolor="#333333", activebackground="#222222",
            font=("Segoe UI", 8)
        )
        self.chk_loop.pack(side=tk.LEFT, padx=4)

        tk.Frame(tb, bg="#3c3c3c", width=1, height=18).pack(side=tk.LEFT, padx=6)

        # 4. Affichage Timecode & Mesure
        self.lbl_timecode = tk.Label(
            tb, text="00:00.00  (Mes. 1.1)", font=("Consolas", 9, "bold"),
            fg="#00e5ff", bg="#222222"
        )
        self.lbl_timecode.pack(side=tk.LEFT, padx=4)

        tk.Frame(tb, bg="#3c3c3c", width=1, height=18).pack(side=tk.LEFT, padx=6)

        # 5. Réglage BPM
        tk.Label(tb, text="BPM :", fg="#aaaaaa", bg="#222222", font=("Segoe UI", 8)).pack(side=tk.LEFT, padx=2)
        self.bpm_var = tk.StringVar(value=str(int(self.model.bpm)))
        self.spin_bpm = tk.Spinbox(
            tb, from_=30, to=300, increment=1, textvariable=self.bpm_var,
            width=4, bg="#2d2d2d", fg="#ffb74d", relief=tk.FLAT, font=("Segoe UI", 9, "bold"),
            insertbackground="#ffffff", command=self._on_bpm_change
        )
        self.spin_bpm.pack(side=tk.LEFT, padx=2)
        self.spin_bpm.bind("<Return>", lambda e: self._on_bpm_change())
        self.spin_bpm.bind("<FocusOut>", lambda e: self._on_bpm_change())

        tk.Frame(tb, bg="#3c3c3c", width=1, height=18).pack(side=tk.LEFT, padx=6)

        # 6. Réglage Durée totale
        tk.Label(tb, text="Durée (s) :", fg="#aaaaaa", bg="#222222", font=("Segoe UI", 8)).pack(side=tk.LEFT, padx=2)
        self.dur_var = tk.StringVar(value=f"{self.model.total_duration:.1f}")
        self.spin_dur = tk.Spinbox(
            tb, from_=1.0, to=300.0, increment=1.0, format="%.1f", textvariable=self.dur_var,
            width=5, bg="#2d2d2d", fg="#ffffff", relief=tk.FLAT, font=("Segoe UI", 9),
            insertbackground="#ffffff", command=self._on_dur_change
        )
        self.spin_dur.pack(side=tk.LEFT, padx=2)
        self.spin_dur.bind("<Return>", lambda e: self._on_dur_change())
        self.spin_dur.bind("<FocusOut>", lambda e: self._on_dur_change())

        tk.Frame(tb, bg="#3c3c3c", width=1, height=18).pack(side=tk.LEFT, padx=6)

        # 7. Snap BPM (Magnétisme)
        self.snap_var = tk.BooleanVar(value=self.model.snap_to_beat)
        self.chk_snap = tk.Checkbutton(
            tb, text="🧲 Snap BPM", variable=self.snap_var, command=self._on_snap_change,
            bg="#222222", fg="#cccccc", selectcolor="#333333", activebackground="#222222",
            font=("Segoe UI", 8)
        )
        self.chk_snap.pack(side=tk.LEFT, padx=4)

        # 8. Boutons droite : Ajouter calque / groupe sélectionné & Retirer piste
        self.btn_del_track = tk.Button(
            tb, text="🗑 Retirer", command=self.remove_selected_track,
            bg="#333333", fg="#ef5350", activebackground="#444444", activeforeground="#ffffff",
            font=("Segoe UI", 8), relief=tk.FLAT, padx=6, pady=2, cursor="hand2"
        )
        self.btn_del_track.pack(side=tk.RIGHT, padx=3)

        self.btn_add_track = tk.Button(
            tb, text="⏱+ Ajouter sélection", command=self.add_selected_layer_to_timeline,
            bg="#333333", fg="#00e5ff", activebackground="#444444", activeforeground="#ffffff",
            font=("Segoe UI", 8, "bold"), relief=tk.FLAT, padx=8, pady=2, cursor="hand2"
        )
        self.btn_add_track.pack(side=tk.RIGHT, padx=3)

        # ── Zone Canvas de la Timeline ──
        canvas_height = max(110, self.RULER_HEIGHT + max(3, len(self.model.tracks)) * self.LANE_HEIGHT + 4)
        self.canvas = tk.Canvas(
            self, bg="#141414", height=canvas_height, highlightthickness=0, cursor="arrow"
        )
        self.canvas.pack(fill=tk.BOTH, expand=True)

        self.canvas.bind("<Configure>", self._on_canvas_configure)
        self.canvas.bind("<Button-1>", self._on_press)
        self.canvas.bind("<B1-Motion>", self._on_motion)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<Motion>", self._on_hover)

    def _on_canvas_configure(self, _event):
        self.redraw()

    # ── Moteur Temporel & Coordonnées ──

    def _get_track_width(self) -> float:
        w = self.canvas.winfo_width()
        return max(50.0, float(w - self.HEADER_WIDTH))

    def time_to_x(self, t: float) -> float:
        dur = max(0.1, self.model.total_duration)
        clamped = max(0.0, min(dur, float(t)))
        return self.HEADER_WIDTH + (clamped / dur) * self._get_track_width()

    def x_to_time(self, x: float) -> float:
        tw = self._get_track_width()
        dur = max(0.1, self.model.total_duration)
        rel_x = max(0.0, min(tw, float(x - self.HEADER_WIDTH)))
        return (rel_x / tw) * dur

    # ── Événements Contrôles ──

    def _on_loop_change(self):
        self.model.loop = bool(self.loop_var.get())

    def _on_snap_change(self):
        self.model.snap_to_beat = bool(self.snap_var.get())

    def _on_bpm_change(self):
        try:
            bpm = float(self.bpm_var.get().replace(",", "."))
            self.model.set_bpm(bpm)
            self.bpm_var.set(str(int(self.model.bpm)))
            self.redraw()
            self.app.set_dirty(True)
        except ValueError:
            self.bpm_var.set(str(int(self.model.bpm)))

    def _on_dur_change(self):
        try:
            dur = float(self.dur_var.get().replace(",", "."))
            self.model.set_total_duration(dur)
            self.dur_var.set(f"{self.model.total_duration:.1f}")
            self.redraw()
            self.app.set_dirty(True)
        except ValueError:
            self.dur_var.set(f"{self.model.total_duration:.1f}")

    def on_model_changed(self):
        """Met à jour les contrôles et redessine lors d'un chargement de projet ou undo/redo."""
        self.model = self.app.timeline
        self.loop_var.set(self.model.loop)
        self.snap_var.set(self.model.snap_to_beat)
        self.bpm_var.set(str(int(self.model.bpm)))
        self.dur_var.set(f"{self.model.total_duration:.1f}")
        self._update_canvas_height()
        self.redraw()
        self.update_timecode()

    def _update_canvas_height(self):
        tracks_count = max(3, len(self.model.tracks))
        needed_height = self.RULER_HEIGHT + tracks_count * self.LANE_HEIGHT + 4
        needed_height = min(220, max(110, needed_height))
        self.canvas.config(height=needed_height)

    # ── Gestion des Pistes et Calques ──

    def add_selected_layer_to_timeline(self):
        """Ajoute le calque ou groupe actif à la timeline."""
        target = self.app.get_current_layer()
        if not target:
            if self.app.layers:
                target = self.app.layers[0]
            else:
                self.app.lbl_status.config(text="Aucun calque sélectionné à ajouter à la timeline", fg="#ffb74d")
                return

        track = self.model.add_track_for_layer(
            target.id,
            start_time=0.0,
            duration=min(self.model.bar_duration, self.model.total_duration),
            color=target.color
        )
        self.selected_track_id = track.track_id
        if track.clips:
            self.selected_clip_id = track.clips[0].clip_id

        self._update_canvas_height()
        self.redraw()
        self.app.record_undo_step()
        self.app.set_dirty(True)
        self.app.lbl_status.config(text=f"Ajouté à la timeline : {target.name}", fg="#66bb6a")

    def remove_selected_track(self):
        """Supprime la piste sélectionnée."""
        if self.selected_track_id is None and self.model.tracks:
            self.selected_track_id = self.model.tracks[-1].track_id

        if self.selected_track_id is not None:
            self.model.remove_track(self.selected_track_id)
            self.selected_track_id = self.model.tracks[0].track_id if self.model.tracks else None
            self._update_canvas_height()
            self.redraw()
            self.app.record_undo_step()
            self.app.set_dirty(True)
            self.app.redraw_canvas()
            self.app.update_count()

    def _find_layer_by_id(self, layer_id: int):
        all_l = self.app._get_all_layers_flat()
        for l in all_l:
            if l.id == layer_id:
                return l
        return None

    # ── Moteur de Rendu Graphique (Canvas) ──

    def update_timecode(self):
        self.lbl_timecode.config(text=self.model.format_timecode())

    def redraw(self):
        """Redessine l'ensemble de la timeline : en-têtes, grille BPM, clips et curseur."""
        self.canvas.delete("all")
        w = self.canvas.winfo_width()
        h = self.canvas.winfo_height()
        if w < 10 or h < 10:
            return

        # 1. Fond des pistes
        track_w = self._get_track_width()
        num_lanes = max(3, len(self.model.tracks))

        for idx in range(num_lanes):
            y1 = self.RULER_HEIGHT + idx * self.LANE_HEIGHT
            y2 = y1 + self.LANE_HEIGHT
            stripe_col = "#181818" if idx % 2 == 0 else "#151515"
            self.canvas.create_rectangle(self.HEADER_WIDTH, y1, w, y2, fill=stripe_col, outline="")
            self.canvas.create_line(0, y2, w, y2, fill="#242424")

        # 2. Règle temporelle & Grille calée sur le BPM
        self._draw_bpm_grid(w, h, num_lanes)

        # 3. En-têtes de pistes (colonne gauche)
        self._draw_track_headers(w, h)

        # 4. Blocs de Clips
        self._draw_clips()

        # 5. Tête de lecture (Playhead)
        self._draw_playhead(h)

    def _draw_bpm_grid(self, w: float, h: float, num_lanes: int):
        # Fond Règle supérieure
        self.canvas.create_rectangle(self.HEADER_WIDTH, 0, w, self.RULER_HEIGHT, fill="#1c1c1c", outline="")
        self.canvas.create_line(0, self.RULER_HEIGHT, w, self.RULER_HEIGHT, fill="#383838", width=1)

        beat_dur = self.model.beat_duration
        bar_dur = self.model.bar_duration
        total_dur = self.model.total_duration

        # Lignes verticales de temps & mesures
        total_beats = int(total_dur / beat_dur) + 2
        for b_idx in range(total_beats):
            t = b_idx * beat_dur
            if t > total_dur + 0.001:
                break
            x = self.time_to_x(t)
            is_bar = (b_idx % 4 == 0)

            if is_bar:
                bar_num = (b_idx // 4) + 1
                # Ligne de mesure solide sur toute la hauteur
                self.canvas.create_line(x, self.RULER_HEIGHT, x, h, fill="#383838", width=1.2)
                # Repère et étiquette sur la règle
                self.canvas.create_line(x, 0, x, self.RULER_HEIGHT, fill="#00e5ff", width=1.5)
                self.canvas.create_text(
                    x + 4, 11, text=f"{bar_num}", fill="#00e5ff",
                    font=("Segoe UI", 8, "bold"), anchor=tk.W
                )
            else:
                beat_in_bar = (b_idx % 4) + 1
                # Trait pointillé subtil pour les temps intermédiaires
                self.canvas.create_line(x, self.RULER_HEIGHT, x, h, fill="#222222", dash=(2, 3))
                # Petit cran sur la règle
                self.canvas.create_line(x, self.RULER_HEIGHT - 6, x, self.RULER_HEIGHT, fill="#555555")
                self.canvas.create_text(
                    x + 2, self.RULER_HEIGHT - 8, text=f".{beat_in_bar}",
                    fill="#666666", font=("Segoe UI", 6), anchor=tk.W
                )

    def _draw_track_headers(self, w: float, h: float):
        # Coin supérieur gauche de la règle
        self.canvas.create_rectangle(0, 0, self.HEADER_WIDTH, self.RULER_HEIGHT, fill="#222222", outline="")
        self.canvas.create_text(10, 13, text="PISTES", fill="#888888", font=("Segoe UI", 8, "bold"), anchor=tk.W)

        # Séparateur vertical entre en-têtes et pistes
        self.canvas.create_line(self.HEADER_WIDTH, 0, self.HEADER_WIDTH, h, fill="#383838", width=1.5)

        if not self.model.tracks:
            self.canvas.create_text(
                self.HEADER_WIDTH + 20, self.RULER_HEIGHT + 24,
                text="Aucune piste. Clique sur '⏱+ Ajouter sélection' pour animer un calque ou groupe.",
                fill="#666666", font=("Segoe UI", 8, "italic"), anchor=tk.W
            )
            return

        for idx, track in enumerate(self.model.tracks):
            y1 = self.RULER_HEIGHT + idx * self.LANE_HEIGHT
            y2 = y1 + self.LANE_HEIGHT
            cy = (y1 + y2) / 2

            is_sel = (track.track_id == self.selected_track_id)
            bg_col = "#2a2a2a" if is_sel else "#1f1f1f"
            self.canvas.create_rectangle(0, y1, self.HEADER_WIDTH, y2, fill=bg_col, outline="")

            layer = self._find_layer_by_id(track.layer_id)
            if layer:
                name = layer.name
                col_hex = f"#{layer.color[0]:02x}{layer.color[1]:02x}{layer.color[2]:02x}"
                icon = "📁" if layer.shape_type == "group" else "—"
            else:
                name = f"Calque #{track.layer_id}"
                col_hex = "#888888"
                icon = "•"

            # Pastille de couleur
            self.canvas.create_rectangle(6, cy - 5, 14, cy + 5, fill=col_hex, outline="#000000")

            # Icône et Nom du calque / groupe
            disp_name = (name[:12] + "…") if len(name) > 13 else name
            text_col = "#ffb74d" if is_sel else "#dddddd"
            self.canvas.create_text(18, cy, text=f"{icon} {disp_name}", fill=text_col, font=("Segoe UI", 8), anchor=tk.W)

            # Bouton Mute 'M' (x: 108 à 124)
            m_bg = "#e53935" if track.muted else "#2d2d2d"
            m_fg = "#ffffff" if track.muted else "#777777"
            self.canvas.create_rectangle(108, cy - 8, 126, cy + 8, fill=m_bg, outline="#444444", width=1)
            self.canvas.create_text(117, cy, text="M", fill=m_fg, font=("Segoe UI", 7, "bold"))

            # Bouton Supprimer '✕' (x: 129 à 145)
            self.canvas.create_rectangle(129, cy - 8, 145, cy + 8, fill="#2d2d2d", outline="#444444", width=1)
            self.canvas.create_text(137, cy, text="✕", fill="#aaaaaa", font=("Segoe UI", 7, "bold"))

    def _draw_clips(self):
        for t_idx, track in enumerate(self.model.tracks):
            y1 = self.RULER_HEIGHT + t_idx * self.LANE_HEIGHT
            y2 = y1 + self.LANE_HEIGHT
            top = y1 + 3
            bot = y2 - 3

            layer = self._find_layer_by_id(track.layer_id)
            base_col = layer.color if layer else (0, 255, 128)
            col_hex = f"#{base_col[0]:02x}{base_col[1]:02x}{base_col[2]:02x}"
            name = layer.name if layer else "Clip"

            for clip in track.clips:
                xs = self.time_to_x(clip.start_time)
                xe = self.time_to_x(clip.end_time)
                w = max(4.0, xe - xs)

                is_sel_clip = (clip.clip_id == self.selected_clip_id)
                outline_col = "#ffffff" if is_sel_clip else "#000000"
                outline_w = 2.0 if is_sel_clip else 1.0

                # Corps du bloc clip
                self.canvas.create_rectangle(
                    xs, top, xe, bot, fill=col_hex, outline=outline_col, width=outline_w
                )

                # Poignée gauche de redimensionnement
                if w > 16:
                    self.canvas.create_rectangle(xs, top, xs + self.HANDLE_WIDTH, bot, fill="#ffffff", outline="", stipple="gray25")
                    # Poignée droite de redimensionnement
                    self.canvas.create_rectangle(xe - self.HANDLE_WIDTH, top, xe, bot, fill="#ffffff", outline="", stipple="gray25")

                # Texte descriptif dans le clip
                if w > 35:
                    lbl = f"{name} ({clip.duration:.1f}s)"
                    brightness = (base_col[0] * 299 + base_col[1] * 587 + base_col[2] * 114) / 1000
                    txt_col = "#000000" if brightness > 140 else "#ffffff"
                    self.canvas.create_text(
                        xs + self.HANDLE_WIDTH + 4, (top + bot) / 2,
                        text=lbl, fill=txt_col, font=("Segoe UI", 8, "bold"), anchor=tk.W
                    )

    def _draw_playhead(self, h: float):
        """Dessine la tête de lecture (aiguille) avec le tag 'playhead' pour mise à jour ultra-rapide."""
        self.canvas.delete("playhead")
        x = self.time_to_x(self.model.current_time)

        # Ligne verticale de la tête de lecture
        self.canvas.create_line(x, 0, x, h, fill="#ff3d00", width=2, tags="playhead")

        # Badge triangle / poignée sur la règle
        badge_pts = [
            x - 6, 0,
            x + 6, 0,
            x + 6, self.RULER_HEIGHT - 6,
            x, self.RULER_HEIGHT,
            x - 6, self.RULER_HEIGHT - 6
        ]
        self.canvas.create_polygon(badge_pts, fill="#ff3d00", outline="#ffffff", width=1, tags="playhead")

    def redraw_playhead_only(self):
        """Rafraîchissement optimisé à 60 FPS du curseur uniquement."""
        h = self.canvas.winfo_height()
        self._draw_playhead(h)

    # ── Interactions Souris (Scrubbing, Déplacement, Redimensionnement) ──

    def _on_hover(self, event):
        x, y = event.x, event.y
        if self._drag_mode:
            return

        if x < self.HEADER_WIDTH:
            if y > self.RULER_HEIGHT:
                t_idx = int((y - self.RULER_HEIGHT) // self.LANE_HEIGHT)
                if 0 <= t_idx < len(self.model.tracks):
                    if 108 <= x <= 126 or 129 <= x <= 145:
                        self.canvas.config(cursor="hand2")
                        return
            self.canvas.config(cursor="arrow")
            return

        if y <= self.RULER_HEIGHT:
            self.canvas.config(cursor="hand2")
            return

        # Survol des clips
        t_idx = int((y - self.RULER_HEIGHT) // self.LANE_HEIGHT)
        if 0 <= t_idx < len(self.model.tracks):
            track = self.model.tracks[t_idx]
            for clip in track.clips:
                xs = self.time_to_x(clip.start_time)
                xe = self.time_to_x(clip.end_time)
                if xs <= x <= xe:
                    if x <= xs + self.HANDLE_WIDTH or x >= xe - self.HANDLE_WIDTH:
                        self.canvas.config(cursor="sb_h_double_arrow")
                    else:
                        self.canvas.config(cursor="fleur")
                    return

        self.canvas.config(cursor="crosshair")

    def _on_press(self, event):
        x, y = event.x, event.y

        # 1. Clic dans la zone d'en-tête (gauche)
        if x < self.HEADER_WIDTH:
            if y > self.RULER_HEIGHT:
                t_idx = int((y - self.RULER_HEIGHT) // self.LANE_HEIGHT)
                if 0 <= t_idx < len(self.model.tracks):
                    track = self.model.tracks[t_idx]
                    # Clic sur le bouton Mute 'M'
                    if 108 <= x <= 126:
                        track.muted = not track.muted
                        self.redraw()
                        self.app.redraw_canvas()
                        self.app.update_count()
                        self.app.set_dirty(True)
                        return
                    # Clic sur le bouton Supprimer '✕'
                    elif 129 <= x <= 145:
                        self.selected_track_id = track.track_id
                        self.remove_selected_track()
                        return
                    else:
                        self.selected_track_id = track.track_id
                        self.redraw()
            return

        # 2. Clic sur la règle (haut) -> Scrubbing tête de lecture
        if y <= self.RULER_HEIGHT:
            self._drag_mode = "scrub"
            t = self.x_to_time(x)
            if self.model.snap_to_beat:
                t = self.model.snap_time(t)
            self.model.current_time = t
            self.update_timecode()
            self.redraw_playhead_only()
            self.app.redraw_canvas()
            self.app.update_count()
            if self.app.live_stream_var.get():
                self.app.send_idn(silent=True)
            return

        # 3. Clic dans les pistes de clips
        t_idx = int((y - self.RULER_HEIGHT) // self.LANE_HEIGHT)
        if 0 <= t_idx < len(self.model.tracks):
            track = self.model.tracks[t_idx]
            self.selected_track_id = track.track_id

            for clip in track.clips:
                xs = self.time_to_x(clip.start_time)
                xe = self.time_to_x(clip.end_time)
                if xs <= x <= xe:
                    self.selected_clip_id = clip.clip_id
                    self._drag_clip = clip
                    self._drag_start_x = x
                    self._drag_orig_start = clip.start_time
                    self._drag_orig_dur = clip.duration

                    if x <= xs + self.HANDLE_WIDTH:
                        self._drag_mode = "resize_left"
                    elif x >= xe - self.HANDLE_WIDTH:
                        self._drag_mode = "resize_right"
                    else:
                        self._drag_mode = "move_clip"
                    self.redraw()
                    return

        # Clic dans une zone vide de piste -> Déplacer la tête de lecture
        self._drag_mode = "scrub"
        t = self.x_to_time(x)
        if self.model.snap_to_beat:
            t = self.model.snap_time(t)
        self.model.current_time = t
        self.update_timecode()
        self.redraw_playhead_only()
        self.app.redraw_canvas()
        self.app.update_count()
        if self.app.live_stream_var.get():
            self.app.send_idn(silent=True)

    def _on_motion(self, event):
        x = event.x
        if not self._drag_mode:
            return

        track_w = self._get_track_width()
        total_dur = self.model.total_duration

        if self._drag_mode == "scrub":
            t = self.x_to_time(x)
            if self.model.snap_to_beat:
                t = self.model.snap_time(t)
            self.model.current_time = t
            self.update_timecode()
            self.redraw_playhead_only()
            self.app.redraw_canvas()
            self.app.update_count()
            if self.app.live_stream_var.get():
                self.app.send_idn(silent=True)

        elif self._drag_mode == "move_clip" and self._drag_clip:
            delta_px = x - self._drag_start_x
            delta_t = (delta_px / track_w) * total_dur
            new_start = self._drag_orig_start + delta_t
            if self.model.snap_to_beat:
                new_start = self.model.snap_time(new_start)
            new_start = max(0.0, min(total_dur - self._drag_clip.duration, new_start))
            self._drag_clip.start_time = new_start
            self.redraw()
            self.app.redraw_canvas()
            self.app.update_count()
            if self.app.live_stream_var.get():
                self.app.send_idn(silent=True)

        elif self._drag_mode == "resize_right" and self._drag_clip:
            delta_px = x - self._drag_start_x
            delta_t = (delta_px / track_w) * total_dur
            new_end = self._drag_orig_start + self._drag_orig_dur + delta_t
            if self.model.snap_to_beat:
                new_end = self.model.snap_time(new_end)
            new_dur = max(0.1, new_end - self._drag_orig_start)
            if self._drag_orig_start + new_dur > total_dur:
                new_dur = total_dur - self._drag_orig_start
            self._drag_clip.duration = new_dur
            self.redraw()
            self.app.redraw_canvas()
            self.app.update_count()
            if self.app.live_stream_var.get():
                self.app.send_idn(silent=True)

        elif self._drag_mode == "resize_left" and self._drag_clip:
            delta_px = x - self._drag_start_x
            delta_t = (delta_px / track_w) * total_dur
            new_start = self._drag_orig_start + delta_t
            if self.model.snap_to_beat:
                new_start = self.model.snap_time(new_start)
            orig_end = self._drag_orig_start + self._drag_orig_dur
            new_start = max(0.0, min(orig_end - 0.1, new_start))
            self._drag_clip.start_time = new_start
            self._drag_clip.duration = orig_end - new_start
            self.redraw()
            self.app.redraw_canvas()
            self.app.update_count()
            if self.app.live_stream_var.get():
                self.app.send_idn(silent=True)

    def _on_release(self, _event):
        if self._drag_mode in ("move_clip", "resize_left", "resize_right"):
            self.app.record_undo_step()
            self.app.set_dirty(True)

        self._drag_mode = None
        self._drag_clip = None

    # ── Moteur de Lecture (Transport Engine) ──

    def toggle_play(self):
        """Démarre ou met en pause la lecture."""
        if self.model.is_playing:
            self.pause()
        else:
            self.play()

    def play(self):
        if self.model.is_playing:
            return
        if self.model.current_time >= self.model.total_duration:
            self.model.current_time = 0.0

        self.model.is_playing = True
        self._last_perf_time = time.perf_counter()
        self.btn_play.config(text="❚❚ Pause", bg="#e65100")
        self._playback_step()

    def pause(self):
        self.model.is_playing = False
        self.btn_play.config(text="▶ Play", bg="#00897b")

    def rewind(self):
        """Arrête la lecture et replace la tête de lecture à 0.0s."""
        self.pause()
        self.model.current_time = 0.0
        self.update_timecode()
        self.redraw_playhead_only()
        self.app.redraw_canvas()
        self.app.update_count()
        if self.app.live_stream_var.get():
            self.app.send_idn(silent=True)

    def _playback_step(self):
        if not self.model.is_playing:
            return

        now = time.perf_counter()
        dt = now - self._last_perf_time
        self._last_perf_time = now

        new_t = self.model.current_time + dt
        if new_t >= self.model.total_duration:
            if self.model.loop:
                new_t = new_t % self.model.total_duration
            else:
                new_t = self.model.total_duration
                self.pause()

        self.model.current_time = new_t
        self.update_timecode()
        self.redraw_playhead_only()
        self.app.redraw_canvas()
        self.app.update_count()

        if self.app.live_stream_var.get():
            self.app.send_idn(silent=True)

        if self.model.is_playing:
            self.after(16, self._playback_step)
