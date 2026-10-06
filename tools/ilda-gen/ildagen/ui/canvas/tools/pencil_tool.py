"""Outil Crayon.

- clic gauche maintenu : dessin à main levée (un nouveau calque par trait, lissage réglable) ;
- Maj : un point aimanté à la grille s'affiche ; Maj + clic pose un point, Maj + glisser trace une ligne
  (grille orthogonale) ou un arc / un rayon (grille polaire). Tout s'enchaîne dans le même calque ;
  Entrée, Échap ou un clic sans Maj terminent la forme ; cliquer sur le premier point la ferme.
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
        self.build_id = None    # calque en construction (Maj)
        self.seg = None         # tracé guidé en cours (Maj + glisser)
        self.hover_pt = None
        self.inv = np.eye(3)

    def cursor(self):
        return Qt.CursorShape.CrossCursor

    def snap(self, world):
        if self.editor.doc.grid.mode == 0:
            return tuple(world)
        return G.snap_point(world, self.editor.doc.grid)

    def _new_node(self, first_world, label):
        ed = self.editor
        ed.begin(label)
        parent, idx = ed.insertion_point()
        node = ShapeNode("path", paths=[Path([[0.0, 0.0]])], name="Tracé")
        parent.add(node, idx)
        ctx = ed.eval_context()
        try:
            self.inv = np.linalg.inv(ed.parent_matrix(node, ctx))
        except np.linalg.LinAlgError:
            self.inv = np.eye(3)
        node.paths[0].pts = self.local(first_world)[None]
        ed.notify(structure=True)
        return node

    def local(self, world):
        return np.array(mu.apply_point(self.inv, world[0], world[1]))

    def build_node(self):
        if self.build_id is None:
            return None
        n = self.editor.find(self.build_id)
        if n is None or n.kind != "shape":
            self.build_id = None
        return n

    # ── Souris ───────────────────────────────────────────────────────────
    def press(self, ev):
        if ev.button != Qt.MouseButton.LeftButton or not self.editor.editing_visible():
            return
        if ev.shift:
            self._press_guided(ev)
            return
        self.finish()
        self.free = self._new_node(ev.world, "Dessin à main levée")
        self._free_pts = [np.array(ev.world, dtype=float)]
        self._last_screen = ev.screen

    def _press_guided(self, ev):
        ed = self.editor
        p = self.snap(ev.world)
        node = self.build_node()
        if node is None:
            node = self._new_node(p, "Tracé guidé")
            self.build_id = node.id
            ed.set_selection([node.id])
        else:
            ed.begin("Tracé guidé")
            path = node.paths[-1]
            first = mu.apply_point(np.linalg.inv(self.inv), *path.pts[0])
            last = mu.apply_point(np.linalg.inv(self.inv), *path.pts[-1])
            if math.dist(first, p) < 1e-6 and len(path.pts) > 2:
                path.closed = True
                ed.commit()
                self.finish()
                ed.notify()
                return
            if math.dist(last, p) > 1e-6:
                seg, _ = G.guided_segment(last, p, ed.doc.grid)
                self._append(node, seg[1:])
        self.seg = {"start": p, "sweep": 0.0, "angle": math.degrees(math.atan2(p[1], p[0])), "preview": None}

    def _append(self, node, world_pts):
        if len(world_pts) == 0:
            return
        loc = mu.apply(self.inv, np.asarray(world_pts, dtype=float))
        path = node.paths[-1]
        path.pts = np.vstack((path.pts, loc))
        self.editor.notify()

    def move(self, ev):
        if self.free is not None:
            if math.hypot(ev.screen.x() - self._last_screen.x(), ev.screen.y() - self._last_screen.y()) >= 1.5:
                self._last_screen = ev.screen
                self._free_pts.append(np.array(ev.world, dtype=float))
                self.free.paths[0].pts = mu.apply(self.inv, np.array(self._free_pts))
                self.editor.notify()
            return
        if self.seg is not None:
            a = math.degrees(math.atan2(ev.world[1], ev.world[0]))
            self.seg["sweep"] += (a - self.seg["angle"] + 180.0) % 360.0 - 180.0
            self.seg["angle"] = a
            pts, _ = G.guided_segment(self.seg["start"], ev.world, self.editor.doc.grid, self.seg["sweep"])
            self.seg["preview"] = pts
        self.hover(ev)

    def release(self, ev):
        ed = self.editor
        if self.free is not None:
            node = self.free
            self.free = None
            pts = np.array(self._free_pts)
            if len(pts) < 2 or np.ptp(pts, axis=0).max() < self.vt.px(2):
                node.parent.remove(node)
                ed.history.cancel()
                ed.notify(structure=True)
                return
            s = float(ed.settings.get("general", "smoothing"))
            pts = smooth(pts, 1 + int(s / 12))
            pts = rdp(pts, 0.0004 + s / 100.0 * 0.005)
            node.paths[0].pts = mu.apply(self.inv, pts)
            node.center_pivot()
            ed.commit()
            ed.notify(structure=True)
            ed.set_selection([node.id])
            return
        if self.seg is not None:
            node = self.build_node()
            prev = self.seg["preview"]
            self.seg = None
            if node is not None and prev is not None and len(prev) > 1 and math.dist(prev[0], prev[-1]) > 1e-6:
                self._append(node, prev[1:])
            if node is not None:
                node.center_pivot()
            ed.commit()
            ed.notify()
            self.view.update()

    def hover(self, ev):
        shift = ev.shift
        self.hover_pt = self.snap(ev.world) if shift else None
        self.view.update()

    def modifiers_changed(self, mods):
        shift = bool(mods & Qt.KeyboardModifier.ShiftModifier)
        if shift and self.view.last_world is not None:
            self.hover_pt = self.snap(self.view.last_world)
        elif not shift:
            self.hover_pt = None
        self.view.update()

    # ── Fin de construction ──────────────────────────────────────────────
    def finish(self):
        node = self.build_node()
        if node is not None:
            node.paths = [p for p in node.paths if len(p.pts) > 1]
            if not node.paths and node.parent is not None:
                self.editor.begin("Tracé guidé")
                node.parent.remove(node)
                self.editor.commit()
                self.editor.notify(structure=True)
            else:
                node.center_pivot()
        self.build_id = None
        self.seg = None
        self.view.update()

    def key_press(self, key, mods):
        if key in (Qt.Key.Key_Return, Qt.Key.Key_Enter, Qt.Key.Key_Escape):
            self.finish()
            return True
        return False

    def deactivate(self):
        self.finish()
        self.hover_pt = None

    # ── Dessin ───────────────────────────────────────────────────────────
    def draw(self, p):
        node = self.build_node()
        if node is not None and len(node.paths[-1].pts):
            first = self.vt.to_screen(*mu.apply_point(np.linalg.inv(self.inv), *node.paths[-1].pts[0]))
            p.setPen(QPen(theme.qc(theme.ACCENT), 1))
            p.drawEllipse(first, 4, 4)
        if self.seg is not None and self.seg["preview"] is not None:
            sp = self.vt.to_screen_arr(self.seg["preview"])
            pen = QPen(theme.qc(theme.ACCENT), 1.2, Qt.PenStyle.DashLine)
            p.setPen(pen)
            for i in range(len(sp) - 1):
                p.drawLine(QPointF(*sp[i]), QPointF(*sp[i + 1]))
        if self.hover_pt is not None:
            draw_snap_marker(p, self.vt, self.hover_pt)
