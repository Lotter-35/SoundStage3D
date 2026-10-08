"""Test des thèmes, des briques d'interface (ui/widgets) et de la molette de la mire, sans écran :
QT_QPA_PLATFORM=offscreen python tools/ilda-gen/tests/test_widgets.py [dossier_captures]

Simule la souris et le clavier sur chaque brique et vérifie les signaux. Avec un dossier : captures de la
galerie des briques et de la fenêtre dans plusieurs thèmes.
"""

import colorsys
import os
import re
import sys
import tempfile
import time
import traceback

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("XDG_CONFIG_HOME", tempfile.mkdtemp())

from PySide6.QtCore import QEvent, QPoint, QPointF, QRectF, Qt  # noqa: E402
from PySide6.QtGui import (QColor, QIcon, QImage, QInputDevice, QKeyEvent, QMouseEvent,  # noqa: E402
                           QNativeGestureEvent, QPainter, QPointingDevice, QWheelEvent)
from PySide6.QtTest import QTest  # noqa: E402
from PySide6.QtWidgets import QApplication, QGridLayout, QHBoxLayout, QVBoxLayout, QWidget  # noqa: E402

from ildagen.core import settings as S  # noqa: E402
from ildagen.core.path import Stroke  # noqa: E402
from ildagen.ui import icons, theme  # noqa: E402
from ildagen.ui.canvas.viewport import wheel_action  # noqa: E402
from ildagen.ui.widgets import (Card, ColorChips, LaserScene, LaserView, Segmented, SliderField, Switch,  # noqa: E402
                                Tile, TopBarButton, fmt_number, parse_number)

SHOTS = sys.argv[1] if len(sys.argv) > 1 else None
M = Qt.KeyboardModifier
L, R, N = Qt.MouseButton.LeftButton, Qt.MouseButton.RightButton, Qt.MouseButton.NoButton
errors = []


def check(name, cond, detail=""):
    print(("OK   " if cond else "BUG  ") + name + (f"  ({detail})" if detail else ""))
    if not cond:
        errors.append(name)


def mouse(w, kind, pos, button, buttons, mods=M.NoModifier):
    pos = QPointF(pos)
    QApplication.sendEvent(w, QMouseEvent(kind, pos, QPointF(w.mapToGlobal(pos)), button, buttons, mods))


def drag(w, a, b, mods=M.NoModifier, steps=8, release=True):
    mouse(w, QEvent.Type.MouseButtonPress, a, L, L, mods)
    for i in range(1, steps + 1):
        mouse(w, QEvent.Type.MouseMove, QPointF(a.x() + (b.x() - a.x()) * i / steps, a.y()), N, L, mods)
    if release:
        mouse(w, QEvent.Type.MouseButtonRelease, b, L, N, mods)


def click(w, p, button=L, mods=M.NoModifier):
    mouse(w, QEvent.Type.MouseButtonPress, p, button, button, mods)
    mouse(w, QEvent.Type.MouseButtonRelease, p, button, N, mods)


def key(w, k, mods=M.NoModifier, text=""):
    QApplication.sendEvent(w, QKeyEvent(QEvent.Type.KeyPress, k, mods, text))
    QApplication.sendEvent(w, QKeyEvent(QEvent.Type.KeyRelease, k, mods, text))


class Spy:
    """Enregistre les émissions des signaux d'un widget : spy.log = [(nom, valeur…)]."""

    def __init__(self, w, *names):
        self.log = []
        for n in names:
            getattr(w, n).connect(lambda *a, n=n: self.log.append((n,) + a))

    def names(self):
        return [e[0] for e in self.log]

    def count(self, n):
        return self.names().count(n)

    def clear(self):
        self.log.clear()


def pixel(img, x, y):
    return QColor(img.pixel(int(x), int(y)))


def is_blue(hex_color):
    c = QColor(hex_color)
    h, s, v = colorsys.rgb_to_hsv(c.redF(), c.greenF(), c.blueF())
    return s > 0.2 and v > 0.15 and 0.5 < h < 0.72


