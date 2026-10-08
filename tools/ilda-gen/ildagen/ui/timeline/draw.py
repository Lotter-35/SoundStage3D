"""Dessin de la timeline : grille musicale, règle (boucle, repères), forme d'onde, pistes, clips (vignettes,
fondus, chaîne de l'animation partagée), tête de lecture."""

import math

import numpy as np
from PySide6.QtCore import QLineF, QPointF, QRectF, Qt
from PySide6.QtGui import QPen, QPolygonF

from ...core.timeline import SUBDIVISIONS
from .. import icons, theme
from .geometry import HEADER_W, LOOP_H, RULER_H, WAVE_H, link_icon_rect

MIN_BAR_PX = 36


def grid_lines(tl, t_start, t_end, pps):
    """[(x_temps, niveau)] niveau 0 = mesure, 1 = temps, 2 = subdivision ; + pas d'affichage des mesures."""
    out = []
    bar, beat = tl.bar_len, tl.beat_len
    sub = beat / SUBDIVISIONS[tl.subdivision][1]
    every = 1
    while bar * every * pps < MIN_BAR_PX:
        every *= 2
    i0 = math.floor((t_start - tl.bar_offset) / bar) - 1
    i1 = math.ceil((t_end - tl.bar_offset) / bar) + 1
    show_beats = beat * pps >= 10
    show_subs = sub * pps >= 7 and SUBDIVISIONS[tl.subdivision][1] > 1
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
                    n = SUBDIVISIONS[tl.subdivision][1]
                    for s in range(1, n):
                        out.append((tt + s * sub, 2, i))
    return out, every


def draw_grid(p, geo, tl, top, bottom):
    t_a, t_b = geo.visible_range()
    lines, _ = grid_lines(tl, t_a, t_b, geo.pps)
    alpha = {0: 0.14, 1: 0.07, 2: 0.035}
    for level in (2, 1, 0):
        pen = QPen(theme.qc("#ffffff", alpha[level]), 1)
        p.setPen(pen)
        xs = [geo.x(t) for t, lv, _ in lines if lv == level]
        p.drawLines([QLineF(x, top, x, bottom) for x in xs if x >= HEADER_W])


def draw_ruler(p, geo, tl):
    w = geo.width
    p.fillRect(QRectF(HEADER_W, 0, w - HEADER_W, RULER_H), theme.qc(theme.BG_PANEL))
    # Zone de boucle
    if tl.loop_end > tl.loop_start:
        x0, x1 = geo.x(tl.loop_start), geo.x(tl.loop_end)
        c = theme.qc(theme.TEXT_DIM, 0.55) if tl.loop_on else theme.qc(theme.TEXT_OFF, 0.35)
        p.fillRect(QRectF(max(HEADER_W, x0), 2, max(0.0, min(w, x1) - max(HEADER_W, x0)), LOOP_H - 4), c)
    t_a, t_b = geo.visible_range()
    lines, every = grid_lines(tl, t_a, t_b, geo.pps)
    p.setFont(theme.mono_font(10))
    for t, level, bar_i in lines:
        x = geo.x(t)
        if x < HEADER_W:
            continue
        if level == 0:
            p.setPen(QPen(theme.qc(theme.TEXT_DIM), 1))
            p.drawLine(QPointF(x, LOOP_H + 4), QPointF(x, RULER_H))
            p.drawText(QPointF(x + 3, RULER_H - 7), str(bar_i + 1))
        elif level == 1:
            p.setPen(QPen(theme.qc(theme.TEXT_OFF), 1))
            p.drawLine(QPointF(x, RULER_H - 6), QPointF(x, RULER_H))
    draw_markers(p, geo, tl)
    p.setPen(QPen(theme.qc(theme.BORDER), 1))
    p.drawLine(QPointF(HEADER_W, RULER_H - 0.5), QPointF(w, RULER_H - 0.5))


