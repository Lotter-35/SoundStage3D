"""Dessin de la mire : fond, grilles, tracés laser, points, zone de sécurité, compteur."""

import math

import numpy as np
from PySide6.QtCore import QLineF, QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPen, QBrush

from ...core import draw_symmetry as DS
from ...core import grid as G
from .. import theme

COLOR_LEVELS = 24


def mire_rect(vt):
    a = vt.to_screen(-1, 1)
    b = vt.to_screen(1, -1)
    return QRectF(a, b)


def draw_background(p, vt, rect):
    p.fillRect(rect, theme.qc(theme.BG_APP))
    m = mire_rect(vt)
    p.fillRect(m, theme.qc(theme.BG_MIRE))
    p.setPen(QPen(theme.qc(theme.BORDER), 1))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawRect(m)


def draw_symmetry_axes(p, vt, grid):
    """Axes de la symétrie de dessin (pointillés couleur accent)."""
    angles = DS.axes(grid)
    if not angles:
        return
    p.setPen(QPen(theme.qc(theme.ACCENT, 0.45), 1, Qt.PenStyle.DashLine))
    c = vt.to_screen(0, 0)
    for a in angles:
        r = math.radians(a)
        dx, dy = math.cos(r), math.sin(r)
        L = 1.0 / max(abs(dx), abs(dy))      # jusqu'au bord du carré
        end = vt.to_screen(dx * L, dy * L)
        start = c if grid.sym == 4 else vt.to_screen(-dx * L, -dy * L)
        p.drawLine(start, end)


def draw_grid(p, vt, grid):
    if grid.mode == 0:
        return
    weak = QPen(theme.qc("#ffffff", 0.06), 1)
    strong = QPen(theme.qc("#ffffff", 0.13), 1)
    p.setBrush(Qt.BrushStyle.NoBrush)
    if grid.mode == 1:
        n = max(1, grid.divisions)
        step = 1.0 / n
        # Évite les grilles illisibles quand on dézoome
        while step * vt.half < 5 and step < 1.0:
            step *= 2
        k = int(round(1.0 / step))
        for i in range(-k, k + 1):
            v = i * step
            p.setPen(strong if i == 0 else weak)
            p.drawLine(vt.to_screen(v, -1), vt.to_screen(v, 1))
            p.drawLine(vt.to_screen(-1, v), vt.to_screen(1, v))
    else:
        c = vt.to_screen(0, 0)
        rs = G.ring_step(grid)
        p.setPen(weak)
        for i in range(1, grid.rings + 1):
            r = i * rs * vt.half
            p.drawEllipse(c, r, r)
        astep = G.ray_step(grid)
        for i in range(grid.rays):
            a = math.radians(i * astep)
            # Rayon prolongé jusqu'au bord du carré
            L = 1.0 / max(abs(math.cos(a)), abs(math.sin(a)))
            p.setPen(strong if (i * astep) % 90 == 0 else weak)
            p.drawLine(c, vt.to_screen(L * math.cos(a), L * math.sin(a)))


def _qcolor(rgb):
    return QColor.fromRgbF(float(rgb[0]), float(rgb[1]), float(rgb[2]))


