"""Tests du modèle de la refonte (v5) : oscillateurs, effets d'animation, liaison des clips, pas de
chevauchement, fondus, live, maîtres, fichier v5 et anciens projets. Importés par test_core.py."""

import json
import math
import os
import tempfile

import numpy as np

from ildagen.core.animation import ParamTrack, new_effect
from ildagen.core.document import Document, FORMAT_VERSION, LEGACY_MESSAGE
from ildagen.core.effects import SHAPE_PARAM, by_category, get as get_effect
from ildagen.core.evaluator import evaluate_form, evaluate_timeline
from ildagen.core.live import QUICK_EFFECTS, SLOTS, LiveSet, Page, default_key, normalize_key
from ildagen.core.masters import Masters, SpeedClock, apply_masters
from ildagen.core.nodes import GroupNode, ModifierNode, ShapeNode, clone_node
from ildagen.core.oscillator import DIVISIONS, Osc, can_oscillate, division_label, osc_overrides
from ildagen.core.param_specs import param_spec
from ildagen.core import placement as P
from ildagen.core.path import Stroke
from ildagen.core.timeline import Clip
from ildagen.editor.live_runtime import LiveRuntime, evaluate_live


def _doc_with_rect(x=0.0):
    doc = Document()
    d = doc.library.defs[0]
    r = ShapeNode("rect", (x - 0.1, -0.1, x + 0.1, 0.1))
    d.root.add(r)
    return doc, d, r


def _clip(doc, d, start=0.0, duration=4.0, track=0):
    c = Clip(d.id, start, duration)
    doc.timeline.tracks[track].clips.append(c)
    doc.timeline.attach(c)
    return c


def _xs(strokes):
    return sorted(round(float(s.pts[:, 0].mean()), 6) for s in strokes)


# ── Oscillateurs ─────────────────────────────────────────────────────────────

def test_osc_waves_and_cadence():
    spec = param_spec(ShapeNode("rect"), "tf.tx")
    o = Osc("onde", "sine", depth=0.5, sync=False, hz=1.0)
    assert abs(o.value(0.1, 0.25, spec) - 0.6) < 1e-9 and abs(o.value(0.1, 0.75, spec) + 0.4) < 1e-9
    sq = Osc("onde", "square", depth=1.0, sync=False, hz=2.0)
    assert sq.value(0.0, 0.1) == 1.0 and sq.value(0.0, 0.3) == -1.0
    tri = Osc("onde", "triangle", depth=1.0, sync=False, hz=1.0)
    assert abs(tri.value(0.0, 0.25) - 1.0) < 1e-9 and abs(tri.value(0.0, 0.0)) < 1e-9
    # Calé sur le tempo : 1 temps à 120 BPM = 0,5 s ; les cycles partent du début de la mesure 1
    s = Osc("onde", "sine", depth=1.0, sync=True, division=DIVISIONS.index(1.0))
    assert abs(s.value(0.0, 0.125, None, 120.0) - 1.0) < 1e-9
    assert abs(s.value(0.0, 0.3 + 0.125, None, 120.0, bar_offset=0.3) - 1.0) < 1e-9
    # Bornes du réglage
    big = Osc("onde", "sine", depth=50.0, sync=False, hz=1.0)
    assert big.value(0.0, 0.25, spec) == spec.max
    # Aléatoire lissé : même résultat à chaque lecture, sans saut
    r = Osc("onde", "random", depth=1.0, sync=False, hz=1.0)
    vals = [r.value(0.0, k / 100.0) for k in range(300)]
    assert vals == [r.value(0.0, k / 100.0) for k in range(300)]
    assert max(abs(a - b) for a, b in zip(vals, vals[1:])) < 0.1 and max(abs(v) for v in vals) <= 1.0


