"""Barre de transport compacte (F1 : elle tient dans une fenêtre de 1100 px) :

▶ ■ ⟳ · position (mesure.temps.subdivision · minutes:secondes) · BPM + Tap ····· Grille 1/2 1/4 1/8 ▾ · aimant ·
zoom − + ajuster · musique · ⋯ (Début de la mesure 1, Caler sur la tête de lecture, temps par mesure).

Grille : valeurs de note (1/4 = une noire = un temps) ; les autres (1/16, 1/32, triolets) sont dans le petit
menu ▾. Quand la place manque, les éléments les moins utiles se cachent (libellé « Grille », zoom, stop).
"""

import time

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (QHBoxLayout, QInputDialog, QLabel, QLineEdit, QMenu, QPushButton, QSizePolicy,
                               QToolButton, QWidget)

from ...core.timeline import SUBDIVISIONS
from .. import icons, theme
from ..widgets import Segmented, fmt_number, parse_number

# Segments de la grille : (libellé, index dans SUBDIVISIONS, infobulle)
GRID_SEGMENTS = [("1/2", 6, "Blanche : 2 temps"), ("1/4", 0, "Noire : 1 temps"), ("1/8", 1, "Croche : 1/2 temps")]
GRID_MENU = [(6, "1/2 · blanche"), (0, "1/4 · noire (temps)"), (1, "1/8 · croche"), (2, "1/16 · double croche"),
             (3, "1/32"), (4, "Triolets de croches"), (5, "Triolets de doubles")]


def tbtn(icon_name, tip, checkable=False):
    b = QToolButton()
    b.setIcon(icons.icon(icon_name, 16))
    b.setIconSize(icons.qsize(16))
    b.setToolTip(tip)
    b.setCheckable(checkable)
    b.setAutoRaise(True)
    b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
    b.setFixedSize(26, 24)
    return b


def vsep():
    s = QWidget()
    s.setFixedSize(13, 16)
    s.setObjectName("vsep")
    s.paintEvent = lambda _e, w=s: _paint_sep(w)
    return s


def _paint_sep(w):
    from PySide6.QtGui import QPainter
    p = QPainter(w)
    p.fillRect(6, 0, 1, w.height(), theme.qc(theme.BORDER))
    p.end()


