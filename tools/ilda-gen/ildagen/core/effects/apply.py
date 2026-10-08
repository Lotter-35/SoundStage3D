"""Évaluation d'un clip de la timeline : forme (oscillateurs au temps local du clip), effets d'animation,
fondus d'entrée et de sortie.

Valeur d'un réglage d'effet : fixe, courbe(u) avec u = (t − début) / durée, ou oscillateur(temps local).
Les effets qui visent un calque s'appliquent au résultat de ce calque pendant le parcours de l'arbre
(`ctx.node_effects`), ceux qui visent toute la forme au résultat final, dans l'ordre de la liste.
« Réglage de la forme » passe par les remplacements (`ctx.overrides`).
"""

from ..evaluator import EvalContext, evaluate
from ..oscillator import osc_overrides
from . import SHAPE_PARAM, get, effect_spec


def effect_values(effect, etype, u, t_local, bpm):
    """{clé: valeur} des réglages d'un effet à la position u (0..1) et au temps local t_local."""
    out = {}
    for sp in etype.params():
        track = effect.params.get(sp.key)
        if track is not None:
            out[sp.key] = track.value_at(u, t_local, sp, bpm)
    return out


def prepare_effects(anim, root, ctx, u, t_local):
    """Range les effets actifs : remplacements (« Réglage de la forme »), effets par calque (dans ctx) ;
    renvoie la liste des effets sur toute la forme [(type, valeurs)]."""
    whole = []
    if anim is None:
        return whole
    for e in anim.effects:
        if not e.enabled:
            continue
        if any(t.is_animated() for t in e.params.values()):
            ctx.animated = True
        if e.type_id == SHAPE_PARAM:
            node = root.find(e.target) if e.target else None
            sp = effect_spec(e, "value", root) if node is not None else None
            track = e.params.get("value")
            if sp is not None and track is not None:
                ctx.overrides[(node.id, e.key)] = track.value_at(u, t_local, sp, ctx.bpm)
            continue
        et = get(e.type_id)
        if et is None or et.mod is None:
            continue
        values = effect_values(e, et, u, t_local, ctx.bpm)
        if e.target:
            if root.find(e.target) is not None:        # calque supprimé depuis : l'effet ne fait rien
                ctx.node_effects.setdefault(e.target, []).append((et, values))
        else:
            whole.append((et, values))
    return whole


def apply_effects(whole, strokes, ctx):
    for et, values in whole:
        strokes = et.apply(strokes, values, ctx)
    return strokes


def fade(strokes, k):
    """Intensité multipliée par k (fondus d'entrée / sortie)."""
    if k >= 1.0:
        return strokes
    k = max(0.0, k)
    return [s.with_col(s.col * k) for s in strokes]


def clip_strokes(timeline, library, clip, t, default_color=(1.0, 1.0, 1.0), speed=1.0):
    """Tracés d'un clip à l'instant t de la timeline. Renvoie (tracés, animé)."""
    d = library.get(clip.def_id)
    if d is None:
        return [], False
    t_local = t - clip.start
    u = min(1.0, max(0.0, clip.u(t_local)))
    lt = max(0.0, t_local) * max(0.0, float(speed))          # temps local des oscillateurs (× maître Vitesse)
    ctx = EvalContext(library, t, timeline.bpm, default_color, None, timeline.bar_offset)
    ctx.overrides = osc_overrides(d.root, lt, ctx, bar_offset=0.0)
    whole = prepare_effects(timeline.animations.get(clip.anim_id), d.root, ctx, u, lt)
    strokes = evaluate(d.root, ctx)
    strokes = apply_effects(whole, strokes, ctx)
    gain = clip.fade_gain(t_local)
    if clip.fade_in > 0 or clip.fade_out > 0:
        ctx.animated = True
    return fade(strokes, gain), ctx.animated