def test_osc_speed_wraps_bounded_params():
    rot = param_spec(ShapeNode("rect"), "tf.rot")          # -360..360 : reboucle
    o = Osc("vitesse", speed=90.0, sync=False)
    assert abs(o.value(0.0, 2.0, rot) - 180.0) < 1e-9
    v = o.value(0.0, 10.0, rot)                             # 900° → 180°
    assert -360.0 <= v < 360.0 and abs((v - 900.0) % 720.0) < 1e-9
    # Par temps quand c'est calé sur le tempo (120 BPM : 2 temps par seconde)
    assert abs(Osc("vitesse", speed=10.0, sync=True).value(0.0, 1.0, None, 120.0) - 20.0) < 1e-9
    tx = param_spec(ShapeNode("rect"), "tf.tx")
    assert Osc("vitesse", speed=1.0, sync=False).value(0.0, 1e6, tx) <= tx.max


def test_osc_division_labels_and_numeric_only():
    assert division_label(0, 4) == "4 mesures" and division_label(2, 4) == "1 mesure"
    assert division_label(4, 4) == "1 temps" and division_label(7, 4) == "1/8 de temps"
    assert division_label(0, 3) == "16 temps" and division_label(3, 2) == "1 mesure"
    m = ModifierNode("radial_sym")
    assert can_oscillate(param_spec(m, "count")) and can_oscillate(param_spec(m, "angle"))
    assert not can_oscillate(param_spec(m, "kaleido")) and not can_oscillate(param_spec(ModifierNode("rotate"), "pivot"))
    assert not can_oscillate(param_spec(ShapeNode("rect"), "col.color"))


def test_osc_saved_cloned_and_evaluated():
    doc, d, r = _doc_with_rect()
    r.osc["tf.tx"] = Osc("onde", "sine", depth=0.5, sync=False, hz=1.0)
    m = ModifierNode("rotate")
    m.osc["angle"] = Osc("vitesse", speed=90.0, sync=False)
    d.root.add(m, 0)
    strokes, animated = evaluate_form(d, doc.library, 0.25, 120.0)
    assert animated
    # Rotation de 22,5° autour du centre du carré décalé de 0,5
    assert abs(strokes[0].pts[:, 0].mean() - 0.5) < 1e-6
    c = clone_node(r)
    assert c.osc["tf.tx"].depth == 0.5 and c.osc["tf.tx"] is not r.osc["tf.tx"]
    doc2 = Document()
    doc2.load_dict(json.loads(json.dumps(doc.to_dict())))
    n = doc2.library.defs[0].root.find(r.id)
    assert n.osc["tf.tx"].to_dict() == r.osc["tf.tx"].to_dict()
    assert r.transform.tx == 0.0                       # la valeur de base n'est jamais touchée


def test_osc_inside_placed_form():
    doc, d, r = _doc_with_rect()
    r.osc["tf.ty"] = Osc("onde", "square", depth=0.3, sync=False, hz=1.0)
    from ildagen.core.library import ShapeDef
    from ildagen.core.nodes import InstanceNode
    outer = doc.library.add(ShapeDef("B"))
    outer.root.add(InstanceNode(d.id))
    from ildagen.core.evaluator import EvalContext
    ctx = EvalContext(doc.library, 0.1)
    ov = osc_overrides(outer.root, 0.1, ctx)
    assert abs(ov[(r.id, "tf.ty")] - 0.3) < 1e-9 and ctx.animated


# ── Effets d'animation ───────────────────────────────────────────────────────

def test_effects_registry():
    cats = dict(by_category())
    names = {c: [e.label for e in es] for c, es in cats.items()}
    assert names["Mouvement"] == ["Rotation", "Taille", "Position", "Bascule 3D"]
    assert names["Apparition"] == ["Fondu", "Dessin progressif", "Masquer"]
    assert names["Division"] == ["Répétition", "Symétrie radiale", "Éclatement"]
    assert names["Couleur et rythme"] == ["Couleur", "Arc-en-ciel", "Stroboscope", "Pulsation"]
    assert names["Déformation"] == ["Onde"] and names["Avancé"] == ["Réglage de la forme"]
    assert get_effect("hide").spec("hidden").label == "Masqué"
    assert get_effect("color").spec("mix").label == "Dosage"


