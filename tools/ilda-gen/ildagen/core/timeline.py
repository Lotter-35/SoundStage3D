"""Timeline : pistes, clips de formes personnalisées, grille musicale (BPM, mesures, temps)."""

import math

from .automation import Automation
from .nodes import new_id

# (libellé, subdivisions par temps)
SUBDIVISIONS = [("Temps", 1), ("1/2 temps", 2), ("1/4 temps", 4), ("1/8 temps", 8),
                ("Triolets", 3), ("Triolets de 1/2", 6)]


class Clip:
    def __init__(self, def_id, start=0.0, duration=2.0, clip_id=None):
        self.id = clip_id or new_id()
        self.def_id = def_id
        self.start = float(start)
        self.duration = float(duration)
        self.automations = []
        self.expanded = False
        self.closed_nodes = []    # modifieurs repliés dans la timeline (par défaut leurs réglages sont affichés)

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

    def overrides_at(self, t_local):
        """{(node_id, clé): valeur} des automations à l'instant local t."""
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
                "automations": [a.to_dict() for a in self.automations]}

    @classmethod
    def from_dict(cls, d):
        c = cls(d.get("def_id", ""), d.get("start", 0.0), d.get("duration", 2.0), d.get("id"))
        c.expanded = d.get("expanded", False)
        c.closed_nodes = list(d.get("closed_nodes", []))
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
        t = cls(d.get("name", "Piste"), d.get("id"))
        t.muted = d.get("muted", False)
        t.solo = d.get("solo", False)
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
        for k in ("bpm", "bar_offset", "beats_per_bar", "subdivision", "snap", "loop_on",
                  "loop_start", "loop_end", "audio_path", "audio_duration"):
            if k in d:
                setattr(tl, k, d[k])
        tl.tracks = [Track.from_dict(t) for t in d.get("tracks", [])] or [Track("Piste 1")]
        return tl
