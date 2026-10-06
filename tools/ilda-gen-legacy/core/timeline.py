import math


class TimelineClip:
    """Bloc temporel (clip) représentant l'intervalle actif d'un calque ou groupe."""

    def __init__(self, clip_id: int, layer_id: int, start_time: float = 0.0, duration: float = 2.0, color=None):
        self.clip_id = int(clip_id)
        self.layer_id = int(layer_id)
        self.start_time = max(0.0, float(start_time))
        self.duration = max(0.05, float(duration))
        self.color = tuple(color) if color is not None else None

    @property
    def end_time(self) -> float:
        return self.start_time + self.duration

    def is_active_at(self, t: float) -> bool:
        """Indique si ce clip est actif à l'instant t."""
        return self.start_time <= t < self.end_time or (abs(t - self.end_time) < 1e-5 and self.duration > 0)

    def clone(self) -> "TimelineClip":
        return TimelineClip(
            clip_id=self.clip_id,
            layer_id=self.layer_id,
            start_time=self.start_time,
            duration=self.duration,
            color=self.color,
        )

    def to_dict(self) -> dict:
        return {
            "clip_id": self.clip_id,
            "layer_id": self.layer_id,
            "start_time": round(self.start_time, 4),
            "duration": round(self.duration, 4),
            "color": list(self.color) if self.color is not None else None,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "TimelineClip":
        col = d.get("color")
        return cls(
            clip_id=d.get("clip_id", 1),
            layer_id=d.get("layer_id", 0),
            start_time=float(d.get("start_time", 0.0)),
            duration=float(d.get("duration", 2.0)),
            color=tuple(col) if col is not None else None,
        )


class TimelineTrack:
    """Piste de la timeline associée à un calque ou groupe de calques."""

    def __init__(self, track_id: int, layer_id: int, muted: bool = False):
        self.track_id = int(track_id)
        self.layer_id = int(layer_id)
        self.clips: list[TimelineClip] = []
        self.muted = bool(muted)

    def is_active_at(self, t: float) -> bool:
        if self.muted:
            return False
        return any(c.is_active_at(t) for c in self.clips)

    def add_clip(self, start_time: float, duration: float, clip_id: int | None = None, color=None) -> TimelineClip:
        cid = clip_id if clip_id is not None else (len(self.clips) + 1)
        clip = TimelineClip(cid, self.layer_id, start_time, duration, color=color)
        self.clips.append(clip)
        return clip

    def remove_clip(self, clip_id: int) -> bool:
        orig_len = len(self.clips)
        self.clips = [c for c in self.clips if c.clip_id != clip_id]
        return len(self.clips) < orig_len

    def clone(self) -> "TimelineTrack":
        t = TimelineTrack(self.track_id, self.layer_id, muted=self.muted)
        t.clips = [c.clone() for c in self.clips]
        return t

    def to_dict(self) -> dict:
        return {
            "track_id": self.track_id,
            "layer_id": self.layer_id,
            "muted": self.muted,
            "clips": [c.to_dict() for c in self.clips],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "TimelineTrack":
        t = cls(
            track_id=d.get("track_id", 1),
            layer_id=d.get("layer_id", 0),
            muted=d.get("muted", False),
        )
        t.clips = [TimelineClip.from_dict(c) for c in d.get("clips", [])]
        return t


class TimelineModel:
    """Modèle central de la timeline musicale / temporelle avec calage au BPM."""

    def __init__(self):
        self.bpm: float = 120.0
        self.total_duration: float = 8.0   # En secondes
        self.current_time: float = 0.0     # Tête de lecture en secondes
        self.is_playing: bool = False
        self.loop: bool = True
        self.snap_to_beat: bool = True
        self.tracks: list[TimelineTrack] = []
        self._next_track_id: int = 1
        self._next_clip_id: int = 1

    @property
    def beat_duration(self) -> float:
        """Durée d'un temps (beat) en secondes selon le BPM."""
        return 60.0 / max(10.0, min(999.0, float(self.bpm)))

    @property
    def bar_duration(self) -> float:
        """Durée d'une mesure (bar = 4 temps en 4/4) en secondes."""
        return 4.0 * self.beat_duration

    @property
    def total_beats(self) -> float:
        return self.total_duration / self.beat_duration

    @property
    def total_bars(self) -> float:
        return self.total_duration / self.bar_duration

    def set_bpm(self, val: float):
        self.bpm = max(20.0, min(300.0, float(val)))

    def set_total_duration(self, val: float):
        self.total_duration = max(0.5, min(600.0, float(val)))
        if self.current_time > self.total_duration:
            self.current_time = self.total_duration

    def snap_time(self, t: float, fraction: float = 1.0) -> float:
        """Magnétise un temps t sur le pas BPM (1.0 = temps entier, 0.5 = demi-temps)."""
        t = max(0.0, min(self.total_duration, float(t)))
        if not self.snap_to_beat:
            return t
        step = self.beat_duration * fraction
        if step <= 0.001:
            return t
        snapped = round(t / step) * step
        return max(0.0, min(self.total_duration, round(snapped, 4)))

    def format_timecode(self, t: float | None = None) -> str:
        """Formate le temps en secondes et mesures.temps musicaux (ex: 00:02.50 | Mes. 2.1)."""
        cur = self.current_time if t is None else max(0.0, float(t))
        mins = int(cur // 60)
        secs = int(cur % 60)
        centis = int((cur % 1.0) * 100)
        bar_idx = int(cur // self.bar_duration) + 1
        beat_idx = int((cur % self.bar_duration) // self.beat_duration) + 1
        return f"{mins:02d}:{secs:02d}.{centis:02d}  (Mes. {bar_idx}.{beat_idx})"

    def get_track_for_layer(self, layer_id: int) -> TimelineTrack | None:
        for t in self.tracks:
            if t.layer_id == layer_id:
                return t
        return None

    def has_layer(self, layer_id: int) -> bool:
        return self.get_track_for_layer(layer_id) is not None

    def add_track_for_layer(
        self,
        layer_id: int,
        start_time: float = 0.0,
        duration: float | None = None,
        color=None,
    ) -> TimelineTrack:
        """Ajoute une piste pour un calque ou groupe, avec un clip initial si absente."""
        existing = self.get_track_for_layer(layer_id)
        if existing is not None:
            # Piste déjà présente : on peut ajouter un clip s'il n'en a pas
            if not existing.clips:
                dur = duration if duration is not None else min(self.bar_duration, self.total_duration)
                cid = self._next_clip_id
                self._next_clip_id += 1
                existing.add_clip(start_time, dur, clip_id=cid, color=color)
            return existing

        track = TimelineTrack(self._next_track_id, layer_id)
        self._next_track_id += 1
        dur = duration if duration is not None else min(self.bar_duration, self.total_duration)
        cid = self._next_clip_id
        self._next_clip_id += 1
        track.add_clip(start_time, dur, clip_id=cid, color=color)
        self.tracks.append(track)
        return track

    def remove_track(self, track_id: int) -> bool:
        orig = len(self.tracks)
        self.tracks = [t for t in self.tracks if t.track_id != track_id]
        return len(self.tracks) < orig

    def remove_track_for_layer(self, layer_id: int) -> bool:
        orig = len(self.tracks)
        self.tracks = [t for t in self.tracks if t.layer_id != layer_id]
        return len(self.tracks) < orig

    def prune_dead_layers(self, existing_layer_ids: set[int]):
        """Nettoie les pistes dont les calques ont été supprimés."""
        self.tracks = [t for t in self.tracks if t.layer_id in existing_layer_ids]

    def _find_parent_layer(self, target_layer, all_layers: list):
        """Trouve le groupe parent d'un calque."""
        for candidate in all_layers:
            if candidate.shape_type == "group" and target_layer in candidate.children:
                return candidate
            if candidate.children:
                found = self._find_parent_layer(target_layer, candidate.children)
                if found is not None:
                    return found
        return None

    def is_layer_active(self, layer, all_layers: list, time_pos: float | None = None) -> bool:
        """Détermine si un calque ou un groupe doit être affiché/émis au temps spécifié."""
        if not self.tracks:
            return True  # Aucune piste dans la timeline : tout reste visible

        t = self.current_time if time_pos is None else max(0.0, float(time_pos))

        # 1. Piste directe sur ce calque
        track = self.get_track_for_layer(layer.id)
        if track is not None:
            return track.is_active_at(t)

        # 2. Vérification des groupes parents
        parent = self._find_parent_layer(layer, all_layers)
        while parent is not None:
            p_track = self.get_track_for_layer(parent.id)
            if p_track is not None:
                return p_track.is_active_at(t)
            parent = self._find_parent_layer(parent, all_layers)

        # 3. Élément non asservi à la timeline -> visible par défaut
        return True

    def clone(self) -> "TimelineModel":
        m = TimelineModel()
        m.bpm = self.bpm
        m.total_duration = self.total_duration
        m.current_time = self.current_time
        m.is_playing = self.is_playing
        m.loop = self.loop
        m.snap_to_beat = self.snap_to_beat
        m.tracks = [t.clone() for t in self.tracks]
        m._next_track_id = self._next_track_id
        m._next_clip_id = self._next_clip_id
        return m

    def to_dict(self) -> dict:
        return {
            "bpm": round(self.bpm, 2),
            "total_duration": round(self.total_duration, 4),
            "current_time": round(self.current_time, 4),
            "loop": bool(self.loop),
            "snap_to_beat": bool(self.snap_to_beat),
            "tracks": [t.to_dict() for t in self.tracks],
            "next_track_id": self._next_track_id,
            "next_clip_id": self._next_clip_id,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "TimelineModel":
        m = cls()
        m.bpm = float(d.get("bpm", 120.0))
        m.total_duration = float(d.get("total_duration", 8.0))
        m.current_time = float(d.get("current_time", 0.0))
        m.loop = bool(d.get("loop", True))
        m.snap_to_beat = bool(d.get("snap_to_beat", True))
        m.tracks = [TimelineTrack.from_dict(t) for t in d.get("tracks", [])]
        m._next_track_id = int(d.get("next_track_id", len(m.tracks) + 1))
        all_c_ids = [c.clip_id for tr in m.tracks for c in tr.clips]
        m._next_clip_id = int(d.get("next_clip_id", max(all_c_ids) + 1 if all_c_ids else 1))
        return m