def test_effects_target_layer_and_whole_form():
    doc = Document()
    d = doc.library.defs[0]
    a, b = ShapeNode("rect", (-0.6, -0.1, -0.4, 0.1)), ShapeNode("rect", (0.4, -0.1, 0.6, 0.1))
    d.root.add(a)
    d.root.add(b)
    c = _clip(doc, d, 0.0, 4.0)
    anim = doc.timeline.animations[c.anim_id]
    e1 = new_effect("translate", target=a.id)
    e1.params["y"].value = 0.3
    e2 = new_effect("translate")
    e2.params["x"].value = 0.1
    anim.effects += [e1, e2]
    out, _ = evaluate_timeline(doc.timeline, doc.library, 1.0)
    ys = {round(float(s.pts[:, 0].mean()), 6): round(float(s.pts[:, 1].mean()), 6) for s in out}
    assert ys == {-0.4: 0.3, 0.6: 0.0}, ys                 # le calque visé seul monte, tout se décale en X
    # Masquer le calque visé ; effet coupé = sans effet
    e3 = new_effect("hide", target=b.id)
    anim.effects.append(e3)
    out, _ = evaluate_timeline(doc.timeline, doc.library, 1.0)
    assert _xs(out) == [-0.4]
    e3.enabled = False
    assert len(evaluate_timeline(doc.timeline, doc.library, 1.0)[0]) == 2
    # Calque supprimé : l'effet qui le visait ne fait plus rien
    d.root.remove(a)
    out, _ = evaluate_timeline(doc.timeline, doc.library, 1.0)
    assert _xs(out) == [0.6]


def test_effect_shape_param_and_order():
    doc, d, r = _doc_with_rect()
    c = _clip(doc, d, 2.0, 4.0)
    anim = doc.timeline.animations[c.anim_id]
    spec = param_spec(r, "tf.tx")
    e = new_effect(SHAPE_PARAM, r.id, "tf.tx", 0.0, spec)
    e.params["value"].mode = "courbe"
    e.params["value"].curve.set_key(0.0, 0.0)
    e.params["value"].curve.set_key(1.0, 0.8)
    anim.effects.append(e)
    out, animated = evaluate_timeline(doc.timeline, doc.library, 4.0)        # milieu du clip
    assert animated and abs(out[0].pts[:, 0].mean() - 0.4) < 1e-6
    assert r.transform.tx == 0.0
    # Éclatement : chaque tracé s'écarte du centre
    d.root.add(ModifierNode("repeat", {"count": 2, "dx": 0.4, "centered": True}), 0)
    anim.effects = [new_effect("burst")]
    anim.effects[0].params["amount"].value = 0.1
    xs = _xs(evaluate_timeline(doc.timeline, doc.library, 3.0)[0])
    assert abs(xs[0] + 0.3) < 1e-6 and abs(xs[1] - 0.3) < 1e-6, xs


def test_effect_track_modes_and_linked_durations():
    """Courbe en proportion de la durée : deux clips liés de durées différentes jouent la même courbe."""
    doc, d, r = _doc_with_rect()
    c1 = _clip(doc, d, 0.0, 4.0)
    c2 = _clip(doc, d, 5.0, 2.0)
    assert c1.anim_id == c2.anim_id
    e = new_effect("translate")
    t = e.params["x"]
    t.mode = "courbe"
    t.curve.set_key(0.0, 0.0)
    t.curve.set_key(1.0, 0.8)
    doc.timeline.animations[c1.anim_id].effects.append(e)
    x1 = evaluate_timeline(doc.timeline, doc.library, 2.0)[0][0].pts[:, 0].mean()
    x2 = evaluate_timeline(doc.timeline, doc.library, 6.0)[0][0].pts[:, 0].mean()
    assert abs(x1 - 0.4) < 1e-6 and abs(x2 - 0.4) < 1e-6, (x1, x2)
    # Oscillateur : temps local du clip, × maître Vitesse
    t.mode = "osc"
    t.value = 0.0
    t.osc = Osc("onde", "sine", depth=0.2, sync=False, hz=1.0)
    x = evaluate_timeline(doc.timeline, doc.library, 5.25)[0][0].pts[:, 0].mean()
    assert abs(x - 0.2) < 1e-6
    x = evaluate_timeline(doc.timeline, doc.library, 5.125, speed=2.0)[0][0].pts[:, 0].mean()
    assert abs(x - 0.2) < 1e-6
    pt = ParamTrack.from_dict(t.to_dict())
    assert pt.mode == "osc" and pt.osc.depth == 0.2 and len(pt.curve.keys) == 2


