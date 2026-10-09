"""Cadre de sélection : coins, milieux des côtés, poignée de rotation, poignée 3D, pivot."""

import math

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QPen, QPolygonF

from ....core.evaluator import node_quad
from ... import theme
from ..painter import draw_quad

HANDLE = 7
HIT = 7
ROT_DIST = 24
TILT_GAP = 20
SMALL = 4 * HIT      # côté (px) sous lequel les poignées des côtés et le pivot sont cachés
# Coordonnées « carré unité » des poignées (s le long du bord haut, t le long du bord gauche)
UNIT = {"c0": (0.0, 1.0), "c1": (1.0, 1.0), "c2": (1.0, 0.0), "c3": (0.0, 0.0),
        "e0": (0.5, 1.0), "e1": (1.0, 0.5), "e2": (0.5, 0.0), "e3": (0.0, 0.5)}


def pickable(root, ctx):
    """Calques cliquables dans la mire, du plus haut au plus bas (groupes verrouillés = un bloc)."""
    for c in root.children:
        if not ctx.is_visible(c) or c.kind == "modifier":
            continue
        if c.kind == "group":
            if c.locked:
                yield c
            else:
                yield from pickable(c, ctx)
        else:
            yield c


class Frame:
    def __init__(self, nodes, quads, pivot):
        self.nodes = nodes
        self.quads = quads
        if len(nodes) == 1:
            self.quad = quads[0]
        else:
            a = np.vstack(quads)
            x0, y0 = a.min(axis=0)
            x1, y1 = a.max(axis=0)
            self.quad = np.array([[x0, y1], [x1, y1], [x1, y0], [x0, y0]])
        self.pivot = pivot if pivot is not None else tuple(self.quad.mean(axis=0))

    @property
    def single(self):
        return len(self.nodes) == 1

    def frame_matrix(self):
        """Matrice carré unité → cadre (origine coin bas gauche)."""
        q = self.quad
        u = q[1] - q[0]
        v = q[0] - q[3]
        o = q[3]
        return np.array([[u[0], v[0], o[0]], [u[1], v[1], o[1]], [0.0, 0.0, 1.0]])

    def bbox(self):
        return (float(self.quad[:, 0].min()), float(self.quad[:, 1].min()),
                float(self.quad[:, 0].max()), float(self.quad[:, 1].max()))


def build_frame(editor, ctx):
    nodes = [n for n in editor.top_selected() if n.kind != "modifier"]
    quads, keep = [], []
    for n in nodes:
        q = node_quad(n, ctx)
        if q is not None:
            quads.append(q)
            keep.append(n)
    if not keep:
        return None
    pivot = editor.world_pivot(keep[0], ctx) if len(keep) == 1 else None
    return Frame(keep, quads, pivot)


def handle_positions(vt, frame):
    """{id: QPointF écran} des poignées."""
    sq = vt.to_screen_arr(frame.quad)
    pos = {}
    for hid, (s, t) in UNIT.items():
        # interpolation bilinéaire sur le quadrilatère (gère la perspective)
        top = sq[0] + (sq[1] - sq[0]) * s
        bot = sq[3] + (sq[2] - sq[3]) * s
        p = bot + (top - bot) * t
        pos[hid] = QPointF(p[0], p[1])
    top_mid = np.array([pos["e0"].x(), pos["e0"].y()])
    bot_mid = np.array([pos["e2"].x(), pos["e2"].y()])
    up = top_mid - bot_mid
    n = float(np.hypot(*up))
    up = up / n if n > 1e-6 else np.array([0.0, -1.0])
    side = sq[1] - sq[0]
    sn = float(np.hypot(*side))
    side = side / sn if sn > 1e-6 else np.array([1.0, 0.0])
    r = top_mid + up * ROT_DIST
    pos["rot"] = QPointF(r[0], r[1])
    t3 = r + side * TILT_GAP
    pos["tilt"] = QPointF(t3[0], t3[1])
    pv = vt.to_screen(*frame.pivot)
    pos["pivot"] = pv
    return pos


def is_small(vt, frame):
    """Cadre trop petit à l'écran pour les poignées des côtés et le pivot (comme Illustrator) : seuls les coins
    (et la rotation) restent, sinon le pivot ou un milieu de côté prendrait tous les clics."""
    sq = vt.to_screen_arr(frame.quad)
    w = float(np.hypot(*(sq[1] - sq[0])))
    h = float(np.hypot(*(sq[0] - sq[3])))
    return min(w, h) < SMALL


