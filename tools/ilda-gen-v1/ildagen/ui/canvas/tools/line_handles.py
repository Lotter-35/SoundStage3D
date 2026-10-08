"""Sélection d'une ligne : une ligne n'a pas d'épaisseur (1D), donc pas de cadre.

Poignées : les deux extrémités (Maj : aimant de grille, ou pas de 15° sans grille) et une rotation.
"""

import math

import numpy as np
from PySide6.QtCore import QPointF, QRectF
from PySide6.QtGui import QPen

from ....core import grid as G
from ....core import mathutil as mu
from ... import theme

HIT = 7
ROT_DIST = 24


def is_line(node):
    if node.kind != "shape":
        return False
    if node.shape == "line":
        return True
    return node.shape == "path" and len(node.paths) == 1 and not node.paths[0].closed and len(node.paths[0].pts) == 2


def local_endpoints(node):
    if node.shape == "line":
        x0, y0, x1, y1 = node.rect
        return np.array([[x0, y0], [x1, y1]], dtype=float)
    return node.paths[0].pts.copy()


def node_matrix(editor, node, ctx):
    """Repère local de la forme → mire (sans inclinaison 3D)."""
    return editor.parent_matrix(node, ctx) @ editor.effective_transform(node, ctx).affine()


def world_endpoints(editor, node, ctx):
    return mu.apply(node_matrix(editor, node, ctx), local_endpoints(node))


def positions(vt, ends):
    a = vt.to_screen(*ends[0])
    b = vt.to_screen(*ends[1])
    mx, my = (a.x() + b.x()) / 2, (a.y() + b.y()) / 2
    dx, dy = b.x() - a.x(), b.y() - a.y()
    n = math.hypot(dx, dy) or 1.0
    nx, ny = dy / n, -dx / n          # perpendiculaire
    if ny > 0:                         # toujours vers le haut de l'écran
        nx, ny = -nx, -ny
    return {"p0": a, "p1": b, "mid": QPointF(mx, my), "rot": QPointF(mx + nx * ROT_DIST, my + ny * ROT_DIST)}


def hit(vt, ends, sp):
    pos = positions(vt, ends)
    for hid in ("p0", "p1", "rot"):
        p = pos[hid]
        if abs(p.x() - sp.x()) <= HIT and abs(p.y() - sp.y()) <= HIT:
            return hid
    return None


def set_endpoint(editor, node, which, world, ctx):
    """Place une extrémité de la ligne au point « world » (repère mire)."""
    m = node_matrix(editor, node, ctx)
    try:
        lx, ly = mu.apply_point(np.linalg.inv(m), *world)
    except np.linalg.LinAlgError:
        return
    i = 0 if which == "p0" else 1
    if node.shape == "line":
        r = list(node.rect)
        r[2 * i], r[2 * i + 1] = lx, ly
        node.rect = tuple(r)
    else:
        node.paths[0].pts[i] = (lx, ly)
    editor.notify()


def constrain(editor, other, world, shift):
    """Maj : aimant de grille, ou angle par pas de 15° quand il n'y a pas de grille."""
    if not shift:
        return world
    if editor.doc.grid.mode != 0:
        return G.snap_point(world, editor.doc.grid)
    d = np.array(world) - other
    L = float(np.hypot(*d))
    a = round(math.degrees(math.atan2(d[1], d[0])) / 15.0) * 15.0
    return tuple(other + L * np.array([math.cos(math.radians(a)), math.sin(math.radians(a))]))


def recenter(node):
    """Recentre le pivot sur le milieu de la ligne sans la déplacer."""
    b = node.local_bbox()
    if b:
        node.transform.set_pivot((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def draw(p, vt, ends, handles=True):
    pos = positions(vt, ends)
    acc = theme.qc(theme.ACCENT)
    pen = QPen(theme.qc(theme.ACCENT, 0.6), 1)
    pen.setDashPattern([4, 3])
    p.setPen(pen)
    p.drawLine(pos["p0"], pos["p1"])
    if not handles:
        return
    p.drawLine(pos["mid"], pos["rot"])
    p.setPen(QPen(acc, 1))
    p.setBrush(theme.qc(theme.BG_MIRE))
    for hid in ("p0", "p1"):
        c = pos[hid]
        p.drawRect(QRectF(c.x() - 3.5, c.y() - 3.5, 7, 7))
    p.drawEllipse(pos["rot"], 4.5, 4.5)
    p.setBrush(theme.qc(theme.BG_MIRE))
