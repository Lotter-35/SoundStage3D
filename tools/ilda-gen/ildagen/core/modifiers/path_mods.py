"""Modifieurs de tracé : pointillés, tirets, dessin progressif, masque, beams."""

import numpy as np

from ..limits import MAX_PIECES
from ..params import F, I, B, E
from ..path import Stroke, closed_pts, cumulative, sample_at, resample_share, resample_stroke
from .base import Modifier

SCOPES = ["Par tracé", "Global (tous les tracés)"]


def _interp_col(col, idx, t):
    nxt = np.minimum(idx + 1, len(col) - 1)
    return col[idx] + (col[nxt] - col[idx]) * t[:, None]


def measure(s):
    """Points, couleurs (fermeture incluse), longueurs cumulées, longueur totale."""
    pts = closed_pts(s.pts, s.closed)
    col = closed_pts(s.col, s.closed)
    cum = cumulative(pts)
    return pts, col, cum, float(cum[-1]) if len(cum) else 0.0


def at(pts, col, cum, s_arr):
    s_arr = np.asarray(s_arr, dtype=float)
    p, idx, t = sample_at(pts, cum, s_arr)
    return p, _interp_col(col, idx, t)


def extract(pts, col, cum, a, b):
    """Morceau du tracé entre les abscisses a < b."""
    pa, ca = at(pts, col, cum, [a, b])
    i0 = int(np.searchsorted(cum, a, side="right"))
    i1 = int(np.searchsorted(cum, b, side="left"))
    p = np.vstack((pa[:1], pts[i0:i1], pa[1:]))
    c = np.vstack((ca[:1], col[i0:i1], ca[1:]))
    return p, c


def extract_many(pts, col, cum, a, b):
    """Morceaux du tracé entre les abscisses a[k] < b[k], calculés d'un coup (tirets)."""
    pa, ca = at(pts, col, cum, a)
    pb, cb = at(pts, col, cum, b)
    i0 = np.searchsorted(cum, a, side="right")
    inner = np.maximum(0, np.searchsorted(cum, b, side="left") - i0)
    sizes = inner + 2
    ends = np.cumsum(sizes)
    offs = ends - sizes
    P = np.empty((int(ends[-1]), 2))
    C = np.empty((int(ends[-1]), 3))
    P[offs], C[offs] = pa, ca
    P[ends - 1], C[ends - 1] = pb, cb
    n_in = int(inner.sum())
    if n_in:
        k = np.repeat(np.arange(len(a)), inner)
        j = np.arange(n_in) - np.repeat(np.cumsum(inner) - inner, inner)
        P[offs[k] + 1 + j] = pts[i0[k] + j]
        C[offs[k] + 1 + j] = col[i0[k] + j]
    return [P[a:z] for a, z in zip(offs, ends)], [C[a:z] for a, z in zip(offs, ends)]


def measured_lines(strokes):
    """measure() des lignes mesurables (None pour les autres) et leur longueur totale."""
    ms = []
    for s in strokes:
        m = measure(s) if s.kind == "line" and len(s.pts) >= 2 else None
        ms.append(m if m is not None and np.isfinite(m[3]) else None)
    return ms, sum(m[3] for m in ms if m is not None)


class Dots(Modifier):
    type_id = "dots"
    label = "Dots"
    category = "Tracé"
    icon = "ellipsis"
    description = "Transforme les lignes en suite de points. Une Translation X posée dessus décale les points (phase)."
    params = [F("spacing", "Espacement", 0.06, 0.002, 4.0, decimals=3, soft_max=0.5),
              I("size", "Éclat", 3, 1, 60),
              F("phase", "Phase", 0.0, -100.0, 100.0, decimals=3, soft_min=-1, soft_max=1),
              B("ends", "Premier et dernier point", True)]
    phase_key = "phase"
    size_keys = ("spacing",)

    def apply(self, strokes, p, ctx):
        sp = max(1e-3, p["spacing"])
        ms, total = measured_lines(strokes)
        if total / sp > MAX_PIECES:
            sp = total / MAX_PIECES        # garde-fou : tracé démesuré, points plus espacés
        out = []
        for s, m in zip(strokes, ms):
            if m is None:
                if s.kind != "line" or len(s.pts) < 2:
                    out.append(s.copy())
                continue
            pts, col, cum, L = m
            first = p["phase"] % sp
            pos = np.arange(first, L + (0 if s.closed else 1e-9), sp)
            if s.closed:
                pos = pos[pos < L - 1e-9]
            elif p.get("ends", True) and L > 0:
                # Un point au tout début et un à la toute fin (le tracé ne s'arrête pas sur un vide) ;
                # les points trop proches d'une extrémité sont retirés pour ne pas faire de paquet
                gap = 0.5 * sp
                pos = pos[(pos > gap) & (pos < L - gap)]
                pos = np.concatenate(([0.0], pos, [L]))
            if len(pos) == 0:
                continue
            dp, dc = at(pts, col, cum, pos)
            out.append(Stroke(dp, dc, False, "dots", int(p["size"])))
        return out


