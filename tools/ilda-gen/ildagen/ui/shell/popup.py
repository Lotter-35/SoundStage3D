"""Panneau déroulant ancré sous un bouton de la barre du haut (maîtres, connexion)."""

from PySide6.QtCore import QPoint, Qt, Signal
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QToolButton, QVBoxLayout, QWidget

from .. import icons


class Popup(QFrame):
    """Fenêtre flottante qui se ferme d'un clic à côté ; aligné à droite sous le bouton qui l'ouvre."""

    closed = Signal()

    def __init__(self, title, parent=None):
        super().__init__(parent, Qt.WindowType.Popup)
        self.setObjectName("popup")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 8)
        lay.setSpacing(2)
        head = QWidget()
        h = QHBoxLayout(head)
        h.setContentsMargins(12, 8, 8, 4)
        t = QLabel(title)
        t.setObjectName("cardTitle")
        h.addWidget(t)
        h.addStretch(1)
        self.head_layout = h
        lay.addWidget(head)
        self.body = QVBoxLayout()
        self.body.setContentsMargins(0, 0, 0, 0)
        self.body.setSpacing(2)
        lay.addLayout(self.body)

    def add_head_button(self, icon_name, tip, slot):
        b = QToolButton()
        b.setIcon(icons.icon(icon_name, 14))
        b.setIconSize(icons.qsize(14))
        b.setAutoRaise(True)
        b.setToolTip(tip)
        b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        b.clicked.connect(slot)
        self.head_layout.addWidget(b)
        return b

    def show_under(self, anchor):
        """Ouvre le panneau sous le widget « anchor », bord droit aligné sur le sien."""
        self.adjustSize()
        g = anchor.mapToGlobal(QPoint(anchor.width(), anchor.height() + 4))
        self.move(g.x() - self.width(), g.y())
        self.show()

    def hideEvent(self, e):
        super().hideEvent(e)
        self.closed.emit()
