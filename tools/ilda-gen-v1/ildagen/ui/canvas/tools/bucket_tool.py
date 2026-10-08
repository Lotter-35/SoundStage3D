"""Outil Seau : applique la couleur de tracé (unie ou dégradé) à une forme ou à toute une zone.

- clic sur une forme : la colorie ;
- clic sur une forme sélectionnée : colorie toute la sélection (groupes compris) ;
- Alt + clic : colorie tout le groupe qui contient la forme.
"""

from PySide6.QtCore import Qt

from .base import Tool
from .selection_frame import pickable
from ....core.evaluator import hit_test


class BucketTool(Tool):
    name = "bucket"

    def cursor(self):
        return Qt.CursorShape.PointingHandCursor

    def _hit(self, world):
        ed = self.editor
        root = ed.current_root()
        if root is None:
            return None
        ctx = ed.eval_context()
        tol = self.vt.px(6)
        return next((n for n in pickable(root, ctx) if hit_test(n, world, ctx, tol)), None)

    def press(self, ev):
        if ev.button != Qt.MouseButton.LeftButton or not self.editor.editing_visible():
            return
        ed = self.editor
        hit = self._hit(ev.world)
        if hit is None:
            return
        if hit.kind == "instance":
            ed.statusMessage.emit("Forme personnalisée : double-cliquez dessus (outil Sélection) pour la colorier")
            return
        sel = set(ed.selection)
        if hit.id in sel or any(a.id in sel for a in hit.ancestors()):
            targets = ed.top_selected()
        elif ev.alt and hit.parent is not None and hit.parent is not ed.current_root():
            targets = [hit.parent]
        else:
            targets = [hit]
        n = ed.paint_nodes(targets)
        if n == 0:
            ed.statusMessage.emit("Calque verrouillé : rien à colorier")
        elif n > 1:
            ed.statusMessage.emit(f"{n} formes coloriées")

    def hover(self, ev):
        self.view.setCursor(Qt.CursorShape.PointingHandCursor if self._hit(ev.world) is not None
                            else Qt.CursorShape.ArrowCursor)
