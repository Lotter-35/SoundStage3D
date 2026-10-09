"""Dessin d'un clip : en-tête (liseré de la couleur de la piste, chevron, nom toujours visible, chaîne de
l'animation partagée), bande de vignettes, fondus (triangle assombri et poignées aux coins du haut), lignes
des réglages en courbe (nom dans la ligne, la courbe passe dessous, clés jamais dessinées hors du clip)."""

import math

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPainterPath, QPen, QPolygonF, QRegion

from .. import icons, theme
from . import curves as CV
from .geometry import CLIP_HEAD, HEADER_W, LANE_LABEL_H, STRIP_H


class ClipStyle:
    """Ce qui change l'aspect d'un clip : sélectionné, éteint (muet / solo ailleurs), survolé, partagé."""
    __slots__ = ("selected", "silent", "hover", "linked", "locked")

    def __init__(self, selected=False, silent=False, hover=False, linked=False, locked=False):
        self.selected, self.silent, self.hover, self.linked, self.locked = selected, silent, hover, linked, locked


def draw_clip(p, geo, b, color, name, st, thumb, sel_key=None, dpr=1.0):
    """b : Box ; color : couleur de la piste ; thumb(clip, u, taille_px) → QPixmap ou None."""
    x, y, w, h = b.x, b.y, b.w, b.h
    outer = QRectF(x, y, w, h)
    vis = QRectF(max(x, HEADER_W - 2), y, min(x + w, geo.width + 2) - max(x, HEADER_W - 2), h)
    if vis.width() <= 0:
        return
    p.save()
    path = QPainterPath()
    path.addRoundedRect(outer, 3, 3)
    p.setClipPath(path)
    p.setClipRect(vis, Qt.ClipOperation.IntersectClip)
    p.fillRect(outer, theme.qc(theme.BG_CARD))
    p.fillRect(QRectF(x, y, w, CLIP_HEAD), theme.qc(theme.SEL if st.selected else theme.BG_HOVER))
    p.fillRect(QRectF(x, y, w, 2), theme.qc(color, 0.45 if st.silent else 1.0))
    sr = QRectF(x, b.strip_top, w, STRIP_H)
    p.fillRect(sr, theme.qc(theme.BG_MIRE))
    if st.silent:
        p.setOpacity(0.35)
    _strip(p, geo, b, thumb, dpr)
    p.setOpacity(1.0)
    _fades(p, b)
    for ln in b.lanes:
        if ln.y + ln.h >= geo.top and ln.y <= geo.height:
            draw_lane(p, geo, b, ln, sel_key)
    p.restore()
    _header(p, geo, b, name, st)
    if (st.hover or st.selected) and w >= 24 and not st.locked:
        _fade_handles(p, geo, b)
    p.setBrush(Qt.BrushStyle.NoBrush)
    if st.selected:
        p.setPen(QPen(theme.qc(theme.ACCENT), 2))
        p.drawRoundedRect(outer.adjusted(0, 0, 0, 0), 3, 3)
    else:
        p.setPen(QPen(theme.qc(theme.BORDER_STRONG, 0.7), 1))
        p.drawRoundedRect(outer.adjusted(0.5, 0.5, -0.5, -0.5), 3, 3)


