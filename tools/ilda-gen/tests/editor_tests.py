"""Tests des opérations de l'éditeur (sans fenêtre) : espaces, oscillateurs, clips, effets, marqueurs,
pistes, live, maîtres ; tout est annulable sauf l'état d'affichage. Importés par test_core.py."""

import os

from ildagen.core.effects import SHAPE_PARAM
from ildagen.core.nodes import ShapeNode
from ildagen.core.oscillator import Osc
from ildagen.core.settings import Settings
from ildagen.editor.state import EditorState


def _editor():
    ed = EditorState(Settings(path=os.devnull))
    r = ShapeNode("rect", (-0.1, -0.1, 0.1, 0.1))
    ed.add_node(r)
    return ed, ed.current_form(), r


def _steps(ed):
    return len(ed.history.undo_stack)


def test_editor_workspace_and_masters_outside_history():
    ed, d, r = _editor()
    seen = []
    ed.workspaceChanged.connect(seen.append)
    n = _steps(ed)
    ed.set_workspace("show")
    ed.set_master("size", 50.0)
    ed.set_master("speed", 2.0)
    assert ed.workspace == "show" and seen == ["show"] and ed.doc.view["workspace"] == "show"
    assert _steps(ed) == n and ed.doc.masters.size == 50.0 and ed.clock.speed == 2.0
    ed.set_workspace("rien")
    assert ed.workspace == "show"
    ed.enter_def(d.id)
    assert ed.workspace == "forme" and ed.editing_visible()


def test_editor_oscillators_undo():
    ed, d, r = _editor()
    o = ed.set_osc(r, "tf.rot", Osc("vitesse", speed=90.0, sync=False))
    assert o is not None and r.osc["tf.rot"].speed == 90.0
    assert ed.set_osc(r, "col.color") is None and "col.color" not in r.osc
    ed.undo()
    assert not ed.find(r.id).osc
    ed.redo()
    node = ed.find(r.id)
    assert node.osc["tf.rot"].mode == "vitesse"
    ed.clear_osc(node, "tf.rot")
    assert not ed.find(r.id).osc
    # La mire tourne en boucle, la valeur de base ne bouge pas
    ed.set_osc(ed.find(r.id), "tf.tx", Osc("onde", "square", depth=0.4, sync=False, hz=1.0))
    ed.clock.restart(ed.clock.anchor - 0.1)
    xs = ed.display_strokes()[0].pts[:, 0].mean()
    assert abs(xs - 0.4) < 1e-6 and ed.find(r.id).transform.tx == 0.0 and ed.is_animated()


def test_editor_clips_tracks_markers():
    ed, d, r = _editor()
    tl = ed.doc.timeline
    tr = tl.tracks[0]
    c1 = ed.add_clip(d.id, tr.id, 0.0, 2.0)
    c2 = ed.add_clip(d.id, tr.id, 1.0, 2.0)               # place occupée : juste après
    assert c2.start == 2.0 and c2.anim_id == c1.anim_id
    ed.move_clip(c2.id, 1.0)
    assert ed.doc.timeline.find_clip(c2.id)[1].start == 2.0   # borné contre le voisin
    ed.resize_clip(c1.id, end=5.0)
    assert ed.doc.timeline.find_clip(c1.id)[1].end == 2.0
    ed.set_clip_fades(c1.id, 0.5, 0.5)
    assert ed.doc.timeline.find_clip(c1.id)[1].fade_in == 0.5
    ed.unlink_clip(c2.id)
    c1, c2 = ed.doc.timeline.find_clip(c1.id)[1], ed.doc.timeline.find_clip(c2.id)[1]
    assert c2.anim_id != c1.anim_id and ed.clip_is_linked(c2) == (False, False)
    ed.relink_clip(c2.id)
    c1, c2 = ed.doc.timeline.find_clip(c1.id)[1], ed.doc.timeline.find_clip(c2.id)[1]
    assert c2.anim_id == c1.anim_id and ed.clip_is_linked(c2) == (True, True)
    ed.undo()
    assert ed.doc.timeline.find_clip(c2.id)[1].anim_id != ed.doc.timeline.find_clip(c1.id)[1].anim_id
    dup = ed.duplicate_clip(c1.id)
    assert dup.start >= 4.0 - 1e-9 and dup.anim_id == ed.doc.timeline.find_clip(c1.id)[1].anim_id
    ed.select_clips([c1.id, c2.id], c2.id)
    assert ed.current_clip().id == c2.id and ed.clip_selection == [c1.id, c2.id]
    ed.copy_clips(ed.selected_clip_items(), 0.0, 4.0)
    a, b, pasted = ed.paste_clips(1.0)                    # même place occupée : autre piste
    assert len(ed.doc.timeline.tracks) == 2 and all(p.anim_id for p in pasted) and ed.playhead == 5.0
    # Pistes et marqueurs
    t2 = ed.add_track()
    ed.rename_track(t2.id, "Lasers")
    ed.set_track_color(t2.id, "#ff4081")
    ed.move_track(t2.id, 0)
    tl = ed.doc.timeline
    assert tl.tracks[0].name == "Lasers" and tl.tracks[0].color == "#ff4081"
    m = ed.add_marker(8.0, "Refrain")
    ed.move_marker(m.id, 4.0)
    ed.rename_marker(m.id, "Couplet")
    assert [(x.t, x.name) for x in ed.doc.timeline.markers] == [(4.0, "Couplet")]
    n = _steps(ed)
    ed.undo()
    ed.undo()
    assert ed.doc.timeline.markers[0].t == 8.0 and _steps(ed) == n - 2
    ed.delete_clips(ed.selected_clip_items())
    assert ed.current_clip() is None and ed.clip_selection == []


