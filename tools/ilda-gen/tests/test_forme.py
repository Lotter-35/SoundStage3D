"""Test de l'espace Forme sans écran :  QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_forme.py

Panneaux Réglages (champs, oscillateurs, cartes de modifieurs, réglages masqués selon le mode, calque
verrouillé), liste « + Modifieur » avec recherche, liste des formes en vignettes, barre de boucle, et les bugs
corrigés de l'audit (C1–C13, M1–M8, F3, F6) — par des gestes simulés à la souris et au clavier.
"""

import os
import sys
import tempfile
import time
import traceback

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("XDG_CONFIG_HOME", tempfile.mkdtemp())

from PySide6.QtCore import QEvent, QPoint, QPointF, Qt  # noqa: E402
from PySide6.QtGui import QKeyEvent, QMouseEvent  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from ildagen.core.nodes import GroupNode, ShapeNode  # noqa: E402
from ildagen.core.oscillator import Osc  # noqa: E402
from ildagen.core.settings import Settings  # noqa: E402
from ildagen.ui import theme  # noqa: E402
from ildagen.ui.canvas.tools.selection_frame import build_frame, handle_positions, hit_handle  # noqa: E402
from ildagen.ui.main_window import MainWindow  # noqa: E402

M = Qt.KeyboardModifier
L, R, NB = Qt.MouseButton.LeftButton, Qt.MouseButton.RightButton, Qt.MouseButton.NoButton
errors = []


def check(name, cond, detail=""):
    print(("OK   " if cond else "BUG  ") + name + (f"  ({detail})" if detail else ""))
    if not cond:
        errors.append(name)


def send(w, kind, pos, button, buttons, mods=M.NoModifier):
    QApplication.sendEvent(w, QMouseEvent(kind, QPointF(pos), QPointF(w.mapToGlobal(pos)), button, buttons, mods))


def drag(w, a, b, mods=M.NoModifier, steps=8):
    send(w, QEvent.Type.MouseButtonPress, a, L, L, mods)
    for i in range(1, steps + 1):
        p = QPoint(int(a.x() + (b.x() - a.x()) * i / steps), int(a.y() + (b.y() - a.y()) * i / steps))
        send(w, QEvent.Type.MouseMove, p, NB, L, mods)
    send(w, QEvent.Type.MouseButtonRelease, b, L, NB, mods)
    QApplication.processEvents()


def click(w, p, mods=M.NoModifier, button=L):
    send(w, QEvent.Type.MouseButtonPress, p, button, button, mods)
    send(w, QEvent.Type.MouseButtonRelease, p, button, NB, mods)
    QApplication.processEvents()


def key(w, k, mods=M.NoModifier, text=""):
    QApplication.sendEvent(w, QKeyEvent(QEvent.Type.KeyPress, k, mods, text))
    QApplication.sendEvent(w, QKeyEvent(QEvent.Type.KeyRelease, k, mods, text))
    QApplication.processEvents()


