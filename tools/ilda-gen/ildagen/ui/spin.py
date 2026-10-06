"""Champs numériques à suffixe (« s », « % »…) : le double-clic ne sélectionne que le nombre, jamais l'unité."""

from PySide6.QtWidgets import QDoubleSpinBox, QSpinBox


class SpinBox(QSpinBox):
    def mouseDoubleClickEvent(self, e):
        self.selectAll()          # Qt exclut préfixe et suffixe de la sélection


class DoubleSpinBox(QDoubleSpinBox):
    def mouseDoubleClickEvent(self, e):
        self.selectAll()
