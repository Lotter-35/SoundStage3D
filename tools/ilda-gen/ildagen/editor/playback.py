"""Lecture de la timeline : horloge, musique (QMediaPlayer), boucle."""

import time

from PySide6.QtCore import QElapsedTimer, QObject, QTimer, QUrl, Signal
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer

TICK_MS = 15
RESYNC_S = 0.06


class Playback(QObject):
    playingChanged = Signal(bool)
    transportChanged = Signal()     # lecture, pause, saut, recalage sur la musique (pour l'envoi live)

    def __init__(self, editor):
        super().__init__()
        self.editor = editor
        self.player = QMediaPlayer(self)
        self.audio = QAudioOutput(self)
        self.audio.setVolume(1.0)
        self.player.setAudioOutput(self.audio)
        self.clock = QElapsedTimer()
        self.anchor = 0.0
        self.timer = QTimer(self)
        self.timer.timeout.connect(self._tick)
        self.has_audio = False

    def load_audio(self, path):
        self.stop_audio()
        self.has_audio = bool(path)
        self.player.setSource(QUrl.fromLocalFile(path) if path else QUrl())

    def stop_audio(self):
        self.player.stop()

    @property
    def playing(self):
        return self.editor.playing

    def toggle(self):
        self.pause() if self.playing else self.play()

    def transport(self):
        """(lecture en cours, position (s), heure time.perf_counter de cette position)."""
        if not self.playing:
            return False, self.editor.playhead, time.perf_counter()
        return True, self.anchor + self.clock.nsecsElapsed() / 1e9, time.perf_counter()

    def play(self):
        if self.playing:
            return
        tl = self.editor.doc.timeline
        if tl.loop_on and not (tl.loop_start <= self.editor.playhead < tl.loop_end):
            self.editor.set_playhead(tl.loop_start)
        self.editor.playing = True
        self._anchor_at(self.editor.playhead)
        self.timer.start(TICK_MS)
        self.editor.notify()
        self.playingChanged.emit(True)
        self.transportChanged.emit()

    def pause(self):
        if not self.playing:
            return
        self.editor.playing = False
        self.timer.stop()
        self.player.pause()
        self.editor.notify()
        self.playingChanged.emit(False)
        self.transportChanged.emit()

    def stop(self):
        self.pause()
        tl = self.editor.doc.timeline
        self.editor.set_playhead(tl.loop_start if tl.loop_on else 0.0)

    def seek(self, t):
        self.editor.set_playhead(t)
        if self.playing:
            self._anchor_at(t)

    def _anchor_at(self, t):
        self.anchor = t
        self.clock.restart()
        self.transportChanged.emit()
        if self.has_audio:
            self.player.setPosition(int(t * 1000))
            if self.player.playbackState() != QMediaPlayer.PlaybackState.PlayingState:
                self.player.play()

    def _tick(self):
        tl = self.editor.doc.timeline
        t = self.anchor + self.clock.elapsed() / 1000.0
        if self.has_audio and self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            audio_t = self.player.position() / 1000.0
            if abs(audio_t - t) > RESYNC_S and audio_t > 0:
                self.anchor = audio_t
                self.clock.restart()
                t = audio_t
                self.transportChanged.emit()
        if tl.loop_on and tl.loop_end > tl.loop_start and t >= tl.loop_end:
            t = tl.loop_start
            self._anchor_at(t)
        elif t >= tl.length():
            self.editor.set_playhead(tl.length())
            self.pause()
            return
        self.editor.set_playhead(t)
