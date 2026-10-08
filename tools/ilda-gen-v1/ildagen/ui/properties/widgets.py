"""Champs de réglage : valeur glissable (scrub), couleur, dégradé, liste, case à cocher.

Signaux communs : editStarted (début du geste), valueEdited (valeur en direct), editFinished (fin du geste) ;
editCancelled (le geste est abandonné : son propriétaire remet l'état d'avant, rien n'est écrit) ;
abort() : le geste en cours est oublié (annulé ailleurs : Échap, Ctrl+Z…).
"""

import math

from PySide6.QtCore import QRectF, QSize, Qt, Signal
from PySide6.QtGui import QPainter, QPen
from PySide6.QtWidgets import QAbstractButton, QComboBox, QLineEdit, QSizePolicy

from .. import theme
from .color_widgets import ColorSwatch, GradientBar, PaletteField  # noqa: F401 (réexportés)


class ScrubField(QLineEdit):
    """Valeur numérique : glisser horizontalement pour la changer (Maj = fin, Ctrl = rapide), clic pour la taper,
    Alt + clic pour revenir à la valeur par défaut. L'unité est affichée à côté, jamais dans le texte modifiable."""

    editStarted = Signal()
    valueEdited = Signal(float)
    editFinished = Signal()
    resetRequested = Signal()
    LIMIT = 1e9      # sans borne explicite, une valeur tapée reste raisonnable

    def __init__(self, decimals=2, minimum=None, maximum=None, soft=(None, None), unit="", factor=1.0,
                 integer=False, parent=None):
        super().__init__(parent)
        self.decimals = 0 if integer else decimals
        self.minimum, self.maximum = minimum, maximum
        lo = soft[0] if soft[0] is not None else (minimum if minimum is not None else -1.0)
        hi = soft[1] if soft[1] is not None else (maximum if maximum is not None else 1.0)
        self.px_step = max((hi - lo) / 300.0, 10 ** (-self.decimals) if self.decimals else 0.0)
        if integer:
            self.px_step = max(self.px_step, 0.1)
        self.unit = unit
        self.factor = factor
        self.integer = integer
        self.value = 0.0
        self._press = None
        self._scrubbing = False
        self._typing = False
        self._acc = 0.0
        self.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.setCursor(Qt.CursorShape.SizeHorCursor)
        self.setMinimumWidth(48)
        self.setFont(theme.mono_font(11))
        self.unit_text = unit.strip()
        if self.unit_text:
            w = self.fontMetrics().horizontalAdvance(self.unit_text)
            self.setTextMargins(0, 0, w + 6, 0)
        self._reset_click = False
        self._aborted = False
        self.editingFinished.connect(self._typed)

    def abort(self):
        """Le glisser en cours est annulé ailleurs : la suite du geste est ignorée."""
        if self._scrubbing or self._press is not None:
            self._aborted = True
        self._scrubbing = False
        self._press = None
        self.setText(self._fmt(self.value))

    def _bound(self, v):
        if self.minimum is not None:
            v = max(self.minimum, v)
        if self.maximum is not None:
            v = min(self.maximum, v)
        return v

    def _clamp(self, v):
        v = self._bound(v)
        return round(v) if self.integer else v

    def _fmt(self, v):
        s = f"{v * self.factor:.{self.decimals}f}"
        return s

    def set_value(self, v):
        if v is None:
            return
        self.value = float(v)
        if not self.hasFocus() and not self._scrubbing:
            self.setText(self._fmt(self.value))

    def paintEvent(self, e):
        super().paintEvent(e)
        if self.unit_text:
            p = QPainter(self)
            p.setFont(self.font())
            p.setPen(theme.qc(theme.TEXT_DIM))
            p.drawText(self.rect().adjusted(0, 0, -6, 0), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                       self.unit_text)
            p.end()

    def mousePressEvent(self, e):
        # Clic puis glisser à gauche / à droite = régler (même si le champ est en saisie) ;
        # clic sans bouger = taper une valeur ; Alt + clic = valeur par défaut.
        self._reset_click = bool(e.modifiers() & Qt.KeyboardModifier.AltModifier)
        self._aborted = False
        if self._scrubbing:
            # Relâchement précédent jamais reçu : ce glisser-là se termine d'abord
            self._scrubbing = False
            self.editFinished.emit()
        if e.button() == Qt.MouseButton.LeftButton:
            self._press = e.position().x()
            self._acc = self.value
            self._scrubbing = False
            self._typing = self.hasFocus()
            if self._typing:
                super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._press is None or not (e.buttons() & Qt.MouseButton.LeftButton):
            return
        dx = e.position().x() - self._press
        if not self._scrubbing and abs(dx) < 3:
            return
        if not self._scrubbing:
            self._scrubbing = True
            if self.hasFocus():
                self.clearFocus()
            self.editStarted.emit()
        self._press = e.position().x()
        mods = e.modifiers()
        k = 0.1 if mods & Qt.KeyboardModifier.ShiftModifier else (
            10.0 if mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier) else 1.0)
        self._acc = self._bound(self._acc + dx * self.px_step * k)
        self.value = self._clamp(self._acc)
        self.setText(self._fmt(self.value))
        self.valueEdited.emit(self.value)

    def mouseReleaseEvent(self, e):
        if self._aborted:
            self._aborted = False       # glisser annulé (Échap…) : le relâchement ne fait rien
            return
        if self._scrubbing:
            self._scrubbing = False
            self._press = None
            self.editFinished.emit()
            return
        self._press = None
        if self._reset_click:
            self._reset_click = False
            self.clearFocus()
            self.resetRequested.emit()
            return
        if self._typing:
            super().mouseReleaseEvent(e)
            return
        self.setFocus()
        self.setText(f"{self.value * self.factor:.{self.decimals}f}")
        self.selectAll()

    def focusOutEvent(self, e):
        super().focusOutEvent(e)
        self.setText(self._fmt(self.value))

    def _typed(self):
        txt = self.text().replace(",", ".").strip()
        if self.unit_text:
            txt = txt.replace(self.unit_text, "").strip()
        try:
            v = float(txt) / self.factor
        except ValueError:
            v = math.nan
        if not math.isfinite(v):
            # « inf », « nan », texte… : refusé, l'ancienne valeur reste
            self.setText(self._fmt(self.value))
            return
        v = self._clamp(max(-self.LIMIT, min(self.LIMIT, v)))
        if abs(v - self.value) > 1e-12:
            self.editStarted.emit()
            self.value = v
            self.valueEdited.emit(v)
            self.editFinished.emit()
        self.clearFocus()

    def keyPressEvent(self, e):
        if e.key() == Qt.Key.Key_Escape:
            self.setText(self._fmt(self.value))
            self.clearFocus()
            return
        super().keyPressEvent(e)


