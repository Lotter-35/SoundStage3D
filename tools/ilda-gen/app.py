import math
import os
import socket
import time
import tkinter as tk
from tkinter import simpledialog

try:
    from .core.constants import CANVAS_SIZE
    from .core.geometry import norm_to_canvas, canvas_to_norm
    from .core.transform import Transform2D
    from .core.layer import Layer
    from .core.timeline import TimelineModel, TimelineTrack, TimelineClip
    from .core.custom_shapes import (
        create_square_shape,
        create_triangle_shape,
        create_star_shape,
        load_user_custom_shapes,
        save_user_custom_shapes,
        instantiate_custom_template,
    )
    from .core.grid import snap_polar as core_snap_polar
    from .core.symmetry import get_sym_mode_info, compute_symmetry

    from .ui.styles import setup_dpi_awareness
    from .ui.undo_mixin import UndoClipboardMixin
    from .ui.project_mixin import ProjectManagerMixin
    from .ui.listbox_mixin import LayerListboxMixin
    from .ui.canvas_render_mixin import CanvasRenderMixin
    from .ui.canvas_events_mixin import CanvasEventsMixin
    from .ui.network_mixin import NetworkIdnMixin
    from .ui.timeline_widget import TimelineWidget
except (ImportError, ValueError):
    from core.constants import CANVAS_SIZE
    from core.geometry import norm_to_canvas, canvas_to_norm
    from core.transform import Transform2D
    from core.layer import Layer
    from core.timeline import TimelineModel, TimelineTrack, TimelineClip
    from core.custom_shapes import (
        create_square_shape,
        create_triangle_shape,
        create_star_shape,
        load_user_custom_shapes,
        save_user_custom_shapes,
        instantiate_custom_template,
    )
    from core.grid import snap_polar as core_snap_polar
    from core.symmetry import get_sym_mode_info, compute_symmetry

    from ui.styles import setup_dpi_awareness
    from ui.undo_mixin import UndoClipboardMixin
    from ui.project_mixin import ProjectManagerMixin
    from ui.listbox_mixin import LayerListboxMixin
    from ui.canvas_render_mixin import CanvasRenderMixin
    from ui.canvas_events_mixin import CanvasEventsMixin
    from ui.network_mixin import NetworkIdnMixin
    from ui.timeline_widget import TimelineWidget


