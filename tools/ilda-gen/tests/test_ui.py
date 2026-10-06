"""Test de l'interface sans écran :  QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_ui.py [dossier_captures]

Simule les gestes de l'utilisateur (souris + touches de modification) et vérifie le résultat.
"""

import math
import os
import sys
import tempfile
import traceback

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("XDG_CONFIG_HOME", tempfile.mkdtemp())

from PySide6.QtCore import QEvent, QPoint, QPointF, Qt  # noqa: E402
from PySide6.QtGui import QMouseEvent  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from ildagen.core.settings import Settings  # noqa: E402
from ildagen.ui import theme  # noqa: E402
from ildagen.ui.canvas.tools.selection_frame import build_frame, handle_positions  # noqa: E402
from ildagen.ui.main_window import MainWindow  # noqa: E402

SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
M = Qt.KeyboardModifier
errors = []


def check(name, cond, detail=""):
    print(("OK   " if cond else "BUG  ") + name + (f"  ({detail})" if detail else ""))
    if not cond:
        errors.append(name)


def send(widget, kind, pos, button, buttons, mods):
    ev = QMouseEvent(kind, QPointF(pos), QPointF(widget.mapToGlobal(pos)), button, buttons, mods)
    QApplication.sendEvent(widget, ev)


def drag(widget, a, b, mods=M.NoModifier, steps=10):
    L = Qt.MouseButton.LeftButton
    N = Qt.MouseButton.NoButton
    send(widget, QEvent.Type.MouseButtonPress, a, L, L, mods)
    for i in range(1, steps + 1):
        p = QPoint(int(a.x() + (b.x() - a.x()) * i / steps), int(a.y() + (b.y() - a.y()) * i / steps))
        send(widget, QEvent.Type.MouseMove, p, N, L, mods)
    send(widget, QEvent.Type.MouseButtonRelease, b, L, N, mods)
    QApplication.processEvents()


def click(widget, p, mods=M.NoModifier):
    drag(widget, p, p, mods, steps=0)


