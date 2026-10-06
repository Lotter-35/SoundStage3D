"""Dessin de la timeline : grille musicale, règle, forme d'onde, pistes, clips, automations, tête de lecture."""

import math

import numpy as np
from PySide6.QtCore import QLineF, QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPen, QPolygonF

from ...core.timeline import SUBDIVISIONS
from .. import icons, theme
from . import lanes as L
from .geometry import CHEVRON_W, HEADER_W, LOOP_H, RULER_H, WAVE_H

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
        c = theme.qc(theme.ACCENT, 0.55) if tl.loop_on else theme.qc(theme.TEXT_OFF, 0.45)
        p.fillRect(QRectF(max(HEADER_W, x0), 1, max(0.0, min(w, x1) - max(HEADER_W, x0)), LOOP_H - 2), c)
        if tl.loop_on:
            p.fillRect(QRectF(max(HEADER_W, x0), RULER_H, max(0.0, min(w, x1) - max(HEADER_W, x0)), geo.height),
                       theme.qc(theme.ACCENT, 0.04))
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


def render_thumb(ed, clip, t_local, size):
    """Petite mire : la forme du clip à l'instant t_local."""
    from PySide6.QtGui import QPainter, QPixmap
    from ...core.evaluator import EvalContext, evaluate
    from ..canvas.painter import draw_strokes
    from ..canvas.viewport import FILL, Viewport
    pm = QPixmap(size * 2, size * 2)
    pm.setDevicePixelRatio(2.0)
    pm.fill(theme.qc(theme.BG_MIRE))
    d = ed.doc.library.get(clip.def_id)
    if d is None:
        return pm
    ctx = EvalContext(ed.doc.library, clip.start + t_local, ed.doc.timeline.bpm, ed.default_color(),
                      clip.overrides_at(t_local))
    vt = Viewport()
    vt.resize(size, size)
    vt.zoom = 0.5 / FILL
    qp = QPainter(pm)
    qp.setRenderHint(QPainter.RenderHint.Antialiasing)
    draw_strokes(qp, vt, evaluate(d.root, ctx), width=1.0)
    qp.end()
    return pm


