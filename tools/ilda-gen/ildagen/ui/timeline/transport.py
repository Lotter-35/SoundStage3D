"""Barre de transport : lecture, boucle, aimant, BPM, mesure, grille, départ de la mesure 1, musique."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QComboBox, QDoubleSpinBox, QHBoxLayout, QLabel, QPushButton, QSpinBox, QToolButton, QWidget

from ..spin import DoubleSpinBox, SpinBox
from ...core.timeline import SUBDIVISIONS
from .. import icons, theme


def tbtn(icon_name, tip, checkable=False):
    b = QToolButton()
    b.setIcon(icons.icon(icon_name, 16))
    b.setIconSize(icons.qsize(16))
    b.setToolTip(tip)
    b.setCheckable(checkable)
    b.setAutoRaise(True)
    b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
    return b


def dim(text):
    lab = QLabel(text)
    lab.setObjectName("dim")
    return lab


class TransportBar(QWidget):
    def __init__(self, editor, playback, canvas, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.playback = playback
        self.canvas = canvas
        self.setObjectName("bar")
        self.setFixedHeight(36)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(8, 3, 8, 3)
        lay.setSpacing(4)

        self.btn_play = tbtn("play", "Lecture / pause (Espace)")
        self.btn_play.clicked.connect(playback.toggle)
        self.btn_stop = tbtn("square-stop", "Stop (retour au début)")
        self.btn_stop.clicked.connect(playback.stop)
        self.btn_loop = tbtn("repeat", "Lecture en boucle (zone de boucle : glisser en haut de la règle)", True)
        self.btn_loop.clicked.connect(self._loop_clicked)
        self.btn_snap = tbtn("magnet", "Aimant : accrocher à la grille (Alt pendant un glisser = libre)", True)
        self.btn_snap.clicked.connect(lambda on: self._set("snap", on, "Aimant"))
        for b in (self.btn_play, self.btn_stop, self.btn_loop, self.btn_snap):
            lay.addWidget(b)

        self.timecode = QLabel("")
        self.timecode.setFont(theme.mono_font(12))
        self.timecode.setMinimumWidth(170)
        self.timecode.setContentsMargins(8, 0, 8, 0)
        lay.addWidget(self.timecode)

        lay.addWidget(dim("BPM"))
        self.bpm = DoubleSpinBox()
        self.bpm.setRange(20.0, 400.0)
        self.bpm.setDecimals(2)
        self.bpm.setFixedWidth(66)
        self.bpm.setButtonSymbols(QDoubleSpinBox.ButtonSymbols.NoButtons)
        self.bpm.editingFinished.connect(lambda: self._set("bpm", self.bpm.value(), "BPM"))
        lay.addWidget(self.bpm)
        self.btn_tap = QPushButton("Tap")
        self.btn_tap.setToolTip("Tapez en rythme pour trouver le BPM")
        self.btn_tap.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.btn_tap.clicked.connect(self._tap)
        self._taps = []
        lay.addWidget(self.btn_tap)
        lay.addWidget(dim("Temps / mesure"))
        self.beats = SpinBox()
        self.beats.setRange(1, 16)
        self.beats.setFixedWidth(40)
        self.beats.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
        self.beats.editingFinished.connect(lambda: self._set("beats_per_bar", self.beats.value(), "Mesure"))
        lay.addWidget(self.beats)
        lay.addWidget(dim("Grille"))
        self.grid = QComboBox()
        self.grid.addItems([s[0] for s in SUBDIVISIONS])
        self.grid.activated.connect(lambda i: self._set("subdivision", i, "Grille"))
        lay.addWidget(self.grid)
        lay.addWidget(dim("Mesure 1 à"))
        self.offset = DoubleSpinBox()
        self.offset.setRange(-600.0, 3600.0)
        self.offset.setDecimals(3)
        self.offset.setSuffix(" s")
        self.offset.setFixedWidth(86)
        self.offset.setButtonSymbols(QDoubleSpinBox.ButtonSymbols.NoButtons)
        self.offset.editingFinished.connect(lambda: self._set("bar_offset", self.offset.value(), "Mesure 1"))
        lay.addWidget(self.offset)
        here = QPushButton("Ici")
        here.setToolTip("La mesure 1 commence à la tête de lecture")
        here.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        here.clicked.connect(lambda: self._set("bar_offset", editor.playhead, "Mesure 1"))
        lay.addWidget(here)
        lay.addStretch(1)

        self.btn_music = QPushButton(" Musique…")
        self.btn_music.setIcon(icons.icon("music", 14, color=theme.TEXT))
        self.btn_music.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        lay.addWidget(self.btn_music)
        zo = tbtn("zoom-out", "Dézoomer (Ctrl + molette)")
        zi = tbtn("zoom-in", "Zoomer (Ctrl + molette)")
        zo.clicked.connect(lambda: canvas.zoom_at(1 / 1.5, canvas.geo.x(editor.playhead)))
        zi.clicked.connect(lambda: canvas.zoom_at(1.5, canvas.geo.x(editor.playhead)))
        lay.addWidget(zo)
        lay.addWidget(zi)
        add = tbtn("plus", "Ajouter une piste")
        add.clicked.connect(editor.add_track)
        lay.addWidget(add)

        editor.timelineChanged.connect(self.refresh)
        editor.projectChanged.connect(self.refresh)
        editor.playheadChanged.connect(self._timecode)
        playback.playingChanged.connect(self._playing)
        self.refresh()

    def _set(self, attr, value, label):
        tl = self.editor.doc.timeline
        if getattr(tl, attr) != value:
            self.editor.timeline_mutate(label, lambda: setattr(tl, attr, value))

    def _tap(self):
        import time
        now = time.monotonic()
        self._taps = [t for t in self._taps if now - t < 3.0] + [now]
        if len(self._taps) >= 3:
            gaps = [b - a for a, b in zip(self._taps, self._taps[1:])]
            bpm = round(60.0 / (sum(gaps) / len(gaps)), 1)
            if 20 <= bpm <= 400:
                self._set("bpm", bpm, "BPM")

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

    def refresh(self):
        tl = self.editor.doc.timeline
        for w, v in ((self.bpm, tl.bpm), (self.beats, tl.beats_per_bar), (self.offset, tl.bar_offset)):
            if not w.hasFocus():
                w.blockSignals(True)
                w.setValue(v)
                w.blockSignals(False)
        self.grid.setCurrentIndex(tl.subdivision)
        self.btn_loop.setChecked(tl.loop_on)
        self.btn_snap.setChecked(tl.snap)
        self._timecode(self.editor.playhead)

    def _playing(self, on):
        self.btn_play.setIcon(icons.icon("pause" if on else "play", 16))

    def _timecode(self, t):
        bar, beat, sub = self.editor.doc.timeline.position(t)
        m, s = divmod(max(0.0, t), 60)
        self.timecode.setText(f"{bar:>3}.{beat}.{sub}   {int(m):02d}:{s:06.3f}")
