import math

try:
    from .transform import Transform2D
except (ImportError, ValueError):
    from core.transform import Transform2D


class Layer:
    """Modèle de Calque / Forme / Groupe hiérarchique."""

    def __init__(self, id_: int, name: str, shape_type: str, color=(0, 255, 128), children=None):
        self.id = id_
        self.name = name
        self.shape_type = shape_type  # "line", "circle", "point", "pencil", "group"
        self.x = 0.0                  # Centre X (-1.0 à +1.0)
        self.y = 0.0                  # Centre Y (-1.0 à +1.0)
        self.scale_x = 1.0
        self.scale_y = 1.0
        self.rotation = 0.0           # Degrés
        self.color = color
        self.enabled = True
        self.is_closed = (shape_type == "circle")
        self.is_expanded = True
        self.children: list["Layer"] = list(children) if children else []
        self.local_points: list[tuple[float, float]] = self._init_default_points()

    def _init_default_points(self) -> list[tuple[float, float]]:
        if self.shape_type == "line":
            return [(-0.55, 0.0), (0.55, 0.0)]
        elif self.shape_type == "circle":
            r = 0.45
            return [(r * math.cos(math.radians(a)), r * math.sin(math.radians(a))) for a in range(0, 360, 6)]
        elif self.shape_type == "point":
            return [(0.0, 0.0)]
        return []

    def get_local_matrix(self) -> Transform2D:
        return Transform2D.from_trs(self.x, self.y, self.scale_x, self.scale_y, self.rotation)

    def get_local_points(self) -> list[tuple[float, float]]:
        if self.shape_type == "group":
            pts = []
            for child in self.children:
                if child.enabled:
                    pts.extend(child.get_unclamped_world_points())
            return pts if pts else [(0.0, 0.0)]
        return self.local_points

    def clone(self) -> "Layer":
        """Crée une copie indépendante complète du calque (y compris récursivement pour les enfants)."""
        dup = Layer(self.id, self.name, self.shape_type, self.color)
        dup.x = self.x
        dup.y = self.y
        dup.scale_x = self.scale_x
        dup.scale_y = self.scale_y
        dup.rotation = self.rotation
        dup.enabled = self.enabled
        dup.is_closed = self.is_closed
        dup.is_expanded = self.is_expanded
        dup.local_points = list(self.local_points)
        dup.children = [child.clone() for child in self.children]
        return dup

    def to_dict(self) -> dict:
        """Sérialise le calque et ses sous-calques en dictionnaire JSON."""
        return {
            "id": self.id,
            "name": self.name,
            "shape_type": self.shape_type,
            "x": round(self.x, 6),
            "y": round(self.y, 6),
            "scale_x": round(self.scale_x, 6),
            "scale_y": round(self.scale_y, 6),
            "rotation": round(self.rotation, 4),
            "color": list(self.color),
            "enabled": bool(self.enabled),
            "is_closed": bool(self.is_closed),
            "is_expanded": bool(self.is_expanded),
            "local_points": [[round(p[0], 6), round(p[1], 6)] for p in self.local_points],
            "children": [child.to_dict() for child in self.children]
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Layer":
        """Reconstruit un calque et ses enfants depuis un dictionnaire JSON."""
        color = tuple(d.get("color", [0, 255, 128]))
        children_data = d.get("children", [])
        children = [cls.from_dict(c) for c in children_data]
        lay = cls(
            id_=d.get("id", 1),
            name=d.get("name", "Calque"),
            shape_type=d.get("shape_type", "point"),
            color=color,
            children=children
        )
        lay.x = float(d.get("x", 0.0))
        lay.y = float(d.get("y", 0.0))
        lay.scale_x = float(d.get("scale_x", 1.0))
        lay.scale_y = float(d.get("scale_y", 1.0))
        lay.rotation = float(d.get("rotation", 0.0))
        lay.enabled = bool(d.get("enabled", True))
        lay.is_closed = bool(d.get("is_closed", False))
        lay.is_expanded = bool(d.get("is_expanded", True))
        raw_pts = d.get("local_points")
        if raw_pts is not None:
            lay.local_points = [(float(p[0]), float(p[1])) for p in raw_pts]
        return lay

    def world_to_local(self, wx: float, wy: float) -> tuple[float, float]:
        """Convertit coordonnées world laser (wx, wy) en coordonnées locales de la forme (lx, ly)."""
        inv_mat = self.get_local_matrix().invert()
        return inv_mat.apply(wx, wy)

    def get_unclamped_world_points(self, x=None, y=None, scale_x=None, scale_y=None, rotation=None, parent_mat: Transform2D | None = None) -> list[tuple[float, float]]:
        """Calcule les points réels dans l'espace laser sans clamp de sécurité."""
        px = self.x if x is None else x
        py = self.y if y is None else y
        sx_val = self.scale_x if scale_x is None else scale_x
        sy_val = self.scale_y if scale_y is None else scale_y
        rot = self.rotation if rotation is None else rotation

        pts = self.get_local_points()
        my_mat = Transform2D.from_trs(px, py, sx_val, sy_val, rot)
        world_mat = parent_mat.multiply(my_mat) if parent_mat else my_mat
        return [world_mat.apply(lx, ly) for lx, ly in pts]

    def get_laser_bounds(self, x=None, y=None, scale_x=None, scale_y=None, rotation=None, parent_mat: Transform2D | None = None) -> tuple[float, float, float, float]:
        """Retourne (min_x, min_y, max_x, max_y) des points réels de la forme."""
        wpts = self.get_unclamped_world_points(x, y, scale_x, scale_y, rotation, parent_mat=parent_mat)
        if not wpts:
            px = self.x if x is None else x
            py = self.y if y is None else y
            return px, py, px, py
        xs = [p[0] for p in wpts]
        ys = [p[1] for p in wpts]
        return min(xs), min(ys), max(xs), max(ys)

    def fits_in_laser(self, x=None, y=None, scale_x=None, scale_y=None, rotation=None, parent_mat: Transform2D | None = None, tol=1e-5) -> bool:
        """Vérifie si tous les points de la forme restent strictement dans la fenêtre laser [-1.0, 1.0]."""
        min_x, min_y, max_x, max_y = self.get_laser_bounds(x, y, scale_x, scale_y, rotation, parent_mat=parent_mat)
        return (min_x >= -1.0 - tol and max_x <= 1.0 + tol and
                min_y >= -1.0 - tol and max_y <= 1.0 + tol)

    def get_world_points(self) -> list[tuple[float, float]]:
        wpts = self.get_unclamped_world_points()
        return [(max(-1.0, min(1.0, x)), max(-1.0, min(1.0, y))) for x, y in wpts]

    def get_render_strokes(self, parent_mat: Transform2D | None = None) -> list[tuple[list[tuple[float, float]], tuple[int, int, int], bool, str]]:
        """Retourne la liste récursive des tracés [(points_laser_world, color, is_closed, shape_type)] pour le calque ou sur-calque."""
        if not self.enabled:
            return []
        my_mat = self.get_local_matrix()
        world_mat = parent_mat.multiply(my_mat) if parent_mat else my_mat

        if self.shape_type == "group":
            strokes = []
            for child in self.children:
                if child.enabled:
                    strokes.extend(child.get_render_strokes(world_mat))
            return strokes

        pts = self.local_points
        world_pts = []
        for lx, ly in pts:
            wx, wy = world_mat.apply(lx, ly)
            world_pts.append((max(-1.0, min(1.0, wx)), max(-1.0, min(1.0, wy))))
        return [(world_pts, self.color, self.is_closed, self.shape_type)]

    def get_laser_stroke(self) -> list[tuple[int, int, int, int, int]]:
        wpts = self.get_world_points()
        if not wpts:
            return []
        stroke = []
        r, g, b = self.color
        for wx, wy in wpts:
            ix = int(round(wx * 32767))
            iy = int(round(wy * 32767))
            stroke.append((ix, iy, r, g, b))
        return stroke
