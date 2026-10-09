"""Test de l'espace Live sans écran :  QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_live.py

Simule la souris et le clavier sur la grille de cues, les pages, les effets rapides et le Tap, et vérifie l'état
du live, l'aperçu de la sortie et l'instantané envoyé au fil de la sortie laser (D11).
"""

import os
import sys
import tempfile
import time
import traceback

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("XDG_CONFIG_HOME", tempfile.mkdtemp())

from PySide6.QtCore import QEvent, QMimeData, QPoint, QPointF, Qt  # noqa: E402
from PySide6.QtGui import QDragEnterEvent, QDropEvent, QKeyEvent, QMouseEvent  # noqa: E402
from PySide6.QtTest import QTest  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from ildagen.core.library import ShapeDef  # noqa: E402
from ildagen.core.live import QUICK_EFFECTS, default_key, loop_length  # noqa: E402
from ildagen.core.nodes import ShapeNode  # noqa: E402
from ildagen.core.oscillator import Osc  # noqa: E402
from ildagen.core.settings import Settings  # noqa: E402
from ildagen.editor import live_snapshot  # noqa: E402
from ildagen.laser.pipeline import SettingsCopy  # noqa: E402
from ildagen.ui import theme  # noqa: E402
from ildagen.ui.canvas.view import DEF_MIME  # noqa: E402
from ildagen.ui.live.cue_grid import CUE_MIME  # noqa: E402
from ildagen.ui.live.menus import KeyDialog, cue_menu, page_menu  # noqa: E402
from ildagen.ui.live.output_panel import TapTempo  # noqa: E402
from ildagen.ui.main_window import MainWindow  # noqa: E402

K = Qt.Key
L, R, N = Qt.MouseButton.LeftButton, Qt.MouseButton.RightButton, Qt.MouseButton.NoButton
NoMod = Qt.KeyboardModifier.NoModifier
errors = []


def check(name, cond, detail=""):
    print(("OK   " if cond else "BUG  ") + name + (f"  ({detail})" if detail else ""))
    if not cond:
        errors.append(name)


def mouse(w, kind, pos, button, buttons):
    pos = QPointF(pos)
    QApplication.sendEvent(w, QMouseEvent(kind, pos, QPointF(w.mapToGlobal(pos)), button, buttons, NoMod))


def click(w, pos=None, button=L):
    pos = pos if pos is not None else QPointF(w.width() / 2, w.height() / 2)
    mouse(w, QEvent.Type.MouseButtonPress, pos, button, button)
    mouse(w, QEvent.Type.MouseButtonRelease, pos, button, N)
    QApplication.processEvents()


def key(w, k, text="", release=True):
    """Touche envoyée comme le ferait le système (raccourcis de la fenêtre compris)."""
    QTest.keyPress(w, k, NoMod) if not text else QApplication.sendEvent(w, QKeyEvent(QEvent.Type.KeyPress, k, NoMod, text))
    if release:
        QTest.keyRelease(w, k, NoMod) if not text else QApplication.sendEvent(w, QKeyEvent(QEvent.Type.KeyRelease, k, NoMod, text))
    QApplication.processEvents()


def drop(w, md):
    pos = QPointF(w.width() / 2, w.height() / 2)
    enter = QDragEnterEvent(pos.toPoint(), Qt.DropAction.MoveAction, md, L, NoMod)
    QApplication.sendEvent(w, enter)
    ev = QDropEvent(pos, Qt.DropAction.MoveAction, md, L, NoMod)
    QApplication.sendEvent(w, ev)
    QApplication.processEvents()
    return enter.isAccepted()