# ── Thèmes ───────────────────────────────────────────────────────────────────
def test_themes(app):
    check("10 thèmes", len(theme.THEMES) == 10, ", ".join(t.label for t in theme.THEMES.values()))
    check("thème par défaut : Graphite · Orange",
          theme.DEFAULT_THEME == "graphite-orange" and theme.THEMES["graphite-orange"].accent == "#ff7a00")
    check("Monochrome : accent blanc", theme.THEMES["monochrome"].accent.lower() == "#e8e8e8")
    check("bases Graphite / Noir / Ardoise", {t.base for t in theme.THEMES.values()} == {"graphite", "noir", "ardoise"})
    blues = [(tid, k, v) for tid in theme.THEMES for k, v in theme.tokens(tid).items() if is_blue(v)]
    check("aucun bleu dans les jetons", not blues, str(blues[:3]))
    check("rouge et vert fixes", all(theme.tokens(t)["DANGER"] == "#e03b3b" and theme.tokens(t)["LIVE"] == "#22b14c"
                                     for t in theme.THEMES))
    check("couleurs de piste", len(theme.TRACK_COLORS) == 8 and theme.TRACK_COLORS[0] == "#00c853")
    qss = theme.build_stylesheet()
    radii = [int(r) for r in re.findall(r"radius:\s*(\d+)px", qss)]
    check("coins de 3 px au plus", radii and max(radii) <= 3, str(sorted(set(radii))))
    check("aucun dégradé dans la feuille de style", "gradient" not in qss.lower())
    check("settings : choix = thèmes", set(S.CHOICES[("ui", "theme")]) == set(theme.THEMES)
          and S.DEFAULTS["ui"]["theme"] == theme.DEFAULT_THEME)
    check("settings : thème inconnu → défaut", S.valid_value("ui", "theme", "bleu") == theme.DEFAULT_THEME
          and S.valid_value("ui", "theme", "noir-violet") == "noir-violet")
    path = os.path.join(tempfile.mkdtemp(), "s.json")
    st = S.Settings(path)
    st.set("ui", "theme", "ardoise-corail")
    st.save()
    check("settings : thème enregistré", S.Settings(path).get("ui", "theme") == "ardoise-corail")

    seen = []
    theme.notifier.changed.connect(seen.append)
    pm1 = icons.pixmap("plus", "TEXT_DIM", 16)
    check("cache d'icônes : même image", icons.pixmap("plus", "TEXT_DIM", 16) is pm1 and icons.cache_size() > 0)
    ic = icons.icon("plus", 16, color=theme.TEXT_DIM)
    on1 = ic.pixmap(48, 48, QIcon.Mode.Normal, QIcon.State.On).toImage()
    got = theme.set_theme("Noir · Violet", app)
    check("set_theme par libellé", got == "noir-violet" and theme.CURRENT == "noir-violet"
          and theme.ACCENT == "#c04dff" and theme.BG_APP == "#0a0a0a")
    check("signal de changement", seen and seen[-1] == "noir-violet")
    check("feuille de style refaite", "#c04dff" in app.styleSheet() and "#ff7a00" not in app.styleSheet())
    check("cache d'icônes vidé au changement de thème", icons.cache_size() == 0)
    on2 = ic.pixmap(48, 48, QIcon.Mode.Normal, QIcon.State.On).toImage()

    def tint(img):
        px = [img.pixelColor(x, y) for x in range(img.width()) for y in range(img.height())]
        return max(px, key=lambda c: c.alpha()).name()
    check("icône recolorée sans être refaite (accent)", tint(on1) == "#ff7a00" and tint(on2) == "#c04dff",
          f"{tint(on1)} → {tint(on2)}")
    check("thème inconnu → défaut", theme.set_theme("??", app) == theme.DEFAULT_THEME)
    theme.notifier.changed.disconnect(seen.append)


# ── Nombres ──────────────────────────────────────────────────────────────────
def test_numbers():
    check("nombres à la française", fmt_number(-0.5, 1) == "−0,5" and fmt_number(62, 0) == "62"
          and fmt_number(-0.001, 1) == "0,0")
    check("saisie : virgule, signe −, unité", parse_number("−1,5 %", " %") == -1.5 and parse_number(" 2.25 ") == 2.25)
    check("saisie : non finie refusée", parse_number("inf") is None and parse_number("nan") is None
          and parse_number("abc") is None)


