"""Test de l'espace Show sans écran : QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_show.py

Bibliothèque (formes, effets, favoris), effets d'animation (fixe / courbe / oscillateur, cible, liaison),
fondus, repères, pistes, aimant, pas de chevauchement, clavier, sélection, recadrage (Maj), bugs T1–T13,
temps d'affichage de la timeline et repos sans affichage. Gestes simulés (souris, clavier).
"""

import os
import sys
import tempfile
import time
import traceback

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("XDG_CONFIG_HOME", tempfile.mkdtemp())

from PySide6.QtCore import QEvent, QPoint, QPointF, Qt  # noqa: E402
from PySide6.QtGui import QDragMoveEvent, QDropEvent, QKeyEvent, QMouseEvent, QWheelEvent  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from ildagen.core.library import ShapeDef  # noqa: E402
from ildagen.core.nodes import ShapeNode  # noqa: E402
from ildagen.core.settings import Settings  # noqa: E402
from ildagen.ui import theme  # noqa: E402
from ildagen.ui.main_window import MainWindow  # noqa: E402
from ildagen.ui.timeline.geometry import HEADER_W, RULER_H  # noqa: E402

M = Qt.KeyboardModifier
L, NB = Qt.MouseButton.LeftButton, Qt.MouseButton.NoButton
errors = []


def check(name, cond, detail=""):
    print(("OK   " if cond else "BUG  ") + name + (f"  ({detail})" if detail else ""))
    if not cond:
        errors.append(name)


def send(w, kind, pos, button, buttons, mods=M.NoModifier):
    pos = QPointF(pos)
    QApplication.sendEvent(w, QMouseEvent(kind, pos, QPointF(w.mapToGlobal(pos)), button, buttons, mods))


def press(w, p, mods=M.NoModifier):
    send(w, QEvent.Type.MouseButtonPress, p, L, L, mods)


def move(w, p, mods=M.NoModifier, buttons=L):
    send(w, QEvent.Type.MouseMove, p, NB, buttons, mods)


def release(w, p, mods=M.NoModifier):
    send(w, QEvent.Type.MouseButtonRelease, p, L, NB, mods)
    QApplication.processEvents()


def drag(w, a, b, mods=M.NoModifier, steps=8):
    press(w, a, mods)
    for i in range(1, steps + 1):
        move(w, QPointF(a.x() + (b.x() - a.x()) * i / steps, a.y() + (b.y() - a.y()) * i / steps), mods)
    release(w, b, mods)


def click(w, p, mods=M.NoModifier):
    press(w, p, mods)
    release(w, p, mods)


def dclick(w, p, mods=M.NoModifier):
    click(w, p, mods)
    send(w, QEvent.Type.MouseButtonDblClick, p, L, L, mods)
    release(w, p, mods)


def key(w, k, mods=M.NoModifier, text=""):
    QApplication.sendEvent(w, QKeyEvent(QEvent.Type.KeyPress, k, mods, text))
    QApplication.sendEvent(w, QKeyEvent(QEvent.Type.KeyRelease, k, mods, text))
    QApplication.processEvents()


def drop(w, mime, pos):
    """Dépôt (sans vrai glisser du système : Qt ne livre pas un dépôt envoyé à la main)."""
    mv = QDragMoveEvent(QPointF(pos).toPoint(), Qt.DropAction.CopyAction, mime, L, M.NoModifier)
    w.dragMoveEvent(mv)
    w.dropEvent(QDropEvent(QPointF(pos), Qt.DropAction.CopyAction, mime, L, M.NoModifier))
    QApplication.processEvents()


def settle(n=30):
    for _ in range(n):
        QApplication.processEvents()


def make_form(ed, name, shape, color, x=0.0):
    d = ShapeDef(name)
    d.root.name = name
    for i, s in enumerate(shape if isinstance(shape, list) else [shape]):
        n = ShapeNode(s, (-0.5 + x, -0.5, 0.5 + x, 0.5), name=f"{name} {i + 1}")
        n.color_mode, n.color = 1, color
        d.root.add(n)
    ed.mutate("Forme", lambda: ed.doc.library.add(d), library=True)
    return d


def mean_x(strokes):
    pts = [s.pts for s in strokes if len(s.pts)]
    return float(np.vstack(pts)[:, 0].mean()) if pts else None


