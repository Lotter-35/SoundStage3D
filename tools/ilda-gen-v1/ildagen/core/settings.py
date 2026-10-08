"""Réglages de l'application (enregistrés dans le dossier utilisateur, communs à tous les projets)."""

import copy
import json
import os
import sys

DEFAULTS = {
    "network": {"host": "127.0.0.1", "port": 7255, "channel": 1, "fps": 30},
    "general": {"default_color": [1.0, 1.0, 1.0], "smoothing": 40, "autosave": True,
                "live_at_start": True, "reopen_last": True,
                "show_blanking": False, "show_safety": True},
    # H4 — Optimisation des points
    "laser": {"kpps": 30000, "max_step": 0.03, "blank_base": 4, "blank_per_unit": 8,
              "corner_dwell": 3, "corner_angle": 30, "end_dwell": 3, "reorder": True},
    # H1 — Zone de sécurité
    "safety": {"enabled": False, "xmin": -1.0, "xmax": 1.0, "ymin": -1.0, "ymax": 1.0},
    # H2 — Correction trapèze (en % de la demi-largeur)
    "keystone": {"top": 0.0, "bottom": 0.0, "left": 0.0, "right": 0.0},
    # H3 — Taille / position de sortie
    "output": {"scale_x": 100.0, "scale_y": 100.0, "offset_x": 0.0, "offset_y": 0.0,
               "rotation": 0.0, "flip_x": False, "flip_y": False, "power": 100.0},
    "export": {"format": 5, "fps": 30},
    # Couleur de tracé (barre de gauche) : appliquée aux nouvelles formes et par le seau
    "brush": {"v": 2, "mode": 1, "color": [1.0, 1.0, 1.0], "bg": [1.0, 0.0, 0.0], "stops": [[0.0, 1.0, 0.0, 0.0], [1.0, 0.0, 0.0, 1.0]],
              "type": 0, "angle": 0.0},
    "ui": {"recent": [], "last_project": ""},
}


def config_dir():
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    elif sys.platform.startswith("win"):
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    path = os.path.join(base, "IldaGen-v1")   # sauvegarde v1 : réglages et autosave séparés
    os.makedirs(path, exist_ok=True)
    return path


class Settings:
    def __init__(self, path=None):
        self.path = path or os.path.join(config_dir(), "settings.json")
        self.data = copy.deepcopy(DEFAULTS)
        self.load()

    def load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                stored = json.load(f)
        except (OSError, ValueError):
            return
        for section, values in stored.items():
            if section in self.data and isinstance(values, dict):
                if section == "brush" and values.get("v") != DEFAULTS["brush"]["v"]:
                    continue   # couleurs d'une ancienne version : on repart des valeurs par défaut (blanc)
                self.data[section].update(values)

    def save(self):
        try:
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=1)
        except OSError:
            pass

    def section(self, name):
        return self.data[name]

    def get(self, section, key):
        return self.data[section].get(key, DEFAULTS[section].get(key))

    def set(self, section, key, value):
        self.data[section][key] = value

    def reset_section(self, name):
        self.data[name] = copy.deepcopy(DEFAULTS[name])

    def add_recent(self, path):
        rec = [p for p in self.data["ui"].get("recent", []) if p != path]
        self.data["ui"]["recent"] = [path] + rec[:7]
