"""État d'affichage enregistré avec le projet mais hors de l'historique (annuler ne le touche pas).

- la grille de la mire : type, densité, aimant, symétrie de dessin ;
- les clips : déplié / replié, modifieurs repliés, hauteur des lignes de réglage ;
- les calques : groupes / modifieurs dépliés dans la liste, réglages affichés dans la ligne.
"""

CLIP_KEYS = ("expanded", "closed_nodes", "lane_sizes")
NODE_KEYS = ("expanded", "show_params")


def strip(state):
    """Copie du dictionnaire d'un document sans l'état d'affichage (pour comparer les contenus)."""
    if not isinstance(state, dict):
        return state
    out = {k: v for k, v in state.items() if k != "grid"}
    lib = []
    for dfn in state.get("library", []) or []:
        if isinstance(dfn, dict) and isinstance(dfn.get("root"), dict):
            dfn = dict(dfn, root=_strip_node(dfn["root"]))
        lib.append(dfn)
    out["library"] = lib
    tl = state.get("timeline")
    if isinstance(tl, dict):
        tracks = []
        for tr in tl.get("tracks", []) or []:
            if isinstance(tr, dict):
                tr = dict(tr, clips=[{k: v for k, v in c.items() if k not in CLIP_KEYS} if isinstance(c, dict) else c
                                     for c in tr.get("clips", []) or []])
            tracks.append(tr)
        out["timeline"] = dict(tl, tracks=tracks)
    return out


def _strip_node(d):
    out = {k: v for k, v in d.items() if k not in NODE_KEYS}
    if "children" in d:
        out["children"] = [_strip_node(c) if isinstance(c, dict) else c for c in d.get("children") or []]
    return out


def capture(doc):
    """État d'affichage actuel d'un document."""
    clips = {c.id: (c.expanded, list(c.closed_nodes), dict(c.lane_sizes)) for _, c in doc.timeline.all_clips()}
    nodes = {}
    for dfn in doc.library.defs:
        for n in dfn.root.walk():
            nodes[(dfn.id, n.id)] = {k: getattr(n, k) for k in NODE_KEYS if hasattr(n, k)}
    return {"grid": doc.grid.to_dict(), "clips": clips, "nodes": nodes}


def apply(doc, view):
    """Remet l'état d'affichage capturé sur un document rechargé (objets encore présents seulement)."""
    from .document import GridSettings
    doc.grid = GridSettings.from_dict(view["grid"])
    clips = view["clips"]
    for _, c in doc.timeline.all_clips():
        if c.id in clips:
            c.expanded, closed, sizes = clips[c.id]
            c.closed_nodes, c.lane_sizes = list(closed), dict(sizes)
    nodes = view["nodes"]
    for dfn in doc.library.defs:
        for n in dfn.root.walk():
            for k, v in nodes.get((dfn.id, n.id), {}).items():
                setattr(n, k, v)
