"""OscEditor : réglages d'un oscillateur (onde ou vitesse, cadence calée sur le tempo ou libre).

Commun aux espaces Forme (oscillateur d'un réglage de calque) et Show (réglage d'effet en mode « Oscillateur »).
Le widget ne touche pas au document : il émet l'oscillateur modifié, l'appelant l'enregistre.

Signaux :
- editStarted() / editFinished() : encadrent un geste (glisser un slider, ou un clic sur un choix) — l'appelant
  ouvre et ferme son étape d'annulation ;
- oscChanged(object) : nouvel oscillateur (copie) pendant le geste ;
- removeRequested() : « Retirer l'oscillateur ».
"""

from PySide6.QtCore import QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QComboBox, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

from ...core.oscillator import DIVISIONS, MAX_HZ, MODES, WAVES, Osc, division_labels, wave_value
from .. import theme
from .segmented import Segmented
from .slider_field import SliderField
from .switch import Switch

WAVE_SHORT = {"sine": "Sinus", "triangle": "Triangle", "square": "Carré", "saw": "Scie", "random": "Aléatoire"}


class OscPreview(QWidget):
    """Deux cycles de l'onde (ou la rampe de la vitesse), pour voir d'un coup d'œil ce que fait l'oscillateur."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.osc = Osc()
        self.setFixedHeight(40)

    def set_osc(self, osc):
        self.osc = osc
        self.update()

    def sizeHint(self):
        return QSize(200, 40)

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(0.5, 0.5, self.width() - 1, self.height() - 1)
        p.setPen(QPen(theme.qc(theme.BORDER), 1))
        p.setBrush(theme.qc(theme.BG_FIELD))
        p.drawRoundedRect(r, theme.RADIUS, theme.RADIUS)
        a = r.adjusted(4, 5, -4, -5)
        p.setPen(QPen(theme.qc(theme.TEXT_OFF), 1, Qt.PenStyle.DotLine))
        p.drawLine(QPointF(a.left(), a.center().y()), QPointF(a.right(), a.center().y()))
        path = QPainterPath()
        n = max(2, int(a.width()))
        for i in range(n + 1):
            x = i / n
            if self.osc.mode == "vitesse":
                y = ((x * 2.0) % 1.0) * 2.0 - 1.0 if self.osc.speed >= 0 else 1.0 - ((x * 2.0) % 1.0) * 2.0
            else:
                y = wave_value(self.osc.wave, x * 2.0 + self.osc.phase)
            pt = QPointF(a.left() + x * a.width(), a.center().y() - y * a.height() / 2)
            path.moveTo(pt) if i == 0 else path.lineTo(pt)
        p.setPen(QPen(theme.qc(theme.ACCENT), 1.4))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawPath(path)


class OscEditor(QWidget):
    editStarted = Signal()
    editFinished = Signal()
    oscChanged = Signal(object)
    removeRequested = Signal()

    def __init__(self, parent=None, removable=True):
        super().__init__(parent)
        self.osc = Osc()
        self.spec = None
        self._updating = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)

        self.mode = Segmented([label for _, label in MODES], 0, expand=True)
        self.mode.set_tooltips(["Onde : la valeur oscille autour de la valeur réglée",
                                "Vitesse : la valeur avance sans fin (rotation continue, défilement)"])
        self.mode.currentChanged.connect(lambda i: self._discrete(mode=MODES[i][0]))
        lay.addWidget(self.mode)

        self.wave = Segmented([WAVE_SHORT[w] for w, _ in WAVES], 0, expand=True)
        self.wave.set_tooltips([label for _, label in WAVES])
        self.wave.currentChanged.connect(lambda i: self._discrete(wave=WAVES[i][0]))
        lay.addWidget(self.wave)

        self.preview = OscPreview()
        lay.addWidget(self.preview)

        self.depth = SliderField("Amplitude", 1.0, 0.0, None, 0.0, 1.0, label_width=96)
        self.depth.setToolTip("Écart maximal autour de la valeur réglée")
        self.speed = SliderField("Vitesse", 1.0, None, None, -1.0, 1.0, label_width=96)
        self.phase = SliderField("Décalage", 0.0, 0.0, 100.0, decimals=0, unit=" %", default=0.0, label_width=96)
        self.phase.setToolTip("Décale le départ de l'onde dans son cycle")
        for f, key in ((self.depth, "depth"), (self.speed, "speed"), (self.phase, "phase")):
            self._wire(f, key)
            lay.addWidget(f)

        row = QHBoxLayout()
        row.setContentsMargins(0, 2, 0, 2)
        lab = QLabel("Synchro tempo")
        lab.setObjectName("dim")
        lab.setFixedWidth(96)
        row.addWidget(lab)
        self.sync = Switch(True)
        self.sync.setToolTip("Oui : la cadence suit le tempo du projet ; Non : fréquence libre en Hz")
        self.sync.clicked.connect(lambda on: self._discrete(sync=bool(on)))
        row.addWidget(self.sync)
        row.addStretch(1)
        lay.addLayout(row)

        row = QHBoxLayout()
        row.setContentsMargins(0, 0, 0, 0)
        self.div_label = QLabel("Un cycle")
        self.div_label.setObjectName("dim")
        self.div_label.setFixedWidth(96)
        row.addWidget(self.div_label)
        self.division = QComboBox()
        self.division.addItems(division_labels())
        self.division.activated.connect(lambda i: self._discrete(division=int(i)))
        row.addWidget(self.division, 1)
        lay.addLayout(row)
        self.hz = SliderField("Fréquence", 1.0, 0.001, MAX_HZ, 0.05, 4.0, decimals=2, unit=" Hz", label_width=96)
        self._wire(self.hz, "hz")
        lay.addWidget(self.hz)

        self.remove = QPushButton("Retirer l'oscillateur")
        self.remove.setVisible(removable)
        self.remove.clicked.connect(self.removeRequested)
        lay.addWidget(self.remove)

    # ── Liaison des champs ───────────────────────────────────────────────
    def _wire(self, field, key):
        field.editStarted.connect(self.editStarted)
        field.valueChanged.connect(lambda v, k=key: self._field(k, v))
        field.editFinished.connect(lambda _v: self.editFinished.emit())
        field.editCancelled.connect(lambda v, k=key: (self._field(k, v), self.editFinished.emit()))

    def _field(self, key, v):
        if self._updating:
            return
        o = self.osc.copy()
        if key == "phase":
            v = v / 100.0
        setattr(o, key, v)
        self._apply(o)

    def _discrete(self, **changes):
        if self._updating:
            return
        o = self.osc.copy()
        for k, v in changes.items():
            setattr(o, k, v)
        self.editStarted.emit()
        self._apply(o)
        self.editFinished.emit()

    def _apply(self, o):
        self.osc = Osc.from_dict(o.to_dict())
        self._refresh()
        self.oscChanged.emit(self.osc.copy())

    # ── Affichage ────────────────────────────────────────────────────────
    def set_osc(self, osc, spec=None, beats_per_bar=4):
        """Montre un oscillateur (sans signal). spec : ParamSpec du réglage (unités, plages confortables)."""
        self.osc = (osc or Osc()).copy()
        self.spec = spec
        unit = (spec.unit if spec is not None else "") or ""
        unit = f" {unit}" if unit and not unit.startswith(" ") else unit
        lo = spec.soft_min if spec is not None and spec.soft_min is not None else -1.0
        hi = spec.soft_max if spec is not None and spec.soft_max is not None else 1.0
        span = max(1e-6, float(hi) - float(lo))
        dec = spec.decimals if spec is not None else 2
        self.depth.set_unit(unit)
        self.depth.set_range(0.0, None, 0.0, span / 2.0)
        self.depth.decimals = dec
        self.speed.set_range(None, None, -span, span)
        self.speed.decimals = dec
        self.division.blockSignals(True)
        self.division.clear()
        self.division.addItems(division_labels(beats_per_bar))
        self.division.blockSignals(False)
        self._refresh()

    def _refresh(self):
        o = self.osc
        self._updating = True
        self.mode.set_current(0 if o.mode == "onde" else 1)
        self.wave.set_current([w for w, _ in WAVES].index(o.wave))
        self.depth.set_value(o.depth)
        self.speed.set_value(o.speed)
        unit = self.depth.unit
        self.speed.set_unit(f"{unit}/temps" if o.sync else f"{unit}/s")
        self.phase.set_value(o.phase * 100.0)
        self.sync.set_value(o.sync)
        self.division.setCurrentIndex(max(0, min(len(DIVISIONS) - 1, o.division)))
        self.hz.set_value(o.hz)
        wave = o.mode == "onde"
        for w in (self.wave, self.depth, self.phase):
            w.setVisible(wave)
        self.speed.setVisible(not wave)
        # Cadence : utile pour l'onde (durée d'un cycle) ; pour la vitesse, seule l'unité change (par temps / par s)
        self.div_label.setVisible(wave and o.sync)
        self.division.setVisible(wave and o.sync)
        self.hz.setVisible(wave and not o.sync)
        self.preview.set_osc(o)
        self._updating = False


def osc_summary(osc, spec=None, beats_per_bar=4):
    """Texte court : « ~ Sinus · 1 temps » ou « ~ 45 °/s »."""
    if osc is None:
        return ""
    unit = (spec.unit.strip() if spec is not None and spec.unit else "")
    if osc.mode == "vitesse":
        per = "temps" if osc.sync else "s"
        v = osc.speed
        txt = f"{v:.0f}" if abs(v) >= 10 or float(v).is_integer() else f"{v:.2f}".rstrip("0").rstrip(",.")
        return f"~ {txt.replace('.', ',')} {unit}/{per}".replace("  ", " ")
    cad = division_labels(beats_per_bar)[osc.division] if osc.sync else f"{osc.hz:g} Hz".replace(".", ",")
    return f"~ {WAVE_SHORT.get(osc.wave, osc.wave)} · {cad}"


__all__ = ["OscEditor", "OscPreview", "osc_summary"]
