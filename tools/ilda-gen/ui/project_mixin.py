import json
import os
import time
import tkinter as tk
from tkinter import filedialog, messagebox

try:
    from ..core.layer import Layer
except (ImportError, ValueError):
    from core.layer import Layer


class ProjectManagerMixin:
    """Gestion des projets (.ildagen / .json) : Sauvegarde, Chargement, Nouveau projet, Détection de modifications."""

    def set_dirty(self, val: bool = True):
        self.is_dirty = val
        self._update_window_title()
        self._update_proj_bar_ui()

    def _update_window_title(self):
        proj_name = os.path.basename(self.current_project_file) if self.current_project_file else "Sans titre"
        dirty_flag = " • (modifié)" if self.is_dirty else ""
        self.root.title(f"ILDA Generator Studio — [{proj_name}{dirty_flag}]")

    def _update_proj_bar_ui(self):
        if hasattr(self, "lbl_project_name"):
            proj_name = os.path.basename(self.current_project_file) if self.current_project_file else "Sans titre"
            dirty_flag = " *" if self.is_dirty else ""
            fg_col = "#ffb74d" if self.is_dirty else "#00e5ff"
            self.lbl_project_name.config(text=f"Projet : {proj_name}{dirty_flag}", fg=fg_col)

    def _get_all_layers_flat(self) -> list[Layer]:
        res = []
        def collect(l_list):
            for l in l_list:
                res.append(l)
                if l.children:
                    collect(l.children)
        collect(self.layers)
        return res

    def new_project(self, event=None):
        """Crée un nouveau projet vierge en vérifiant d'abord si l'actuel est modifié."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        if self.is_dirty:
            resp = messagebox.askyesnocancel(
                "Nouveau projet",
                "Le projet actuel contient des modifications non enregistrées.\n"
                "Voulez-vous enregistrer vos modifications avant de continuer ?"
            )
            if resp is None:
                return "break"
            if resp is True:
                saved = self.save_project()
                if not saved:
                    return "break"

        self.layers.clear()
        self.selected_layers.clear()
        self.selected_layer = None
        self.layer_counter = 0
        self.current_project_file = None
        self.import_line()
        self.undo_stack.clear()
        self.redo_stack.clear()
        self.is_dirty = False
        self._update_window_title()
        self._update_proj_bar_ui()
        self.redraw_canvas()
        self.lbl_status.config(text="Nouveau projet créé", fg="#66bb6a")
        return "break"

    def save_project(self, event=None) -> bool:
        """Enregistre le projet actuel (si sans titre, appelle Enregistrer sous)."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return False
        if not self.current_project_file:
            return self.save_project_as(event)
        return self._save_to_path(self.current_project_file)

    def save_project_as(self, event=None) -> bool:
        """Boîte de dialogue 'Enregistrer sous' pour choisir l'emplacement du fichier .ildagen."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return False
        init_file = os.path.basename(self.current_project_file) if self.current_project_file else "mon_projet.ildagen"
        init_dir = os.path.dirname(self.current_project_file) if self.current_project_file else os.getcwd()

        filepath = filedialog.asksaveasfilename(
            parent=self.root,
            title="Enregistrer le projet ILDA Studio",
            initialfile=init_file,
            initialdir=init_dir,
            defaultextension=".ildagen",
            filetypes=[
                ("Projet ILDA Studio (*.ildagen)", "*.ildagen"),
                ("Fichier JSON (*.json)", "*.json"),
                ("Tous les fichiers (*.*)", "*.*")
            ]
        )
        if not filepath:
            return False
        return self._save_to_path(filepath)

    def _save_to_path(self, filepath: str) -> bool:
        """Sérialise l'état complet du travail (arborescence des calques, réglages, symétrie, grille) dans le fichier JSON."""
        try:
            data = {
                "version": "1.0",
                "generator": "ILDA Generator Studio",
                "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "layer_counter": self.layer_counter,
                "layers": [l.to_dict() for l in self.layers],
                "settings": {
                    "grid_type": self.grid_type_var.get(),
                    "show_grid": bool(self.show_grid_var.get()),
                    "sym_mode": self.sym_mode_var.get(),
                    "sym_cx": float(self.sym_cx),
                    "sym_cy": float(self.sym_cy),
                    "current_color": list(self.current_color),
                    "live_stream": bool(self.live_stream_var.get()),
                    "host": self.entry_host.get() if hasattr(self, "entry_host") else "127.0.0.1",
                    "port": self.entry_port.get() if hasattr(self, "entry_port") else "7255",
                    "channel": self.entry_channel.get() if hasattr(self, "entry_channel") else "1",
                    "kpps": self.entry_kpps.get() if hasattr(self, "entry_kpps") else "30"
                }
            }
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)

            self.current_project_file = filepath
            self.is_dirty = False
            self._update_window_title()
            self._update_proj_bar_ui()
            filename = os.path.basename(filepath)
            self.lbl_status.config(text=f"Projet sauvegardé : {filename}", fg="#66bb6a")
            return True
        except Exception as err:
            messagebox.showerror("Erreur d'enregistrement", f"Impossible d'enregistrer le projet :\n{err}")
            return False

    def open_project(self, event=None, filepath: str | None = None) -> bool:
        """Charge un projet depuis un fichier .ildagen ou .json."""
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return False
        if self.is_dirty:
            resp = messagebox.askyesnocancel(
                "Ouvrir un projet",
                "Le projet actuel contient des modifications non enregistrées.\n"
                "Voulez-vous enregistrer vos modifications avant d'ouvrir un autre projet ?"
            )
            if resp is None:
                return False
            if resp is True:
                saved = self.save_project()
                if not saved:
                    return False

        if not filepath:
            init_dir = os.path.dirname(self.current_project_file) if self.current_project_file else os.getcwd()
            filepath = filedialog.askopenfilename(
                parent=self.root,
                title="Ouvrir un projet ILDA Studio",
                initialdir=init_dir,
                filetypes=[
                    ("Projet ILDA Studio (*.ildagen)", "*.ildagen"),
                    ("Fichier JSON (*.json)", "*.json"),
                    ("Tous les fichiers (*.*)", "*.*")
                ]
            )
        if not filepath:
            return False

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)

            layers_data = data.get("layers", [])
            new_layers = [Layer.from_dict(d) for d in layers_data]
            self.layers = new_layers

            def get_max_id(layers_list):
                m = 0
                for lay in layers_list:
                    m = max(m, lay.id)
                    if lay.children:
                        m = max(m, get_max_id(lay.children))
                return m

            self.layer_counter = max(data.get("layer_counter", 0), get_max_id(self.layers))

            settings = data.get("settings", {})
            if "grid_type" in settings:
                gt = settings["grid_type"]
                self.grid_type_var.set(gt)
                if hasattr(self, "btn_grid_toggle"):
                    self.btn_grid_toggle.config(
                        text="◎ Polaire (30°)" if gt == "polar" else "▦ Cartésienne",
                        fg="#ffb74d" if gt == "polar" else "#00e5ff"
                    )

            if "show_grid" in settings:
                self.show_grid_var.set(bool(settings["show_grid"]))

            if "sym_mode" in settings:
                self.sym_mode_var.set(settings["sym_mode"])
            if "sym_cx" in settings:
                self.sym_cx = float(settings["sym_cx"])
            if "sym_cy" in settings:
                self.sym_cy = float(settings["sym_cy"])
            self._update_sym_ui()

            if "current_color" in settings:
                self.current_color = tuple(settings["current_color"])

            if "live_stream" in settings:
                self.live_stream_var.set(bool(settings["live_stream"]))

            if "host" in settings and hasattr(self, "entry_host"):
                self.entry_host.delete(0, tk.END)
                self.entry_host.insert(0, str(settings["host"]))
            if "port" in settings and hasattr(self, "entry_port"):
                self.entry_port.delete(0, tk.END)
                self.entry_port.insert(0, str(settings["port"]))
            if "channel" in settings and hasattr(self, "entry_channel"):
                self.entry_channel.delete(0, tk.END)
                self.entry_channel.insert(0, str(settings["channel"]))
            if "kpps" in settings and hasattr(self, "entry_kpps"):
                self.entry_kpps.delete(0, tk.END)
                self.entry_kpps.insert(0, str(settings["kpps"]))

            self.selected_layers = {self.layers[0]} if self.layers else set()
            self.selected_layer = self.layers[0] if self.layers else None
            self._sync_legacy_indices()
            self._sync_listbox_selection()
            self._refresh_layers_ui()

            self.undo_stack.clear()
            self.redo_stack.clear()
            self.current_project_file = filepath
            self.is_dirty = False
            self._update_window_title()
            self._update_proj_bar_ui()
            self.redraw_canvas()

            filename = os.path.basename(filepath)
            total_count = len(self._get_all_layers_flat())
            self.lbl_status.config(text=f"Projet chargé : {filename} ({total_count} éléments)", fg="#66bb6a")
            return True
        except Exception as err:
            messagebox.showerror("Erreur d'ouverture", f"Impossible d'ouvrir le projet :\n{err}")
            return False

    def _on_close_window(self):
        """Intercepte la fermeture de la fenêtre pour proposer d'enregistrer si modifié."""
        if self.is_dirty:
            resp = messagebox.askyesnocancel(
                "Enregistrer les modifications",
                "Le projet actuel contient des modifications non enregistrées.\n"
                "Voulez-vous enregistrer votre travail avant de quitter ?"
            )
            if resp is None:
                return
            if resp is True:
                saved = self.save_project()
                if not saved:
                    return
        self.root.destroy()

    def _on_key_ctrl_s(self, event=None):
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        is_shift, _, _ = self._get_modifiers(event)
        if is_shift:
            return self.save_project_as(event)
        return self.save_project(event)

    def _on_key_ctrl_n(self, event=None):
        if event and isinstance(getattr(event, "widget", None), tk.Entry):
            return
        is_shift, _, _ = self._get_modifiers(event)
        if is_shift:
            return self.create_empty_group(event)
        return self.new_project(event)
