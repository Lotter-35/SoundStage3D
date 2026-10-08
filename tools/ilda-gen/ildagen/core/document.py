"""Document (projet) : formes, timeline (Show), live, maîtres, réglages enregistrés avec le projet."""

import json
import math
import os

from .atomic import write_json
from .legacy import legacy_library
from .library import Library, ShapeDef
from .live import LiveSet
from .masters import Masters
from .placement import resolve_overlaps
from .timeline import Timeline

PROJECT_EXT = ".ildaproj"
# 5 : refonte Forme / Show / Live (oscillateurs, animations des clips, live, maîtres) ;
# 3 : clés d'automation en proportion de la durée du clip (anciennes automations, abandonnées en 5)
FORMAT_VERSION = 5
LEGACY_MESSAGE = "Projet d'une ancienne version : les animations ont été retirées"
WORKSPACES = ("forme", "show", "live")


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


def default_view():
    """État d'affichage du projet (hors annulation) : espace actif, page du live, dispositions des espaces."""
    return {"workspace": "forme", "live_page": "", "layouts": {}}


def load_view(d):
    v = default_view()
    if isinstance(d, dict):
        if d.get("workspace") in WORKSPACES:
            v["workspace"] = d["workspace"]
        if isinstance(d.get("live_page"), str):
            v["live_page"] = d["live_page"]
        if isinstance(d.get("layouts"), dict):
            v["layouts"] = dict(d["layouts"])
    return v


class Document:
    """Un projet = des formes + la timeline qui les joue (Show) + les pages de cues (Live)."""

    def __init__(self):
        self.library = Library()
        ensure_form(self.library)
        self.timeline = Timeline()
        self.live = LiveSet()
        self.masters = Masters()       # état d'affichage (hors annulation), enregistré
        self.grid = GridSettings()     # état d'affichage (hors annulation), enregistré
        self.view = default_view()     # état d'affichage (hors annulation), enregistré
        self.network = {}      # copie des réglages réseau au moment de l'enregistrement
        self.path = ""         # fichier du projet
        self.version = FORMAT_VERSION   # version du format du fichier lu (plus récent : avertir)
        self.animations_dropped = False  # ancien projet (v1–v4) dont les automations ont été abandonnées

    def load_notice(self):
        """Message à montrer après l'ouverture (ancien projet dont les animations ont été retirées), ou ""."""
        return LEGACY_MESSAGE if self.animations_dropped else ""

    def to_dict(self):
        return {"version": FORMAT_VERSION, "library": self.library.to_dict(),
                "timeline": self.timeline.to_dict(), "live": self.live.to_dict(),
                "masters": self.masters.to_dict(), "grid": self.grid.to_dict(), "view": dict(self.view),
                "network": dict(self.network)}

    def load_dict(self, d):
        if not isinstance(d, dict) or not isinstance(d.get("library", []), list):
            raise ValueError("ce fichier n'est pas un projet ILDA Gen")
        self.version = d.get("version", 1)
        if not isinstance(self.version, (int, float)) or isinstance(self.version, bool):
            raise ValueError("version du format illisible")
        raw_lib = [x for x in d.get("library") or [] if isinstance(x, dict)]
        tl_d = d.get("timeline") if isinstance(d.get("timeline"), dict) else {}
        remap = {}
        self.animations_dropped = False
        if self.version < 5:
            raw_lib, remap, self.animations_dropped = legacy_library(raw_lib, tl_d)
        self.library = Library.from_dict(raw_lib)
        ensure_form(self.library)
        self.timeline = Timeline.from_dict(tl_d)
        for _, c in self.timeline.all_clips():
            c.def_id = remap.get(c.def_id, c.def_id)
        resolve_overlaps(self.timeline)        # jamais de chevauchement sur une piste
        self.timeline.link_animations()        # chaque clip a son animation, liée par forme (D5)
        self.live = LiveSet.from_dict(d.get("live"))
        self.masters = Masters.from_dict(d.get("masters"))
        self.grid = GridSettings.from_dict(d.get("grid"))
        self.view = load_view(d.get("view"))
        net = d.get("network")
        self.network = dict(net) if isinstance(net, dict) else {}

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
