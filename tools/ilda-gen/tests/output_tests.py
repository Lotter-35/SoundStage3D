"""Tests de la sortie laser (optimiseur, budget, sécurité, IDN, export ILDA) et des corrections de l'audit.
Importés par test_core.py (lancés avec lui)."""

import math
import os
import tempfile
import time

import numpy as np

from ildagen.core.nodes import ShapeNode, GroupNode, ModifierNode
from ildagen.core.library import Library
from ildagen.core.evaluator import EvalContext, evaluate
from ildagen.core.path import Stroke
from ildagen.core.settings import Settings
from ildagen.laser.optimizer import optimize
from ildagen.laser.output import apply_output
from ildagen.laser.pipeline import MAX_LIVE_POINTS, budget_for, render_frame

LASER = Settings(path=os.devnull).section("laser")


def _settings(**sections):
    s = Settings(path=os.devnull)
    for name, values in sections.items():
        s.section(name).update(values)
    return s


def _eval(*nodes, t=0.0, **kw):
    root = GroupNode()
    for n in nodes:
        root.add(n)
    return evaluate(root, EvalContext(Library(), t, **kw))


def _circle(size=0.5):
    return ShapeNode("ellipse", (-size, -size, size, size))


def _timed(fn):
    t0 = time.perf_counter()
    r = fn()
    return r, time.perf_counter() - t0


def test_giant_geometry_is_clipped_and_fast():
    """Répétition ×10 / ×64 à 400 % : découpée au champ avant d'ajouter des points, jamais de blocage."""
    s = _settings()
    for count in (10, 16, 64):
        strokes = _eval(ModifierNode("repeat", {"count": count, "scale": 400.0}), _circle())
        fr, dt = _timed(lambda: render_frame(strokes, s, 30))
        assert fr.count <= budget_for(s, 30) and dt < 1.0, (count, fr.count, dt)
    for mod in (ModifierNode("dashes", {"dash": 0.01, "gap": 0.01}), ModifierNode("dots", {"spacing": 0.002}),
                ModifierNode("rainbow"), ModifierNode("mask")):
        (strokes, fr), dt = _timed(lambda: (lambda st: (st, render_frame(st, s, 30)))(
            _eval(mod, ModifierNode("repeat", {"count": 64, "scale": 400.0}), _circle())))
        assert fr.count <= 1000 and dt < 3.0, (mod.mod_type, dt)


def test_dashes_vectorized_same_result():
    """Tirets calculés d'un coup : mêmes tirets que tracés un par un (bornes, couleurs)."""
    out = _eval(ModifierNode("dashes", {"dash": 0.1, "gap": 0.05, "phase": 0.02}),
                ShapeNode("line", (-0.8, 0.0, 0.8, 0.0)))
    lengths = [float(np.hypot(*(s.pts[-1] - s.pts[0]))) for s in out]
    assert len(out) == 11 and all(abs(L - 0.1) < 1e-9 for L in lengths[1:-1]), lengths
    big = _eval(ModifierNode("dashes", {"dash": 0.001, "gap": 0.001}),
                ModifierNode("repeat", {"count": 64, "scale": 400.0}), _circle())
    assert 0 < len(big) <= 8000 + 64


def test_point_budget_and_reduced_flag():
    s = _settings()
    assert budget_for(s, 30) == 1000 and budget_for(_settings(laser={"scan_kpps": 60.0}), 30) == 2000
    assert budget_for(_settings(laser={"scan_kpps": 100.0}), 1) == MAX_LIVE_POINTS
    assert budget_for(_settings(laser={"scan_kpps": 100.0}), 1, cap=65535) == 65535
    circle = render_frame(_eval(_circle()), s, 30)
    assert not circle.reduced and circle.count < 300
    for mods in ([ModifierNode("dashes", {"dash": 0.01, "gap": 0.01})],
                 [ModifierNode("dashes", {"dash": 0.01, "gap": 0.01}), ModifierNode("radial_sym", {"count": 8})],
                 [ModifierNode("dots", {"spacing": 0.002, "size": 60})]):
        for fps in (30, 60, 120):
            fr = render_frame(_eval(*mods, _circle()), s, fps)
            assert fr.count <= budget_for(s, fps) and fr.reduced, (mods[0].mod_type, fps, fr.count)