def wait_for(app, cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        app.processEvents()
        if cond():
            return True
        time.sleep(0.005)
    app.processEvents()
    return cond()


def add_form(ed, name, kind, osc=None):
    d = ShapeDef(name)
    n = ShapeNode(kind, (-0.5, -0.5, 0.5, 0.5))
    if osc is not None:
        n.osc["tf.rot"] = osc
    d.root.add(n)
    ed.doc.library.add(d)
    ed.notify(library=True)
    return d


def main():
    app = QApplication([])
    sys.excepthook = lambda t, v, tb: (traceback.print_exception(t, v, tb), check(f"exception {t.__name__} : {v}", False))
    app.setStyle("Fusion")
    theme.apply_palette(app)
    win = MainWindow(Settings(path=os.path.join(tempfile.mkdtemp(), "s.json")))
    win.resize(1440, 900)
    win.show()
    win.activateWindow()
    app.processEvents()
    ed = win.editor
    ws = win.live_space
    grid = ws.grid
    tiles = grid.tiles
    star = add_form(ed, "Étoile", "star", Osc("vitesse", speed=90.0, sync=False))
    rect = add_form(ed, "Carré", "rect")
    circ = add_form(ed, "Cercle", "ellipse", Osc("onde", depth=20.0, division=6))

    # ── Espace Live ─────────────────────────────────────────────────────
    ed.set_workspace("live")
    app.processEvents()
    check("espace Live affiché : grille, horloge et clavier actifs",
          win.stack.currentWidget() is ws and ws.timer.isActive() and ws.keys.installed and len(tiles) == 32)
    check("raccourcis d'outils inactifs hors de Forme",
          not any(a.isEnabled() for k, a in win.actions_.items() if k.startswith("tool_"))
          and not win.actions_["swap_colors"].isEnabled())

    # ── Placer des formes ───────────────────────────────────────────────
    page = ed.live_page()
    md = QMimeData()
    md.setData(DEF_MIME, star.id.encode("utf-8"))
    check("déposer une forme sur une case vide l'y place", drop(tiles[0], md) and page.cues[0] is not None
          and page.cues[0].def_id == star.id)
    menu = cue_menu(grid, ed, 1)
    place = next(a for a in menu.actions() if a.text() == "Placer une forme").menu()
    next(a for a in place.actions() if a.text() == "Carré").trigger()
    check("menu « Placer une forme » : la forme est placée", page.cues[1] is not None and page.cues[1].def_id == rect.id)
    texts = [a.text() for a in cue_menu(grid, ed, 1).actions()]
    check("menu d'un cue : placer, changer la touche, vider la case",
          "Changer la touche…" in texts and "Vider la case" in texts and "Placer une forme" in texts)
    ed.set_cue(page.id, 2, circ.id)
    ed.set_cue(page.id, 9, rect.id)
    app.processEvents()
    check("cases : nom de la forme et touche par défaut (A, Z, E… ; 4e ligne F1-F8)",
          tiles[0].name == "Étoile" and tiles[0].key == "A" and tiles[1].key == "Z" and tiles[9].key == "S"
          and default_key(24) == "F1" and tiles[5].empty and not tiles[0].empty)

    # ── Lancer au clic (départ immédiat) ────────────────────────────────
    ed.set_launch(0)
    ed.set_multi(False)
    click(tiles[0])
    c0, c1 = page.cues[0].id, page.cues[1].id
    check("clic sur une case : le cue part", ed.cue_state(c0) == "playing")
    ws.tick()
    check("case en cours : contour et bandeau accent, barre d'avancement", tiles[0].playing and tiles[0].progress is not None)
    s1 = tiles[0].scene.bbox
    wait_for(app, lambda: tiles[0].scene.bbox != s1, 1.0)
    check("aperçu animé du cue en cours (oscillateurs)", tiles[0].scene.bbox != s1 and not tiles[0].scene.is_empty())
    p0 = tiles[0].progress
    wait_for(app, lambda: tiles[0].progress != p0, 1.0)
    check("barre d'avancement de la boucle (une boucle = la plus longue période)", tiles[0].progress != p0
          and abs(loop_length(star, ed.doc.library, 120.0) - 4.0) < 1e-6)
    wait_for(app, lambda: win.live.stats.count > 0, 1.5)
    ws.tick(advance=False)
    txt = ws.status.text()
    check("barre d'état : cues en cours, points, images/s", ws.status.isVisible() and txt.startswith("1 cue en cours")
          and txt.endswith(f" points · {win.live.fps()} images/s") and " 0 points" not in txt, txt)
    click(tiles[1])
    check("un seul cue : le nouveau arrête le précédent", ed.cue_state(c1) == "playing" and ed.cue_state(c0) is None)
    click(tiles[1])
    check("clic sur un cue en cours : il s'arrête", ed.cue_state(c1) is None)

    # ── Clavier ─────────────────────────────────────────────────────────
    ed.set_multi(True)
    key(grid, K.Key_A)
    key(grid, K.Key_Z)
    check("touches du clavier : les cues partent (plusieurs cues ensemble)",
          ed.cue_state(c0) == "playing" and ed.cue_state(c1) == "playing")
    tool = ed.tool
    key(grid, K.Key_E)      # touche du cue « Cercle » et de l'outil Cercle
    key(grid, K.Key_V)      # outil Sélection : aucun cue sur cette touche
    check("lettres dans Live : cues, jamais les outils", ed.tool == tool and ed.cue_state(page.cues[2].id) == "playing")
    key(grid, K.Key_Space)
    check("Espace dans Live : pas de lecture de la timeline", not win.playback.playing)
    key(grid, K.Key_Escape)
    check("Échap : tous les cues s'arrêtent", not ed.playing_cues())
    key(grid, K.Key_A, release=False)
    QApplication.sendEvent(grid, QKeyEvent(QEvent.Type.KeyPress, K.Key_A, NoMod, "a", True))   # répétition
    QApplication.sendEvent(grid, QKeyEvent(QEvent.Type.KeyRelease, K.Key_A, NoMod, "a", True))
    QApplication.sendEvent(grid, QKeyEvent(QEvent.Type.KeyPress, K.Key_A, NoMod, "a", True))
    QTest.keyRelease(grid, K.Key_A, NoMod)
    check("touche tenue (répétition) : le cue part une fois, il n'est pas arrêté", ed.cue_state(c0) == "playing")
    key(grid, K.Key_A)
    check("nouvel appui : le cue s'arrête", ed.cue_state(c0) is None)

    # ── Départ calé (au temps / à la mesure) : en attente puis en cours ──
    ed.set_launch(2)
    ed.set_live_origin(time.perf_counter() - 1.7)     # 120 BPM : prochaine mesure dans 0,3 s
    click(tiles[0])
    ws.tick()
    check("départ à la mesure : « en attente »", ed.cue_state(c0) == "waiting" and tiles[0].waiting
          and not tiles[0].playing)
    ok = wait_for(app, lambda: tiles[0].playing, 1.5)
    check("puis le cue part sur la mesure", ok and ed.cue_state(c0) == "playing" and not tiles[0].waiting)
    ed.set_launch(1)
    ed.set_live_origin(time.perf_counter() - 0.2)     # prochain temps dans 0,3 s
    click(tiles[1])
    check("départ au temps : en attente", ed.cue_state(c1) == "waiting")
    click(tiles[1])
    check("clic sur un cue en attente : annulé", ed.cue_state(c1) is None)
    ed.set_launch(0)
    ed.stop_all_cues()

    # ── Effets rapides : touches 1 à 8 et boutons, tenus ────────────────
    ed.set_multi(False)
    click(tiles[1])
    n0 = len(ed.display_strokes())
    mirror = next(i for i, q in enumerate(QUICK_EFFECTS) if q.id == "mirror")
    key(grid, getattr(K, f"Key_{mirror + 1}"), release=False)
    ws.tick()
    n1 = len(ed.display_strokes())
    check("chiffre tenu : effet rapide actif (bouton allumé, sortie changée)",
          "mirror" in ed.runtime.held and ws.output.quick[mirror].on and n1 == 2 * n0, f"{n0} → {n1}")
    QTest.keyRelease(grid, getattr(K, f"Key_{mirror + 1}"), NoMod)
    app.processEvents()
    check("chiffre relâché : l'effet s'arrête", "mirror" not in ed.runtime.held and len(ed.display_strokes()) == n0
          and not ws.output.quick[mirror].on)
    key(grid, K.Key_Ampersand, "&", release=False)
    check("AZERTY : « & » tient l'effet 1", QUICK_EFFECTS[0].id in ed.runtime.held)
    key(grid, K.Key_Ampersand, "&")
    check("… et le relâche", QUICK_EFFECTS[0].id not in ed.runtime.held)
    b = ws.output.quick[mirror]
    mouse(b, QEvent.Type.MouseButtonPress, QPointF(5, 5), L, L)
    app.processEvents()
    held = "mirror" in ed.runtime.held and b.on
    ws.tick()
    out_pts = sum(len(s.pts) for s in ed.display_strokes())
    mouse(b, QEvent.Type.MouseButtonRelease, QPointF(5, 5), L, N)
    app.processEvents()
    check("bouton d'effet rapide : actif tant qu'on le tient", held and "mirror" not in ed.runtime.held and not b.on)
    check("aperçu de la sortie : cues + effets rapides", out_pts > 0 and ws.output.view.scene.count > 0)

    # ── Sortie laser : l'instantané suit le Live (D11) ──────────────────
    ed.hold_quick("mirror")
    snap = live_snapshot.take(ed, win.playback, live_snapshot.copy_document(ed.doc), ed.content_rev,
                              SettingsCopy(win.settings), 30)
    strokes, _ = live_snapshot.evaluate_at(snap.doc, snap, snap.frame_time(time.perf_counter()))
    check("instantané de la sortie : mode live, cues en cours et effets rapides",
          snap.mode == "live" and c1 in snap.runtime.cues and "mirror" in snap.runtime.held
          and len(strokes) == len(ed.display_strokes()) and len(strokes) > 0)
    win.live.set_live(True)
    ok = wait_for(app, lambda: win.live.worker._snap is not None and win.live.worker._snap.mode == "live"
                  and c1 in win.live.worker._snap.runtime.cues, 1.5)
    win.live.set_live(False)
    check("envoi live : le fil de sortie reçoit les cues du Live", ok)
    ed.release_quick("mirror")
    ed.stop_all_cues()

    # ── Glisser un cue sur une autre case ───────────────────────────────
    started = []
    real = grid.start_drag
    grid.start_drag = lambda t: started.append(t.slot)
    mouse(tiles[0], QEvent.Type.MouseButtonPress, QPointF(20, 20), L, L)
    mouse(tiles[0], QEvent.Type.MouseMove, QPointF(60, 60), N, L)
    mouse(tiles[0], QEvent.Type.MouseButtonRelease, QPointF(60, 60), L, N)
    grid.start_drag = real
    check("glisser une case : le glisser part, pas de lancement", started == [0] and ed.cue_state(c0) is None)
    check("déposer un cue sur une case vide : il y va", drop(tiles[12], grid.drag_mime(0))
          and page.cues[12] is not None and page.cues[12].id == c0 and page.cues[0] is None and tiles[12].name == "Étoile")
    drop(tiles[1], grid.drag_mime(12))
    check("déposer un cue sur un autre : les cases s'échangent", page.cues[1].id == c0 and page.cues[12].id == c1)
    ed.undo()
    ed.undo()
    page = ed.live_page()
    check("annuler les déplacements", page.cues[0].id == c0 and page.cues[1].id == c1)

    # ── Touche d'un cue ─────────────────────────────────────────────────
    dlg = KeyDialog("Étoile", "A", win)
    dlg.show()
    QApplication.sendEvent(dlg, QKeyEvent(QEvent.Type.KeyPress, K.Key_1, NoMod, "1"))
    refused = dlg.key is None and dlg.isVisible()
    QApplication.sendEvent(dlg, QKeyEvent(QEvent.Type.KeyPress, K.Key_P, NoMod, "p"))
    check("« Changer la touche… » : les chiffres 1-8 refusés, la touche appuyée retenue", refused and dlg.key == "P"
          and not dlg.isVisible())
    win.activateWindow()
    app.processEvents()
    ed.set_cue_key(c0, dlg.key)
    ed.set_cue_key(c1, "p")
    app.processEvents()
    check("touche changée (une seule case par touche)", page.cues[0].key == "" and page.cues[1].key == "P"
          and tiles[1].key == "P" and tiles[0].key == "")
    key(grid, K.Key_P)
    check("la nouvelle touche lance le cue", ed.cue_state(c1) == "playing")
    ed.set_cue_key(c1, "1")
    check("une touche d'effet rapide n'est jamais donnée à un cue", page.cues[1].key == "P")
    ed.stop_all_cues()

    # ── Pages ───────────────────────────────────────────────────────────
    bar = ws.pages
    click(bar.btn_add)
    check("« + » : nouvelle page affichée (vide)", len(ed.doc.live.pages) == 2 and ed.live_page() is not page
          and all(t.empty for t in tiles))
    tabs = bar.tabs
    r = tabs.tab_rects()[1]
    QTest.mouseDClick(tabs, L, NoMod, r.center().toPoint())
    app.processEvents()
    edit = tabs._edit
    ok = edit is not None and app.focusWidget() is edit
    ed.set_live_page(page.id)
    edit.setFocus()
    key(edit, K.Key_P)          # on tape dans le champ : aucun cue ne part
    check("double-clic : renommer sur place ; taper un nom ne lance aucun cue",
          ok and ed.cue_state(c1) is None and "p" in edit.text().lower(),
          f"champ {edit is not None}, focus {type(app.focusWidget()).__name__}, {edit.text() if edit else ''}")
    ed.set_live_page(ed.doc.live.pages[1].id)
    edit.setText("Refrain")
    QTest.keyClick(edit, K.Key_Return)
    app.processEvents()
    check("page renommée", ed.live_page().name == "Refrain" and tabs._edit is None)
    m = page_menu(tabs, ed, ed.live_page())
    next(a for a in m.actions() if a.text() == "Déplacer vers la gauche").trigger()
    check("menu : déplacer la page", ed.doc.live.pages[0].name == "Refrain")
    click(tabs, tabs.tab_rects()[1].center())
    check("clic sur un onglet : la page s'affiche", ed.live_page() is page and tiles[0].name == "Étoile")
    key(grid, K.Key_P)
    check("les touches visent la page affichée", ed.cue_state(c1) == "playing")
    m = page_menu(tabs, ed, ed.doc.live.pages[0])
    next(a for a in m.actions() if a.text() == "Supprimer la page").trigger()
    check("menu : supprimer la page", len(ed.doc.live.pages) == 1 and ed.live_page() is page)

    # ── Barre des pages : départ, plusieurs cues, tout arrêter ──────────
    seg = bar.launch
    click(seg, seg.segment_rects()[2].center())
    check("Départ : « À la mesure »", ed.doc.live.launch == 2)
    click(seg, seg.segment_rects()[0].center())
    click(bar.multi)
    check("« Plusieurs cues » : interrupteur", ed.doc.live.multi is True)
    ed.trigger_cue(c1)
    click(bar.btn_stop)
    check("« Tout arrêter »", not ed.playing_cues())

    # ── Tap tempo ───────────────────────────────────────────────────────
    tap = TapTempo()
    check("Tap : tempo à partir de 3 tapes", tap.tap(10.0) is None and tap.tap(10.5) is None
          and abs(tap.tap(11.0) - 120.0) < 1e-6 and tap.tap(20.0) is None)
    t0 = time.perf_counter()
    for i in range(4):
        ws.output.tap(t0 + i * 0.6)
    check("Tap : le tempo du projet change, la grille des départs part de la dernière tape",
          ed.doc.timeline.bpm == 100.0 and abs(ed.runtime.origin - (t0 + 1.8)) < 1e-9 and "100 BPM" in ws.output.bpm.text(),
          ws.output.bpm.text())
    ed.undo()
    check("Tap : une seule étape d'annulation", ed.doc.timeline.bpm == 120.0)

    # ── Annuler pendant qu'un cue joue, quitter l'espace ────────────────
    ed.set_cue(page.id, 20, circ.id)
    c20 = ed.live_page().cues[20].id
    ed.trigger_cue(c20)
    ed.undo()                       # la case 20 redevient vide alors que son cue joue
    app.processEvents()
    check("annuler la pose d'un cue en cours : il s'arrête", ed.cue_state(c20) is None and tiles[20].empty
          and not ed.runtime.cues.get(c20))
    page = ed.live_page()
    key(grid, K.Key_7, release=False)
    ed.set_workspace("forme")
    app.processEvents()
    check("quitter Live : horloge arrêtée, clavier rendu, effets tenus lâchés",
          not ws.timer.isActive() and not ws.keys.installed and not ed.runtime.held and not ws.status.isVisible())
    check("raccourcis d'outils actifs dans Forme", all(a.isEnabled() for k, a in win.actions_.items() if k.startswith("tool_")))
    QTest.keyClick(win.canvas.view, K.Key_B)
    check("… la touche B prend le Crayon", ed.tool == "pencil", ed.tool)
    ed.set_tool("select")
    ed.set_workspace("show")
    check("raccourcis d'outils inactifs dans Show", not win.actions_["tool_pencil"].isEnabled())
    ed.set_workspace("live")
    app.processEvents()
    check("retour dans Live : la page et ses cues", ws.keys.installed and tiles[1].name in ("Carré", "Étoile"))

    # Thèmes : l'espace se peint dans tous les thèmes (fond, cue en cours en couleur accent)
    ed.trigger_cue(page.cues[1].id)
    ws.tick()
    t = tiles[1]
    gap = grid.mapTo(ws, QPoint(3, 3))
    strip = t.mapTo(ws, QPoint(t.width() - 8, t.height() - 9))
    bad = []
    for tid in theme.THEMES:
        theme.set_theme(tid, app)
        img = ws.grab().toImage()
        if img.pixelColor(gap).name() != theme.BG_APP or img.pixelColor(strip).name() != theme.ACCENT:
            bad.append(tid)
    theme.set_theme(theme.DEFAULT_THEME, app)
    check("l'espace Live se peint dans les 10 thèmes (fond, cue en cours en accent)", not bad and t.playing, str(bad))

    win.live.shutdown()
    print()
    if errors:
        print(f"{len(errors)} PROBLÈME(S) :")
        for e in errors:
            print("  -", e)
        sys.exit(1)
    print("TOUT EST OK")


if __name__ == "__main__":
    main()
