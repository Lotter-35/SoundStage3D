"""Panneau de la timeline : transport + zone des pistes + barres de défilement."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QGridLayout, QScrollBar, QVBoxLayout, QWidget

from .canvas import TimelineCanvas
from .geometry import HEADER_W
from .transport import TransportBar


class TimelinePanel(QWidget):
    def __init__(self, editor, playback, parent=None):
        super().__init__(parent)
        self.editor = editor
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.canvas = TimelineCanvas(editor, playback)
        self.transport = TransportBar(editor, playback, self.canvas)
        lay.addWidget(self.transport)
        grid = QGridLayout()
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setSpacing(0)
        self.hbar = QScrollBar(Qt.Orientation.Horizontal)
        self.vbar = QScrollBar(Qt.Orientation.Vertical)
        grid.addWidget(self.canvas, 0, 0)
        grid.addWidget(self.vbar, 0, 1)
        grid.addWidget(self.hbar, 1, 0)
        lay.addLayout(grid, 1)
        self._updating = False
        self.hbar.valueChanged.connect(self._h)
        self.vbar.valueChanged.connect(self._v)
        self.canvas.scrollChanged.connect(self.update_bars)
        self.update_bars()

    def update_bars(self):
        self._updating = True
        c = self.canvas
        g = c.geo
        tl = self.editor.doc.timeline
        view_w = max(1, c.width() - HEADER_W)
        total = int(tl.length() * g.pps)
        self.hbar.setRange(0, max(0, total - view_w // 2))
        self.hbar.setPageStep(view_w)
        self.hbar.setValue(int(g.t0 * g.pps))
        view_h = max(1, c.height() - g.top)
        content = g.content_height(self.editor)
        self.vbar.setRange(0, max(0, content - view_h))
        self.vbar.setPageStep(view_h)
        self.vbar.setValue(g.scroll_y)
        self.vbar.setVisible(content > view_h)
        self._updating = False

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self.update_bars()

    def _h(self, v):
        if self._updating:
            return
        self.canvas.geo.t0 = v / self.canvas.geo.pps
        self.canvas.update()

    def _v(self, v):
        if self._updating:
            return
        self.canvas.geo.scroll_y = v
        self.canvas.update()
