"""Maîtres (bouton tout en haut à droite) : lumière, taille, vitesse, position, rotation, couleur forcée.

Ils agissent sur toute la sortie laser et sur les aperçus ; hors annulation, enregistrés avec le projet.
"""

from PySide6.QtWidgets import QHBoxLayout, QLabel, QWidget

from ...core.masters import FIELDS
from .. import theme
from ..widgets import ColorChips, SliderField
from .popup import Popup

DECIMALS = {"brightness": 0, "size": 0, "speed": 2, "x": 2, "y": 2, "rotation": 0}


class MastersPopup(Popup):
    def __init__(self, editor, parent=None):
        super().__init__("Maîtres", parent)
        self.editor = editor
        self.setFixedWidth(320)
        self.add_head_button("rotate-ccw", "Remettre tous les maîtres à leur valeur neutre", editor.reset_masters)
        self.fields = {}
        for key, (label, default, lo, hi, unit) in FIELDS.items():
            f = SliderField(label, default, lo, hi, decimals=DECIMALS.get(key, 2), unit=unit,
                            default=default, label_width=78)
            f.valueChanged.connect(lambda v, k=key: editor.set_master(k, v))
            f.editCancelled.connect(lambda v, k=key: editor.set_master(k, v))
            self.body.addWidget(_padded(f))
            self.fields[key] = f
        row = QWidget()
        h = QHBoxLayout(row)
        h.setContentsMargins(12, 4, 12, 0)
        lab = QLabel("Couleur")
        lab.setObjectName("dim")
        lab.setFixedWidth(78)
        h.addWidget(lab)
        self.chips = ColorChips(theme.LASER_COLORS, allow_none=True, none_first=True,
                                none_tip="Aucune : les couleurs de la forme")
        self.chips.colorChosen.connect(lambda c: editor.set_master("color", c))
        h.addWidget(self.chips)
        h.addStretch(1)
        self.body.addWidget(row)
        editor.mastersChanged.connect(self.refresh)
        self.refresh()

    def refresh(self):
        m = self.editor.doc.masters
        for key, f in self.fields.items():
            if not f.is_editing():
                f.set_value(getattr(m, key))
        self.chips.set_value(m.color)


def _padded(w):
    box = QWidget()
    h = QHBoxLayout(box)
    h.setContentsMargins(4, 0, 4, 0)
    h.addWidget(w)
    return box
