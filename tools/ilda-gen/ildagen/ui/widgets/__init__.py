"""Briques d'interface communes aux trois espaces (Forme, Show, Live), dessinées selon le thème courant.

- SliderField : réglage numérique à barre remplie façon Blender (glisser, molette, flèches, saisie, Échap, ↺, ∿).
- Switch : interrupteur Oui / Non.
- Segmented : choix exclusif en segments (trait accent sous le segment actif).
- ColorChips : pastilles de couleur, dont « aucune ».
- Card : carte repliable avec interrupteur (modifieurs, effets).
- Tile : vignette de forme ou de cue (aperçu peint, nom, états sélectionnée / en cours / en attente).
- LaserView, LaserScene : rendu laser avec halo léger, désactivable.
- TopBarButton : boutons de la barre du haut (normal, sans cadre, BLACKOUT, Live).
- OscEditor : réglages d'un oscillateur (onde / vitesse, cadence), osc_summary : texte court « ~ Sinus · 1 temps ».

Chaque brique lit les couleurs de ui/theme.py au moment de peindre : un changement de thème les repeint.
"""

from .card import Card
from .color_chips import ColorChips
from .laser_view import LaserScene, LaserView
from .numbers import fmt_number, parse_number
from .osc_editor import OscEditor, OscPreview, osc_summary
from .segmented import Segmented
from .slider_field import SliderField
from .switch import Switch
from .tile import Tile
from .topbar_button import TopBarButton

__all__ = ["Card", "ColorChips", "LaserScene", "LaserView", "Segmented", "SliderField", "Switch", "Tile",
           "TopBarButton", "fmt_number", "parse_number", "OscEditor", "OscPreview", "osc_summary"]