def test_clip_fades():
    doc, d, r = _doc_with_rect()
    c = _clip(doc, d, 0.0, 4.0)
    c.set_fades(1.0, 2.0)
    lum = [evaluate_timeline(doc.timeline, doc.library, t)[0][0].col.max() for t in (0.0, 0.5, 1.5, 3.0, 3.5)]
    assert np.allclose(lum, [0.0, 0.5, 1.0, 0.5, 0.25]), lum
    c.set_fades(3.0, 3.0)                              # somme ≤ durée
    assert abs(c.fade_in + c.fade_out - 4.0) < 1e-9
    c.duration = 2.0
    assert c.fade_in + c.fade_out <= 2.0 + 1e-9
    c2 = Clip.from_dict(c.to_dict())
    assert abs(c2.fade_in - c.fade_in) < 1e-6


# ── Liaison (D5) et pas de chevauchement ─────────────────────────────────────

def test_clip_linking_rules():
    doc, d, r = _doc_with_rect()
    tl = doc.timeline
    c1 = _clip(doc, d, 0.0, 2.0)
    tl.animations[c1.anim_id].effects.append(new_effect("rotate"))
    c2 = _clip(doc, d, 3.0, 2.0)
    assert c2.anim_id == c1.anim_id and tl.link_state(c1) == (True, [])
    a2 = tl.unlink(c2)
    assert c2.anim_id == a2.id != c1.anim_id
    assert a2.effects[0].id != tl.animations[c1.anim_id].effects[0].id and a2.effects[0].type_id == "rotate"
    assert tl.link_state(c2) == (False, [c1.anim_id])
    assert tl.relink(c2) is tl.animations[c1.anim_id] and a2.id not in tl.animations    # inutile : oubliée
    other = doc.library.add(type(d)("Autre"))
    c3 = _clip(doc, other, 6.0, 1.0)
    assert c3.anim_id != c1.anim_id and tl.relink(c3, c1.anim_id) is None          # pas la même forme
    tl.tracks[0].clips.remove(c3)
    tl.prune_animations()
    assert set(tl.animations) == {c1.anim_id}


def test_no_overlap_placement():
    doc, d, r = _doc_with_rect()
    tr = doc.timeline.tracks[0]
    a, b = _clip(doc, d, 0.0, 2.0), _clip(doc, d, 4.0, 2.0)
    assert P.place_after(tr, 1.0, 1.0) == 2.0 and P.place_after(tr, 1.0, 3.0) == 6.0
    assert P.fit_start(tr, 3.5, 2.0, [a]) == 2.0                # contre le voisin
    assert P.fit_start(tr, 5.5, 2.0, [a]) == 6.0                # au-delà : intervalle libre suivant
    assert P.resize_limits(tr, a) == (0.0, 4.0)
    assert P.group_delta([(tr, a, 0.0)], 3.0) == 2.0 and P.group_delta([(tr, b, 4.0)], -10.0) == -2.0
    c = Clip(d.id, 1.0, 2.0)                                     # ancien projet : chevauchement
    tr.clips.append(c)
    assert P.resolve_overlaps(doc.timeline) == 1 and len(doc.timeline.tracks) == 2
    assert doc.timeline.tracks[1].clips == [c] and c.start == 1.0


# ── Live ─────────────────────────────────────────────────────────────────────

