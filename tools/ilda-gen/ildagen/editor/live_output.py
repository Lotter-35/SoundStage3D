"""Sortie live vers le serveur SoundStage3D (IDN / UDP) : côté interface.

Le calcul et l'envoi des images se font dans un fil dédié (live_worker.py) : une interface lente ne fait plus
saccader le laser, et une image lourde ne bloque plus l'interface. L'interface publie des instantanés figés
(document copié quand son contenu change, ce qu'il faut montrer, état de la lecture, réglages).

Hors live : rien n'est calculé en continu. L'aperçu de la mire (points laser, compteur) est recalculé dans
le fil seulement quand l'affichage change (au plus APERCU_HZ fois par seconde).
Reste ici : le ping de connexion (bouton d'état) et une horloge d'affichage qui fait vivre les animations
de la mire (sans aucun calcul laser).
"""

import time

from PySide6.QtCore import QObject, Qt, QTimer, Signal
from PySide6.QtNetwork import QHostAddress, QUdpSocket

from ..laser.idn import IdnPacketBuilder, is_ping_response
from ..laser.pipeline import SettingsCopy
from . import live_snapshot
from .live_worker import FrameInfo, OutputWorker

PING_INTERVAL_MS = 1000
PING_TIMEOUT_S = 2.5
PREVIEW_HZ = 10