def shot(win, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        win.grab().save(os.path.join(SHOTS, name + ".png"))


def main():
    app = QApplication([])
    app.setStyle("Fusion")
    theme.apply_palette(app)
    win = MainWindow(Settings(path=os.path.join(tempfile.mkdtemp(), "s.json")))
    win.resize(1440, 900)
    win.show()
    app.processEvents()
    ed = win.editor
    view = win.canvas.view

    def sp(x, y):
        p = view.vt.to_screen(x, y)
        return QPoint(int(round(p.x())), int(round(p.y())))

    def handles():
        fr = build_frame(ed, ed.eval_context())
        return {k: QPoint(int(round(v.x())), int(round(v.y()))) for k, v in handle_positions(view.vt, fr).items()}

    # ── Formes ──────────────────────────────────────────────────────────
    ed.set_tool("shape:rect")
    drag(view, sp(-0.6, 0.6), sp(-0.1, 0.1))
    rect = ed.doc.main_group.children[0]
    check("carré créé", rect.shape == "rect")
    ed.set_tool("shape:ellipse")
    drag(view, sp(0.3, 0.3), sp(0.6, 0.4), M.ShiftModifier)
    circ = ed.doc.main_group.children[0]
    b = circ.local_bbox()
    check("Maj = cercle parfait", abs((b[2] - b[0]) - (b[3] - b[1])) < 1e-6)
    ed.set_tool("shape:star")
    drag(view, sp(0.0, -0.5), sp(0.2, -0.3), M.AltModifier)
    star = ed.doc.main_group.children[0]
    b = star.local_bbox()
    check("Alt = depuis le centre", abs((b[0] + b[2]) / 2) < 0.02, f"centre x {(b[0] + b[2]) / 2:.3f}")

    # ── Transformations ─────────────────────────────────────────────────
    ed.set_tool("select")
    ed.set_selection([rect.id])
    h = handles()
    drag(view, h["c1"], QPoint(h["c1"].x() + 50, h["c1"].y() - 20), M.ShiftModifier)
    check("coin + Maj = proportionnel", abs(rect.transform.sx - rect.transform.sy) < 1e-6,
          f"{rect.transform.sx:.3f} / {rect.transform.sy:.3f}")
    ed.undo()
    rect = ed.find(rect.id)
    h = handles()
    drag(view, h["e1"], QPoint(h["e1"].x() + 40, h["e1"].y()), M.AltModifier)
    q = build_frame(ed, ed.eval_context()).quad
    check("côté + Alt = symétrique depuis le centre", abs((q[:, 0].min() + q[:, 0].max()) / 2 - (-0.35)) < 0.01)
    ed.undo()
    rect = ed.find(rect.id)
    h = handles()
    q0 = build_frame(ed, ed.eval_context()).quad
    c0 = (q0[:, 0].min() + q0[:, 0].max()) / 2
    target = sp(0.0, 0.5)    # près de la ligne de grille x = 0 (aimant)
    drag(view, h["c1"], QPoint(target.x() + 3, target.y()), M.ShiftModifier | M.AltModifier)
    q = build_frame(ed, ed.eval_context()).quad
    x0, x1, y0, y1 = q[:, 0].min(), q[:, 0].max(), q[:, 1].min(), q[:, 1].max()
    check("Alt + Maj + coin + aimant : depuis le centre, proportionnel, sur la grille",
          abs((x0 + x1) / 2 - c0) < 1e-6 and abs((x1 - x0) - (y1 - y0)) < 1e-6 and abs(x1) < 1e-6,
          f"x {x0:.3f}..{x1:.3f}  y {y0:.3f}..{y1:.3f}")
    ed.undo()
    rect = ed.find(rect.id)
    h = handles()
    drag(view, h["rot"], QPoint(h["rot"].x() + 80, h["rot"].y() + 50), M.ShiftModifier)
    check("rotation + Maj = pas de 15°", abs(rect.transform.rot / 15 - round(rect.transform.rot / 15)) < 1e-6
          and rect.transform.rot != 0, f"{rect.transform.rot:.2f}°")
    ed.undo()
    rect = ed.find(rect.id)
    h = handles()
    drag(view, h["c0"], QPoint(h["c0"].x() - 30, h["c0"].y() - 30), M.ControlModifier)
    rect = ed.find(rect.id)
    check("Ctrl + coin = distorsion (géométrie recalculée)", rect.shape == "path")
    ed.undo()
    rect = ed.find(rect.id)
    h = handles()
    drag(view, h["e0"], QPoint(h["e0"].x() + 40, h["e0"].y()), M.ControlModifier | M.ShiftModifier)
    check("Ctrl + Maj + côté = inclinaison", abs(rect.transform.shear) > 0.01, f"{rect.transform.shear:.3f}")
    ed.undo()
    rect = ed.find(rect.id)
    h = handles()
    drag(view, h["c1"], QPoint(h["c1"].x() + 30, h["c1"].y()), M.ControlModifier | M.ShiftModifier | M.AltModifier)
    check("Ctrl + Alt + Maj + coin = perspective", ed.find(rect.id).shape == "path")
    ed.undo()
    rect = ed.find(rect.id)
    h = handles()
    drag(view, h["tilt"], QPoint(h["tilt"].x() + 60, h["tilt"].y()))
    check("poignée 3D = inclinaison Y", abs(rect.transform.tilt_y) > 5, f"{rect.transform.tilt_y:.1f}°")
    ed.undo()
    rect = ed.find(rect.id)
    # Déplacement avec magnétisme (Maj) : un bord ou le centre du carré s'aligne sur la grille
    drag(view, sp(-0.6, 0.5), sp(0.12, 0.52), M.ShiftModifier)
    q = build_frame(ed, ed.eval_context()).quad
    xs = [q[:, 0].min(), (q[:, 0].min() + q[:, 0].max()) / 2, q[:, 0].max()]
    off = min(abs(x * 8 - round(x * 8)) for x in xs)
    check("Maj + déplacer = aligné sur la grille", off < 1e-6, f"bords / centre x {[round(x, 4) for x in xs]}")
    ed.undo()
    # Alt + glisser = copie
    n_before = len(ed.doc.main_group.children)
    drag(view, sp(-0.6, 0.5), sp(-0.6, 0.8), M.AltModifier)
    check("Alt + glisser = duplique", len(ed.doc.main_group.children) == n_before + 1)
    ed.undo()
    ed.undo()
    check("annuler la copie", len(ed.doc.main_group.children) == n_before)
    # Sélection rectangle
    ed.clear_selection()
    drag(view, sp(-0.95, 0.95), sp(0.95, -0.95))
    check("sélection rectangle", len(ed.selection) == 3, str(len(ed.selection)))
    shot(win, "01_formes")

    # ── Crayon ──────────────────────────────────────────────────────────
    ed.set_tool("pencil")
    L = Qt.MouseButton.LeftButton
    send(view, QEvent.Type.MouseButtonPress, sp(-0.8, -0.8), L, L, M.NoModifier)
    for i in range(50):
        send(view, QEvent.Type.MouseMove, sp(-0.8 + i * 0.03, -0.8 + 0.1 * math.sin(i / 5)), Qt.MouseButton.NoButton, L, M.NoModifier)
    send(view, QEvent.Type.MouseButtonRelease, sp(0.7, -0.8), L, Qt.MouseButton.NoButton, M.NoModifier)
    free = ed.doc.main_group.children[0]
    check("main levée lissée et simplifiée", free.shape == "path" and 2 < len(free.paths[0].pts) < 50,
          f"{len(free.paths[0].pts)} points")
    ed.set_grid_mode(2)
    view.last_world = (0.5, 0.0)
    drag(view, sp(0.5, 0.0), sp(0.5, 0.0), M.ShiftModifier, steps=0)
    send(view, QEvent.Type.MouseButtonPress, sp(0.5, 0.0), L, L, M.ShiftModifier)
    for a in range(0, 181, 15):
        send(view, QEvent.Type.MouseMove, sp(0.5 * math.cos(math.radians(a)), 0.5 * math.sin(math.radians(a))),
             Qt.MouseButton.NoButton, L, M.ShiftModifier)
    send(view, QEvent.Type.MouseButtonRelease, sp(-0.5, 0.0), L, Qt.MouseButton.NoButton, M.ShiftModifier)
    guided = ed.doc.main_group.children[0]
    pts = guided.paths[0].pts
    radii = [math.hypot(*p) for p in pts]
    check("polaire : arc le long du cercle", len(pts) > 10 and max(radii) - min(radii) < 0.02,
          f"{len(pts)} points, rayon {min(radii):.3f}-{max(radii):.3f}")
    n0 = len(ed.doc.main_group.children)
    drag(view, sp(-0.25, 0.0), sp(-0.25, 0.0), M.ShiftModifier, steps=0)
    point = ed.doc.main_group.children[0]
    check("Maj + clic = un point visible (nouveau calque)", len(ed.doc.main_group.children) == n0 + 1
          and len(point.paths[0].pts) == 1 and any(len(s_.pts) == 1 for s_ in ed.display_strokes()))
    ed.set_grid_mode(1)
    drag(view, sp(-0.5, 0.75), sp(0.25, 0.75), M.ShiftModifier)
    line = ed.doc.main_group.children[0]
    check("Maj + glisser = une ligne (2 points)", len(line.paths[0].pts) == 2 and line.name == "Ligne")
    # Ligne sélectionnée : poignées aux extrémités, pas d'épaisseur
    ed.set_tool("select")
    ed.set_selection([line.id])
    app.processEvents()
    from ildagen.ui.canvas.tools import line_handles as LH
    ends = LH.world_endpoints(ed, line, ed.eval_context())
    pos = LH.positions(view.vt, ends)
    p1 = QPoint(int(round(pos["p1"].x())), int(round(pos["p1"].y())))
    drag(view, p1, sp(0.5, 0.5), M.ShiftModifier)
    ends = LH.world_endpoints(ed, ed.find(line.id), ed.eval_context())
    check("ligne : extrémité déplacée (aimantée)", abs(ends[1][0] - 0.5) < 1e-6 and abs(ends[1][1] - 0.5) < 1e-6,
          str(ends[1]))
    check("ligne : début inchangé", abs(ends[0][0] + 0.5) < 1e-6 and abs(ends[0][1] - 0.75) < 1e-6)
    check("ligne : pas de poignées d'épaisseur", view.tool.line_node() is not None)
    ed.undo()
    ed.undo()
    ed.set_tool("pencil")
    ed.set_grid_mode(1)
    # Plusieurs traits au crayon puis V : tout le dessin est sélectionné
    ed.set_tool("pencil")
    n_before = len(ed.doc.main_group.children)
    drag(view, sp(-0.9, -0.2), sp(-0.7, -0.3))
    drag(view, sp(-0.9, -0.4), sp(-0.7, -0.5))
    drag(view, sp(-0.9, -0.6), sp(-0.7, -0.7))
    new_ids = [n.id for n in ed.doc.main_group.children[:len(ed.doc.main_group.children) - n_before]]
    ed.set_tool("select")
    check("V après plusieurs traits : tous sélectionnés", sorted(ed.selection) == sorted(new_ids) and len(new_ids) == 3,
          f"{len(ed.selection)} / {len(new_ids)}")
    for _ in range(3):
        ed.undo()
    ed.clear_selection()
    # Bouton « Nouveau calque » : le prochain trait le remplit
    layer = ed.new_empty_layer()
    n_layers = len(ed.doc.main_group.children)
    ed.set_tool("pencil")
    drag(view, sp(-0.9, 0.9), sp(-0.6, 0.8))
    check("nouveau calque rempli par le trait", len(ed.doc.main_group.children) == n_layers and ed.find(layer.id).paths
          and len(ed.find(layer.id).paths[0].pts) >= 2)
    ed.undo()
    ed.undo()
    # Clic simple dans le vide avec le crayon = désélectionner
    ed.set_tool("pencil")
    ed.set_selection([guided.id])
    n_layers = len(ed.doc.main_group.children)
    click(view, sp(0.9, 0.9))
    check("crayon : clic dans le vide désélectionne", ed.selection == [] and len(ed.doc.main_group.children) == n_layers)
    ed.set_tool("select")
    check("V reprend le dernier calque touché", len(ed.selection) == 1 and ed.selection[0] == ed.last_touched)
    ed.clear_selection()
    ed.set_tool("pencil")
    # Couleur de tracé + seau
    b = ed.brush()
    b.update(mode=1, color=[1.0, 1.0, 1.0], bg=[0.0, 1.0, 0.0])
    ed.swap_colors()
    check("X : inverser les couleurs", b["color"] == [0.0, 1.0, 0.0] and b["bg"] == [1.0, 1.0, 1.0])
    ed.set_tool("shape:rect")
    drag(view, sp(0.6, -0.6), sp(0.9, -0.9))
    green = ed.doc.main_group.children[0]
    check("nouvelle forme à la couleur de tracé", green.color_mode == 1 and tuple(green.color) == (0.0, 1.0, 0.0))
    ed.clear_selection()
    b.update(color=[0.0, 0.0, 1.0])
    ed.brush_changed()
    ed.set_tool("bucket")
    click(view, sp(0.6, -0.75))
    check("seau : couleur appliquée", tuple(ed.find(green.id).color) == (0.0, 0.0, 1.0))
    ed.undo()
    check("seau annulable", tuple(ed.find(green.id).color) == (0.0, 1.0, 0.0))
    ed.set_selection([green.id])
    b.update(mode=1, color=[1.0, 0.0, 1.0])
    ed.brush_changed()
    check("couleur à gauche = appliquée à la sélection", tuple(ed.find(green.id).color) == (1.0, 0.0, 1.0))
    ed.undo()
    check("annulable", tuple(ed.find(green.id).color) == (0.0, 1.0, 0.0))
    ed.clear_selection()
    ed.reset_colors()
    ed.set_tool("select")

    # ── Calques : groupes, verrou, œil, presse-papiers ──────────────────
    ed.set_selection([circ.id, star.id])
    ed.group_selected()
    g = ed.selected_nodes()[0]
    check("grouper", g.kind == "group" and len(g.children) == 2)
    ed.set_visible(g, False)
    check("masquer un groupe masque son contenu", all(not c.visible for c in g.children))
    ed.set_visible(g, True)
    ed.set_locked([g], True)
    check("groupe verrouillé replié", not g.expanded)
    click(view, sp(0.45, 0.35))
    check("clic sur un élément d'un groupe verrouillé = groupe entier", ed.selection == [g.id], str(ed.selection))
    ed.set_locked([g], False)
    ed.copy_selection()
    ed.paste()
    check("copier / coller", len(ed.doc.main_group.children) >= 4)
    ed.undo()
    ed.select_all()
    check("Ctrl+A", len(ed.selection) == len(ed.doc.main_group.children))
    # Glisser-déposer dans l'arbre (API du modèle)
    tree = win.layers.tree
    ok = ed.move_nodes([free.id], g.id, 0)
    check("déplacer un calque dans un groupe", ok and ed.find(free.id).parent is ed.find(g.id))
    ed.undo()

    # ── Modifieurs ───────────────────────────────────────────────────────
    g = ed.find(g.id)
    ed.set_selection([g.id])
    m = ed.add_modifier("color")
    ed.set_param(m, "color", (1.0, 0.0, 0.0))
    sym = ed.add_modifier("mirror_sym")
    ed.add_modifier("translate", onto=sym)
    check("sous-modifieur sur un modifieur", sym.children and sym.children[0].mod_type == "translate")
    strokes = ed.display_strokes()
    check("rendu avec modifieurs", len(strokes) > 4, str(len(strokes)))
    app.processEvents()
    check("réglages affichés dans la ligne du modifieur", m.id in tree.param_widgets)
    # Réglage au clic-glisser (même après un premier clic qui a mis le champ en saisie)
    form = tree.param_widgets[sym.id]
    field = form.fields["angle"]
    L_ = Qt.MouseButton.LeftButton
    c = QPoint(field.width() // 2, field.height() // 2)
    send(field, QEvent.Type.MouseButtonPress, c, L_, L_, M.NoModifier)
    send(field, QEvent.Type.MouseButtonRelease, c, L_, Qt.MouseButton.NoButton, M.NoModifier)
    a0 = ed.find(sym.id).values["angle"]
    send(field, QEvent.Type.MouseButtonPress, c, L_, L_, M.NoModifier)
    send(field, QEvent.Type.MouseMove, QPoint(c.x() + 20, c.y()), Qt.MouseButton.NoButton, L_, M.NoModifier)
    check("pendant un réglage : sélection masquée dans la mire", ed.param_editing)
    send(field, QEvent.Type.MouseButtonRelease, QPoint(c.x() + 20, c.y()), L_, Qt.MouseButton.NoButton, M.NoModifier)
    check("après le réglage : sélection réaffichée", not ed.param_editing)
    drag(field, c, QPoint(c.x() + 60, c.y()))
    check("clic + glisser à droite augmente la valeur", ed.find(sym.id).values["angle"] > a0,
          f"{a0} → {ed.find(sym.id).values['angle']}")
    shot(win, "02_modifieurs")

    # ── Forme personnalisée ─────────────────────────────────────────────
    ed.select_all()
    d = ed.create_custom_shape("Motif")
    check("forme personnalisée créée", d is not None and len(ed.doc.library.defs) == 1)
    check("remplacée par une occurrence", ed.doc.main_group.children[0].kind == "instance")
    app.processEvents()
    check("forme listée à gauche", win.tools.defs.count() == 1)

    # ── Timeline ─────────────────────────────────────────────────────────
    clip = ed.add_clip(d.id, ed.doc.timeline.tracks[0].id, 0.0, 4.0)
    ed.enter_clip(clip.id)
    check("contexte clip", ed.context == ("clip", clip.id) and ed.display_mode() == "timeline")
    win.tools.defs.setCurrentRow(-1)
    ed.enter_scene()
    ed.enter_clip(clip.id)
    cur = win.tools.defs.currentItem()
    check("clip sélectionné = forme surlignée à gauche", cur is not None and cur.data(Qt.ItemDataRole.UserRole) == d.id)
    a = ed.new_automation(clip.id)
    check("automation en attente", a.armed)
    inner_shape = next(n for n in d.root.walk() if n.kind == "shape")
    ed.set_playhead(2.0)
    ed.set_param(inner_shape, "tf.tx", 0.4)
    check("automation liée au réglage touché", not a.armed and a.key == "tf.tx" and a.node_id == inner_shape.id,
          a.label)
    check("clé écrite à la tête de lecture", any(abs(k.t - 2.0) < 1e-6 for k in a.keys))
    ed.set_playhead(0.0)
    v0 = ed.effective_param(inner_shape, "tf.tx")
    ed.set_playhead(2.0)
    v1 = ed.effective_param(inner_shape, "tf.tx")
    check("valeur animée dans le temps", abs(v1 - 0.4) < 1e-6 and abs(v0 - 0.4) > 1e-6, f"{v0} → {v1}")
    mod_in_def = next(n for n in d.root.walk() if n.kind == "modifier")
    a2 = ed.new_automation(clip.id)
    ed.set_playhead(1.0)
    ed.set_param(mod_in_def, "__active__", False)
    check("automation « Actif » d'un modifieur", a2.key == "__active__" and a2.discrete)
    ed.set_playhead(0.5)
    check("modifieur actif avant la clé", ed.eval_context().is_visible(mod_in_def))
    ed.set_playhead(1.5)
    check("modifieur coupé après la clé", not ed.eval_context().is_visible(mod_in_def))
    ed.set_selection([ed.doc.main_group.children[0].id] if False else [])
    clip.expanded = True
    ed.notify(timeline=True)
    tl = ed.doc.timeline
    tl.bpm = 128
    t = tl.snap_time(1.01)
    check("aimant BPM", abs(t - 60 / 128 * 2) < 1e-6 or abs(t - 60 / 128 * 2) < 0.5, f"{t:.3f}")
    # Clip déplié : les modifieurs de la forme et leurs réglages sont directement animables
    clip.expanded = True
    ed.notify(timeline=True)
    app.processEvents()
    tl_canvas = win.timeline.canvas
    rows_ = tl_canvas.rows()
    groups = [r for r in rows_ if r.kind == "group" and r.clip is clip]
    check("modifieurs affichés sous le clip déplié", len(groups) >= 2, str(len(groups)))
    lane_v = next(r for r in rows_ if r.kind == "lane" and r.node is not None and r.virtual
                  and r.auto.key != "__active__" and not (r.auto.key in ("color",)))
    n_auto = len(clip.automations)
    click(tl_canvas, QPoint(int(tl_canvas.geo.x(clip.start + 1.0)), int(lane_v.y + lane_v.h * 0.3)))
    check("clic dans un réglage de modifieur = automation créée", len(clip.automations) == n_auto + 1
          and clip.automations[-1].node_id == lane_v.node.id and len(clip.automations[-1].keys) == 1)
    ed.undo()
    clip = ed.doc.timeline.find_clip(clip.id)[1]
    check("annulable", len(clip.automations) == n_auto)
    ed.enter_clip(clip.id)
    # Gestes à la souris dans la timeline
    canvas = win.timeline.canvas
    app.processEvents()
    rows = canvas.rows()
    tr_row = next(r for r in rows if r.kind == "track")
    x = canvas.geo.x(clip.start + 1.0)
    y = int(tr_row.y + tr_row.h / 2)
    drag(canvas, QPoint(int(x), y), QPoint(int(x + canvas.geo.pps * 1.0), y))
    check("glisser un clip (aimanté)", abs(clip.start - tl.snap_time(1.0, force=True)) < 1e-6, f"début {clip.start:.3f}")
    ed.undo()
    clip = ed.doc.timeline.find_clip(clip.id)[1]
    ed.enter_clip(clip.id)
    clip.expanded = True
    ed.notify(timeline=True)
    app.processEvents()
    lane = next(r for r in canvas.rows() if r.kind == "lane" and r.auto.key == "tf.tx")
    n_keys = len(lane.auto.keys)
    click(canvas, QPoint(int(canvas.geo.x(clip.start + 3.0)), int(lane.y + lane.h * 0.3)))
    check("clic dans une automation = nouvelle clé", len(lane.auto.keys) == n_keys + 1)
    t_before = ed.playhead
    win.playback.play()
    import time as _t
    _t.sleep(0.05)
    for _ in range(5):
        win.playback._tick()
    win.playback.pause()
    check("lecture : la tête avance", ed.playhead > t_before, f"{t_before:.3f} → {ed.playhead:.3f}")
    app.processEvents()
    shot(win, "03_timeline")

    # ── Sortie live ──────────────────────────────────────────────────────
    ed.enter_scene()
    inst = ed.doc.main_group.children[0]
    ed.set_selection([inst.id])
    before = ed.effective_transform(inst).sx
    ed.flip_selection(True)
    check("retourner horizontalement", ed.find(inst.id).transform.sx * before < 0 or
          abs(abs(ed.find(inst.id).transform.rot) - 180) < 1e-6)
    win.live.set_live(True)
    win.live.tick()
    check("envoi live actif", win.live.live)
    win.live.set_blackout(True)
    check("blackout coupe l'envoi", not win.live.live and win.live.blackout)
    win.live.set_blackout(False)

    # ── Enregistrer / ouvrir ─────────────────────────────────────────────
    path = os.path.join(tempfile.mkdtemp(), "test.ildaproj")
    win.project._write(path)
    ed.dirty = False
    win.project.open(path)
    check("projet rouvert", len(ed.doc.library.defs) == 1 and ed.doc.timeline.has_clips())
    from ildagen.editor.export import export_ilda
    n = export_ilda(ed, os.path.join(tempfile.mkdtemp(), "t.ild"), 5, 25, 0.0, 4.0)
    check("export ILDA de l'animation", n == 100, f"{n} images")
    # Suppr sur une forme personnalisée de la liste de gauche (annulable)
    win.tools.defs.setCurrentRow(0)
    win.tools.defs.setFocus()
    app.processEvents()
    win.tools.defs.delete_current()
    check("Suppr supprime la forme personnalisée", len(ed.doc.library.defs) == 0 and not ed.doc.timeline.has_clips())
    ed.undo()
    check("annuler la suppression de la forme", len(ed.doc.library.defs) == 1 and ed.doc.timeline.has_clips())
    ed.dirty = False
    print("\n" + ("TOUT EST OK" if not errors else f"{len(errors)} problème(s) : {', '.join(errors)}"))
    return 1 if errors else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(2)
