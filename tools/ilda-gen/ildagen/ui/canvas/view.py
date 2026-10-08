"""Zone de la mire : affichage, zoom / déplacement de la vue, routage vers l'outil actif."""

from PySide6.QtCore import QEvent, QPointF, Qt
from PySide6.QtGui import QPainter
from PySide6.QtWidgets import QWidget

from ...laser.output import safety_rect
from .. import theme
from . import painter as P
from .tools import BucketTool, PencilTool, SelectTool, ShapeTool
from .tools.base import ToolEvent
from .viewport import Viewport

DEF_MIME = "application/x-ildagen-def"
POINTS_ZOOM = 6.0   # au-delà, les points laser réels sont affichés


class CanvasView(QWidget):
    def __init__(self, editor, live, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.live = live
        self.vt = Viewport()
        self.context_menu_builder = None
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAcceptDrops(True)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent)
        self.setMinimumSize(200, 200)
        self.tools = {"select": SelectTool(self), "pencil": PencilTool(self), "shape": ShapeTool(self),
                      "bucket": BucketTool(self)}
        self.tool = self.tools["select"]
        self._panning = None
        self.last_world = None
        self.stats = None
        editor.docChanged.connect(self.update)
        editor.selectionChanged.connect(self.update)
        editor.gridChanged.connect(self.update)
        editor.contextChanged.connect(self.update)
        editor.toolChanged.connect(self.set_tool)
        editor.restored.connect(self._restored)
        live.statsChanged.connect(self._on_stats)
        live.frameComputed.connect(self._on_frame)

    # ── Outils ───────────────────────────────────────────────────────────
    def set_tool(self, name):
        self.tool.deactivate()
        if name.startswith("shape:"):
            self.tool = self.tools["shape"]
            self.tool.kind = name.split(":", 1)[1]
        else:
            self.tool = self.tools.get(name, self.tools["select"])
        self.setCursor(self.tool.cursor())
        self.update()

    def _restored(self):
        sel = self.tools["select"]
        sel.drag = None
        sel.marquee = None
        sel.guides = []
        self.tools["pencil"].free = None
        self.tools["pencil"].seg = None
        self.tools["shape"].node = None
        self.tools["shape"].start = None
        self.update()

    def _on_stats(self, stats):
        self.stats = stats
        self.update()

    def _on_frame(self):
        if self.editor.is_animated() or self.vt.zoom >= POINTS_ZOOM:
            self.update()

    # ── Rendu ────────────────────────────────────────────────────────────
    def resizeEvent(self, e):
        self.vt.resize(self.width(), self.height())
        super().resizeEvent(e)

    def paintEvent(self, _e):
        self.vt.resize(self.width(), self.height())
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        P.draw_background(p, self.vt, self.rect())
        P.draw_grid(p, self.vt, self.editor.doc.grid)
        if self.editor.editing_visible():
            P.draw_symmetry_axes(p, self.vt, self.editor.doc.grid)
        strokes = self.editor.display_strokes()
        show_points = self.vt.zoom >= POINTS_ZOOM
        P.draw_strokes(p, self.vt, strokes, alpha=0.55 if show_points else 1.0)
        settings = self.editor.settings
        if show_points or settings.get("general", "show_blanking"):
            lp = self.live.last_points
            if lp is not None:
                P.draw_laser_points(p, self.vt, lp[0], lp[1], settings.get("general", "show_blanking"))
        if settings.get("general", "show_safety"):
            P.draw_safety(p, self.vt, safety_rect(settings))
        if self.editor.editing_visible() and not self.editor.param_editing:
            # Pendant un réglage dans un panneau, rien ne masque la forme
            self._draw_modifier_scope(p)
            if self.tool is not self.tools["select"]:
                self.tools["select"].draw(p)
            self.tool.draw(p)
        P.draw_counter(p, self.rect(), self.stats, self.vt.zoom)
        p.end()

    def _draw_modifier_scope(self, p):
        """Modifieur sélectionné : contour pointillé des formes qu'il modifie."""
        ed = self.editor
        mods = [n for n in ed.selected_nodes() if n.kind == "modifier"]
        if not mods:
            return
        from ...core.evaluator import node_quad
        ctx = ed.eval_context()
        for m in mods:
            for t in ed.modifier_targets(m):
                if t.kind == "modifier":
                    continue
                q = node_quad(t, ctx)
                if q is not None:
                    P.draw_quad(p, self.vt, q, theme.qc(theme.ACCENT, 0.6))

    # ── Souris ───────────────────────────────────────────────────────────
    def _event(self, e, button=None):
        pos = e.position()
        return ToolEvent(self.vt.to_world(pos.x(), pos.y()), QPointF(pos), button or e.button(), e.modifiers())

    def mousePressEvent(self, e):
        self.setFocus()
        if e.button() == Qt.MouseButton.MiddleButton:
            self._panning = e.position()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            return
        if e.button() == Qt.MouseButton.LeftButton:
            self.tool.press(self._event(e))

    def mouseMoveEvent(self, e):
        if self._panning is not None:
            d = e.position() - self._panning
            self._panning = e.position()
            self.vt.pan_pixels(d.x(), d.y())
            self.update()
            return
        ev = self._event(e, Qt.MouseButton.NoButton)
        self.last_world = ev.world
        if e.buttons() & Qt.MouseButton.LeftButton:
            self.tool.move(ev)
        else:
            self.tool.hover(ev)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.MiddleButton and self._panning is not None:
            self._panning = None
            self.setCursor(self.tool.cursor())
            return
        if e.button() == Qt.MouseButton.LeftButton:
            self.tool.release(self._event(e))

    def mouseDoubleClickEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.tool.double_click(self._event(e))

    def wheelEvent(self, e):
        pos = e.position()
        mods = e.modifiers()
        pd = e.pixelDelta()
        zoom_key = bool(mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier |
                                Qt.KeyboardModifier.AltModifier))
        if not pd.isNull() and not zoom_key:
            # Pavé tactile : déplacement de la vue
            self.vt.pan_pixels(pd.x(), pd.y())
        else:
            dy = e.angleDelta().y() or e.angleDelta().x()
            self.vt.zoom_at(1.0015 ** dy, pos.x(), pos.y())
        self.update()
        e.accept()

    def event(self, e):
        if e.type() == QEvent.Type.NativeGesture and e.gestureType() == Qt.NativeGestureType.ZoomNativeGesture:
            pos = e.position()
            self.vt.zoom_at(1.0 + e.value(), pos.x(), pos.y())
            self.update()
            return True
        return super().event(e)

    def keyPressEvent(self, e):
        if self.tool.key_press(e.key(), e.modifiers()):
            e.accept()
            return
        self.tool.modifiers_changed(e.modifiers())
        super().keyPressEvent(e)

    def keyReleaseEvent(self, e):
        self.tool.modifiers_changed(e.modifiers())
        super().keyReleaseEvent(e)

    def contextMenuEvent(self, e):
        if self.context_menu_builder is None or not self.editor.editing_visible():
            return
        if self.tool is self.tools["select"]:
            ctx = self.editor.eval_context()
            hit = self.tool.pick(self.vt.to_world(e.pos().x(), e.pos().y()), ctx)
            if hit is not None and hit.id not in self.editor.selection:
                self.editor.set_selection([hit.id])
        menu = self.context_menu_builder(self)
        menu.exec(e.globalPos())

    def fit_view(self):
        self.vt.fit()
        self.update()

    def zoom_by(self, factor):
        self.vt.zoom_at(factor, self.width() / 2, self.height() / 2)
        self.update()

    # ── Glisser-déposer d'une forme personnalisée ────────────────────────
    def dragEnterEvent(self, e):
        if e.mimeData().hasFormat(DEF_MIME) and self.editor.editing_visible():
            e.acceptProposedAction()

    def dragMoveEvent(self, e):
        if e.mimeData().hasFormat(DEF_MIME):
            e.acceptProposedAction()

    def dropEvent(self, e):
        if not e.mimeData().hasFormat(DEF_MIME):
            return
        def_id = bytes(e.mimeData().data(DEF_MIME)).decode("utf-8")
        pos = e.position()
        self.editor.place_instance(def_id, self.vt.to_world(pos.x(), pos.y()))
        e.acceptProposedAction()
        self.setFocus()


__all__ = ["CanvasView", "DEF_MIME", "theme"]
