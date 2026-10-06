"""Évaluation de l'arbre des calques → tracés colorés.

Dans un groupe, la pile est parcourue de BAS en HAUT : chaque modifieur s'applique à tout ce qui a été
accumulé en dessous de lui. Un groupe renvoie son résultat comme un seul bloc à son parent.
"""

import numpy as np

from .modifiers import SUB_MODIFIER_TYPES
from .modifiers.base import blend
from .path import Stroke, strokes_bbox
from .transform import TRANSFORM_KEYS
from . import mathutil as mu
from . import shape_color

MAX_DEPTH = 12


class EvalContext:
    def __init__(self, library, time=0.0, bpm=120.0, default_color=(1.0, 1.0, 1.0), overrides=None):
        self.library = library
        self.time = time
        self.bpm = bpm
        self.default_color = tuple(default_color)
        self.overrides = overrides or {}    # {(node_id, clé): valeur}
        self.pivot = None
        self.depth = 0
        self.animated = False                # un modifieur dépend du temps qui passe

    def node_overrides(self, node_id):
        return {k: v for (nid, k), v in self.overrides.items() if nid == node_id}

    def is_visible(self, node):
        v = self.overrides.get((node.id, "__active__"))
        return node.visible if v is None else bool(v)


def node_transform(node, ctx):
    ov = {k[3:]: v for k, v in ctx.node_overrides(node.id).items() if k.startswith("tf.") and k[3:] in TRANSFORM_KEYS}
    return node.transform.with_overrides(ov) if ov else node.transform


def resolve_params(mnode, ctx):
    """Réglages effectifs d'un modifieur : valeurs + automations + sous-modifieurs."""
    mod = mnode.modifier
    p = dict(mod.defaults())
    p.update(mnode.values)
    for k, v in ctx.node_overrides(mnode.id).items():
        if k in p:
            spec = mod.spec(k)
            p[k] = spec.clamp(v) if spec is not None else v
    for sub in mnode.children:
        if sub.kind == "modifier" and ctx.is_visible(sub) and sub.mod_type in SUB_MODIFIER_TYPES:
            mod.absorb(sub.mod_type, resolve_params(sub, ctx), p)
    return p


def apply_modifier(mnode, strokes, ctx):
    mod = mnode.modifier
    if mod is None:
        return strokes
    p = resolve_params(mnode, ctx)
    if mod.is_animated(p):
        ctx.animated = True
    out = mod.apply(strokes, p, ctx)
    if mod.blendable and not getattr(mod, "self_mix", False):
        out = blend(strokes, out, p.get("mix", 100.0) / 100.0)
    return out


def eval_children(children, ctx):
    saved = ctx.pivot
    ctx.pivot = None
    acc = []
    for child in reversed(children):
        if not ctx.is_visible(child):
            continue
        if child.kind == "modifier":
            acc = apply_modifier(child, acc, ctx)
        else:
            acc.extend(eval_node(child, ctx))
    ctx.pivot = saved
    return acc


def shape_strokes(node, ctx):
    tf = node_transform(node, ctx)
    out = []
    for p in node.local_paths():
        if len(p.pts) == 0:
            continue
        out.append(Stroke(tf.apply(p.pts), None, p.closed, color=ctx.default_color))
    ov = ctx.node_overrides(node.id)
    col = {k: ov.get("col." + k, getattr(node, a)) for k, a in shape_color.ATTRS.items()}
    if int(round(col["mode"])):
        out = shape_color.colorize(out, int(round(col["mode"])), col["color"], col["stops"],
                                   int(round(col["type"])), float(col["angle"]))
    return out


def eval_node(node, ctx):
    """Tracés d'un nœud (sans tenir compte de sa propre visibilité)."""
    if node.kind == "shape":
        return shape_strokes(node, ctx)
    if node.kind == "group":
        res = eval_children(node.children, ctx)
        return transform_strokes(res, node_transform(node, ctx))
    if node.kind == "instance":
        d = ctx.library.get(node.def_id)
        if d is None or ctx.depth >= MAX_DEPTH:
            return []
        ctx.depth += 1
        res = eval_children(d.root.children, ctx)
        ctx.depth -= 1
        return transform_strokes(res, node_transform(node, ctx))
    return []


def transform_strokes(strokes, tf):
    if tf.is_identity():
        return strokes
    return [s.with_pts(tf.apply(s.pts)) for s in strokes]


def evaluate(root, ctx):
    """Tracés de tout un arbre (racine = groupe de scène ou de forme personnalisée)."""
    return eval_children(root.children, ctx)


def evaluate_timeline(timeline, library, t, default_color=(1.0, 1.0, 1.0)):
    """Tracés de tous les clips actifs à l'instant t. Renvoie (tracés, animé)."""
    out = []
    animated = False
    for _, clip in timeline.active_clips(t):
        d = library.get(clip.def_id)
        if d is None:
            continue
        ctx = EvalContext(library, t, timeline.bpm, default_color, clip.overrides_at(t - clip.start))
        out.extend(evaluate(d.root, ctx))
        animated = animated or ctx.animated
    return out, animated


# ── Géométrie pour la sélection dans la mire ─────────────────────────────────

def to_world(node, pts, ctx, stop=None):
    """Passe des points du repère du parent de node au repère de la racine (transformations des groupes)."""
    for a in node.ancestors():
        if a is stop or a.parent is None:
            break
        if a.has_transform:
            pts = node_transform(a, ctx).apply(pts)
    return pts


def local_content_bbox(node, ctx):
    """Boîte du contenu d'un nœud AVANT sa propre transformation."""
    if node.kind == "shape":
        return node.local_bbox()
    if node.kind == "group":
        return strokes_bbox(eval_children(node.children, ctx))
    if node.kind == "instance":
        d = ctx.library.get(node.def_id)
        return strokes_bbox(eval_children(d.root.children, ctx)) if d else None
    return None


def node_quad(node, ctx):
    """4 coins (repère racine) du cadre de sélection d'un nœud, ou None."""
    b = local_content_bbox(node, ctx)
    if b is None:
        return None
    x0, y0, x1, y1 = b
    if x1 - x0 < 1e-4:
        x0, x1 = x0 - 0.01, x1 + 0.01
    if y1 - y0 < 1e-4:
        y0, y1 = y0 - 0.01, y1 + 0.01
    corners = np.array([[x0, y1], [x1, y1], [x1, y0], [x0, y0]], dtype=float)   # HG, HD, BD, BG
    corners = node_transform(node, ctx).apply(corners)
    return to_world(node, corners, ctx)


def node_hit_strokes(node, ctx):
    """Tracés d'un nœud dans le repère racine (pour cliquer dessus)."""
    if not ctx.is_visible(node) or node.kind == "modifier":
        return []
    res = eval_node(node, ctx)
    return [s.with_pts(to_world(node, s.pts, ctx)) for s in res]


def hit_test(node, p, ctx, tol):
    for s in node_hit_strokes(node, ctx):
        if s.kind == "dots":
            if len(s.pts) and np.min(np.hypot(*(s.pts - p).T)) <= tol:
                return True
        elif mu.dist_point_segments(np.asarray(p, dtype=float), s.pts, s.closed) <= tol:
            return True
        elif s.closed and len(s.pts) > 2 and node.kind == "shape" and mu.point_in_polygon(p, s.pts):
            return True
    return False
