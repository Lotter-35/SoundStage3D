"""Card : carte repliable (modifieur dans Réglages, effet d'animation dans Show).

En-tête de 30 px : [interrupteur] Titre · sous-titre …… [widgets ajoutés] [chevron] ; le corps dessous
(body_layout : y ajouter les SliderField…). Clic sur l'en-tête (hors interrupteur et widgets ajoutés) :
replier / déplier. Interrupteur éteint : titre en gris (le sous-titre peut dire « · désactivé »).

Signaux : toggledOn(bool) = interrupteur actionné par l'utilisateur ; expandedChanged(bool).
set_on(v) / set_expanded(v) : sans signal ; add_header_widget(w) : widget à droite de l'en-tête.
"""

from PySide6.QtCore import QSize, Qt, Signal
from PySide6.QtGui import QPainter
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QSizePolicy, QVBoxLayout, QWidget

from .. import icons, theme
from .switch import Switch

HEADER_H = 30


class _Chevron(QWidget):
    """Chevron peint à la demande (suit le thème)."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.down = True
        self.setFixedSize(QSize(14, 14))
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)

    def paintEvent(self, _e):
        p = QPainter(self)
        name = "chevron-down" if self.down else "chevron-right"
        p.drawPixmap(0, 0, icons.pixmap(name, theme.TEXT_OFF, 14, self.devicePixelRatioF()))
        p.end()


class _Header(QWidget):
    def __init__(self, card):
        super().__init__(card)
        self.card = card
        self.setFixedHeight(HEADER_H)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self.card.collapsible:
            self.card._toggle_expanded()


class Card(QFrame):
    toggledOn = Signal(bool)
    expandedChanged = Signal(bool)

    def __init__(self, title="", subtitle="", switchable=True, on=True, expanded=True, collapsible=True,
                 parent=None):
        super().__init__(parent)
        self.setObjectName("card")
        self.collapsible = collapsible
        self._expanded = expanded
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Maximum)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(1, 1, 1, 1)
        lay.setSpacing(0)

        self.header = _Header(self)
        h = QHBoxLayout(self.header)
        h.setContentsMargins(9, 0, 9, 0)
        h.setSpacing(8)
        self.switch = Switch(on, text=False)
        self.switch.clicked.connect(self._switched)
        self.switch.setVisible(switchable)
        h.addWidget(self.switch)
        self.title = QLabel(title)
        self.title.setObjectName("cardTitle")
        h.addWidget(self.title)
        self.subtitle = QLabel(subtitle)
        self.subtitle.setObjectName("dim")
        self.subtitle.setVisible(bool(subtitle))
        h.addWidget(self.subtitle)
        h.addStretch(1)
        self.extra = QHBoxLayout()
        self.extra.setSpacing(6)
        h.addLayout(self.extra)
        self.chevron = _Chevron()
        self.chevron.setVisible(collapsible)
        h.addWidget(self.chevron)
        lay.addWidget(self.header)

        self.body = QWidget()
        self.body_layout = QVBoxLayout(self.body)
        self.body_layout.setContentsMargins(9, 0, 9, 6)
        self.body_layout.setSpacing(2)
        lay.addWidget(self.body)
        self._sync()

    # ── État ─────────────────────────────────────────────────────────────
    def is_on(self):
        return self.switch.isChecked()

    def set_on(self, on):
        self.switch.set_value(on)
        self._sync()

    def is_expanded(self):
        return self._expanded

    def set_expanded(self, on):
        self._expanded = bool(on)
        self._sync()

    def set_title(self, text):
        self.title.setText(text)

    def set_subtitle(self, text):
        self.subtitle.setText(text)
        self.subtitle.setVisible(bool(text))

    def add_header_widget(self, w):
        self.extra.addWidget(w)

    def add_widget(self, w):
        self.body_layout.addWidget(w)

    # ── Interne ──────────────────────────────────────────────────────────
    def _switched(self, on):
        self._sync()
        self.toggledOn.emit(on)

    def _toggle_expanded(self):
        self._expanded = not self._expanded
        self._sync()
        self.expandedChanged.emit(self._expanded)

    def _sync(self):
        off = not self.switch.isHidden() and not self.switch.isChecked()
        if self.title.property("off") != off:
            self.title.setProperty("off", off)
            self.title.style().unpolish(self.title)
            self.title.style().polish(self.title)
        self.body.setVisible(self._expanded or not self.collapsible)
        self.chevron.down = self._expanded
        self.chevron.update()