def draw_clip(p, geo, row, clip, ed, selected, muted, thumb=None):
    x, y, w, h = geo.clip_rect(row, clip)
    r = QRectF(x, y, w, h)
    d = ed.doc.library.get(clip.def_id)
    fill = theme.qc(theme.ACCENT, 0.22) if selected else theme.qc(theme.BG_FIELD)
    p.setBrush(fill)
    p.setPen(Qt.PenStyle.NoPen)
    p.drawRoundedRect(r, 3, 3)
    # Vignettes de la forme tout le long du clip (une par carré, à l'instant de son centre)
    size = int(h - THUMB_LABEL_H - 2)
    if thumb is not None and size >= 12:
        p.save()
        p.setClipRect(r.adjusted(1, 1, -1, -1))
        ty = y + THUMB_LABEL_H
        left = max(x, HEADER_W - size)
        k0 = int(max(0.0, (left - x) // size))
        k = k0
        while x + k * size < min(x + w, geo.width):
            tx = x + k * size
            t_local = min(clip.duration, max(0.0, (k * size + size / 2) / geo.pps))
            p.setOpacity(0.35 if muted else 1.0)
            p.drawPixmap(QPointF(tx + 1, ty), thumb(clip, t_local, size))
            k += 1
        p.restore()
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.setPen(QPen(theme.qc(theme.ACCENT) if selected else theme.qc(theme.BORDER), 1.5 if selected else 1))
    p.drawRoundedRect(r, 3, 3)
    if w > CHEVRON_W + 4:
        pm = icons.pixmap("chevron-down" if clip.expanded else "chevron-right", theme.TEXT_DIM, 12)
        p.drawPixmap(QPointF(x + 3, y + (THUMB_LABEL_H - 12) / 2), pm)
    if w > CHEVRON_W + 20:
        p.setPen(theme.qc(theme.TEXT_OFF if muted else theme.TEXT))
        p.setFont(theme.ui_font(11))
        label = d.name if d else "?"
        if clip.automations:
            label += f"   · {len(clip.automations)} automation" + ("s" if len(clip.automations) > 1 else "")
        fm = p.fontMetrics()
        p.drawText(QRectF(x + CHEVRON_W + 2, y, w - CHEVRON_W - 6, THUMB_LABEL_H), Qt.AlignmentFlag.AlignVCenter,
                   fm.elidedText(label, Qt.TextElideMode.ElideRight, int(w - CHEVRON_W - 6)))
    p.setBrush(Qt.BrushStyle.NoBrush)


def draw_lane(p, geo, row, ed, sel_key):
    clip, auto = row.clip, row.auto
    x0, x1 = geo.x(clip.start), geo.x(clip.end)
    p.fillRect(QRectF(HEADER_W, row.y, geo.width - HEADER_W, row.h), theme.qc(theme.BG_APP))
    p.fillRect(QRectF(x0, row.y + 1, x1 - x0, row.h - 2), theme.qc(theme.BG_PANEL))
    if auto.armed:
        p.setPen(theme.qc(theme.ACCENT))
        p.setFont(theme.ui_font(11))
        p.drawText(QRectF(max(HEADER_W, x0) + 8, row.y, max(10.0, x1 - max(HEADER_W, x0) - 16), row.h),
                   Qt.AlignmentFlag.AlignVCenter, "En attente : modifiez un réglage (Propriétés ou mire)")
        return
    node, spec = L.target(ed, clip, auto)
    rng = L.value_range(spec, auto)
    a, b = max(HEADER_W, x0), min(geo.width, x1)
    if b <= a:
        return
    xs = np.arange(a, b + 1, 2.0)
    if not auto.keys and node is not None:
        # Réglage pas encore animé : sa valeur fixe en pointillés (cliquer pour poser une clé)
        from ...core import nodes as N
        v = N.get_param(node, auto.key)
        if L.is_color(spec) and v is not None:
            p.fillRect(QRectF(a, row.y + row.h / 2 - 3, b - a, 6), QColor.fromRgbF(*v))
        elif v is not None:
            y = L.v_to_y(v, row, rng)
            pen = QPen(theme.qc(theme.TEXT_OFF), 1, Qt.PenStyle.DashLine)
            p.setPen(pen)
            p.drawLine(QPointF(a, y), QPointF(b, y))
        return
    if L.is_color(spec):
        for x in xs:
            v = auto.value_at(geo.t(x) - clip.start)
            if v is not None:
                p.fillRect(QRectF(x, row.y + row.h / 2 - 6, 2.0, 12), QColor.fromRgbF(*v))
    elif auto.keys:
        pts = [QPointF(x, L.v_to_y(auto.value_at(geo.t(x) - clip.start), row, rng)) for x in xs]
        p.setPen(QPen(theme.qc(theme.ACCENT), 1.5))
        p.drawPolyline(QPolygonF(pts))
    # Clés
    for k in auto.keys:
        kx = geo.x(clip.start + k.t)
        if kx < HEADER_W - 6 or kx > geo.width + 6:
            continue
        ky = row.y + row.h / 2 if L.is_color(spec) else L.v_to_y(k.v, row, rng)
        is_sel = sel_key is k
        p.setPen(QPen(theme.qc(theme.ACCENT), 1.2))
        if L.is_color(spec):
            p.setBrush(QColor.fromRgbF(*k.v))
        else:
            p.setBrush(theme.qc(theme.ACCENT) if is_sel else theme.qc(theme.BG_MIRE))
        p.drawPolygon(QPolygonF([QPointF(kx, ky - 5), QPointF(kx + 5, ky), QPointF(kx, ky + 5), QPointF(kx - 5, ky)]))
        if is_sel:
            p.setPen(theme.qc(theme.TEXT))
            p.setFont(theme.mono_font(10))
            p.drawText(QPointF(kx + 8, max(row.y + 11, ky - 6)), L.format_value(k.v, spec))
    p.setBrush(Qt.BrushStyle.NoBrush)
    # Poignées de Bézier de la clé sélectionnée
    if sel_key is not None and sel_key in auto.keys and sel_key.curve == "custom" and not L.is_color(spec):
        h = bezier_handles(geo, row, clip, auto, sel_key, rng)
        if h is not None:
            (ax, ay), (bx, by), (h1x, h1y), (h2x, h2y) = h
            p.setPen(QPen(theme.qc(theme.TEXT_DIM), 1))
            p.drawLine(QPointF(ax, ay), QPointF(h1x, h1y))
            p.drawLine(QPointF(bx, by), QPointF(h2x, h2y))
            p.setBrush(theme.qc(theme.TEXT))
            p.drawEllipse(QPointF(h1x, h1y), 3.5, 3.5)
            p.drawEllipse(QPointF(h2x, h2y), 3.5, 3.5)
            p.setBrush(Qt.BrushStyle.NoBrush)


def bezier_handles(geo, row, clip, auto, key, rng):
    i = auto.keys.index(key)
    if i + 1 >= len(auto.keys):
        return None
    nxt = auto.keys[i + 1]
    ax, bx = geo.x(clip.start + key.t), geo.x(clip.start + nxt.t)
    ay, by = L.v_to_y(key.v, row, rng), L.v_to_y(nxt.v, row, rng)
    x1, y1, x2, y2 = key.h
    return (ax, ay), (bx, by), (ax + x1 * (bx - ax), ay + y1 * (by - ay)), (ax + x2 * (bx - ax), ay + y2 * (by - ay))


def draw_group(p, geo, row):
    """Ligne d'un modifieur sous un clip déplié."""
    clip = row.clip
    x0, x1 = geo.x(clip.start), geo.x(clip.end)
    p.fillRect(QRectF(HEADER_W, row.y, geo.width - HEADER_W, row.h), theme.qc(theme.BG_APP))
    p.fillRect(QRectF(x0, row.y + 1, x1 - x0, row.h - 2), theme.qc(theme.ACCENT, 0.06))


def draw_headers(p, geo, rows, ed):
    w = HEADER_W
    p.fillRect(QRectF(0, geo.top, w, geo.height - geo.top), theme.qc(theme.BG_PANEL))
    p.setFont(theme.ui_font(12))
    for r in rows:
        if r.y + r.h < geo.top or r.y > geo.height:
            continue
        if r.kind == "track":
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
        elif r.kind == "group":
            m = r.node
            opened = m.id not in r.clip.closed_nodes
            p.drawPixmap(QPointF(10, r.y + (r.h - 12) / 2),
                         icons.pixmap("chevron-down" if opened else "chevron-right", theme.TEXT_DIM, 12))
            p.drawPixmap(QPointF(24, r.y + (r.h - 14) / 2), icons.pixmap(m.modifier.icon, theme.ACCENT, 14))
            p.setFont(theme.ui_font(11))
            p.setPen(theme.qc(theme.TEXT))
            fm = p.fontMetrics()
            p.drawText(QRectF(44, r.y, w - 50, r.h), Qt.AlignmentFlag.AlignVCenter,
                       fm.elidedText(m.name, Qt.TextElideMode.ElideRight, w - 50))
        else:
            p.setFont(theme.ui_font(11))
            if r.node is not None:
                animated = bool(r.auto.keys)
                label = r.label
                x = 44
                p.setPen(theme.qc(theme.TEXT if animated else theme.TEXT_DIM))
                if animated:
                    p.setBrush(theme.qc(theme.ACCENT))
                    p.setPen(Qt.PenStyle.NoPen)
                    p.drawEllipse(QPointF(34, r.y + r.h / 2), 3, 3)
                    p.setBrush(Qt.BrushStyle.NoBrush)
                    p.setPen(theme.qc(theme.TEXT))
            else:
                x = 22
                p.setPen(theme.qc(theme.ACCENT if r.auto.armed else theme.TEXT_DIM))
                label = "Automation en attente…" if r.auto.armed else r.auto.label
            fm = p.fontMetrics()
            p.drawText(QRectF(x, r.y, w - x - 6, r.h), Qt.AlignmentFlag.AlignVCenter,
                       fm.elidedText(label, Qt.TextElideMode.ElideRight, w - x - 6))
        p.setPen(QPen(theme.qc(theme.BORDER), 1))
        p.drawLine(QPointF(0, r.y + r.h - 0.5), QPointF(geo.width, r.y + r.h - 0.5))
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
