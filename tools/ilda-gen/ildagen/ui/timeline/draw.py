"""Dessin de la timeline (hors clips : draw_clip.py) : grille musicale, règle (numéros de mesure, repères,
barre de boucle, instant survolé), ligne de la musique, en-têtes des pistes, tête de lecture, ligne d'aimant."""

import math

import numpy as np
from PySide6.QtCore import QLineF, QPointF, QRectF, Qt
from PySide6.QtGui import QPen, QPolygonF

from ...core.timeline import SUBDIVISIONS
from .. import icons, theme
from .geometry import HEADER_W, LOOP_H, RULER_H, WAVE_H

MIN_BAR_PX = 36
MARKER_H = 17
MS_W, MS_H = 18, 17          # boutons M / S


def grid_lines(tl, t_start, t_end, pps):
    """[(temps, niveau, n° de mesure)] niveau 0 = mesure, 1 = temps, 2 = subdivision ; + pas des mesures."""
    out = []
    bar, beat = tl.bar_len, tl.beat_len
    n = SUBDIVISIONS[tl.subdivision][1]
    sub = beat / n if n >= 1 else beat
    every = 1
    while bar * every * pps < MIN_BAR_PX:
        every *= 2
    i0 = math.floor((t_start - tl.bar_offset) / bar) - 1
    i1 = math.ceil((t_end - tl.bar_offset) / bar) + 1
    show_beats = beat * pps >= 10
    show_subs = n >= 2 and sub * pps >= 7
    for i in range(i0, i1):
        tb = tl.bar_offset + i * bar
        if i % every == 0:
            out.append((tb, 0, i))
        if show_beats:
            for b in range(tl.beats_per_bar):
                tt = tb + b * beat
                if b > 0:
                    out.append((tt, 1, i))
                if show_subs:
                    for s in range(1, int(n)):
                        out.append((tt + s * sub, 2, i))
    return out, every


def draw_grid(p, geo, lines, top, bottom):
    alpha = {0: 0.085, 1: 0.04, 2: 0.02}
    for level in (2, 1, 0):
        p.setPen(QPen(theme.qc(theme.WHITE, alpha[level]), 1))
        xs = [geo.x(t) for t, lv, _ in lines if lv == level]
        p.drawLines([QLineF(x + 0.5, top, x + 0.5, bottom) for x in xs if x >= HEADER_W])


def marker_rects(p, geo, tl):
    """[(repère, QRectF)] des étiquettes visibles des repères (dans la règle)."""
    p.setFont(theme.ui_font(10, True))
    fm = p.fontMetrics()
    out = []
    for m in tl.markers:
        x = geo.x(m.t)
        w = fm.horizontalAdvance(m.name) + 12
        if x + w < HEADER_W or x > geo.width:
            continue
        out.append((m, QRectF(x, 4, w, MARKER_H)))
    return out