class EnumField(QComboBox):
    editStarted = Signal()
    valueEdited = Signal(int)
    editFinished = Signal()

    def __init__(self, options, parent=None):
        super().__init__(parent)
        self.addItems(options)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        # Prend la largeur disponible sans exiger la place du plus long choix
        self.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon)
        self.setMinimumContentsLength(4)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.activated.connect(self._chosen)

    def set_value(self, v):
        if v is not None:
            self.blockSignals(True)
            self.setCurrentIndex(int(v))
            self.blockSignals(False)

    def _chosen(self, i):
        self.editStarted.emit()
        self.valueEdited.emit(i)
        self.editFinished.emit()

    def wheelEvent(self, e):
        e.ignore()   # ne change pas la valeur en faisant défiler le panneau


class BoolField(QAbstractButton):
    """Réglage oui / non : interrupteur (bleu = oui) suivi du mot « Oui » ou « Non »."""

    editStarted = Signal()
    valueEdited = Signal(bool)
    editFinished = Signal()
    TW, TH = 28, 16

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setCheckable(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.setFont(theme.ui_font(11))
        self.clicked.connect(self._clicked)

    def sizeHint(self):
        return QSize(self.TW + 8 + self.fontMetrics().horizontalAdvance("Non") + 2, max(self.TH, 18))

    def minimumSizeHint(self):
        return self.sizeHint()

    def set_value(self, v):
        if v is not None:
            self.blockSignals(True)
            self.setChecked(bool(v))
            self.blockSignals(False)
            self.update()

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        on = self.isChecked()
        y = (self.height() - self.TH) / 2
        track = QRectF(0.5, y + 0.5, self.TW - 1, self.TH - 1)
        p.setPen(QPen(theme.qc(theme.ACCENT if on else theme.BORDER), 1))
        p.setBrush(theme.qc(theme.ACCENT) if on else theme.qc(theme.BG_FIELD))
        p.drawRoundedRect(track, self.TH / 2, self.TH / 2)
        d = self.TH - 4
        kx = self.TW - 2 - d if on else 2
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(theme.qc("#ffffff") if on else theme.qc(theme.TEXT_DIM))
        p.drawEllipse(QRectF(kx, y + 2, d, d))
        p.setPen(theme.qc(theme.TEXT if on else theme.TEXT_DIM))
        p.drawText(QRectF(self.TW + 8, 0, self.width() - self.TW - 8, self.height()),
                   Qt.AlignmentFlag.AlignVCenter, "Oui" if on else "Non")

    def _clicked(self, on):
        self.editStarted.emit()
        self.valueEdited.emit(on)
        self.editFinished.emit()


__all__ = ["ScrubField", "EnumField", "BoolField", "ColorSwatch", "GradientBar", "PaletteField"]
