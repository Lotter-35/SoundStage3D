"""Timeline (espace Show) : pistes, clips de formes, animations des clips, marqueurs, grille musicale.

Liaison (D5) : un clip joue l'animation `anim_id`. Un nouveau clip d'une forme déjà présente reprend
l'animation d'un clip de cette forme (sinon une animation vide) ; coller / dupliquer gardent l'animation ;
« Délier » en fait une copie pour ce clip seul ; « Relier » reprend celle d'un autre clip de la même forme.
Une animation qui ne sert plus à aucun clip est supprimée. Pas de chevauchement sur une piste
(core/placement.py : les opérations bornent les clips contre leurs voisins).
"""

import math

from .animation import Animation
from .nodes import new_id
from .params import finite  # noqa: F401  (réexporté : utilisé par les autres modules)

# (libellé, subdivisions par temps) ; « 2 temps » (blanche) ajouté à la fin : les indices enregistrés restent valables
SUBDIVISIONS = [("Temps", 1), ("1/2 temps", 2), ("1/4 temps", 4), ("1/8 temps", 8),
                ("Triolets", 3), ("Triolets de 1/2", 6), ("2 temps", 0.5)]

# Couleurs franches des pistes et des marqueurs
TRACK_COLORS = ["#00c853", "#ffd000", "#d500f9", "#ff3d00", "#00e5ff", "#ff4081", "#c6ff00", "#ff9100"]

MAX_START = 4 * 3600.0       # un clip commence au plus tard à 4 h (aucun spectacle n'est plus long)
MIN_DURATION = 0.01
MAX_DURATION = 3600.0        # un clip dure au plus 1 h


def valid_color(c, default):
    return c if isinstance(c, str) and len(c) == 7 and c.startswith("#") else default


class Clip:
    def __init__(self, def_id, start=0.0, duration=2.0, clip_id=None, anim_id=None):
        self.id = clip_id or new_id()
        self.def_id = def_id
        self._fade_in = self._fade_out = 0.0
        self.start = start
        self.duration = duration
        self.anim_id = anim_id        # animation jouée (partagée entre clips liés)
        self.expanded = False         # affichage (hors annulation)

    # Début et durée toujours finis et bornés (une valeur infinie bloquerait l'affichage de la timeline)
    @property
    def start(self):
        return self._start

    @start.setter
    def start(self, v):
        self._start = finite(v, getattr(self, "_start", 0.0), 0.0, MAX_START)

    @property
    def duration(self):
        return self._duration

    @duration.setter
    def duration(self, v):
        self._duration = finite(v, getattr(self, "_duration", 2.0), MIN_DURATION, MAX_DURATION)
        self.set_fades(self._fade_in, self._fade_out)      # les fondus tiennent toujours dans le clip

    # Fondus (s) : ≥ 0, leur somme ne dépasse jamais la durée du clip
    @property
    def fade_in(self):
        return self._fade_in

    @property
    def fade_out(self):
        return self._fade_out

    def set_fades(self, fade_in=None, fade_out=None):
        a = finite(self._fade_in if fade_in is None else fade_in, 0.0, 0.0, MAX_DURATION)
        b = finite(self._fade_out if fade_out is None else fade_out, 0.0, 0.0, MAX_DURATION)
        d = getattr(self, "_duration", 2.0)
        if a + b > d:
            k = d / (a + b)
            a, b = a * k, b * k
        self._fade_in, self._fade_out = a, b

    def fade_gain(self, t_local):
        """Intensité (0..1) des fondus d'entrée et de sortie au temps local t."""
        k = 1.0
        if self._fade_in > 1e-9:
            k = min(k, max(0.0, t_local) / self._fade_in)
        if self._fade_out > 1e-9:
            k = min(k, max(0.0, self.duration - t_local) / self._fade_out)
        return max(0.0, min(1.0, k))

    @property
    def end(self):
        return self.start + self.duration

    def active_at(self, t):
        return self.start <= t < self.end

    # Les clés de courbe sont placées en proportion de la durée du clip (0 = début, 1 = fin) :
    # des clips liés de durées différentes jouent la même courbe, chacun sur sa propre durée.
    def u(self, t_local):
        """Secondes depuis le début du clip → position relative (0..1)."""
        return t_local / self.duration if self.duration > 1e-9 else 0.0

    def secs(self, u):
        """Position relative (0..1) → secondes depuis le début du clip."""
        return u * self.duration

    def to_dict(self):
        d = {"id": self.id, "def_id": self.def_id, "start": round(self.start, 6),
             "duration": round(self.duration, 6), "anim_id": self.anim_id, "expanded": self.expanded}
        if self._fade_in or self._fade_out:
            d["fade_in"], d["fade_out"] = round(self._fade_in, 6), round(self._fade_out, 6)
        return d

    @classmethod
    def from_dict(cls, d):
        c = cls(d.get("def_id", ""), d.get("start", 0.0), d.get("duration", 2.0), d.get("id"))
        c.anim_id = d.get("anim_id") if isinstance(d.get("anim_id"), str) else None
        c.expanded = bool(d.get("expanded", False))
        c.set_fades(d.get("fade_in", 0.0), d.get("fade_out", 0.0))
        return c