class Dashes(Modifier):
    type_id = "dashes"
    label = "Tirets"
    category = "Tracé"
    icon = "equal"
    description = "Découpe les lignes en tirets."
    params = [F("dash", "Tiret", 0.08, 0.002, 4.0, decimals=3, soft_max=0.5),
              F("gap", "Espace", 0.05, 0.002, 4.0, decimals=3, soft_max=0.5),
              F("phase", "Phase", 0.0, -100.0, 100.0, decimals=3, soft_min=-1, soft_max=1)]
    phase_key = "phase"
    size_keys = ("dash", "gap")

    def apply(self, strokes, p, ctx):
        dash, gap = max(1e-3, p["dash"]), max(1e-3, p["gap"])
        ms, total = measured_lines(strokes)
        n = total / (dash + gap) + 2 * len(strokes)
        if n > MAX_PIECES:
            # Garde-fou : tracé démesuré, tirets agrandis (même proportion tiret / espace)
            dash, gap = dash * n / MAX_PIECES, gap * n / MAX_PIECES
        period = dash + gap
        out = []
        for s, m in zip(strokes, ms):
            if m is None:
                if s.kind != "line" or len(s.pts) < 2:
                    out.append(s.copy())
                continue
            pts, col, cum, L = m
            start = (p["phase"] % period) - period
            # +1 : à très grande échelle, la précision des nombres peut faire « perdre » le dernier tiret
            starts = start + period * np.arange(int(np.ceil((L - start) / period)) + 1)
            a = np.maximum(0.0, starts)
            b = np.minimum(L, starts + dash)
            keep = b - a > 1e-6
            if not keep.any():
                continue
            for dp, dc in zip(*extract_many(pts, col, cum, a[keep], b[keep])):
                out.append(Stroke(dp, dc, False))
        return out


class Trim(Modifier):
    type_id = "trim"
    label = "Dessin progressif"
    category = "Tracé"
    icon = "pen-line"
    description = "N'affiche que la portion du tracé entre Début et Fin (effet « se dessine »)."
    params = [F("start", "Début", 0.0, 0.0, 100.0, "%", 1),
              F("end", "Fin", 100.0, 0.0, 100.0, "%", 1),
              F("offset", "Décalage", 0.0, -10000.0, 10000.0, "%", 1, soft_min=-100, soft_max=100),
              E("scope", "Portée", SCOPES)]
    phase_key = "offset"
    phase_scale = 50.0

    def apply(self, strokes, p, ctx):
        a = p["start"] / 100.0
        b = p["end"] / 100.0
        if b <= a:
            return [s for s in strokes if s.kind != "line"]
        off = p["offset"] / 100.0
        lines = [s for s in strokes if s.kind == "line" and len(s.pts) >= 2]
        others = [s.copy() for s in strokes if not (s.kind == "line" and len(s.pts) >= 2)]
        out = []
        if p["scope"] == 0:
            for s in lines:
                out.extend(self._window(s, a + off, b + off, s.closed))
        else:
            ms = [measure(s) for s in lines]
            total = sum(m[3] for m in ms)
            if total <= 0:
                return others
            # Le décalage boucle sur la longueur totale (sinon tout s'éteint au-delà de ±100 %)
            A, B_ = (a + off % 1.0) * total, (b + off % 1.0) * total
            g0 = 0.0
            for s, m in zip(lines, ms):
                L = m[3]
                for shift in (-total, 0.0, total):
                    lo, hi = max(A + shift, g0), min(B_ + shift, g0 + L)
                    if hi - lo > 1e-6:
                        dp, dc = extract(m[0], m[1], m[2], lo - g0, hi - g0)
                        out.append(Stroke(dp, dc, False))
                g0 += L
        return out + others

    @staticmethod
    def _window(s, a, b, closed):
        pts, col, cum, L = measure(s)
        if L <= 0:
            return []
        if b - a >= 1.0 and closed:
            return [s.copy()]
        if closed:
            a0 = (a % 1.0) * L
            length = (b - a) * L
            if a0 + length <= L:
                dp, dc = extract(pts, col, cum, a0, a0 + length)
                return [Stroke(dp, dc, False)]
            p1, c1 = extract(pts, col, cum, a0, L)
            p2, c2 = extract(pts, col, cum, 0.0, a0 + length - L)
            return [Stroke(np.vstack((p1, p2[1:])), np.vstack((c1, c2[1:])), False)]
        lo, hi = max(0.0, a * L), min(L, b * L)
        if hi - lo <= 1e-6:
            return []
        dp, dc = extract(pts, col, cum, lo, hi)
        return [Stroke(dp, dc, False)]