def hit_handle(vt, frame, sp, allow_pivot=True):
    pos = handle_positions(vt, frame)
    small = is_small(vt, frame)
    # Les coins d'abord, puis les côtés, le pivot en dernier
    order = ["rot", "tilt", "c0", "c1", "c2", "c3"] + ([] if small else ["e0", "e1", "e2", "e3"]) + \
        (["pivot"] if allow_pivot and frame.single and not small else [])
    for group in (order[:2], order[2:6], order[6:]):
        # Dans chaque groupe (rotation / coins / côtés et pivot), la poignée la plus proche
        near = [(abs(pos[h].x() - sp.x()) + abs(pos[h].y() - sp.y()), h) for h in group
                if abs(pos[h].x() - sp.x()) <= HIT and abs(pos[h].y() - sp.y()) <= HIT]
        if near:
            return min(near)[1]
    # Juste à l'extérieur d'un coin : rotation (comme Photoshop)
    poly = QPolygonF([QPointF(*q) for q in vt.to_screen_arr(frame.quad)])
    if not poly.containsPoint(sp, Qt.FillRule.OddEvenFill):
        for hid in ("c0", "c1", "c2", "c3"):
            p = pos[hid]
            d = math.hypot(p.x() - sp.x(), p.y() - sp.y())
            if HIT < d <= 22:
                return "rot"
    return None


def inside_frame(vt, frame, sp):
    poly = QPolygonF([QPointF(*q) for q in vt.to_screen_arr(frame.quad)])
    return poly.containsPoint(sp, Qt.FillRule.OddEvenFill)


def handle_cursor(hid, frame):
    if hid in ("rot", "tilt"):
        return Qt.CursorShape.CrossCursor
    if hid == "pivot":
        return Qt.CursorShape.SizeAllCursor
    q = frame.quad
    ang = math.degrees(math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]))
    base = {"e1": 0, "c1": 45, "e0": 90, "c0": 135, "e3": 180, "c3": 225, "e2": 270, "c2": 315}[hid]
    a = (base + ang) % 180
    if a < 22.5 or a >= 157.5:
        return Qt.CursorShape.SizeHorCursor
    if a < 67.5:
        return Qt.CursorShape.SizeBDiagCursor
    if a < 112.5:
        return Qt.CursorShape.SizeVerCursor
    return Qt.CursorShape.SizeFDiagCursor


def draw_frame(p, vt, frame, handles=True, tilt=True):
    acc = theme.qc(theme.ACCENT)
    if not frame.single:
        for q in frame.quads:
            draw_quad(p, vt, q, theme.qc(theme.ACCENT, 0.35))
    draw_quad(p, vt, frame.quad, acc)
    if not handles:
        return
    pos = handle_positions(vt, frame)
    small = is_small(vt, frame)
    p.setPen(QPen(theme.qc(theme.ACCENT, 0.7), 1))
    p.drawLine(pos["e0"], pos["rot"])
    p.setPen(QPen(acc, 1))
    p.setBrush(theme.qc(theme.BG_MIRE))
    for hid in ("c0", "c1", "c2", "c3") + (() if small else ("e0", "e1", "e2", "e3")):
        c = pos[hid]
        p.drawRect(QRectF(c.x() - HANDLE / 2, c.y() - HANDLE / 2, HANDLE, HANDLE))
    p.drawEllipse(pos["rot"], 4.5, 4.5)
    if tilt:
        t = pos["tilt"]
        p.drawPolygon(QPolygonF([QPointF(t.x(), t.y() - 5), QPointF(t.x() + 5, t.y()),
                                 QPointF(t.x(), t.y() + 5), QPointF(t.x() - 5, t.y())]))
    if frame.single and not small:
        c = pos["pivot"]
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawEllipse(c, 3.5, 3.5)
        p.drawLine(QPointF(c.x() - 7, c.y()), QPointF(c.x() + 7, c.y()))
        p.drawLine(QPointF(c.x(), c.y() - 7), QPointF(c.x(), c.y() + 7))
    p.setBrush(Qt.BrushStyle.NoBrush)
