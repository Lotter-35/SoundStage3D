"""Réglages de l'application (enregistrés dans le dossier utilisateur, communs à tous les projets)."""

import copy
import json
import logging
import math
import os
import sys

from .atomic import write_json

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


# Bornes des réglages numériques (une valeur hors bornes est ramenée dedans)
RANGES = {
    ("network", "port"): (1, 65535),
    ("network", "channel"): (1, 16),
    ("network", "fps"): (1, 240),
    ("export", "fps"): (1, 240),
    ("laser", "kpps"): (1, None),
    ("general", "smoothing"): (0, 100),
}

log = logging.getLogger(__name__)


def _number(v, kind):
    """Nombre fini du type voulu (int / float) à partir d'un nombre ou d'un texte, sinon None."""
    if isinstance(v, bool):
        return None
    if isinstance(v, str):
        try:
            v = float(v.strip().replace(",", "."))
        except ValueError:
            return None
    if not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    return int(round(v)) if kind is int else float(v)


def coerce(default, v):
    """Valeur lue convertie au type de la valeur par défaut ; None si c'est impossible."""
    if isinstance(default, bool):
        if isinstance(v, bool):
            return v
        return bool(v) if isinstance(v, (int, float)) and v in (0, 1) else None
    if isinstance(default, (int, float)):
        return _number(v, type(default))
    if isinstance(default, str):
        return v if isinstance(v, str) else None
    if isinstance(default, dict):
        return v if isinstance(v, dict) else None
    if isinstance(default, list):
        if not isinstance(v, list):
            return None
        if not default:
            return [x for x in v if isinstance(x, str)]        # liste de chemins (fichiers récents)
        if all(isinstance(x, (int, float)) for x in default):
            # Couleur : même nombre de composantes, toutes des nombres
            out = [_number(x, float) for x in v]
            return out if len(out) == len(default) and None not in out else None
        if isinstance(default[0], list):
            # Liste de lignes de nombres (repères d'un dégradé) : chaque ligne de la même longueur
            rows = [coerce(default[0], x) for x in v]
            return rows if rows and None not in rows else None
        return list(v)
    return v


def valid_value(section, key, v):
    """Réglage validé (type et bornes) ; valeur par défaut si la valeur lue n'est pas utilisable."""
    default = DEFAULTS.get(section, {}).get(key)
    if default is None:
        return v                                  # réglage libre (disposition des panneaux…)
    out = coerce(default, v)
    if out is None:
        log.warning("Réglage %s.%s invalide (%r) : valeur par défaut", section, key, v)
        return copy.deepcopy(default)
    lo, hi = RANGES.get((section, key), (None, None))
    if lo is not None:
        out = max(lo, out)
    if hi is not None:
        out = min(hi, out)
    return out


def config_dir():
    if sys.platform == "darwin":
        base = os.path.expanduser("~/Library/Application Support")
    elif sys.platform.startswith("win"):
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    path = os.path.join(base, "IldaGen")
    os.makedirs(path, exist_ok=True)
    return path


class Settings:
    def __init__(self, path=None):
        self.path = path or os.path.join(config_dir(), "settings.json")
        self.data = copy.deepcopy(DEFAULTS)
        self.load()

    def load(self):
        """Lit les réglages ; chaque valeur est vérifiée (un fichier abîmé ne bloque jamais le démarrage)."""
        try:
            with open(self.path, encoding="utf-8") as f:
                stored = json.load(f)
        except (OSError, ValueError):
            return
        if not isinstance(stored, dict):
            return
        for section, values in stored.items():
            if section in self.data and isinstance(values, dict):
                if section == "brush" and values.get("v") != DEFAULTS["brush"]["v"]:
                    continue   # couleurs d'une ancienne version : on repart des valeurs par défaut (blanc)
                for key, v in values.items():
                    if isinstance(key, str):
                        self.data[section][key] = valid_value(section, key, v)

    def save(self):
        try:
            write_json(self.path, self.data, indent=1)
        except (OSError, TypeError, ValueError):
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
