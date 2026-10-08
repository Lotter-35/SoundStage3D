"""Document (projet) : formes, timeline, réglages enregistrés avec le projet."""

import json
import math
import os

from .atomic import write_json
from .library import Library, ShapeDef, link_clips
from .timeline import Timeline

PROJECT_EXT = ".ildaproj"
FORMAT_VERSION = 3   # 3 : clés d'automation en proportion de la durée du clip


class GridSettings:
    MODES = ["Aucune", "Orthogonale", "Polaire"]

    def __init__(self):
        self.mode = 1          # 0 aucune, 1 orthogonale, 2 polaire
        self.divisions = 8     # cases par demi-axe (orthogonale)
        self.rings = 8         # cercles (polaire)
        self.rays = 16         # rayons (polaire)
        self.snap = True       # aimant : les poignées de redimensionnement s'accrochent à la grille
        self.sym = 0           # symétrie de dessin (voir core/draw_symmetry.py)
        self.sym_count = 6     # nombre de branches (radiale / kaléidoscope)
        self.sym_last = 1      # dernier mode utilisé (bouton marche / arrêt)

    # Bornes de chaque réglage (une valeur abîmée reprend la valeur par défaut)
    LIMITS = {"mode": (0, 2), "divisions": (1, 64), "rings": (1, 64), "rays": (2, 360), "sym": (0, 5),
              "sym_count": (2, 16), "sym_last": (0, 5)}

    def to_dict(self):
        return dict(self.__dict__)

    @classmethod
    def from_dict(cls, d):
        g = cls()
        for k, v in (d if isinstance(d, dict) else {}).items():
            default = g.__dict__.get(k)
            if default is None or isinstance(v, bool) != isinstance(default, bool):
                continue
            if isinstance(default, (int, float)) and not isinstance(default, bool):
                if not isinstance(v, (int, float)) or not math.isfinite(v):
                    continue
                lo, hi = cls.LIMITS.get(k, (-math.inf, math.inf))
                v = type(default)(min(hi, max(lo, v)))
            elif type(v) is not type(default):
                continue
            setattr(g, k, v)
        return g


FORM_PREFIX = "Forme"


def next_form_name(library):
    """« Forme 1 », « Forme 2 »… : premier numéro libre."""
    names = {d.name for d in library.visible()}
    i = 1
    while f"{FORM_PREFIX} {i}" in names:
        i += 1
    return f"{FORM_PREFIX} {i}"


def ensure_form(library):
    """Le projet contient toujours au moins une forme."""
    if not library.visible():
        library.add(ShapeDef(next_form_name(library)))
    return library.visible()[0]


class Document:
    """Un projet = des formes (la liste de gauche) + la timeline qui les joue."""

    def __init__(self):
        self.library = Library()
        ensure_form(self.library)
        self.timeline = Timeline()
        self.grid = GridSettings()
        self.network = {}      # copie des réglages réseau au moment de l'enregistrement
        self.path = ""         # fichier du projet
        self.version = FORMAT_VERSION   # version du format du fichier lu (plus récent : avertir)

    def to_dict(self):
        return {"version": FORMAT_VERSION, "library": self.library.to_dict(),
                "timeline": self.timeline.to_dict(), "grid": self.grid.to_dict(), "network": dict(self.network)}

    def load_dict(self, d):
        if not isinstance(d, dict) or not isinstance(d.get("library", []), list):
            raise ValueError("ce fichier n'est pas un projet ILDA Gen")
        self.version = d.get("version", 1)
        if not isinstance(self.version, (int, float)) or isinstance(self.version, bool):
            raise ValueError("version du format illisible")
        self.library = Library.from_dict(d.get("library"))
        ensure_form(self.library)
        self.timeline = Timeline.from_dict(d.get("timeline") or {})
        if self.version < 3:
            self._keys_to_ratio()
        link_clips(self.library, self.timeline)
        self.grid = GridSettings.from_dict(d.get("grid"))
        net = d.get("network")
        self.network = dict(net) if isinstance(net, dict) else {}

    def _keys_to_ratio(self):
        """Anciens projets : instants des clés en secondes → proportion de la durée du clip."""
        first = {}
        for _, c in self.timeline.all_clips():
            first.setdefault(c.def_id, c)
            for a in c.automations:
                for k in a.keys:
                    k.t = c.u(k.t)
        for dfn in self.library.defs:
            c = first.get(dfn.id)
            for a in dfn.automations:
                for k in a.keys:
                    k.t = c.u(k.t) if c is not None else k.t

    def save(self, path):
        data = self.to_dict()
        tl = data["timeline"]
        # Chemin de la musique relatif au projet quand c'est possible
        if tl.get("audio_path"):
            try:
                tl["audio_path"] = os.path.relpath(tl["audio_path"], os.path.dirname(os.path.abspath(path)))
            except ValueError:
                pass
        write_json(path, data, separators=(",", ":"))
        self.path = path

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        doc = cls()
        doc.load_dict(d)
        doc.to_dict()      # le projet lu doit pouvoir être réenregistré (sinon : fichier abîmé)
        ap = doc.timeline.audio_path
        if ap and not os.path.isabs(ap):
            doc.timeline.audio_path = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(path)), ap))
        doc.path = path
        return doc
