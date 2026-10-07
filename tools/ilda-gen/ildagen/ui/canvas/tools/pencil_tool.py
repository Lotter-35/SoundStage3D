"""Outil Crayon.

- clic gauche maintenu : dessin à main levée (un nouveau calque par trait, lissage réglable) ;
- Maj : le point aimanté à la grille s'affiche ;
  Maj + clic : pose un POINT (un calque) ;
  Maj + glisser : trace UNE ligne (grille orthogonale) ou un arc / un rayon (grille polaire), un calque.
- clic simple dans le vide : désélectionne.
- symétrie de dessin active : le trait est rangé sous un modifieur Symétrie (ajouté automatiquement).
"""

import math

import numpy as np
from PySide6.QtCore import QPointF, Qt
from PySide6.QtGui import QPen

from ....core import grid as G
from ....core import mathutil as mu
from ....core.nodes import ShapeNode
from ....core.path import Path, rdp, smooth
from ... import theme
from ..painter import draw_snap_marker
from .base import Tool


class PencilTool(Tool):
    name = "pencil"

    def __init__(self, view):
        super().__init__(view)
        self.free = None        # calque en cours de dessin à main levée
        self.seg = None         # point / ligne guidée en cours (Maj)
        self.hover_pt = None
        self.inv = np.eye(3)

    def cursor(self):
        return Qt.CursorShape.CrossCursor

    def snap(self, world):
        if self.editor.doc.grid.mode == 0:
            return tuple(world)
        return G.snap_point(world, self.editor.doc.grid)

    def _new_node(self, first_world, label, name="Tracé"):
        ed = self.editor
        ed.begin(label)
        node = ed.empty_selected_layer() if not ed.doc.grid.sym else None
        if node is not None:
            # Calque vide sélectionné (bouton « Nouveau calque ») : le trait le remplit
            node.paths = [Path([[0.0, 0.0]])]
        else:
            parent, idx = ed.draw_insertion_point()
            node = ShapeNode("path", paths=[Path([[0.0, 0.0]])], name=name)
            ed.apply_brush(node)
            parent.add(node, idx)
        try:
            self.inv = np.linalg.inv(ed.parent_matrix(node, ed.eval_context()))
        except np.linalg.LinAlgError:
            self.inv = np.eye(3)
        self._set_world(node, np.array([first_world], dtype=float))
        ed.notify(structure=True)
        return node

    def _set_world(self, node, pts):
        """Géométrie du calque à partir des points « monde »."""
        pts = np.asarray(pts, dtype=float).reshape(-1, 2)
        node.paths = [Path(mu.apply(self.inv, pts))]

    # ── Souris ───────────────────────────────────────────────────────────
    def press(self, ev):
        if ev.button != Qt.MouseButton.LeftButton or not self.editor.editing_visible():
            return
        if ev.shift:
            p = self.snap(ev.world)
            node = self._new_node(p, "Point / ligne", "Point")
            self.seg = {"node": node, "start": p, "sweep": 0.0,
                        "angle": math.degrees(math.atan2(p[1], p[0])), "preview": None}
            return
        self.free = self._new_node(ev.world, "Dessin à main levée")
        self._free_pts = [np.array(ev.world, dtype=float)]
        self._last_screen = ev.screen

    def move(self, ev):
        if self.free is not None:
            if math.hypot(ev.screen.x() - self._last_screen.x(), ev.screen.y() - self._last_screen.y()) >= 1.5:
                self._last_screen = ev.screen
                self._free_pts.append(np.array(ev.world, dtype=float))
                self._set_world(self.free, np.array(self._free_pts))
                self.editor.notify()
            return
        if self.seg is not None:
            a = math.degrees(math.atan2(ev.world[1], ev.world[0]))
            self.seg["sweep"] += (a - self.seg["angle"] + 180.0) % 360.0 - 180.0
            self.seg["angle"] = a
            pts, _ = G.guided_segment(self.seg["start"], ev.world, self.editor.doc.grid, self.seg["sweep"])
            pts = np.asarray(pts, dtype=float)
            if math.dist(pts[0], pts[-1]) < 1e-9:
                pts = pts[:1]
            self.seg["preview"] = pts
            node = self.seg["node"]
            self._set_world(node, pts)
            if node.name in ("Point", "Arc", "Ligne"):
                node.name = "Point" if len(pts) == 1 else ("Arc" if len(pts) > 2 else "Ligne")
            self.editor.notify()
        self.hover(ev)

    def release(self, ev):
        ed = self.editor
        if self.free is not None:
            node = self.free
            self.free = None
            pts = np.array(self._free_pts)
            if len(pts) < 2 or np.ptp(pts, axis=0).max() < self.vt.px(2):
                restore = ed.history.cancel()
                if restore is not None:
                    ed.restore(restore)
                ed.notify(structure=True)
                ed.clear_selection()
                return
            s = float(ed.settings.get("general", "smoothing"))
            pts = smooth(pts, 1 + int(s / 12))
            pts = rdp(pts, 0.0004 + s / 100.0 * 0.005)
            self._set_world(node, pts)
            node.center_pivot()
            ed.commit()
            ed.notify(structure=True)
            ed.note_drawn(node)
            ed.set_selection([node.id])
            return
        if self.seg is not None:
            node = self.seg["node"]
            self.seg = None
            node.center_pivot()
            ed.commit()
            ed.notify(structure=True)
            ed.note_drawn(node)
            ed.set_selection([node.id])
            self.view.update()

    def hover(self, ev):
        self.hover_pt = self.snap(ev.world) if ev.shift else None
        self.view.update()

    def modifiers_changed(self, mods):
        shift = bool(mods & Qt.KeyboardModifier.ShiftModifier)
        if shift and self.view.last_world is not None:
            self.hover_pt = self.snap(self.view.last_world)
        elif not shift:
            self.hover_pt = None
        self.view.update()

    def deactivate(self):
        self.hover_pt = None

    # ── Dessin ───────────────────────────────────────────────────────────
    def draw(self, p):
        if self.seg is not None and self.seg["preview"] is not None and len(self.seg["preview"]) > 1:
            sp = self.vt.to_screen_arr(self.seg["preview"])
            p.setPen(QPen(theme.qc(theme.ACCENT, 0.5), 1, Qt.PenStyle.DashLine))
            for i in range(len(sp) - 1):
                p.drawLine(QPointF(*sp[i]), QPointF(*sp[i + 1]))
        if self.hover_pt is not None:
            draw_snap_marker(p, self.vt, self.hover_pt)
