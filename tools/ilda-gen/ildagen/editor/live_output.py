"""Sortie live vers le serveur SoundStage3D (IDN / UDP) : images à cadence fixe, ping de connexion, blackout."""

import time

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtNetwork import QHostAddress, QUdpSocket

from ..laser.idn import IdnPacketBuilder, is_ping_response
from ..laser.optimizer import build_points
from ..laser.output import apply_output

PING_INTERVAL_MS = 1000
PING_TIMEOUT_S = 2.5


class LiveOutput(QObject):
    connectionChanged = Signal(bool)
    statsChanged = Signal(int, float)      # nombre de points, images / seconde que le laser peut tenir
    liveChanged = Signal(bool)
    blackoutChanged = Signal(bool)
    frameComputed = Signal()

    def __init__(self, editor):
        super().__init__()
        self.editor = editor
        self.settings = editor.settings
        self.builder = IdnPacketBuilder()
        self.sock = QUdpSocket(self)
        self.sock.bind(QHostAddress(QHostAddress.SpecialAddress.AnyIPv4), 0)
        self.sock.readyRead.connect(self._read)
        self.live = False
        self.blackout = False
        self.connected = False
        self._last_pong = 0.0
        self._last_key = None
        self.last_points = None            # (points, couleurs) normalisés de la dernière image
        self.frame_timer = QTimer(self)
        self.frame_timer.timeout.connect(self.tick)
        self.ping_timer = QTimer(self)
        self.ping_timer.timeout.connect(self.ping)
        self.ping_timer.start(PING_INTERVAL_MS)
        self.apply_fps()
        self.ping()

    # ── Réglages ─────────────────────────────────────────────────────────
    def net(self, key):
        return self.settings.get("network", key)

    def apply_fps(self):
        fps = max(1, min(120, int(self.net("fps"))))
        self.frame_timer.start(int(1000 / fps))

    def target(self):
        return QHostAddress(str(self.net("host")).strip() or "127.0.0.1"), int(self.net("port"))

    # ── Commandes ────────────────────────────────────────────────────────
    def set_live(self, on):
        on = bool(on) and not self.blackout
        if on != self.live:
            self.live = on
            if not on:
                self._send_blank()
            self.liveChanged.emit(on)

    def set_blackout(self, on):
        self.blackout = bool(on)
        if self.blackout:
            if self.live:
                self.live = False
                self.liveChanged.emit(False)
            for _ in range(3):
                self._send_blank()
        self.blackoutChanged.emit(self.blackout)

    def shutdown(self):
        if self.live:
            self._send_blank()

    # ── Images ───────────────────────────────────────────────────────────
    def compute(self):
        strokes = self.editor.display_strokes()
        key = (id(strokes), id(self.settings.section("laser")), tuple(sorted(self.settings.section("laser").items())))
        if key != self._last_key or self.last_points is None:
            self.last_points = build_points(strokes, self.settings.section("laser"))
            self._last_key = key
            n = len(self.last_points[0])
            kpps = float(self.settings.get("laser", "kpps"))
            self.statsChanged.emit(n, kpps / max(1, n))
            self.frameComputed.emit()
        return self.last_points

    def tick(self):
        pts, col = self.compute()
        if not self.live or self.blackout:
            return
        if len(pts) == 0:
            self._send_blank()
            return
        x, y, r, g, b = apply_output(pts, col, self.settings)
        self._send(self.builder.frame_packets(x, y, r, g, b, int(self.net("channel")),
                                              float(self.settings.get("laser", "kpps"))))

    def _send_blank(self):
        self._send(self.builder.blank_packets(int(self.net("channel")), float(self.settings.get("laser", "kpps"))))

    def _send(self, packets):
        host, port = self.target()
        for p in packets:
            self.sock.writeDatagram(p, host, port)

    # ── Connexion ────────────────────────────────────────────────────────
    def ping(self):
        _, pkt = self.builder.ping_packet()
        host, port = self.target()
        self.sock.writeDatagram(pkt, host, port)
        ok = time.monotonic() - self._last_pong < PING_TIMEOUT_S
        if ok != self.connected:
            self.connected = ok
            self.connectionChanged.emit(ok)

    def _read(self):
        while self.sock.hasPendingDatagrams():
            dg = self.sock.receiveDatagram()
            if is_ping_response(bytes(dg.data())):
                self._last_pong = time.monotonic()
                if not self.connected:
                    self.connected = True
                    self.connectionChanged.emit(True)