def test_typical_frames_are_fast():
    """Cas de l'audit : chaque image en moins de 15 ms (marge ×3 pour une machine lente)."""
    s = _settings()
    cases = [[ModifierNode("repeat", {"count": 10, "scale": 400.0})],
             [ModifierNode("dashes", {"dash": 0.01, "gap": 0.01})],
             [ModifierNode("dashes", {"dash": 0.01, "gap": 0.01}), ModifierNode("radial_sym", {"count": 8})],
             [ModifierNode("dots", {"spacing": 0.002, "size": 60})]]
    for mods in cases:
        prev = None
        best = 1e9
        for _ in range(4):
            (strokes, fr), dt = _timed(lambda: (lambda st: (st, render_frame(st, s, 30, previous=prev)))(
                _eval(*mods, _circle(1.0 if mods[0].mod_type == "dots" else 0.5))))
            prev = fr.order
            best = min(best, dt)
        assert best < 0.045, (mods[0].mod_type, best)


def test_alternate_colors_no_beads():
    """Couleurs alternées par segment : pas de faux coins (points doublés de longueur nulle)."""
    plain = optimize(_eval(_circle()), LASER).pts
    alt = optimize(_eval(ModifierNode("alternate"), _circle()), LASER)
    rnd = optimize(_eval(ModifierNode("random_color", {"mode": 1}), _circle()), LASER)
    assert len(alt.pts) <= len(plain) + 100 and len(rnd.pts) <= len(plain) + 100, (len(plain), len(alt.pts))
    # Aucun point allumé répété plus de 2 fois (changement de couleur net = 2 points au même endroit)
    p, c = alt.pts, alt.col
    same = np.all(np.abs(np.diff(p, axis=0)) < 1e-9, axis=1) & (c[1:].max(axis=1) > 0)
    runs = np.diff(np.flatnonzero(np.concatenate(([True], ~same, [True]))))
    assert runs.max() <= 2, runs.max()
    # Le changement de couleur reste net : rouge puis bleu au même point
    k = np.flatnonzero(same)[0]
    assert np.allclose(c[k], (1, 0, 0)) and np.allclose(c[k + 1], (0, 0, 1))


def _dwell_at(r, point):
    """Nombre de points allumés posés sur ce point."""
    lit = r.col.max(axis=1) > 0
    return int(np.sum(np.all(np.abs(r.pts - point) < 1e-9, axis=1) & lit))


