"""Écriture de fichiers ILDA (.ild) : formats 0, 1 (palette) et 4, 5 (couleurs réelles)."""

import struct

import numpy as np

FORMATS = [
    (5, "Format 5 — 2D, couleurs réelles (recommandé)"),
    (4, "Format 4 — 3D, couleurs réelles"),
    (1, "Format 1 — 2D, palette 64 couleurs"),
    (0, "Format 0 — 3D, palette 64 couleurs"),
]


def default_palette():
    """Palette ILDA standard (64 couleurs)."""
    pal = []
    pal += [(255, i * 16, 0) for i in range(16)]
    pal += [(255 - i * 32, 255, 0) for i in range(8)]
    pal += [(0, 255, round(i * 36.43)) for i in range(8)]
    pal += [(0, round(255 - i * 28.4), 255) for i in range(8)]
    pal += [(i * 32, 0, 255) for i in range(8)]
    pal += [(255, i * 32, 255) for i in range(8)]
    pal += [(255, 255 - i * 32, 255 - i * 32) for i in range(8)]
    return np.array(pal, dtype=float)


PALETTE = default_palette()


def _header(fmt, count, frame_no, total, name="ILDAGEN"):
    nm = name.encode("ascii", "replace")[:8].ljust(8, b" ")
    company = b"ILDAGEN ".ljust(8, b" ")
    return b"ILDA" + bytes(3) + bytes([fmt]) + nm + company + struct.pack(">HHHBB", count, frame_no, total, 0, 0)


def _palette_index(r, g, b):
    c = np.column_stack((r, g, b)).astype(float)
    d = ((c[:, None, :] - PALETTE[None, :, :]) ** 2).sum(axis=2)
    return d.argmin(axis=1).astype(np.uint8)


def frame_bytes(fmt, x, y, r, g, b, frame_no, total, name="ILDAGEN"):
    n = len(x)
    lit = (r > 0) | (g > 0) | (b > 0)
    status = np.where(lit, 0, 0x40).astype(np.uint8)
    if n:
        status[-1] |= 0x80
    is3d = fmt in (0, 4)
    fields = [("x", ">i2"), ("y", ">i2")] + ([("z", ">i2")] if is3d else []) + [("s", "u1")]
    if fmt in (4, 5):
        fields += [("b", "u1"), ("g", "u1"), ("r", "u1")]
    else:
        fields += [("c", "u1")]
    rec = np.zeros(n, dtype=np.dtype(fields))
    rec["x"] = x
    rec["y"] = y
    rec["s"] = status
    if fmt in (4, 5):
        rec["r"], rec["g"], rec["b"] = r, g, b
    else:
        rec["c"] = _palette_index(r, g, b)
    return _header(fmt, n, frame_no, total, name) + rec.tobytes()


def write_ilda(path, frames, fmt=5, name="ILDAGEN"):
    """frames : liste de (x, y, r, g, b). Les images vides deviennent un point éteint."""
    total = len(frames)
    with open(path, "wb") as f:
        for i, (x, y, r, g, b) in enumerate(frames):
            if len(x) == 0:
                z16 = np.zeros(1, dtype=np.int16)
                z8 = np.zeros(1, dtype=np.uint8)
                x, y, r, g, b = z16, z16, z8, z8, z8
            f.write(frame_bytes(fmt, x, y, r, g, b, i, total, name))
        f.write(_header(fmt, 0, 0, total, name))
