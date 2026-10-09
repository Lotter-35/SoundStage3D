"""Champs du panneau Réglages (espace Forme), un par type de réglage.

- ParamSlider : réglage numérique (SliderField avec le bouton ∿ de l'oscillateur ; pendant qu'un oscillateur
  est posé, le champ montre son résumé « ~ Sinus · 1 temps ») ;
- SegField (choix court en segments), EnumField (liste), BoolField (interrupteur Oui / Non) ;
- ColorRow : pastilles de couleur + « … » (autre couleur, sélecteur annulable) ;
- GradientBar, PaletteField (properties/color_widgets.py).
Tous émettent editStarted / valueEdited(valeur) / editFinished (et editCancelled pour un geste abandonné) ;
FieldRow pose un libellé (colonne de largeur fixe, tronqué « … ») devant un champ qui n'en dessine pas.
"""

from PySide6.QtCore import QFontMetrics, Qt, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import QColorDialog, QHBoxLayout, QToolButton, QWidget

from ...core.oscillator import can_oscillate
from .. import theme
from .common import LABEL_W, ElidedLabel, display
from ..widgets import ColorChips, Segmented, SliderField
from ..widgets.slider_field import GAP, OSC_W
from .widgets import BoolField, EnumField
from .color_widgets import GradientBar, PaletteField  # noqa: F401 (réexportés)

SEG_MAX_W = 190      # au-delà, un choix s'affiche en liste déroulante


class ParamSlider(SliderField):
    def __init__(self, spec, factor=1.0, label_width=LABEL_W, osc=True, parent=None):
        f, unit, dec = display(spec, factor)
        super().__init__(spec.label, spec.default_value(), spec.min, spec.max, spec.soft_min, spec.soft_max,
                         decimals=dec, integer=spec.kind == "int", unit=unit, default=spec.default_value(),
                         factor=f, osc=osc and can_oscillate(spec), label_width=label_width, parent=parent)
        self.spec = spec
        self.summary = ""
        self.setFixedHeight(26)
        if spec.tip:
            self.setToolTip(spec.tip)

    def set_summary(self, text):
        """Résumé de l'oscillateur posé (texte affiché à la place de la valeur), "" sans oscillateur."""
        if text != self.summary:
            self.summary = text
            self.set_osc_active(bool(text))

    def display_text(self):
        if self.summary and not self.is_editing():
            return self.summary
        return super().display_text()


class SegField(Segmented):
    editStarted = Signal()
    valueEdited = Signal(object)
    editFinished = Signal()

    def __init__(self, options, parent=None):
        super().__init__(options, 0, expand=True, parent=parent)
        self.currentChanged.connect(self._chosen)

    def set_value(self, v):
        if v is not None:
            self.set_current(int(v))

    def _chosen(self, i):
        self.editStarted.emit()
        self.valueEdited.emit(i)
        self.editFinished.emit()


def fits_segments(options):
    fm = QFontMetrics(theme.ui_font(11))
    return len(options) <= 3 and sum(fm.horizontalAdvance(o) + 16 for o in options) <= SEG_MAX_W


class ColorRow(QWidget):
    """Pastilles de couleur laser (+ la couleur actuelle si elle n'en fait pas partie) et « … » pour une autre
    couleur. allow_none : pastille « par défaut » (valeur None)."""

    editStarted = Signal()
    valueEdited = Signal(object)
    editFinished = Signal()
    editCancelled = Signal()

    def __init__(self, allow_none=False, none_tip="Couleur par défaut", parent=None):
        super().__init__(parent)
        self.value = None
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self.chips = ColorChips(theme.LASER_COLORS, allow_none=allow_none, none_tip=none_tip)
        self.chips.colorChosen.connect(self._chosen)
        lay.addWidget(self.chips)
        self.more = QToolButton()
        self.more.setText("…")
        self.more.setToolTip("Autre couleur…")
        self.more.setAutoRaise(True)
        self.more.setFixedSize(18, 22)
        self.more.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.more.clicked.connect(self.click)
        lay.addWidget(self.more)
        lay.addStretch(1)

    def set_value(self, c):
        self.value = None if c is None else tuple(float(x) for x in c[:3])
        base = list(theme.LASER_COLORS)
        self.chips.set_colors(base)
        if self.value is not None and self.chips.selected_index() < 0:
            self.chips.set_colors(base + [self.value])
        self.chips.set_value(self.value)

    def _chosen(self, c):
        self.editStarted.emit()
        self.set_value(c)
        self.valueEdited.emit(self.value)
        self.editFinished.emit()

    def click(self):
        """« … » : sélecteur de couleur, en direct ; Annuler remet la couleur d'avant (rien n'est écrit)."""
        start = self.value or (1.0, 1.0, 1.0)
        dlg = QColorDialog(QColor.fromRgbF(*start), self)
        dlg.setOption(QColorDialog.ColorDialogOption.DontUseNativeDialog, True)
        self.editStarted.emit()
        dlg.currentColorChanged.connect(lambda q: self.valueEdited.emit((q.redF(), q.greenF(), q.blueF())))
        if not dlg.exec():
            self.editCancelled.emit()
            return
        q = dlg.currentColor()
        self.set_value((q.redF(), q.greenF(), q.blueF()))
        self.valueEdited.emit(self.value)
        self.editFinished.emit()

    def abort(self):
        pass


class FieldRow(QWidget):
    """[Libellé (colonne fixe)] [champ] [place du bouton ∿] : aligné sur les ParamSlider."""

    def __init__(self, label, field, label_width=LABEL_W, tip="", parent=None):
        super().__init__(parent)
        self.field = field
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 2, OSC_W + GAP // 2, 2)
        lay.setSpacing(GAP)
        self.label = ElidedLabel(label)
        self.label.setObjectName("dim")
        self.label.setFixedWidth(label_width)
        lay.addWidget(self.label)
        lay.addWidget(field, 1)
        if tip:
            self.setToolTip(tip)


def make_field(spec, label_width=LABEL_W, factor=1.0):
    """(ligne à poser dans le formulaire, champ qui porte la valeur) pour un réglage."""
    if spec.kind in ("float", "int"):
        f = ParamSlider(spec, factor, label_width)
        return f, f
    if spec.kind == "bool":
        f = BoolField()
    elif spec.kind == "enum":
        f = SegField(spec.options) if fits_segments(spec.options) else EnumField(spec.options)
    elif spec.kind == "color":
        f = ColorRow()
    elif spec.kind == "gradient":
        f = GradientBar()
    elif spec.kind == "palette":
        f = PaletteField()
    else:
        return None, None
    return FieldRow(spec.label, f, label_width, spec.tip), f


__all__ = ["ParamSlider", "SegField", "ColorRow", "FieldRow", "make_field", "fits_segments", "BoolField",
           "EnumField", "GradientBar", "PaletteField"]