# ── SliderField ──────────────────────────────────────────────────────────────
def test_slider(app, host):
    s = SliderField("Taille", 0.5, 0.0, 2.0, 0.0, 1.0, decimals=0, unit=" %", factor=100, default=1.0, osc=True)
    host.layout().addWidget(s)
    s.resize(300, 26)
    s.show()
    app.processEvents()
    spy = Spy(s, "editStarted", "valueChanged", "editFinished", "editCancelled", "resetRequested", "oscRequested")
    bar = s.bar_rect()
    y = bar.center().y()
    check("affichage : valeur, unité", s.display_text() == "50 %" and abs(s.fill_ratio() - 0.5) < 1e-9)
    x0 = bar.left() + bar.width() / 2
    drag(s, QPointF(x0, y), QPointF(x0 + bar.width() / 4, y), steps=10)
    check("glisser : un seul geste, valeur en direct", spy.count("editStarted") == 1 and spy.count("editFinished") == 1
          and spy.count("valueChanged") >= 3, str(spy.names()[:6]))
    check("glisser d'un quart de barre = un quart de plage", abs(s.value() - 0.75) < 0.03, f"{s.value():.3f}")
    check("valeur finale transmise", spy.log[-1] == ("editFinished", s.value()))
    check("arrondi à la précision affichée", abs(s.value() * 100 - round(s.value() * 100)) < 1e-9)

    # Maj = fin
    s.set_value(0.5)
    spy.clear()
    drag(s, QPointF(x0, y), QPointF(x0 + 100, y), mods=M.ShiftModifier, steps=10)
    fine = s.value() - 0.5
    s.set_value(0.5)
    drag(s, QPointF(x0, y), QPointF(x0 + 100, y), steps=10)
    normal = s.value() - 0.5
    check("Maj : réglage fin (10 fois moins)", 0 < fine < normal / 5, f"{fine:.3f} / {normal:.3f}")
    # Ctrl = crans
    s.set_value(0.5)
    drag(s, QPointF(x0, y), QPointF(x0 + 37, y), mods=M.ControlModifier, steps=10)
    check("Ctrl : par crans", abs(s.value() / s.snap - round(s.value() / s.snap)) < 1e-6, f"{s.value()} / {s.snap}")
    # Bornes douces au glisser
    s.set_value(0.5)
    drag(s, QPointF(x0, y), QPointF(x0 + 2000, y), steps=10)
    check("glisser borné à la plage douce", abs(s.value() - 1.0) < 1e-9, f"{s.value()}")

    # Échap pendant le glisser
    s.set_value(0.3)
    spy.clear()
    drag(s, QPointF(x0, y), QPointF(x0 + 60, y), steps=6, release=False)
    moved = s.value()
    key(s, Qt.Key.Key_Escape)
    mouse(s, QEvent.Type.MouseButtonRelease, QPointF(x0 + 60, y), L, N)
    check("Échap annule le glisser", abs(moved - 0.3) > 0.01 and abs(s.value() - 0.3) < 1e-9
          and ("editCancelled", 0.3) in spy.log and spy.count("editFinished") == 0, str(spy.names()))
    check("pendant un glisser, Échap est pour le champ (pas un raccourci)", s._press_x is None)

    # abort() : annulé ailleurs, aucun signal ensuite
    spy.clear()
    drag(s, QPointF(x0, y), QPointF(x0 + 40, y), steps=4, release=False)
    s.abort()
    mouse(s, QEvent.Type.MouseButtonRelease, QPointF(x0 + 40, y), L, N)
    check("abort : le relâchement ne termine rien", spy.count("editFinished") == 0 and spy.count("editCancelled") == 0)

    # Molette : seulement avec le focus, les pas rapprochés font un seul geste
    s.set_value(0.5)
    s.clearFocus()
    spy.clear()
    ev = QWheelEvent(QPointF(x0, y), QPointF(s.mapToGlobal(QPoint(int(x0), int(y)))), QPoint(), QPoint(0, 120), N,
                     M.NoModifier, Qt.ScrollPhase.NoScrollPhase, False)
    QApplication.sendEvent(s, ev)
    check("molette sans focus : le panneau défile", not ev.isAccepted() and s.value() == 0.5)
    host.activateWindow()
    s.setFocus()
    app.processEvents()
    check("le champ prend le focus", s.hasFocus())
    for _ in range(3):
        QApplication.sendEvent(s, QWheelEvent(QPointF(x0, y), QPointF(), QPoint(), QPoint(0, 120), N, M.NoModifier,
                                              Qt.ScrollPhase.NoScrollPhase, False))
    check("molette : 3 pas", abs(s.value() - 0.53) < 1e-9, f"{s.value()}")
    check("molette : un seul début de geste", spy.count("editStarted") == 1 and spy.count("editFinished") == 0)
    QTest.qWait(700)
    check("molette : fin du geste après une pause", spy.count("editFinished") == 1)
    # Flèches (Maj = petit pas, Ctrl = grand pas) et Échap
    spy.clear()
    s.set_value(0.5)
    key(s, Qt.Key.Key_Right)
    key(s, Qt.Key.Key_Right, M.ControlModifier)
    check("flèches : pas et grand pas", abs(s.value() - 0.61) < 1e-9, f"{s.value()}")
    key(s, Qt.Key.Key_Escape)
    check("Échap annule les pas", abs(s.value() - 0.5) < 1e-9 and spy.count("editCancelled") == 1)

    # Saisie : double-clic, Entrée
    spy.clear()
    mouse(s, QEvent.Type.MouseButtonDblClick, QPointF(x0, y), L, L)
    ed = s.typing_editor()
    check("double-clic : saisie", ed is not None and ed.text() == "50")
    ed.setText("12,5")
    key(ed, Qt.Key.Key_Return)
    check("saisie validée (unité affichée en %)", abs(s.value() - 0.125) < 1e-9 and s.typing_editor() is None
          and spy.names() == ["editStarted", "valueChanged", "editFinished"], f"{s.value()} {spy.names()}")
    for txt in ("inf", "nan", "abc"):
        key(s, Qt.Key.Key_Return)
        ed = s.typing_editor()
        ed.setText(txt)
        key(ed, Qt.Key.Key_Return)
    check("saisie non finie refusée", abs(s.value() - 0.125) < 1e-9 and spy.count("editFinished") == 1)
    key(s, Qt.Key.Key_Return)
    s.typing_editor().setText("900")
    key(s.typing_editor(), Qt.Key.Key_Return)
    check("saisie bornée (bornes dures)", abs(s.value() - 2.0) < 1e-9, f"{s.value()}")
    key(s, Qt.Key.Key_F2)
    s.typing_editor().setText("3")
    key(s.typing_editor(), Qt.Key.Key_Escape)
    check("Échap annule la saisie", s.typing_editor() is None and abs(s.value() - 2.0) < 1e-9)

    # Valeur par défaut : clic droit, Alt + clic
    spy.clear()
    click(s, QPointF(x0, y), R)
    check("clic droit : valeur par défaut", abs(s.value() - 1.0) < 1e-9 and spy.count("editFinished") == 1)
    s.set_value(0.2)
    click(s, QPointF(x0, y), L, M.AltModifier)
    check("Alt + clic : valeur par défaut", abs(s.value() - 1.0) < 1e-9)
    s.set_default(None)
    spy.clear()
    click(s, QPointF(x0, y), R)
    check("sans valeur par défaut : resetRequested", spy.names() == ["resetRequested"])
    # Bouton oscillateur
    spy.clear()
    o = s.osc_rect().center()
    click(s, o)
    check("bouton ∿ : oscRequested", spy.names() == ["oscRequested"] and abs(s.value() - 1.0) < 1e-9)
    s.set_osc_active(True)
    check("oscillateur actif : « ~ » devant la valeur", s.display_text().startswith("~ "))
    # Entier
    si = SliderField("Branches", 5, 2, 64, 2, 20, integer=True)
    host.layout().addWidget(si)
    si.resize(300, 26)
    b = si.bar_rect()
    drag(si, QPointF(b.left() + 50, b.center().y()), QPointF(b.left() + 90, b.center().y()))
    check("entier : valeurs entières", si.value() == int(si.value()) and si.value() > 5
          and si.display_text() == str(int(si.value())))
    # Rendu dans tous les états (aucune exception)
    s._dragging = True
    img1 = s.grab()
    s._dragging = False
    check("rendu actif / repos", not img1.isNull() and not s.grab().isNull())
    return s


