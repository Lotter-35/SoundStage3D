"""Tests du cœur (sans interface) : python -m pytest tools/ilda-gen/tests  ou  python tools/ilda-gen/tests/test_core.py"""

import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ildagen.core.nodes import ShapeNode, GroupNode, ModifierNode, InstanceNode, clone_node  # noqa: E402
from ildagen.core.library import Library, ShapeDef  # noqa: E402
from ildagen.core.evaluator import EvalContext, evaluate, evaluate_timeline, node_quad  # noqa: E402
from ildagen.core.modifiers import registry  # noqa: E402
from ildagen.core.document import Document  # noqa: E402
from ildagen.core.history import History  # noqa: E402
from ildagen.core.timeline import Clip  # noqa: E402
from ildagen.core.automation import Automation  # noqa: E402
from ildagen.core.settings import Settings  # noqa: E402
from ildagen.laser.optimizer import build_points  # noqa: E402
from ildagen.laser.output import apply_output  # noqa: E402
from ildagen.laser.idn import IdnPacketBuilder  # noqa: E402
from ildagen.laser.ilda_file import write_ilda  # noqa: E402


def ctx(lib=None, **kw):
    return EvalContext(lib or Library(), **kw)


def test_shape_and_color_modifier():
    root = GroupNode("Scène")
    root.add(ModifierNode("color", {"color": (1.0, 0.0, 0.0)}))
    root.add(ShapeNode("rect", (-0.5, -0.5, 0.5, 0.5)))
    root.add(ShapeNode("ellipse", (-0.2, -0.2, 0.2, 0.2)))
    out = evaluate(root, ctx())
    assert len(out) == 2
    assert np.allclose(out[0].col[0], (1, 0, 0))
    # modifieur placé sous une forme : n'agit pas sur elle
    root.children.insert(1, root.children.pop(0))
    out = evaluate(root, ctx())
    assert np.allclose(out[0].col[0], (1, 1, 1)) or np.allclose(out[1].col[0], (1, 1, 1))


def test_group_scope():
    root = GroupNode()
    g = GroupNode("G")
    g.add(ModifierNode("color", {"color": (0.0, 0.0, 1.0)}))
    g.add(ShapeNode("rect"))
    root.add(g)
    root.add(ShapeNode("ellipse"))
    out = evaluate(root, ctx())
    cols = sorted(tuple(np.round(s.col[0], 2)) for s in out)
    assert (0.0, 0.0, 1.0) in cols and (1.0, 1.0, 1.0) in cols


def test_all_modifiers_run():
    for type_id, mod in registry.items():
        root = GroupNode()
        root.add(ModifierNode(type_id))
        root.add(ShapeNode("star", (-0.5, -0.5, 0.5, 0.5)))
        root.add(ShapeNode("line", (-0.8, 0.2, 0.8, 0.3)))
        out = evaluate(root, ctx(time=0.37))
        for s in out:
            assert s.pts.shape[1] == 2 and len(s.pts) == len(s.col), type_id
        pts, col = build_points(out, Settings(path=os.devnull).section("laser"))
        assert len(pts) == len(col), type_id


def test_symmetry_counts():
    root = GroupNode()
    root.add(ModifierNode("mirror_sym", {"axes": 2}))
    root.add(ShapeNode("line", (0.1, 0.1, 0.5, 0.2)))
    assert len(evaluate(root, ctx())) == 4
    root.children[0].values["axes"] = 4
    assert len(evaluate(root, ctx())) == 8


def test_sub_modifier_moves_symmetry_center():
    root = GroupNode()
    sym = ModifierNode("mirror_sym", {"axes": 1, "angle": 90.0})
    sym.add(ModifierNode("translate", {"x": 0.5}))
    root.add(sym)
    root.add(ShapeNode("line", (0.6, 0.0, 0.7, 0.0)))
    out = evaluate(root, ctx())
    xs = sorted(round(float(s.pts[:, 0].mean()), 3) for s in out)
    assert xs == [0.35, 0.65]


def test_dots_phase_from_translation():
    root = GroupNode()
    dots = ModifierNode("dots", {"spacing": 0.1, "ends": False})
    root.add(dots)
    root.add(ShapeNode("line", (-0.5, 0.0, 0.5, 0.0)))
    a = evaluate(root, ctx())[0].pts[0, 0]
    dots.add(ModifierNode("translate", {"x": 0.05}))
    b = evaluate(root, ctx())[0].pts[0, 0]
    assert abs((b - a) - 0.05) < 1e-6


def test_instances_and_quads():
    lib = Library()
    inner = GroupNode("Def")
    inner.add(ShapeNode("rect", (-0.2, -0.2, 0.2, 0.2)))
    d = lib.add(ShapeDef("Carré", inner))
    root = GroupNode()
    inst = InstanceNode(d.id)
    inst.transform.tx = 0.5
    root.add(inst)
    out = evaluate(root, ctx(lib))
    assert abs(out[0].pts[:, 0].mean() - 0.5) < 1e-6
    q = node_quad(inst, ctx(lib))
    assert abs(q[:, 0].min() - 0.3) < 1e-6


