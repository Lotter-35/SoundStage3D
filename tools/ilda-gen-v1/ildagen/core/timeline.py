"""Timeline : pistes, clips de formes personnalisées, grille musicale (BPM, mesures, temps)."""

import math

from .automation import Automation
from .nodes import new_id

# (libellé, subdivisions par temps)
SUBDIVISIONS = [("Temps", 1), ("1/2 temps", 2), ("1/4 temps", 4), ("1/8 temps", 8),
                ("Triolets", 3), ("Triolets de 1/2", 6)]

MAX_START = 4 * 3600.0       # un clip commence au plus tard à 4 h (aucun spectacle n'est plus long)
MIN_DURATION = 0.01
MAX_DURATION = 3600.0        # un clip dure au plus 1 h


def finite(v, default, lo=None, hi=None):
    """Nombre fini borné ; `default` si la valeur n'est pas un nombre utilisable (texte, infini, NaN…)."""
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(v):
        return default
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


class Clip:
    def __init__(self, def_id, start=0.0, duration=2.0, clip_id=None):
        self.id = clip_id or new_id()
        self.def_id = def_id
        self.start = start
        self.duration = duration
        self.automations = []
        self.expanded = False
        self.closed_nodes = []    # modifieurs repliés dans la timeline (par défaut leurs réglages sont affichés)
        self.lane_sizes = {}      # hauteur choisie à la main pour une ligne de réglage : {clé: "big" | "small"}

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

    @property
    def end(self):
        return self.start + self.duration

    def active_at(self, t):
        return self.start <= t < self.end

    def find_automation(self, auto_id):
        return next((a for a in self.automations if a.id == auto_id), None)

    def automation_for(self, node_id, key):
        return next((a for a in self.automations if a.node_id == node_id and a.key == key), None)

    def armed_automation(self):
        return next((a for a in self.automations if a.armed), None)

    # Les clés d'automation sont placées en proportion de la durée du clip (0 = début, 1 = fin) :
    # des clips liés de durées différentes jouent la même courbe, chacun sur sa propre durée.
    def u(self, t_local):
        """Secondes depuis le début du clip → position relative (0..1)."""
        return t_local / self.duration if self.duration > 1e-9 else 0.0

    def secs(self, u):
        """Position relative (0..1) → secondes depuis le début du clip."""
        return u * self.duration

    def overrides_at(self, t_local):
        """{(node_id, clé): valeur} des automations à l'instant local t (secondes)."""
        t_local = self.u(t_local)
        out = {}
        for a in self.automations:
            if a.armed:
                continue
            v = a.value_at(t_local)
            if v is not None:
                out[(a.node_id, a.key)] = v
        return out

    def to_dict(self):
        return {"id": self.id, "def_id": self.def_id, "start": round(self.start, 6),
                "duration": round(self.duration, 6), "expanded": self.expanded, "closed_nodes": list(self.closed_nodes),
                "lane_sizes": dict(self.lane_sizes),
                "automations": [a.to_dict() for a in self.automations]}

    @classmethod
    def from_dict(cls, d):
        c = cls(d.get("def_id", ""), d.get("start", 0.0), d.get("duration", 2.0), d.get("id"))
        c.expanded = bool(d.get("expanded", False))
        c.closed_nodes = [i for i in d.get("closed_nodes") or [] if isinstance(i, str)]
        sizes = d.get("lane_sizes")
        c.lane_sizes = dict(sizes) if isinstance(sizes, dict) else {}
        c.automations = [Automation.from_dict(a) for a in d.get("automations", [])]
        return c


class Track:
    def __init__(self, name="Piste", track_id=None):
        self.id = track_id or new_id()
        self.name = name
        self.muted = False
        self.solo = False
        self.clips = []

    def to_dict(self):
        return {"id": self.id, "name": self.name, "muted": self.muted, "solo": self.solo,
                "clips": [c.to_dict() for c in self.clips]}

    @classmethod
    def from_dict(cls, d):
        t = cls(str(d.get("name", "Piste")), d.get("id"))
        t.muted = bool(d.get("muted", False))
        t.solo = bool(d.get("solo", False))
        t.clips = [Clip.from_dict(c) for c in d.get("clips", [])]
        return t


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
        beats = (t - self.bar_offset) / self.beat_len
        bar = math.floor(beats / self.beats_per_bar)
        beat_in_bar = beats - bar * self.beats_per_bar
        beat = math.floor(beat_in_bar)
        sub = math.floor((beat_in_bar - beat) * SUBDIVISIONS[self.subdivision][1])
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

    def has_clips(self):
        return any(True for _ in self.all_clips())

    def content_end(self):
        return max([c.end for _, c in self.all_clips()] + [0.0])

    def length(self):
        return max(self.audio_duration, self.content_end() + self.bar_len * 2, 60.0)

    def active_clips(self, t, hold=None):
        """Clips joués à l'instant t. hold : id d'un clip gardé visible jusqu'à sa toute dernière image
        incluse (aperçu d'une clé posée à la fin du clip)."""
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

    def to_dict(self):
        return {"bpm": self.bpm, "bar_offset": self.bar_offset, "beats_per_bar": self.beats_per_bar,
                "subdivision": self.subdivision, "snap": self.snap, "loop_on": self.loop_on,
                "loop_start": self.loop_start, "loop_end": self.loop_end, "audio_path": self.audio_path,
                "audio_duration": self.audio_duration, "tracks": [t.to_dict() for t in self.tracks]}

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
        tl.tracks = [Track.from_dict(t) for t in d.get("tracks", [])] or [Track("Piste 1")]
        return tl
