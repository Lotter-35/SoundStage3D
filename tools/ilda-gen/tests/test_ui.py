"""Test de l'interface sans écran :  QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_ui.py [dossier_captures]

Simule les gestes de l'utilisateur (souris + touches de modification) et vérifie le résultat.
"""

import math
import os
import sys
import tempfile
import traceback

import numpy as np  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("XDG_CONFIG_HOME", tempfile.mkdtemp())

from PySide6.QtCore import QEvent, QPoint, QPointF, Qt  # noqa: E402
from PySide6.QtGui import QMouseEvent  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from ildagen.core.settings import Settings  # noqa: E402
from ildagen.ui import theme  # noqa: E402
from ildagen.ui.canvas.tools.selection_frame import build_frame, handle_positions  # noqa: E402
from ildagen.ui.main_window import MainWindow  # noqa: E402
from live_checks import live_checks  # noqa: E402

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
    # Une exception dans un slot Qt (bouton, signal…) ne plante pas l'application mais doit faire échouer le test
    sys.excepthook = lambda t, v, tb: (traceback.print_exception(t, v, tb), check(f"exception {t.__name__} : {v}", False))
    app.setStyle("Fusion")
    theme.apply_palette(app)
    win = MainWindow(Settings(path=os.path.join(tempfile.mkdtemp(), "s.json")))
    win.resize(1440, 900)
    win.show()
    app.processEvents()
    ed = win.editor
    view = win.canvas.view
    F1 = ed.doc.library.defs[0].id      # « Forme 1 », toujours présente

    def root():
        return ed.doc.library.get(F1).root

    def sp(x, y):
        p = view.vt.to_screen(x, y)
        return QPoint(int(round(p.x())), int(round(p.y())))

    def handles():
        fr = build_frame(ed, ed.eval_context())
        return {k: QPoint(int(round(v.x())), int(round(v.y()))) for k, v in handle_positions(view.vt, fr).items()}

    # ── Formes ──────────────────────────────────────────────────────────
    ed.set_tool("shape:rect")
    drag(view, sp(-0.6, 0.6), sp(-0.1, 0.1))
    rect = root().children[0]
    check("carré créé", rect.shape == "rect")
    ed.set_tool("shape:ellipse")
    drag(view, sp(0.3, 0.3), sp(0.6, 0.4), M.ShiftModifier)
    circ = root().children[0]
    b = circ.local_bbox()
    check("Maj = cercle parfait", abs((b[2] - b[0]) - (b[3] - b[1])) < 1e-6)
    ed.set_tool("shape:star")
    drag(view, sp(0.0, -0.5), sp(0.2, -0.3), M.AltModifier)
    star = root().children[0]
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
          abs((x0 + x1) / 2 - c0) < 1e-6 and abs(x1) < 1e-6 and
          abs((x1 - x0) / (y1 - y0) - np.ptp(q0[:, 0]) / np.ptp(q0[:, 1])) < 1e-6,
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
    n_before = len(root().children)
    drag(view, sp(-0.6, 0.5), sp(-0.6, 0.8), M.AltModifier)
    check("Alt + glisser = duplique", len(root().children) == n_before + 1)
    ed.undo()                       # copie + déplacement = une seule étape (M3)
    check("annuler la copie", len(root().children) == n_before)
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
    free = root().children[0]
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
    guided = root().children[0]
    pts = guided.paths[0].pts
    radii = [math.hypot(*p) for p in pts]
    check("polaire : arc le long du cercle", len(pts) > 10 and max(radii) - min(radii) < 0.02,
          f"{len(pts)} points, rayon {min(radii):.3f}-{max(radii):.3f}")
    n0 = len(root().children)
    drag(view, sp(-0.25, 0.0), sp(-0.25, 0.0), M.ShiftModifier, steps=0)
    point = root().children[0]
    check("Maj + clic = un point visible (nouveau calque)", len(root().children) == n0 + 1
          and len(point.paths[0].pts) == 1 and any(len(s_.pts) == 1 for s_ in ed.display_strokes()))
    ed.set_grid_mode(1)
    drag(view, sp(-0.5, 0.75), sp(0.25, 0.75), M.ShiftModifier)
    line = root().children[0]
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
    n_before = len(root().children)
    drag(view, sp(-0.9, -0.2), sp(-0.7, -0.3))
    drag(view, sp(-0.9, -0.4), sp(-0.7, -0.5))
    drag(view, sp(-0.9, -0.6), sp(-0.7, -0.7))
    new_ids = [n.id for n in root().children[:len(root().children) - n_before]]
    ed.set_tool("select")
    check("V après plusieurs traits : tous sélectionnés", sorted(ed.selection) == sorted(new_ids) and len(new_ids) == 3,
          f"{len(ed.selection)} / {len(new_ids)}")
    for _ in range(3):
        ed.undo()
    ed.clear_selection()
    # Bouton « Nouveau calque » : le prochain trait le remplit
    layer = ed.new_empty_layer()
    n_layers = len(root().children)
    ed.set_tool("pencil")
    drag(view, sp(-0.9, 0.9), sp(-0.6, 0.8))
    check("nouveau calque rempli par le trait", len(root().children) == n_layers and ed.find(layer.id).paths
          and len(ed.find(layer.id).paths[0].pts) >= 2)
    ed.undo()
    ed.undo()
    # Clic simple dans le vide avec le crayon = désélectionner
    ed.set_tool("pencil")
    ed.set_selection([guided.id])
    n_layers = len(root().children)
    click(view, sp(0.9, 0.9))
    check("crayon : clic dans le vide désélectionne", ed.selection == [] and len(root().children) == n_layers)
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
    green = root().children[0]
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
    check("copier / coller", len(root().children) >= 4)
    ed.undo()
    ed.select_all()
    check("Ctrl+A", len(ed.selection) == len(root().children))
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
    ed.set_selection([sym.id])
    app.processEvents()
    check("réglages du modifieur dans Réglages (plus dans la ligne, D10)", win.properties.form is not None
          and win.properties.form.node_id == sym.id)
    # Glisser sur un modifieur : jamais dedans, au-dessus ou en dessous, ligne alignée (pas de décalage)
    mi = tree.model_.index_for_id(m.id)
    si = tree.model_.index_for_id(sym.id)
    rm, rs = tree.visualRect(mi), tree.visualRect(si)
    mid = tree._drop_target(QPoint(rm.center().x(), rm.center().y()))
    top = tree._drop_target(QPoint(rm.center().x(), rm.top() + 2))
    bot = tree._drop_target(QPoint(rm.center().x(), rm.bottom() - 1))
    stop = tree._drop_target(QPoint(rs.center().x(), rs.top() + 2))
    mm = ed.find(m.id)
    check("glisser sur un modifieur : jamais dedans", mid[0] is not mm and top[0] is not mm and bot[0] is not mm
          and mid[2][0] == "line")
    check("au-dessus / en dessous du modifieur", top[1] == mm.index() and bot[1] == mm.index() + 1
          and bot[2][1] >= rm.bottom())
    check("ligne d'insertion au même niveau pour deux modifieurs", top[2][2] == stop[2][2], f"{top[2][2]} / {stop[2][2]}")
    # Réglage au clic-glisser (même après un premier clic qui a mis le champ en saisie)
    form = win.properties.form
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
    angle_field = field
    angle_field.start_typing()
    typed = angle_field.typing_editor().text()
    angle_field._close_editor()
    check("l'unité n'est pas dans le texte modifiable", "°" not in typed, typed)
    check("clic + glisser à droite augmente la valeur", ed.find(sym.id).values["angle"] > a0,
          f"{a0} → {ed.find(sym.id).values['angle']}")
    shot(win, "02_modifieurs")

    # Alt + clic = valeur par défaut ; bouton / Ctrl+Maj+R = tout réinitialiser
    send(angle_field, QEvent.Type.MouseButtonPress, c, L_, L_, M.AltModifier)
    send(angle_field, QEvent.Type.MouseButtonRelease, c, L_, Qt.MouseButton.NoButton, M.AltModifier)
    check("Alt + clic : valeur par défaut", ed.find(sym.id).values["angle"] == 90.0, str(ed.find(sym.id).values["angle"]))
    ed.set_param(ed.find(sym.id), "axes", 3)
    ed.reset_params([ed.find(sym.id)])
    check("réinitialiser tous les réglages", ed.find(sym.id).values["axes"] == 1)
    ed.undo()
    check("annulable", ed.find(sym.id).values["axes"] == 3)

    # ── Forme personnalisée ─────────────────────────────────────────────
    ed.select_all()
    d = ed.create_custom_shape("Motif")
    check("forme personnalisée créée", d is not None and len(ed.doc.library.defs) == 2)
    check("remplacée par une occurrence", root().children[0].kind == "instance")
    app.processEvents()
    check("forme listée à gauche", win.tools.defs.count() == 2)

    # ── Timeline (espace Show) ───────────────────────────────────────────
    tl = ed.doc.timeline
    clip = ed.add_clip(d.id, tl.tracks[0].id, 0.0, 4.0)
    ed.set_workspace("show")
    ed.select_clip(clip.id)
    app.processEvents()
    check("espace Show : la mire montre la timeline, les outils n'agissent plus",
          ed.workspace == "show" and not ed.editing_visible() and win.top.spaces.current() == 1 and win.stack.currentWidget() is win.show_space)
    check("clip actif : Propriétés montre ses réglages (début, durée, fondus)",
          sorted(win.show_space.inspector._clip_fields or {}) == ["duration", "fade_in", "fade_out", "start"])
    tl_canvas = win.timeline.canvas
    check("timeline : seulement les pistes (plus de lignes d'automation)",
          all(r.kind == "track" for r in tl_canvas.rows()) and len(tl_canvas.rows()) == len(tl.tracks))
    # Effet d'animation posé sur le clip : la mire le suit à la tête de lecture
    eff = ed.add_effect(clip.id, "translate")
    ed.set_track_mode(eff.id, "x", "courbe")
    ed.set_curve_key(eff.id, "x", 1.0, 0.4)

    def mean_x():
        return float(np.vstack([s.pts for s in ed.display_strokes()])[:, 0].mean())
    ed.set_playhead(0.0)
    x0 = mean_x()
    ed.set_playhead(2.0)
    x1 = mean_x()
    check("effet en courbe : la mire suit la tête de lecture", abs((x1 - x0) - 0.2) < 1e-6, f"{x1 - x0:.4f}")
    win.show_space.inspector._clip_fields["fade_in"].setText("1")
    win.show_space.inspector._clip_fields["fade_in"]._typed()
    clip = ed.doc.timeline.find_clip(clip.id)[1]
    check("fondu d'entrée tapé dans Propriétés", abs(clip.fade_in - 1.0) < 1e-9, f"{clip.fade_in}")
    ed.undo()
    clip = ed.doc.timeline.find_clip(clip.id)[1]
    tl = ed.doc.timeline
    tl.bpm = 128
    t = tl.snap_time(1.01)
    check("aimant BPM", abs(t - 60 / 128 * 2) < 1e-6 or abs(t - 60 / 128 * 2) < 0.5, f"{t:.3f}")
    # Gestes à la souris dans la timeline
    canvas = win.timeline.canvas
    app.processEvents()
    rows = canvas.rows()
    tr_row = next(r for r in rows if r.kind == "track")
    x = canvas.geo.x(clip.start + 1.0)
    y = int(tr_row.y + tr_row.h / 2)
    drag(canvas, QPoint(int(x), y), QPoint(int(x + canvas.geo.pps * 1.0), y))
    clip = ed.doc.timeline.find_clip(clip.id)[1]
    check("glisser un clip (aimanté)", abs(clip.start - tl.snap_time(1.0, force=True)) < 1e-6, f"début {clip.start:.3f}")
    ed.undo()
    clip = ed.doc.timeline.find_clip(clip.id)[1]
    ed.select_clip(clip.id)
    # Zone de temps (Ctrl + glisser) : copier le clip + le vide, coller à la tête de lecture, à la suite
    tl_ = ed.doc.timeline
    tr_row = next(r for r in canvas.rows() if r.kind == "track")
    yy = int(tr_row.y + tr_row.h / 2)
    span = clip.duration + tl_.beat_len / 4          # le clip + un quart de temps de vide
    n_clips = sum(1 for _ in tl_.all_clips())
    drag(canvas, QPoint(int(canvas.geo.x(clip.start)) + 1, yy), QPoint(int(canvas.geo.x(clip.start + span)), yy),
         M.ControlModifier)
    rs = canvas.range_sel
    span = tl_.snap_time(clip.start + span) - clip.start      # aimantée à la grille
    check("Ctrl + glisser : zone de temps sélectionnée", rs is not None and abs((rs[1] - rs[0]) - span) < 1e-6
          and len(canvas.clips_in_range()) == 1, f"{rs}")
    canvas.setFocus()
    app.processEvents()
    win.copy_pressed()
    paste_at = clip.end + 2.0
    ed.set_playhead(paste_at)
    win.paste_pressed()
    win.paste_pressed()
    tl_ = ed.doc.timeline
    starts = sorted(c.start for _, c in tl_.all_clips())
    pasted = [c for _, c in tl_.all_clips() if c.id != clip.id]
    check("coller deux fois : à la tête de lecture puis à la suite, même écart",
          sum(1 for _ in tl_.all_clips()) == n_clips + 2 and any(abs(s - paste_at) < 1e-6 for s in starts)
          and any(abs(s - (paste_at + span)) < 1e-6 for s in starts) and abs(ed.playhead - (paste_at + 2 * span)) < 1e-6,
          f"{starts} tête {ed.playhead:.3f}")
    check("clip collé : même animation (liée)", all(c.anim_id == clip.anim_id for c in pasted))
    ed.undo()
    ed.undo()
    canvas.clear_range()
    tl_ = ed.doc.timeline
    clip = tl_.find_clip(clip.id)[1]
    # Clips d'une même forme : ils partagent leur animation (D5) ; délier / relier
    cl2 = ed.add_clip(clip.def_id, tl_.tracks[0].id, clip.end + 3.0, 1.0)
    check("nouveau clip de la forme : même animation", cl2.anim_id == clip.anim_id)
    linked, shared = ed.clip_is_linked(cl2)
    check("icône de lien : animation partagée", linked and shared)
    ed.unlink_clip(cl2.id)
    tl_ = ed.doc.timeline
    clip, cl2 = tl_.find_clip(clip.id)[1], tl_.find_clip(cl2.id)[1]
    a1, a2 = tl_.animations[clip.anim_id], tl_.animations[cl2.anim_id]
    check("délier : copie de l'animation (la forme reste commune)", cl2.def_id == clip.def_id and a1 is not a2
          and [e.type_id for e in a2.effects] == ["translate"] and a2.effects[0].id != a1.effects[0].id
          and ed.clip_is_linked(cl2) == (False, False))
    ed.relink_clip(cl2.id)
    tl_ = ed.doc.timeline
    clip, cl2 = tl_.find_clip(clip.id)[1], tl_.find_clip(cl2.id)[1]
    check("relier : l'animation des autres clips de la forme", cl2.anim_id == clip.anim_id and len(tl_.animations) == 1)
    ed.undo()
    ed.undo()
    ed.undo()
    tl_ = ed.doc.timeline
    clip = tl_.find_clip(clip.id)[1]
    # Pas de chevauchement : un clip glissé sur son voisin s'arrête contre lui
    c2 = ed.add_clip(clip.def_id, tl_.tracks[0].id, clip.end + 1.0, 1.0)
    app.processEvents()
    tr_row = next(r for r in canvas.rows() if r.kind == "track")
    yy = int(tr_row.y + tr_row.h / 2)
    x2 = int(canvas.geo.x(c2.start + 0.5))
    drag(canvas, QPoint(x2, yy), QPoint(x2 - int(canvas.geo.pps * 3.0), yy), M.AltModifier)
    c2 = ed.doc.timeline.find_clip(c2.id)[1]
    check("glisser un clip sur son voisin : il s'arrête contre lui", abs(c2.start - clip.end) < 1e-6,
          f"{c2.start:.3f} / fin du voisin {clip.end:.3f}")
    ed.undo()
    tl_ = ed.doc.timeline
    clip, c2 = tl_.find_clip(clip.id)[1], tl_.find_clip(c2.id)[1]
    # Multi-sélection de clips : rectangle, Cmd/Ctrl + clic, déplacement en bloc, Ctrl+A, Ctrl+D, Suppr
    x_end = int(canvas.geo.x(c2.end)) + 20
    drag(canvas, QPoint(x_end, int(tr_row.y) + 2), QPoint(int(canvas.geo.x(clip.start + 1.0)), yy))
    check("rectangle de sélection : les deux clips", canvas.sel_clips == {clip.id, c2.id}, str(len(canvas.sel_clips)))
    s1, s2 = clip.start, c2.start
    x1 = int(canvas.geo.x(c2.start + 0.5))
    drag(canvas, QPoint(x1, yy), QPoint(x1 + int(canvas.geo.pps), yy), M.AltModifier)
    tl_ = ed.doc.timeline
    clip, c2 = tl_.find_clip(clip.id)[1], tl_.find_clip(c2.id)[1]
    check("glisser un clip sélectionné : tous bougent ensemble", abs((clip.start - s1) - 1.0) < 0.05
          and abs((c2.start - s2) - 1.0) < 0.05, f"{clip.start - s1:.3f} / {c2.start - s2:.3f}")
    ed.undo()
    tl_ = ed.doc.timeline
    clip, c2 = tl_.find_clip(clip.id)[1], tl_.find_clip(c2.id)[1]
    app.processEvents()
    click(canvas, QPoint(int(canvas.geo.x(clip.start + 1.0)), yy))
    click(canvas, QPoint(int(canvas.geo.x(c2.start + 0.5)), yy), M.ControlModifier)
    check("Cmd/Ctrl + clic : ajouter à la sélection", canvas.sel_clips == {clip.id, c2.id})
    click(canvas, QPoint(int(canvas.geo.x(c2.start + 0.5)), yy), M.ControlModifier)
    check("Cmd/Ctrl + clic : retirer de la sélection", canvas.sel_clips == {clip.id} and ed.current_clip() is clip)
    canvas.setFocus()
    app.processEvents()
    win.select_all_pressed()
    check("Ctrl+A dans la timeline : tous les clips", canvas.sel_clips == {clip.id, c2.id})
    n = sum(1 for _ in tl_.all_clips())
    win.duplicate_pressed()
    tl_ = ed.doc.timeline
    starts = sorted(c.start for _, c in tl_.all_clips())
    check("Ctrl+D : la sélection est recopiée juste après", sum(1 for _ in tl_.all_clips()) == n + 2
          and any(abs(s - c2.end) < 1e-6 for s in starts) and len(canvas.sel_clips) == 2)
    canvas.delete_selection()
    check("Suppr : supprime les clips sélectionnés", sum(1 for _ in ed.doc.timeline.all_clips()) == n)
    ed.undo()
    ed.undo()
    ed.undo()
    canvas.set_clip_selection(())
    tl_ = ed.doc.timeline
    clip = tl_.find_clip(clip.id)[1]
    ed.select_clip(clip.id)
    # Raccourcir le clip : la courbe de l'effet garde ses proportions (clés en proportion de la durée)
    anim = tl_.animations[clip.anim_id]
    keys0 = [(k.t, k.v) for e in anim.effects for t in e.params.values() for k in t.curve.keys]
    d0 = clip.duration
    tr_row = next(r for r in canvas.rows() if r.kind == "track")
    yy = int(tr_row.y + tr_row.h / 2)
    drag(canvas, QPoint(int(canvas.geo.x(clip.end)) - 2, yy),
         QPoint(int(canvas.geo.x(clip.start + d0 / 2)) - 2, yy), M.AltModifier)
    tl_ = ed.doc.timeline
    clip = tl_.find_clip(clip.id)[1]
    f = clip.duration / d0
    keys1 = [(k.t, k.v) for e in tl_.animations[clip.anim_id].effects for t in e.params.values() for k in t.curve.keys]
    check("raccourcir le clip : la courbe garde ses proportions", abs(f - 0.5) < 0.05 and keys0 == keys1 and keys0,
          f"facteur {f:.3f}")
    ed.undo()
    clip = ed.doc.timeline.find_clip(clip.id)[1]
    # Double-clic sur un clip : sa forme s'ouvre dans l'espace Forme
    tr_row = next(r for r in canvas.rows() if r.kind == "track")
    pt = QPoint(int(canvas.geo.x(clip.start + 1.0)), int(tr_row.y + tr_row.h / 2))
    send(canvas, QEvent.Type.MouseButtonDblClick, pt, Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton, M.NoModifier)
    app.processEvents()
    check("double-clic sur un clip : sa forme s'ouvre dans Forme", ed.workspace == "forme"
          and ed.current_form_id() == clip.def_id and win.canvas.header.name_label.text() == d.name)
    ed.set_current_form(F1)
    ed.set_workspace("show")
    t_before = ed.playhead
    win.playback.play()
    import time as _t
    _t.sleep(0.05)
    for _ in range(5):
        win.playback._tick()
    win.playback.pause()
    check("lecture : la tête avance", ed.playhead > t_before, f"{t_before:.3f} → {ed.playhead:.3f}")
    # Pavé tactile : deux doigts = défilement horizontal ET vertical
    from PySide6.QtGui import QWheelEvent
    for _ in range(12):        # assez de pistes pour dépasser la hauteur de la timeline
        ed.add_track()
    canvas.geo.t0, canvas.geo.scroll_y = 2.0, 0
    canvas.resize(canvas.width(), 140)
    pos = QPointF(400, 120)
    ev = QWheelEvent(pos, canvas.mapToGlobal(pos), QPoint(30, -40), QPoint(30, -40), Qt.MouseButton.NoButton,
                     M.NoModifier, Qt.ScrollPhase.ScrollUpdate, False)
    QApplication.sendEvent(canvas, ev)
    check("pavé tactile : défilement sur le côté et vers le bas", canvas.geo.t0 < 2.0 and canvas.geo.scroll_y > 0,
          f"t0 {canvas.geo.t0:.3f}, y {canvas.geo.scroll_y}")
    for _ in range(3):
        ed.undo()
    canvas.geo.t0, canvas.geo.scroll_y = 0.0, 0
    app.processEvents()
    shot(win, "03_timeline")

    # ── Sortie live ──────────────────────────────────────────────────────
    ed.enter_def(F1)
    inst = root().children[0]
    ed.set_selection([inst.id])
    app.processEvents()
    from ildagen.ui.properties.forms import ParamForm
    from ildagen.core import nodes as N
    old_tx = N.get_param(inst, "tf.tx")
    ed.mutate("test", lambda: N.set_param(inst, "tf.tx", 0.25))
    app.processEvents()
    form = next((f for f in win.properties.findChildren(ParamForm) if f.node() is inst), None)
    ok = form is not None and not form.is_default() and win.properties.reset_btn.isEnabled()
    if ok:
        f_tx = form.fields["tf.tx"]
        send(f_tx, QEvent.Type.MouseButtonPress, QPoint(f_tx.width() // 2, f_tx.height() // 2),
             Qt.MouseButton.RightButton, Qt.MouseButton.RightButton, M.NoModifier)
        app.processEvents()
    check("clic droit sur un réglage : valeur par défaut (↺ du panneau éteint)", ok
          and abs(N.get_param(inst, "tf.tx")) < 1e-9 and not win.properties.reset_btn.isEnabled(),
          f"{N.get_param(inst, 'tf.tx')}")
    ed.mutate("test", lambda: N.set_param(inst, "tf.tx", old_tx))
    before = ed.effective_transform(inst).sx
    ed.flip_selection(True)
    check("retourner horizontalement", ed.find(inst.id).transform.sx * before < 0 or
          abs(abs(ed.find(inst.id).transform.rot) - 180) < 1e-6)
    live_checks(app, win, check)

    # ── Symétrie de dessin : modifieur ajouté automatiquement, le trait reste simple ──
    from ildagen.core import draw_symmetry as DS
    from ildagen.core import nodes as N
    ed.set_symmetry(1)
    ed.set_tool("pencil")
    n_before = len(root().children)
    drag(view, sp(0.2, 0.2), sp(0.5, 0.35))
    g = root().children[0]
    stroke = g.children[1] if g.kind == "group" and len(g.children) == 2 else None
    check("symétrie de dessin : groupe « Symétrie » + modifieur ajoutés, le trait reste un seul trait",
          stroke is not None and g.name == "Symétrie" and g.children[0].mod_type == "mirror_sym"
          and len(stroke.paths) == 1 and len(root().children) == n_before + 1)
    drag(view, sp(0.3, -0.2), sp(0.6, -0.4))
    check("trait suivant (même mode) : sous le même modifieur", len(g.children) == 3
          and len(root().children) == n_before + 1)
    ed.set_symmetry(3)
    ed.set_tool("shape:rect")
    drag(view, sp(0.2, 0.2), sp(0.5, 0.5))
    g2 = root().children[0]
    check("mode changé : nouveau groupe avec son modifieur (4 quarts)", g2 is not g and g2.kind == "group"
          and N.get_param(g2.children[0], "axes") == 2 and g2.children[1].kind == "shape"
          and len(root().children) == n_before + 2)
    shot(win, "04_symetrie")
    ed.set_symmetry(count=6)
    check("radiale ×6", DS.modifier_spec(ed.doc.grid) == ("radial_sym", {"count": 6, "angle": 0.0, "kaleido": False}))
    ed.set_symmetry(0)
    for _ in range(3):
        ed.undo()
    check("symétrie de dessin annulable", len(root().children) == n_before)
    ed.set_tool("select")

    # ── Dupliquer un groupe : ses oscillateurs sont dupliqués ──
    from ildagen.core.nodes import ShapeNode as _SN
    from ildagen.core.oscillator import Osc
    fnew = ed.new_form("Groupes")
    sh = ed.add_node(_SN("line"))
    ed.set_selection([sh.id])
    ed.group_selected()
    grp = ed.top_selected()[0]
    ed.set_selection([sh.id])
    dm = ed.add_modifier("dots")
    ed.set_osc(ed.find(dm.id), "phase", Osc("vitesse", speed=0.5, sync=False))
    ed.set_selection([grp.id])
    copies = ed.duplicate_selection()
    dots = [n for c in copies for n in c.walk() if n.kind == "modifier"]
    check("dupliquer un groupe : ses oscillateurs sont dupliqués", len(dots) == 1 and dots[0].id != dm.id
          and dots[0].osc["phase"].speed == 0.5 and ed.find(dm.id).osc["phase"] is not dots[0].osc["phase"])
    ed.display_strokes()
    check("forme avec un oscillateur : la mire tourne en boucle", ed.is_animated())
    ed.delete_def(fnew.id)
    ed.enter_def(F1)

    # ── Liste des formes : clic = afficher / éditer, + = nouvelle forme ──
    lst = win.tools.defs
    n_forms = len(ed.doc.library.defs)
    win.tools.btn_new.click()
    app.processEvents()
    new = ed.current_form()
    check("+ : nouvelle forme vide, sélectionnée", len(ed.doc.library.defs) == n_forms + 1 and not new.root.children
          and ed.current_form_id() == new.id and lst.current_id() == new.id and lst.tile(new.id).selected
          and win.canvas.header.name_label.text() == new.name, new.name)
    ed.set_tool("shape:ellipse")
    drag(view, sp(-0.2, -0.2), sp(0.2, 0.2))
    check("on dessine directement dans la forme choisie", len(new.root.children) == 1 and not
          any(c.shape == "ellipse" and c.local_bbox()[0] < -0.19 for c in root().children if c.kind == "shape"))
    tile = lst.tile(F1)
    click(tile, tile.rect().center())
    check("clic sur une forme de la liste : elle s'affiche et ses calques aussi", ed.current_form_id() == F1
          and ed.workspace == "forme" and win.layers.tree.model_.rowCount() == len(root().children))
    dup = ed.duplicate_form(new.id)
    check("dupliquer une forme", dup is not None and len(dup.root.children) == 1 and dup.root.children[0].id !=
          new.root.children[0].id and ed.current_form_id() == dup.id)
    ed.delete_def(dup.id)
    check("supprimer la forme en cours : on passe sur une autre", ed.doc.library.get(dup.id) is None
          and ed.current_root() is not None)
    ed.delete_def(new.id)
    ed.enter_def(F1)
    ed.set_tool("select")

    # ── Enregistrer / ouvrir ─────────────────────────────────────────────
    path = os.path.join(tempfile.mkdtemp(), "test.ildaproj")
    win.project._write(path)
    ed.dirty = False
    win.project.open(path)
    check("projet rouvert", len(ed.doc.library.defs) == 2 and ed.doc.timeline.has_clips())
    from ildagen.editor.export import export_ilda
    n = export_ilda(ed, os.path.join(tempfile.mkdtemp(), "t.ild"), 5, 25, 0.0, 4.0)
    check("export ILDA de l'animation", n == 100, f"{n} images")
    # Suppr sur une forme personnalisée de la liste de gauche (annulable)
    motif = next(x for x in ed.doc.library.defs if x.id != F1)
    ed.enter_def(motif.id)                  # comme un clic sur la forme dans la liste
    win.tools.defs.setFocus()
    app.processEvents()
    win.tools.defs.delete_current()
    check("Suppr supprime la forme personnalisée", len(ed.doc.library.defs) == 1 and not ed.doc.timeline.has_clips(), f"{[d.name for d in ed.doc.library.defs]} {[(c.def_id, c.start) for _, c in ed.doc.timeline.all_clips()]}")
    ed.undo()
    check("annuler la suppression de la forme", len(ed.doc.library.defs) == 2 and ed.doc.timeline.has_clips())
    ed.dirty = False
    gestures_and_safety(app, win)
    ed.dirty = False
    # Fermeture comme dans l'application (vérifie aussi qu'elle ne plante pas) ; le live actif à la fermeture
    # est mémorisé pour le prochain lancement
    from ildagen.app import shutdown
    settings = win.settings
    win.live.set_live(True)
    win.close()
    check("live actif à la fermeture : mémorisé", settings.get("general", "live_last") is True)
    print("\n" + ("TOUT EST OK" if not errors else f"{len(errors)} problème(s) : {', '.join(errors)}"))
    shutdown(win, app)
    return 1 if errors else 0


def gestures_and_safety(app, win):
    """Gestes annulables (outil changé, Échap, Ctrl+Z), état d'affichage hors historique, flèches regroupées,
    formes nulles, valeurs tapées, fichiers abîmés, sauvegardes automatiques jamais écrasées."""
    import json
    from PySide6.QtGui import QColor, QKeyEvent
    from PySide6.QtWidgets import QColorDialog, QMessageBox
    from shiboken6 import isValid
    from ildagen.core import autosave as AS
    from ildagen.core.document import Document
    from ildagen.core.timeline import MAX_DURATION
    from ildagen.ui.properties.forms import ParamForm

    ed = win.editor
    view = win.canvas.view
    proj = win.project
    L, NB = Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton
    messages = []
    saved = {k: getattr(QMessageBox, k) for k in ("critical", "warning", "information", "question")}
    QMessageBox.critical = lambda *a, **k: messages.append(("critical", a[2] if len(a) > 2 else ""))
    QMessageBox.warning = lambda *a, **k: messages.append(("warning", a[2] if len(a) > 2 else ""))
    QMessageBox.information = lambda *a, **k: messages.append(("information", ""))
    QMessageBox.question = lambda *a, **k: QMessageBox.StandardButton.Discard

    def press(w, p, mods=M.NoModifier):
        send(w, QEvent.Type.MouseButtonPress, p, L, L, mods)

    def move(w, p, mods=M.NoModifier, buttons=L):
        send(w, QEvent.Type.MouseMove, p, NB, buttons, mods)

    def release(w, p, mods=M.NoModifier):
        send(w, QEvent.Type.MouseButtonRelease, p, L, NB, mods)
        app.processEvents()

    def key(w, k, mods=M.NoModifier):
        QApplication.sendEvent(w, QKeyEvent(QEvent.Type.KeyPress, k, mods))
        QApplication.sendEvent(w, QKeyEvent(QEvent.Type.KeyRelease, k, mods))
        app.processEvents()

    def root():
        return ed.current_root()

    def kids():
        return len(root().children)

    def steps():
        return len(ed.history.undo_stack)

    def sp(x, y):
        p = view.vt.to_screen(x, y)
        return QPoint(int(round(p.x())), int(round(p.y())))

    def center(node_id):
        q = build_frame(ed, ed.eval_context()).quad if ed.selection == [node_id] else None
        if q is None:
            ed.set_selection([node_id])
            q = build_frame(ed, ed.eval_context()).quad
        return float(q[:, 0].mean()), float(q[:, 1].mean())

    def handles():
        fr = build_frame(ed, ed.eval_context())
        return {k: QPoint(int(round(v.x())), int(round(v.y()))) for k, v in handle_positions(view.vt, fr).items()}

    def grab(node_id):
        """Point du contour gauche de la forme, loin des poignées (centre = pivot, milieu du côté = poignée)."""
        ed.set_selection([node_id])
        q = build_frame(ed, ed.eval_context()).quad
        y0, y1 = float(q[:, 1].min()), float(q[:, 1].max())
        return sp(float(q[:, 0].min()), y0 + 0.25 * (y1 - y0))

    def load_json(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def form_for(node_id):
        app.processEvents()
        return next((f for f in win.properties.findChildren(ParamForm)
                     if isValid(f) and f.node_id == node_id and f.isVisibleTo(win.properties)), None)

    proj.timer.stop()
    proj.new()
    ed.set_symmetry(0)
    ed.set_grid_mode(1)
    view.setFocus()
    app.processEvents()

    # ── A1 : changer d'outil pendant un geste l'annule ──────────────────
    ed.set_tool("shape:rect")
    drag(view, sp(-0.6, 0.6), sp(-0.3, 0.3))
    rect_id = root().children[0].id
    n0, s0 = kids(), steps()
    press(view, sp(0.2, 0.6))
    move(view, sp(0.3, 0.5))
    move(view, sp(0.5, 0.3))
    drawing = kids() == n0 + 1 and ed.gesture_active() and win.actions_["cancel_gesture"].isEnabled()
    ed.set_tool("select")                     # V avant de relâcher
    move(view, sp(0.6, 0.2))
    release(view, sp(0.6, 0.2))
    check("outil changé pendant un tracé : la forme en cours est annulée", drawing and kids() == n0
          and steps() == s0 and not ed.gesture_active() and not win.actions_["cancel_gesture"].isEnabled())
    ed.set_selection([rect_id])
    c0 = center(rect_id)
    key(view, Qt.Key.Key_Right)
    ed.undo()
    check("… puis un petit pas : Ctrl+Z n'annule que le petit pas", ed.find(rect_id) is not None
          and kids() == n0 and abs(center(rect_id)[0] - c0[0]) < 1e-5)
    ed.set_tool("pencil")
    press(view, sp(0.1, -0.2))
    for i in range(1, 10):
        move(view, sp(0.1 + i * 0.04, -0.2 - i * 0.03))
    ed.set_tool("shape:rect")                 # R avant de relâcher
    release(view, sp(0.5, -0.5))
    check("crayon puis R pendant le trait : trait annulé, rien d'ouvert", kids() == n0 and steps() == s0
          and not ed.gesture_active())
    ed.set_tool("select")
    ed.set_selection([rect_id])
    a = grab(rect_id)
    press(view, a)
    move(view, QPoint(a.x() + 20, a.y()))
    move(view, QPoint(a.x() + 40, a.y()))
    moved = abs(center(rect_id)[0] - c0[0]) > 1e-3
    ed.set_tool("shape:polygon")              # P avant de relâcher
    release(view, QPoint(a.x() + 40, a.y()))
    check("déplacement puis P : la forme revient à sa place, rien d'ouvert", moved
          and abs(center(rect_id)[0] - c0[0]) < 1e-5 and steps() == s0 and not ed.gesture_active(),
          f"{moved} {center(rect_id)[0] - c0[0]} {steps() - s0} {ed.gesture_active()}")
    ed.set_tool("select")
    ed.set_selection([rect_id])
    drag(view, a, QPoint(a.x() + 30, a.y()))
    c1 = center(rect_id)
    ed.set_tool("pencil")
    click(view, sp(0.8, -0.8))                # simple clic au crayon (rien n'est dessiné)
    check("un clic au crayon ensuite n'annule pas le déplacement", abs(center(rect_id)[0] - c1[0]) < 1e-5
          and steps() == s0 + 1, f"{c1[0]:.3f} → {center(rect_id)[0]:.3f}")
    ed.undo()

    # ── A2 : Ctrl+Z / Ctrl+Y pendant un geste n'annulent que le geste ───
    ed.set_tool("shape:ellipse")
    n0, s0 = kids(), steps()
    press(view, sp(0.3, 0.3))
    move(view, sp(0.4, 0.4))
    move(view, sp(0.6, 0.6))
    ed.undo()
    release(view, sp(0.6, 0.6))
    check("Ctrl+Z pendant un tracé : seul le tracé est annulé", kids() == n0 and steps() == s0
          and ed.find(rect_id) is not None and not ed.gesture_active())
    drag(view, sp(0.3, 0.3), sp(0.6, 0.6))
    ed.undo()                                  # une action à rétablir
    ed.set_tool("select")
    ed.set_selection([rect_id])
    c0 = center(rect_id)
    a = grab(rect_id)
    press(view, a)
    move(view, QPoint(a.x() + 30, a.y()))
    ed.redo()
    move(view, QPoint(a.x() + 50, a.y()))
    release(view, QPoint(a.x() + 50, a.y()))
    check("Ctrl+Y pendant un déplacement : seul le déplacement est annulé (rien n'est rétabli)",
          abs(center(rect_id)[0] - c0[0]) < 1e-5 and kids() == n0 and len(ed.history.redo_stack) == 1
          and not ed.gesture_active())
    ed.redo()
    ed.undo()
    check("… et l'annulation suivante ne défait que l'action rétablie", kids() == n0 and ed.find(rect_id) is not None)

    # ── A3 : Échap annule le geste en cours ─────────────────────────────
    ed.set_tool("shape:rect")
    n0, s0 = kids(), steps()
    press(view, sp(0.2, -0.2))
    move(view, sp(0.4, -0.4))
    key(view, Qt.Key.Key_Escape)
    move(view, sp(0.5, -0.5))
    release(view, sp(0.5, -0.5))
    check("Échap pendant un tracé de forme : rien n'est créé", kids() == n0 and steps() == s0)
    ed.set_tool("pencil")
    press(view, sp(0.2, -0.2))
    for i in range(1, 8):
        move(view, sp(0.2 + i * 0.03, -0.2 - i * 0.03))
    key(view, Qt.Key.Key_Escape)
    release(view, sp(0.5, -0.5))
    check("Échap pendant un trait au crayon : rien n'est créé", kids() == n0 and steps() == s0)
    ed.set_tool("select")
    ed.set_selection([rect_id])
    c0 = center(rect_id)
    a = grab(rect_id)
    press(view, a)
    move(view, QPoint(a.x() + 40, a.y() + 10))
    key(view, Qt.Key.Key_Escape)
    move(view, QPoint(a.x() + 60, a.y() + 10))
    release(view, QPoint(a.x() + 60, a.y() + 10))
    check("Échap pendant un déplacement : la forme revient, la sélection reste", abs(center(rect_id)[0] - c0[0]) < 1e-5
          and steps() == s0 and ed.selection == [rect_id])
    for hid in ("c1", "rot", "pivot"):
        node = ed.find(rect_id)
        before = (node.transform.to_dict(), node.rect)
        h = handles()
        press(view, h[hid])
        move(view, QPoint(h[hid].x() + 25, h[hid].y() - 15))
        changed = (ed.find(rect_id).transform.to_dict(), ed.find(rect_id).rect) != before
        key(view, Qt.Key.Key_Escape)
        release(view, QPoint(h[hid].x() + 25, h[hid].y() - 15))
        node = ed.find(rect_id)
        check(f"Échap pendant la poignée « {hid} » : rien ne change", changed and (node.transform.to_dict(), node.rect) == before
              and steps() == s0)
    key(view, Qt.Key.Key_Escape)
    check("Échap sans geste : désélectionne (comme avant)", ed.selection == [])

    # Réglage glissé (Propriétés) puis Échap : action « Annuler le geste en cours »
    ed.set_selection([rect_id])
    form = form_for(rect_id)
    field = form.fields["tf.rot"]
    r0 = ed.find(rect_id).transform.rot
    c = QPoint(field.width() // 2, field.height() // 2)
    press(field, c)
    move(field, QPoint(c.x() + 30, c.y()))
    scrubbed = ed.find(rect_id).transform.rot != r0 and win.actions_["cancel_gesture"].isEnabled()
    win.actions_["cancel_gesture"].trigger()
    if isValid(field):
        move(field, QPoint(c.x() + 60, c.y()))
        release(field, QPoint(c.x() + 60, c.y()))
    check("Échap pendant un réglage glissé : valeur d'avant, rien d'enregistré", scrubbed
          and ed.find(rect_id).transform.rot == r0 and steps() == s0 and not ed.param_editing)

    # Timeline : Échap pendant le glisser d'un clip
    fid = ed.current_form_id()
    clip = ed.add_clip(fid, ed.doc.timeline.tracks[0].id, 1.0, 2.0)
    ed.enter_def(fid)
    s0 = steps()
    canvas = win.timeline.canvas
    app.processEvents()
    tr_row = next(r for r in canvas.rows() if r.kind == "track")
    y = int(tr_row.y + tr_row.h / 2)
    x = int(canvas.geo.x(clip.start + 1.0))
    press(canvas, QPoint(x, y))
    move(canvas, QPoint(x + int(canvas.geo.pps), y))
    clip_moved = abs(ed.doc.timeline.find_clip(clip.id)[1].start - 1.0) > 0.1
    key(canvas, Qt.Key.Key_Escape)
    move(canvas, QPoint(x + 2 * int(canvas.geo.pps), y))
    release(canvas, QPoint(x + 2 * int(canvas.geo.pps), y))
    check("Échap pendant le glisser d'un clip : il revient à sa place", clip_moved
          and abs(ed.doc.timeline.find_clip(clip.id)[1].start - 1.0) < 1e-5 and steps() == s0)
    # Relâchement jamais reçu (fenêtre quittée) : le geste est annulé au mouvement suivant
    press(canvas, QPoint(x, y))
    move(canvas, QPoint(x + int(canvas.geo.pps), y))
    move(canvas, QPoint(x + int(canvas.geo.pps), y), buttons=NB)
    check("timeline : relâchement perdu = glisser annulé", abs(ed.doc.timeline.find_clip(clip.id)[1].start - 1.0) < 1e-5
          and not ed.gesture_active())
    ed.enter_def(fid)
    ed.set_tool("select")
    ed.set_selection([rect_id])
    c0 = center(rect_id)
    a = grab(rect_id)
    press(view, a)
    move(view, QPoint(a.x() + 30, a.y()))
    win._app_state(Qt.ApplicationState.ApplicationInactive)      # autre application au premier plan
    release(view, QPoint(a.x() + 30, a.y()))
    check("l'application perd la main pendant un déplacement : annulé", abs(center(rect_id)[0] - c0[0]) < 1e-5
          and not ed.gesture_active())

    # ── A4 : l'état d'affichage n'est pas annulé, mais il est enregistré ─
    s0 = steps()
    ed.set_tool("shape:rect")
    n0 = kids()
    drag(view, sp(0.5, -0.5), sp(0.8, -0.8))
    ed.set_grid_mode(2)
    ed.set_symmetry(1)
    ed.set_snap(False)
    clip = ed.doc.timeline.find_clip(clip.id)[1]
    ed.set_clip_expanded(clip.id, True)        # déplier le clip
    no_step = steps() == s0 + 1
    ed.undo()
    g = ed.doc.grid
    clip = ed.doc.timeline.find_clip(clip.id)[1]
    check("annuler ne touche pas l'affichage (grille, symétrie, aimant, clip déplié)", no_step and kids() == n0
          and g.mode == 2 and g.sym == 1 and not g.snap and clip.expanded, f"{g.mode} {g.sym} {g.snap} {clip.expanded}")
    ed.set_symmetry(0)
    ed.set_snap(True)
    ed.set_grid_mode(1)
    ed.set_tool("select")
    # Groupe replié dans la liste des calques, maîtres, espace actif : gardés après annuler, sans étape
    ed.set_selection([rect_id])
    ed.group_selected()
    grp_id = ed.selection[0]
    s0 = steps()
    ed.set_expanded(ed.find(grp_id), False)
    ed.set_master("brightness", 60.0)
    ed.set_workspace("show")
    ed.set_workspace("forme")
    no_step = steps() == s0 and ed.view_dirty
    ed.rename(ed.find(rect_id), "Renommé")
    ed.undo()
    check("annuler garde le dépliage des calques, les maîtres et l'espace actif", no_step
          and not ed.find(grp_id).expanded and ed.doc.masters.brightness == 60.0 and ed.workspace == "forme"
          and ed.find(rect_id).name != "Renommé")
    ed.set_master("brightness", 100.0)
    ed.undo()
    path = os.path.join(tempfile.mkdtemp(), "vue.ildaproj")
    proj._write(path)
    ed.set_grid_mode(2)
    proj.autosave()
    check("affichage modifié : enregistré par la sauvegarde automatique (projet nommé)",
          Document.load(path).grid.mode == 2 and not ed.view_dirty)
    ed.set_grid_mode(1)
    ed.set_selection([rect_id])
    a = grab(rect_id)
    press(view, a)
    move(view, QPoint(a.x() + 30, a.y()))
    proj.autosave()                                # pendant le geste : rien n'est écrit
    waited = Document.load(path).grid.mode == 2
    key(view, Qt.Key.Key_Escape)
    release(view, QPoint(a.x() + 30, a.y()))
    proj.autosave()
    proj.timer.stop()
    check("sauvegarde automatique : attend la fin du geste (jamais un état annulé ensuite)", waited
          and Document.load(path).grid.mode == 1)

    # ── A5 : flèche maintenue = une seule étape ─────────────────────────
    ed.set_selection([rect_id])
    s0 = steps()
    c0 = center(rect_id)
    for _ in range(6):
        key(view, Qt.Key.Key_Right)
    one = steps() == s0 + 1 and center(rect_id)[0] > c0[0] + 0.02
    ed.undo()
    check("flèche répétée : une seule étape d'annulation", one and abs(center(rect_id)[0] - c0[0]) < 1e-5)
    key(view, Qt.Key.Key_Right)
    ed.history.undo_stack[-1].time -= 5.0      # une pause
    key(view, Qt.Key.Key_Right)
    check("flèche après une pause : nouvelle étape", steps() == s0 + 2)
    ed.undo()
    ed.undo()

    # ── A6 : une opération qui échoue ne laisse rien d'ouvert ───────────
    s0, n0 = steps(), kids()

    def failing():
        root().children.pop(0)
        raise ValueError("échec voulu")
    raised = False
    try:
        ed.mutate("Échec", failing)
    except ValueError:
        raised = True
    ed.rename(ed.find(rect_id), "Rect A6")
    check("opération en échec : annulée, l'action suivante a sa propre étape", raised and kids() == n0
          and steps() == s0 + 1 and ed.history.undo_label() == "Renommer")
    ed.undo()

    # ── A7 : Ctrl+Z pendant un réglage glissé ; couleur annulée dans un clip ─
    ed.set_selection([rect_id])
    s0 = steps()
    form = form_for(rect_id)
    field = form.fields["tf.rot"]
    r0 = ed.find(rect_id).transform.rot
    press(field, c)
    move(field, QPoint(c.x() + 30, c.y()))
    editing = ed.param_editing
    ed.undo()
    if isValid(field):
        release(field, QPoint(c.x() + 30, c.y()))
    check("Ctrl+Z pendant un réglage glissé : annulé, la mire réaffiche la sélection", editing
          and not ed.param_editing and ed.find(rect_id).transform.rot == r0 and steps() == s0)
    field = form_for(rect_id).fields["tf.rot"]
    drag(field, c, QPoint(c.x() + 30, c.y()))
    check("le réglage suivant est bien enregistré", steps() == s0 + 1
          and ed.history.undo_label() == "Réglage : Rotation" and not ed.param_editing)
    ed.undo()
    ed.set_selection([rect_id])
    s0 = steps()
    col0 = tuple(ed.find(rect_id).color)
    swatch = form_for(rect_id).fields["col.color"]
    real_exec = QColorDialog.exec

    def cancelled_dialog(dlg):
        dlg.currentColorChanged.emit(QColor(255, 0, 0))     # aperçu en direct…
        return 0                                           # … puis « Annuler »
    QColorDialog.exec = cancelled_dialog
    try:
        swatch.click()
    finally:
        QColorDialog.exec = real_exec
    app.processEvents()
    check("couleur annulée : rien n'est écrit, aucune étape", tuple(ed.find(rect_id).color) == col0
          and steps() == s0 and not ed.gesture_active())

    # ── S1 : forme revenue au point de départ = pas de forme ────────────
    for kind in ("rect", "line"):
        ed.set_tool("shape:" + kind)
        n0, s0 = kids(), steps()
        a = sp(0.0, -0.6)
        press(view, a)
        move(view, QPoint(a.x() + 20, a.y() + 10))
        move(view, QPoint(a.x() + 1, a.y()))
        release(view, QPoint(a.x() + 1, a.y()))
        check(f"forme « {kind} » ramenée au départ : pas créée", kids() == n0 and steps() == s0 and not ed.gesture_active())
    click(view, sp(0.0, -0.6))
    check("simple clic avec une forme : taille par défaut (inchangé)", kids() == n0 + 1)
    ed.undo()
    ed.set_tool("select")

    # ── S9 : valeurs tapées infinies / NaN refusées, clip borné ─────────
    ed.set_selection([rect_id])
    field = form_for(rect_id).fields["tf.rot"]
    r0 = ed.find(rect_id).transform.rot
    def typed(f, txt):
        f.start_typing()
        f.typing_editor().setText(txt)
        f._commit_typing()
    for txt in ("inf", "nan", "-inf"):
        typed(field, txt)
    ok_inf = ed.find(rect_id).transform.rot == r0
    typed(field, "1e308")
    check("réglage tapé : inf / nan refusés, valeur énorme ramenée au maximum", ok_inf
          and ed.find(rect_id).transform.rot == 360.0, f"{ed.find(rect_id).transform.rot}")
    ed.undo()
    ed.set_workspace("show")
    ed.select_clip(clip.id)
    ed.clear_selection()
    app.processEvents()
    dur = win.show_space.inspector._clip_fields["duration"]
    d0 = ed.current_clip().duration
    dur.setText("inf")
    dur._typed()
    ok_inf = ed.current_clip().duration == d0
    dur.setText("1e308")
    dur._typed()
    check("durée du clip : inf refusé, maximum 1 h", ok_inf and ed.current_clip().duration == MAX_DURATION)
    ed.current_clip().duration = float("inf")
    canvas.grab()                                  # dessin de la timeline sans erreur
    check("clip : durée infinie impossible", ed.current_clip().duration == MAX_DURATION)
    ed.undo()

    # ── S10 : oscillateur posé sur un réglage depuis l'espace Forme ──────
    ed.enter_def(fid)
    ed.set_selection([rect_id])
    n_err = len(errors)
    ed.set_osc(ed.find(rect_id), "tf.rot")
    app.processEvents()
    check("oscillateur sur un réglage (Forme) : pas d'erreur, on reste sur le calque, valeur de base intacte",
          len(errors) == n_err and ed.selection == [rect_id] and form_for(rect_id) is not None
          and "tf.rot" in ed.find(rect_id).osc and ed.find(rect_id).transform.rot == r0)
    ed.undo()
    check("oscillateur annulable", not ed.find(rect_id).osc)

    # ── S7 : projets / sauvegardes abîmés : message, jamais de plantage ─
    folder = tempfile.mkdtemp()
    bad_list = os.path.join(folder, "liste.ildaproj")
    with open(bad_list, "w") as f:
        json.dump([1, 2, 3], f)
    bad_types = os.path.join(folder, "types.ildaproj")
    with open(bad_types, "w") as f:
        json.dump({"version": 3, "library": [{"id": "x", "name": "F", "root": {"kind": "group", "children": 5}}]}, f)
    bad_json = os.path.join(folder, "json.ildaproj")
    with open(bad_json, "w") as f:
        f.write("{pas du json")
    doc_before = ed.doc
    for p in (bad_list, bad_types, bad_json):
        messages.clear()
        ok = proj.open(p)
        check(f"projet abîmé ({os.path.basename(p)}) : message, projet en cours gardé", not ok and ed.doc is doc_before
              and messages and messages[0][0] == "critical", str(messages))
    net = os.path.join(folder, "reseau.ildaproj")
    d = Document().to_dict()
    d["network"] = {"port": "abc", "channel": 99}
    with open(net, "w") as f:
        json.dump(d, f)
    ok = proj.open(net)
    check("réglages réseau abîmés dans un projet : ouvert, valeurs sûres", ok and ed.settings.get("network", "port") == 7255
          and ed.settings.get("network", "channel") == 16)
    from ildagen.core.document import LEGACY_MESSAGE
    old = os.path.join(folder, "ancien.ildaproj")
    with open(old, "w") as f:
        json.dump({"version": 4, "library": [{"id": "A", "name": "A", "automations": [{"id": "x", "node_id": "r", "key": "tf.tx", "keys": []}],
                                               "root": {"kind": "group", "id": "r", "name": "A", "children": []}}],
                   "timeline": {"tracks": [{"name": "P", "clips": [{"def_id": "A", "start": 0, "duration": 2}]}]}}, f)
    status = []
    ed.statusMessage.connect(status.append)
    ok = proj.open(old)
    ed.statusMessage.disconnect(status.append)
    check("ancien projet (v4) : ouvert, message « animations retirées »", ok and proj.last_notice == LEGACY_MESSAGE
          and any(LEGACY_MESSAGE in m for m in status) and ed.doc.timeline.has_clips(), str(status))
    newer = os.path.join(folder, "futur.ildaproj")
    d = Document().to_dict()
    d["version"] = 99
    with open(newer, "w") as f:
        json.dump(d, f)
    messages.clear()
    ok = proj.open(newer)
    ed.set_tool("shape:rect")
    drag(view, sp(-0.2, -0.2), sp(0.2, 0.2))
    proj.autosave()
    check("format plus récent : avertissement, ouvert, jamais réécrit automatiquement", ok and messages
          and messages[0][0] == "warning" and load_json(newer)["version"] == 99 and not proj.auto_on())
    ed.set_tool("select")
    s = ed.settings
    s.set("general", "reopen_last", True)
    proj.new()                                     # comme au lancement : projet vide
    s.set("ui", "last_project", bad_types)
    messages.clear()
    proj.restore_session()
    check("dernier projet abîmé au démarrage : message, projet vide, pas de nouvel essai", messages
          and not ed.doc.path and not ed.doc.library.defs[0].root.children and s.get("ui", "last_project") == "",
          f"{messages} {ed.doc.path} {len(ed.doc.library.defs[0].root.children)} {s.get('ui', 'last_project')}")

    # ── S8 : la sauvegarde automatique d'un projet sans nom n'est jamais perdue ─
    proj.new()
    ed.set_tool("shape:star")
    drag(view, sp(-0.3, 0.3), sp(0.3, -0.3))
    proj.timer.stop()
    proj.autosave()                                # travail sans nom n° 1
    for p_ in AS.backups(proj.backup_dir):
        os.remove(p_)
    first = load_json(proj.autosave_path)
    proj.new()                                     # comme un lancement qui ne rouvre pas ce travail
    proj.autosave()
    untouched = load_json(proj.autosave_path) == first
    ed.set_tool("shape:ellipse")
    drag(view, sp(-0.3, 0.3), sp(0.3, -0.3))
    proj.timer.stop()
    proj.autosave()                                # travail n° 2 : le n° 1 est d'abord copié
    proj.autosave()
    backs = AS.backups(proj.backup_dir)
    shapes = lambda d: [c.get("shape") for c in d["library"][0]["root"]["children"]]  # noqa: E731
    check("nouveau travail sans nom : l'ancien est copié dans les sauvegardes datées (une seule fois)",
          untouched and len(backs) == 1 and shapes(load_json(backs[0])) == ["star"]
          and shapes(load_json(proj.autosave_path)) == ["ellipse"])
    check("menu Fichier → Récupérer une sauvegarde automatique…", win.actions_["recover_backup"].text()
          == "Récupérer une sauvegarde automatique…")
    ok = proj.open_backup(backs[0])
    check("sauvegarde récupérée : projet sans nom avec l'ancien travail", ok and not ed.doc.path and ed.dirty
          and [c.shape for c in root().children] == ["star"])
    proj.autosave()
    check("… et le travail qu'elle remplace est copié à son tour", len(AS.backups(proj.backup_dir)) == 2)
    ed.set_tool("select")
    proj.timer.stop()
    for k, v in saved.items():
        setattr(QMessageBox, k, v)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(2)