# ── Switch, Segmented, ColorChips, Card, Tile, TopBarButton ──────────────────
def test_small(app, host):
    sw = Switch(False)
    host.layout().addWidget(sw)
    sw.resize(sw.sizeHint())
    spy = Spy(sw, "clicked", "toggled")
    click(sw, QPointF(5, sw.height() / 2))
    check("interrupteur : clic = oui", sw.isChecked() and spy.count("clicked") == 1 and ("toggled", True) in spy.log)
    spy.clear()
    sw.set_value(False)
    check("interrupteur : set_value sans signal", not sw.isChecked() and not spy.log)

    seg = Segmented(["Fixe", "Courbe", "Oscillateur"], 0, focusable=True)
    host.layout().addWidget(seg)
    seg.resize(seg.sizeHint())
    spy = Spy(seg, "currentChanged")
    r = seg.segment_rects()
    click(seg, r[2].center())
    check("segments : clic", seg.current() == 2 and spy.log == [("currentChanged", 2)])
    click(seg, r[2].center())
    check("segments : même segment, pas de signal", len(spy.log) == 1)
    key(seg, Qt.Key.Key_Left)
    check("segments : flèche", seg.current() == 1 and spy.log[-1] == ("currentChanged", 1))
    seg.set_current(0)
    check("segments : set_current sans signal", seg.current() == 0 and len(spy.log) == 2)
    big = Segmented([("Forme", "⌘1"), ("Show", "⌘2"), ("Live", "⌘3")], 0, large=True)
    check("grands segments (onglets)", big.sizeHint().height() == 26
          and big.sizeHint().width() > seg.sizeHint().width())

    cc = ColorChips(none_first=False)
    host.layout().addWidget(cc)
    cc.resize(cc.sizeHint())
    spy = Spy(cc, "colorChosen")
    click(cc, cc.chip_rect(1).center())
    check("pastilles : clic = couleur", spy.log and spy.log[-1][1] == cc.entries()[1] and cc.selected_index() == 1)
    last = len(cc.entries()) - 1
    click(cc, cc.chip_rect(last).center())
    check("pastille « aucune »", spy.log[-1] == ("colorChosen", None) and cc.entries()[last] is None)
    cc.set_value("#ffffff")
    check("set_value : pastille entourée", cc.entries()[cc.selected_index()] == (1.0, 1.0, 1.0))
    cc.set_value((0.3, 0.3, 0.3))
    check("couleur absente : aucune pastille entourée", cc.selected_index() == -1)

    card = Card("Points", "· 1/4 de temps", expanded=True)
    card.add_widget(SliderField("Espacement", 0.04, 0, 1, decimals=0, unit=" %", factor=100))
    host.layout().addWidget(card)
    card.resize(300, 120)
    card.show()
    app.processEvents()
    spy = Spy(card, "toggledOn", "expandedChanged")
    click(card.header, QPointF(card.header.width() / 2, 15))
    check("carte : clic sur l'en-tête = replier", not card.is_expanded() and card.body.isHidden()
          and spy.log == [("expandedChanged", False)])
    click(card.switch, QPointF(4, card.switch.height() / 2))
    check("carte : interrupteur", spy.log[-1] == ("toggledOn", False) and not card.is_on()
          and card.title.property("off") is True and not card.is_expanded())

    calls = []
    t = Tile("Étoile", lambda p, r: calls.append(QRectF(r)), key="A")
    host.layout().addWidget(t)
    t.resize(120, 120)
    t.show()
    spy = Spy(t, "clicked", "doubleClicked", "contextRequested")
    t.grab()
    check("vignette : aperçu peint par le rappel", calls and calls[-1].width() > 100)
    click(t, QPointF(60, 60))
    mouse(t, QEvent.Type.MouseButtonDblClick, QPointF(60, 60), L, L)
    click(t, QPointF(60, 60), R)
    check("vignette : clic, double-clic, clic droit", spy.names() == ["clicked", "doubleClicked", "contextRequested"],
          str(spy.names()))
    for state in ({"selected": True}, {"playing": True}, {"waiting": True}, {"empty": True}, {"add": True}):
        t.set_state(**{k: False for k in ("selected", "playing", "waiting", "empty", "add")})
        t.set_state(**state)
        t.set_progress(0.5)
        t.grab()
    t.strip = "bar"
    check("vignette : tous les états se peignent", not t.grab().isNull())

    b = TopBarButton("BLACKOUT", None, "danger", checkable=True)
    check("bouton de la barre du haut", b.property("tb") == "danger" and b.isCheckable() and b.height() == 26)


