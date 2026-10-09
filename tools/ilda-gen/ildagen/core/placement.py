"""Pas de chevauchement sur une piste : les opérations bornent les clips contre leurs voisins.

- déplacer un clip : il va au plus près de l'endroit voulu, dans un intervalle libre assez grand ;
- déplacer plusieurs clips ensemble (dans le temps et d'une piste à l'autre) : le décalage commun le plus
  proche où aucun ne touche un voisin ;
- redimensionner : un bord s'arrête contre le clip voisin ;
- déposer / ajouter sur une place occupée : juste après ; coller : la même place sur une autre piste.
"""

import math

from .timeline import MAX_DURATION, MAX_START

EPS = 1e-6
END = MAX_START + MAX_DURATION


def _ids(exclude):
    return {c if isinstance(c, str) else c.id for c in exclude or ()}


def busy(track, exclude=()):
    """[(début, fin)] des clips de la piste (sauf ceux d'exclude), triés."""
    ex = _ids(exclude)
    return sorted((c.start, c.end) for c in track.clips if c.id not in ex)


def gaps(track, exclude=()):
    """Intervalles libres [(a, b)] de 0 à la fin (le dernier est ouvert)."""
    out = []
    cur = 0.0
    for a, b in busy(track, exclude):
        if a > cur + EPS:
            out.append((cur, a))
        cur = max(cur, b)
    out.append((cur, END))
    return out


def is_free(track, start, duration, exclude=()):
    end = start + duration
    return all(b <= start + EPS or a >= end - EPS for a, b in busy(track, exclude))


def fit_start(track, start, duration, exclude=()):
    """Début le plus proche de `start` où un clip de cette durée tient sans chevaucher (déplacer)."""
    best = None
    for a, b in gaps(track, exclude):
        if b - a + EPS < duration:
            continue
        s = min(max(start, a), b - duration)
        d = abs(s - start)
        if best is None or d < best[0] - EPS:
            best = (d, s)
    return max(0.0, best[1]) if best is not None else start


def place_after(track, start, duration, exclude=()):
    """Premier début ≥ start où le clip tient (dépôt sur une place occupée : juste après)."""
    start = max(0.0, start)
    for a, b in gaps(track, exclude):
        s = max(start, a)
        if s + duration <= b + EPS:
            return s
    return start


def resize_limits(track, clip):
    """(début minimal, fin maximale) du clip : ses voisins sur la piste."""
    lo, hi = 0.0, END
    for c in track.clips:
        if c is clip:
            continue
        if c.end <= clip.start + EPS:
            lo = max(lo, c.end)
        elif c.start >= clip.end - EPS:
            hi = min(hi, c.start)
    return lo, hi


def group_delta(moves, delta):
    """Décalage commun borné pour un groupe de clips déplacés ensemble.
    moves : [(piste, clip, début d'origine)] ; les clips du groupe ne se gênent pas entre eux."""
    ids = {c.id for _, c, _ in moves}
    lo, hi = -math.inf, math.inf
    for tr, c, s0 in moves:
        e0 = s0 + c.duration
        # Intervalle libre qui contient la position d'origine du clip
        for a, b in gaps(tr, ids):
            if a - EPS <= s0 and e0 <= b + EPS:
                lo, hi = max(lo, a - s0), min(hi, b - e0)
                break
        else:
            lo, hi = max(lo, -s0), hi
    if lo > hi:
        return 0.0
    return min(max(delta, lo), hi)


def group_fit(tracks, moves, delta, shift=0):
    """Déplacement d'un groupe de clips dans le temps et de `shift` pistes (toutes du même nombre).
    moves : [(index de la piste d'origine, clip, début d'origine)]. Renvoie (décalage, pistes) : le décalage le
    plus proche de `delta` où chaque clip tient sur sa piste d'arrivée sans chevauchement (ni avant 0, ni sur
    une piste verrouillée), ou None si aucun ne convient. Les clips du groupe ne se gênent pas entre eux."""
    if not moves:
        return None
    lo_i = min(i for i, _, _ in moves)
    hi_i = max(i for i, _, _ in moves)
    shift = max(-lo_i, min(len(tracks) - 1 - hi_i, int(shift)))
    ids = {c.id for _, c, _ in moves}
    dests = [(tracks[i + shift], c, s0) for i, c, s0 in moves]
    if any(getattr(tr, "locked", False) for tr, _, _ in dests):
        return None
    free = {tr.id: gaps(tr, ids) for tr, _, _ in dests}

    def fits(d):
        for tr, c, s0 in dests:
            s = s0 + d
            if s < -EPS:
                return False
            e = s + c.duration
            if not any(a - EPS <= s and e <= b + EPS for a, b in free[tr.id]):
                return False
        return True

    if fits(delta):
        return delta, shift
    # Candidats : chaque clip calé contre le bord d'un intervalle libre de sa piste d'arrivée (ou à 0)
    cands = {-min(s0 for _, _, s0 in dests)}
    for tr, c, s0 in dests:
        for a, b in free[tr.id]:
            cands.add(a - s0)
            if b < END:
                cands.add(b - s0 - c.duration)
    ok = [d for d in cands if fits(d)]
    if not ok:
        return None
    return min(ok, key=lambda d: (abs(d - delta), d)), shift


def resolve_overlaps(timeline):
    """Anciens projets (chevauchements permis) : un clip qui en chevauche un autre passe sur une piste libre
    à la même place (une nouvelle piste au besoin). Renvoie le nombre de clips déplacés."""
    moved = 0
    i = 0
    while i < len(timeline.tracks):
        tr = timeline.tracks[i]
        kept = []
        for c in sorted(tr.clips, key=lambda c: (c.start, c.id)):
            if all(c.start >= k.end - EPS or c.end <= k.start + EPS for k in kept):
                kept.append(c)
                continue
            dest = next((t for t in timeline.tracks[i + 1:] if is_free(t, c.start, c.duration)), None)
            if dest is None:
                dest = timeline.new_track()
                timeline.tracks.append(dest)
            dest.clips.append(c)
            moved += 1
        tr.clips = [c for c in tr.clips if c in kept]
        i += 1
    return moved