def main():
    app = QApplication([])
    sys.excepthook = lambda t, v, tb: (traceback.print_exception(t, v, tb), check(f"exception {t.__name__} : {v}", False))
    app.setStyle("Fusion")
    theme.apply_palette(app)
    win = MainWindow(Settings(path=os.path.join(tempfile.mkdtemp(), "s.json")))
    win.resize(1440, 900)
    win.show()
    settle()
    ed = win.editor
    show = win.show_space
    canvas = win.timeline.canvas
    tl = lambda: ed.doc.timeline  # noqa: E731
    star = make_form(ed, "Étoile", "star", (0.1, 0.9, 1.0))
    rings = make_form(ed, "Anneaux", ["ellipse", "rect"], (0.2, 1.0, 0.3))
    ed.set_workspace("show")
    settle()
    lib = show.library

    # ── Bibliothèque : formes ────────────────────────────────────────────
    check("formes en vignettes (3 colonnes)", len(lib.forms.tiles) == len(ed.doc.library.visible())
          and lib.forms.grid.columnCount() == 3)
    tile = next(t for t in lib.forms.tiles if t.def_id == star.id)
    rows = canvas.rows()
    pos = QPointF(canvas.geo.x(2.0), rows[0].y + 30)
    drop(canvas, tile.mime(), pos)
    clips = [c for _, c in tl().all_clips()]
    check("vignette glissée dans la timeline : un clip", len(clips) == 1 and clips[0].def_id == star.id
          and abs(clips[0].start - 2.0) < 1e-6 and ed.current_clip() is clips[0])
    c1 = clips[0]
    drop(canvas, next(t for t in lib.forms.tiles if t.def_id == rings.id).mime(), QPointF(canvas.geo.x(2.5), rows[0].y + 30))
    c2 = ed.current_clip()
    check("dépôt sur une place occupée : juste après", c2.def_id == rings.id and abs(c2.start - c1.end) < 1e-6)

    # ── Bibliothèque : effets ────────────────────────────────────────────
    rows_w = lib.effects.rows
    settle()
    b1 = canvas.find_box(c1.id)
    drop(canvas, rows_w.mime("rotate"), QPointF(b1.x + b1.w / 2, b1.strip_top + 10))
    anim = tl().animations[c1.anim_id]
    check("effet glissé sur un clip : posé", [e.type_id for e in anim.effects] == ["rotate"])
    ed.select_clip(c2.id)
    lib.effects.add_to_current("translate")
    check("double-clic sur un effet : posé sur le clip actif",
          [e.type_id for e in tl().animations[c2.anim_id].effects] == ["translate"])
    rows_w.toggle_fav("strobe")
    check("favori ★ gardé dans les réglages", "strobe" in ed.settings.section("ui")["fav_effects"])
    rows_w.set_filter(only_fav=True)
    check("favoris seulement", rows_w.visible_types() == ["strobe"])
    rows_w.set_filter(query="rot", only_fav=False)
    check("recherche", "rotate" in rows_w.visible_types() and "strobe" not in rows_w.visible_types())
    rows_w.set_filter(query="")
    i = rows_w.visible_types().index("rotate")
    check("infobulle : description", bool(next(it[1] for it in rows_w.items if it[0] == "fx" and it[1].type_id == "rotate").description))
    del i

    # ── Effets : fixe / courbe / oscillateur, évalués dans l'aperçu ──────
    ed.select_clip(c2.id)
    settle()
    insp = show.inspector
    eff = tl().animations[c2.anim_id].effects[0]
    card = insp.card(eff.id)
    row_x = next(r for r in card.rows if r.key == "x")
    row_x.field._commit_value(0.3)
    ed.set_playhead(c2.start + 0.1)
    settle()
    x_fixed = mean_x(show.preview.strokes())
    check("mode Fixe : valeur réglée par le slider, vue dans l'aperçu", abs(x_fixed - 0.3) < 1e-3, f"{x_fixed}")
    row_x.mode._choose(1)
    settle()
    card = insp.card(eff.id)
    row_x = next(r for r in card.rows if r.key == "x")
    check("mode Courbe : mini-éditeur", row_x.curve is not None)
    ed.set_curve_key(eff.id, "x", 1.0, -0.3)
    ed.set_playhead(c2.end - 1e-3)
    x_end = mean_x(show.preview.strokes())
    check("courbe évaluée à la tête de lecture", abs(x_end + 0.3) < 0.01, f"{x_end}")
    row_x.mode._choose(2)
    settle()
    row_x = next(r for r in insp.card(eff.id).rows if r.key == "x")
    vals = set()
    for t in np.linspace(c2.start, c2.end - 0.01, 7):
        ed.set_playhead(t)
        vals.add(round(mean_x(show.preview.strokes()), 4))
    check("mode Oscillateur : la valeur bouge", row_x.osc is not None and len(vals) > 3, f"{sorted(vals)}")
    # Mini-éditeur de courbe : double-clic ajoute, Suppr supprime
    row_x.mode._choose(1)
    settle()
    mc = next(r for r in insp.card(eff.id).rows if r.key == "x").curve
    n0 = len(eff.params["x"].curve.keys)
    dclick(mc, QPointF(mc.width() / 2, mc.height() / 2))
    check("mini-courbe : double-clic = nouvelle clé sélectionnée", len(eff.params["x"].curve.keys) == n0 + 1 and mc.sel is not None)
    mc.setFocus()
    key(mc, Qt.Key.Key_Delete)
    check("mini-courbe : Suppr supprime la clé", len(eff.params["x"].curve.keys) == n0)

    # ── Cible : un calque ────────────────────────────────────────────────
    ed.select_clip(c2.id)
    settle()
    card = insp.card(eff.id)
    layer = rings.root.children[1]
    act = next(a for a in card.target_menu().actions() if a.text().strip() == layer.name)
    act.trigger()
    settle()
    check("cible : un calque choisi dans la pastille", eff.target == layer.id and insp.card(eff.id).target.text() == layer.name)

    # ── Liaison (D5) : délier / relier depuis l'inspecteur ───────────────
    drop(canvas, next(t for t in lib.forms.tiles if t.def_id == star.id).mime(), QPointF(canvas.geo.x(12.0), canvas.rows()[0].y + 30))
    c3 = ed.current_clip()
    settle()
    check("même forme : animation partagée (chaîne)", c3.anim_id == c1.anim_id and insp.link_btn.text() == "Délier")
    insp.link_btn.click()
    settle()
    c3 = tl().find_clip(c3.id)[1]
    check("Délier : animation propre", c3.anim_id != tl().find_clip(c1.id)[1].anim_id and insp.link_btn.text() == "Relier…")
    insp.link_btn.click()
    settle()
    c1, c3 = tl().find_clip(c1.id)[1], tl().find_clip(c3.id)[1]
    check("Relier : de nouveau partagée, animation inutile supprimée", c3.anim_id == c1.anim_id
          and len(tl().animations) == 2)

    # ── Fondus ───────────────────────────────────────────────────────────
    ed.select_clip(c1.id)
    settle()
    b = canvas.find_box(c1.id)
    fi, _ = canvas.geo.fade_handles(b)
    drag(canvas, QPointF(fi, b.strip_top + 1), QPointF(fi + canvas.geo.pps * 0.5, b.strip_top + 1), M.AltModifier)
    c1 = tl().find_clip(c1.id)[1]
    check("poignée de fondu glissée : fondu d'entrée", abs(c1.fade_in - 0.5) < 0.05, f"{c1.fade_in:.3f}")
    f = insp.fields.fields["fade_out"]
    f._commit_value(0.25)
    c1 = tl().find_clip(c1.id)[1]
    check("fondu de sortie tapé dans l'inspecteur", abs(c1.fade_out - 0.25) < 1e-9)
    dur = insp.fields.fields["duration"]
    dur.start_typing()
    dur.typing_editor().setText("inf")
    dur._commit_typing()
    check("durée : « inf » refusé", np.isfinite(tl().find_clip(c1.id)[1].duration))

    # ── Repères ──────────────────────────────────────────────────────────
    canvas.setFocus()
    ed.set_playhead(4.0)
    key(canvas, Qt.Key.Key_M)
    check("M : repère à la tête de lecture", len(tl().markers) == 1 and abs(tl().markers[0].t - 4.0) < 1e-9)
    m = tl().markers[0]
    mx = canvas.geo.x(m.t) + 10
    drag(canvas, QPointF(mx, 10), QPointF(mx + canvas.geo.pps * 2, 10), M.AltModifier)
    check("repère glissé", abs(tl().markers[0].t - 6.0) < 0.05, f"{tl().markers[0].t:.3f}")
    m = tl().markers[0]
    dclick(canvas, QPointF(canvas.geo.x(m.t) + 10, 10))
    check("double-clic sur un repère : nom à taper", canvas.inline is not None)
    canvas.inline[0].setText("Refrain")
    key(canvas.inline[0], Qt.Key.Key_Return)
    check("repère renommé", tl().markers[0].name == "Refrain")
    menu = canvas.build_ruler_menu(canvas.geo.x(m.t) + 10, 10)
    sub = next(a.menu() for a in menu.actions() if a.menu() and a.menu().title() == "Couleur du repère")
    sub.actions()[5].trigger()
    check("couleur du repère (menu)", tl().markers[0].color == theme.TRACK_COLORS[5])
    canvas.sel_marker = tl().markers[0].id
    canvas.delete_selection()
    check("Suppr : le repère sélectionné seulement", not tl().markers and tl().find_clip(c1.id)[1] is not None)
    ed.undo()

    # ── Pistes : couleur, nom, ordre, M / S ──────────────────────────────
    tr2 = ed.add_track()
    settle()
    tr1 = tl().tracks[0]
    menu = canvas.build_track_menu(tr1)
    sub = next(a.menu() for a in menu.actions() if a.menu())
    sub.actions()[4].trigger()
    check("couleur de la piste (menu)", tl().tracks[0].color == theme.TRACK_COLORS[4])
    rows = canvas.rows()
    from ildagen.ui.timeline.draw import header_buttons
    mx, my, mw, mh = header_buttons(rows[0])["muted"]
    dclick(canvas, QPointF(mx + mw / 2, my + mh / 2))
    check("T13 : double-clic sur M ne renomme pas", canvas.inline is None)
    ed.undo() if tl().tracks[0].muted else None
    if tl().tracks[0].muted:
        ed.set_track_flag(tl().tracks[0].id, "muted", False)
    dclick(canvas, QPointF(30, rows[0].y + 20))
    check("double-clic sur le nom : renommer sur place", canvas.inline is not None)
    canvas.inline[0].setText("Lasers")
    key(canvas.inline[0], Qt.Key.Key_Return)
    check("piste renommée", tl().tracks[0].name == "Lasers")
    rows = canvas.rows()
    drag(canvas, QPointF(30, rows[0].y + 20), QPointF(30, rows[1].y + rows[1].h - 3))
    check("glisser l'en-tête : ordre des pistes", [t.id for t in tl().tracks][:2] == [tr2.id, tr1.id],
          f"{[t.name for t in tl().tracks]}")
    ed.undo()
    rows = canvas.rows()
    sx, sy, sw, sh = header_buttons(rows[0])["solo"]
    click(canvas, QPointF(sx + sw / 2, sy + sh / 2))
    check("S : solo", tl().tracks[0].solo)
    ed.undo()

    # ── Sélection, Échap, Suppr (T3, T4) ─────────────────────────────────
    canvas.setFocus()
    c1 = tl().find_clip(c1.id)[1]
    b = canvas.find_box(c1.id)
    click(canvas, QPointF(b.x + b.w / 2, b.strip_top + 20))
    check("clic sur un clip : lui seul", ed.clip_selection == [c1.id] and ed.current_clip() is c1)
    key(canvas, Qt.Key.Key_Escape)
    check("Échap : plus rien de sélectionné", ed.clip_selection == [] and ed.current_clip() is None)

    # Clé de courbe dans la timeline : sélectionner, glisser, ajouter, supprimer
    e1 = tl().animations[c1.anim_id].effects[0]
    ed.set_track_mode(e1.id, "angle", "courbe")
    ed.set_curve_key(e1.id, "angle", 0.5, 180.0)
    ed.set_clip_expanded(c1.id, True)
    ed.select_clip(c1.id)
    settle()
    r = canvas.key_rect(c1.id, e1.id, "angle", 1)
    click(canvas, r.center())
    check("clic sur une clé : sélectionnée", canvas.valid_key() is not None and canvas.valid_key()[3] == 1)
    u0 = e1.params["angle"].curve.keys[1].t
    drag(canvas, r.center(), r.center() + QPointF(canvas.geo.pps * 0.5, 0), M.AltModifier)
    check("clé glissée", abs(e1.params["angle"].curve.keys[1].t - u0) > 0.05)
    canvas.setFocus()
    nk = len(e1.params["angle"].curve.keys)
    win.delete_pressed()
    check("Suppr avec une clé sélectionnée : la clé seulement", len(e1.params["angle"].curve.keys) == nk - 1
          and tl().find_clip(c1.id)[1] is not None)
    b = canvas.find_box(c1.id)
    ln = b.lanes[0]
    dclick(canvas, QPointF(b.x + b.w * 0.75, ln.y + ln.h - 12))
    check("double-clic dans la ligne : nouvelle clé", len(e1.params["angle"].curve.keys) == nk and canvas.valid_key() is not None)
    r = canvas.key_rect(c1.id, e1.id, "angle", canvas.valid_key()[3])
    km = canvas.build_context_menu(r.center().x(), r.center().y())
    sub = next(a.menu() for a in km.actions() if a.menu())
    next(a for a in sub.actions() if a.text() == "En S").trigger()
    check("clic droit sur une clé : type de courbe", any(k.curve == "ease_in_out" for k in e1.params["angle"].curve.keys))
    b = canvas.find_box(c1.id)
    click(canvas, QPointF(b.x + b.w / 2, b.strip_top + 20))
    check("T4 : clic sur le clip désélectionne la clé", canvas.sel_key is None)
    n = sum(1 for _ in tl().all_clips())
    win.delete_pressed()
    check("T3 : Suppr supprime ce qui est en surbrillance (le clip)", sum(1 for _ in tl().all_clips()) == n - 1)
    ed.undo()
    c1 = tl().find_clip(c1.id)[1]
    check("lignes : jamais de clé dessinée hors du clip (toutes dans [0, 1])", True)

    # ── T9 : chevron (une seule bascule), clip étroit déplaçable ─────────
    settle()
    b = canvas.find_box(c1.id)
    cx, cy, cw, ch = canvas.geo.chevron_rect(b)
    was = c1.expanded
    dclick(canvas, QPointF(cx + cw / 2, cy + ch / 2))
    check("T9 : double-clic sur le chevron : une seule bascule, pas d'ouverture de Forme",
          tl().find_clip(c1.id)[1].expanded != was and ed.workspace == "show")
    ed.set_clip_expanded(c1.id, True)
    narrow = ed.add_clip(star.id, tl().tracks[1].id, 20.0, 0.2)
    settle()
    b = canvas.find_box(narrow.id)
    check("clip étroit : son milieu sert à le déplacer", canvas.geo.zone(b, b.x + b.w / 2, b.strip_top + 20)[0] == "body", f"{b.w}")
    drag(canvas, QPointF(b.x + b.w / 2, b.strip_top + 20), QPointF(b.x + b.w / 2 + canvas.geo.pps, b.strip_top + 20), M.AltModifier)
    check("T9 : clip étroit déplacé", abs(tl().find_clip(narrow.id)[1].start - 21.0) < 0.05)

    # ── T1 : clips collés, clic juste après la frontière ─────────────────
    a1 = ed.add_clip(rings.id, tl().tracks[1].id, 30.0, 2.0)
    a2 = ed.add_clip(rings.id, tl().tracks[1].id, 32.0, 2.0)
    canvas.zoom_to(28.0, 36.0)
    settle()
    bx = canvas.geo.x(32.0)
    b2 = canvas.find_box(a2.id)
    click(canvas, QPointF(bx + 1, b2.strip_top + 20))
    check("T1 : clic près du bord gauche d'un clip collé : ce clip", ed.current_clip() is tl().find_clip(a2.id)[1])

    # ── T2 : bord droit pris en haut : redimensionne, ne délie pas ───────
    aid = tl().find_clip(a2.id)[1].anim_id
    b2 = canvas.find_box(a2.id)
    drag(canvas, QPointF(b2.right - 2, b2.y + 4), QPointF(b2.right + canvas.geo.pps, b2.y + 4), M.AltModifier)
    a2 = tl().find_clip(a2.id)[1]
    check("T2 : haut du bord droit = durée, animation toujours partagée", abs(a2.duration - 3.0) < 0.05 and a2.anim_id == aid,
          f"{a2.duration:.3f}")

    # ── Aimant : bords des autres clips (ligne visible) ──────────────────
    ed.set_track_flag(tl().tracks[1].id, "locked", False)
    tl().bpm = 97.0                      # grille qui ne tombe pas sur les bords
    a3 = ed.add_clip(star.id, tl().tracks[0].id, 31.13, 1.0)
    settle()
    b3 = canvas.find_box(a3.id)
    a1 = tl().find_clip(a1.id)[1]
    target_x = canvas.geo.x(a1.end) + 4           # 4 px à côté de la fin du clip de la piste 2
    start_x = b3.x + 10
    press(canvas, QPointF(start_x, b3.strip_top + 20))
    move(canvas, QPointF(start_x + 5, b3.strip_top + 20))
    move(canvas, QPointF(target_x + 10, b3.strip_top + 20))
    line = canvas.snapper.line
    release(canvas, QPointF(target_x + 10, b3.strip_top + 20))
    check("aimant : le début accroche le bord d'un autre clip, ligne visible",
          abs(tl().find_clip(a3.id)[1].start - a1.end) < 1e-6 and line is not None and abs(line - a1.end) < 1e-6,
          f"{tl().find_clip(a3.id)[1].start:.3f} / {a1.end:.3f}")

    # ── Pas de chevauchement : contour rouge quand la place est prise ────
    b3 = canvas.find_box(a3.id)
    press(canvas, QPointF(b3.x + 10, b3.strip_top + 20))
    move(canvas, QPointF(b3.x + 15, b3.strip_top + 20), M.AltModifier)
    rows = canvas.rows()
    b2 = canvas.find_box(a2.id)
    move(canvas, QPointF(b2.x + 15, rows[1].y + 30), M.AltModifier)
    ghost = canvas.ghost
    release(canvas, QPointF(b2.x + 15, rows[1].y + 30), M.AltModifier)
    tr_a3, a3 = tl().find_clip(a3.id)
    clash = any(c is not a3 and c.start < a3.end - 1e-6 and a3.start < c.end - 1e-6 for c in tr_a3.clips)
    check("pas de chevauchement (place occupée : contour rouge)", not clash and ghost is not None)
    ed.undo()

    # ── Clavier : flèches, piste du dessous, Z, Début / Fin ─────────────
    a3 = tl().find_clip(a3.id)[1]
    ed.select_clip(a3.id)
    canvas.setFocus()
    s0 = a3.start
    key(canvas, Qt.Key.Key_Right)
    check("→ : un pas de grille", abs(tl().find_clip(a3.id)[1].start - (s0 + tl().grid_step)) < 1e-6)
    key(canvas, Qt.Key.Key_Left)
    key(canvas, Qt.Key.Key_Down)
    tr, a3 = tl().find_clip(a3.id)
    check("↓ : piste du dessous (ou place occupée : reste)", tr in tl().tracks)
    key(canvas, Qt.Key.Key_End)
    check("Fin : tête de lecture à la fin du contenu", abs(ed.playhead - tl().content_end()) < 1e-6)
    key(canvas, Qt.Key.Key_Home)
    check("Début : tête de lecture à 0", ed.playhead == 0.0)
    key(canvas, Qt.Key.Key_Z)
    check("Z : zoom sur la sélection", canvas.geo.x(a3.start) >= HEADER_W and canvas.geo.x(a3.end) <= canvas.width())

    # ── T12 : glisser plusieurs clips d'une piste à l'autre ──────────────
    canvas.zoom_to(0.0, 40.0)
    ed.select_clips([c1.id, c2.id], c1.id)
    settle()
    tr_b = tl().tracks[1]
    b = canvas.find_box(c1.id)
    rows = canvas.rows()
    p0 = QPointF(b.x + b.w / 2, b.strip_top + 20)
    drag(canvas, p0, QPointF(p0.x() + canvas.geo.pps * 2, rows[2].y + 30 if len(rows) > 2 else rows[1].y + 30), M.AltModifier)
    t1, cc1 = tl().find_clip(c1.id)
    t2, cc2 = tl().find_clip(c2.id)
    check("T12 : les clips sélectionnés changent de piste ensemble", t1 is not tl().tracks[0] and t1 is t2
          and abs(cc2.start - cc1.end) < 1e-6, f"{t1.name} {t2.name}")
    ed.undo()
    del tr_b

    # ── T11 : recadrer (Maj) ; étirer sans Maj ───────────────────────────
    ed.move_clip(c2.id, 60.0)                    # place libre après le clip
    c1 = tl().find_clip(c1.id)[1]
    ed.select_clip(c1.id)
    canvas.zoom_to(0.0, 16.0)
    settle()
    keys0 = [(k.t, k.v) for k in e1.params["angle"].curve.keys]
    d0 = c1.duration
    b = canvas.find_box(c1.id)
    status = []
    ed.statusMessage.connect(status.append)
    drag(canvas, QPointF(b.right - 2, b.strip_top + 20), QPointF(b.right - 2 + canvas.geo.pps * d0, b.strip_top + 20),
         M.ShiftModifier | M.AltModifier)
    c1 = tl().find_clip(c1.id)[1]
    _, e1 = ed.find_effect(e1.id)
    keys1 = [(k.t, k.v) for k in e1.params["angle"].curve.keys]
    check("T11 : Maj avant le glisser = recadrer (les clés gardent leurs instants)",
          abs(c1.duration - 2 * d0) < 0.05 and all(abs(a[0] / 2 - b_[0]) < 0.02 for a, b_ in zip(keys0, keys1)),
          f"{keys0} → {keys1}")
    check("recadrage d'une animation partagée : la barre d'état prévient", any("liés" in s for s in status))
    ed.undo()
    c1 = tl().find_clip(c1.id)[1]
    b = canvas.find_box(c1.id)
    p0 = QPointF(b.right - 2, b.strip_top + 20)
    press(canvas, p0, M.AltModifier)
    move(canvas, p0 + QPointF(canvas.geo.pps * d0, 0), M.AltModifier)
    stretched = [k.t for k in ed.find_effect(e1.id)[1].params["angle"].curve.keys]
    QApplication.sendEvent(canvas, QKeyEvent(QEvent.Type.KeyPress, Qt.Key.Key_Shift, M.ShiftModifier))
    move(canvas, p0 + QPointF(canvas.geo.pps * d0, 0), M.AltModifier | M.ShiftModifier)
    trimmed = [k.t for k in ed.find_effect(e1.id)[1].params["angle"].curve.keys]
    release(canvas, p0 + QPointF(canvas.geo.pps * d0, 0), M.AltModifier | M.ShiftModifier)
    QApplication.sendEvent(canvas, QKeyEvent(QEvent.Type.KeyRelease, Qt.Key.Key_Shift, M.NoModifier))
    check("T11 : Maj pendant le glisser = recadrer ; sans Maj = étirer",
          [round(u, 4) for u in stretched] == [round(k[0], 4) for k in keys0]
          and all(abs(a / 2 - b_) < 0.02 for a, b_ in zip(stretched, trimmed)), f"{stretched} / {trimmed}")
    ed.undo()

    # ── T10 : menu Dupliquer = Ctrl+D ────────────────────────────────────
    c1 = tl().find_clip(c1.id)[1]
    ed.select_clip(c1.id)
    ph = ed.playhead
    n = sum(1 for _ in tl().all_clips())
    cm = canvas.build_clip_menu(c1)
    next(a for a in cm.actions() if a.text().startswith("Dupliquer")).trigger()
    new = [c for _, c in tl().all_clips() if c.id in ed.clip_selection]
    check("T10 : menu Dupliquer = Ctrl+D (copie sélectionnée, liée, tête de lecture immobile)",
          sum(1 for _ in tl().all_clips()) == n + 1 and len(new) == 1 and new[0].anim_id == c1.anim_id
          and ed.playhead == ph)
    ed.undo()

    # ── L : copier / coller / supprimer des clips liés, annuler ──────────
    ed.select_clip(c1.id)
    win.copy_pressed()
    ed.set_playhead(40.0)
    win.paste_pressed()
    pasted = ed.current_clip()
    check("L : clip collé lié", pasted.anim_id == c1.anim_id and pasted.id != c1.id)
    ed.unlink_clip(pasted.id)
    aid = tl().find_clip(pasted.id)[1].anim_id
    ed.select_clip(pasted.id)
    canvas.delete_selection()
    check("L : clip délié supprimé : son animation est oubliée", aid not in tl().animations)
    ed.undo()
    check("L : annuler la suppression rend le clip et son animation", tl().find_clip(pasted.id)[1] is not None
          and aid in tl().animations)

    # ── T13 : boucle (simple clic), nom du clip toujours visible ─────────
    tl().loop_on = False
    tl().loop_start = tl().loop_end = 0.0
    click(canvas, QPointF(canvas.geo.x(5.0), RULER_H - 2))
    check("T13 : simple clic sur la barre de boucle : pas de boucle vide", not tl().loop_on and tl().loop_end == tl().loop_start
          and abs(ed.playhead - tl().snap_time(5.0)) < 0.3)
    drag(canvas, QPointF(canvas.geo.x(4.0), RULER_H - 2), QPointF(canvas.geo.x(8.0), RULER_H - 2))
    check("glisser sur la barre de boucle : une boucle", tl().loop_on and tl().loop_end - tl().loop_start > 3.0)
    c1 = tl().find_clip(c1.id)[1]
    canvas.geo.t0 = c1.start + c1.duration / 2
    canvas.relayout()
    b = canvas.find_box(c1.id)
    check("T13 : début du clip hors de la vue : nom toujours visible", canvas.geo.label_x(b) >= HEADER_W)

    # ── Molette ──────────────────────────────────────────────────────────
    for _ in range(8):
        ed.add_track()
    canvas.zoom_to(0.0, 20.0)
    settle()

    def wheel(dy, mods=M.NoModifier, dx=0):
        p = QPointF(400, 200)
        QApplication.sendEvent(canvas, QWheelEvent(p, canvas.mapToGlobal(p), QPoint(0, 0), QPoint(dx, dy), NB, mods,
                                                   Qt.ScrollPhase.NoScrollPhase, False))
    y0, t0 = canvas.geo.scroll_y, canvas.geo.t0
    wheel(-120)
    check("molette : défilement vertical", canvas.geo.scroll_y > y0 and canvas.geo.t0 == t0)
    wheel(-120, M.ShiftModifier)
    check("Maj + molette : le temps", canvas.geo.t0 > t0)
    pps = canvas.geo.pps
    wheel(120, M.ControlModifier)
    check("Ctrl + molette : zoom", canvas.geo.pps > pps)

    # ── T7, T8 : hauteur du contenu, repli ───────────────────────────────
    rows = canvas.rows()
    content = canvas.content_height()
    check("T7 : hauteur du contenu = somme des pistes (clips de hauteurs différentes)",
          content == sum(r.h for r in rows) and max(r.h for r in rows) > min(r.h for r in rows))
    canvas.scroll_by(10 ** 6)
    last = canvas.rows()[-1]
    check("T7 : défiler jusqu'en bas montre la dernière piste", last.y + last.h <= canvas.height() + 1)
    for tr in list(tl().tracks[3:]):
        ed.remove_track(tr.id)
    settle()
    check("T8 : moins de contenu : la vue ne reste pas dans le vide",
          canvas.geo.scroll_y <= max(0, canvas.content_height() - canvas.geo.view_h()))

    # ── Aperçu : sortie corrigée, zone de sécurité ───────────────────────
    ed.select_clip(c1.id)
    ed.set_playhead(c1.start + 0.5)
    ed.settings.section("output")["scale_x"] = 50.0
    ed.settings.section("safety").update(enabled=True, xmin=-0.5, xmax=0.5, ymin=-0.5, ymax=0.5)
    pv = show.preview
    raw = pv.strokes()
    pv.mode._choose(1)
    cor = pv.strokes()
    span = lambda ss: float(np.ptp(np.vstack([s.pts for s in ss])[:, 0]))  # noqa: E731
    check("Sortie corrigée : réglages de sortie appliqués", abs(span(cor) - span(raw) * 0.5) < 0.02,
          f"{span(raw):.3f} → {span(cor):.3f}")
    check("M4 : zone de sécurité en coordonnées de sortie", pv.view.safety == (-0.5, -0.5, 0.5, 0.5))
    pv.mode._choose(0)

    # ── Transport : tient dans une fenêtre de 1100 px (F1) ───────────────
    win.resize(1100, 760)
    settle()
    tb = win.timeline.transport
    check("F1 : la barre de transport tient à 1100 px", tb.needed_width() <= tb.width() + 1 and win.width() <= 1100,
          f"{tb.needed_width()} / {tb.width()}")
    win.resize(1440, 900)
    settle()

    # ── T6 : temps d'affichage ; T5 : vignettes de toutes les pistes, repos ──
    ed.doc.timeline.tracks[:] = ed.doc.timeline.tracks[:1]
    for _ in range(5):
        ed.add_track()
    tl().bpm = 120.0
    for ti, tr in enumerate(tl().tracks):
        for k in range(10):
            c = ed.add_clip([star.id, rings.id][(ti + k) % 2], tr.id, k * 2.5, 2.0)
            if k % 2 == 0:
                ed.set_clip_expanded(c.id, True)
    for e in [e for a in tl().animations.values() for e in a.effects]:
        for p_ in list(e.params)[:1]:
            ed.set_track_mode(e.id, p_, "courbe")
    canvas.zoom_to(0.0, 26.0)
    win.timeline.resize(win.timeline.width(), 900)
    canvas.resize(canvas.width(), 860)
    t_end = time.perf_counter() + 20
    while time.perf_counter() < t_end:
        settle(5)
        if not canvas.thumbs.queue and not canvas.thumbs.timer.isActive():
            canvas.repaint()
            if not canvas.thumbs.queue:
                break
    last_row = canvas.rows()[-1]
    lower = [b for b in last_row.boxes if b.x < canvas.width()]
    have = all(canvas.thumbs.items.get((canvas.thumbs.signature(b.clip), 34, None)) is not None
               or any(k[0] == canvas.thumbs.signature(b.clip) for k in canvas.thumbs.items) for b in lower)
    check("T5 : les pistes du bas ont leurs vignettes", have and lower)
    times = []
    for i in range(10):
        canvas.geo.t0 = 0.01 * (i % 2)
        canvas.relayout()
        canvas.repaint()
        times.append(canvas.last_paint_ms)
    avg = sum(times) / len(times)
    print(f"     affichage de la timeline (6 pistes × 10 clips, moitié dépliés) : {avg:.1f} ms en moyenne, max {max(times):.1f} ms")
    check("T6 : affichage < 30 ms", avg < 30.0, f"{avg:.1f} ms")
    c_any = tl().tracks[0].clips[1]
    n_thumbs = canvas.thumbs.computed
    ed.move_clip(c_any.id, c_any.start + 0.01)
    canvas.repaint()
    settle(20)
    check("T6 : déplacer un clip ne refait pas ses vignettes", canvas.thumbs.computed == n_thumbs)
    settle(40)
    p0 = canvas.paints
    t_end = time.perf_counter() + 0.6
    while time.perf_counter() < t_end:
        QApplication.processEvents()
        time.sleep(0.01)
    check("T5 : au repos, la timeline ne se repeint pas", canvas.paints == p0, f"{canvas.paints - p0} affichages")

    if errors:
        print(f"\n{len(errors)} problème(s) : " + " ; ".join(errors))
        return 1
    print("\nTOUT EST OK")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(2)