# ── LaserView ────────────────────────────────────────────────────────────────
def laser_strokes(n_strokes=10, per=200):
    cols = [(0.12, 0.88, 1), (1, .17, .82), (.13, 1, .33), (1, .9, 0), (1, .12, .12), (1, 1, 1)]
    out = []
    for i in range(n_strokes):
        t = np.linspace(0, 2 * np.pi, per)
        r = 0.2 + 0.07 * i
        out.append(Stroke(np.column_stack((r * np.cos(3 * t + i), r * np.sin(2 * t))), color=cols[i % len(cols)]))
    return out


def test_laser(app):
    scene = LaserScene(laser_strokes())
    check("scène laser : 2000 points", scene.count == 2000)
    img = QImage(400, 400, QImage.Format.Format_ARGB32_Premultiplied)

    def bench(glow, n=15):
        best = 1e9
        for _ in range(n):
            img.fill(QColor(0, 0, 0))
            p = QPainter(img)
            t0 = time.perf_counter()
            scene.paint(p, QRectF(0, 0, 400, 400), glow, 1.5, 6)
            p.end()
            best = min(best, time.perf_counter() - t0)
        return best * 1000
    t_glow, t_plain = bench(True), bench(False)
    print(f"     rendu laser 2000 points, 400 px : {t_glow:.2f} ms avec halo, {t_plain:.2f} ms sans")
    check("rendu laser léger (< 15 ms avec halo)", t_glow < 15.0, f"{t_glow:.2f} ms")
    # Le halo éclaire autour du trait : un segment horizontal, pixel 3 px au-dessus
    seg = LaserScene([Stroke(np.array([[-0.8, 0.0], [0.8, 0.0]]), color=(0.0, 1.0, 0.0))])
    lum = []
    for glow in (True, False):
        img.fill(QColor(0, 0, 0))
        p = QPainter(img)
        seg.paint(p, QRectF(0, 0, 400, 400), glow, 1.5)
        p.end()
        lum.append(pixel(img, 200, 196).green())
    check("halo autour du trait (désactivable)", lum[0] > 10 and lum[1] == 0, str(lum))
    dots = LaserScene([Stroke(np.array([[0.0, 0.0], [0.5, 0.5]]), color=(1.0, 0.0, 0.0), kind="dots")])
    check("points isolés et tracés éteints", not dots.is_empty()
          and LaserScene([Stroke(np.zeros((3, 2)), color=(0, 0, 0))]).is_empty())
    v = LaserView(laser_strokes(2, 50), fit=True)
    v.resize(200, 160)
    check("LaserView se peint", not v.grab().isNull())