class Track:
    def __init__(self, name="Piste", track_id=None, color=None):
        self.id = track_id or new_id()
        self.name = name
        self.color = valid_color(color, TRACK_COLORS[0])
        self.muted = False
        self.solo = False
        self.locked = False           # verrouillée : ses clips ne bougent plus (ni déposés, ni supprimés)
        self.clips = []

    def to_dict(self):
        d = {"id": self.id, "name": self.name, "color": self.color, "muted": self.muted, "solo": self.solo,
             "clips": [c.to_dict() for c in self.clips]}
        if self.locked:
            d["locked"] = True
        return d

    @classmethod
    def from_dict(cls, d, index=0):
        t = cls(str(d.get("name", "Piste")), d.get("id"),
                valid_color(d.get("color"), TRACK_COLORS[index % len(TRACK_COLORS)]))
        t.muted = bool(d.get("muted", False))
        t.solo = bool(d.get("solo", False))
        t.locked = d.get("locked") is True
        t.clips = [Clip.from_dict(c) for c in d.get("clips", []) if isinstance(c, dict)]
        return t


class Marker:
    def __init__(self, t=0.0, name="Repère", color=None, marker_id=None):
        self.id = marker_id or new_id()
        self.t = finite(t, 0.0, 0.0, MAX_START)
        self.name = name
        self.color = valid_color(color, TRACK_COLORS[1])

    def to_dict(self):
        return {"id": self.id, "t": round(self.t, 6), "name": self.name, "color": self.color}

    @classmethod
    def from_dict(cls, d):
        return cls(d.get("t", 0.0), str(d.get("name", "Repère")), d.get("color"), d.get("id"))