def test_timeline_automation():
    doc = Document()
    g = GroupNode("Def")
    shape = ShapeNode("rect", (-0.1, -0.1, 0.1, 0.1))
    g.add(shape)
    d = doc.library.add(ShapeDef("A", g))
    clip = Clip(d.id, 1.0, 4.0)
    a = Automation()
    a.bind(shape.id, "tf.tx", "Position X")
    a.set_key(0.0, 0.0)
    a.set_key(1.0, 0.8)          # fin du clip (instants en proportion de la durée)
    clip.automations.append(a)
    doc.timeline.tracks[0].clips.append(clip)
    out, _ = evaluate_timeline(doc.timeline, doc.library, 3.0)
    assert abs(out[0].pts[:, 0].mean() - 0.4) < 1e-6
    out, _ = evaluate_timeline(doc.timeline, doc.library, 0.5)
    assert out == []


def test_save_load_and_history():
    doc = Document()
    form = doc.library.defs[0].root
    form.add(ShapeNode("star"))
    m = ModifierNode("gradient")
    form.add(m)
    h = History()
    h.begin("x", doc.to_dict())
    form.children[0].transform.tx = 0.3
    assert h.commit(doc.to_dict())
    before = h.undo(doc.to_dict())
    assert before["library"][0]["root"]["children"][0]["transform"]["tx"] == 0.0
    path = os.path.join(tempfile.mkdtemp(), "t.ildaproj")
    doc.save(path)
    doc2 = Document.load(path)
    assert doc2.library.defs[0].root.children[1].mod_type == "gradient"
    c = clone_node(doc2.library.defs[0].root)
    assert c.id != doc2.library.defs[0].root.id


def test_output_idn_ilda():
    s = Settings(path=os.devnull)
    root = GroupNode()
    root.add(ShapeNode("rect", (-0.5, -0.5, 0.5, 0.5)))
    pts, col = build_points(evaluate(root, ctx()), s.section("laser"))
    x, y, r, g, b = apply_output(pts, col, s)
    assert x.dtype == np.int16 and len(x) == len(pts)
    pk = IdnPacketBuilder().frame_packets(x, y, r, g, b, 1, 30000)
    assert pk and all(len(p) <= 1500 for p in pk)
    path = os.path.join(tempfile.mkdtemp(), "t.ild")
    write_ilda(path, [(x, y, r, g, b)] * 3, 5)
    data = open(path, "rb").read()
    assert data[:4] == b"ILDA" and data[7] == 5


def test_line_snaps_on_center():
    from ildagen.core.document import GridSettings
    from ildagen.core.grid import smart_snap
    g = GridSettings()
    # Ligne horizontale de -0.3 à 0.21 : son bord gauche est presque sur -0.25… mais seul le centre compte
    dx, dy, guides = smart_snap((-0.3, 0.1, 0.21, 0.1), [], g, 0.06)
    assert abs((-0.3 + 0.21) / 2 + dx) < 1e-9, dx


def test_always_one_form():
    from ildagen.core.document import next_form_name
    doc = Document()
    assert len(doc.library.defs) == 1 and doc.library.defs[0].name == "Forme 1"
    assert next_form_name(doc.library) == "Forme 2"
    doc.load_dict({"library": [], "timeline": {}})
    assert len(doc.library.defs) == 1


def test_rotation_intensity_keeps_size():
    """Rotation de 150° à 50 % d'intensité = rotation de 75°, la forme ne rétrécit pas."""
    root = GroupNode()
    root.add(ModifierNode("rotate", values={"angle": 150.0, "mix": 50.0, "pivot": 2}))
    root.add(ShapeNode("rect", (0.2, -0.1, 0.6, 0.1)))
    ref = GroupNode()
    ref.add(ModifierNode("rotate", values={"angle": 75.0, "pivot": 2}))
    ref.add(ShapeNode("rect", (0.2, -0.1, 0.6, 0.1)))
    a = np.vstack([s.pts for s in evaluate(root, ctx())])
    b = np.vstack([s.pts for s in evaluate(ref, ctx())])
    assert np.allclose(a, b, atol=1e-9)


def test_click_cycles_curve():
    from ildagen.core.automation import Automation
    a = Automation()
    a.bind("n", "x", "x")
    a.set_key(0.0, 0.0)
    k1, k2 = a.set_key(1.0, 50.0), a.set_key(2.0, 100.0)
    assert abs(a.value_at(0.5) - 25.0) < 1e-4                                      # rampe par défaut
    assert a.cycle_curve(k1) == "Carré" and abs(a.value_at(0.9) - 0.0) < 1e-9       # reste à 0 puis saute à 50
    assert a.cycle_curve(k1) == "Sinusoïdale"
    v = a.value_at(0.25)
    assert 0.0 < v < 12.5                                                           # démarre doucement (en S)
    assert a.cycle_curve(k1) == "Rampe" and abs(a.value_at(0.5) - 25.0) < 1e-4
    assert a.cycle_curve(k2) == "Carré" and abs(a.value_at(1.9) - 50.0) < 1e-9      # 50 jusqu'au bout, puis 100


