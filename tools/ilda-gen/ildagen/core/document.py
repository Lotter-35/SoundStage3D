"""Document (projet) : formes, timeline, réglages enregistrés avec le projet."""

import json
import os

from .library import Library, ShapeDef, link_clips
from .timeline import Timeline

PROJECT_EXT = ".ildaproj"
FORMAT_VERSION = 2


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

    def to_dict(self):
        return dict(self.__dict__)

    @classmethod
    def from_dict(cls, d):
        g = cls()
        g.__dict__.update({k: v for k, v in (d or {}).items() if k in g.__dict__})
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

    def to_dict(self):
        return {"version": FORMAT_VERSION, "library": self.library.to_dict(),
                "timeline": self.timeline.to_dict(), "grid": self.grid.to_dict(), "network": dict(self.network)}

    def load_dict(self, d):
        self.library = Library.from_dict(d.get("library"))
        ensure_form(self.library)
        self.timeline = Timeline.from_dict(d.get("timeline", {}))
        link_clips(self.library, self.timeline)
        self.grid = GridSettings.from_dict(d.get("grid"))
        self.network = dict(d.get("network", {}))

    def save(self, path):
        data = self.to_dict()
        tl = data["timeline"]
        # Chemin de la musique relatif au projet quand c'est possible
        if tl.get("audio_path"):
            try:
                tl["audio_path"] = os.path.relpath(tl["audio_path"], os.path.dirname(os.path.abspath(path)))
            except ValueError:
                pass
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
        self.path = path

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        doc = cls()
        doc.load_dict(d)
        ap = doc.timeline.audio_path
        if ap and not os.path.isabs(ap):
            doc.timeline.audio_path = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(path)), ap))
        doc.path = path
        return doc