def main():
    app = QApplication([])
    sys.excepthook = lambda t, v, tb: (traceback.print_exception(t, v, tb), check(f"exception {t.__name__} : {v}", False))
    app.setStyle("Fusion")
    theme.apply_palette(app)
    win = MainWindow(Settings(path=os.path.join(tempfile.mkdtemp(), "s.json")))
    win.resize(1440, 900)
    win.show()
    app.processEvents()
    ed = win.editor
    view, tree, reg = win.canvas.view, win.layers.tree, win.properties

    def steps():
        return len(ed.history.undo_stack)

    def sp(x, y):
        p = view.vt.to_screen(x, y)
        return QPoint(int(round(p.x())), int(round(p.y())))

    def mid(w):
        return QPoint(w.width() // 2, w.height() // 2)

    # ── Réglages d'un calque ─────────────────────────────────────────────
    star = ed.add_node(ShapeNode("star", rect=(-0.4, -0.4, 0.4, 0.4)))
    ed.set_selection([star.id])
    app.processEvents()
    form = reg.form
    check("calque sélectionné : ses réglages dans Réglages", form is not None and form.node_id == star.id
          and {"sp.branches", "sp.ratio", "tf.tx", "tf.rot", "tf.sx", "col.color"} <= set(form.fields))
    check("unités affichées (position en % de la mire, rotation en °, creux en %)",
          form.fields["tf.tx"].display_text().endswith("%") and form.fields["tf.rot"].display_text().endswith("°")
          and form.fields["sp.ratio"].display_text().endswith("%"), form.fields["tf.tx"].display_text())
    check("titre : nom + type, en texte brut", reg.title.name.full_text() == "Étoile"
          and "étoile" in reg.title.kind.full_text())
    f = form.fields["tf.rot"]
    s0, r0 = steps(), star.transform.rot
    drag(f, mid(f), QPoint(mid(f).x() + 40, mid(f).y()))
    check("glisser un slider : le calque change, une seule étape d'annulation",
          ed.find(star.id).transform.rot > r0 and steps() == s0 + 1, f"{ed.find(star.id).transform.rot}")
    ed.undo()
    check("… annulé d'un coup", abs(ed.find(star.id).transform.rot - r0) < 1e-9)
    f = reg.form.fields["tf.rot"]
    f.setFocus()
    ed.mutate("t", lambda: setattr(ed.find(star.id).transform, "rot", 33.0))
    app.processEvents()
    check("C7/C8 : champ qui a le focus mis à jour par un changement venu d'ailleurs", abs(f.value() - 33.0) < 1e-9)
    key(f, Qt.Key.Key_Return)
    ed_line = f.typing_editor()
    check("… Entrée : la saisie part de la valeur actuelle (jamais une valeur périmée)",
          ed_line is not None and ed_line.text() == "33,0", ed_line.text() if ed_line else "")
    f._close_editor()
    ed.undo()

    # ── Oscillateur ──────────────────────────────────────────────────────
    f = reg.form.fields["tf.rot"]
    s0 = steps()
    click(f, QPoint(f.width() - 8, f.height() // 2))
    from ildagen.ui.properties.osc_popup import OscPopup
    pops = [w for w in [getattr(reg.form, "popup", None)] if isinstance(w, OscPopup)]   # (fermé tout seul hors écran)
    node = ed.find(star.id)
    check("∿ : oscillateur posé (une étape) et son éditeur ouvert", "tf.rot" in node.osc and pops
          and steps() == s0 + 1, f"{list(node.osc)} {len(pops)} {steps() - s0}")
    app.processEvents()
    f = reg.form.fields["tf.rot"]
    check("champ avec oscillateur : résumé « ~ … » et bouton accent", f.display_text().startswith("~") and f._osc_on,
          f.display_text())
    if pops:
        pop = pops[0]
        s1 = steps()
        oe = pop.osc_editor
        oe.mode.currentChanged.emit(1)      # Vitesse
        oe._discrete(mode="vitesse")
        check("éditer l'oscillateur : une étape", ed.find(star.id).osc["tf.rot"].mode == "vitesse" and steps() == s1 + 1)
        app.processEvents()
        check("résumé en vitesse « ~ … °/temps »", "°/temps" in reg.form.fields["tf.rot"].display_text(),
              reg.form.fields["tf.rot"].display_text())
        oe.removeRequested.emit()
        app.processEvents()
        check("retirer l'oscillateur", "tf.rot" not in ed.find(star.id).osc and not reg.form.fields["tf.rot"]._osc_on)
    ed.undo()
    ed.undo()
    ed.undo()
    check("oscillateur : annuler le retire", not ed.find(star.id).osc)
    tx = ed.find(star.id)
    ed.set_osc(tx, "tf.tx", Osc(depth=0.5))
    pop = reg.form.open_osc("tf.tx")
    check("oscillateur d'une position : amplitude montrée en % (50 %)",
          pop is not None and abs(pop.osc_editor.depth.value() - 50.0) < 1e-6, f"{pop.osc_editor.depth.value()}")
    pop.close()
    ed.undo()

    # ── Réglages masqués selon le mode ───────────────────────────────────
    strobe = ed.add_modifier("strobe")
    app.processEvents()
    fm = reg.form
    check("modifieur sélectionné : ses réglages directement", fm.node_id == strobe.id and "division" in fm.fields)
    check("Stroboscope calé sur le tempo : Division montrée, Fréquence masquée",
          fm.rows["division"].isVisibleTo(fm) and not fm.rows["rate"].isVisibleTo(fm))
    ed.mutate("t", lambda: ed.find(strobe.id).values.__setitem__("sync", 0))
    app.processEvents()
    fm = reg.form
    check("… en Hz : Fréquence montrée, Division masquée",
          fm.rows["rate"].isVisibleTo(fm) and not fm.rows["division"].isVisibleTo(fm))
    alt = ed.add_modifier("alternate")
    app.processEvents()
    fm = reg.form
    check("Segments alternés à 2 couleurs : couleurs 3 et 4 masquées", not fm.rows["c3"].isVisibleTo(fm)
          and not fm.rows["c4"].isVisibleTo(fm) and fm.rows["c2"].isVisibleTo(fm))
    rnd = ed.add_modifier("random_color")
    app.processEvents()
    fm = reg.form
    check("Couleur aléatoire : liste de couleurs seulement avec « Couleurs choisies » ; Graine à plage confortable",
          not fm.rows["colors"].isVisibleTo(fm) and fm.fields["seed"].soft_max <= 1000)
    grad = ed.add_modifier("gradient")
    app.processEvents()
    fm = reg.form
    check("Dégradé le long du tracé : angle et centre masqués", not fm.rows["angle"].isVisibleTo(fm)
          and not fm.rows["cx"].isVisibleTo(fm))
    from ildagen.core.modifiers import registry
    check("vocabulaire : Points, Faisceaux, Dosage", registry["dots"].label == "Points"
          and registry["beams"].label == "Faisceaux" and registry["color"].spec("mix").label == "Dosage")

    # ── Cartes des modifieurs qui agissent sur le calque ─────────────────
    ed.set_selection([star.id])
    app.processEvents()
    ids = [c.mod_id for c in reg.cards]
    check("cartes : les modifieurs au-dessus du calque, le plus proche d'abord",
          ids == [strobe.id, alt.id, rnd.id, grad.id], str(len(ids)))
    card = reg.cards[0]
    s0 = steps()
    card.switch.click()
    app.processEvents()
    check("interrupteur de la carte = œil du modifieur (une étape)", not ed.find(strobe.id).visible and steps() == s0 + 1)
    check("… sous-titre « désactivé »", "désactivé" in reg.cards[0].subtitle.text())
    ed.undo()
    app.processEvents()
    card = reg.cards[0]
    was = card.is_expanded()
    card._toggle_expanded()
    check("carte dépliée : ses réglages (construits à l'ouverture), état gardé hors annulation",
          card.is_expanded() != was and (card.form is not None or was) and ed.find(strobe.id).show_params != was)

    # ── Liste « + Modifieur » avec recherche ─────────────────────────────
    picker = win.layers.open_picker()
    app.processEvents()
    heads = [picker.list.item(i) for i in range(picker.list.count())
             if not (picker.list.item(i).flags() & Qt.ItemFlag.ItemIsEnabled)]
    check("C14 : catégories visibles", len(heads) >= 6 and all(h.text() for h in heads))
    for ch in "point":
        key(picker.search, Qt.Key.Key_unknown, text=ch)
    picker.search.setText("point")
    vis = [it.text() for it in picker.visible_items()]
    check("recherche « point » (sans accents) : Points proposé", "Points" in vis and len(vis) < 6, str(vis))
    s0 = steps()
    key(picker.search, Qt.Key.Key_Return)
    sel = ed.selected_nodes()
    check("Entrée : le modifieur est ajouté", sel and sel[0].kind == "modifier" and sel[0].mod_type == "dots"
          and steps() == s0 + 1)
    # C13 : modifieur ajouté avec un sous-modifieur sélectionné : à côté de son modifieur
    sub = ed.add_modifier("rotate", onto=ed.find(strobe.id))
    parent_idx = ed.find(strobe.id).index()
    new = ed.add_modifier("dimmer")
    check("C13 : ajouté à côté du modifieur porteur, pas en haut de la forme", new.index() == parent_idx
          and new.parent is ed.find(strobe.id).parent, f"{new.index()} / {parent_idx}")
    ed.set_selection([sub.id])

    # ── Calque verrouillé ────────────────────────────────────────────────
    ed.set_locked([ed.find(star.id)], True)
    ed.set_selection([star.id])
    app.processEvents()
    check("C6 : calque verrouillé, champs grisés", all(not r.isEnabled() for r in reg.form.rows.values()))
    ed.set_locked([ed.find(star.id)], False)
    app.processEvents()
    check("… déverrouillé : champs actifs", all(r.isEnabled() for r in reg.form.rows.values()))

    # ── C12 : arrondi affiché, nom en texte brut, champ de renommage ─────
    ed.mutate("t", lambda: setattr(ed.find(star.id).transform, "tx", 0.000004))
    app.processEvents()
    check("C12 : 0,0004 % affiché « 0,0 % » = valeur par défaut (↺ éteint)", not reg.reset_btn.isEnabled())
    ed.rename(ed.find(star.id), "<b>gras</b> " + "très long nom " * 6)
    app.processEvents()
    check("C12 : nom affiché tel quel (pas de HTML)", reg.title.name.full_text().startswith("<b>gras</b>"))
    ix = tree.model_.index_for_id(star.id)
    tree.edit(ix)
    app.processEvents()
    from ildagen.ui.layers.delegate import lock_rect
    editors = [w for w in tree.viewport().findChildren(QApplication.instance().focusWidget().__class__)] \
        if QApplication.focusWidget() else []
    lr = lock_rect(tree.visualRect(ix))
    ok = bool(editors) and all(e.geometry().right() < lr.left() for e in editors)
    check("C12 : le champ de renommage ne recouvre pas le verrou", ok)
    key(QApplication.focusWidget(), Qt.Key.Key_Escape)

    # ── Arbre : défilement, groupes, clavier, double-clic ────────────────
    g = ed.add_node(GroupNode("Groupe"))
    for i in range(30):
        ed.add_node(ShapeNode("rect", rect=(-0.1, -0.1, 0.1, 0.1), name=f"Carré {i}"), parent=ed.find(g.id), index=0)
    ed.set_expanded(ed.find(g.id), False)
    ed.set_selection([ed.find(g.id).children[5].id])
    app.processEvents()
    check("C2 : groupe ouvert pour montrer la sélection", ed.find(g.id).expanded)
    ed.notify(structure=True)
    app.processEvents()
    check("C2 : … il reste ouvert après une reconstruction",
          tree.isExpanded(tree.model_.index_for_id(g.id)))
    bar = tree.verticalScrollBar()
    bar.setValue(bar.maximum())
    app.processEvents()
    far = ed.find(g.id).children[-1]
    pos0 = bar.value()
    r = tree.visualRect(tree.model_.index_for_id(far.id))
    from ildagen.ui.layers.delegate import eye_rect
    click(tree.viewport(), eye_rect(r).center())
    check("C1 : clic sur un œil tout en bas : la liste ne remonte pas", not ed.find(far.id).visible
          and bar.value() == pos0 and pos0 > 0, f"{pos0} → {bar.value()}")
    t0 = time.perf_counter()
    for _ in range(4):
        ed.set_visible(ed.find(far.id), True)
        app.processEvents()
        ed.set_visible(ed.find(far.id), False)
        app.processEvents()
    dt = (time.perf_counter() - t0) / 8 * 1000
    ed.undo()
    app.processEvents()
    r = tree.visualRect(tree.model_.index_for_id(far.id))
    vis0 = ed.find(far.id).visible
    send(tree.viewport(), QEvent.Type.MouseButtonPress, eye_rect(r).center(), L, L)
    send(tree.viewport(), QEvent.Type.MouseButtonRelease, eye_rect(r).center(), L, NB)
    send(tree.viewport(), QEvent.Type.MouseButtonDblClick, eye_rect(r).center(), L, L)
    send(tree.viewport(), QEvent.Type.MouseButtonRelease, eye_rect(r).center(), L, NB)
    app.processEvents()
    check("C4 : double-clic sur l'œil = deux clics, pas de renommage", ed.find(far.id).visible == vis0
          and tree.state() != tree.State.EditingState)
    ed.set_selection([ed.find(g.id).children[3].id])
    app.processEvents()
    tree.setFocus()
    key(tree, Qt.Key.Key_Down)
    check("C3 : flèche ↓ dans l'arbre : calque suivant sélectionné", ed.selection == [ed.find(g.id).children[4].id],
          str(ed.selection))
    tree.context_menu_builder = None
    from PySide6.QtGui import QContextMenuEvent

    # C10 : œil / annuler sur une forme à 13 modifieurs : rapide, sans reconstruction
    ed.new_form("Lourde")
    base = ed.add_node(ShapeNode("ellipse", rect=(-0.5, -0.5, 0.5, 0.5)))
    for t in ("translate", "rotate", "scale", "dots", "color", "rainbow", "wave", "strobe", "pulse", "dimmer",
              "mirror_sym", "radial_sym", "trim"):
        ed.set_selection([base.id])
        ed.add_modifier(t)
    ed.set_selection([base.id])
    app.processEvents()
    win.forme.tools.defs.anim.stop()
    sig = tree.model_.sig
    n, busy = 6, 0.0
    t0 = time.perf_counter()
    for _ in range(n):
        for act in (lambda: ed.set_visible(ed.find(base.id), False), ed.undo):
            t1 = time.perf_counter()
            act()                         # traitement du clic (arbre, Réglages, cartes, annuler compris)
            busy += time.perf_counter() - t1
            app.processEvents()           # dessins ensuite (mire, vignette : calcul des 13 modifieurs)
    total = (time.perf_counter() - t0) / (2 * n) * 1000
    dt = busy / (2 * n) * 1000
    check("C10 : œil / annuler avec 13 modifieurs : sans reconstruire l'arbre", tree.model_.sig is sig)
    print(f"     (œil ou annuler : {dt:.1f} ms de traitement, {total:.1f} ms avec les dessins de la mire et de la vignette)")
    check("C10 : … traitement < 30 ms", dt < 30, f"{dt:.1f} ms")
    win.forme.tools.defs.anim.start()

    # ── C11 : dépôt impossible ───────────────────────────────────────────
    m0 = next(n for n in ed.current_root().children if n.kind == "modifier")
    check("C11 : une forme ne se dépose pas dans un modifieur", not ed.can_drop(ed.find(base.id), m0))
    status = []
    ed.statusMessage.connect(status.append)
    ok = ed.move_nodes([base.id], m0.id, 0)
    ed.statusMessage.disconnect(status.append)
    check("… déplacement refusé", not ok)

    # ── Liste des formes ─────────────────────────────────────────────────
    lib = win.tools.defs
    n0 = lib.count()
    click(lib.add_tile, mid(lib.add_tile))
    check("case « + » : nouvelle forme, devenue la forme en cours", lib.count() == n0 + 1
          and lib.current_id() == ed.current_form_id() and lib.tile(ed.current_form_id()).selected)
    lone = ed.add_node(ShapeNode("rect"))
    ed.set_selection([lone.id])
    app.processEvents()
    p_empty = QPoint(10, tree.viewport().height() - 4)
    tree.contextMenuEvent(QContextMenuEvent(QContextMenuEvent.Reason.Mouse, p_empty, tree.viewport().mapToGlobal(p_empty)))
    check("C5 : clic droit dans le vide de l'arbre : le menu ne vise aucun calque", not tree.indexAt(p_empty).isValid()
          and ed.selection == [])
    fid = ed.current_form_id()
    e = lib.start_rename(fid)
    e.setText("Renommée")
    key(e, Qt.Key.Key_Return)
    check("renommer sur place (double-clic sur la vignette)", ed.doc.library.get(fid).name == "Renommée"
          and lib.tile(fid).name == "Renommée")
    ed.duplicate_form(fid)
    check("dupliquer une forme", lib.count() == n0 + 2)
    lib.delete_current()
    check("supprimer une forme", lib.count() == n0 + 1)
    from ildagen.ui.canvas.view import DEF_MIME
    check("glisser une vignette : même type de données qu'avant (timeline)", DEF_MIME == "application/x-ildagen-def")
    t = lib.tile(ed.doc.library.defs[0].id)
    lib.cache.scene(t.def_id)
    check("F3 : cadrage de la vignette sur tout le contenu (jamais coupé)",
          lib.cache.scenes[t.def_id].bbox is not None)

    # ── Barre de boucle ──────────────────────────────────────────────────
    lb = win.forme.loop_bar
    ed.enter_def(ed.doc.library.defs[0].id)
    lb.btn_loop.click()
    t1 = ed.loop_time()
    time.sleep(0.05)
    check("Boucle en pause : le temps de la forme s'arrête", ed.loop_paused() and abs(ed.loop_time() - t1) < 1e-6)
    lb.btn_loop.click()
    time.sleep(0.03)
    check("… relancée : il repart d'où il était", not ed.loop_paused() and ed.loop_time() > t1)
    lb.speed.currentChanged.emit(2)
    c0, l0 = win.forme.clock.time(), ed.loop_time()
    time.sleep(0.1)
    c1, l1 = win.forme.clock.time(), ed.loop_time()
    check("aperçu 2× : la mire va deux fois plus vite (pas le laser)", abs((c1 - c0) - 2 * (l1 - l0)) < 0.02)
    lb.speed.currentChanged.emit(1)
    lb.bpm.setText("128")
    lb._bpm_typed()
    check("Tempo : celui du projet (timeline)", ed.doc.timeline.bpm == 128)
    from ildagen.ui.forme.loop_bar import meter_state
    from ildagen.editor.live_worker import FrameInfo
    info = FrameInfo()
    info.count, info.budget = 684, 1000
    text, ratio, col = meter_state(info)
    check("compteur : « 684 points », vert sous le budget", text == "684 points" and col == "LIVE")
    info.reduced = True
    check("… rouge si l'image a été allégée", meter_state(info)[2] == "DANGER")
    ed.add_node(ShapeNode("rect"))
    t_end = time.time() + 2
    while time.time() < t_end and not win.live.stats.count:
        app.processEvents()
        time.sleep(0.02)
    check("compteur hors live : les points de l'aperçu (plus de « Aucun tracé »)", win.live.stats.count > 0
          and "point" in lb.points.text(), lb.points.text())

    # ── Mire : M1, M2, M3, M7, M8 ────────────────────────────────────────
    ed.set_tool("select")
    view.fit_view()
    small = ed.add_node(ShapeNode("rect", rect=(0.5, 0.5, 0.53, 0.53)))
    ed.set_selection([small.id])
    fr = build_frame(ed, ed.eval_context())
    pos = handle_positions(view.vt, fr)
    hid = hit_handle(view.vt, fr, pos["c1"])
    check("M2 : petite forme : le coin est attrapé (pas le pivot)", hid == "c1", str(hid))
    big = ed.add_node(ShapeNode("rect", rect=(-0.5, -0.5, 0.0, 0.0)))
    ed.set_selection([big.id])
    ed.set_grid_mode(1)
    ed.set_snap(True)
    pos = handle_positions(view.vt, build_frame(ed, ed.eval_context()))
    a = QPoint(int(pos["e1"].x()), int(pos["e1"].y()))
    drag(view, a, sp(-0.5, -0.25))
    tf = ed.find(big.id).transform
    check("M1 : aimant sur le point d'ancrage : l'échelle n'est jamais nulle", abs(tf.sx) >= 1e-3, f"{tf.sx}")
    pos = handle_positions(view.vt, build_frame(ed, ed.eval_context()))
    drag(view, QPoint(int(round(pos["c1"].x())), int(round(pos["c1"].y()))), sp(0.1, 0.0))
    check("… et la forme peut être ré-agrandie", ed.find(big.id).transform.sx > 0.5, f"{ed.find(big.id).transform.sx}")
    ed.set_snap(False)
    n0, s0 = len(ed.current_root().children), steps()
    c = sp(-0.25, -0.5)
    click(view, c, M.AltModifier)
    check("M3 : Alt + clic sans bouger : aucune copie, aucune étape", len(ed.current_root().children) == n0
          and steps() == s0)
    ed.set_selection([big.id])
    q = build_frame(ed, ed.eval_context()).quad
    a = sp(float(q[:, 0].min()), float(q[:, 1].min() + 0.25 * (q[:, 1].max() - q[:, 1].min())))
    drag(view, a, QPoint(a.x() - 40, a.y()), M.AltModifier)
    check("M3 : Alt + glisser : une copie, une seule étape", len(ed.current_root().children) == n0 + 1
          and steps() == s0 + 1)
    ed.undo()
    # M8 : coin d'une forme inclinée en 3D : la poignée suit la souris
    ed.set_selection([big.id])
    ed.mutate("t", lambda: (setattr(ed.find(big.id).transform, "tilt_y", 40.0),
                            setattr(ed.find(big.id).transform, "tilt_x", 20.0)))
    pos = handle_positions(view.vt, build_frame(ed, ed.eval_context()))
    a = QPoint(int(pos["c1"].x()), int(pos["c1"].y()))
    b = QPoint(a.x() + 40, a.y() - 30)
    drag(view, a, b)
    pos = handle_positions(view.vt, build_frame(ed, ed.eval_context()))
    d = ((pos["c1"].x() - b.x()) ** 2 + (pos["c1"].y() - b.y()) ** 2) ** 0.5
    check("M8 : coin d'une forme inclinée : il suit la souris", d < 2.5, f"écart {d:.1f} px")
    view.vt.pan_pixels(-100000, 100000)
    from PySide6.QtCore import QRectF
    from ildagen.ui.canvas.painter import mire_rect
    inter = mire_rect(view.vt).normalized().intersected(QRectF(view.rect()))
    check("M8 : déplacement de la vue borné (la mire reste à l'écran)", inter.width() >= 40 and inter.height() >= 40,
          str(inter))
    view.fit_view()
    from ildagen.core import grid as G
    p = G.snap_point((1.3, 0.0), ed.doc.grid.__class__())
    gp = ed.doc.grid.__class__()
    gp.mode = 2
    p = G.snap_point((1.3, 0.05), gp)
    check("M8 : aimant polaire au-delà du dernier cercle : sur ce cercle", abs((p[0] ** 2 + p[1] ** 2) ** 0.5 - 1.0) < 1e-9)
    ed.set_workspace("show")
    n0 = len(ed.current_root().children)
    ed.set_tool("shape:rect")
    drag(view, sp(0.1, 0.1), sp(0.3, 0.3))
    check("M7 : hors de l'espace Forme, aucun outil n'agit", len(ed.current_root().children) == n0)
    ed.set_workspace("forme")
    ed.set_tool("select")

    # ── M5 : adresse du serveur ─────────────────────────────────────────
    from ildagen.ui.shell.connection_popup import ConnectionPopup
    cp = ConnectionPopup(ed.settings, win.live)
    host0 = ed.settings.get("network", "host")
    cp.host.setText("300.1.2.3")
    cp.host.editingFinished.emit()
    check("M5 : adresse IP invalide refusée (message)", ed.settings.get("network", "host") == host0
          and "invalide" in cp.state.text())
    cp.host.setText("10.0.0.7")
    cp.host.editingFinished.emit()
    check("M5 : adresse IP valide gardée", ed.settings.get("network", "host") == "10.0.0.7")
    cp.host.setText("localhost")
    cp.host.editingFinished.emit()
    check("M5 : nom d'hôte résolu (DNS)", ed.settings.get("network", "host") == "127.0.0.1")
    cp.close()

    # ── F6 : lettres des raccourcis à côté des icônes ────────────────────
    from ildagen.ui.forme.tool_column import BTN_W, ICON, KEY_W
    b = win.forme.tools.column.buttons["select"]
    check("F6 : la lettre a sa propre place (ne recouvre pas l'icône)", (BTN_W - KEY_W - ICON) // 2 + 1 + ICON
          <= BTN_W - KEY_W - 2 and "(V)" in b.toolTip())
    # C9 : panneau étroit : libellés tronqués « … », valeurs entières
    win.forme.split.setSizes([200, 1000, 250])
    ed.set_selection([star.id])
    app.processEvents()
    win.grab()
    fl = reg.form.fields["tf.tilt_x"]
    check("C9 : panneau étroit : la barre garde sa place", fl.bar_rect().width() >= 60, f"{fl.bar_rect().width()}")
    win.forme.reset_layout()
    s = win.forme.save_layout()
    check("C17 : disposition mémorisée (Calques / Réglages)", "right" in s and win.forme.right_split.sizes()[1] > 300,
          str(win.forme.right_split.sizes()))

    ed.dirty = False
    from ildagen.app import shutdown
    win.close()
    print("\n" + ("TOUT EST OK" if not errors else f"{len(errors)} problème(s) : {', '.join(errors)}"))
    shutdown(win, app)
    return 1 if errors else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(2)