class Mask(Modifier):
    type_id = "mask"
    label = "Masque de zone"
    category = "Tracé"
    icon = "square-dashed"
    description = "N'affiche que ce qui est dans (ou hors de) une zone."
    params = [E("shape", "Forme", ["Rectangle", "Ellipse"]),
              F("cx", "Centre X", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3),
              F("cy", "Centre Y", 0.0, -4.0, 4.0, soft_min=-1, soft_max=1, decimals=3),
              F("w", "Largeur", 1.0, 0.0, 8.0, decimals=3, soft_max=2.0),
              F("h", "Hauteur", 1.0, 0.0, 8.0, decimals=3, soft_max=2.0),
              B("invert", "Inverser", False)]
    center_keys = ("cx", "cy")
    size_keys = ("w", "h")

    def _inside(self, pts, p):
        dx = (pts[:, 0] - p["cx"]) / max(1e-6, p["w"] / 2)
        dy = (pts[:, 1] - p["cy"]) / max(1e-6, p["h"] / 2)
        if p["shape"] == 0:
            ins = (np.abs(dx) <= 1) & (np.abs(dy) <= 1)
        else:
            ins = dx * dx + dy * dy <= 1
        return ~ins if p["invert"] else ins

    def apply(self, strokes, p, ctx):
        out = []
        share = resample_share(strokes)
        for s in strokes:
            if s.kind != "line":
                keep = self._inside(s.pts, p)
                if keep.any():
                    out.append(Stroke(s.pts[keep], s.col[keep], False, s.kind, s.dwell))
                continue
            r = resample_stroke(s, 0.005, share)
            pts = closed_pts(r.pts, r.closed)
            col = closed_pts(r.col, r.closed)
            keep = self._inside(pts, p)
            if keep.all():
                out.append(s.copy())
                continue
            # Morceaux consécutifs à l'intérieur
            edges = np.diff(np.concatenate(([0], keep.astype(int), [0])))
            starts = np.where(edges == 1)[0]
            ends = np.where(edges == -1)[0]
            for a, b in zip(starts, ends):
                if b - a >= 2:
                    out.append(Stroke(pts[a:b], col[a:b], False))
        return out


class Beams(Modifier):
    type_id = "beams"
    label = "Beams"
    category = "Tracé"
    icon = "zap"
    description = "Remplace les formes par des points fixes très lumineux (faisceaux dans la fumée)."
    params = [E("mode", "Placement", ["Sur les sommets", "Répartis le long du tracé"]),
              I("count", "Nombre", 8, 1, 256, soft_max=64),
              I("dwell", "Éclat", 20, 1, 200, soft_max=60)]

    def apply(self, strokes, p, ctx):
        out = []
        for s in strokes:
            if len(s.pts) == 0:
                continue
            if p["mode"] == 0 or len(s.pts) < 2:
                pts, col = s.pts, s.col
                if s.kind == "line" and not s.closed and len(pts) > 1 and np.allclose(pts[0], pts[-1]):
                    pts, col = pts[:-1], col[:-1]
            else:
                mp, mc, cum, L = measure(s)
                n = int(p["count"])
                pos = np.linspace(0.0, L, n, endpoint=not s.closed) if n > 1 else np.array([L / 2])
                pts, col = at(mp, mc, cum, pos)
            out.append(Stroke(pts, col, False, "dots", int(p["dwell"])))
        return out


MODIFIERS = [Dots, Dashes, Trim, Mask, Beams]
