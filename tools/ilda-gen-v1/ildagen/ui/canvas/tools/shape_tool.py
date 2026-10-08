"""Outil Forme : trait, carré, cercle, triangle, étoile, polygone, mire ILDA.

Glisser pour tracer. Maj : proportions forcées + aimant de grille ; Alt : depuis le centre.
Un simple clic pose la forme à une taille par défaut (la mire ILDA occupe toute la zone).
Symétrie de dessin active : la forme est rangée sous un modifieur Symétrie (ajouté automatiquement).
"""

import math

import numpy as np
from PySide6.QtCore import Qt

from ....core import grid as G
from ....core import mathutil as mu
from ....core.nodes import ShapeNode
from .base import Tool

DEFAULT_HALF = 0.25


class ShapeTool(Tool):
    name = "shape"

    def __init__(self, view):
        super().__init__(view)
        self.kind = "rect"
        self.node = None
        self.start = None
        self.inv = np.eye(3)

    def cursor(self):
        return Qt.CursorShape.CrossCursor

    def _snap(self, p, ev):
        if ev.shift and self.editor.doc.grid.mode != 0:
            return G.snap_point(p, self.editor.doc.grid)
        return tuple(p)

    def press(self, ev):
        if ev.button != Qt.MouseButton.LeftButton or not self.editor.editing_visible():
            return
        self.start = self._snap(ev.world, ev)
        self.press_screen = ev.screen
        self.node = None

    def _rect(self, ev):
        a = np.array(self.start, dtype=float)
        b = np.array(self._snap(ev.world, ev), dtype=float)
        if self.kind == "line":
            if ev.shift and self.editor.doc.grid.mode == 0:
                d = b - a
                ang = round(math.degrees(math.atan2(d[1], d[0])) / 15.0) * 15.0
                L = float(np.hypot(*d))
                b = a + L * np.array([math.cos(math.radians(ang)), math.sin(math.radians(ang))])
            if ev.alt:
                a = a - (b - a)
            return (a[0], a[1], b[0], b[1])
        d = b - a
        if ev.shift:
            m = max(abs(d[0]), abs(d[1]))
            d = np.array([math.copysign(m, d[0] or 1.0), math.copysign(m, d[1] or 1.0)])
            b = a + d
        if ev.alt:
            return (a[0] - d[0], a[1] - d[1], a[0] + d[0], a[1] + d[1])
        return (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))

    def _local_rect(self, r):
        x0, y0 = mu.apply_point(self.inv, r[0], r[1])
        x1, y1 = mu.apply_point(self.inv, r[2], r[3])
        if self.kind == "line":
            return (x0, y0, x1, y1)
        return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))

    def _create(self):
        ed = self.editor
        ed.begin("Forme")
        parent, idx = ed.draw_insertion_point()
        self.node = ShapeNode(self.kind)
        ed.apply_brush(self.node)
        parent.add(self.node, idx)
        try:
            self.inv = np.linalg.inv(ed.parent_matrix(self.node, ed.eval_context()))
        except np.linalg.LinAlgError:
            self.inv = np.eye(3)
        ed.notify(structure=True)

    def move(self, ev):
        if self.start is None:
            return
        if self.node is None:
            if math.hypot(ev.screen.x() - self.press_screen.x(), ev.screen.y() - self.press_screen.y()) < 3:
                return
            self._create()
        self.node.rect = self._local_rect(self._rect(ev))
        self.node.center_pivot()
        self.editor.notify()

    def release(self, ev):
        if self.start is None:
            return
        ed = self.editor
        if self.node is None:
            self._create()
            x, y = self.start
            if self.kind == "ilda_test":
                r = (-1.0, -1.0, 1.0, 1.0)
            elif self.kind == "line":
                r = (x - DEFAULT_HALF, y, x + DEFAULT_HALF, y)
            else:
                r = (x - DEFAULT_HALF, y - DEFAULT_HALF, x + DEFAULT_HALF, y + DEFAULT_HALF)
            self.node.rect = self._local_rect(r)
        self.node.center_pivot()
        ed.commit()
        ed.notify(structure=True)
        ed.note_drawn(self.node)
        ed.set_selection([self.node.id])
        self.node = None
        self.start = None
