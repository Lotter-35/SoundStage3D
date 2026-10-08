"""Switch : interrupteur oui / non.

Oui = piste couleur accent, pastille à droite ; Non = piste grise, pastille à gauche. Suivi du mot « Oui » ou
« Non » (option text, à désactiver dans un en-tête de carte), jamais une case pleine sans coche.

Signaux (de QAbstractButton) : clicked(bool) = action de l'utilisateur ; toggled(bool) = tout changement.
set_value(v) : sans signal.
"""

from PySide6.QtCore import QRectF, QSize, Qt
from PySide6.QtGui import QPainter
from PySide6.QtWidgets import QAbstractButton

from .. import theme

TW, TH = 24, 13
TEXT_GAP = 7


class Switch(QAbstractButton):
    def __init__(self, checked=False, text=True, focusable=False, parent=None):
        super().__init__(parent)
        self.show_text = text
        self.setCheckable(True)
        self.setChecked(bool(checked))
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.TabFocus if focusable else Qt.FocusPolicy.NoFocus)
        self.setFont(theme.ui_font(12))

    def set_value(self, v):
        if v is not None:
            self.blockSignals(True)
            self.setChecked(bool(v))
            self.blockSignals(False)
            self.update()

    def value(self):
        return self.isChecked()

    def sizeHint(self):
        w = TW + (TEXT_GAP + self.fontMetrics().horizontalAdvance("Non") + 2 if self.show_text else 0)
        return QSize(w, 18)

    def minimumSizeHint(self):
        return self.sizeHint()

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        on = self.isChecked()
        en = self.isEnabled()
        y = (self.height() - TH) / 2
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(theme.qc(theme.ACCENT if on else theme.FILL, 1.0 if en else 0.45))
        p.drawRoundedRect(QRectF(0, y, TW, TH), TH / 2, TH / 2)
        d = TH - 4
        kx = TW - 2 - d if on else 2
        p.setBrush(theme.qc(theme.BG_APP if on else theme.TEXT_DIM, 1.0 if en else 0.6))
        p.drawEllipse(QRectF(kx, y + 2, d, d))
        if self.show_text:
            p.setPen(theme.qc((theme.TEXT if on else theme.TEXT_DIM) if en else theme.TEXT_OFF))
            p.drawText(QRectF(TW + TEXT_GAP, 0, self.width() - TW - TEXT_GAP, self.height()),
                       Qt.AlignmentFlag.AlignVCenter, "Oui" if on else "Non")
        if self.hasFocus():
            p.setPen(theme.qc(theme.BORDER_STRONG))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRoundedRect(QRectF(-0.5, y - 1.5, TW + 1, TH + 3), TH / 2 + 1, TH / 2 + 1)
        p.end()

    def hitButton(self, pos):
        return self.rect().contains(pos)