# ── Molette de la mire (D13) ─────────────────────────────────────────────────
def test_wheel(app, win):
    T, Ph, D = QInputDevice.DeviceType, Qt.ScrollPhase, QInputDevice.Capability
    check("molette souris = zoom", wheel_action(T.Mouse, Ph.NoScrollPhase, M.NoModifier) == "zoom")
    check("pavé tactile = déplacement", wheel_action(T.TouchPad, Ph.NoScrollPhase, M.NoModifier) == "pan"
          and wheel_action(T.Mouse, Ph.ScrollUpdate, M.NoModifier) == "pan"
          and wheel_action(T.Mouse, Ph.ScrollMomentum, M.NoModifier) == "pan")
    check("Ctrl / Cmd + molette = zoom", wheel_action(T.TouchPad, Ph.ScrollUpdate, M.ControlModifier) == "zoom"
          and wheel_action(T.Mouse, Ph.ScrollUpdate, M.MetaModifier) == "zoom")
    mouse_dev = QPointingDevice("souris de test", 4242, T.Mouse, QPointingDevice.PointerType.Generic,
                                D.Position | D.Scroll, 1, 3)
    pad_dev = QPointingDevice("pavé de test", 4243, T.TouchPad, QPointingDevice.PointerType.Finger,
                              D.Position | D.Scroll, 2, 1)
    view = win.canvas.view
    pos = QPointF(view.width() / 2 + 40, view.height() / 2 + 30)

    def wheel(dev, pixel_d, angle_d, phase, mods=M.NoModifier):
        view.vt.fit()
        ev = QWheelEvent(pos, QPointF(view.mapToGlobal(pos.toPoint())), pixel_d, angle_d, N, mods, phase, False,
                         Qt.MouseEventSource.MouseEventNotSynthesized, dev)
        QApplication.sendEvent(view, ev)
        return view.vt.zoom, (view.vt.pan_x, view.vt.pan_y)
    # Souris sur macOS : déplacement en pixels ET en degrés, sans phase → zoom (bug M6 : la vue se déplaçait)
    z, pan = wheel(mouse_dev, QPoint(0, 12), QPoint(0, 120), Ph.NoScrollPhase)
    check("souris (macOS, pixels + degrés) : zoom", z > 1.1, f"zoom {z:.3f} pan {pan}")
    z, pan = wheel(mouse_dev, QPoint(), QPoint(0, -120), Ph.NoScrollPhase)
    check("souris (Windows / Linux) : dézoom", z < 0.9, f"zoom {z:.3f}")
    z, pan = wheel(mouse_dev, QPoint(0, 30), QPoint(0, 60), Ph.ScrollUpdate)
    check("défilement à phases (pavé tactile macOS) : déplacement", abs(z - 1) < 1e-9 and pan[1] != 0, f"{z} {pan}")
    z, pan = wheel(pad_dev, QPoint(20, 0), QPoint(40, 0), Ph.NoScrollPhase)
    check("pavé tactile (Linux) : déplacement", abs(z - 1) < 1e-9 and pan[0] != 0, f"{z} {pan}")
    z, pan = wheel(pad_dev, QPoint(0, 30), QPoint(0, 60), Ph.ScrollUpdate, M.ControlModifier)
    check("Ctrl + pavé tactile : zoom", z > 1.0, f"{z}")
    view.vt.fit()
    g = QNativeGestureEvent(Qt.NativeGestureType.ZoomNativeGesture, pad_dev, 2, pos, pos,
                            QPointF(view.mapToGlobal(pos.toPoint())), 0.25, QPointF(), 0)
    QApplication.sendEvent(view, g)
    check("pincement : zoom", abs(view.vt.zoom - 1.25) < 1e-6, f"{view.vt.zoom}")
    view.vt.fit()