def draw_strokes(p, vt, strokes, width=1.6, alpha=1.0):
    """Tracés colorés ; les segments sont regroupés par couleur (quantifiée) pour aller vite."""
    buckets = {}
    dots = {}
    for s in strokes:
        if len(s.pts) == 0:
            continue
        sp = vt.to_screen_arr(s.pts)
        q = np.clip(np.round(s.col * COLOR_LEVELS), 0, COLOR_LEVELS).astype(int)
        if s.kind == "dots":
            for (x, y), c in zip(sp, q):
                key = tuple(c)
                if key != (0, 0, 0):
                    dots.setdefault(key, []).append(QPointF(x, y))
            continue
        pts = np.vstack((sp, sp[:1])) if s.closed and len(sp) > 2 else sp
        cols = np.vstack((q, q[:1])) if s.closed and len(sp) > 2 else q
        if len(pts) == 1:
            key = tuple(cols[0])
            if key != (0, 0, 0):
                dots.setdefault(key, []).append(QPointF(*pts[0]))
            continue
        seg_c = cols[1:]
        keys = seg_c[:, 0] * 10000 + seg_c[:, 1] * 100 + seg_c[:, 2]
        for k in np.unique(keys):
            if k == 0:
                continue
            idx = np.nonzero(keys == k)[0]
            a = pts[idx]
            b = pts[idx + 1]
            lines = [QLineF(a[i, 0], a[i, 1], b[i, 0], b[i, 1]) for i in range(len(idx))]
            buckets.setdefault((int(k // 10000), int(k // 100 % 100), int(k % 100)), []).extend(lines)
    for key, lines in buckets.items():
        c = _qcolor(np.array(key) / COLOR_LEVELS)
        c.setAlphaF(alpha)
        pen = QPen(c, width)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        p.setPen(pen)
        p.drawLines(lines)
    p.setPen(Qt.PenStyle.NoPen)
    for key, pts in dots.items():
        c = _qcolor(np.array(key) / COLOR_LEVELS)
        c.setAlphaF(alpha)
        p.setBrush(QBrush(c))
        for pt in pts:
            p.drawEllipse(pt, 2.2, 2.2)
    p.setBrush(Qt.BrushStyle.NoBrush)


def draw_laser_points(p, vt, pts, col, show_blank):
    """Points réellement envoyés au laser (visible en zoomant)."""
    if pts is None or len(pts) == 0:
        return
    sp = vt.to_screen_arr(pts)
    lit = col.max(axis=1) > 0
    if show_blank and len(sp) > 1:
        pen = QPen(theme.qc(theme.TEXT_OFF, 0.6), 1, Qt.PenStyle.DashLine)
        p.setPen(pen)
        lines = [QLineF(sp[i, 0], sp[i, 1], sp[i + 1, 0], sp[i + 1, 1])
                 for i in range(len(sp) - 1) if not lit[i + 1]]
        p.drawLines(lines)
    r = 1.6 if vt.zoom < 20 else 2.6
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(theme.qc(theme.TEXT_OFF))
    for i in np.nonzero(~lit)[0]:
        p.drawEllipse(QPointF(sp[i, 0], sp[i, 1]), r * 0.7, r * 0.7)
    for i in np.nonzero(lit)[0]:
        p.setBrush(_qcolor(col[i]))
        p.drawEllipse(QPointF(sp[i, 0], sp[i, 1]), r, r)
    p.setBrush(Qt.BrushStyle.NoBrush)


def draw_safety(p, vt, rect):
    if rect is None:
        return
    x0, y0, x1, y1 = rect
    pen = QPen(theme.qc(theme.DANGER, 0.45), 1, Qt.PenStyle.DashLine)
    p.setPen(pen)
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawRect(QRectF(vt.to_screen(x0, y1), vt.to_screen(x1, y0)))


def draw_counter(p, area, stats, zoom):
    """Petit compteur dans le coin bas droit : points envoyés (ou prévus hors live), image réduite pour tenir
    le budget de points, image coupée par la sécurité anti point fixe."""
    n = stats.count if stats is not None else 0
    warn = stats is not None and (stats.reduced or stats.static)
    txt = (f"{n:,} pts".replace(",", " ") + (" envoyés" if stats.sent else "")) if n else "Aucun tracé"
    if stats is not None and stats.reduced:
        txt += " · réduit"
    if stats is not None and stats.static:
        txt += " · point fixe coupé"
    if abs(zoom - 1.0) > 1e-3:
        txt += f" · {zoom * 100:.0f} %"
    p.setFont(theme.mono_font(10))
    fm = p.fontMetrics()
    w = fm.horizontalAdvance(txt) + 12
    r = QRectF(area.right() - w - 8, area.bottom() - 22, w, 16)
    p.setPen(theme.qc(theme.WARNING if warn else theme.TEXT_DIM))
    p.drawText(r, Qt.AlignmentFlag.AlignCenter, txt)


def draw_quad(p, vt, quad, color, dashed=True, width=1.0):
    pen = QPen(color, width, Qt.PenStyle.DashLine if dashed else Qt.PenStyle.SolidLine)
    if dashed:
        pen.setDashPattern([4, 3])
    p.setPen(pen)
    p.setBrush(Qt.BrushStyle.NoBrush)
    sp = vt.to_screen_arr(quad)
    for i in range(4):
        a, b = sp[i], sp[(i + 1) % 4]
        p.drawLine(QPointF(*a), QPointF(*b))


def draw_guides(p, vt, guides):
    pen = QPen(theme.qc(theme.ACCENT, 0.8), 1)
    p.setPen(pen)
    for kind, v in guides:
        if kind == "v":
            p.drawLine(QPointF(vt.to_screen(v, 0).x(), 0), QPointF(vt.to_screen(v, 0).x(), vt.h))
        else:
            p.drawLine(QPointF(0, vt.to_screen(0, v).y()), QPointF(vt.w, vt.to_screen(0, v).y()))


def draw_snap_marker(p, vt, pt):
    c = vt.to_screen(*pt)
    p.setPen(QPen(theme.qc(theme.ACCENT), 1.5))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawEllipse(c, 5, 5)
    p.drawLine(QPointF(c.x() - 9, c.y()), QPointF(c.x() - 6, c.y()))
    p.drawLine(QPointF(c.x() + 6, c.y()), QPointF(c.x() + 9, c.y()))
    p.drawLine(QPointF(c.x(), c.y() - 9), QPointF(c.x(), c.y() - 6))
    p.drawLine(QPointF(c.x(), c.y() + 6), QPointF(c.x(), c.y() + 9))
