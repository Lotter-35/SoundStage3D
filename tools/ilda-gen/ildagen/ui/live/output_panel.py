"""Colonne de droite de l'espace Live : « Sortie » (aperçu laser de ce qui part : cues en cours, effets rapides,
maîtres ; halo), tempo du projet et Tap, puis les huit « Effets rapides », actifs tant qu'on les maintient
(souris, ou chiffres 1 à 8 du clavier).

Tap : à partir de la 3e tape (tapes espacées de moins de 2 s), le tempo du projet devient celui des tapes et la
grille des départs calés commence à la dernière tape (set_live_origin) : taper sur les premiers temps d'une
mesure cale les départs « À la mesure » sur la musique.
"""

import time

from PySide6.QtCore import QRectF, QSize, Qt
from PySide6.QtGui import QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QGridLayout, QHBoxLayout, QLabel, QPushButton, QVBoxLayout, QWidget

from ...core.live import QUICK_EFFECTS
from .. import icons, theme
from ..widgets import LaserView, fmt_number

TAP_RESET = 2.0        # s sans tape : on recommence à compter
TAP_KEEP = 8           # tapes retenues pour la moyenne


class TapTempo:
    def __init__(self):
        self.taps = []

    def tap(self, now):
        """Une tape à l'heure now ; renvoie le tempo (BPM) à partir de la 3e tape, sinon None."""
        if self.taps and now - self.taps[-1] > TAP_RESET:
            self.taps = []
        self.taps = (self.taps + [now])[-TAP_KEEP:]
        if len(self.taps) < 3:
            return None
        span = (self.taps[-1] - self.taps[0]) / (len(self.taps) - 1)
        return 60.0 / span if span > 0 else None


class OutputView(LaserView):
    """Aperçu de la sortie : carré noir sur le fond du panneau, aussi large que la colonne."""

    def __init__(self, parent=None):
        super().__init__(glow=True, margin=8, parent=parent)
        self.setMinimumSize(120, 120)
        self.cost = 0.0             # durée de la dernière mise à jour (préparation + peinture), en s
        self._prep = 0.0

    def hasHeightForWidth(self):
        return True

    def heightForWidth(self, w):
        return w

    def sizeHint(self):
        return QSize(320, 320)

    def set_strokes(self, strokes):
        t0 = time.perf_counter()
        super().set_strokes(strokes)
        self._prep = time.perf_counter() - t0

    def paintEvent(self, _e):
        t0 = time.perf_counter()
        p = QPainter(self)
        r = QRectF(self.rect())
        p.fillRect(r, theme.qc(theme.BG_PANEL))
        sq = self.scene.square(r)
        p.fillRect(sq, theme.qc(theme.BG_MIRE))
        p.setPen(theme.qc(theme.BG_FIELD))
        p.drawRect(sq.adjusted(0, 0, -1, -1))
        self.scene.paint(p, sq, self.glow, self.line_width, self.margin)
        p.end()
        self.cost = self._prep + time.perf_counter() - t0


