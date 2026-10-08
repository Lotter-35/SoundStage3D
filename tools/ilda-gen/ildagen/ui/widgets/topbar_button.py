"""TopBarButton : bouton de la barre du haut (hauteur 26 px, coins de 3 px), styles dans la feuille du thème.

variant :
- "normal" : fond de champ ; enfoncé (checkable) = fond de sélection (bouton « Maîtres » ouvert) ;
- "plain" : sans cadre, texte secondaire (état de connexion) ;
- "danger" : BLACKOUT, texte rouge au repos, rouge plein quand il est engagé ;
- "live" : enfoncé = fond de sélection et icône verte (envoi live actif).
"""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QPushButton

from .. import icons

ICON_COLORS = {          # (repos, enfoncé) : jetons du thème
    "normal": ("TEXT", "TEXT"),
    "plain": ("TEXT_DIM", "TEXT"),
    "danger": ("DANGER", "WHITE"),
    "live": ("TEXT_DIM", "LIVE"),
}


class TopBarButton(QPushButton):
    def __init__(self, text="", icon=None, variant="normal", checkable=False, parent=None):
        super().__init__(text, parent)
        self.variant = variant if variant in ICON_COLORS else "normal"
        self.setProperty("tb", self.variant)
        self.setCheckable(checkable)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setFixedHeight(26)
        if icon:
            self.set_icon(icon)

    def set_icon(self, name):
        rest, on = ICON_COLORS[self.variant]
        self.setIcon(icons.icon(name, 13, color=rest, active_color=on))
        self.setIconSize(icons.qsize(13))