def draw_ruler(p, geo, tl, lines, markers, sel_marker=None, hover_x=None):
    w = geo.width
    p.fillRect(QRectF(HEADER_W, 0, w - HEADER_W, RULER_H), theme.qc(theme.BG_PANEL))
    p.save()
    p.setClipRect(QRectF(HEADER_W, 0, w - HEADER_W, RULER_H))
    p.setFont(theme.mono_font(10))
    for t, level, bar_i in lines:
        x = geo.x(t)
        if level == 0:
            p.setPen(theme.qc(theme.TEXT_DIM))
            p.drawText(QPointF(x + 4, 15), str(bar_i + 1))
            p.fillRect(QRectF(x, RULER_H - 7, 1, 7), theme.qc(theme.TEXT_OFF))
        elif level == 1:
            p.fillRect(QRectF(x, RULER_H - 4, 1, 4), theme.qc(theme.TEXT_OFF, 0.6))
    # Zone de boucle : fine barre en bas de la règle (accent : boucle active)
    if tl.loop_end > tl.loop_start:
        x0, x1 = geo.x(tl.loop_start), geo.x(tl.loop_end)
        col = theme.qc(theme.ACCENT) if tl.loop_on else theme.qc(theme.TEXT_OFF)
        p.fillRect(QRectF(x0, RULER_H - LOOP_H, max(1.0, x1 - x0), LOOP_H - 1), col)
    # Repères : étiquette pleine de leur couleur, texte presque noir
    p.setFont(theme.ui_font(10, True))
    for m, r in markers:
        p.fillRect(QRectF(r.left(), r.bottom(), 1, RULER_H - r.bottom()), theme.qc(m.color))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(theme.qc(m.color))
        p.drawRoundedRect(r, 2, 2)
        p.setPen(theme.qc(theme.ON_ACCENT))
        p.drawText(r, Qt.AlignmentFlag.AlignCenter, m.name)
        if m.id == sel_marker:
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.setPen(QPen(theme.qc(theme.TEXT), 1.5))
            p.drawRoundedRect(r.adjusted(-1.5, -1.5, 1.5, 1.5), 3, 3)
    p.setBrush(Qt.BrushStyle.NoBrush)
    # Instant survolé (secondes), discret, à côté du pointeur
    if hover_x is not None and hover_x >= HEADER_W:
        t = max(0.0, geo.t(hover_x))
        mm, ss = divmod(t, 60)
        txt = f"{int(mm):02d}:{ss:05.2f}"
        p.setFont(theme.mono_font(10))
        tw = p.fontMetrics().horizontalAdvance(txt) + 8
        bx = hover_x + 8 if hover_x + 8 + tw < w else hover_x - 8 - tw
        p.fillRect(QRectF(bx, 4, tw, 15), theme.qc(theme.BG_POPUP))
        p.setPen(theme.qc(theme.TEXT_DIM))
        p.drawText(QRectF(bx, 4, tw, 15), Qt.AlignmentFlag.AlignCenter, txt)
    p.restore()
    p.fillRect(QRectF(HEADER_W, RULER_H - 1, w - HEADER_W, 1), theme.qc(theme.BORDER))


def draw_waveform(p, geo, peaks, peaks_per_s):
    """Ligne de la musique (sous la règle)."""
    y0 = RULER_H
    p.fillRect(QRectF(HEADER_W, y0, geo.width - HEADER_W, WAVE_H), theme.qc(theme.BG_APP))
    mid = y0 + WAVE_H / 2
    amp = WAVE_H / 2 - 4
    n = len(peaks)
    xs = np.arange(int(HEADER_W), int(geo.width))
    if len(xs) and n:
        t = geo.t0 + (xs - HEADER_W) / geo.pps
        i0 = np.clip((t * peaks_per_s).astype(int), 0, n)
        i1 = np.clip(((t + 1.0 / geo.pps) * peaks_per_s).astype(int) + 1, 0, n)
        lines = []
        for x, a, b in zip(xs, i0, i1):
            if b <= a:
                continue
            seg = peaks[a:b]
            lo, hi = float(seg[:, 0].min()), float(seg[:, 1].max())
            lines.append(QLineF(x + 0.5, mid - hi * amp, x + 0.5, mid - lo * amp + 0.5))
        p.setPen(QPen(theme.qc(theme.TEXT_DIM, 0.8), 1))
        p.drawLines(lines)
    p.fillRect(QRectF(HEADER_W, y0 + WAVE_H - 1, geo.width - HEADER_W, 1), theme.qc(theme.BORDER))


def header_buttons(row):
    """Zones des boutons d'en-tête d'une piste : {« lock » | « muted » | « solo »: (x, y, l, h)}."""
    y = row.y + (min(row.h, 64) - MS_H) / 2
    x_s = HEADER_W - 8 - MS_W
    x_m = x_s - 3 - MS_W
    return {"solo": (x_s, y, MS_W, MS_H), "muted": (x_m, y, MS_W, MS_H), "lock": (x_m - 3 - 16, y, 16, MS_H)}