def test_live_set_keys_and_file():
    assert default_key(0) == "A" and default_key(8) == "Q" and default_key(23) == ";" and default_key(31) == "8"
    assert normalize_key("z") == "Z" and normalize_key("é") == "2"
    ls = LiveSet()
    p = ls.pages[0]
    from ildagen.core.live import Cue
    p.cues[3] = Cue("forme", default_key(3))
    ls.pages.append(Page("Refrain"))
    ls.launch, ls.multi = 2, True
    ls2 = LiveSet.from_dict(json.loads(json.dumps(ls.to_dict())))
    assert len(ls2.pages) == 2 and ls2.pages[0].cues[3].key == "R" and ls2.launch == 2 and ls2.multi
    assert len(ls2.pages[0].cues) == SLOTS and ls2.pages[0].cue_for_key("r").def_id == "forme"
    assert LiveSet.from_dict({"launch": 7, "multi": "oui", "pages": "x"}).launch == 1


def test_live_runtime_quantize_single_multi():
    rt = LiveRuntime(SpeedClock(1.0, 0.0), origin=0.0)      # 120 BPM : temps 0,5 s, mesure 2 s
    assert rt.next_start(0.7, 0, 120.0) == 0.7
    assert rt.next_start(0.7, 1, 120.0) == 1.0 and rt.next_start(1.0005, 1, 120.0) == 1.0
    assert rt.next_start(0.7, 2, 120.0, 4) == 2.0
    assert rt.trigger("a", "A", 0.7, 2, False, 120.0)
    assert rt.state("a", 1.0) == "waiting" and rt.state("a", 2.0) == "playing"
    # Un seul cue : le suivant arrête le précédent à son départ
    assert rt.trigger("b", "B", 2.2, 1, False, 120.0)
    assert rt.state("a", 2.4) == "playing" and rt.state("a", 2.5) is None and rt.state("b", 2.5) == "playing"
    # Plusieurs cues : ils jouent ensemble ; relancer un cue l'arrête (au prochain départ calé)
    assert rt.trigger("c", "C", 3.0, 0, True, 120.0)
    assert {pc.cue_id for pc in rt.active(3.1)} == {"b", "c"}
    assert not rt.trigger("c", "C", 3.2, 1, True, 120.0)
    assert rt.state("c", 3.4) == "playing" and rt.state("c", 3.6) is None
    # En attente puis relancé : annulé
    rt.trigger("d", "D", 4.1, 2, True, 120.0)
    assert not rt.trigger("d", "D", 4.2, 2, True, 120.0) and rt.state("d", 6.5) is None


def test_live_evaluation_and_quick_effects():
    doc, d, r = _doc_with_rect(0.3)
    r.osc["tf.ty"] = Osc("onde", "square", depth=0.2, sync=False, hz=1.0)
    clock = SpeedClock(1.0, 0.0)
    rt = LiveRuntime(clock, origin=0.0)
    rt.trigger("a", d.id, 1.0, 0, False, 120.0)
    out, _ = evaluate_live(doc, rt, 0.9)
    assert out == []
    out, _ = evaluate_live(doc, rt, 1.1)                     # temps local 0,1 s : carré en haut
    assert abs(out[0].pts[:, 1].mean() - 0.2) < 1e-6
    # Maître Vitesse : le temps local accélère sans saut
    clock.set_speed(2.0, 1.1)
    a = evaluate_live(doc, rt, 1.1)[0][0].pts[:, 1].mean()
    assert abs(a - 0.2) < 1e-6 and abs(clock.at(1.3) - 1.5) < 1e-9
    # Effets rapides : Fondu noir progressif, Miroir
    rt.hold("blackout", 2.0)
    half = evaluate_live(doc, rt, 2.125)[0][0].col.max()     # 0,25 s accélérées sur 0,5 s d'attaque
    assert abs(half - 0.5) < 1e-6
    rt.release("blackout")
    rt.hold("mirror", 2.2)
    out, _ = evaluate_live(doc, rt, 2.3)
    assert _xs(out) == [-0.3, 0.3]
    assert [q.label for q in QUICK_EFFECTS] == ["Strobo 1/8", "Rotation", "Arc-en-ciel", "Fondu noir",
                                                 "Pulsation", "Onde", "Miroir", "Points"]
    for q in QUICK_EFFECTS:
        rt.held = {q.id: 2.0}
        out, _ = evaluate_live(doc, rt, 2.6)
        assert all(len(s.pts) == len(s.col) for s in out), q.id