def draw_waveform(p, geo, peaks, peaks_per_s):
    if peaks is None:
        return
    y0 = RULER_H
    mid = y0 + WAVE_H / 2
    amp = WAVE_H / 2 - 4
    p.fillRect(QRectF(HEADER_W, y0, geo.width - HEADER_W, WAVE_H), theme.qc(theme.BG_MIRE))
    n = len(peaks)
    xs = np.arange(int(HEADER_W), int(geo.width))
    if len(xs) == 0:
        return
    t = geo.t0 + (xs - HEADER_W) / geo.pps
    i0 = np.clip((t * peaks_per_s).astype(int), 0, n)
    i1 = np.clip(((t + 1.0 / geo.pps) * peaks_per_s).astype(int) + 1, 0, n)
    valid = i1 > i0
    lines = []
    for x, a, b, ok in zip(xs, i0, i1, valid):
        if not ok:
            continue
        seg = peaks[a:b]
        lo, hi = float(seg[:, 0].min()), float(seg[:, 1].max())
        lines.append(QLineF(x + 0.5, mid - hi * amp, x + 0.5, mid - lo * amp + 0.5))
    p.setPen(QPen(theme.qc(theme.TEXT_DIM, 0.75), 1))
    p.drawLines(lines)
    p.setPen(QPen(theme.qc(theme.BORDER), 1))
    p.drawLine(QPointF(HEADER_W, y0 + WAVE_H - 0.5), QPointF(geo.width, y0 + WAVE_H - 0.5))


THUMB_LABEL_H = 16
LABEL_PAD = 4


def draw_markers(p, geo, tl):
    """Repères (marqueurs) dans la règle : un petit drapeau de leur couleur avec leur nom."""
    p.setFont(theme.ui_font(9, True))
    fm = p.fontMetrics()
    for m in tl.markers:
        x = geo.x(m.t)
        if x < HEADER_W - 2 or x > geo.width:
            continue
        w = fm.horizontalAdvance(m.name) + 8
        r = QRectF(x, LOOP_H, w, 11)
        p.fillRect(r, theme.qc(m.color))
        p.setPen(theme.qc("#000000"))
        p.drawText(r, Qt.AlignmentFlag.AlignCenter, m.name)


