"""Outil Forme : trait, carré, cercle, triangle, étoile, polygone, mire ILDA.

Glisser pour tracer. Maj : proportions forcées + aimant de grille ; Alt : depuis le centre.
Un simple clic pose la forme à une taille par défaut (la mire ILDA occupe toute la zone).
Symétrie de dessin active : les copies miroir / tournées suivent le tracé, puis l'ensemble est rangé dans
un groupe « Symétrie » (pivot au centre de la mire) ; chaque copie reste une vraie forme modifiable.
"""

import math

import numpy as np
from PySide6.QtCore import Qt

from ....core import draw_symmetry as DS
from ....core import grid as G
from ....core import mathutil as mu
from ....core.nodes import GroupNode, ShapeNode, clone_node
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
        self.copies = []        # [(calque copie, matrice monde)]

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
        parent, idx = ed.insertion_point()
        self.node = ShapeNode(self.kind)
        ed.apply_brush(self.node)
        parent.add(self.node, idx)
        self.pm = ed.parent_matrix(self.node, ed.eval_context())
        try:
            self.inv = np.linalg.inv(self.pm)
        except np.linalg.LinAlgError:
            self.inv = np.eye(3)
        self.copies = []
        for i, m in enumerate(DS.matrices(ed.doc.grid)):
            c = clone_node(self.node)
            parent.add(c, idx + 1 + i)
            self.copies.append((c, m))
        ed.notify(structure=True)

    def _sync_copies(self):
        """Les copies reprennent la forme d'origine, transformée par leur matrice de symétrie."""
        n = self.node
        for c, m in self.copies:
            c.rect = n.rect
            c.sparams = dict(n.sparams)
            tf = n.transform.copy()
            tf.set_affine(self.inv @ m @ self.pm @ n.transform.affine())
            c.transform = tf

    def _group_copies(self):
        if not self.copies:
            return [self.node]
        n = self.node
        parent = n.parent
        idx = n.index()
        g = GroupNode("Symétrie")
        members = [n] + [c for c, _ in self.copies]
        for m in members:
            parent.remove(m)
            g.add(m)
        parent.add(g, idx)
        g.transform.px, g.transform.py = mu.apply_point(self.inv, 0.0, 0.0)
        g.expanded = False
        self.copies = []
        return [g]

    def move(self, ev):
        if self.start is None:
            return
        if self.node is None:
            if math.hypot(ev.screen.x() - self.press_screen.x(), ev.screen.y() - self.press_screen.y()) < 3:
                return
            self._create()
        self.node.rect = self._local_rect(self._rect(ev))
        self.node.center_pivot()
        self._sync_copies()
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
        self._sync_copies()
        made = self._group_copies()
        ed.commit()
        ed.notify(structure=True)
        for n in made:
            ed.note_drawn(n)
        ed.set_selection([n.id for n in made])
        self.node = None
        self.start = None
