import json
import math
import os

try:
    from .layer import Layer
except (ImportError, ValueError):
    from core.layer import Layer


CUSTOM_SHAPES_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "save-ildagen",
    "custom_shapes.json"
)


def create_square_shape(layer_id_counter: int, color=(0, 255, 128), size: float = 0.4) -> tuple[Layer, int]:
    """Crée une forme liée 'Carré' composée de 4 calques lignes éditables."""
    cid = layer_id_counter + 1
    grp = Layer(cid, "Carré", "group", color=color)
    grp.locked = True
    grp.is_expanded = False

    # 4 lignes formant le contour du carré
    # 1. Haut
    cid += 1
    l_top = Layer(cid, "Ligne Haut", "line", color=color)
    l_top.local_points = [(-size, size), (size, size)]

    # 2. Droite
    cid += 1
    l_right = Layer(cid, "Ligne Droite", "line", color=color)
    l_right.local_points = [(size, size), (size, -size)]

    # 3. Bas
    cid += 1
    l_bottom = Layer(cid, "Ligne Bas", "line", color=color)
    l_bottom.local_points = [(size, -size), (-size, -size)]

    # 4. Gauche
    cid += 1
    l_left = Layer(cid, "Ligne Gauche", "line", color=color)
    l_left.local_points = [(-size, -size), (-size, size)]

    grp.children = [l_top, l_right, l_bottom, l_left]
    return grp, cid


def create_triangle_shape(layer_id_counter: int, color=(0, 255, 128), r: float = 0.45) -> tuple[Layer, int]:
    """Crée une forme liée 'Triangle' composée de 3 calques lignes éditables."""
    cid = layer_id_counter + 1
    grp = Layer(cid, "Triangle", "group", color=color)
    grp.locked = True
    grp.is_expanded = False

    # Sommets d'un triangle équilatéral pointant vers le haut
    p1 = (0.0, r)
    p2 = (r * math.cos(math.radians(210)), r * math.sin(math.radians(210)))
    p3 = (r * math.cos(math.radians(330)), r * math.sin(math.radians(330)))

    cid += 1
    l1 = Layer(cid, "Côté 1", "line", color=color)
    l1.local_points = [p1, p2]

    cid += 1
    l2 = Layer(cid, "Côté 2", "line", color=color)
    l2.local_points = [p2, p3]

    cid += 1
    l3 = Layer(cid, "Côté 3", "line", color=color)
    l3.local_points = [p3, p1]

    grp.children = [l1, l2, l3]
    return grp, cid


def create_star_shape(layer_id_counter: int, color=(0, 255, 128), r_outer: float = 0.45, r_inner: float = 0.20) -> tuple[Layer, int]:
    """Crée une forme liée 'Étoile' (5 branches) composée de 10 calques segments éditables."""
    cid = layer_id_counter + 1
    grp = Layer(cid, "Étoile", "group", color=color)
    grp.locked = True
    grp.is_expanded = False

    # 10 sommets en étoile (angles de 90° à 450° par pas de 36°)
    pts = []
    for i in range(10):
        deg = 90 + i * 36
        rad = math.radians(deg)
        r = r_outer if i % 2 == 0 else r_inner
        pts.append((round(r * math.cos(rad), 4), round(r * math.sin(rad), 4)))

    children = []
    for i in range(10):
        cid += 1
        seg = Layer(cid, f"Branche {i + 1}", "line", color=color)
        p_start = pts[i]
        p_end = pts[(i + 1) % 10]
        seg.local_points = [p_start, p_end]
        children.append(seg)

    grp.children = children
    return grp, cid


def load_user_custom_shapes() -> list[dict]:
    """Charge la liste des modèles de formes personnalisées sauvegardés sur le disque."""
    if not os.path.exists(CUSTOM_SHAPES_FILE):
        return []
    try:
        with open(CUSTOM_SHAPES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def save_user_custom_shapes(shapes: list[dict]):
    """Sauvegarde les modèles de formes personnalisées sur le disque."""
    try:
        os.makedirs(os.path.dirname(CUSTOM_SHAPES_FILE), exist_ok=True)
        with open(CUSTOM_SHAPES_FILE, "w", encoding="utf-8") as f:
            json.dump(shapes, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def instantiate_custom_template(template: dict, layer_id_counter: int) -> tuple[Layer, int]:
    """Instancie une forme personnalisée depuis son modèle sérialisé en attribuant de nouveaux IDs."""
    cid = layer_id_counter

    def clone_with_new_ids(d: dict) -> Layer:
        nonlocal cid
        cid += 1
        lay = Layer.from_dict(d)
        lay.id = cid
        new_children = []
        for ch in lay.children:
            ch_dict = ch.to_dict()
            new_children.append(clone_with_new_ids(ch_dict))
        lay.children = new_children
        return lay

    layer_data = template.get("layer_data", {})
    inst = clone_with_new_ids(layer_data)
    inst.locked = True
    return inst, cid
