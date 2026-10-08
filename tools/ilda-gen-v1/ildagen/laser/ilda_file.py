"""Écriture de fichiers ILDA (.ild) : formats 0, 1 (palette) et 4, 5 (couleurs réelles).

Limites du format : 65 535 points par image et 65 535 images (compteurs sur 16 bits) ; au-delà, l'écriture
est refusée avec un message clair. Le fichier est écrit à côté puis renommé : un export raté ne laisse
jamais de fichier tronqué.

Formats à palette (0 et 1) : la palette ILDA n'a que 64 couleurs vives, sans niveaux de luminosité. Chaque
point prend la teinte la plus proche de sa couleur ramenée à pleine luminosité, et la luminosité est rendue
par un tramage : la proportion de points allumés le long de l'image suit la luminosité (un rouge à 50 % allume
un point sur deux, un rouge à 1/255 presque aucun).
"""

import os

import numpy as np

MAX_POINTS = 65535
MAX_FRAMES = 65535

FORMATS = [
    (5, "Format 5 — 2D, couleurs réelles (recommandé)"),
    (4, "Format 4 — 3D, couleurs réelles"),
    (1, "Format 1 — 2D, palette 64 couleurs (luminosité tramée)"),
    (0, "Format 0 — 3D, palette 64 couleurs (luminosité tramée)"),
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
    return (b"ILDA" + bytes(3) + bytes([fmt]) + nm + company + int(count).to_bytes(2, "big")
            + int(frame_no).to_bytes(2, "big") + int(total).to_bytes(2, "big") + bytes(2))


def palette_map(r, g, b):
    """(indices de palette, points allumés) : teinte la plus proche, luminosité rendue par tramage."""
    c = np.column_stack((r, g, b)).astype(float)
    m = c.max(axis=1) if len(c) else np.zeros(0)
    hue = c * (255.0 / np.where(m > 0, m, 1.0))[:, None]
    idx = ((hue[:, None, :] - PALETTE[None, :, :]) ** 2).sum(axis=2).argmin(axis=1).astype(np.uint8)
    cum = np.cumsum(m / 255.0)
    lit = np.floor(cum + 0.5) - np.floor(np.concatenate(([0.0], cum[:-1])) + 0.5) >= 1
    return idx, lit & (m > 0)


def frame_bytes(fmt, x, y, r, g, b, frame_no, total, name="ILDAGEN"):
    n = len(x)
    if n > MAX_POINTS:
        raise ValueError(f"Image {frame_no + 1} : {n} points, le format ILDA en accepte au plus {MAX_POINTS}.")
    is3d = fmt in (0, 4)
    fields = [("x", ">i2"), ("y", ">i2")] + ([("z", ">i2")] if is3d else []) + [("s", "u1")]
    if fmt in (4, 5):
        fields += [("b", "u1"), ("g", "u1"), ("r", "u1")]
        lit = (r > 0) | (g > 0) | (b > 0)
    else:
        fields += [("c", "u1")]
        idx, lit = palette_map(r, g, b)
    rec = np.zeros(n, dtype=np.dtype(fields))
    rec["x"] = x
    rec["y"] = y
    status = np.where(lit, 0, 0x40).astype(np.uint8)
    if n:
        status[-1] |= 0x80
    rec["s"] = status
    if fmt in (4, 5):
        rec["r"], rec["g"], rec["b"] = r, g, b
    else:
        rec["c"] = idx
    return _header(fmt, n, frame_no, total, name) + rec.tobytes()


def write_ilda(path, frames, fmt=5, name="ILDAGEN"):
    """frames : liste de (x, y, r, g, b). Les images vides deviennent un point éteint.
    Écrit dans un fichier temporaire puis le renomme (jamais de fichier tronqué)."""
    total = len(frames)
    if total > MAX_FRAMES:
        raise ValueError(f"{total} images : le format ILDA en accepte au plus {MAX_FRAMES}. "
                         "Réduisez la cadence ou la durée exportée.")
    tmp = path + ".tmp"
    try:
        with open(tmp, "wb") as f:
            for i, (x, y, r, g, b) in enumerate(frames):
                if len(x) == 0:
                    z16 = np.zeros(1, dtype=np.int16)
                    z8 = np.zeros(1, dtype=np.uint8)
                    x, y, r, g, b = z16, z16, z8, z8, z8
                f.write(frame_bytes(fmt, x, y, r, g, b, i, total, name))
            f.write(_header(fmt, 0, 0, total, name))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
