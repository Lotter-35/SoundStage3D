"""SliderField : réglage numérique façon Blender, barre remplie selon la valeur dans sa plage.

[Libellé]  [███████████░░░░░░    62 %]  [∿]

Gestes :
- glisser à gauche / à droite (depuis le libellé ou la barre) = régler ; Maj = fin, Ctrl / Cmd = par crans
  (snap) ; toute la largeur de la barre = toute la plage douce ;
- molette (champ actif : après un clic, pour ne pas changer un réglage en faisant défiler le panneau) et
  flèches = un pas (Maj = petit pas, Ctrl / Cmd = grand pas) ; Début / Fin = bornes douces ; coups rapprochés
  = un seul geste (une seule annulation) ;
- double-clic, Entrée ou F2 = taper une valeur (refusée si ce n'est pas un nombre fini, sinon bornée) ;
- Échap = annule le glisser, les pas ou la saisie en cours (la valeur d'avant revient) ;
- clic droit ou Alt + clic = valeur par défaut ; bouton ∿ à droite (option osc) = oscRequested.

Signaux : editStarted() début d'un geste ; valueChanged(float) en direct ; editFinished(float) fin du geste
(valeur finale) ; editCancelled(float) geste abandonné : la valeur d'avant est réaffichée, le propriétaire la
remet dans son modèle ; resetRequested() remise à zéro demandée sans valeur par défaut connue ; oscRequested().
abort() : le geste en cours est oublié sans signal (annulé ailleurs : Ctrl+Z…).

Plages : minimum / maximum = bornes dures (saisie) ; soft_min / soft_max = plage de la barre et du glisser
(par défaut les bornes dures). factor : valeur affichée = valeur × factor (0..1 affiché en %).
"""

from PySide6.QtCore import QEvent, QRectF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from .. import icons, theme
from .numbers import fmt_number, nice_step
from .slider_typing import TypingMixin

DRAG_START = 3       # px avant qu'un appui devienne un glisser
BURST_MS = 600       # molette / flèches : pas rapprochés = un seul geste
LABEL_W = 92
OSC_W = 16
GAP = 8
BAR_H = 21
LIMIT = 1e9          # sans borne, une valeur tapée reste raisonnable
M = Qt.KeyboardModifier
COARSE = M.ControlModifier | M.MetaModifier


