"""Outils mathématiques : matrices affines 3x3, homographies, perspective.

Repère de travail : coordonnées normalisées, la mire va de -1 à 1 sur chaque axe, Y vers le haut.
"""

import math

import numpy as np

FOCAL = 2.5  # distance de la « caméra » pour les inclinaisons 3D (unités de mire)


def affine(a=1.0, b=0.0, c=0.0, d=1.0, tx=0.0, ty=0.0):
    """Matrice 3x3 : x' = a*x + b*y + tx ; y' = c*x + d*y + ty."""
    return np.array([[a, b, tx], [c, d, ty], [0.0, 0.0, 1.0]])


def translation(tx, ty):
    return affine(tx=tx, ty=ty)


def rotation(deg):
    r = math.radians(deg)
    cs, sn = math.cos(r), math.sin(r)
    return affine(cs, -sn, sn, cs)


def scaling(sx, sy):
    return affine(sx, 0.0, 0.0, sy)


def about(m, cx, cy):
    """Applique la matrice m autour du point (cx, cy)."""
    return translation(cx, cy) @ m @ translation(-cx, -cy)


def apply(m, pts):
    """Applique une matrice affine (ou une homographie) à un tableau (N, 2)."""
    if len(pts) == 0:
        return pts
    out = pts @ m[:2, :2].T + m[:2, 2]
    if m[2, 0] != 0.0 or m[2, 1] != 0.0 or m[2, 2] != 1.0:
        w = pts @ m[2, :2] + m[2, 2]
        w = np.where(np.abs(w) < 1e-9, 1e-9, w)
        out = out / w[:, None]
    return out


def apply_point(m, x, y):
    p = apply(m, np.array([[x, y]], dtype=float))
    return float(p[0, 0]), float(p[0, 1])


def homography(src, dst):
    """Homographie 3x3 qui envoie 4 points src sur 4 points dst."""
    rows = []
    rhs = []
    for (x, y), (u, v) in zip(src, dst):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        rhs.append(u)
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        rhs.append(v)
    try:
        h = np.linalg.solve(np.array(rows, dtype=float), np.array(rhs, dtype=float))
    except np.linalg.LinAlgError:
        return np.eye(3)
    return np.array([[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1.0]])


def tilt(pts, tilt_x, tilt_y, cx, cy, z=0.0, focal=FOCAL):
    """Incline les points autour de X puis Y (degrés) autour de (cx, cy) et projette en perspective.

    tilt_x : bascule haut/bas (rotation autour de l'axe horizontal)
    tilt_y : bascule gauche/droite (rotation autour de l'axe vertical)
    z      : éloignement supplémentaire (profondeur)
    """
    if len(pts) == 0 or (tilt_x == 0.0 and tilt_y == 0.0 and z == 0.0):
        return pts
    x = pts[:, 0] - cx
    y = pts[:, 1] - cy
    ax = math.radians(tilt_x)
    ay = math.radians(tilt_y)
    # Rotation autour de X
    y1 = y * math.cos(ax)
    z1 = y * math.sin(ax)
    # Rotation autour de Y
    x2 = x * math.cos(ay) + z1 * math.sin(ay)
    z2 = -x * math.sin(ay) + z1 * math.cos(ay)
    depth = focal + z2 + z
    depth = np.where(depth < 0.05, 0.05, depth)
    k = focal / depth
    return np.column_stack((cx + x2 * k, cy + y1 * k))


def bbox(pts):
    """(xmin, ymin, xmax, ymax) ou None si vide."""
    if pts is None or len(pts) == 0:
        return None
    mn = pts.min(axis=0)
    mx = pts.max(axis=0)
    return float(mn[0]), float(mn[1]), float(mx[0]), float(mx[1])


def union_bbox(boxes):
    boxes = [b for b in boxes if b is not None]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def decompose(m):
    """Décompose la partie 2x2 d'une matrice affine en (rotation°, sx, sy, cisaillement).

    m2 = R(rot) @ [[sx, sh], [0, sy]]
    """
    a, b, c, d = m[0, 0], m[0, 1], m[1, 0], m[1, 1]
    rot = math.degrees(math.atan2(c, a))
    sx = math.hypot(a, c)
    r = math.radians(-rot)
    cs, sn = math.cos(r), math.sin(r)
    # U = R(-rot) @ m2
    u01 = cs * b - sn * d
    u11 = sn * b + cs * d
    return rot, sx, u11, u01


def dist_point_segments(p, pts, closed=False):
    """Distance minimale d'un point à une polyligne (N, 2)."""
    if len(pts) == 0:
        return float("inf")
    if len(pts) == 1:
        return float(np.hypot(*(pts[0] - p)))
    a = pts[:-1]
    b = pts[1:]
    if closed:
        a = np.vstack((a, pts[-1:]))
        b = np.vstack((b, pts[:1]))
    ab = b - a
    ap = p - a
    den = (ab * ab).sum(axis=1)
    den = np.where(den < 1e-12, 1e-12, den)
    t = np.clip((ap * ab).sum(axis=1) / den, 0.0, 1.0)
    proj = a + ab * t[:, None]
    return float(np.min(np.hypot(*(proj - p).T)))


def point_in_polygon(p, poly):
    """Test pair-impair."""
    x, y = p
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside
