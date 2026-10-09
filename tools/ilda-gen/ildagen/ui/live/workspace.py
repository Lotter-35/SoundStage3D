"""Espace Live : jouer les formes en direct depuis une grille de cues (façon Pangolin Beyond).

À gauche : la barre des pages (onglets, départ, plusieurs cues, tout arrêter) au-dessus de la grille 8 × 4 de la
page affichée ; à droite : la sortie (aperçu laser, tempo, Tap) et les effets rapides. Barre d'état :
« N cues en cours · P points · F images/s ».

Une horloge d'affichage (FPS images/s) tourne seulement quand l'espace est affiché : à chaque image, chaque cue
en cours est calculé une fois (sa forme au temps écoulé depuis son départ) et sert à la fois à sa case et à
l'aperçu de la sortie (+ effets rapides + maîtres). Le laser, lui, est calculé dans le fil d'envoi
(editor/live_snapshot.py) à partir des mêmes données (D11).

Clavier (keys.py) : touches des cues, chiffres 1 à 8 = effets rapides tenus, Échap = tout arrêter.
"""

import time

from PySide6.QtCore import QTimer, Qt
from PySide6.QtWidgets import QApplication, QHBoxLayout, QLabel, QSplitter, QVBoxLayout, QWidget

from ...core.masters import apply_masters
from ...editor.live_runtime import apply_quick, cue_strokes
from ..layout import restore_splits, save_splits
from .cue_grid import CueGrid
from .keys import LiveKeys
from .output_panel import OutputPanel
from .pages_bar import PagesBar
from .thumbs import Thumbs

FPS = 25
STATUS_EVERY = 5        # barre d'état : une image sur 5
OUT_BUDGET = 0.008      # s : au-delà, l'aperçu de la sortie saute des images
OUT_SKIP_MAX = 2        # au plus 2 images sautées sur 3


class LiveWorkspace(QWidget):
    def __init__(self, win, parent=None):
        super().__init__(parent)
        self.win = win
        ed = self.editor = win.editor
        self.thumbs = Thumbs(ed)
        self.pages = PagesBar(ed)
        self.grid = CueGrid(ed, self.thumbs)
        self.output = OutputPanel(ed)
        self.keys = LiveKeys(ed, win, self)

        left = QWidget()
        v = QVBoxLayout(left)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)
        v.addWidget(self.pages)
        v.addWidget(self.grid, 1)
        self.split = QSplitter(Qt.Orientation.Horizontal)
        self.split.addWidget(left)
        self.split.addWidget(self.output)
        self.split.setStretchFactor(0, 1)
        self.split.setStretchFactor(1, 0)
        self.split.setChildrenCollapsible(False)
        self.split.setSizes([1100, 340])
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self.split)

        self.status = QLabel()
        self.status.setObjectName("dim")
        self.status.hide()
        self._status_added = False
        self.frame = 0
        self._dirty = True              # contenu à relire à l'affichage
        self._output_idle = False       # sortie vide déjà affichée
        self._out_next = 0              # prochaine image où l'aperçu de la sortie est recalculé
        self.timer = QTimer(self)
        self.timer.setInterval(1000 // FPS)
        self.timer.timeout.connect(self.tick)

        ed.liveChanged.connect(self._live_changed)
        ed.docChanged.connect(self._doc_changed)
        ed.libraryChanged.connect(self._live_changed)
        ed.mastersChanged.connect(self._doc_changed)
        ed.projectChanged.connect(self._live_changed)
        ed.timelineChanged.connect(self.output.refresh)
        QApplication.instance().applicationStateChanged.connect(self._app_state)

    # ── Affichage ────────────────────────────────────────────────────────
    def showEvent(self, e):
        super().showEvent(e)
        if not self._status_added and getattr(self.win, "status", None) is not None:
            self.win.status.addPermanentWidget(self.status)
            self._status_added = True
        self.status.show()
        self.keys.install()
        self._dirty = True
        self.refresh()
        self.timer.start()
        QTimer.singleShot(0, self._focus)

    def hideEvent(self, e):
        super().hideEvent(e)
        self.timer.stop()
        self.keys.remove()              # les effets rapides tenus au clavier sont lâchés
        self.status.hide()

    def _focus(self):
        w = QApplication.focusWidget()
        if self.isVisible() and (w is None or not self.isAncestorOf(w)):
            self.grid.setFocus()

    def _app_state(self, state):
        if state != Qt.ApplicationState.ApplicationActive:
            self.keys.release_all()     # touche relâchée hors de la fenêtre : l'effet ne reste pas tenu

    # ── Changements ──────────────────────────────────────────────────────
    def _live_changed(self):
        self._dirty = True
        if self.isVisible():
            self.refresh()

    def _doc_changed(self):
        self._output_idle = False
        if self.isVisible() and self.grid.tiles and self.grid.tiles[0].rev != self.editor.content_rev:
            self.refresh()

    def refresh(self):
        """Relit les pages, les cues et les réglages du live, puis affiche l'image en cours."""
        if self._dirty:
            self._dirty = False
            self.editor.prune_live()
        self.pages.refresh()
        self.grid.refresh()
        self.output.refresh()
        self._output_idle = False
        self.tick(advance=False)

    # ── Une image ────────────────────────────────────────────────────────
    def tick(self, advance=True):
        ed = self.editor
        if advance:
            self.frame += 1
        now = time.perf_counter()
        rt = ed.runtime
        s_now = rt.clock.at(now)
        color = ed.default_color()
        active = rt.active(now)
        out = {pc.cue_id: cue_strokes(ed.doc, pc, s_now, color) for pc in active}
        self.grid.tick(now, s_now, out, self.frame)
        if (active or rt.held or not self._output_idle) and (not advance or self.frame >= self._out_next):
            strokes = [s for pc in active for s in out[pc.cue_id]]
            strokes = apply_quick(ed.doc, rt, strokes, s_now, color)
            self.output.set_strokes(apply_masters(strokes, ed.doc.masters))
            self._output_idle = not (active or rt.held)
            # Aperçu lourd (arc-en-ciel sur beaucoup de points…) : mis à jour moins souvent, la grille et le
            # clavier restent vifs (le laser, lui, est calculé dans le fil d'envoi)
            self._out_next = self.frame + 1 + min(OUT_SKIP_MAX, int(self.output.view.cost / OUT_BUDGET))
        if not advance or self.frame % STATUS_EVERY == 0:
            self._status(len(active))

    def _status(self, n):
        live = self.win.live
        pts = f"{live.stats.count:,}".replace(",", " ")
        cues = f"{n} cue{'s' if n > 1 else ''} en cours"
        self.status.setText(f"{cues} · {pts} points · {live.fps()} images/s")

    # ── Disposition ──────────────────────────────────────────────────────
    def splits(self):
        return {"split": self.split}

    def save_layout(self):
        return save_splits(self.splits())

    def restore_layout(self, state):
        restore_splits(self.splits(), state)

    def reset_layout(self):
        self.split.setSizes([1100, 340])
