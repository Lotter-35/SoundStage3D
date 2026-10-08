"""Décodage de la musique en forme d'onde (crêtes min / max) pour l'affichage dans la timeline."""

import numpy as np
from PySide6.QtCore import QObject, QUrl, Signal
from PySide6.QtMultimedia import QAudioDecoder, QAudioFormat

RATE = 8000           # échantillons / s demandés au décodeur (mono)
PEAKS_PER_S = 200     # résolution de la forme d'onde stockée


class WaveformLoader(QObject):
    loaded = Signal(object, float)    # crêtes (N, 2) min / max, durée en secondes
    failed = Signal(str)

    def __init__(self):
        super().__init__()
        self.decoder = QAudioDecoder(self)
        fmt = QAudioFormat()
        fmt.setSampleRate(RATE)
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Float)
        self.decoder.setAudioFormat(fmt)
        self.decoder.bufferReady.connect(self._buffer)
        self.decoder.finished.connect(self._finished)
        self.decoder.error.connect(self._error)
        self.chunks = []

    def load(self, path):
        self.decoder.stop()
        self.chunks = []
        self.decoder.setSource(QUrl.fromLocalFile(path))
        self.decoder.start()

    def _buffer(self):
        buf = self.decoder.read()
        if not buf.isValid():
            return
        data = bytes(buf.constData())
        if buf.format().sampleFormat() == QAudioFormat.SampleFormat.Float:
            a = np.frombuffer(data, dtype=np.float32)
        else:
            a = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        ch = max(1, buf.format().channelCount())
        if ch > 1:
            a = a[: len(a) // ch * ch].reshape(-1, ch).mean(axis=1)
        self.chunks.append(a)

    def _finished(self):
        if not self.chunks:
            self.failed.emit("Aucun son décodé")
            return
        a = np.concatenate(self.chunks)
        self.chunks = []
        duration = len(a) / RATE
        step = RATE // PEAKS_PER_S
        n = len(a) // step
        if n == 0:
            self.failed.emit("Fichier trop court")
            return
        blk = a[: n * step].reshape(n, step)
        peaks = np.column_stack((blk.min(axis=1), blk.max(axis=1)))
        m = float(np.abs(peaks).max()) or 1.0
        self.loaded.emit(peaks / m, duration)

    def _error(self, _err):
        self.failed.emit(self.decoder.errorString() or "Impossible de lire ce fichier audio")
