"""Espace Live : grille de cues (en construction : prochaine étape de la refonte)."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QLabel, QVBoxLayout, QWidget


class LiveWorkspace(QWidget):
    def __init__(self, win, parent=None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        msg = QLabel("Espace Live : la grille de cues arrive avec la prochaine étape de la refonte.")
        msg.setObjectName("dim")
        msg.setAlignment(Qt.AlignmentFlag.AlignCenter)
        lay.addWidget(msg)

    def save_layout(self):
        return {}

    def restore_layout(self, state):
        pass