def draw_headers(p, geo, rows, solo_any, hover_row=None, drop_y=None):
    """Colonne de gauche : bande de couleur, nom, verrou, muet / solo de chaque piste."""
    w = HEADER_W
    p.fillRect(QRectF(0, geo.top, w, geo.height - geo.top), theme.qc(theme.BG_PANEL))
    for r in rows:
        if r.y + r.h < geo.top or r.y > geo.height:
            continue
        tr = r.track
        silent = tr.muted or (solo_any and not tr.solo)
        p.fillRect(QRectF(0, r.y, 3, r.h - 1), theme.qc(tr.color, 0.45 if silent else 1.0))
        btn = header_buttons(r)
        p.setFont(theme.ui_font(12))
        p.setPen(theme.qc(theme.TEXT_OFF if (silent or tr.locked) else theme.TEXT))
        fm = p.fontMetrics()
        room = btn["lock"][0] - 12
        bh = min(r.h, 64)
        p.drawText(QRectF(10, r.y, room, bh), Qt.AlignmentFlag.AlignVCenter,
                   fm.elidedText(tr.name, Qt.TextElideMode.ElideRight, int(room)))
        if tr.locked or r is hover_row:
            lx, ly, lw, lh = btn["lock"]
            col = theme.TEXT if tr.locked else theme.TEXT_OFF
            p.drawPixmap(QPointF(lx + 1, ly + 2), icons.pixmap("lock" if tr.locked else "lock-open", col, 13))
        p.setFont(theme.ui_font(9, True))
        for flag, label, on_col in (("muted", "M", theme.WARNING), ("solo", "S", theme.ACCENT)):
            on = getattr(tr, flag)
            br = QRectF(*btn[flag]).adjusted(0.5, 0.5, -0.5, -0.5)
            p.setPen(QPen(theme.qc(on_col if on else theme.BORDER_STRONG), 1))
            p.setBrush(theme.qc(on_col) if on else Qt.BrushStyle.NoBrush)
            p.drawRoundedRect(br, 2, 2)
            p.setPen(theme.qc(theme.ON_ACCENT if on else theme.TEXT_DIM))
            p.drawText(br, Qt.AlignmentFlag.AlignCenter, label)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.fillRect(QRectF(0, r.y + r.h - 1, geo.width, 1), theme.qc(theme.BORDER))
    if drop_y is not None:
        p.fillRect(QRectF(0, drop_y - 1, geo.width, 2), theme.qc(theme.ACCENT))
    p.fillRect(QRectF(w - 1, geo.top, 1, geo.height - geo.top), theme.qc(theme.BORDER))


def draw_corner(p, geo, has_wave):
    """Coin en haut à gauche (au-dessus des en-têtes) et en-tête de la ligne de la musique."""
    p.fillRect(QRectF(0, 0, HEADER_W, geo.top), theme.qc(theme.BG_PANEL))
    p.fillRect(QRectF(0, RULER_H - 1, HEADER_W, 1), theme.qc(theme.BORDER))
    if has_wave:
        cy = RULER_H + WAVE_H / 2
        p.drawPixmap(QPointF(10, cy - 7), icons.pixmap("music", theme.TEXT_DIM, 14))
        p.setFont(theme.ui_font(12))
        p.setPen(theme.qc(theme.TEXT_DIM))
        p.drawText(QRectF(30, RULER_H, HEADER_W - 34, WAVE_H), Qt.AlignmentFlag.AlignVCenter, "Musique")
        p.fillRect(QRectF(0, geo.top - 1, HEADER_W, 1), theme.qc(theme.BORDER))
    p.fillRect(QRectF(HEADER_W - 1, 0, 1, geo.top), theme.qc(theme.BORDER))


def draw_playhead(p, geo, t):
    x = geo.x(t)
    if x < HEADER_W or x > geo.width:
        return
    p.fillRect(QRectF(x, 0, 1, geo.height), theme.qc(theme.ACCENT))
    p.setBrush(theme.qc(theme.ACCENT))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawPolygon(QPolygonF([QPointF(x - 5, 0), QPointF(x + 6, 0), QPointF(x + 0.5, 7)]))
    p.setBrush(Qt.BrushStyle.NoBrush)


def draw_snap_line(p, geo, t):
    """Ligne d'aimant : le bord accroché (autre clip, repère, tête de lecture, boucle)."""
    x = geo.x(t)
    if HEADER_W <= x <= geo.width:
        pen = QPen(theme.qc(theme.ACCENT, 0.9), 1, Qt.PenStyle.DashLine)
        pen.setDashPattern([3, 3])
        p.setPen(pen)
        p.drawLine(QPointF(x + 0.5, 0), QPointF(x + 0.5, geo.height))