# ── Paramètres : Apparence et « Réinitialiser cet onglet » (F5) ──────────────
def test_settings_dialog(app, win):
    from ildagen.ui.dialogs import SettingsDialog
    ed = win.editor
    dlg = SettingsDialog(ed, win.live, win)
    tabs = [dlg.tabs.tabText(i) for i in range(dlg.tabs.count())]
    check("onglet Apparence", "Apparence" in tabs, ", ".join(tabs))
    ap = dlg.appearance
    dlg.tabs.setCurrentWidget(ap)
    lst = ap.list
    row = next(i for i in range(lst.count()) if lst.item(i).data(Qt.ItemDataRole.UserRole) == "noir-menthe")
    rect = lst.visualItemRect(lst.item(row))
    click(lst.viewport(), QPointF(rect.center()))
    app.processEvents()
    check("clic sur un thème : appliqué tout de suite et retenu", theme.CURRENT == "noir-menthe"
          and win.settings.get("ui", "theme") == "noir-menthe" and theme.ACCENT == "#00e5a8")
    check("aperçu de chaque thème", all(not lst.item(i).icon().isNull() for i in range(lst.count())))
    dlg._reset_tab()
    check("réinitialiser Apparence", theme.CURRENT == theme.DEFAULT_THEME
          and win.settings.get("ui", "theme") == theme.DEFAULT_THEME)
    # Grille (F5 : le bouton ne faisait rien)
    g = ed.doc.grid
    dlg.grid_fields["divisions"].setValue(20)
    dlg.grid_fields["rays"].setValue(40)
    check("grille modifiée", g.divisions == 20 and g.rays == 40)
    dlg.tabs.setCurrentIndex(tabs.index("Grille"))
    dlg._reset_tab()
    check("réinitialiser Grille (F5)", g.divisions == 8 and g.rays == 16 and dlg.grid_fields["divisions"].value() == 8)
    # Général : interrupteurs
    sw = dlg.widgets[("general", "show_blanking")]
    check("réglage oui / non = interrupteur", isinstance(sw, Switch))
    sw.click()
    check("interrupteur appliqué", win.settings.get("general", "show_blanking") is True)
    win.settings.set("general", "live_last", True)
    dlg.tabs.setCurrentIndex(tabs.index("Général"))
    dlg._reset_tab()
    check("réinitialiser Général", win.settings.get("general", "show_blanking") is False and not sw.isChecked()
          and win.settings.get("general", "live_last") is True)
    for name in ("Sortie laser", "Couleurs", "Zone de sécurité", "Trapèze", "Taille / position"):
        dlg.tabs.setCurrentIndex(tabs.index(name))
        dlg._reset_tab()
    check("réinitialiser : chaque onglet a son action", len(dlg.resets) == dlg.tabs.count())
    win.settings.set("general", "live_last", False)
    dlg.close()


