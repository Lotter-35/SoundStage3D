"""Gauche de l'espace Forme : colonne d'outils (forme/tool_column.py) + liste des formes en vignettes
(forme/library.py). Garde l'ancienne interface : TOOLS, SHAPE_KEYS (raccourcis), def_thumbnail, .defs, .btn_new."""

from PySide6.QtGui import QPainter, QPixmap
from PySide6.QtWidgets import QHBoxLayout, QWidget

from ..core.evaluator import EvalContext, eval_children
from ..core.path import strokes_bbox
from . import theme
from .canvas.painter import draw_strokes
from .canvas.viewport import Viewport
from .forme.library import FormLibrary
from .forme.tool_column import SHAPE_KEYS, TOOLS, ToolColumn

THUMB = 40

__all__ = ["ToolPanel", "TOOLS", "SHAPE_KEYS", "def_thumbnail"]


def def_thumbnail(editor, d, size=THUMB):
    """Petite image fixe d'une forme (cadrée sur son contenu)."""
    pm = QPixmap(size * 2, size * 2)
    pm.setDevicePixelRatio(2.0)
    pm.fill(theme.qc(theme.BG_MIRE))
    ctx = EvalContext(editor.doc.library, 0.0, editor.doc.timeline.bpm, editor.default_color())
    strokes = eval_children(d.root.children, ctx)
    b = strokes_bbox(strokes)
    if b:
        vt = Viewport()
        vt.resize(size, size)
        span = max(b[2] - b[0], b[3] - b[1], 1e-3)
        vt.zoom = 2.0 / span / 1.25
        vt.pan_x, vt.pan_y = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        p = QPainter(pm)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        draw_strokes(p, vt, strokes, width=1.2)
        p.end()
    return pm


class ToolPanel(QWidget):
    def __init__(self, editor, time_fn=None, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setMinimumWidth(170)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.column = ToolColumn(editor)
        lay.addWidget(self.column)
        self.defs = FormLibrary(editor, time_fn)
        self.defs.setObjectName("formLibrary")
        lay.addWidget(self.defs, 1)
        self.buttons = self.column.buttons
        self.btn_new = self.defs.btn_new
