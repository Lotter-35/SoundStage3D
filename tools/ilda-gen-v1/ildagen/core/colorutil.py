"""Couleurs : conversions TSV vectorisées, dégradés."""

import numpy as np


def rgb_to_hsv(c):
    """c (N, 3) dans 0..1 → (N, 3) teinte 0..1, saturation, valeur."""
    r, g, b = c[:, 0], c[:, 1], c[:, 2]
    mx = c.max(axis=1)
    mn = c.min(axis=1)
    d = mx - mn
    h = np.zeros(len(c))
    nz = d > 1e-9
    rm = nz & (mx == r)
    gm = nz & (mx == g) & ~rm
    bm = nz & ~rm & ~gm
    h[rm] = ((g[rm] - b[rm]) / d[rm]) % 6
    h[gm] = (b[gm] - r[gm]) / d[gm] + 2
    h[bm] = (r[bm] - g[bm]) / d[bm] + 4
    h = h / 6.0
    s = np.where(mx > 1e-9, d / np.where(mx > 1e-9, mx, 1.0), 0.0)
    return np.column_stack((h % 1.0, s, mx))


def hsv_to_rgb(hsv):
    h = (hsv[:, 0] % 1.0) * 6.0
    s = np.clip(hsv[:, 1], 0, 1)
    v = np.clip(hsv[:, 2], 0, 1)
    i = np.floor(h).astype(int) % 6
    f = h - np.floor(h)
    p = v * (1 - s)
    q = v * (1 - s * f)
    t = v * (1 - s * (1 - f))
    out = np.empty((len(h), 3))
    sel = [(i == k) for k in range(6)]
    for k, (a, b, c) in enumerate([(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]):
        m = sel[k]
        out[m, 0], out[m, 1], out[m, 2] = a[m], b[m], c[m]
    return out


def hue_colors(h, s=1.0, v=1.0):
    h = np.asarray(h, dtype=float)
    return hsv_to_rgb(np.column_stack((h, np.full(len(h), s), np.full(len(h), v))))


def sample_gradient(stops, t):
    """stops : [[pos, r, g, b], …] (pos 0..1) ; t (N,) → couleurs (N, 3)."""
    st = sorted(([float(x) for x in s] for s in stops), key=lambda s: s[0])
    if not st:
        return np.ones((len(t), 3))
    pos = np.array([s[0] for s in st])
    cols = np.array([s[1:4] for s in st])
    out = np.empty((len(t), 3))
    for k in range(3):
        out[:, k] = np.interp(t, pos, cols[:, k])
    return out


def wrap_t(t, mode):
    """mode 0 = étendre, 1 = répéter, 2 = miroir."""
    if mode == 1:
        return t % 1.0
    if mode == 2:
        return 1.0 - np.abs((t % 2.0) - 1.0)
    return np.clip(t, 0.0, 1.0)


def to_hex(c):
    return "#%02x%02x%02x" % tuple(int(round(max(0.0, min(1.0, v)) * 255)) for v in c[:3])


def from_hex(s):
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


# Couleurs « pures » d'un laser RVB
LASER_COLORS = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0), (0, 1, 1), (1, 0, 1), (1, 1, 1)]