def test_int_param_progressive():
    """Un réglage entier (graine) animé varie progressivement entre deux points, arrondi à l'entier."""
    from ildagen.core.evaluator import EvalContext, resolve_params
    from ildagen.core.library import Library
    m = ModifierNode("random_color")
    c = EvalContext(Library(), 0.0, 120.0, (1.0, 1.0, 1.0), {(m.id, "seed"): 47.6})
    assert resolve_params(m, c)["seed"] == 48


def test_line_snaps_center_in_thickness():
    from ildagen.core.document import GridSettings
    from ildagen.core.grid import smart_snap
    g = GridSettings()
    # Trait horizontal (cadre d'épaisseur 0,02) dont le bord du haut est tout près de y = 0,25 : seul le milieu compte
    dx, dy, _ = smart_snap((-0.3, 0.232, 0.3, 0.252), [], g, 0.03)
    assert abs((0.232 + 0.252) / 2 + dy - 0.25) < 1e-9, dy


def test_random_color_chosen_palette():
    """Couleur aléatoire, palette « Couleurs choisies » : seules ces couleurs sont tirées."""
    root = GroupNode()
    root.add(ModifierNode("random_color", values={"palette": 2, "mode": 1, "colors": [(1, 0, 0), (0, 0, 1)]}))
    root.add(ShapeNode("polygon", (-0.5, -0.5, 0.5, 0.5)))
    cols = np.vstack([s.col for s in evaluate(root, ctx())])
    got = {tuple(np.round(c, 6)) for c in cols}
    assert got <= {(1.0, 0.0, 0.0), (0.0, 0.0, 1.0)} and len(got) == 2, got


def test_dots_keep_ends():
    """Dots : premier et dernier point toujours présents sur un tracé ouvert (option active par défaut)."""
    from ildagen.core.path import Path
    def run(ends):
        root = GroupNode()
        root.add(ModifierNode("dots", values={"spacing": 0.3, "phase": 0.1, "ends": ends}))
        root.add(ShapeNode("path", paths=[Path([[0.0, 0.0], [1.0, 0.0]])]))
        return evaluate(root, ctx())[0].pts
    on, off = run(True), run(False)
    assert np.allclose(on[0], [0, 0]) and np.allclose(on[-1], [1, 0])
    assert not np.allclose(off[0], [0, 0]) and np.diff(on[:, 0]).min() >= 0.15 - 1e-9


def test_linked_clips_share_automations():
    from ildagen.core.automation import Automation
    from ildagen.core.timeline import Clip
    doc = Document()
    d = doc.library.visible()[0]
    m = ModifierNode("rotate")
    d.root.add(m)
    tr = doc.timeline.tracks[0]
    c1, c2 = Clip(d.id, 0, 2), Clip(d.id, 3, 2)
    a1 = Automation()
    a1.bind(m.id, "angle", "Angle")
    a1.set_key(0.0, 90.0)
    a2 = Automation()
    a2.bind(m.id, "angle", "Angle")
    a2.set_key(0.0, 180.0)
    c1.automations, c2.automations = [a1], [a2]
    tr.clips += [c1, c2]
    data = doc.to_dict()
    for x in data["library"]:
        x.pop("automations", None)          # ancien format : automations rangées dans les clips
    old = Document()
    old.load_dict(data)
    k1, k2 = old.timeline.tracks[0].clips
    assert k1.def_id == d.id and k2.def_id != d.id and old.library.get(k2.def_id).hidden
    assert k1.automations[0].keys[0].v == 90.0 and k2.automations[0].keys[0].v == 180.0
    # Nouveau format : les clips liés partagent la même liste après réouverture
    k2.def_id = d.id
    data2 = old.to_dict()
    new = Document()
    new.load_dict(data2)
    n1, n2 = new.timeline.tracks[0].clips
    assert n1.automations is n2.automations and not any(x.hidden for x in new.library.defs)


def test_linked_clips_different_durations():
    """Clips liés de durées différentes : la même courbe, jouée sur la durée de chacun."""
    from ildagen.core.automation import Automation
    from ildagen.core.timeline import Clip
    doc = Document()
    d = doc.library.visible()[0]
    shape = ShapeNode("rect", (-0.1, -0.1, 0.1, 0.1))
    d.root.add(shape)
    a = Automation()
    a.bind(shape.id, "tf.tx", "X")
    a.set_key(0.0, 0.0)
    a.set_key(1.0, 0.8)
    d.automations.append(a)
    c1, c2 = Clip(d.id, 0.0, 4.0), Clip(d.id, 5.0, 2.0)
    c1.automations = c2.automations = d.automations
    doc.timeline.tracks[0].clips += [c1, c2]
    x1 = evaluate_timeline(doc.timeline, doc.library, 2.0)[0][0].pts[:, 0].mean()     # milieu du clip 1
    x2 = evaluate_timeline(doc.timeline, doc.library, 6.0)[0][0].pts[:, 0].mean()     # milieu du clip 2
    assert abs(x1 - 0.4) < 1e-6 and abs(x2 - 0.4) < 1e-6, (x1, x2)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("OK  ", name)
