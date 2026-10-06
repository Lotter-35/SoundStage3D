"""Barre de connexion : IP, port, canal, images / s, état, envoi live, blackout."""

from PySide6.QtCore import QSize, Qt
from PySide6.QtGui import QPainter
from PySide6.QtWidgets import QHBoxLayout, QLabel, QLineEdit, QPushButton, QSpinBox, QWidget

from . import icons, theme


class StatusDot(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.on = False
        self.setFixedSize(QSize(10, 10))

    def set_on(self, on):
        self.on = on
        self.update()

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(theme.qc(theme.SUCCESS if self.on else theme.TEXT_OFF))
        p.drawEllipse(1, 1, 8, 8)


def labeled(text):
    lab = QLabel(text)
    lab.setObjectName("dim")
    return lab


def spin(lo, hi, value, width, suffix=""):
    s = QSpinBox()
    s.setRange(lo, hi)
    s.setValue(int(value))
    s.setFixedWidth(width)
    s.setSuffix(suffix)
    s.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
    s.setAlignment(Qt.AlignmentFlag.AlignRight)
    return s


class ConnectionBar(QWidget):
    def __init__(self, editor, live, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.live = live
        self.settings = editor.settings
        self.setObjectName("bar")
        self.setFixedHeight(38)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(10, 4, 10, 4)
        lay.setSpacing(6)

        lay.addWidget(labeled("IP"))
        self.host = QLineEdit(str(self.settings.get("network", "host")))
        self.host.setFixedWidth(120)
        self.host.setToolTip("Adresse du serveur SoundStage3D (DAC)")
        self.host.editingFinished.connect(self._apply)
        lay.addWidget(self.host)
        lay.addWidget(labeled("Port"))
        self.port = spin(1, 65535, self.settings.get("network", "port"), 64)
        self.port.editingFinished.connect(self._apply)
        lay.addWidget(self.port)
        lay.addWidget(labeled("Canal"))
        self.channel = spin(1, 16, self.settings.get("network", "channel"), 40)
        self.channel.setToolTip("Canal « ILDA live » du laser dans SoundStage3D (1 à 16)")
        self.channel.editingFinished.connect(self._apply)
        lay.addWidget(self.channel)
        lay.addWidget(labeled("Images/s"))
        self.fps = spin(1, 120, self.settings.get("network", "fps"), 44)
        self.fps.setToolTip("Nombre d'images envoyées par seconde")
        self.fps.editingFinished.connect(self._apply)
        lay.addWidget(self.fps)

        lay.addSpacing(10)
        self.dot = StatusDot()
        lay.addWidget(self.dot)
        self.state = labeled("Non connecté")
        lay.addWidget(self.state)
        lay.addStretch(1)

        self.btn_live = QPushButton(" Envoi live")
        self.btn_live.setObjectName("live")
        self.btn_live.setIcon(icons.icon("radio", 14, color=theme.TEXT, active_color="#ffffff"))
        self.btn_live.setCheckable(True)
        self.btn_live.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.btn_live.setToolTip("Envoyer en direct au laser ce qui est affiché dans la mire")
        self.btn_live.toggled.connect(live.set_live)
        lay.addWidget(self.btn_live)

        self.btn_black = QPushButton(" BLACKOUT")
        self.btn_black.setObjectName("danger")
        self.btn_black.setIcon(icons.icon("octagon-x", 14, color=theme.DANGER, active_color="#ffffff"))
        self.btn_black.setCheckable(True)
        self.btn_black.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.btn_black.setToolTip("Arrêt d'urgence : coupe immédiatement la sortie laser (cliquer à nouveau pour réarmer)")
        self.btn_black.toggled.connect(live.set_blackout)
        lay.addWidget(self.btn_black)

        live.connectionChanged.connect(self._connection)
        live.liveChanged.connect(self._live_changed)
        live.blackoutChanged.connect(self._blackout_changed)
        self._connection(live.connected)

    def _apply(self):
        s = self.settings
        s.set("network", "host", self.host.text().strip() or "127.0.0.1")
        s.set("network", "port", self.port.value())
        s.set("network", "channel", self.channel.value())
        s.set("network", "fps", self.fps.value())
        s.save()
        self.live.apply_fps()
        self.live.ping()

    def reload(self):
        s = self.settings
        self.host.setText(str(s.get("network", "host")))
        self.port.setValue(int(s.get("network", "port")))
        self.channel.setValue(int(s.get("network", "channel")))
        self.fps.setValue(int(s.get("network", "fps")))
        self.live.apply_fps()

    def _connection(self, ok):
        self.dot.set_on(ok)
        self.state.setText("Connecté" if ok else "Non connecté")

    def _live_changed(self, on):
        self.btn_live.blockSignals(True)
        self.btn_live.setChecked(on)
        self.btn_live.blockSignals(False)

    def _blackout_changed(self, on):
        self.btn_black.blockSignals(True)
        self.btn_black.setChecked(on)
        self.btn_black.blockSignals(False)
        self.btn_live.setEnabled(not on)