class SliderField(TypingMixin, QWidget):
    editStarted = Signal()
    valueChanged = Signal(float)
    editFinished = Signal(float)
    editCancelled = Signal(float)
    resetRequested = Signal()
    oscRequested = Signal()

    def __init__(self, label="", value=0.0, minimum=None, maximum=None, soft_min=None, soft_max=None,
                 decimals=2, integer=False, unit="", step=None, snap=None, default=None, factor=1.0,
                 osc=False, label_width=LABEL_W, reset_on_right_click=True, parent=None):
        super().__init__(parent)
        self._label = label
        self.label_width = label_width
        self.integer = integer
        self.decimals = 0 if integer else decimals
        self.unit = unit
        self.factor = factor or 1.0
        self.has_osc = osc
        self.reset_on_right_click = reset_on_right_click
        self._default = default
        self._osc_on = False
        self.set_range(minimum, maximum, soft_min, soft_max, step, snap)
        self._value = self._clamp(float(value))
        self._start = self._value
        self._press_x = None          # appui en cours (x), None sinon
        self._last_x = 0.0
        self._acc = 0.0               # valeur exacte pendant le glisser (avant crans et arrondi)
        self._dragging = False
        self._burst = False           # pas de molette / flèches en cours
        self._wheel_acc = 0
        self._hover = None            # "bar", "osc" ou None
        self._osc_press = False
        self._editor = None
        self._burst_timer = QTimer(self)
        self._burst_timer.setSingleShot(True)
        self._burst_timer.timeout.connect(self._end_burst)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.ClickFocus)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setCursor(Qt.CursorShape.SizeHorCursor)

    # ── Réglages du champ ────────────────────────────────────────────────
    def set_range(self, minimum=None, maximum=None, soft_min=None, soft_max=None, step=None, snap=None):
        self.minimum, self.maximum = minimum, maximum
        self.soft_min = soft_min if soft_min is not None else minimum
        self.soft_max = soft_max if soft_max is not None else maximum
        span = (self.soft_max - self.soft_min) if self.has_range() else None
        self.quantum = 1.0 if self.integer else 10.0 ** -self.decimals / self.factor
        self.step = max(step if step is not None else (1.0 if self.integer else nice_step(span)), self.quantum)
        self.snap = snap if snap is not None else self.step * 10.0
        if hasattr(self, "_value"):
            self._value = self._clamp(self._value)
            self.update()

    def has_range(self):
        return self.soft_min is not None and self.soft_max is not None and self.soft_max > self.soft_min

    def set_label(self, text):
        self._label = text
        self.update()

    def set_unit(self, unit):
        self.unit = unit
        self.update()

    def set_default(self, v):
        self._default = v

    def set_osc_active(self, on):
        """Oscillateur posé sur ce réglage : bouton ∿ couleur accent et « ~ » devant la valeur."""
        self._osc_on = bool(on)
        self.update()

    def value(self):
        return self._value

    def set_value(self, v):
        """Valeur venue du modèle (sans signal) ; ignorée pendant un glisser."""
        if v is None or self._dragging:
            return
        self._value = self._clamp(float(v))
        self.update()

    def is_editing(self):
        return self._dragging or self._burst or self._editor is not None

    def display_text(self):
        txt = fmt_number(self._value * self.factor, self.decimals) + self.unit
        return ("~ " + txt) if self._osc_on else txt

    # ── Valeurs ──────────────────────────────────────────────────────────
    def _clamp(self, v):
        if self.minimum is not None:
            v = max(self.minimum, v)
        if self.maximum is not None:
            v = min(self.maximum, v)
        v = max(-LIMIT, min(LIMIT, v))
        return float(round(v)) if self.integer else v

    def _quantize(self, v):
        """Arrondi à la précision affichée (les valeurs réglées à la souris restent « propres »)."""
        return self._clamp(round(v / self.quantum) * self.quantum)

    def _set_live(self, v):
        if abs(v - self._value) > 1e-12:
            self._value = v
            self.valueChanged.emit(v)
        self.update()

    def _commit_value(self, v):
        """Changement en un seul geste (saisie, remise à zéro, bornes)."""
        v = self._clamp(v)
        if abs(v - self._value) > 1e-12:
            self.editStarted.emit()
            self._value = v
            self.valueChanged.emit(v)
            self.editFinished.emit(v)
        self.update()

    def reset(self):
        """Valeur par défaut (clic droit, Alt + clic)."""
        self._end_burst()
        if self._default is None:
            self.resetRequested.emit()
        else:
            self._commit_value(float(self._default))

    # ── Géométrie ────────────────────────────────────────────────────────
    def bar_rect(self):
        x0 = (self.label_width + GAP) if self._label else 0
        x1 = self.width() - ((OSC_W + GAP // 2) if self.has_osc else 0)
        return QRectF(x0, (self.height() - BAR_H) / 2, max(10, x1 - x0), BAR_H)

    def osc_rect(self):
        return QRectF(self.width() - OSC_W, 0, OSC_W, self.height()) if self.has_osc else QRectF()

    def fill_ratio(self):
        if not self.has_range():
            return 0.0
        return min(1.0, max(0.0, (self._value - self.soft_min) / (self.soft_max - self.soft_min)))

    def sizeHint(self):
        w = (self.label_width + GAP if self._label else 0) + 140 + (OSC_W + GAP if self.has_osc else 0)
        return QSize(w, 26)

    def minimumSizeHint(self):
        return QSize((self.label_width // 2 + GAP if self._label else 0) + 50 + (OSC_W if self.has_osc else 0), BAR_H)

    # ── Rendu ────────────────────────────────────────────────────────────
    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        on = self.isEnabled()
        active = self._dragging or self._burst
        if self._label:
            p.setFont(theme.ui_font(12))
            p.setPen(theme.qc(theme.TEXT_DIM if on else theme.TEXT_OFF))
            r = QRectF(0, 0, self.label_width, self.height())
            p.drawText(r, Qt.AlignmentFlag.AlignVCenter,
                       p.fontMetrics().elidedText(self._label, Qt.TextElideMode.ElideRight, self.label_width))
        bar = self.bar_rect()
        path = QPainterPath()
        path.addRoundedRect(bar, 2, 2)
        p.fillPath(path, theme.qc(theme.BG_FIELD))
        fill = QRectF(bar.left(), bar.top(), bar.width() * self.fill_ratio(), bar.height())
        p.save()
        p.setClipPath(path)
        fill_col = theme.ACCENT if active else (theme.FILL_ACT if self._hover == "bar" and on else theme.FILL)
        p.fillRect(fill, theme.qc(fill_col, 1.0 if on else 0.5))
        p.restore()
        if self._editor is None:
            self._paint_value(p, bar, fill, on, active)
        if self.hasFocus() and not active and self._editor is None:
            p.setPen(QPen(theme.qc(theme.BORDER_STRONG), 1))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRoundedRect(bar.adjusted(0.5, 0.5, -0.5, -0.5), 2, 2)
        if self.has_osc:
            col = theme.ACCENT if self._osc_on else (theme.TEXT if self._hover == "osc" else theme.TEXT_OFF)
            r = self.osc_rect()
            pm = icons.pixmap("sine", col, 13, self.devicePixelRatioF())
            p.drawPixmap(int(r.center().x() - 6.5), int(r.center().y() - 6.5), pm)
        p.end()

    def _paint_value(self, p, bar, fill, on, active):
        f = theme.ui_font(12)
        f.setWeight(QFont.Weight.Medium)
        p.setFont(f)
        tr = bar.adjusted(7, 0, -7, 0)
        align = Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter
        txt = self.display_text()
        p.setPen(theme.qc(theme.TEXT if on else theme.TEXT_OFF))
        p.drawText(tr, align, txt)
        if active and fill.width() > 0:
            # Partie du texte posée sur la barre accent : couleur lisible sur l'accent
            p.save()
            p.setClipRect(fill)
            p.setPen(theme.qc(theme.ON_ACCENT))
            p.drawText(tr, align, txt)
            p.restore()

    # ── Souris ───────────────────────────────────────────────────────────
    def _zone(self, pos):
        if self.has_osc and self.osc_rect().contains(pos):
            return "osc"
        return "bar"

    def mousePressEvent(self, e):
        if self._editor is not None:
            self._commit_typing()
        pos = e.position()
        if e.button() == Qt.MouseButton.RightButton:
            if self.reset_on_right_click and self._zone(pos) == "bar":
                self.reset()
            e.accept()
            return
        if e.button() != Qt.MouseButton.LeftButton:
            return
        if self._zone(pos) == "osc":
            self._osc_press = True
            return
        self.setFocus(Qt.FocusReason.MouseFocusReason)
        if e.modifiers() & M.AltModifier:
            self.reset()
            return
        self._end_burst()
        self._press_x = self._last_x = pos.x()
        self._start = self._acc = self._value
        self._dragging = False

    def mouseMoveEvent(self, e):
        zone = self._zone(e.position())
        if zone != self._hover and self._press_x is None:
            self._hover = zone
            self.setCursor(Qt.CursorShape.PointingHandCursor if zone == "osc" else Qt.CursorShape.SizeHorCursor)
            self.update()
        if self._press_x is None or not (e.buttons() & Qt.MouseButton.LeftButton):
            return
        x = e.position().x()
        if not self._dragging:
            if abs(x - self._press_x) < DRAG_START:
                return
            self._dragging = True             # le glisser compte depuis le point d'appui
            self.editStarted.emit()
        dx = x - self._last_x
        self._last_x = x
        mods = e.modifiers()
        per_px = ((self.soft_max - self.soft_min) / max(40.0, self.bar_rect().width()) if self.has_range()
                  else self.step / 2.0)
        self._acc += dx * per_px * (0.1 if mods & M.ShiftModifier else 1.0)
        if self.has_range():
            lo, hi = min(self.soft_min, self._start), max(self.soft_max, self._start)
            self._acc = min(hi, max(lo, self._acc))
        v = self._acc
        if mods & COARSE:
            v = round(v / self.snap) * self.snap
        self._set_live(self._quantize(v))

    def mouseReleaseEvent(self, e):
        if self._osc_press:
            self._osc_press = False
            if e.button() == Qt.MouseButton.LeftButton and self.osc_rect().contains(e.position()):
                self.oscRequested.emit()
            return
        if e.button() != Qt.MouseButton.LeftButton or self._press_x is None:
            return
        was = self._dragging
        self._press_x = None
        self._dragging = False
        if was:
            self.update()
            self.editFinished.emit(self._value)

    def mouseDoubleClickEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self._zone(e.position()) == "bar":
            self._press_x = None
            self.start_typing()
        elif e.button() == Qt.MouseButton.LeftButton:
            self._osc_press = True          # double-clic sur ∿ : deuxième clic

    def leaveEvent(self, e):
        self._hover = None
        self.update()
        super().leaveEvent(e)

    def contextMenuEvent(self, e):
        if self.reset_on_right_click:
            e.accept()                      # le clic droit remet la valeur par défaut, pas de menu
        else:
            super().contextMenuEvent(e)

    def wheelEvent(self, e):
        if not self.isEnabled() or not self.hasFocus() or self._editor is not None or self._dragging:
            e.ignore()                      # le panneau défile
            return
        d = e.angleDelta().y() or e.angleDelta().x()
        self._wheel_acc += d
        n = int(self._wheel_acc / 120)
        if n:
            self._wheel_acc -= n * 120
            self._step_by(n, e.modifiers())
        e.accept()

    # ── Pas (molette, flèches) ───────────────────────────────────────────
    def _step_by(self, n, mods):
        k = 0.1 if mods & M.ShiftModifier else (10.0 if mods & COARSE else 1.0)
        st = max(self.step * k, self.quantum)
        self._begin_burst()
        self._set_live(self._quantize(self._value + n * st))

    def _begin_burst(self):
        if not self._burst:
            self._burst = True
            self._start = self._value
            self.editStarted.emit()
        self._burst_timer.start(BURST_MS)

    def _end_burst(self):
        if self._burst:
            self._burst_timer.stop()
            self._burst = False
            self.update()
            self.editFinished.emit(self._value)

    def _cancel(self):
        """Échap : le geste en cours est annulé, la valeur d'avant revient."""
        self._press_x = None
        self._dragging = False
        self._burst = False
        self._burst_timer.stop()
        self._value = self._start
        self.update()
        self.editCancelled.emit(self._start)

    def abort(self):
        """Geste annulé ailleurs (Ctrl+Z…) : on l'oublie sans rien émettre."""
        self._press_x = None
        self._dragging = False
        self._burst = False
        self._burst_timer.stop()
        self._close_editor()
        self.update()

    # ── Clavier ──────────────────────────────────────────────────────────
    def event(self, e):
        # Échap pendant un geste du champ : pour lui, pas pour le raccourci « Annuler le geste » de la fenêtre
        if (e.type() == QEvent.Type.ShortcutOverride and e.key() == Qt.Key.Key_Escape
                and (self._dragging or self._burst)):
            e.accept()
            return True
        return super().event(e)

    def keyPressEvent(self, e):
        k, mods = e.key(), e.modifiers()
        K = Qt.Key
        if k == K.Key_Escape and (self._dragging or self._burst):
            self._cancel()
        elif k == K.Key_Escape and self._press_x is not None:
            self._press_x = None            # appui sans glisser : rien n'a changé
        elif k in (K.Key_Return, K.Key_Enter, K.Key_F2):
            self.start_typing()
        elif k in (K.Key_Right, K.Key_Up):
            self._step_by(1, mods)
        elif k in (K.Key_Left, K.Key_Down):
            self._step_by(-1, mods)
        elif k in (K.Key_Home, K.Key_End) and self.has_range():
            self._end_burst()
            self._commit_value(self.soft_min if k == K.Key_Home else self.soft_max)
        else:
            super().keyPressEvent(e)
            return
        e.accept()

    def focusOutEvent(self, e):
        self._end_burst()
        self.update()
        super().focusOutEvent(e)

    def focusInEvent(self, e):
        self.update()
        super().focusInEvent(e)

    def hideEvent(self, e):
        self._end_burst()
        super().hideEvent(e)
