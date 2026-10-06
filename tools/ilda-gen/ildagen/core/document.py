"""Document (projet) : scène, formes personnalisées, timeline, réglages enregistrés avec le projet."""

import json
import os

from .library import Library
from .nodes import GroupNode, node_from_dict
from .timeline import Timeline

PROJECT_EXT = ".ildaproj"
FORMAT_VERSION = 1


class GridSettings:
    MODES = ["Aucune", "Orthogonale", "Polaire"]

    def __init__(self):
        self.mode = 1          # 0 aucune, 1 orthogonale, 2 polaire
        self.divisions = 8     # cases par demi-axe (orthogonale)
        self.rings = 8         # cercles (polaire)
        self.rays = 16         # rayons (polaire)
        self.snap = True       # aimant : les poignées de redimensionnement s'accrochent à la grille

    def to_dict(self):
        return dict(self.__dict__)

    @classmethod
    def from_dict(cls, d):
        g = cls()
        g.__dict__.update({k: v for k, v in (d or {}).items() if k in g.__dict__})
        return g


MAIN_NAME = "Forme principale"


def ensure_main_group(scene):
    """La scène contient toujours UN groupe principal, en tête, qui contient tous les calques."""
    main = next((c for c in scene.children if c.kind == "group" and getattr(c, "main", False)), None)
    if main is None:
        main = GroupNode(MAIN_NAME)
        main.main = True
    for c in list(scene.children):
        if c is not main:
            scene.remove(c)
            main.add(c)
    if main.parent is not scene:
        scene.add(main, 0)
    main.expanded = True
    return main


class Document:
    def __init__(self):
        self.scene = GroupNode("Scène")
        ensure_main_group(self.scene)
        self.library = Library()
        self.timeline = Timeline()
        self.grid = GridSettings()
        self.network = {}      # copie des réglages réseau au moment de l'enregistrement
        self.path = ""         # fichier du projet

    @property
    def main_group(self):
        return ensure_main_group(self.scene)

    def to_dict(self):
        return {"version": FORMAT_VERSION, "scene": self.scene.to_dict(), "library": self.library.to_dict(),
                "timeline": self.timeline.to_dict(), "grid": self.grid.to_dict(), "network": dict(self.network)}

    def load_dict(self, d):
        self.scene = node_from_dict(d["scene"]) if "scene" in d else GroupNode("Scène")
        ensure_main_group(self.scene)
        self.library = Library.from_dict(d.get("library"))
        self.timeline = Timeline.from_dict(d.get("timeline", {}))
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
