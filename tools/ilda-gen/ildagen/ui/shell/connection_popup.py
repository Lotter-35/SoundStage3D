"""Connexion au serveur SoundStage3D : IP, port, canal, images/s (ouvert depuis l'état de connexion)."""

from PySide6.QtCore import Qt
from PySide6.QtNetwork import QAbstractSocket, QHostAddress, QHostInfo
from PySide6.QtWidgets import QGridLayout, QLabel, QLineEdit, QSpinBox, QWidget

from ..spin import SpinBox
from .popup import Popup


def _label(text):
    lab = QLabel(text)
    lab.setObjectName("dim")
    return lab


def _spin(lo, hi, value, suffix=""):
    s = SpinBox()
    s.setRange(lo, hi)
    s.setValue(int(value))
    s.setSuffix(suffix)
    s.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
    s.setAlignment(Qt.AlignmentFlag.AlignRight)
    return s


class ConnectionPopup(Popup):
    def __init__(self, settings, live, parent=None):
        super().__init__("Connexion", parent)
        self.settings = settings
        self.live = live
        self.setFixedWidth(300)
        box = QWidget()
        g = QGridLayout(box)
        g.setContentsMargins(12, 2, 12, 2)
        g.setHorizontalSpacing(10)
        g.setVerticalSpacing(6)
        self.host = QLineEdit(str(settings.get("network", "host")))
        self.host.setToolTip("Adresse du serveur SoundStage3D")
        self.port = _spin(1, 65535, settings.get("network", "port"))
        self.channel = _spin(1, 16, settings.get("network", "channel"))
        self.channel.setToolTip("Canal « ILDA live » du laser dans SoundStage3D (1 à 16)")
        self.fps = _spin(1, 120, settings.get("network", "fps"), " images/s")
        self.fps.setToolTip("Nombre d'images envoyées par seconde")
        for row, (text, w) in enumerate((("Adresse IP", self.host), ("Port", self.port), ("Canal", self.channel),
                                         ("Cadence", self.fps))):
            g.addWidget(_label(text), row, 0)
            g.addWidget(w, row, 1)
        self.body.addWidget(box)
        self.state = _label("")
        self.state.setContentsMargins(12, 6, 12, 0)
        self.body.addWidget(self.state)
        for w in (self.port, self.channel, self.fps):
            w.valueChanged.connect(self._apply)       # aussi à la molette (le réglage suit le champ)
        self.host.editingFinished.connect(self._apply)
        live.connectionChanged.connect(self._connection)
        self._connection(live.connected)

    def _host(self):
        """Adresse tapée : une IP valide est gardée telle quelle ; un nom d'hôte est résolu (DNS) en IP ; sinon
        None (message d'erreur, l'ancienne adresse reste)."""
        text = self.host.text().strip() or "127.0.0.1"
        addr = QHostAddress()
        if addr.setAddress(text):
            return text
        looks_ip = all(c.isdigit() or c == "." for c in text)
        if not looks_ip:
            info = QHostInfo.fromName(text)
            ips = [a for a in info.addresses() if a.protocol() == QAbstractSocket.NetworkLayerProtocol.IPv4Protocol]
            if info.error() == QHostInfo.HostInfoError.NoError and ips:
                self.state.setText(f"{text} → {ips[0].toString()}")
                return ips[0].toString()
        self.state.setText(f"Adresse invalide ou introuvable : « {text} »")
        self.state.setObjectName("warning")
        self.state.style().unpolish(self.state)
        self.state.style().polish(self.state)
        self.host.setText(str(self.settings.get("network", "host")))
        return None

    def _apply(self, *_):
        s = self.settings
        host = self._host() if self.sender() is self.host else str(s.get("network", "host"))
        if host is None:
            return
        if self.state.objectName() == "warning" and self.sender() is self.host:
            self.state.setObjectName("dim")
            self.state.style().unpolish(self.state)
            self.state.style().polish(self.state)
        s.set("network", "host", host)
        s.set("network", "port", self.port.value())
        s.set("network", "channel", self.channel.value())
        s.set("network", "fps", self.fps.value())
        s.save()
        self.live.apply_fps()
        self.live.ping()

    def reload(self):
        s = self.settings
        for w, key in ((self.port, "port"), (self.channel, "channel"), (self.fps, "fps")):
            w.blockSignals(True)
            w.setValue(int(s.get("network", key)))
            w.blockSignals(False)
        self.host.setText(str(s.get("network", "host")))
        self.live.apply_fps()

    def _connection(self, ok):
        self.state.setText("Serveur connecté" if ok else "Pas de réponse du serveur")