class IDNGeneratorApp(
    ProjectManagerMixin,
    UndoClipboardMixin,
    LayerListboxMixin,
    CanvasRenderMixin,
    CanvasEventsMixin,
    NetworkIdnMixin,
):
    """Application principale ILDA Generator Studio."""

    def __init__(self, root: tk.Tk):
        setup_dpi_awareness()
        self.root = root
        self.root.title("Générateur IDN — SoundStage3D (UDP 7255)")
        self.root.configure(bg="#1e1e1e")
        self.root.resizable(True, True)
        self.root.minsize(960, 780)
        self.root.geometry("1020x840")

        self.timeline = TimelineModel()
        self.user_custom_shapes = load_user_custom_shapes()

        self.layers: list[Layer] = []
        self.selected_idx: int = -1
        self.selected_layer: Layer | None = None
        self.selected_layers: set[Layer] = set()
        self.layer_counter: int = 0
        self.sequence_num = 0
        self.t0 = time.perf_counter()

        self.selected_indices: set[int] = set()
        self._listbox_items_map: list[tuple[Layer, Layer | None, int]] = []

        # État des touches modificatrices (Shift, Alt, Ctrl)
        self.key_shift_pressed = False
        self.key_ctrl_pressed = False
        self.key_alt_pressed = False

        # Outil actif ("select" ou "pencil") et Couleur courante
        self.current_tool: str = "select"
        self.current_color: tuple[int, int, int] = (0, 255, 128)
        self._draw_start_cx: float = 0.0
        self._draw_start_cy: float = 0.0
        self._draw_points: list[tuple[float, float]] = []
        self._draw_moved: bool = False
        self._draw_had_shift: bool = False
        self._draw_last_snap: tuple[float, float] = (0.0, 0.0)
        self._pencil_hover_pt: tuple[float, float, float, float] | None = None
        self._last_mouse_cx: float = CANVAS_SIZE / 2.0
        self._last_mouse_cy: float = CANVAS_SIZE / 2.0

        # Interaction souris
        self._drag_mode: str | None = None  # "move", "scale", "rotate" ou "pencil"
        self._drag_handle_name: str = ""
        self._drag_handle_pos: tuple[float, float] = (0.0, 0.0)
        self._drag_start_cx: float = 0.0
        self._drag_start_cy: float = 0.0
        self._drag_orig_x: float = 0.0
        self._drag_orig_y: float = 0.0
        self._drag_box_w: float = 100.0
        self._drag_box_h: float = 100.0
        self._drag_orig_scale_x: float = 1.0
        self._drag_orig_scale_y: float = 1.0
        self._drag_orig_rot: float = 0.0
        self._drag_orig_angle: float = 0.0
        self._duplicated_during_drag: bool = False
        self._snap_guide_x: bool = False
        self._snap_guide_y: bool = False

        # Mode Miroir / Symétrie configurable
        self.sym_mode_var = tk.StringVar(value="Désactivé")
        self.sym_cx: float = 0.0
        self.sym_cy: float = 0.0
        self._sym_move_mode_active: bool = False

        # Type de grille (Cartésienne ou Polaire 30°)
        self.grid_type_var = tk.StringVar(value="cartesian")

        self.udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            self.udp_sock.setblocking(False)
        except Exception:
            pass
        self._redraw_pending: bool = False

        # Zoom et Pan du Canvas (Vue interactive)
        self.view_zoom: float = 1.0
        self.view_pan_x: float = 0.0
        self.view_pan_y: float = 0.0
        self._pan_start_x: float = 0.0
        self._pan_start_y: float = 0.0
        self._pan_orig_x: float = 0.0
        self._pan_orig_y: float = 0.0

        # Système Annuler / Rétablir (Undo / Redo) & Presse-papier (Ctrl+C, Ctrl+V, Ctrl+Z)
        self.undo_stack: list[dict] = []
        self.redo_stack: list[dict] = []
        self._max_undo: int = 50
        self._pre_drag_snapshot: dict | None = None
        self.clipboard_layer: Layer | None = None
        self.clipboard_layers: list[Layer] = []

        # Gestion de projet (Sauvegarde / Chargement de l'état du travail & Sauvegarde automatique)
        self.current_project_file: str | None = None
        self.is_dirty: bool = False
        self.autosave_enabled: bool = True
        self.autosave_var = tk.BooleanVar(value=True)
        self._autosave_timer: str | None = None
        self.last_autosave_time: float = 0.0

        self._build_ui()
        self._bind_shortcuts()

        # Forme de départ par défaut
        self.import_line()
        self.undo_stack.clear()
        self.redo_stack.clear()
        self.is_dirty = False
        self._update_window_title()
        self._update_proj_bar_ui()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close_window)

        self._live_tick()

    def norm_to_canvas(self, wx: float, wy: float) -> tuple[float, float]:
        """Convertit coordonnées normalisées (-1.0 à +1.0) en coordonnées canvas pixels selon zoom et pan."""
        return norm_to_canvas(wx, wy, self.view_zoom, self.view_pan_x, self.view_pan_y)

    def canvas_to_norm(self, cx: float, cy: float) -> tuple[float, float]:
        """Convertit coordonnées canvas pixels en coordonnées normalisées (-1.0 à +1.0) selon zoom et pan."""
        return canvas_to_norm(cx, cy, self.view_zoom, self.view_pan_x, self.view_pan_y)

    def is_layer_active_for_render(self, layer) -> bool:
        """Indique si le calque ou groupe doit être affiché/streamé selon la timeline active."""
        if not hasattr(self, "timeline"):
            return True
        return self.timeline.is_layer_active(layer, self.layers)

    def _build_ui(self):
        # 0. Menu Supérieur (Fichier, Édition)
        menubar = tk.Menu(self.root)
        file_menu = tk.Menu(menubar, tearoff=0, bg="#252526", fg="#ffffff", activebackground="#007acc", activeforeground="#ffffff")
        file_menu.add_command(label="Nouveau projet", accelerator="Ctrl+N", command=self.new_project)
        file_menu.add_command(label="Ouvrir un projet...", accelerator="Ctrl+O", command=self.open_project)
        file_menu.add_separator()
        file_menu.add_command(label="Enregistrer le projet", accelerator="Ctrl+S", command=self.save_project)
        file_menu.add_command(label="Enregistrer sous...", accelerator="Ctrl+Shift+S", command=self.save_project_as)
        file_menu.add_checkbutton(label="Sauvegarde automatique", command=self.toggle_autosave, variable=self.autosave_var)
        file_menu.add_separator()
        file_menu.add_command(label="Quitter", command=self._on_close_window)
        menubar.add_cascade(label="Fichier", menu=file_menu)

        edit_menu = tk.Menu(menubar, tearoff=0, bg="#252526", fg="#ffffff", activebackground="#007acc", activeforeground="#ffffff")
        edit_menu.add_command(label="Annuler", accelerator="Ctrl+Z", command=self.undo)
        edit_menu.add_command(label="Rétablir", accelerator="Ctrl+Y", command=self.redo)
        edit_menu.add_separator()
        edit_menu.add_command(label="Copier", accelerator="Ctrl+C", command=self.copy_selected_layer)
        edit_menu.add_command(label="Couper", accelerator="Ctrl+X", command=self.cut_selected_layer)
        edit_menu.add_command(label="Coller", accelerator="Ctrl+V", command=self.paste_layer)
        edit_menu.add_separator()
        edit_menu.add_command(label="Tout sélectionner", accelerator="Ctrl+A", command=self.select_all_visible_layers)
        edit_menu.add_command(label="Grouper", accelerator="Ctrl+G", command=self.group_selected_layers)
        edit_menu.add_command(label="Dégrouper", accelerator="Ctrl+Shift+G", command=self.ungroup_selected_layer)
        edit_menu.add_command(label="Nouveau groupe vide", accelerator="Ctrl+Shift+N", command=self.create_empty_group)
        menubar.add_cascade(label="Édition", menu=edit_menu)

        self.root.config(menu=menubar)

        # 1. Barre Réseau & État supérieure (envoi IDN vers le jeu et statut du projet)
        net_bar = tk.Frame(self.root, bg="#181818", padx=10, pady=6)
        net_bar.pack(side=tk.TOP, fill=tk.X)

        def field(label, width, value):
            tk.Label(net_bar, text=label, fg="#aaaaaa", bg="#181818").pack(side=tk.LEFT, padx=2)
            e = tk.Entry(net_bar, width=width, bg="#2a2a2a", fg="#ffffff", relief=tk.FLAT, insertbackground="#ffffff")
            e.insert(0, value)
            e.pack(side=tk.LEFT, padx=3)
            return e

        self.entry_host = field("IP :", 12, "127.0.0.1")
        self.entry_port = field("Port :", 6, "7255")
        self.entry_channel = field("Canal :", 3, "1")
        self.entry_kpps = field("kpps :", 3, "30")

        self.live_stream_var = tk.BooleanVar(value=True)
        tk.Checkbutton(
            net_bar, text="Envoi live", variable=self.live_stream_var,
            bg="#181818", fg="#dddddd", selectcolor="#2a2a2a", activebackground="#181818",
        ).pack(side=tk.LEFT, padx=8)

        self.show_grid_var = tk.BooleanVar(value=True)
        tk.Checkbutton(
            net_bar, text="Grille", variable=self.show_grid_var, command=self.redraw_canvas,
            bg="#181818", fg="#dddddd", selectcolor="#2a2a2a", activebackground="#181818",
        ).pack(side=tk.LEFT, padx=(6, 2))

        self.btn_grid_toggle = tk.Button(
            net_bar, text="▦ Cartésienne", command=self.toggle_grid_type,
            bg="#2a2a2a", fg="#00e5ff", activebackground="#3a3a3a", activeforeground="#ffffff",
            relief=tk.FLAT, padx=6, pady=1, font=("Segoe UI", 8, "bold"), cursor="hand2"
        )
        self.btn_grid_toggle.pack(side=tk.LEFT, padx=(2, 6))

        tk.Frame(net_bar, bg="#333333", width=1, height=16).pack(side=tk.LEFT, padx=8)

        self.lbl_project_name = tk.Label(
            net_bar, text="Projet : Sans titre", fg="#00e5ff", bg="#181818", font=("Segoe UI", 8, "bold")
        )
        self.lbl_project_name.pack(side=tk.LEFT, padx=4)

        self.lbl_autosave = tk.Label(
            net_bar, text="⚡ Auto-save ON", fg="#81c784", bg="#181818", font=("Segoe UI", 8)
        )
        self.lbl_autosave.pack(side=tk.LEFT, padx=6)

        # 2. Zone principale : Gauche (Formes) | Centre (Preview) | Droite (Calques)
        main_frame = tk.Frame(self.root, bg="#1e1e1e")
        main_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=6)

        # ── Panneau Gauche : Outils & Formes de base ──
        left_panel = tk.Frame(main_frame, bg="#252526", width=180, padx=8, pady=8)
        left_panel.pack(side=tk.LEFT, fill=tk.Y, padx=(0, 8))
        left_panel.pack_propagate(False)

        tk.Label(left_panel, text="Outils", fg="#cccccc", bg="#252526", font=("Segoe UI", 9, "bold")).pack(anchor=tk.W, pady=(0, 4))

        self.btn_tool_select = tk.Button(
            left_panel, text="Sélection (V)", command=lambda: self.set_tool("select"),
            bg="#00897b", fg="#ffffff", activebackground="#00796b", activeforeground="#ffffff",
            relief=tk.FLAT, pady=5
        )
        self.btn_tool_select.pack(fill=tk.X, pady=2)

        self.btn_tool_pencil = tk.Button(
            left_panel, text="Crayon / Point (P)", command=lambda: self.set_tool("pencil"),
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=5
        )
        self.btn_tool_pencil.pack(fill=tk.X, pady=2)

        tk.Frame(left_panel, height=1, bg="#383838").pack(fill=tk.X, pady=6)

        tk.Label(left_panel, text="Formes de base", fg="#cccccc", bg="#252526", font=("Segoe UI", 9, "bold")).pack(anchor=tk.W, pady=(0, 4))

        btn_line = tk.Button(
            left_panel, text="Ligne", command=self.import_line,
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=5
        )
        btn_line.pack(fill=tk.X, pady=2)

        btn_circle = tk.Button(
            left_panel, text="Cercle", command=self.import_circle,
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=5
        )
        btn_circle.pack(fill=tk.X, pady=2)

        tk.Frame(left_panel, height=1, bg="#383838").pack(fill=tk.X, pady=5)

        # ── Formes personnalisées (Formes liées éditables) ──
        tk.Label(left_panel, text="Formes personnalisées", fg="#00e5ff", bg="#252526", font=("Segoe UI", 9, "bold")).pack(anchor=tk.W, pady=(0, 2))

        self.custom_shapes_frame = tk.Frame(left_panel, bg="#252526")
        self.custom_shapes_frame.pack(fill=tk.X)
        self._build_custom_shapes_buttons()

        tk.Frame(left_panel, height=1, bg="#383838").pack(fill=tk.X, pady=5)

        # ── Mode Miroir / Symétrie ──
        tk.Label(left_panel, text="Mode Miroir", fg="#ffb74d", bg="#252526", font=("Segoe UI", 9, "bold")).pack(anchor=tk.W, pady=(0, 2))

        self.opt_sym = tk.OptionMenu(
            left_panel, self.sym_mode_var,
            "Désactivé",
            "x2 Gauche / Droite",
            "x2 Haut / Bas",
            "x4 Croix (X & Y)",
            "x3 Radial (120°)",
            "x4 Radial (90°)",
            "x5 Radial (72°)",
            "x6 Radial (60°)",
            "x8 Radial (45°)",
            "x12 Radial (30°)",
            command=self._on_sym_mode_change
        )
        self.opt_sym.config(bg="#333333", fg="#ffb74d", activebackground="#444444", activeforeground="#ffffff", relief=tk.FLAT, font=("Segoe UI", 8), highlightthickness=0)
        self.opt_sym["menu"].config(bg="#252526", fg="#ffffff", activebackground="#007acc")
        self.opt_sym.pack(fill=tk.X, pady=2)

        self.lbl_sym_coords = tk.Label(left_panel, text="Axe : (0.00, 0.00)", fg="#aaaaaa", bg="#252526", font=("Segoe UI", 8))
        self.lbl_sym_coords.pack(anchor=tk.W, pady=1)

        self.btn_sym_apply = tk.Button(
            left_panel, text="⇋ Symétriser sélec", command=self.apply_symmetry_to_selection,
            bg="#333333", fg="#ffb74d", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=3, font=("Segoe UI", 8, "bold")
        )
        self.btn_sym_apply.pack(fill=tk.X, pady=(4, 1))

        # ── Panneau Droite : Calques ──
        right_panel = tk.Frame(main_frame, bg="#252526", width=180, padx=8, pady=8)
        right_panel.pack(side=tk.RIGHT, fill=tk.Y, padx=(8, 0))
        right_panel.pack_propagate(False)

        calques_header = tk.Frame(right_panel, bg="#252526")
        calques_header.pack(fill=tk.X, pady=(0, 6))
        tk.Label(calques_header, text="Calques", fg="#cccccc", bg="#252526", font=("Segoe UI", 9, "bold")).pack(side=tk.LEFT)
        self.btn_header_new_grp = tk.Button(
            calques_header, text="📁+ Dossier", command=self.create_empty_group,
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, padx=6, pady=1, font=("Segoe UI", 8), cursor="hand2"
        )
        self.btn_header_new_grp.pack(side=tk.RIGHT)

        self.layer_listbox = tk.Listbox(
            right_panel, bg="#1e1e1e", fg="#ffffff", selectbackground="#007acc", selectforeground="#ffffff",
            relief=tk.FLAT, highlightthickness=0, font=("Segoe UI", 9), selectmode=tk.EXTENDED,
            activestyle="none"
        )
        self.layer_listbox.pack(fill=tk.BOTH, expand=True)

        # Ligne indicatrice visuelle pour le glisser-déposer de calques (drag & drop landing line)
        self._lb_drop_line = tk.Frame(self.layer_listbox, bg="#00e5ff", height=2)

        # Cadre rectangle de sélection pour la liste des calques (marquee selection box)
        self._lb_mq_top = tk.Frame(self.layer_listbox, bg="#00e5ff", height=1)
        self._lb_mq_bottom = tk.Frame(self.layer_listbox, bg="#00e5ff", height=1)
        self._lb_mq_left = tk.Frame(self.layer_listbox, bg="#00e5ff", width=1)
        self._lb_mq_right = tk.Frame(self.layer_listbox, bg="#00e5ff", width=1)

        self.layer_listbox.bind("<Button-1>", self._on_listbox_press)
        self.layer_listbox.bind("<B1-Motion>", self._on_listbox_motion)
        self.layer_listbox.bind("<ButtonRelease-1>", self._on_listbox_release)
        self.layer_listbox.bind("<Leave>", self._on_listbox_leave)
        self.layer_listbox.bind("<MouseWheel>", lambda e: self.layer_listbox.yview_scroll(int(-1 * (e.delta / 120)), "units"))
        self.layer_listbox.bind("<<ListboxSelect>>", self._on_listbox_select)
        self.layer_listbox.bind("<Button-3>", self._on_listbox_right_click)
        self.layer_listbox.bind("<Double-Button-1>", self._on_listbox_double_click)
        self.layer_listbox.bind("<Triple-Button-1>", self._on_listbox_triple_click)

        btn_box = tk.Frame(right_panel, bg="#252526")
        btn_box.pack(fill=tk.X, pady=(6, 0))

        self.btn_new_group = tk.Button(
            btn_box, text="📁+ Nouveau groupe vide", command=self.create_empty_group,
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=4, font=("Segoe UI", 8)
        )
        self.btn_new_group.pack(fill=tk.X, pady=1)

        self.btn_group = tk.Button(
            btn_box, text="📁 Grouper (Ctrl+G)", command=self.group_selected_layers,
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=4, font=("Segoe UI", 8, "bold")
        )
        self.btn_group.pack(fill=tk.X, pady=1)

        self.btn_ungroup = tk.Button(
            btn_box, text="📂 Dégrouper (Ctrl+Shift+G)", command=self.ungroup_selected_layer,
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=4, font=("Segoe UI", 8)
        )
        self.btn_ungroup.pack(fill=tk.X, pady=1)

        self.btn_timeline_add = tk.Button(
            btn_box, text="⏱+ Ajouter à la timeline", command=self.add_layer_to_timeline,
            bg="#333333", fg="#00e5ff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=4, font=("Segoe UI", 8, "bold")
        )
        self.btn_timeline_add.pack(fill=tk.X, pady=1)

        self.btn_lock_group = tk.Button(
            btn_box, text="🔒 Lier / Délier en forme", command=self.toggle_lock_group,
            bg="#333333", fg="#ffb74d", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=4, font=("Segoe UI", 8, "bold")
        )
        self.btn_lock_group.pack(fill=tk.X, pady=(1, 1))

        # ── Panneau Centre : Visualisateur interactif (parfaitement centré) ──
        center_panel = tk.Frame(main_frame, bg="#1e1e1e")
        center_panel.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

        self.canvas = tk.Canvas(
            center_panel, width=CANVAS_SIZE, height=CANVAS_SIZE,
            bg="#000000", cursor="crosshair", highlightthickness=1, highlightbackground="#333333"
        )
        self.canvas.pack(expand=True)

        self.canvas.bind("<Button-1>", self._on_canvas_press)
        self.canvas.bind("<B1-Motion>", self._on_canvas_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_canvas_release)
        self.canvas.bind("<Double-Button-1>", self._on_canvas_double_click)
        self.canvas.bind("<Motion>", self._on_canvas_motion)
        self.canvas.bind("<Leave>", self._on_canvas_leave)
        self.canvas.bind("<MouseWheel>", self._on_mouse_wheel)
        self.canvas.bind("<Button-4>", lambda e: self._on_mouse_wheel_step(1, e.x, e.y))
        self.canvas.bind("<Button-5>", lambda e: self._on_mouse_wheel_step(-1, e.x, e.y))

        # Pan de la vue (Clic milieu ou Clic droit)
        self.canvas.bind("<Button-2>", self._on_pan_press)
        self.canvas.bind("<B2-Motion>", self._on_pan_drag)
        self.canvas.bind("<ButtonRelease-2>", self._on_pan_release)

        self.canvas.bind("<Button-3>", self._on_pan_press)
        self.canvas.bind("<B3-Motion>", self._on_pan_drag)
        self.canvas.bind("<ButtonRelease-3>", self._on_pan_release)
        self.canvas.bind("<Double-Button-3>", lambda e: self.reset_zoom())

        # 3. Barre Inférieure (Points, Statut & Envoi IDN)
        bot_bar = tk.Frame(self.root, bg="#2a2a2a", padx=10, pady=6)
        bot_bar.pack(side=tk.BOTTOM, fill=tk.X)
        self.lbl_points = tk.Label(bot_bar, text="Points : 0", fg="#888888", bg="#2a2a2a")
        self.lbl_points.pack(side=tk.LEFT, padx=5)

        tk.Frame(bot_bar, bg="#444444", width=1, height=16).pack(side=tk.LEFT, padx=10)

        self.lbl_status = tk.Label(bot_bar, text="Prêt", fg="#66bb6a", bg="#2a2a2a", font=("Segoe UI", 9))
        self.lbl_status.pack(side=tk.LEFT, padx=5)

        tk.Button(
            bot_bar, text="Envoyer en IDN (UDP)", command=self.send_idn,
            bg="#00897b", fg="#ffffff", font=("Segoe UI", 9, "bold"), relief=tk.FLAT, padx=12,
        ).pack(side=tk.RIGHT, padx=5)

        # 4. Timeline musicale DAW (sur toute la largeur)
        self.timeline_widget = TimelineWidget(self.root, self)
        self.timeline_widget.pack(side=tk.BOTTOM, fill=tk.X, padx=10, pady=(0, 4))

    def _bind_shortcuts(self):
        """Raccourcis clavier avec gestion des touches modificatrices."""
        self.root.bind("<FocusIn>", self._reset_modifier_keys)
        self.root.bind("<FocusOut>", self._reset_modifier_keys)

        for k in ("Shift_L", "Shift_R"):
            self.root.bind(f"<KeyPress-{k}>", self._on_shift_press)
            self.root.bind(f"<KeyRelease-{k}>", self._on_shift_release)
        for k in ("Control_L", "Control_R"):
            self.root.bind(f"<KeyPress-{k}>", lambda e: setattr(self, "key_ctrl_pressed", True))
            self.root.bind(f"<KeyRelease-{k}>", lambda e: setattr(self, "key_ctrl_pressed", False))
        for k in ("Alt_L", "Alt_R"):
            self.root.bind(f"<KeyPress-{k}>", lambda e: setattr(self, "key_alt_pressed", True))
            self.root.bind(f"<KeyRelease-{k}>", lambda e: setattr(self, "key_alt_pressed", False))

        # Raccourcis Presse-papier, Annuler / Rétablir, Grouper & Sélection
        for w in (self.root, self.canvas, self.layer_listbox):
            for k in ("a", "A"):
                w.bind(f"<Control-{k}>", self.select_all_visible_layers)
                w.bind(f"<Control-Key-{k}>", self.select_all_visible_layers)
            for k in ("c", "C"):
                w.bind(f"<Control-{k}>", self.copy_selected_layer)
                w.bind(f"<Control-Key-{k}>", self.copy_selected_layer)
            for k in ("x", "X"):
                w.bind(f"<Control-{k}>", self.cut_selected_layer)
                w.bind(f"<Control-Key-{k}>", self.cut_selected_layer)
            for k in ("v", "V"):
                w.bind(f"<Control-{k}>", self.paste_layer)
                w.bind(f"<Control-Key-{k}>", self.paste_layer)
            for k in ("z", "Z"):
                w.bind(f"<Control-{k}>", self.undo)
                w.bind(f"<Control-Key-{k}>", self.undo)
            for k in ("y", "Y"):
                w.bind(f"<Control-{k}>", self.redo)
                w.bind(f"<Control-Key-{k}>", self.redo)
            for k in ("z", "Z"):
                w.bind(f"<Control-Shift-{k}>", self.redo)
                w.bind(f"<Control-Shift-Key-{k}>", self.redo)
            for k in ("g", "G"):
                w.bind(f"<Control-{k}>", self.group_selected_layers)
                w.bind(f"<Control-Key-{k}>", self.group_selected_layers)
                w.bind(f"<Control-Shift-{k}>", self.ungroup_selected_layer)
                w.bind(f"<Control-Shift-Key-{k}>", self.ungroup_selected_layer)
            for k in ("s", "S"):
                w.bind(f"<Control-{k}>", self._on_key_ctrl_s)
                w.bind(f"<Control-Key-{k}>", self._on_key_ctrl_s)
                w.bind(f"<Control-Shift-{k}>", self.save_project_as)
                w.bind(f"<Control-Shift-Key-{k}>", self.save_project_as)
            for k in ("o", "O"):
                w.bind(f"<Control-{k}>", self.open_project)
                w.bind(f"<Control-Key-{k}>", self.open_project)
            for k in ("n", "N"):
                w.bind(f"<Control-{k}>", self._on_key_ctrl_n)
                w.bind(f"<Control-Key-{k}>", self._on_key_ctrl_n)
                w.bind(f"<Control-Shift-{k}>", self.create_empty_group)
                w.bind(f"<Control-Shift-Key-{k}>", self.create_empty_group)
            for k in ("u", "U"):
                w.bind(f"<Control-{k}>", self.ungroup_selected_layer)
                w.bind(f"<Control-Key-{k}>", self.ungroup_selected_layer)

        self.layer_listbox.bind("<Delete>", lambda e: self.delete_selected_layer(e))
        self.layer_listbox.bind("<BackSpace>", lambda e: self.delete_selected_layer(e))

        self.root.bind("<Key-c>", self.center_selected_layer)
        self.root.bind("<Key-C>", self.center_selected_layer)
        self.root.bind("<plus>", lambda e: self.scale_selected_layer(1.1, e))
        self.root.bind("<equal>", lambda e: self.scale_selected_layer(1.1, e))
        self.root.bind("<KP_Add>", lambda e: self.scale_selected_layer(1.1, e))
        self.root.bind("<minus>", lambda e: self.scale_selected_layer(0.9, e))
        self.root.bind("<underscore>", lambda e: self.scale_selected_layer(0.9, e))
        self.root.bind("<KP_Subtract>", lambda e: self.scale_selected_layer(0.9, e))
        self.root.bind("<Key-r>", lambda e: self.rotate_selected_layer(15.0, e))
        self.root.bind("<Key-R>", lambda e: self.rotate_selected_layer(-15.0, e))
        self.root.bind("<Delete>", lambda e: self.delete_selected_layer(e))
        self.root.bind("<BackSpace>", lambda e: self.delete_selected_layer(e))
        self.root.bind("<Left>", lambda e: self.nudge_selected_layer(-0.02, 0.0, e))
        self.root.bind("<Right>", lambda e: self.nudge_selected_layer(0.02, 0.0, e))
        self.root.bind("<Up>", lambda e: self.nudge_selected_layer(0.0, 0.02, e))
        self.root.bind("<Down>", lambda e: self.nudge_selected_layer(0.0, -0.02, e))
        self.root.bind("<Key-g>", lambda e: self.toggle_grid())
        self.root.bind("<Shift-Key-g>", lambda e: self.toggle_grid_type())
        self.root.bind("<Shift-Key-G>", lambda e: self.toggle_grid_type())
        self.root.bind("<Key-m>", lambda e: self.cycle_sym_mode())
        self.root.bind("<Key-M>", lambda e: self.cycle_sym_mode())
        self.root.bind("<Key-0>", lambda e: self.reset_zoom())
        self.root.bind("<Key-z>", lambda e: self.zoom_step(1.2, e))
        self.root.bind("<Key-Z>", lambda e: self.zoom_step(0.8, e))

        def _safe_action(action_fn, e):
            if isinstance(getattr(e, "widget", None), tk.Entry):
                return
            action_fn(event=e)

        def _safe_tool(tool_name, e):
            if isinstance(getattr(e, "widget", None), tk.Entry):
                return
            self.set_tool(tool_name)

        def _on_space(e):
            if isinstance(getattr(e, "widget", None), (tk.Entry, tk.Spinbox)):
                return
            if hasattr(self, "timeline_widget"):
                self.timeline_widget.toggle_play()
                return "break"

        def _on_rewind(e):
            if isinstance(getattr(e, "widget", None), (tk.Entry, tk.Spinbox)):
                return
            if hasattr(self, "timeline_widget"):
                self.timeline_widget.rewind()
                return "break"

        self.root.bind("<space>", _on_space)
        self.canvas.bind("<space>", _on_space)
        self.root.bind("<Home>", _on_rewind)

        self.root.bind("<Key-v>", lambda e: _safe_tool("select", e))
        self.root.bind("<Key-V>", lambda e: _safe_tool("select", e))
        self.root.bind("<Key-p>", lambda e: _safe_tool("pencil", e))
        self.root.bind("<Key-P>", lambda e: _safe_tool("pencil", e))
        self.root.bind("<Key-b>", lambda e: _safe_tool("pencil", e))
        self.root.bind("<Key-B>", lambda e: _safe_tool("pencil", e))

        def _on_escape(e):
            if isinstance(getattr(e, "widget", None), tk.Entry):
                return
            if getattr(self, "_sym_move_mode_active", False):
                self.toggle_sym_move_mode()
            elif self.current_tool == "pencil":
                self.set_tool("select")
            else:
                self.reset_zoom()

        self.root.bind("<Escape>", _on_escape)

    def toggle_grid(self):
        """Active ou désactive l'affichage de la grille de repères (Touche 'G')."""
        self.show_grid_var.set(not self.show_grid_var.get())
        self.redraw_canvas()

    def toggle_grid_type(self):
        """Bascule entre la grille cartésienne et la grille polaire 30° (Touche 'Shift+G')."""
        if self.grid_type_var.get() == "cartesian":
            self.grid_type_var.set("polar")
            if hasattr(self, "btn_grid_toggle"):
                self.btn_grid_toggle.config(text="◎ Polaire (30°)", fg="#ffb74d")
            self.lbl_status.config(text="Grille Polaire active (cercles concentriques + rayons 30°)", fg="#ffb74d")
        else:
            self.grid_type_var.set("cartesian")
            if hasattr(self, "btn_grid_toggle"):
                self.btn_grid_toggle.config(text="▦ Cartésienne", fg="#00e5ff")
            self.lbl_status.config(text="Grille Cartésienne active (pas 0.05)", fg="#00e5ff")
        self.redraw_canvas()

    def snap_polar(self, wx: float, wy: float, snap_radius_step: float = 0.05, snap_angle_deg: float = 30.0) -> tuple[float, float]:
        """Aimante (wx, wy) sur la grille polaire (cercles de pas 0.05 et rayons à 30°)."""
        return core_snap_polar(wx, wy, snap_radius_step, snap_angle_deg)

    def get_sym_mode(self) -> tuple[str, int]:
        """Retourne (mode_code, count) selon le mode de symétrie actif."""
        val = getattr(self, "sym_mode_var", None)
        text = val.get() if val else "Désactivé"
        return get_sym_mode_info(text)

    def compute_symmetry_strokes(self, pts: list[tuple[float, float]]) -> list[list[tuple[float, float]]]:
        """Calcule les tracés symétriques pour une liste de points laser [(wx, wy)] selon l'axe actif."""
        mode, count = self.get_sym_mode()
        return compute_symmetry(pts, mode, count, self.sym_cx, self.sym_cy)

    def _update_sym_ui(self):
        """Met à jour l'affichage des coordonnées de l'axe de symétrie dans le panneau gauche."""
        if hasattr(self, "lbl_sym_coords"):
            self.lbl_sym_coords.config(text=f"Axe : ({self.sym_cx:+.2f}, {self.sym_cy:+.2f})")

    def _on_sym_mode_change(self, choice=None):
        mode, count = self.get_sym_mode()
        if mode == "none":
            self.lbl_status.config(text="Mode Miroir désactivé", fg="#888888")
        else:
            self.lbl_status.config(text=f"Mode Miroir actif : {self.sym_mode_var.get()} (axe en {self.sym_cx:+.2f}, {self.sym_cy:+.2f})", fg="#ffb74d")
        self._update_sym_ui()
        self.redraw_canvas()

    def reset_sym_center(self):
        """Recentres l'axe de symétrie à l'origine laser (0.00, 0.00)."""
        self.sym_cx = 0.0
        self.sym_cy = 0.0
        self._update_sym_ui()
        self.redraw_canvas()
        self.lbl_status.config(text="Axe de symétrie recentré en (0.00, 0.00)", fg="#ffb74d")

    def toggle_sym_move_mode(self):
        """Active ou désactive le mode de placement libre de l'axe au clic."""
        self._sym_move_mode_active = not getattr(self, "_sym_move_mode_active", False)
        if self._sym_move_mode_active:
            if hasattr(self, "btn_sym_move"):
                self.btn_sym_move.config(bg="#e65100")
            self.canvas.config(cursor="fleur")
            self.lbl_status.config(text="Clique ou glisse n'importe où pour placer l'axe de symétrie", fg="#ffb74d")
        else:
            if hasattr(self, "btn_sym_move"):
                self.btn_sym_move.config(bg="#333333")
            self.canvas.config(cursor="crosshair")
            self.lbl_status.config(text="Positionnement d'axe terminé", fg="#888888")

    def cycle_sym_mode(self):
        """Raccourci 'M' : fait défiler les modes de symétrie rapidement."""
        modes = ["Désactivé", "x2 Gauche / Droite", "x2 Haut / Bas", "x4 Croix (X & Y)", "x3 Radial (120°)", "x6 Radial (60°)"]
        cur = self.sym_mode_var.get()
        idx = modes.index(cur) if cur in modes else 0
        nxt = modes[(idx + 1) % len(modes)]
        self.sym_mode_var.set(nxt)
        self._on_sym_mode_change()

    def _insert_new_layer_in_tree(self, new_layer: Layer):
        """Insère un calque créé (forme ou groupe de symétrie) dans l'arbre selon la sélection courante."""
        cur_l = self.get_current_layer()
        if cur_l and cur_l.shape_type == "group":
            cur_l.children.append(new_layer)
            cur_l.is_expanded = True
        elif cur_l:
            p = self.find_parent_group(cur_l)
            if p is not None:
                idx = p.children.index(cur_l) + 1 if cur_l in p.children else len(p.children)
                p.children.insert(idx, new_layer)
                p.is_expanded = True
            else:
                idx = self.layers.index(cur_l) + 1 if cur_l in self.layers else len(self.layers)
                self.layers.insert(idx, new_layer)
        else:
            self.layers.append(new_layer)

        self.select_layer_object(new_layer)
        self._refresh_layers_ui()

    def apply_symmetry_to_selection(self):
        """Duplique et symétrise les calques actuellement sélectionnés selon l'axe et le mode de symétrie actif."""
        mode, count = self.get_sym_mode()
        if mode == "none":
            self.lbl_status.config(text="Choisis d'abord un mode miroir (x2, x3, x4...) dans le panneau gauche", fg="#ffb74d")
            return

        sel = list(getattr(self, "selected_layers", set()))
        if not sel and self.get_current_layer():
            sel = [self.get_current_layer()]

        if not sel:
            self.lbl_status.config(text="Sélectionne au moins une forme à symétriser", fg="#ffb74d")
            return

        self.push_undo_state()
        new_shapes = []

        for l in sel:
            strokes = l.get_render_strokes()
            for wpts, color, is_closed, shape_type in strokes:
                if not wpts:
                    continue
                sym_strokes = self.compute_symmetry_strokes(wpts)
                for b_idx in range(1, len(sym_strokes)):
                    b_pts = sym_strokes[b_idx]
                    self.layer_counter += 1
                    min_x = min(p[0] for p in b_pts)
                    max_x = max(p[0] for p in b_pts)
                    min_y = min(p[1] for p in b_pts)
                    max_y = max(p[1] for p in b_pts)
                    cx_l = (min_x + max_x) / 2.0
                    cy_l = (min_y + max_y) / 2.0

                    if len(b_pts) == 1:
                        dup = Layer(self.layer_counter, f"{l.name} Miroir {b_idx}", "point", color=color)
                        dup.x = b_pts[0][0]
                        dup.y = b_pts[0][1]
                        dup.local_points = [(0.0, 0.0)]
                    elif shape_type == "line" and len(b_pts) == 2:
                        p1, p2 = b_pts[0], b_pts[1]
                        dist = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
                        ang = math.degrees(math.atan2(p2[1] - p1[1], p2[0] - p1[0]))
                        dup = Layer(self.layer_counter, f"{l.name} Miroir {b_idx}", "line", color=color)
                        dup.x = cx_l
                        dup.y = cy_l
                        dup.rotation = ang
                        dup.scale_x = max(0.05, dist / 1.10)
                        dup.scale_y = 1.0
                        dup.local_points = [(-0.55, 0.0), (0.55, 0.0)]
                    else:
                        dup = Layer(self.layer_counter, f"{l.name} Miroir {b_idx}", "pencil", color=color)
                        dup.x = cx_l
                        dup.y = cy_l
                        dup.scale_x = 1.0
                        dup.scale_y = 1.0
                        dup.rotation = 0.0
                        dup.is_closed = is_closed
                        dup.local_points = [(p[0] - cx_l, p[1] - cy_l) for p in b_pts]

                    self._insert_new_layer_in_tree(dup)
                    new_shapes.append(dup)

        self.selected_layers = set(new_shapes)
        self.selected_layer = new_shapes[-1] if new_shapes else None
        self._sync_legacy_indices()
        self._sync_listbox_selection()
        self.redraw_canvas()
        self.lbl_status.config(text=f"Symétrie appliquée : {len(new_shapes)} forme(s) créée(s)", fg="#66bb6a")

    def set_tool(self, tool_name: str):
        """Bascule entre les outils 'select' et 'pencil'."""
        self.current_tool = tool_name
        self._pencil_hover_pt = None
        if hasattr(self, "btn_tool_select") and hasattr(self, "btn_tool_pencil"):
            if tool_name == "select":
                self.btn_tool_select.config(bg="#00897b")
                self.btn_tool_pencil.config(bg="#333333")
                self.canvas.config(cursor="crosshair")
                self.lbl_status.config(text="Mode Sélection (V) : clique pour transformer", fg="#81c784")
            elif tool_name == "pencil":
                self.btn_tool_select.config(bg="#333333")
                self.btn_tool_pencil.config(bg="#00897b")
                self.canvas.config(cursor="pencil")
                self.lbl_status.config(text="Mode Crayon (P) : Clic = Point | Glisser = Dessin | Shift = Ligne droite / Aimant", fg="#81c784")
        self.redraw_canvas()

    def import_line(self):
        """Importe une nouvelle forme Ligne."""
        self.push_undo_state()
        self.layer_counter += 1
        name = f"Ligne {self.layer_counter}"
        layer = Layer(self.layer_counter, name, "line", color=self.current_color)
        self.layers.append(layer)
        self.set_tool("select")
        self.select_layer(len(self.layers) - 1)

    def import_circle(self):
        """Importe une nouvelle forme Cercle."""
        self.push_undo_state()
        self.layer_counter += 1
        name = f"Cercle {self.layer_counter}"
        layer = Layer(self.layer_counter, name, "circle", color=self.current_color)
        self.layers.append(layer)
        self.set_tool("select")
        self.select_layer(len(self.layers) - 1)

    def _build_custom_shapes_buttons(self):
        """Génère dynamiquement les boutons de formes personnalisées dans le panneau gauche."""
        if not hasattr(self, "custom_shapes_frame"):
            return
        for w in self.custom_shapes_frame.winfo_children():
            w.destroy()

        btn_square = tk.Button(
            self.custom_shapes_frame, text="Carré", command=self.import_square,
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=3, font=("Segoe UI", 8)
        )
        btn_square.pack(fill=tk.X, pady=1)

        btn_tri = tk.Button(
            self.custom_shapes_frame, text="Triangle", command=self.import_triangle,
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=3, font=("Segoe UI", 8)
        )
        btn_tri.pack(fill=tk.X, pady=1)

        btn_star = tk.Button(
            self.custom_shapes_frame, text="Étoile", command=self.import_star,
            bg="#333333", fg="#ffffff", activebackground="#444444", activeforeground="#ffffff",
            relief=tk.FLAT, pady=3, font=("Segoe UI", 8)
        )
        btn_star.pack(fill=tk.X, pady=1)

        # Formes enregistrées par l'utilisateur
        for tmpl in getattr(self, "user_custom_shapes", []):
            name = tmpl.get("name", "Forme")
            btn_t = tk.Button(
                self.custom_shapes_frame, text=f"★ {name}",
                command=lambda t=tmpl: self.import_custom_template(t),
                bg="#2a2a2a", fg="#00e5ff", activebackground="#3a3a3a", activeforeground="#ffffff",
                relief=tk.FLAT, pady=3, font=("Segoe UI", 8, "bold")
            )
            btn_t.pack(fill=tk.X, pady=1)

        btn_save = tk.Button(
            self.custom_shapes_frame, text="💾+ Sauvegarder sélec", command=self.save_selection_as_custom_shape,
            bg="#2a2a2a", fg="#ffb74d", activebackground="#3a3a3a", activeforeground="#ffffff",
            relief=tk.FLAT, pady=3, font=("Segoe UI", 8)
        )
        btn_save.pack(fill=tk.X, pady=(4, 1))

    def import_square(self):
        """Importe un Carré comme forme personnalisée liée dont tous les côtés restent éditables."""
        self.push_undo_state()
        grp, self.layer_counter = create_square_shape(self.layer_counter, color=self.current_color)
        self.layers.append(grp)
        self.set_tool("select")
        self.select_layer_object(grp)
        self.set_dirty(True)
        self.lbl_status.config(text="Forme personnalisée importée : Carré (forme liée)", fg="#66bb6a")

    def import_triangle(self):
        """Importe un Triangle comme forme personnalisée liée dont tous les côtés restent éditables."""
        self.push_undo_state()
        grp, self.layer_counter = create_triangle_shape(self.layer_counter, color=self.current_color)
        self.layers.append(grp)
        self.set_tool("select")
        self.select_layer_object(grp)
        self.set_dirty(True)
        self.lbl_status.config(text="Forme personnalisée importée : Triangle (forme liée)", fg="#66bb6a")

    def import_star(self):
        """Importe une Étoile comme forme personnalisée liée dont toutes les branches restent éditables."""
        self.push_undo_state()
        grp, self.layer_counter = create_star_shape(self.layer_counter, color=self.current_color)
        self.layers.append(grp)
        self.set_tool("select")
        self.select_layer_object(grp)
        self.set_dirty(True)
        self.lbl_status.config(text="Forme personnalisée importée : Étoile (forme liée)", fg="#66bb6a")

    def import_custom_template(self, template: dict):
        """Instancie une forme personnalisée utilisateur sauvegardée."""
        self.push_undo_state()
        grp, self.layer_counter = instantiate_custom_template(template, self.layer_counter)
        self.layers.append(grp)
        self.set_tool("select")
        self.select_layer_object(grp)
        self.set_dirty(True)
        name = template.get("name", "Forme")
        self.lbl_status.config(text=f"Forme personnalisée importée : {name}", fg="#66bb6a")

    def save_selection_as_custom_shape(self, target_layer: Layer | None = None):
        """Enregistre le groupe ou les calques sélectionnés dans la palette des 'Formes personnalisées'."""
        target = target_layer if target_layer is not None else self.get_current_layer()
        if not target and self.selected_layers:
            target = next(iter(self.selected_layers))

        if not target:
            self.lbl_status.config(text="Sélectionne d'abord un calque ou groupe à sauvegarder en forme", fg="#ffb74d")
            return

        # Si plusieurs calques sont sélectionnés et que la cible n'est pas un groupe unique les contenant
        if len(self.selected_layers) > 1:
            self.group_selected_layers()
            target = self.get_current_layer()

        if not target:
            return

        if target.shape_type != "group":
            self.push_undo_state()
            self.layer_counter += 1
            grp = Layer(self.layer_counter, f"{target.name} (Lié)", "group", color=target.color, children=[target.clone()])
            grp.locked = True
            target = grp
        else:
            target.locked = True

        name = simpledialog.askstring(
            "Forme personnalisée",
            "Nom de votre nouvelle forme personnalisée :",
            initialvalue=target.name,
            parent=self.root
        )
        if not name or not name.strip():
            return
        name = name.strip()

        template = {
            "name": name,
            "layer_data": target.to_dict()
        }
        if not hasattr(self, "user_custom_shapes"):
            self.user_custom_shapes = []
        self.user_custom_shapes.append(template)
        save_user_custom_shapes(self.user_custom_shapes)
        self._build_custom_shapes_buttons()
        self.set_dirty(True)
        self._refresh_layers_ui()
        self.lbl_status.config(text=f"Forme '{name}' ajoutée aux Formes personnalisées !", fg="#00e5ff")

    def select_layer_object(self, layer: Layer | None):
        if layer is not None:
            self.selected_layer = layer
            self.selected_layers = {layer}
            # Déplier les groupes parents si nécessaire pour que le calque soit visible dans la liste
            p = self.find_parent_group(layer)
            while p is not None:
                p.is_expanded = True
                p = self.find_parent_group(p)
            self._sync_legacy_indices()
        else:
            self.selected_layer = None
            self.selected_layers = set()
            self.selected_idx = -1
            self.selected_indices.clear()
        self._refresh_layers_ui()
        self._sync_listbox_selection()
        self.redraw_canvas()

    def select_layer(self, idx: int):
        if 0 <= idx < len(self.layers):
            self.select_layer_object(self.layers[idx])
        else:
            self.select_layer_object(None)

    def get_current_layer(self) -> Layer | None:
        if getattr(self, "selected_layer", None) is not None:
            return self.selected_layer
        if 0 <= self.selected_idx < len(self.layers):
            return self.layers[self.selected_idx]
        return None

    def find_parent_group(self, target_layer: Layer) -> Layer | None:
        def search(group: Layer):
            for child in group.children:
                if child is target_layer:
                    return group
                if child.shape_type == "group":
                    res = search(child)
                    if res is not None:
                        return res
            return None
        for l in self.layers:
            if l.shape_type == "group":
                res = search(l)
                if res is not None:
                    return res
        return None

    def get_parent_world_matrix(self, layer: Layer) -> Transform2D:
        chain = []
        cur = layer
        while True:
            parent = self.find_parent_group(cur)
            if parent is None:
                break
            chain.append(parent)
            cur = parent
        mat = Transform2D()
        for p in reversed(chain):
            mat = mat.multiply(p.get_local_matrix())
        return mat

    def get_layer_world_matrix(self, layer: Layer) -> Transform2D:
        parent_mat = self.get_parent_world_matrix(layer)
        return parent_mat.multiply(layer.get_local_matrix())

    def get_layer_world_points(self, l: Layer) -> list[tuple[float, float]]:
        world_mat = self.get_layer_world_matrix(l)
        if l.shape_type == "group":
            pts = []
            for child in l.children:
                if child.enabled:
                    pts.extend(self.get_layer_world_points(child))
            return pts if pts else [world_mat.apply(0.0, 0.0)]
        pts = l.local_points
        return [world_mat.apply(lx, ly) for lx, ly in pts]

    def get_layer_world_center(self, l: Layer) -> tuple[float, float]:
        world_mat = self.get_layer_world_matrix(l)
        return world_mat.apply(0.0, 0.0)

    def select_all_visible_layers(self, event=None):
        """Ctrl+A : Sélectionne toutes les formes visibles dans l'affichage et la liste des calques."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            event.widget.select_range(0, tk.END)
            event.widget.icursor(tk.END)
            return "break"

        visible_layers = [l for l in self.layers if l.enabled]

        if not visible_layers:
            self.selected_layers = set()
            self.selected_layer = None
            self.selected_indices.clear()
            self.selected_idx = -1
            self._sync_listbox_selection()
            self.redraw_canvas()
            self.lbl_status.config(text="Aucune forme visible à sélectionner", fg="#ffb74d")
            return "break"

        self.selected_layers = set(visible_layers)
        self.selected_layer = visible_layers[0]
        self._sync_legacy_indices()
        self._sync_listbox_selection()
        self.redraw_canvas()
        self.lbl_status.config(
            text=f"{len(visible_layers)} forme(s) visible(s) sélectionnée(s) (Ctrl+A)",
            fg="#80d8ff"
        )
        return "break"

    def create_empty_group(self, event=None):
        """Crée un nouveau sur-calque / sous-groupe vide dans la liste des calques."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return

        self.push_undo_state()
        self.layer_counter += 1

        cur_l = self.get_current_layer()
        target_parent = None
        insert_idx = len(self.layers)

        if cur_l is not None:
            if cur_l.shape_type == "group":
                # Si un groupe est sélectionné, créer un sous-groupe vide à l'intérieur
                target_parent = cur_l
                insert_idx = len(cur_l.children)
            else:
                # Si un calque est sélectionné, créer dans le même conteneur juste après ce calque
                parent = self.find_parent_group(cur_l)
                if parent is not None:
                    target_parent = parent
                    insert_idx = parent.children.index(cur_l) + 1 if cur_l in parent.children else len(parent.children)
                else:
                    target_parent = None
                    insert_idx = self.layers.index(cur_l) + 1 if cur_l in self.layers else len(self.layers)

        target_list = target_parent.children if target_parent is not None else self.layers

        if target_parent is not None:
            group_name = f"Sous-groupe {self.layer_counter}"
            group_color = target_parent.color
        else:
            group_name = f"Sur-calque {self.layer_counter}"
            group_color = (0, 229, 255)

        group = Layer(self.layer_counter, group_name, "group", color=group_color)
        group.x = 0.0
        group.y = 0.0
        group.scale_x = 1.0
        group.scale_y = 1.0
        group.rotation = 0.0
        if target_parent is not None:
            group.enabled = target_parent.enabled
            target_parent.is_expanded = True

        if insert_idx > len(target_list):
            insert_idx = len(target_list)
        target_list.insert(insert_idx, group)

        self.select_layer_object(group)
        self._refresh_layers_ui()
        self.redraw_canvas()

        container_desc = f" dans '{target_parent.name}'" if target_parent else ""
        self.lbl_status.config(text=f"Créé : {group.name} (vide){container_desc}", fg="#66bb6a")
        return "break"

    def group_selected_layers(self, event=None):
        """Encapsule les calques sélectionnés dans un sur-calque / sous-groupe (Ctrl+G).
        Si tous les calques sélectionnés appartiennent à un même groupe parent,
        un sous-groupe est automatiquement créé à l'intérieur de ce groupe parent.
        Si aucun calque n'est sélectionné, crée un groupe vide."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return

        sel = list(getattr(self, "selected_layers", set()))
        if not sel and self.get_current_layer():
            sel = [self.get_current_layer()]

        if not sel:
            return self.create_empty_group(event)

        self.push_undo_state()
        self.layer_counter += 1

        # Identifier le parent commun éventuel des éléments sélectionnés
        first_parent = self.find_parent_group(sel[0])
        same_parent = all(self.find_parent_group(l) is first_parent for l in sel)
        target_parent = first_parent if same_parent else None
        target_list = target_parent.children if target_parent is not None else self.layers

        # Nom du groupe / sous-groupe
        if target_parent is not None:
            group_name = f"Sous-groupe {self.layer_counter}"
        else:
            group_name = f"Sur-calque {self.layer_counter}"

        # Conserver l'ordre d'origine des calques (z-index) dans le groupe
        sel.sort(key=lambda x: target_list.index(x) if x in target_list else 9999)

        # Trouver la position d'insertion dans la liste cible (le plus petit index parmi les calques sélectionnés)
        indices = [target_list.index(l) for l in sel if l in target_list]
        insert_idx = min(indices) if indices else len(target_list)

        if same_parent:
            # Tous les éléments partagent le même espace local (soit target_parent, soit la racine)
            all_pts = []
            for l in sel:
                all_pts.extend(l.get_unclamped_world_points(parent_mat=None))

            if all_pts:
                min_x = min(p[0] for p in all_pts)
                max_x = max(p[0] for p in all_pts)
                min_y = min(p[1] for p in all_pts)
                max_y = max(p[1] for p in all_pts)
                cx = (min_x + max_x) / 2.0
                cy = (min_y + max_y) / 2.0
            else:
                cx, cy = 0.0, 0.0

            group = Layer(self.layer_counter, group_name, "group", color=sel[0].color)
            group.x = cx
            group.y = cy
            group.scale_x = 1.0
            group.scale_y = 1.0
            group.rotation = 0.0
            if target_parent is not None:
                group.enabled = target_parent.enabled

            # Pour chaque élément sélectionné, recalculer son décalage par rapport au centre du nouveau groupe
            for l in sel:
                l.x -= cx
                l.y -= cy
                group.children.append(l)
                if l in target_list:
                    target_list.remove(l)

        else:
            # Éléments venant de parents différents : regrouper au niveau racine en coordonnées monde
            all_wpts = []
            for l in sel:
                all_wpts.extend(self.get_layer_world_points(l))

            if all_wpts:
                min_x = min(p[0] for p in all_wpts)
                max_x = max(p[0] for p in all_wpts)
                min_y = min(p[1] for p in all_wpts)
                max_y = max(p[1] for p in all_wpts)
                cx = (min_x + max_x) / 2.0
                cy = (min_y + max_y) / 2.0
            else:
                cx, cy = 0.0, 0.0

            group = Layer(self.layer_counter, group_name, "group", color=sel[0].color)
            group.x = cx
            group.y = cy
            group.scale_x = 1.0
            group.scale_y = 1.0
            group.rotation = 0.0

            group_inv = Transform2D.from_trs(cx, cy, 1.0, 1.0, 0.0).invert()

            for l in sel:
                l_world_mat = self.get_layer_world_matrix(l)
                child_mat = group_inv.multiply(l_world_mat)
                ch_x, ch_y, ch_sx, ch_sy, ch_rot = child_mat.decompose()
                l.x = ch_x
                l.y = ch_y
                l.scale_x = ch_sx
                l.scale_y = ch_sy
                l.rotation = ch_rot
                group.children.append(l)

                p = self.find_parent_group(l)
                if p is not None and l in p.children:
                    p.children.remove(l)
                elif l in self.layers:
                    self.layers.remove(l)

        if insert_idx > len(target_list):
            insert_idx = len(target_list)
        target_list.insert(insert_idx, group)

        if target_parent is not None:
            target_parent.is_expanded = True

        self.select_layer_object(group)
        self._refresh_layers_ui()
        self.redraw_canvas()
        self.lbl_status.config(text=f"Créé : {group.name} ({len(group.children)} formes)", fg="#66bb6a")
        return "break"

    def ungroup_selected_layer(self, event=None):
        """Dissocie / dégroupe le sur-calque sélectionné (Ctrl+Shift+G ou Ctrl+U)."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return

        cur_l = self.get_current_layer()
        if not cur_l:
            self.lbl_status.config(text="Aucun sur-calque sélectionné", fg="#ffb74d")
            return "break"

        if cur_l.shape_type == "group":
            group = cur_l
        else:
            group = self.find_parent_group(cur_l)
            if group is None:
                self.lbl_status.config(text=f"'{cur_l.name}' n'est pas dans un sur-calque", fg="#ffb74d")
                return "break"

        if not group.children:
            self.lbl_status.config(text=f"'{group.name}' est vide", fg="#ffb74d")
            return "break"

        self.push_undo_state()

        parent_of_group = self.find_parent_group(group)
        group_mat = group.get_local_matrix()

        extracted_children = []
        for child in group.children:
            child_world_mat = group_mat.multiply(child.get_local_matrix())
            wx, wy, wsx, wsy, wrot = child_world_mat.decompose()
            child.x = wx
            child.y = wy
            child.scale_x = wsx
            child.scale_y = wsy
            child.rotation = wrot
            extracted_children.append(child)

        if parent_of_group is not None:
            idx = parent_of_group.children.index(group)
            del parent_of_group.children[idx]
            for offset, child in enumerate(extracted_children):
                parent_of_group.children.insert(idx + offset, child)
        else:
            idx = self.layers.index(group)
            del self.layers[idx]
            for offset, child in enumerate(extracted_children):
                self.layers.insert(idx + offset, child)

        self.selected_layers = set(extracted_children)
        self.selected_layer = extracted_children[0] if extracted_children else None
        self._sync_legacy_indices()
        self._sync_listbox_selection()
        self._refresh_layers_ui()
        self.redraw_canvas()
        self.lbl_status.config(text=f"Dissocié : {group.name} ({len(extracted_children)} formes)", fg="#80d8ff")
        return "break"

    def center_selected_layer(self, event=None):
        """Touche 'C' : Centre la forme sélectionnée à (0, 0). Avec Shift/Alt : reset complet."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        is_shift, is_alt, is_ctrl = self._get_modifiers(event)
        if is_ctrl:
            return "break"
        eff_layers = self.get_effective_selected_layers()
        if not eff_layers:
            return

        self.push_undo_state()
        if len(eff_layers) == 1:
            l = eff_layers[0]
            parent_mat = self.get_parent_world_matrix(l)
            inv_parent = parent_mat.invert()
            lx, ly = inv_parent.apply(0.0, 0.0)
            l.x = lx
            l.y = ly
            if is_shift or is_alt:
                l.scale_x = 1.0
                l.scale_y = 1.0
                l.rotation = 0.0
        else:
            # Multi-sélection : centrer le centre du bloc sélectionné à (0, 0)
            all_wpts = []
            for sl in eff_layers:
                pts = self.get_layer_world_points(sl)
                all_wpts.extend(pts if pts else [self.get_layer_world_center(sl)])
            min_wx = min(pt[0] for pt in all_wpts)
            max_wx = max(pt[0] for pt in all_wpts)
            min_wy = min(pt[1] for pt in all_wpts)
            max_wy = max(pt[1] for pt in all_wpts)
            cen_wx = (min_wx + max_wx) / 2.0
            cen_wy = (min_wy + max_wy) / 2.0
            shift_x = -cen_wx
            shift_y = -cen_wy

            for sl in eff_layers:
                p_mat = self.get_parent_world_matrix(sl)
                inv_p = p_mat.invert()
                cur_wx, cur_wy = p_mat.apply(sl.x, sl.y)
                cand_wx = cur_wx + shift_x
                cand_wy = cur_wy + shift_y
                sl.x, sl.y = inv_p.apply(cand_wx, cand_wy)

        self.redraw_canvas()

    def scale_selected_layer(self, factor: float, event=None):
        """Touches '+' / '-' ou Molette : Redimensionne la forme ou la sélection."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        eff_layers = self.get_effective_selected_layers()
        if not eff_layers:
            return
        is_shift, _is_alt, is_ctrl = self._get_modifiers(event)
        if is_shift:
            eff_factor = 1.25 if factor > 1.0 else 0.8
        elif is_ctrl:
            eff_factor = 1.02 if factor > 1.0 else 0.98
        else:
            eff_factor = factor

        self.push_undo_state()
        if len(eff_layers) == 1:
            l = eff_layers[0]
            cand_sx = l.scale_x * eff_factor
            cand_sy = l.scale_y * eff_factor
            parent_mat = self.get_parent_world_matrix(l)
            if eff_factor > 1.0:
                if l.fits_in_laser(scale_x=cand_sx, scale_y=cand_sy, parent_mat=parent_mat):
                    l.scale_x = cand_sx
                    l.scale_y = cand_sy
                else:
                    low = 1.0
                    high = eff_factor
                    for _ in range(14):
                        mid = (low + high) / 2.0
                        if l.fits_in_laser(scale_x=l.scale_x * mid, scale_y=l.scale_y * mid, parent_mat=parent_mat):
                            low = mid
                        else:
                            high = mid
                    l.scale_x = max(0.05, l.scale_x * low)
                    l.scale_y = max(0.05, l.scale_y * low)
            else:
                l.scale_x = max(0.05, cand_sx)
                l.scale_y = max(0.05, cand_sy)
        else:
            # Multi-sélection : redimensionner autour du centre du groupe
            all_wpts = []
            for sl in eff_layers:
                pts = self.get_layer_world_points(sl)
                all_wpts.extend(pts if pts else [self.get_layer_world_center(sl)])
            cen_wx = (min(pt[0] for pt in all_wpts) + max(pt[0] for pt in all_wpts)) / 2.0
            cen_wy = (min(pt[1] for pt in all_wpts) + max(pt[1] for pt in all_wpts)) / 2.0

            scale_mat = Transform2D(eff_factor, 0.0, 0.0, eff_factor, cen_wx * (1.0 - eff_factor), cen_wy * (1.0 - eff_factor))
            for sl in eff_layers:
                orig_wmat = self.get_layer_world_matrix(sl)
                cand_wmat = scale_mat.multiply(orig_wmat)
                p_mat = self.get_parent_world_matrix(sl)
                inv_p = p_mat.invert()
                cand_lmat = inv_p.multiply(cand_wmat)
                cx_val, cy_val, sx_val, sy_val, rot_val = cand_lmat.decompose()
                if sl.fits_in_laser(cx_val, cy_val, sx_val, sy_val, rot_val, parent_mat=p_mat):
                    sl.x, sl.y, sl.scale_x, sl.scale_y, sl.rotation = cx_val, cy_val, sx_val, sy_val, rot_val

        self.redraw_canvas()

    def rotate_selected_layer(self, delta_deg: float, event=None):
        """Touche 'R' : Fait pivoter la forme ou la sélection."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        eff_layers = self.get_effective_selected_layers()
        if not eff_layers:
            return
        is_shift, is_alt, is_ctrl = self._get_modifiers(event)
        step = 45.0 if is_ctrl else delta_deg
        if is_shift:
            step = round(step / 15.0) * 15.0

        self.push_undo_state()
        if len(eff_layers) == 1:
            l = eff_layers[0]
            cand_rot = 0.0 if is_alt else (l.rotation + step) % 360.0
            parent_mat = self.get_parent_world_matrix(l)
            if l.fits_in_laser(rotation=cand_rot, parent_mat=parent_mat):
                l.rotation = cand_rot
        else:
            all_wpts = []
            for sl in eff_layers:
                pts = self.get_layer_world_points(sl)
                all_wpts.extend(pts if pts else [self.get_layer_world_center(sl)])
            cen_wx = (min(pt[0] for pt in all_wpts) + max(pt[0] for pt in all_wpts)) / 2.0
            cen_wy = (min(pt[1] for pt in all_wpts) + max(pt[1] for pt in all_wpts)) / 2.0

            rad = math.radians(step)
            cos_r, sin_r = math.cos(rad), math.sin(rad)
            rot_mat = Transform2D(
                cos_r, -sin_r,
                sin_r,  cos_r,
                cen_wx * (1.0 - cos_r) + cen_wy * sin_r,
                cen_wy * (1.0 - cos_r) - cen_wx * sin_r
            )
            for sl in eff_layers:
                orig_wmat = self.get_layer_world_matrix(sl)
                cand_wmat = rot_mat.multiply(orig_wmat)
                p_mat = self.get_parent_world_matrix(sl)
                inv_p = p_mat.invert()
                cand_lmat = inv_p.multiply(cand_wmat)
                cx_val, cy_val, sx_val, sy_val, rot_val = cand_lmat.decompose()
                if sl.fits_in_laser(cx_val, cy_val, sx_val, sy_val, rot_val, parent_mat=p_mat):
                    sl.x, sl.y, sl.scale_x, sl.scale_y, sl.rotation = cx_val, cy_val, sx_val, sy_val, rot_val

        self.redraw_canvas()

    def nudge_selected_layer(self, dx: float, dy: float, event=None):
        """Flèches directionnelles : Déplace la forme ou la sélection (Shift=vite, Ctrl=fin)."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        eff_layers = self.get_effective_selected_layers()
        if not eff_layers:
            return
        is_shift, _is_alt, is_ctrl = self._get_modifiers(event)
        mult = 5.0 if is_shift else (0.2 if is_ctrl else 1.0)
        eff_dx = dx * mult
        eff_dy = dy * mult

        self.push_undo_state()
        for l in eff_layers:
            parent_mat = self.get_parent_world_matrix(l)
            inv_parent = parent_mat.invert()
            cur_wx, cur_wy = parent_mat.apply(l.x, l.y)
            new_wx = cur_wx + eff_dx
            new_wy = cur_wy + eff_dy
            cand_lx, cand_ly = inv_parent.apply(new_wx, new_wy)

            # Empêcher la forme de déborder de la fenêtre laser [-1.0, 1.0]
            min_x, min_y, max_x, max_y = l.get_laser_bounds(x=cand_lx, y=cand_ly, parent_mat=parent_mat)
            if min_x < -1.0: new_wx += (-1.0 - min_x)
            if max_x > 1.0: new_wx -= (max_x - 1.0)
            if min_y < -1.0: new_wy += (-1.0 - min_y)
            if max_y > 1.0: new_wy -= (max_y - 1.0)

            cand_lx, cand_ly = inv_parent.apply(new_wx, new_wy)
            l.x = cand_lx
            l.y = cand_ly
        self.redraw_canvas()

    def delete_selected_layer(self, event=None):
        """Touche 'Suppr' / 'Delete' : Supprime le ou les calques actifs."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        layers_to_del = list(self.selected_layers) if getattr(self, "selected_layers", None) else ([self.get_current_layer()] if self.get_current_layer() else [])
        if layers_to_del:
            self.push_undo_state()
            for l in layers_to_del:
                parent = self.find_parent_group(l)
                if parent is not None:
                    if l in parent.children:
                        parent.children.remove(l)
                elif l in self.layers:
                    self.layers.remove(l)
            self.selected_layers.clear()
            self.selected_layer = None
            if hasattr(self, "timeline"):
                all_l = self._get_all_layers_flat()
                self.timeline.prune_dead_layers({lay.id for lay in all_l})
                if hasattr(self, "timeline_widget"):
                    self.timeline_widget.on_model_changed()
            self._sync_legacy_indices()
            self._refresh_layers_ui()
            self.redraw_canvas()
            self.lbl_status.config(text="Calque(s) supprimé(s) (Suppr)", fg="#ffb74d")