class QuickButton(QWidget):
    """Bouton d'effet rapide : actif tant qu'on le tient (fond accent, texte presque noir)."""

    def __init__(self, editor, q, index, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.q = q
        self.on = False
        self._hover = False
        self._mouse = False
        self.setFixedHeight(42)
        self.setMinimumWidth(56)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip(f"{q.label} : actif tant qu'on le maintient (touche {index + 1})")

    def set_on(self, on):
        if on != self.on:
            self.on = on
            self.update()

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        path = QPainterPath()
        path.addRoundedRect(r, theme.RADIUS, theme.RADIUS)
        fill = theme.ACCENT if self.on else (theme.BG_HOVER if self._hover else theme.BG_FIELD)
        p.fillPath(path, theme.qc(fill))
        p.setPen(QPen(theme.qc(theme.ACCENT if self.on else theme.BORDER), 1))
        p.drawPath(path)
        col = theme.ON_ACCENT if self.on else (theme.TEXT if self._hover else theme.TEXT_DIM)
        n = 15
        top = (self.height() - (n + 3 + 13)) / 2
        pm = icons.pixmap(self.q.icon, col, n, self.devicePixelRatioF())
        p.drawPixmap(int(r.center().x() - n / 2), int(top), pm)
        f = theme.ui_font(11)
        if self.on:
            f.setWeight(QFont.Weight.DemiBold)
        p.setFont(f)
        p.setPen(theme.qc(col))
        p.drawText(QRectF(2, top + n + 2, self.width() - 4, 15), Qt.AlignmentFlag.AlignCenter, self.q.label)
        p.end()

    def enterEvent(self, e):
        self._hover = True
        self.update()
        super().enterEvent(e)

    def leaveEvent(self, e):
        self._hover = False
        self.update()
        super().leaveEvent(e)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._mouse = True
            self.editor.hold_quick(self.q.id)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self._mouse:
            self._mouse = False
            self.editor.release_quick(self.q.id)


class _Separator(QWidget):
    def __init__(self):
        super().__init__()
        self.setFixedHeight(1)

    def paintEvent(self, _e):
        p = QPainter(self)
        p.fillRect(self.rect(), theme.qc(theme.BORDER))
        p.end()


def _header(text, right=None):
    row = QWidget()
    row.setFixedHeight(28)
    h = QHBoxLayout(row)
    h.setContentsMargins(10, 0, 10, 0)
    h.setSpacing(9)
    t = QLabel(text)
    t.setObjectName("sectionTitle")
    h.addWidget(t)
    h.addStretch(1)
    for w in right or ():
        h.addWidget(w)
    return row


class OutputPanel(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.tapper = TapTempo()
        self.setMinimumWidth(240)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 2, 0, 0)
        lay.setSpacing(0)

        self.bpm = QLabel()
        self.bpm.setFont(theme.mono_font(11))
        self.bpm.setToolTip("Tempo du projet (le même que dans Show)")
        self.btn_tap = QPushButton("Tap")
        self.btn_tap.setFixedHeight(22)
        self.btn_tap.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.btn_tap.setToolTip("Taper le tempo sur les temps de la musique (3 tapes au moins) : le tempo du projet "
                                "change et la grille des départs commence à la dernière tape")
        self.btn_tap.pressed.connect(lambda: self.tap(time.perf_counter()))
        lay.addWidget(_header("Sortie", [self.bpm, self.btn_tap]))
        self.view = OutputView()
        box = QVBoxLayout()
        box.setContentsMargins(10, 2, 10, 10)
        box.addWidget(self.view)
        lay.addLayout(box)
        lay.addWidget(_Separator())
        hint = QLabel("maintenir pour activer")
        hint.setObjectName("dim")
        hint.setFont(theme.ui_font(11))
        lay.addWidget(_header("Effets rapides", [hint]))
        grid = QGridLayout()
        grid.setContentsMargins(10, 2, 10, 10)
        grid.setSpacing(5)
        self.quick = []
        for i, q in enumerate(QUICK_EFFECTS):
            b = QuickButton(editor, q, i)
            grid.addWidget(b, i // 4, i % 4)
            self.quick.append(b)
        lay.addLayout(grid)
        lay.addStretch(1)
        self.refresh()

    def paintEvent(self, _e):
        p = QPainter(self)
        p.fillRect(self.rect(), theme.qc(theme.BG_PANEL))
        p.end()

    def refresh(self):
        """Tempo affiché, boutons des effets rapides tenus."""
        self.bpm.setText(f"{fmt_number(self.editor.doc.timeline.bpm, 1).removesuffix(',0')} BPM")
        held = self.editor.runtime.held
        for b in self.quick:
            b.set_on(b.q.id in held)

    def set_strokes(self, strokes):
        self.view.set_strokes(strokes)

    def tap(self, now):
        bpm = self.tapper.tap(now)
        if bpm is not None:
            self.editor.set_tempo(bpm)
            self.editor.set_live_origin(now)