class LiveOutput(QObject):
    connectionChanged = Signal(bool)
    statsChanged = Signal(object)          # FrameInfo : points (envoyés ou en aperçu), image réduite, coupée
    liveChanged = Signal(bool)
    blackoutChanged = Signal(bool)
    frameComputed = Signal()
    _frameReady = Signal(object)           # fil d'envoi → interface (toujours en file d'attente Qt)

    def __init__(self, editor, playback=None):
        super().__init__()
        self.editor = editor
        self.settings = editor.settings
        self.playback = None
        self.builder = IdnPacketBuilder()
        self.sock = QUdpSocket(self)
        self.sock.bind(QHostAddress(QHostAddress.SpecialAddress.AnyIPv4), 0)
        self.sock.readyRead.connect(self._read)
        self.live = False
        self.blackout = False
        self.connected = False
        self.stats = FrameInfo()
        self.last_points = None            # (points, couleurs) normalisés de la dernière image (aperçu mire)
        self._last_pong = 0.0
        self._doc_rev = None
        self._doc_copy = None
        self._last_copy = 0.0
        self._last_preview = 0.0
        self._frameReady.connect(self._on_worker_frame, Qt.ConnectionType.QueuedConnection)
        self.worker = OutputWorker(self._frameReady.emit)
        self.worker.start()
        self._pub_timer = QTimer(self)
        self._pub_timer.setSingleShot(True)
        self._pub_timer.timeout.connect(self._publish)
        self._preview_timer = QTimer(self)
        self._preview_timer.setSingleShot(True)
        self._preview_timer.timeout.connect(self._send_preview)
        self.display_timer = QTimer(self)
        self.display_timer.timeout.connect(self._display_tick)
        self.ping_timer = QTimer(self)
        self.ping_timer.timeout.connect(self.ping)
        self.ping_timer.start(PING_INTERVAL_MS)
        editor.docChanged.connect(self._changed)
        if playback is not None:
            self.attach_playback(playback)
        self.apply_fps()
        self.ping()

    def attach_playback(self, playback):
        self.playback = playback
        playback.transportChanged.connect(self._changed)

    # ── Réglages ─────────────────────────────────────────────────────────
    def net(self, key):
        return self.settings.get("network", key)

    def fps(self):
        return max(1, min(120, int(self.net("fps"))))

    def apply_fps(self):
        """Cadence ou réglages réseau / sortie changés : horloge d'affichage et nouvel instantané."""
        self.display_timer.start(int(1000 / self.fps()))
        self._changed()

    def target(self):
        return QHostAddress(str(self.net("host")).strip() or "127.0.0.1"), int(self.net("port"))

    # ── Commandes ────────────────────────────────────────────────────────
    def set_live(self, on):
        on = bool(on) and not self.blackout
        if on != self.live:
            self.live = on
            if on:
                self._doc_copy = None      # copie fraîche tout de suite (pas celle d'un live précédent)
                self._publish()
            self.worker.set_live(on)
            if not on:
                self._changed()            # retour à l'aperçu de la mire
            self.liveChanged.emit(on)

    def set_blackout(self, on):
        self.blackout = bool(on)
        if self.blackout:
            # Image éteinte envoyée tout de suite d'ici, sans attendre le fil d'envoi
            self._send_now(self.builder.blank_packets(int(self.net("channel")), self._kpps()))
            if self.live:
                self.live = False
                self.worker.set_live(False)
                self.liveChanged.emit(False)
        self.worker.set_blackout(self.blackout)
        self.blackoutChanged.emit(self.blackout)

    def shutdown(self):
        """Fermeture : images éteintes + fermeture IDN si le live était actif, puis arrêt du fil."""
        self._pub_timer.stop()
        self._preview_timer.stop()
        self.display_timer.stop()
        self.ping_timer.stop()
        self.worker.stop()

    # ── Instantanés ──────────────────────────────────────────────────────
    def _changed(self, *_):
        if self.live:
            if not self._pub_timer.isActive():
                self._pub_timer.start(0)   # plusieurs changements d'affilée : un seul instantané
        else:
            self._want_preview()

    def _publish(self):
        if not self.live:
            return
        ed = self.editor
        rev = ed.content_rev
        if rev != self._doc_rev or self._doc_copy is None:
            # Copie du document seulement quand son contenu a changé (pas à chaque mouvement de la tête),
            # et au plus une par image : un glisser rapide sur un gros projet ne ralentit pas l'interface
            wait = 1.0 / self.fps() - (time.perf_counter() - self._last_copy)
            if wait > 0 and self._doc_copy is not None:
                self._pub_timer.start(int(wait * 1000) + 1)
                return
            self._doc_copy = live_snapshot.copy_document(ed.doc)
            self._doc_rev = rev
            self._last_copy = time.perf_counter()
        self.worker.publish(live_snapshot.take(ed, self.playback, self._doc_copy, self._doc_rev,
                                               SettingsCopy(self.settings), self.fps()))

    def _want_preview(self):
        if self._preview_timer.isActive():
            return
        wait = 1.0 / PREVIEW_HZ - (time.perf_counter() - self._last_preview)
        self._preview_timer.start(max(0, int(wait * 1000)))

    def _send_preview(self):
        if self.live:
            return
        self._last_preview = time.perf_counter()
        # Copies : un tracé sans transformation partage ses points avec le document, que l'interface modifie
        strokes = [s.copy() for s in self.editor.display_strokes()]
        self.worker.request_preview(strokes, SettingsCopy(self.settings), self.fps())

    def _display_tick(self):
        """Fait vivre les animations de la mire (forme animée hors lecture) ; aucun calcul laser ici."""
        ed = self.editor
        if ed.is_animated() and not ed.playing:
            self.frameComputed.emit()
            if not self.live:
                self._want_preview()

    def _on_worker_frame(self, info):
        if info.sent != self.live:
            return                         # image d'un état précédent (live coupé entre-temps)
        self.last_points = (info.pts, info.col)
        if info.key() != self.stats.key():
            self.stats = info
            self.statsChanged.emit(info)
        self.stats = info
        self.frameComputed.emit()

    # ── Réseau (interface) ───────────────────────────────────────────────
    def _kpps(self):
        return float(self.settings.get("laser", "scan_kpps")) * 1000.0

    def _send_now(self, packets):
        host, port = self.target()
        for p in packets:
            self.sock.writeDatagram(p, host, port)

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
