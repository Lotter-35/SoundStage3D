"""Segmented : choix exclusif en segments collés (Fixe | Courbe | Oscillateur, 0,5× | 1× | 2×…).

Segment actif : fond de sélection, texte clair et trait accent de 2 px dessous. options : libellés, ou couples
(libellé, indication) : l'indication (raccourci « ⌘1 ») est écrite en petit après le libellé.
large=True : grands segments (onglets Forme · Show · Live de la barre du haut). expand=True : segments de même
largeur occupant toute la place.

Signal : currentChanged(int) = choix de l'utilisateur (clic, flèches si le widget a le focus).
set_current(i) : sans signal.
"""

from PySide6.QtCore import QEvent, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QFont, QFontMetrics, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QSizePolicy, QToolTip, QWidget

from .. import theme


class Segmented(QWidget):
    currentChanged = Signal(int)

    def __init__(self, options=(), current=0, large=False, expand=False, focusable=False, parent=None):
        super().__init__(parent)
        self.large = large
        self.expand = expand
        self._options = []
        self._tips = []
        self._current = current
        self._hover = -1
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.TabFocus if focusable else Qt.FocusPolicy.NoFocus)
        self.setSizePolicy(QSizePolicy.Policy.Expanding if expand else QSizePolicy.Policy.Fixed,
                           QSizePolicy.Policy.Fixed)
        self.set_options(options, current)

    # ── Contenu ──────────────────────────────────────────────────────────
    def set_options(self, options, current=None):
        self._options = [(o, "") if isinstance(o, str) else (str(o[0]), str(o[1])) for o in options]
        if current is not None:
            self._current = current
        self._current = min(max(0, self._current), max(0, len(self._options) - 1))
        self.updateGeometry()
        self.update()

    def set_tooltips(self, tips):
        self._tips = list(tips)

    def options(self):
        return [o[0] for o in self._options]

    def current(self):
        return self._current

    def set_current(self, i):
        if 0 <= i < len(self._options) and i != self._current:
            self._current = i
            self.update()

    # ── Géométrie ────────────────────────────────────────────────────────
    def _fonts(self):
        f = theme.ui_font(12 if self.large else 11)
        fb = QFont(f)
        if self.large:
            fb.setWeight(QFont.Weight.DemiBold)
        return f, fb, theme.mono_font(10)

    def _pad(self):
        return 18 if self.large else 8

    def _natural_widths(self):
        f, fb, fm_hint = self._fonts()
        m, mb, mh = QFontMetrics(f), QFontMetrics(fb), QFontMetrics(fm_hint)
        out = []
        for text, hint in self._options:
            w = max(m.horizontalAdvance(text), mb.horizontalAdvance(text)) + 2 * self._pad()
            if hint:
                w += 7 + mh.horizontalAdvance(hint)
            out.append(w)
        return out

    def segment_rects(self):
        n = len(self._options)
        if not n:
            return []
        h = self.height()
        if self.expand:
            w = self.width() / n
            return [QRectF(i * w, 0, w, h) for i in range(n)]
        out, x = [], 0.0
        for w in self._natural_widths():
            out.append(QRectF(x, 0, w, h))
            x += w
        return out

    def sizeHint(self):
        return QSize(int(sum(self._natural_widths())) + 1, 26 if self.large else 20)

    def minimumSizeHint(self):
        return QSize(min(self.sizeHint().width(), 40 * max(1, len(self._options))) if self.expand
                     else self.sizeHint().width(), self.sizeHint().height())

    def index_at(self, pos):
        return next((i for i, r in enumerate(self.segment_rects()) if r.contains(pos)), -1)

    # ── Rendu ────────────────────────────────────────────────────────────
    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        rects = self.segment_rects()
        if not rects:
            return
        outer = QRectF(0.5, 0.5, rects[-1].right() - 1, self.height() - 1)
        path = QPainterPath()
        path.addRoundedRect(outer, theme.RADIUS, theme.RADIUS)
        p.fillPath(path, theme.qc(theme.BG_APP))
        f, fb, fh = self._fonts()
        en = self.isEnabled()
        p.save()
        p.setClipPath(path)
        for i, (r, (text, hint)) in enumerate(zip(rects, self._options)):
            on = i == self._current
            if on:
                p.fillRect(r, theme.qc(theme.SEL))
                line = QRectF(r.left(), r.bottom() - 2.5, r.width(), 2)
                p.fillRect(line, theme.qc(theme.ACCENT if en else theme.TEXT_OFF))
            elif i == self._hover and en:
                p.fillRect(r, theme.qc(theme.BG_HOVER))
            if i:
                p.fillRect(QRectF(r.left(), 0, 1, self.height()), theme.qc(theme.BORDER))
            col = theme.TEXT if (on or i == self._hover) else theme.TEXT_DIM
            p.setPen(theme.qc(col if en else theme.TEXT_OFF))
            p.setFont(fb if on else f)
            if hint:
                tw = p.fontMetrics().horizontalAdvance(text)
                hw = QFontMetrics(fh).horizontalAdvance(hint)
                x0 = r.center().x() - (tw + 7 + hw) / 2
                p.drawText(QRectF(x0, 0, tw + 1, self.height()), Qt.AlignmentFlag.AlignVCenter, text)
                p.setFont(fh)
                p.setPen(theme.qc(theme.TEXT_OFF))
                p.drawText(QRectF(x0 + tw + 7, 0, hw + 1, self.height()), Qt.AlignmentFlag.AlignVCenter, hint)
            else:
                p.drawText(r, Qt.AlignmentFlag.AlignCenter, text)
        p.restore()
        p.setPen(QPen(theme.qc(theme.BORDER_STRONG if self.hasFocus() else theme.BORDER), 1))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawPath(path)
        p.end()

    # ── Souris, clavier ──────────────────────────────────────────────────
    def _choose(self, i):
        if 0 <= i < len(self._options) and i != self._current:
            self._current = i
            self.update()
            self.currentChanged.emit(i)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._choose(self.index_at(e.position()))

    def mouseMoveEvent(self, e):
        i = self.index_at(e.position())
        if i != self._hover:
            self._hover = i
            self.update()

    def leaveEvent(self, e):
        self._hover = -1
        self.update()
        super().leaveEvent(e)

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Left, Qt.Key.Key_Right):
            self._choose(self._current + (1 if e.key() == Qt.Key.Key_Right else -1))
            e.accept()
            return
        super().keyPressEvent(e)

    def event(self, e):
        if e.type() == QEvent.Type.ToolTip:
            i = self.index_at(e.pos().toPointF())
            if 0 <= i < len(self._tips) and self._tips[i]:
                QToolTip.showText(e.globalPos(), self._tips[i], self)
            else:
                QToolTip.hideText()
            return True
        return super().event(e)