class TransportBar(QWidget):
    musicRequested = Signal()

    def __init__(self, editor, playback, canvas, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.playback = playback
        self.canvas = canvas
        self.setObjectName("bar")
        self.setFixedHeight(34)
        self.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Fixed)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(8, 0, 8, 0)
        lay.setSpacing(2)

        self.btn_play = tbtn("play", "Lecture / pause (Espace)")
        self.btn_play.clicked.connect(playback.toggle)
        self.btn_stop = tbtn("square-stop", "Stop (retour au début)")
        self.btn_stop.clicked.connect(playback.stop)
        self.btn_loop = tbtn("repeat", "Lecture en boucle (zone : glisser dans le bas de la règle)", True)
        self.btn_loop.clicked.connect(self._loop_clicked)
        for b in (self.btn_play, self.btn_stop, self.btn_loop):
            lay.addWidget(b)
        lay.addSpacing(8)
        self.timecode = QLabel("")
        self.timecode.setFont(theme.mono_font(12))
        self.timecode.setToolTip("Position : mesure.temps.subdivision · minutes:secondes")
        lay.addWidget(self.timecode)
        self.sep1 = vsep()
        lay.addWidget(self.sep1)
        self.bpm = QLineEdit()
        self.bpm.setFont(theme.mono_font(12))
        self.bpm.setFixedWidth(46)
        self.bpm.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.bpm.setToolTip("Tempo (battements par minute) : tapez une valeur")
        self.bpm.editingFinished.connect(self._bpm_typed)
        lay.addWidget(self.bpm)
        bpm_lab = QLabel("BPM")
        bpm_lab.setObjectName("dim")
        bpm_lab.setFont(theme.mono_font(10))
        lay.addWidget(bpm_lab)
        lay.addSpacing(4)
        self.btn_tap = QPushButton("Tap")
        self.btn_tap.setFixedHeight(22)
        self.btn_tap.setToolTip("Tapez en rythme pour trouver le tempo")
        self.btn_tap.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.btn_tap.clicked.connect(self.tap)
        self._taps = []
        lay.addWidget(self.btn_tap)
        lay.addStretch(1)

        self.grid_label = QLabel("Grille")
        self.grid_label.setObjectName("dim")
        lay.addWidget(self.grid_label)
        lay.addSpacing(4)
        self.grid = Segmented([s[0] for s in GRID_SEGMENTS])
        self.grid.set_tooltips([s[2] for s in GRID_SEGMENTS])
        self.grid.currentChanged.connect(lambda i: self.set_grid(GRID_SEGMENTS[i][1]))
        lay.addWidget(self.grid)
        self.btn_grid = tbtn("chevron-down", "Autres grilles : 1/16, 1/32, triolets")
        self.btn_grid.setFixedWidth(18)
        self.btn_grid.clicked.connect(lambda: self.grid_menu().exec(self.btn_grid.mapToGlobal(self.btn_grid.rect().bottomLeft())))
        lay.addWidget(self.btn_grid)
        self.btn_snap = tbtn("magnet", "Aimant : grille, bords des clips, repères, tête de lecture (Alt pendant un glisser = libre)", True)
        self.btn_snap.clicked.connect(lambda on: self._set("snap", on, "Aimant"))
        lay.addWidget(self.btn_snap)
        self.sep2 = vsep()
        lay.addWidget(self.sep2)
        self.btn_zo = tbtn("zoom-out", "Dézoomer (Ctrl + molette)")
        self.btn_zi = tbtn("zoom-in", "Zoomer (Ctrl + molette)")
        self.btn_fit = tbtn("scan", "Ajuster : la sélection, sinon tout (Z)")
        self.btn_zo.clicked.connect(lambda: canvas.zoom_at(1 / 1.5, canvas.geo.x(editor.playhead)))
        self.btn_zi.clicked.connect(lambda: canvas.zoom_at(1.5, canvas.geo.x(editor.playhead)))
        self.btn_fit.clicked.connect(lambda: canvas.zoom_fit())
        for b in (self.btn_zo, self.btn_zi, self.btn_fit):
            lay.addWidget(b)
        self.btn_music = tbtn("music", "Importer une musique…")
        self.btn_music.clicked.connect(self.musicRequested.emit)
        lay.addWidget(self.btn_music)
        self.btn_more = tbtn("ellipsis", "Mesure 1, temps par mesure, pistes")
        self.btn_more.clicked.connect(lambda: self.more_menu().exec(self.btn_more.mapToGlobal(self.btn_more.rect().bottomLeft())))
        lay.addWidget(self.btn_more)
        # Ce qui se cache en premier quand la place manque
        self.optional = [self.grid_label, self.btn_fit, self.btn_zo, self.btn_zi, self.sep2, self.btn_stop, self.btn_tap]

        editor.timelineChanged.connect(self.refresh)
        editor.projectChanged.connect(self.refresh)
        editor.playheadChanged.connect(self._timecode)
        playback.playingChanged.connect(self._playing)
        theme.notifier.changed.connect(lambda _: self._timecode(self.editor.playhead))
        self.refresh()

    # ── Réglages de la timeline ──────────────────────────────────────────
    def _set(self, attr, value, label):
        tl = self.editor.doc.timeline
        if getattr(tl, attr) != value:
            self.editor.timeline_mutate(label, lambda: setattr(tl, attr, value))

    def set_grid(self, sub):
        self._set("subdivision", int(sub), "Grille")

    def _bpm_typed(self):
        v = parse_number(self.bpm.text())
        if v is not None:
            self._set("bpm", round(min(400.0, max(20.0, v)), 2), "Tempo")
        self.refresh()

    def tap(self, now=None):
        now = time.monotonic() if now is None else now
        self._taps = [t for t in self._taps if now - t < 3.0] + [now]
        if len(self._taps) >= 3:
            gaps = [b - a for a, b in zip(self._taps, self._taps[1:])]
            bpm = round(60.0 / (sum(gaps) / len(gaps)), 1)
            if 20 <= bpm <= 400:
                self._set("bpm", bpm, "Tempo")

    def _loop_clicked(self, on):
        tl = self.editor.doc.timeline

        def do():
            tl.loop_on = on
            if on and tl.loop_end <= tl.loop_start:
                # Pas encore de zone : 4 mesures à partir de la mesure de la tête de lecture
                bar = (self.editor.playhead - tl.bar_offset) // tl.bar_len
                tl.loop_start = max(0.0, tl.bar_offset + bar * tl.bar_len)
                tl.loop_end = tl.loop_start + 4 * tl.bar_len
        self.editor.timeline_mutate("Boucle", do)

    # ── Menus ────────────────────────────────────────────────────────────
    def grid_menu(self):
        tl = self.editor.doc.timeline
        m = QMenu(self)
        for sub, label in GRID_MENU:
            a = m.addAction(label)
            a.setCheckable(True)
            a.setChecked(tl.subdivision == sub)
            a.triggered.connect(lambda _=False, s=sub: self.set_grid(s))
        return m

    def more_menu(self):
        ed = self.editor
        tl = ed.doc.timeline
        m = QMenu(self)
        m.addAction(f"Début de la mesure 1… ({fmt_number(tl.bar_offset, 3)} s)").triggered.connect(self.ask_bar_offset)
        m.addAction("Caler sur la tête de lecture").triggered.connect(
            lambda: self._set("bar_offset", ed.playhead, "Début de la mesure 1"))
        sub = m.addMenu("Temps par mesure")
        for n in (2, 3, 4, 5, 6, 7):
            a = sub.addAction(f"{n}/4")
            a.setCheckable(True)
            a.setChecked(tl.beats_per_bar == n)
            a.triggered.connect(lambda _=False, k=n: self._set("beats_per_bar", k, "Temps par mesure"))
        m.addSeparator()
        m.addAction("Ajouter une piste").triggered.connect(ed.add_track)
        return m

    def ask_bar_offset(self):
        tl = self.editor.doc.timeline
        v, ok = QInputDialog.getDouble(self, "Début de la mesure 1", "Instant (s) :", tl.bar_offset, 0.0, 3600.0, 3)
        if ok:
            self._set("bar_offset", v, "Début de la mesure 1")

    # ── Affichage ────────────────────────────────────────────────────────
    def refresh(self):
        tl = self.editor.doc.timeline
        if not self.bpm.hasFocus():
            self.bpm.setText(fmt_number(tl.bpm, 2 if tl.bpm % 1 else 0))
        idx = next((i for i, s in enumerate(GRID_SEGMENTS) if s[1] == tl.subdivision), -1)
        self.grid.set_current(idx)
        self.btn_grid.setToolTip("Grille : " + dict(GRID_MENU).get(tl.subdivision, SUBDIVISIONS[tl.subdivision][0]))
        self.btn_loop.setChecked(tl.loop_on)
        self.btn_snap.setChecked(tl.snap)
        self._timecode(self.editor.playhead)

    def _playing(self, on):
        self.btn_play.setIcon(icons.icon("pause" if on else "play", 16))

    def _timecode(self, t):
        bar, beat, sub = self.editor.doc.timeline.position(t)
        m, s = divmod(max(0.0, t), 60)
        self.timecode.setText(f"{bar}.{beat}.{sub} <span style='color:{theme.TEXT_DIM}'>· {int(m):02d}:{s:06.3f}</span>")

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self.fit_width()

    def fit_width(self):
        """Cache les éléments facultatifs tant que la barre ne tient pas dans sa largeur."""
        lay = self.layout()
        for w in self.optional:
            w.setVisible(True)
        lay.invalidate()
        for w in self.optional:
            if lay.sizeHint().width() <= self.width():
                break
            w.setVisible(False)
            lay.invalidate()

    def needed_width(self):
        return self.layout().sizeHint().width()