def _strip(p, geo, b, thumb, dpr):
    """Bande de vignettes : une par carré, calée sur le début du clip, seulement celles qui se voient."""
    s = STRIP_H
    x0 = max(b.x, HEADER_W - s)
    k0 = int(max(0.0, (x0 - b.x) // s))
    k1 = int(math.ceil((min(b.right, geo.width) - b.x) / s))
    size = int(round(s * dpr))
    src = QRectF(0, 0, size, size)
    for k in range(k0, max(k0, k1)):
        u = min(1.0, (k * s + s / 2) / b.w) if b.w > 0 else 0.0
        pm = thumb(b.clip, u, size)
        if pm is not None:
            p.drawPixmap(QRectF(b.x + k * s, b.strip_top, s, s), pm, src)


def _fades(p, b):
    """Fondus : triangle assombri au-dessus de la diagonale (intensité qui monte / descend)."""
    c = b.clip
    if c.duration <= 1e-9 or (c.fade_in <= 0 and c.fade_out <= 0):
        return
    k = b.w / c.duration
    top, bot = b.strip_top, b.strip_top + STRIP_H
    shade = theme.qc(theme.BLACK, 0.55)
    p.setPen(QPen(theme.qc(theme.TEXT_DIM), 1))
    if c.fade_in > 0:
        xe = b.x + c.fade_in * k
        p.setBrush(shade)
        p.drawPolygon(QPolygonF([QPointF(b.x, top), QPointF(xe, top), QPointF(b.x, bot)]), Qt.FillRule.OddEvenFill)
        p.drawLine(QPointF(b.x, bot), QPointF(xe, top))
    if c.fade_out > 0:
        xs = b.right - c.fade_out * k
        p.setBrush(shade)
        p.drawPolygon(QPolygonF([QPointF(xs, top), QPointF(b.right, top), QPointF(b.right, bot)]))
        p.drawLine(QPointF(xs, top), QPointF(b.right, bot))
    p.setBrush(Qt.BrushStyle.NoBrush)


def _fade_handles(p, geo, b):
    fi, fo = geo.fade_handles(b)
    p.setPen(QPen(theme.qc(theme.TEXT), 1))
    p.setBrush(theme.qc(theme.BG_PANEL))
    for hx in (fi, fo):
        if HEADER_W <= hx <= geo.width:
            p.drawRect(QRectF(hx - 3, b.strip_top - 3, 6, 6))
    p.setBrush(Qt.BrushStyle.NoBrush)


def _header(p, geo, b, name, st):
    lx = geo.label_x(b)
    right = b.right - 6
    if st.linked and b.w > 46:
        ix = b.right - 19
        if ix > lx + 10:
            p.drawPixmap(QPointF(ix, b.y + 3), icons.pixmap("link", theme.TEXT_DIM, 13))
            right = ix - 4
    if b.foldable and b.w > 30:
        cx, cy, cw, ch = geo.chevron_rect(b)
        if cx + cw < b.right - 2:
            name_ic = "chevron-down" if b.clip.expanded else "chevron-right"
            p.drawPixmap(QPointF(cx, cy + (ch - 12) / 2), icons.pixmap(name_ic, theme.TEXT_DIM, 12))
    room = right - lx
    if room > 8:
        f = theme.ui_font(11, True)
        p.setFont(f)
        p.setPen(theme.qc(theme.TEXT_OFF if (st.silent or st.locked) else theme.TEXT))
        txt = p.fontMetrics().elidedText(name, Qt.TextElideMode.ElideRight, int(room))
        p.drawText(QRectF(lx, b.y + 1, room, CLIP_HEAD - 1), Qt.AlignmentFlag.AlignVCenter, txt)


# ── Lignes des réglages en courbe ────────────────────────────────────────────

def lane_map(b, ln):
    if ln.small:
        return CV.LaneMap(b.x, b.right, ln.y + 3, ln.y + ln.h - 3, ln.spec)
    return CV.LaneMap(b.x, b.right, ln.y + LANE_LABEL_H + 2, ln.y + ln.h - 5, ln.spec)


def label_rect(p, b, ln):
    """Rectangle du nom de la ligne (flèche comprise), dans le clip."""
    p.setFont(theme.ui_font(10))
    x = max(b.x, HEADER_W) + 5
    w = min(p.fontMetrics().horizontalAdvance(ln.label) + 16, max(0.0, b.right - x - 4))
    return QRectF(x, ln.y + 1, w, LANE_LABEL_H)


def draw_lane(p, geo, b, ln, sel_key):
    lr = QRectF(b.x, ln.y, b.w, ln.h)
    p.fillRect(lr, theme.qc(theme.BG_PANEL))
    p.fillRect(QRectF(b.x, ln.y, b.w, 1), theme.qc(theme.BG_HOVER))
    track = ln.track
    if track is None:
        return
    lab = label_rect(p, b, ln)
    m = lane_map(b, ln)
    p.save()
    if ln.small:
        region = QRegion(lr.toAlignedRect()).subtracted(QRegion(lab.adjusted(-2, -1, 4, 2).toAlignedRect()))
        p.setClipRegion(region, Qt.ClipOperation.IntersectClip)
    else:
        p.setClipRect(lr, Qt.ClipOperation.IntersectClip)
    curve = track.curve
    if CV.is_color(ln.spec):
        _color_band(p, b, m, curve)
    else:
        pts = m.screen(curve)
        if len(pts):
            p.setPen(QPen(theme.qc(theme.TEXT, 0.75), 1.3))
            p.drawPolyline(QPolygonF([QPointF(px, py) for px, py in pts]))
    sel = sel_key[3] if (sel_key is not None and sel_key[0] == b.clip.id and sel_key[1] == ln.effect.id
                         and sel_key[2] == ln.key) else None
    _keys(p, m, curve, sel, ln)
    p.restore()
    # Nom du réglage (la courbe ne passe jamais dessus)
    if lab.width() > 14:
        chev = "chevron-right" if ln.small else "chevron-down"
        p.drawPixmap(QPointF(lab.left(), lab.top() + 2), icons.pixmap(chev, theme.TEXT_OFF, 10))
        p.setPen(theme.qc(theme.TEXT_DIM))
        p.setFont(theme.ui_font(10))
        tr = lab.adjusted(13, 0, 0, 0)
        p.drawText(tr, Qt.AlignmentFlag.AlignVCenter,
                   p.fontMetrics().elidedText(ln.label, Qt.TextElideMode.ElideRight, int(max(0.0, tr.width()))))


def _color_band(p, b, m, curve):
    if not curve.keys:
        return
    n = int(max(2, min(96, b.w / 4)))
    yc = (m.top + m.bottom) / 2
    w = b.w / n
    for i in range(n):
        v = curve.value_at((i + 0.5) / n)
        if isinstance(v, (tuple, list)):
            p.fillRect(QRectF(b.x + i * w, yc - 5, w + 0.5, 10), QColor.fromRgbF(*[min(1.0, max(0.0, c)) for c in v[:3]]))


def _keys(p, m, curve, sel, ln):
    r0 = 3.5 if ln.small else 4.0
    for k in curve.keys:
        if not -1e-9 <= k.t <= 1.0 + 1e-9:
            continue
        kx, ky = m.key_pos(k)
        is_sel = k is sel
        r = r0 + (1.0 if is_sel else 0.0)
        p.setPen(QPen(theme.qc(theme.ACCENT) if is_sel else theme.qc(theme.TEXT, 0.9), 1.2))
        if CV.is_color(ln.spec) and isinstance(k.v, (tuple, list)):
            p.setBrush(QColor.fromRgbF(*[min(1.0, max(0.0, c)) for c in k.v[:3]]))
        else:
            p.setBrush(theme.qc(theme.ACCENT) if is_sel else theme.qc(theme.BG_PANEL))
        p.drawPolygon(QPolygonF([QPointF(kx, ky - r), QPointF(kx + r, ky), QPointF(kx, ky + r), QPointF(kx - r, ky)]))
    p.setBrush(Qt.BrushStyle.NoBrush)
    if sel is not None and sel in curve.keys and sel.curve == "custom" and not CV.is_color(ln.spec) and not ln.small:
        h = m.handles(curve, curve.keys.index(sel))
        if h is not None:
            (ax, ay), (bx, by), (h1x, h1y), (h2x, h2y) = h
            p.setPen(QPen(theme.qc(theme.TEXT_DIM), 1))
            p.drawLine(QPointF(ax, ay), QPointF(h1x, h1y))
            p.drawLine(QPointF(bx, by), QPointF(h2x, h2y))
            p.setBrush(theme.qc(theme.TEXT))
            p.drawEllipse(QPointF(h1x, h1y), 3.0, 3.0)
            p.drawEllipse(QPointF(h2x, h2y), 3.0, 3.0)
            p.setBrush(Qt.BrushStyle.NoBrush)


def draw_ghost(p, x, y, w, h):
    """Place visée mais occupée (pas de chevauchement) : contour rouge en pointillés."""
    pen = QPen(theme.qc(theme.DANGER), 1, Qt.PenStyle.DashLine)
    pen.setDashPattern([3, 3])
    p.setPen(pen)
    p.setBrush(theme.qc(theme.DANGER, 0.08))
    p.drawRoundedRect(QRectF(x, y, w, h), 3, 3)
    p.setBrush(Qt.BrushStyle.NoBrush)


__all__ = ["ClipStyle", "draw_clip", "draw_lane", "draw_ghost", "label_rect", "lane_map"]
