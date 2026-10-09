"""Barre de boucle sous la mire (espace Forme).

[Boucle ⏸] [0,5× | 1× | 2×]  Tempo 128 BPM ………………  684 points ▬▬▬▬░░░  30 images/s

- Boucle : met en pause / relance les oscillateurs de la forme (l'aperçu ET le laser) ;
- 0,5× / 1× / 2× : vitesse de l'aperçu seulement (mire et vignettes), pas du laser ;
- Tempo : celui du projet (le même que la timeline), utilisé par les oscillateurs calés sur le tempo ;
- points : points de l'image laser (envoyée, ou calculée pour l'aperçu quand le live est coupé) par rapport
  au budget de points par image : vert, orange près du budget, rouge si l'image a dû être allégée.
"""

from PySide6.QtCore import QRectF, QSize, Qt
from PySide6.QtGui import QDoubleValidator, QPainter
from PySide6.QtWidgets import QHBoxLayout, QLabel, QLineEdit, QPushButton, QWidget

from .. import icons, theme
from ..widgets import Segmented
from ..widgets.numbers import fmt_number, parse_number

SPEEDS = (0.5, 1.0, 2.0)
BPM_RANGE = (20.0, 400.0)


class PreviewClock:
    """Temps de boucle de l'aperçu : celui de la forme, accéléré ou ralenti localement, sans saut."""

    def __init__(self, editor):
        self.editor = editor
        self.k = 1.0
        self.base = 0.0
        self.anchor = None

    def time(self):
        t = self.editor.loop_time()
        if self.anchor is None:
            return t
        if t < self.anchor:                 # boucle relancée (nouveau projet…) : on repart de là
            self.anchor, self.base = t, t
        return self.base + (t - self.anchor) * self.k

    def set_speed(self, k):
        cur = self.time()
        self.anchor = self.editor.loop_time()
        self.base = cur
        self.k = float(k)


class PointBar(QWidget):
    """Petite barre de remplissage du budget de points."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.ratio = 0.0
        self.color = "LIVE"
        self.setFixedSize(QSize(110, 5))

    def set_state(self, ratio, color):
        self.ratio, self.color = max(0.0, min(1.0, ratio)), color
        self.update()

    def paintEvent(self, _e):
        p = QPainter(self)
        r = QRectF(self.rect())
        p.fillRect(r, theme.qc(theme.BG_FIELD))
        p.fillRect(QRectF(0, 0, r.width() * self.ratio, r.height()), theme.qc(getattr(theme, self.color)))
        p.end()


def meter_state(stats):
    """(texte, remplissage 0..1, jeton de couleur) d'après les points de la dernière image."""
    n = stats.count if stats is not None else 0
    budget = getattr(stats, "budget", 0) or 0
    ratio = n / budget if budget else 0.0
    if stats is not None and (stats.reduced or stats.static):
        color = "DANGER"
    elif ratio >= 0.8:
        color = "WARNING"
    else:
        color = "LIVE"
    text = f"{fmt_number(n)} point{'s' if n > 1 else ''}".replace(",", " ")
    if stats is not None and stats.reduced:
        text += " · allégée"
    if stats is not None and stats.static:
        text += " · point fixe coupé"
    return text, ratio, color


class LoopBar(QWidget):
    def __init__(self, editor, live, clock, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.live = live
        self.clock = clock
        self.setObjectName("loopBar")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground)
        self.setFixedHeight(34)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(10, 0, 10, 0)
        lay.setSpacing(10)
        self.btn_loop = QPushButton("Boucle")
        self.btn_loop.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.btn_loop.setIconSize(QSize(13, 13))
        self.btn_loop.clicked.connect(lambda: editor.set_loop_paused(not editor.loop_paused()))
        lay.addWidget(self.btn_loop)
        self.speed = Segmented(["0,5×", "1×", "2×"], 1)
        self.speed.set_tooltips(["Aperçu ralenti (le laser garde sa vitesse)", "Aperçu à vitesse normale",
                                 "Aperçu accéléré (le laser garde sa vitesse)"])
        self.speed.currentChanged.connect(lambda i: clock.set_speed(SPEEDS[i]))
        lay.addWidget(self.speed)
        lab = QLabel("Tempo")
        lab.setObjectName("dim")
        lay.addWidget(lab)
        self.bpm = QLineEdit()
        self.bpm.setFont(theme.mono_font(11))
        self.bpm.setFixedWidth(52)
        self.bpm.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.bpm.setValidator(QDoubleValidator(BPM_RANGE[0], BPM_RANGE[1], 2))
        self.bpm.setToolTip("Tempo du projet (le même que la timeline) : cadence des oscillateurs calés sur le tempo")
        self.bpm.editingFinished.connect(self._bpm_typed)
        lay.addWidget(self.bpm)
        unit = QLabel("BPM")
        unit.setFont(theme.mono_font(11))
        lay.addWidget(unit)
        lay.addStretch(1)
        self.points = QLabel("")
        self.points.setObjectName("dim")
        lay.addWidget(self.points)
        self.bar = PointBar()
        lay.addWidget(self.bar)
        self.fps = QLabel("")
        lay.addWidget(self.fps)
        editor.docChanged.connect(self._loop_state)
        editor.timelineChanged.connect(self.refresh)
        editor.projectChanged.connect(self.refresh)
        editor.restored.connect(self.refresh)
        live.statsChanged.connect(self._stats)
        theme.notifier.changed.connect(self._restyle)
        self._restyle()
        self.refresh()

    def _restyle(self, *_):
        # Tempo : texte à chasse fixe sans cadre ; cadre accent pendant la saisie
        self.bpm.setStyleSheet(f"QLineEdit {{ background: transparent; border: 1px solid transparent; "
                               f"padding: 0 2px; color: {theme.TEXT}; }} QLineEdit:hover {{ border-color: "
                               f"{theme.BORDER}; }} QLineEdit:focus {{ background: {theme.BG_FIELD}; "
                               f"border-color: {theme.ACCENT}; }}")

    def refresh(self):
        if not self.bpm.hasFocus():
            self.bpm.setText(fmt_number(self.editor.doc.timeline.bpm, 0 if float(self.editor.doc.timeline.bpm)
                                        .is_integer() else 1))
        self._loop_state()
        self._stats(self.live.stats)

    def _loop_state(self):
        paused = self.editor.loop_paused()
        self.btn_loop.setIcon(icons.icon("play" if paused else "pause", 13))
        self.btn_loop.setToolTip("Relancer la boucle (les oscillateurs repartent)" if paused else
                                 "Mettre la boucle en pause (les oscillateurs s'arrêtent, aperçu et laser)")

    def _bpm_typed(self):
        v = parse_number(self.bpm.text())
        tl = self.editor.doc.timeline
        if v is not None:
            v = max(BPM_RANGE[0], min(BPM_RANGE[1], v))
            if abs(v - tl.bpm) > 1e-9:
                self.editor.timeline_mutate("BPM", lambda: setattr(tl, "bpm", v))
        self.bpm.clearFocus()
        self.refresh()

    def _stats(self, stats):
        text, ratio, color = meter_state(stats)
        self.points.setText(text)
        self.points.setToolTip(f"Points de l'image laser{' envoyée' if getattr(stats, 'sent', False) else ''} "
                               f"(budget : {getattr(stats, 'budget', 0)} points par image)")
        self.bar.set_state(ratio, color)
        self.fps.setText(f"{self.live.fps()} images/s")