# ── Maîtres ──────────────────────────────────────────────────────────────────

def test_masters_apply_and_ranges():
    m = Masters()
    s = [Stroke([[0.5, 0.0], [0.5, 0.5]], color=(0.0, 0.5, 0.0))]
    assert apply_masters(s, m) is s                           # neutres : rien ne change
    m.set("size", 50.0)
    m.set("rotation", 90.0)
    m.set("x", 0.1)
    m.set("color", (1.0, 0.0, 0.0))
    m.set("brightness", 50.0)
    out = apply_masters(s, m)
    assert np.allclose(out[0].pts, [[0.1, 0.25], [-0.15, 0.25]])
    assert np.allclose(out[0].col, [[0.25, 0.0, 0.0]] * 2)
    assert np.allclose(s[0].pts, [[0.5, 0.0], [0.5, 0.5]])  # l'entrée n'est jamais modifiée
    assert m.set("size", 999) == 200.0 and m.set("speed", -1) == 0.0 and m.set("brightness", "abc") == 50.0
    assert m.set("color", "rouge") is None
    m2 = Masters.from_dict(json.loads(json.dumps(m.to_dict())))
    assert m2.signature() == m.signature()
    c = SpeedClock(1.0, 10.0)
    c.set_speed(0.5, 12.0)
    assert abs(c.at(12.0) - 2.0) < 1e-9 and abs(c.at(14.0) - 3.0) < 1e-9


# ── Fichier v5 et anciens projets ────────────────────────────────────────────

def test_v5_round_trip():
    doc, d, r = _doc_with_rect()
    r.osc["tf.rot"] = Osc("vitesse", speed=45.0)
    c = _clip(doc, d, 1.0, 3.0)
    c.set_fades(0.5, 0.25)
    anim = doc.timeline.animations[c.anim_id]
    e = new_effect("strobe", target=r.id)
    e.params["duty"].mode = "courbe"
    e.params["duty"].curve.set_key(0.5, 20.0)
    anim.effects.append(e)
    from ildagen.core.timeline import Marker
    doc.timeline.markers.append(Marker(4.0, "Refrain", "#ff3d00"))
    doc.timeline.tracks[0].color = "#d500f9"
    from ildagen.core.live import Cue
    doc.live.pages[0].cues[0] = Cue(d.id, "A")
    doc.masters.set("size", 80.0)
    doc.view["workspace"] = "show"
    path = os.path.join(tempfile.mkdtemp(), "v5.ildaproj")
    doc.save(path)
    with open(path) as f:
        raw = json.load(f)
    assert raw["version"] == FORMAT_VERSION == 5 and "live" in raw and "masters" in raw
    doc2 = Document.load(path)
    assert doc2.to_dict() == dict(doc.to_dict(), timeline=dict(doc.to_dict()["timeline"], audio_path=""))
    assert not doc2.animations_dropped and doc2.load_notice() == ""


def _legacy_project():
    """Projet v4 : automations dans la forme et les clips, un clip délié (copie cachée), deux clips qui se
    chevauchent."""
    shape = ShapeNode("rect")
    root = GroupNode("A")
    root.add(shape)
    auto = {"id": "a1", "node_id": shape.id, "key": "tf.tx", "label": "X", "discrete": False,
            "keys": [{"t": 0.0, "v": 0.0, "c": "linear"}, {"t": 1.0, "v": 0.5, "c": "linear"}]}
    hidden_root = clone_node(root)
    lib = [{"id": "A", "name": "A", "root": root.to_dict(), "automations": [auto]},
           {"id": "H", "name": "A", "root": hidden_root.to_dict(), "automations": [auto], "hidden": True, "source": "A"},
           {"id": "O", "name": "Orpheline", "root": GroupNode("O").to_dict(), "hidden": True, "source": "disparue"}]
    clips = [{"id": "c1", "def_id": "A", "start": 0.0, "duration": 4.0, "automations": [auto], "lane_sizes": {}},
             {"id": "c2", "def_id": "H", "start": 6.0, "duration": 2.0, "closed_nodes": []},
             {"id": "c3", "def_id": "A", "start": 2.0, "duration": 2.0},
             {"id": "c4", "def_id": "O", "start": 9.0, "duration": 1.0}]
    return {"version": 4, "library": lib, "timeline": {"bpm": 128, "tracks": [{"name": "Piste 1", "clips": clips}]}}