class Timeline:
    def __init__(self):
        self.bpm = 120.0
        self.bar_offset = 0.0          # instant (s) où commence la mesure 1
        self.beats_per_bar = 4
        self.subdivision = 0           # index dans SUBDIVISIONS
        self.snap = True
        self.loop_on = False
        self.loop_start = 0.0
        self.loop_end = 0.0
        self.audio_path = ""
        self.audio_duration = 0.0
        self.tracks = [Track("Piste 1")]
        self.animations = {}           # {anim_id: Animation}
        self.markers = []              # [Marker], triés par instant

    # ── Grille ──────────────────────────────────────────────────────────
    @property
    def beat_len(self):
        return 60.0 / max(1.0, self.bpm)

    @property
    def bar_len(self):
        return self.beat_len * self.beats_per_bar

    @property
    def grid_step(self):
        return self.beat_len / SUBDIVISIONS[self.subdivision][1]

    def snap_time(self, t, step=None, force=False):
        if not (self.snap or force):
            return t
        step = step or self.grid_step
        return self.bar_offset + round((t - self.bar_offset) / step) * step

    def position(self, t):
        """(mesure, temps, subdivision) à partir de 1 ; mesures négatives avant la mesure 1."""
        beats = (t - self.bar_offset) / self.beat_len + 1e-9
        bar = math.floor(beats / self.beats_per_bar)
        beat_in_bar = beats - bar * self.beats_per_bar
        beat = math.floor(beat_in_bar)
        n = max(1, int(SUBDIVISIONS[self.subdivision][1]))
        sub = math.floor((beat_in_bar - beat) * n)
        return bar + 1, beat + 1, sub + 1

    # ── Contenu ─────────────────────────────────────────────────────────
    def all_clips(self):
        for tr in self.tracks:
            for c in tr.clips:
                yield tr, c

    def find_clip(self, clip_id):
        for tr, c in self.all_clips():
            if c.id == clip_id:
                return tr, c
        return None, None

    def find_track(self, track_id):
        return next((t for t in self.tracks if t.id == track_id), None)

    def find_marker(self, marker_id):
        return next((m for m in self.markers if m.id == marker_id), None)

    def next_track_color(self):
        used = [t.color for t in self.tracks]
        free = [c for c in TRACK_COLORS if c not in used]
        return free[0] if free else TRACK_COLORS[len(self.tracks) % len(TRACK_COLORS)]

    def new_track(self, name=None):
        return Track(name or f"Piste {len(self.tracks) + 1}", color=self.next_track_color())

    def has_clips(self):
        return any(True for _ in self.all_clips())

    def content_end(self):
        return max([c.end for _, c in self.all_clips()] + [0.0])

    def length(self):
        return max(self.audio_duration, self.content_end() + self.bar_len * 2, 60.0)

    def active_clips(self, t, hold=None):
        """Clips joués à l'instant t. hold : id d'un clip gardé visible jusqu'à sa toute dernière image."""
        solo = any(tr.solo for tr in self.tracks)
        for tr in self.tracks:
            if tr.muted or (solo and not tr.solo):
                continue
            for c in tr.clips:
                if c.active_at(t) or (c.id == hold and c.start <= t <= c.end):
                    yield tr, c

    def remove_def(self, def_id):
        for tr in self.tracks:
            tr.clips = [c for c in tr.clips if c.def_id != def_id]
        self.prune_animations()

    # ── Animations et liaison des clips (D5) ────────────────────────────
    def animation_of(self, clip):
        return self.animations.get(clip.anim_id)

    def find_effect(self, effect_id):
        """(animation, effet) ou (None, None)."""
        for a in self.animations.values():
            e = a.find(effect_id)
            if e is not None:
                return a, e
        return None, None

    def clips_of_anim(self, anim_id):
        return [c for _, c in self.all_clips() if c.anim_id == anim_id]

    def linked_anim(self, def_id, exclude=None):
        """Animation d'un clip existant de cette forme (le premier dans le temps), ou None."""
        clips = sorted((c for _, c in self.all_clips() if c.def_id == def_id and c is not exclude
                        and c.anim_id in self.animations), key=lambda c: c.start)
        return clips[0].anim_id if clips else None

    def attach(self, clip):
        """Donne une animation au clip : la sienne si elle existe (coller, dupliquer), sinon celle d'un clip de
        la même forme, sinon une animation vide."""
        if clip.anim_id in self.animations:
            return self.animations[clip.anim_id]
        aid = self.linked_anim(clip.def_id, exclude=clip)
        if aid is None:
            a = Animation()
            self.animations[a.id] = a
            aid = a.id
        clip.anim_id = aid
        return self.animations[aid]

    def prune_animations(self):
        """Supprime les animations qui ne servent plus à aucun clip."""
        used = {c.anim_id for _, c in self.all_clips()}
        for aid in [a for a in self.animations if a not in used]:
            del self.animations[aid]

    def link_state(self, clip):
        """(partagée avec d'autres clips, animations d'autres clips de la même forme pour « Relier »)."""
        shared = any(c is not clip and c.anim_id == clip.anim_id for _, c in self.all_clips())
        others = []
        for _, c in sorted(self.all_clips(), key=lambda tc: tc[1].start):
            if c.def_id == clip.def_id and c.anim_id != clip.anim_id and c.anim_id not in others:
                others.append(c.anim_id)
        return shared, others

    def unlink(self, clip):
        """« Délier » : le clip reçoit une copie de son animation (nouveaux identifiants)."""
        src = self.animations.get(clip.anim_id)
        a = src.copy() if src is not None else Animation()
        self.animations[a.id] = a
        clip.anim_id = a.id
        self.prune_animations()
        return a

    def relink(self, clip, anim_id=None):
        """« Relier » : le clip reprend l'animation d'un autre clip de la même forme (la première trouvée si
        anim_id est vide). Renvoie l'animation, ou None."""
        _, others = self.link_state(clip)
        if anim_id is None:
            anim_id = others[0] if others else None
        if anim_id not in others:
            return None
        clip.anim_id = anim_id
        self.prune_animations()
        return self.animations.get(anim_id)

    def link_animations(self):
        """Après chargement : chaque clip a une animation (liée par forme), les inutiles sont oubliées."""
        for _, c in sorted(self.all_clips(), key=lambda tc: tc[1].start):
            self.attach(c)
        self.prune_animations()

    # ── Fichier ─────────────────────────────────────────────────────────
    def to_dict(self):
        return {"bpm": self.bpm, "bar_offset": self.bar_offset, "beats_per_bar": self.beats_per_bar,
                "subdivision": self.subdivision, "snap": self.snap, "loop_on": self.loop_on,
                "loop_start": self.loop_start, "loop_end": self.loop_end, "audio_path": self.audio_path,
                "audio_duration": self.audio_duration, "tracks": [t.to_dict() for t in self.tracks],
                "animations": [a.to_dict() for a in self.animations.values()],
                "markers": [m.to_dict() for m in self.markers]}

    @classmethod
    def from_dict(cls, d):
        tl = cls()
        # Chaque valeur est vérifiée : un fichier abîmé reprend les valeurs par défaut au lieu de planter
        tl.bpm = finite(d.get("bpm"), tl.bpm, 1.0, 999.0)
        tl.bar_offset = finite(d.get("bar_offset"), tl.bar_offset, -MAX_START, MAX_START)
        tl.beats_per_bar = int(finite(d.get("beats_per_bar"), tl.beats_per_bar, 1, 32))
        tl.subdivision = int(finite(d.get("subdivision"), tl.subdivision, 0, len(SUBDIVISIONS) - 1))
        tl.loop_start = finite(d.get("loop_start"), tl.loop_start, 0.0, MAX_START)
        tl.loop_end = finite(d.get("loop_end"), tl.loop_end, 0.0, MAX_START)
        tl.audio_duration = finite(d.get("audio_duration"), tl.audio_duration, 0.0, MAX_START)
        for k in ("snap", "loop_on"):
            if isinstance(d.get(k), bool):
                setattr(tl, k, d[k])
        if isinstance(d.get("audio_path"), str):
            tl.audio_path = d["audio_path"]
        tl.tracks = [Track.from_dict(t, i) for i, t in enumerate(d.get("tracks", [])) if isinstance(t, dict)] \
            or [Track("Piste 1")]
        for a in d.get("animations", []) or []:
            if isinstance(a, dict):
                anim = Animation.from_dict(a)
                tl.animations[anim.id] = anim
        tl.markers = sorted((Marker.from_dict(m) for m in d.get("markers", []) or [] if isinstance(m, dict)),
                            key=lambda m: m.t)
        return tl
