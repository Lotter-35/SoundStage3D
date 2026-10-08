"""Onglet « Apparence » des Paramètres : choix du thème (un fond + un accent), appliqué dès le clic.

Le thème choisi est enregistré dans les réglages (ui.theme) et repris au lancement suivant.
"""

from PySide6.QtCore import QRectF, QSize, Qt
from PySide6.QtGui import QIcon, QPainter, QPixmap
from PySide6.QtWidgets import QLabel, QListWidget, QListWidgetItem, QVBoxLayout, QWidget

from .. import theme

SW, SH = 46, 26


def theme_swatch(tid, dpr=2.0):
    """Aperçu d'un thème : fond, panneau, barre de slider remplie de l'accent, interrupteur allumé."""
    t = theme.tokens(tid)
    pm = QPixmap(int(SW * dpr), int(SH * dpr))
    pm.setDevicePixelRatio(dpr)
    pm.fill(theme.qc(t["BG_APP"]))
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setPen(theme.qc(t["BORDER_STRONG"]))
    p.setBrush(theme.qc(t["BG_PANEL"]))
    p.drawRect(QRectF(0.5, 0.5, SW - 1, SH - 1))
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(theme.qc(t["BG_FIELD"]))
    p.drawRoundedRect(QRectF(5, 5, SW - 10, 7), 1.5, 1.5)
    p.setBrush(theme.qc(t["ACCENT"]))
    p.drawRoundedRect(QRectF(5, 5, (SW - 10) * 0.62, 7), 1.5, 1.5)
    p.drawRoundedRect(QRectF(5, 16, 12, 6), 3, 3)
    p.setBrush(theme.qc(t["BG_APP"]))
    p.drawEllipse(QRectF(12, 17, 4, 4))
    p.setBrush(theme.qc(t["FILL"]))
    p.drawRoundedRect(QRectF(21, 17, SW - 26, 4), 1, 1)
    p.end()
    return pm


class AppearanceTab(QWidget):
    def __init__(self, settings, parent=None):
        super().__init__(parent)
        self.settings = settings
        lay = QVBoxLayout(self)
        lay.setContentsMargins(14, 14, 14, 14)
        lay.setSpacing(8)
        lab = QLabel("Thème")
        lab.setObjectName("dim")
        lay.addWidget(lab)
        self.list = QListWidget()
        self.list.setIconSize(QSize(SW, SH))
        self.list.setSpacing(1)
        for tid, t in theme.THEMES.items():
            text = "  " + t.label + ("  (par défaut)" if tid == theme.DEFAULT_THEME else "")
            pm = theme_swatch(tid)
            icon = QIcon(pm)
            icon.addPixmap(pm, QIcon.Mode.Selected)       # pas de teinte de sélection sur l'aperçu
            it = QListWidgetItem(icon, text)
            it.setData(Qt.ItemDataRole.UserRole, tid)
            it.setSizeHint(QSize(0, SH + 8))
            self.list.addItem(it)
        self.list.currentItemChanged.connect(self._chosen)
        lay.addWidget(self.list, 1)
        hint = QLabel("Le thème change tout de suite. Rouge (BLACKOUT) et vert (connecté) ne changent jamais.")
        hint.setObjectName("dim")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        self.select(theme.resolve(settings.get("ui", "theme")), apply=False)

    def select(self, tid, apply=True):
        for i in range(self.list.count()):
            it = self.list.item(i)
            if it.data(Qt.ItemDataRole.UserRole) == tid:
                self.list.blockSignals(not apply)
                self.list.setCurrentItem(it)
                self.list.blockSignals(False)
                return

    def current(self):
        it = self.list.currentItem()
        return it.data(Qt.ItemDataRole.UserRole) if it is not None else theme.CURRENT

    def _chosen(self, it, _prev=None):
        if it is None:
            return
        tid = it.data(Qt.ItemDataRole.UserRole)
        self.settings.set("ui", "theme", tid)
        if tid != theme.CURRENT:
            theme.set_theme(tid)

    def reset(self):
        """« Réinitialiser cet onglet » : thème par défaut."""
        self.select(theme.DEFAULT_THEME)
        self._chosen(self.list.currentItem())