# ── Galerie (captures) ───────────────────────────────────────────────────────
def gallery():
    w = QWidget()
    w.setObjectName("galerie")
    w.setAttribute(Qt.WidgetAttribute.WA_StyledBackground)
    w.resize(980, 600)
    lay = QHBoxLayout(w)
    left = QVBoxLayout()
    lay.addLayout(left, 1)
    act = SliderField("Taille", 0.62, 0, 2, 0, 1, decimals=0, unit=" %", factor=100, osc=True)
    act._dragging = True
    rot = SliderField("Rotation", 45, None, None, -360, 360, decimals=0, unit=" °/s", osc=True)
    rot.set_osc_active(True)
    for s in (act, SliderField("Branches", 5, 2, 64, 2, 20, integer=True, osc=True),
              SliderField("Creux", 0.42, 0, 1, decimals=0, unit=" %", factor=100, osc=True), rot,
              SliderField("Vitesse", 1.0, 0, 4, decimals=1, unit="×")):
        left.addWidget(s)
    cc = ColorChips()
    cc.set_value(theme.LASER_COLORS[0])
    left.addWidget(cc)
    row = QHBoxLayout()
    row.addWidget(Segmented(["Fixe", "Courbe", "Oscillateur"], 1))
    row.addWidget(Switch(True))
    row.addWidget(Switch(False))
    row.addStretch(1)
    left.addLayout(row)
    left.addWidget(Segmented([("Forme", "⌘1"), ("Show", "⌘2"), ("Live", "⌘3")], 0, large=True))
    c1 = Card("Points")
    for lab, v in (("Espacement", 0.04), ("Dosage", 1.0)):
        c1.add_widget(SliderField(lab, v, 0, 1, decimals=0, unit=" %", factor=100, osc=True))
    left.addWidget(c1)
    left.addWidget(Card("Clignotement", "· 1/4 de temps", expanded=False))
    left.addWidget(Card("Symétrie", "· désactivé", on=False, expanded=False))
    bar = QHBoxLayout()
    for text, ic, var, on in (("SoundStage3D", None, "plain", False), ("Live", "radio", "live", True),
                              ("BLACKOUT", None, "danger", False), ("Maîtres", "sliders-vertical", "normal", False)):
        b = TopBarButton(text, ic, var, checkable=True)
        b.setChecked(on)
        bar.addWidget(b)
    left.addLayout(bar)
    left.addStretch(1)
    grid = QGridLayout()
    lay.addLayout(grid, 1)
    scene = LaserScene(laser_strokes(3, 120), fit=True)
    for i, (name, state) in enumerate((("Étoile", {"selected": True}), ("Anneaux", {"playing": True}),
                                       ("Lissajous", {"waiting": True}), ("", {"add": True}))):
        t = Tile(name, (lambda p, r: scene.paint(p, r, True, 1.3, 6)) if name else None, key="AZER"[i],
                 strip="overlay" if i == 0 else "bar")
        t.set_state(**state)
        t.set_progress(0.35)
        grid.addWidget(t, i // 2, i % 2)
    grid.addWidget(LaserView(laser_strokes(4, 160)), 2, 0, 1, 2)
    return w


def main():
    app = QApplication([])
    sys.excepthook = lambda t, v, tb: (traceback.print_exception(t, v, tb),
                                       check(f"exception {t.__name__} : {v}", False))
    app.setStyle("Fusion")
    theme.set_theme(theme.DEFAULT_THEME, app)
    test_themes(app)
    test_numbers()
    host = QWidget()
    host.setLayout(QVBoxLayout())
    host.resize(400, 600)
    host.show()
    app.processEvents()
    test_slider(app, host)
    test_small(app, host)
    test_laser(app)

    from ildagen.core.settings import Settings
    from ildagen.ui.main_window import MainWindow
    win = MainWindow(Settings(path=os.path.join(tempfile.mkdtemp(), "s.json")))
    win.resize(1440, 900)
    win.show()
    app.processEvents()
    test_wheel(app, win)
    test_settings_dialog(app, win)
    for tid in theme.THEMES:
        theme.set_theme(tid, app)
        app.processEvents()
        ok = not win.grab().isNull()
        if SHOTS and tid in ("graphite-orange", "noir-violet", "ardoise-corail", "monochrome"):
            os.makedirs(SHOTS, exist_ok=True)
            win.grab().save(os.path.join(SHOTS, f"fenetre_{tid}.png"))
            g = gallery()
            g.setStyleSheet(f"QWidget#galerie {{ background: {theme.BG_PANEL}; }}")
            g.show()
            app.processEvents()
            g.grab().save(os.path.join(SHOTS, f"galerie_{tid}.png"))
            g.close()
            g.deleteLater()
        if not ok:
            check(f"fenêtre dans le thème {tid}", False)
    check("la fenêtre se peint dans les 10 thèmes", True)
    theme.set_theme(theme.DEFAULT_THEME, app)
    from ildagen.app import shutdown
    win.editor.dirty = False
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