def test_editor_effects_undo():
    ed, d, r = _editor()
    c = ed.add_clip(d.id, None, 0.0, 4.0)
    e = ed.add_effect(c.id, "rotate")
    e2 = ed.add_effect(c.id, "translate")
    ed.move_effect(e2.id, 0)
    anim = ed.doc.timeline.animations[ed.doc.timeline.find_clip(c.id)[1].anim_id]
    assert [x.type_id for x in anim.effects] == ["translate", "rotate"]
    ed.set_track_value(e2.id, "x", 99.0)
    assert anim.find(e2.id).params["x"].value == 4.0          # borné par le réglage
    ed.set_track_mode(e2.id, "x", "courbe")
    keys = anim.find(e2.id).params["x"].curve.keys
    assert [k.t for k in keys] == [0.0, 1.0]
    i = ed.set_curve_key(e2.id, "x", 0.5, 0.2)
    assert i == 1 and ed.move_curve_key(e2.id, "x", 1, u=0.25, v=0.3) == 1
    ed.set_curve_type(e2.id, "x", 0, "hold")
    ed.remove_curve_key(e2.id, "x", 2)
    t = ed.find_effect(e2.id)[1].params["x"]
    assert [(k.t, k.v) for k in t.curve.keys] == [(0.0, 4.0), (0.25, 0.3)] and t.curve.keys[0].curve == "hold"
    ed.set_track_mode(e.id, "pivot", "osc")                    # liste : pas d'oscillateur
    assert ed.find_effect(e.id)[1].params["pivot"].mode == "fixe"
    ed.set_track_mode(e.id, "angle", "osc")
    assert ed.find_effect(e.id)[1].params["angle"].osc is not None
    ed.set_effect_enabled(e.id, False)
    ed.set_effect_target(e.id, r.id)
    assert ed.find_effect(e.id)[1].target == r.id and not ed.find_effect(e.id)[1].enabled
    sp = ed.add_effect(c.id, SHAPE_PARAM, r.id, "tf.rot")
    assert sp.params["value"].value == 0.0 and ed.effect_param_spec(sp.id, "value").max == 360.0
    ed.set_effect_target(sp.id, r.id, "tf.sx")
    assert ed.find_effect(sp.id)[1].key == "tf.sx" and ed.find_effect(sp.id)[1].params["value"].value == 1.0
    assert ed.add_effect(c.id, SHAPE_PARAM, "inconnu", "tf.rot") is None
    n = len(ed.find_effect(e.id)[0].effects)
    ed.remove_effect(e.id)
    assert ed.find_effect(e.id)[1] is None
    ed.undo()
    assert ed.find_effect(e.id)[1] is not None and len(ed.find_effect(e.id)[0].effects) == n
    # Pendant un geste (glisser) : une seule étape pour toutes les valeurs
    s = _steps(ed)
    ed.begin("Glisser")
    for v in (10.0, 20.0, 30.0):
        ed.set_track_value(e2.id, "y", v / 100.0)
    ed.commit()
    assert _steps(ed) == s + 1 and ed.find_effect(e2.id)[1].params["y"].value == 0.3


def test_editor_live_ops():
    ed, d, r = _editor()
    page = ed.live_page()
    cue = ed.set_cue(page.id, 9, d.id)
    assert cue.key == "S" and ed.live_page().cues[9].def_id == d.id
    ed.set_cue_key(cue.id, "a")
    other = ed.set_cue(page.id, 0, d.id)
    assert other.key == ""                                    # « A » est déjà pris sur la page
    ed.set_cue_key(other.id, "A")                             # une touche = une seule case
    assert ed.doc.live.find_cue(other.id)[2].key == "A" and ed.doc.live.find_cue(cue.id)[2].key == ""
    ed.set_cue_key(cue.id, "A")
    ed.set_launch(0)
    ed.set_multi(True)
    n = _steps(ed)
    assert ed.trigger_key("a", now=10.0) is not None and ed.cue_state(cue.id, now=10.0) == "playing"
    ed.hold_quick("strobe", now=10.0)
    assert ed.runtime.held and _steps(ed) == n                 # lancer / tenir : hors annulation
    ed.set_workspace("live")
    assert ed.is_animated()
    ed.release_quick("strobe")
    assert not ed.trigger_cue(cue.id, now=10.5) and ed.cue_state(cue.id, now=10.6) is None
    p2 = ed.add_page()
    assert ed.live_page() is p2 and len(ed.doc.live.pages) == 2
    ed.rename_page(p2.id, "Refrain")
    ed.move_page(p2.id, 0)
    assert ed.doc.live.pages[0].name == "Refrain"
    ed.clear_cue(page.id, 9)
    assert ed.doc.live.find_cue(cue.id)[2] is None
    ed.undo()
    assert ed.doc.live.find_cue(cue.id)[2] is not None
    ed.delete_def(d.id)                                       # forme supprimée : ses cases se vident
    assert not list(ed.doc.live.all_cues())