def draw_clip(p, geo, row, clip, ed, selected, muted, thumb=None):
    x, y, w, h = geo.clip_rect(row, clip)
    r = QRectF(x, y, w, h)
    d = ed.doc.library.get(clip.def_id)
    fill = theme.qc(theme.BG_HOVER) if selected else theme.qc(theme.BG_FIELD)
    p.setBrush(fill)
    p.setPen(Qt.PenStyle.NoPen)
    p.drawRoundedRect(r, 3, 3)
    # Barre de la couleur de la piste en haut du clip
    p.fillRect(QRectF(x + 1, y, max(0.0, w - 2), 2), theme.qc(row.track.color, 0.45 if muted else 1.0))
    # Vignettes de la forme tout le long du clip (une par carré, à l'instant de son centre)
    size = int(h - THUMB_LABEL_H - 2)
    if thumb is not None and size >= 12:
        p.save()
        p.setClipRect(r.adjusted(1, 1, -1, -1))
        ty = y + THUMB_LABEL_H
        left = max(x, HEADER_W - size)
        k = int(max(0.0, (left - x) // size))
        while x + k * size < min(x + w, geo.width):
            tx = x + k * size
            t_local = min(clip.duration, max(0.0, (k * size + size / 2) / geo.pps))
            pm = thumb(clip, t_local, size)
            if pm is not None:
                p.setOpacity(0.35 if muted else 1.0)
                p.drawPixmap(QPointF(tx + 1, ty), pm)
            k += 1
        p.restore()
    _draw_fades(p, geo, clip, x, y + THUMB_LABEL_H, h - THUMB_LABEL_H)
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.setPen(QPen(theme.qc(theme.ACCENT, 0.9) if selected else theme.qc(theme.BORDER), 1))
    p.drawRoundedRect(r, 3, 3)
    # Animation : chaîne = partagée avec d'autres clips de la forme, chaîne brisée = déliée (« Relier » possible)
    room = w - 2 * LABEL_PAD
    linked, shared = ed.clip_is_linked(clip)
    if w > 40 and (shared or not linked):
        ix, iy, iw, ih = link_icon_rect(geo, row, clip)
        p.drawPixmap(QPointF(ix + 1, iy + 1), icons.pixmap("link" if linked else "unlink", theme.TEXT_DIM, 12))
        room -= iw + 2
    if w > 20:
        p.setPen(theme.qc(theme.TEXT_OFF if muted else theme.TEXT))
        p.setFont(theme.ui_font(11))
        label = d.name if d else "?"
        fm = p.fontMetrics()
        p.drawText(QRectF(x + LABEL_PAD, y, room, THUMB_LABEL_H), Qt.AlignmentFlag.AlignVCenter,
                   fm.elidedText(label, Qt.TextElideMode.ElideRight, int(max(0, room))))
    p.setBrush(Qt.BrushStyle.NoBrush)


def _draw_fades(p, geo, clip, x, y, h):
    """Fondus d'entrée / de sortie : une diagonale du bas vers le haut (et inversement)."""
    if clip.fade_in <= 0 and clip.fade_out <= 0:
        return
    p.setPen(QPen(theme.qc(theme.TEXT, 0.8), 1))
    if clip.fade_in > 0:
        p.drawLine(QPointF(x, y + h), QPointF(x + clip.fade_in * geo.pps, y))
    if clip.fade_out > 0:
        xe = geo.x(clip.end)
        p.drawLine(QPointF(xe - clip.fade_out * geo.pps, y), QPointF(xe, y + h))


def draw_headers(p, geo, rows, ed):
    """Colonne de gauche : les pistes (couleur, nom, muet / solo)."""
    w = HEADER_W
    p.fillRect(QRectF(0, geo.top, w, geo.height - geo.top), theme.qc(theme.BG_PANEL))
    for r in rows:
        if r.y + r.h < geo.top or r.y > geo.height:
            continue
        p.fillRect(QRectF(0, r.y + 1, 3, r.h - 2), theme.qc(r.track.color))      # couleur de la piste
        p.setPen(theme.qc(theme.TEXT_OFF if r.track.muted else theme.TEXT))
        p.setFont(theme.ui_font(12))
        p.drawText(QRectF(10, r.y, w - 70, r.h), Qt.AlignmentFlag.AlignVCenter, r.track.name)
        for i, (label, on, col) in enumerate((("M", r.track.muted, theme.WARNING), ("S", r.track.solo, theme.ACCENT))):
            br = QRectF(w - 50 + i * 22, r.y + (r.h - 18) / 2, 18, 18)
            p.setPen(QPen(theme.qc(col) if on else theme.qc(theme.BORDER), 1))
            p.setBrush(theme.qc(col, 0.25) if on else Qt.BrushStyle.NoBrush)
            p.drawRoundedRect(br, 3, 3)
            p.setPen(theme.qc(theme.TEXT if on else theme.TEXT_DIM))
            p.setFont(theme.ui_font(10, True))
            p.drawText(br, Qt.AlignmentFlag.AlignCenter, label)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.setPen(QPen(theme.qc(theme.BORDER), 1))
        p.drawLine(QPointF(0, r.y + r.h - 0.5), QPointF(geo.width, r.y + r.h - 0.5))    # fin de la piste
    p.setPen(QPen(theme.qc(theme.BORDER), 1))
    p.drawLine(QPointF(w - 0.5, 0), QPointF(w - 0.5, geo.height))


def draw_corner(p, geo, tl):
    p.fillRect(QRectF(0, 0, HEADER_W, geo.top), theme.qc(theme.BG_PANEL))
    p.setPen(theme.qc(theme.TEXT_DIM))
    p.setFont(theme.mono_font(10))
    p.drawText(QRectF(10, 0, HEADER_W - 12, RULER_H), Qt.AlignmentFlag.AlignVCenter,
               f"{tl.bpm:g} BPM · {tl.beats_per_bar}/4")
    if geo.has_wave:
        p.setFont(theme.ui_font(11))
        name = tl.audio_path.replace("\\", "/").split("/")[-1]
        fm = p.fontMetrics()
        p.drawText(QRectF(10, RULER_H, HEADER_W - 14, WAVE_H), Qt.AlignmentFlag.AlignVCenter,
                   fm.elidedText(name, Qt.TextElideMode.ElideMiddle, HEADER_W - 14))
    p.setPen(QPen(theme.qc(theme.BORDER), 1))
    p.drawLine(QPointF(0, geo.top - 0.5), QPointF(HEADER_W, geo.top - 0.5))


def draw_playhead(p, geo, t):
    x = geo.x(t)
    if x < HEADER_W or x > geo.width:
        return
    p.setPen(QPen(theme.qc(theme.ACCENT), 1))
    p.drawLine(QPointF(x, LOOP_H), QPointF(x, geo.height))
    p.setBrush(theme.qc(theme.ACCENT))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawPolygon(QPolygonF([QPointF(x - 5, LOOP_H), QPointF(x + 5, LOOP_H), QPointF(x, LOOP_H + 7)]))
    p.setBrush(Qt.BrushStyle.NoBrush)