def test_closed_shape_closing_corner_dwell():
    """Carré fermé : le coin de fermeture a son temps d'arrêt comme les autres (pas de trou)."""
    sq = Stroke(np.array([[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]), None, True)
    r = optimize([sq], LASER)
    counts = [_dwell_at(r, c) for c in sq.pts]
    assert len(set(counts)) == 1 and counts[0] >= 4, counts
    # Arrivée sur le coin de fermeture : la fin de l'image s'y arrête allumée
    assert np.allclose(r.pts[-1], r.pts[0]) and r.col[-1].max() > 0


def test_corner_dwell_depends_on_angle():
    tri = Stroke(np.array([[0.0, 0.5], [0.4, -0.3], [-0.4, -0.3]]), None, True)   # coins aigus (~120° de virage)
    hexa = Stroke(np.array([[0.5 * math.cos(a), 0.5 * math.sin(a)] for a in np.arange(6) * math.pi / 3]), None, True)
    t = optimize([tri], LASER)
    h = optimize([hexa], LASER)
    assert _dwell_at(t, tri.pts[1]) > _dwell_at(h, hexa.pts[1]) >= 2


def test_rounded_corner_detected():
    """Coin arrondi fait de nombreux segments minuscules : un seul coin, avec son temps d'arrêt."""
    arc = [(0.3 + 0.004 * math.cos(a), 0.3 + 0.004 * math.sin(a)) for a in np.linspace(-math.pi / 2, 0, 9)]
    pts = np.array([(-0.5, 0.296)] + arc + [(0.304, 0.8)])
    r = optimize([Stroke(pts, None, False)], LASER)
    lit = r.col.max(axis=1) > 0
    near = np.hypot(*(r.pts - (0.3, 0.3)).T) < 0.01
    sharp = optimize([Stroke(np.array([(-0.5, 0.3), (0.3, 0.3), (0.3, 0.8)]), None, False)], LASER)
    near_s = np.hypot(*(sharp.pts - (0.3, 0.3)).T) < 0.01
    assert np.sum(near & lit) >= np.sum(near_s & (sharp.col.max(axis=1) > 0)) - 1, (np.sum(near & lit),)


def test_dots_beam_continues_from_last_dot():
    """Après une suite de points, le trajet éteint part du DERNIER point (pas du premier)."""
    dots = Stroke(np.array([[-0.9, 0.0], [-0.5, 0.0], [-0.1, 0.0]]), None, False, "dots", 3)
    line = Stroke(np.array([[0.0, 0.0], [0.5, 0.0]]), None, False)
    r = optimize([dots, line], dict(LASER, reorder=False))
    lit = r.col.max(axis=1) > 0
    first_line = np.flatnonzero(lit & (np.abs(r.pts[:, 0]) < 1e-9))[0]
    run_start = np.flatnonzero(lit[:first_line])[-1] + 1     # trajet éteint juste avant la ligne
    move = r.pts[run_start:first_line, 0]
    assert len(move) and move.min() >= -0.1 - 1e-9 and np.allclose(r.pts[run_start - 1], (-0.1, 0.0))


def test_order_stable_and_vectorized():
    rng = np.random.default_rng(3)
    strokes = [Stroke(rng.uniform(-0.9, 0.9, (2, 2)), None, False) for _ in range(300)]
    a = optimize(strokes, LASER, 20000)
    assert sorted(a.order[0].tolist()) == list(range(300))
    # Petit mouvement : même ordre, même sens (pas de scintillement)
    moved = [Stroke(s.pts + 0.002, None, False) for s in strokes]
    b = optimize(moved, LASER, 20000, a.order)
    assert np.array_equal(a.order[0], b.order[0]) and np.array_equal(a.order[1], b.order[1])


def test_blank_moves_eased():
    """Trajet éteint : accélération puis freinage (points serrés aux deux bouts, écartés au milieu)."""
    r = optimize([Stroke(np.array([[-0.8, 0.0], [-0.7, 0.0]]), None, False),
                  Stroke(np.array([[0.7, 0.0], [0.8, 0.0]]), None, False)], dict(LASER, reorder=False))
    lit = r.col.max(axis=1) > 0
    i0 = np.flatnonzero(lit)[np.flatnonzero(np.diff(np.flatnonzero(lit)) > 1)[0]]
    move = r.pts[i0:np.flatnonzero(lit[i0 + 1:])[0] + i0 + 2, 0]
    steps = np.diff(move)
    assert steps[0] < steps[len(steps) // 2] and steps[-1] < steps[len(steps) // 2]
    cfg = dict(LASER, reorder=False, blank_pre=3, blank_post=2)
    r2 = optimize([Stroke(np.array([[-0.8, 0.0], [-0.7, 0.0]]), None, False),
                   Stroke(np.array([[0.7, 0.0], [0.8, 0.0]]), None, False)], cfg)
    assert len(r2.pts) == len(r.pts) + 2 * 5                # 2 trajets (aller + retour), 5 points de plus chacun
    # Vitesse de balayage doublée : deux fois plus de points pour les mêmes temps d'arrêt
    r3 = optimize(_eval(ShapeNode("rect")), dict(LASER, scan_kpps=60.0))
    assert len(r3.pts) > len(optimize(_eval(ShapeNode("rect")), LASER).pts) + 8


def test_color_correction_shift_and_defaults():
    s = _settings()
    strokes = _eval(ModifierNode("color", {"color": (1.0, 0.5, 0.25)}), _circle())
    base = render_frame(strokes, s, 30)
    lit = base.r > 0
    assert np.all(base.r[lit] == 255) and np.all(base.g[lit] == 128)          # valeurs neutres : inchangé
    fr = render_frame(strokes, _settings(color={"gain_g": 50.0, "gamma": 2.0, "min_power": 0.0}), 30)
    assert np.all(fr.g[lit] == round(0.25 ** 2 * 255)) and np.all(fr.r[lit] == 255)
    dim = render_frame(_eval(ModifierNode("dimmer", {"level": 10.0}), _circle()), _settings(color={"min_power": 20.0}), 30)
    assert dim.count > 0 and not ((dim.r > 0) | (dim.g > 0) | (dim.b > 0)).any()
    sh = render_frame(strokes, _settings(color={"shift": 4}), 30)
    assert np.array_equal(np.roll(base.r, 4), sh.r)


def test_static_beam_guard():
    """Forme de taille nulle, ou sortie réduite à rien : jamais de faisceau fixe allumé."""
    s = _settings()
    zero = render_frame(_eval(ShapeNode("ellipse", (0.2, 0.2, 0.2, 0.2))), s, 30)
    assert zero.static and not ((zero.r > 0) | (zero.g > 0) | (zero.b > 0)).any()
    tiny = _settings(output={"scale_x": 0.0, "scale_y": 0.0})
    fr = render_frame(_eval(_circle(0.05)), tiny, 30)
    assert fr.static and not (fr.r > 0).any()
    big = render_frame(_eval(_circle()), tiny, 30)                     # taille min. 5 % : pas tout au centre
    assert not big.static and np.abs(big.x).max() > 500           # rayon 0,5 × 5 % = 0,025
    off = render_frame(_eval(ShapeNode("ellipse", (0.2, 0.2, 0.2, 0.2))), _settings(safety={"static_guard": False}), 30)
    assert not off.static and (off.r > 0).any()


def test_apply_output_validation():
    s = _settings(safety={"enabled": True, "xmin": 0.5, "xmax": -0.5, "ymin": -1.0, "ymax": 1.0})
    pts = np.array([[0.0, 0.0], [np.nan, 0.0], [0.9, 0.0], [np.inf, 1.0]])
    x, y, r, g, b = apply_output(pts, np.ones((4, 3)), s)
    assert len(x) == 2                                        # NaN / infini retirés
    assert r[0] == 255 and r[1] == 0                          # zone remise dans l'ordre : 0,9 est dehors


def test_strobe_follows_bar_offset():
    """Stroboscope calé sur le tempo : le cycle part du début de la mesure 1 (ici 0,30 s)."""
    strobe = ModifierNode("strobe", {"sync": 1, "division": 2, "duty": 50.0})   # 1 temps à 120 BPM = 0,5 s
    on = _eval(strobe, _circle(), t=0.30 + 0.01, bpm=120.0, bar_offset=0.30)
    off = _eval(strobe, _circle(), t=0.30 - 0.01, bpm=120.0, bar_offset=0.30)
    assert on[0].col.max() > 0 and off[0].col.max() == 0
    pulse = ModifierNode("pulse", {"sync": 1, "division": 2, "shape": 2, "depth": 100.0})
    top = _eval(pulse, _circle(), t=0.30, bpm=120.0, bar_offset=0.30)
    assert top[0].col.max() > 0.99


def test_trim_global_offset_wraps():
    for off in (0.0, 250.0, -730.0, 9999.0):
        out = _eval(ModifierNode("trim", {"start": 0.0, "end": 40.0, "offset": off, "scope": 1}),
                    ShapeNode("rect"), ShapeNode("line", (-0.8, 0.8, 0.8, 0.8)))
        total = sum(float(np.hypot(*np.diff(s.pts, axis=0).T).sum()) for s in out)
        assert total > 0.5, (off, total)


def test_automation_key_merge_is_time_based():
    from ildagen.core.automation import Automation
    a = Automation()
    a.bind("n", "x", "x")
    k1 = a.set_key(0.5, 1.0, 600.0)
    a.set_key(0.5 + 0.3 / 600.0, 2.0, 600.0)           # 0,3 s plus loin sur un clip de 10 minutes
    assert len(a.keys) == 2 and k1.v == 1.0
    a.set_key(0.5 + 0.0005 / 600.0, 3.0, 600.0)        # 0,5 ms : la même clé
    assert len(a.keys) == 2 and k1.v == 3.0
    a.set_key(0.7, 1.0)
    a.set_key(0.7004, 2.0)                             # sans durée : tolérance minuscule
    assert len(a.keys) == 4


def test_idn_sequence_and_close():
    from ildagen.laser.idn import IdnPacketBuilder, frame_data, CMD_RT_CNLMSG_CLOSE
    b = IdnPacketBuilder()
    n = 1000
    x = np.zeros(n, dtype=np.int16)
    u = np.full(n, 255, dtype=np.uint8)
    pk = b.data_packets(frame_data(x, x, u, u, u), n, 1, 30000)
    seqs = [int.from_bytes(p[2:4], "big") for p in pk]
    assert len(pk) > 1 and seqs == list(range(seqs[0], seqs[0] + len(pk))) and all(len(p) <= 1500 for p in pk)
    assert b.close_packets(1, 30000)[0][0] == CMD_RT_CNLMSG_CLOSE


def test_ilda_limits_atomic_and_palette_dimming():
    from ildagen.laser.ilda_file import palette_map, write_ilda
    path = os.path.join(tempfile.mkdtemp(), "t.ild")
    z = np.zeros(1, dtype=np.int16)
    u = np.zeros(1, dtype=np.uint8)
    try:
        write_ilda(path, [(z, z, u, u, u)] * 65536, 5)
        raise AssertionError("trop d'images acceptées")
    except ValueError as e:
        assert "65535" in str(e)
    big = np.zeros(70000, dtype=np.int16)
    try:
        write_ilda(path, [(big, big, big.astype(np.uint8), big.astype(np.uint8), big.astype(np.uint8))], 5)
        raise AssertionError("trop de points acceptés")
    except ValueError:
        pass
    assert not os.path.exists(path) and not os.path.exists(path + ".tmp")     # rien de tronqué
    n = 1000
    for level, lo, hi in ((255, 1.0, 1.0), (128, 0.45, 0.55), (1, 0.0, 0.01)):
        idx, lit = palette_map(np.full(n, level), np.zeros(n), np.zeros(n))
        assert lo <= lit.mean() <= hi and np.all(idx == 0), (level, lit.mean())


def test_export_without_output_settings_by_default():
    from ildagen.laser.output import plain_output
    s = _settings(output={"scale_x": 50.0, "scale_y": 50.0, "power": 20.0})
    strokes = _eval(_circle())
    plain = render_frame(strokes, s, 30, corrections=False)
    corr = render_frame(strokes, s, 30, corrections=True)
    assert np.abs(plain.x).max() > 1.8 * np.abs(corr.x).max() and plain.r.max() == 255 and corr.r.max() < 60
    x, _, r, _, _ = plain_output(np.array([[2.0, 0.0]]), np.ones((1, 3)))
    assert x[0] == 32767 and r[0] == 0                        # hors champ : éteint


def test_snapshot_transport_time():
    from ildagen.editor.live_snapshot import Snapshot
    snap = Snapshot(mode="timeline", playing=True, preview=False, anchor_pos=3.0, anchor_wall=100.0,
                    loop=(2.0, 4.0), length=60.0, view_time=1.0, t0=0.0)
    assert abs(snap.frame_time(100.5) - 3.5) < 1e-9 and abs(snap.frame_time(101.5) - 2.5) < 1e-9
    stop = Snapshot(mode="timeline", playing=False, preview=False, view_time=7.0, t0=0.0)
    assert stop.frame_time(1e6) == 7.0
    form = Snapshot(mode="def", t0=10.0)
    assert form.frame_time(12.5) == 2.5


def test_worker_cache_uses_revisions():
    """Image mise en cache sur la révision du document (plus sur id() d'une liste réutilisée)."""
    from ildagen.core.document import Document
    from ildagen.editor.live_snapshot import Snapshot, copy_document
    from ildagen.editor.live_worker import OutputWorker
    from ildagen.laser.pipeline import SettingsCopy
    doc = Document()
    d = doc.library.defs[0]
    d.root.add(ShapeNode("rect"))
    w = OutputWorker(lambda info: None)
    sc = SettingsCopy(Settings(path=os.devnull))

    def snap(rev):
        return Snapshot(doc_rev=rev, doc=copy_document(doc), mode="def", def_id=d.id, t0=0.0,
                        default_color=(1.0, 1.0, 1.0), settings=sc, fps=30, hold=None)
    f1, _, new1 = w._render(snap(1), 0.0)
    f2, _, new2 = w._render(snap(1), 0.5)
    d.root.children[0].transform.tx = 0.3
    f3, _, new3 = w._render(snap(2), 0.5)
    assert new1 and not new2 and new3 and f3.pts[:, 0].mean() > f1.pts[:, 0].mean() + 0.2
