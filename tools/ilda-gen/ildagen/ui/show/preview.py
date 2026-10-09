"""Aperçu de la timeline à la tête de lecture (non modifiable), maîtres compris.

« Aperçu » : le contenu ; « Sortie corrigée » : ce qui part au laser après les réglages de sortie (taille,
position, rotation, trapèze, couleurs), avec la zone de sécurité en pointillés dans le repère de SORTIE (M4 :
elle était dessinée dans le repère du contenu).
"""

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, QTimer
from PySide6.QtGui import QPainter, QPen
from PySide6.QtWidgets import QHBoxLayout, QLabel, QVBoxLayout, QWidget

from ...core.masters import apply_masters
from ...laser.output import apply_output, safety_rect
from .. import theme
from ..widgets import LaserView, Segmented


class _Out:
    """Tracé après les réglages de sortie (même interface que core.path.Stroke pour LaserScene)."""
    __slots__ = ("pts", "col", "closed", "kind")

    def __init__(self, pts, col, closed, kind):
        self.pts, self.col, self.closed, self.kind = pts, col, closed, kind


def corrected(strokes, settings):
    out = []
    for s in strokes:
        if len(s.pts) == 0:
            continue
        x, y, r, g, b = apply_output(s.pts, s.col, settings)
        pts = np.stack([x, y], axis=1).astype(float) / 32767.0
        col = np.stack([r, g, b], axis=1).astype(float) / 255.0
        out.append(_Out(pts, col, bool(getattr(s, "closed", False)), getattr(s, "kind", "line")))
    return out


class PreviewView(LaserView):
    """LaserView + zone de sécurité (repère de sortie)."""

    def __init__(self, parent=None):
        super().__init__(margin=4, parent=parent)
        self.safety = None

    def paintEvent(self, e):
        super().paintEvent(e)
        if self.safety is None:
            return
        p = QPainter(self)
        sq = self.scene.square(QRectF(self.rect()))
        was_fit = self.scene.fit
        self.scene.fit = False
        tr = self.scene.transform(sq, self.margin)
        self.scene.fit = was_fit
        x0, y0, x1, y1 = self.safety
        a, b = tr.map(QPointF(x0, y1)), tr.map(QPointF(x1, y0))
        pen = QPen(theme.qc(theme.WARNING), 1, Qt.PenStyle.DashLine)
        pen.setDashPattern([4, 3])
        p.setPen(pen)
        p.drawRect(QRectF(a, b))
        p.end()


class ShowPreview(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setObjectName("showPreview")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(10, 0, 10, 10)
        lay.setSpacing(0)
        head = QHBoxLayout()
        head.setContentsMargins(0, 0, 0, 0)
        title = QLabel("Aperçu")
        title.setObjectName("sectionTitle")
        title.setFixedHeight(30)
        head.addWidget(title)
        head.addStretch(1)
        self.mode = Segmented(["Aperçu", "Sortie corrigée"])
        self.mode.set_tooltips(["Le contenu de la timeline (maîtres compris)",
                                "Après les réglages de sortie (taille, position, trapèze, zone de sécurité)"])
        self.mode.currentChanged.connect(lambda _: self.refresh())
        head.addWidget(self.mode)
        lay.addLayout(head)
        self.view = PreviewView()
        lay.addWidget(self.view, 1)
        self.timer = QTimer(self)
        self.timer.setInterval(33)
        self.timer.timeout.connect(self.refresh)
        for sig in (editor.docChanged, editor.playheadChanged, editor.mastersChanged, editor.workspaceChanged):
            sig.connect(lambda *_: self.refresh())

    def corrected_mode(self):
        return self.mode.current() == 1

    def strokes(self):
        ed = self.editor
        s = apply_masters(ed.display_strokes(), ed.doc.masters)
        return corrected(s, ed.settings) if self.corrected_mode() else s

    def refresh(self):
        ed = self.editor
        if not self.isVisible() or ed.workspace != "show":
            self.timer.stop()
            return
        self.view.safety = safety_rect(ed.settings) if self.corrected_mode() else None
        self.view.set_strokes(self.strokes())
        if ed.is_animated():
            if not self.timer.isActive():
                self.timer.start()
        else:
            self.timer.stop()

    def showEvent(self, e):
        super().showEvent(e)
        self.refresh()