def test_legacy_import():
    for version in (3, 4):
        data = _legacy_project()
        data["version"] = version
        doc = Document()
        doc.load_dict(data)
        assert doc.animations_dropped and doc.load_notice() == LEGACY_MESSAGE
        assert [x.id for x in doc.library.defs] == ["A", "O"]         # copie cachée abandonnée (sauf orpheline)
        clips = {c.id: (tr, c) for tr, c in doc.timeline.all_clips()}
        assert clips["c2"][1].def_id == "A" and clips["c4"][1].def_id == "O"
        tl = doc.timeline
        # Animations vides, liées par forme
        assert tl.animations[clips["c1"][1].anim_id].effects == []
        assert len({c.anim_id for _, c in tl.all_clips() if c.def_id == "A"}) == 1
        assert len(tl.animations) == 2
        # Plus de chevauchement : c3 (2 → 4) chevauchait c1 (0 → 4)
        assert clips["c3"][0] is not clips["c1"][0] and clips["c3"][1].start == 2.0
        out = evaluate_timeline(tl, doc.library, 2.0)[0]
        assert all(abs(float(s.pts[:, 0].mean())) < 1e-6 for s in out)     # plus aucune automation
        d = doc.to_dict()
        assert "automations" not in json.dumps(d) and "hidden" not in json.dumps(d)
    old = Document()
    old.load_dict({"version": 2, "library": [{"id": "A", "name": "A", "root": GroupNode("A").to_dict()}]})
    assert not old.animations_dropped and old.load_notice() == ""


def test_view_state_outside_history():
    """Grille, maîtres, espace actif, clips / calques dépliés : hors de la comparaison d'historique,
    gardés après un rechargement (annuler / rétablir)."""
    from ildagen.core import view_state as VS
    from ildagen.core.history import History
    doc, d, r = _doc_with_rect()
    g = GroupNode("G")
    d.root.add(g)
    clip = _clip(doc, d, 0.0, 2.0)
    h = History(strip=VS.strip)
    h.begin("x", doc.to_dict())
    doc.grid.mode, doc.grid.sym, doc.grid.snap = 2, 1, False
    clip.expanded, g.expanded = True, False
    doc.masters.set("brightness", 40.0)
    doc.view["workspace"] = "live"
    assert not h.commit(doc.to_dict())          # seul l'affichage a changé : pas d'étape
    view = VS.capture(doc)
    doc2 = Document()
    doc2.load_dict(Document().to_dict() | {"library": doc.library.to_dict(), "timeline": doc.timeline.to_dict()})
    VS.apply(doc2, view)
    c2 = doc2.timeline.tracks[0].clips[0]
    assert doc2.grid.mode == 2 and doc2.grid.sym == 1 and not doc2.grid.snap
    assert c2.expanded and not doc2.library.defs[0].root.find(g.id).expanded
    assert doc2.masters.brightness == 40.0 and doc2.view["workspace"] == "live"


def test_hide_and_burst_effects_alone():
    from ildagen.core.evaluator import EvalContext
    from ildagen.core.library import Library
    ctx = EvalContext(Library())
    s = [Stroke([[0.2, 0.0], [0.4, 0.0]]), Stroke([[-0.4, 0.0], [-0.2, 0.0]])]
    assert get_effect("hide").apply(s, {"hidden": True}, ctx) == []
    out = get_effect("burst").apply(s, {"amount": 0.1, "center": 1}, ctx)
    assert np.allclose(out[0].pts[:, 0], [0.3, 0.5]) and np.allclose(out[1].pts[:, 0], [-0.5, -0.3])
    assert math.isclose(get_effect("burst").spec("amount").default, 0.2)
