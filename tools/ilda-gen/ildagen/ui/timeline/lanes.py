"""Lignes d'un clip déplié : une par réglage d'effet en mode « Courbe », dans l'ordre des effets puis des
réglages. Nom écrit dans le clip : « Rotation », « Taille · Échelle X » (effet à plusieurs courbes),
« Masquer · Hexagone » (effet qui vise un calque), « Rayon · Cercle » (Réglage de la forme)."""

from ...core.effects import SHAPE_PARAM, effect_specs, get as get_effect
from .geometry import Lane


def curve_specs(effect, root):
    """[ParamSpec] des réglages de l'effet en mode « Courbe »."""
    out = []
    for sp in effect_specs(effect, root):
        t = effect.params.get(sp.key)
        if t is not None and t.mode == "courbe":
            out.append(sp)
    return out


def lane_label(effect, spec, root, several):
    et = get_effect(effect.type_id)
    node = root.find(effect.target) if (root is not None and effect.target) else None
    if effect.type_id == SHAPE_PARAM:
        parts = [spec.label if spec is not None else "Réglage"]
    else:
        parts = [et.label if et is not None else effect.type_id]
        if several and spec is not None:
            parts.append(spec.label)
    if node is not None:
        parts.append(node.name)
    return " · ".join(parts)


def clip_lanes(editor, clip, small=()):
    """([Lane], repliable) d'un clip : lignes seulement s'il est déplié ; repliable = il a des courbes."""
    tl = editor.doc.timeline
    anim = tl.animations.get(clip.anim_id)
    if anim is None or not anim.effects:
        return [], False
    d = editor.doc.library.get(clip.def_id)
    root = d.root if d is not None else None
    lanes = []
    foldable = False
    for e in anim.effects:
        specs = curve_specs(e, root)
        if not specs:
            continue
        foldable = True
        if not clip.expanded:
            break
        for sp in specs:
            ln = Lane(e, sp.key, sp, lane_label(e, sp, root, len(specs) > 1), (clip.id, e.id, sp.key) in small)
            lanes.append(ln)
    return lanes, foldable
