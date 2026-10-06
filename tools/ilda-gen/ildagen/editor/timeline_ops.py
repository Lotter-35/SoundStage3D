"""Opérations de timeline : pistes, clips, automations, tête de lecture."""

from ..core.automation import Automation
from ..core.timeline import Clip, Track


class TimelineOpsMixin:
    def set_playhead(self, t):
        t = max(0.0, float(t))
        if abs(t - self.playhead) > 1e-9:
            self.playhead = t
            self._touch()
            self.playheadChanged.emit(t)
            self.docChanged.emit()

    def timeline_mutate(self, label, fn):
        return self.mutate(label, fn, structure=False, timeline=True)

    def add_track(self):
        tl = self.doc.timeline
        tr = Track(f"Piste {len(tl.tracks) + 1}")
        self.timeline_mutate("Ajouter une piste", lambda: tl.tracks.append(tr))
        return tr

    def remove_track(self, track_id):
        tl = self.doc.timeline
        tr = tl.find_track(track_id)
        if tr is None:
            return
        if self.context[0] == "clip" and any(c.id == self.context[1] for c in tr.clips):
            self.enter_scene()

        def do():
            tl.tracks.remove(tr)
            if not tl.tracks:
                tl.tracks.append(Track("Piste 1"))
        self.timeline_mutate("Supprimer la piste", do)

    def add_clip(self, def_id, track_id, start, duration=None):
        tl = self.doc.timeline
        tr = tl.find_track(track_id) or tl.tracks[0]
        clip = Clip(def_id, max(0.0, start), duration or tl.bar_len)
        self.timeline_mutate("Ajouter un clip", lambda: tr.clips.append(clip))
        return clip

    def delete_clip(self, clip_id):
        tl = self.doc.timeline
        tr, clip = tl.find_clip(clip_id)
        if clip is None:
            return
        if self.context == ("clip", clip_id):
            self.enter_scene()
            self.set_view_source("timeline")
        self.timeline_mutate("Supprimer le clip", lambda: tr.clips.remove(clip))
        if self.selected_clip == clip_id:
            self.selected_clip = None

    def duplicate_clip(self, clip_id):
        tl = self.doc.timeline
        tr, clip = tl.find_clip(clip_id)
        if clip is None:
            return None
        from ..core.timeline import Clip as _Clip
        c = _Clip.from_dict(clip.to_dict())
        from ..core.nodes import new_id
        c.id = new_id()
        for a in c.automations:
            a.id = new_id()
        c.start = clip.end
        self.timeline_mutate("Dupliquer le clip", lambda: tr.clips.append(c))
        return c

    def new_automation(self, clip_id):
        """Automation « en attente » : elle se liera au prochain réglage touché dans ce clip."""
        _, clip = self.doc.timeline.find_clip(clip_id)
        if clip is None:
            return None
        a = Automation(label="En attente : touchez un réglage")

        def do():
            clip.automations = [x for x in clip.automations if not x.armed]
            clip.automations.append(a)
            clip.expanded = True
        self.timeline_mutate("Nouvelle automation", do)
        if self.context != ("clip", clip_id):
            self.enter_clip(clip_id)
        self.statusMessage.emit("Automation en attente : modifiez un réglage (Propriétés ou mire) pour la lier")
        return a

    def automate_param(self, node, key):
        """Crée directement une automation liée à un réglage (clic droit sur le réglage)."""
        clip = self.current_clip()
        if clip is None or clip.automation_for(node.id, key) is not None:
            return None
        from ..core import nodes as N
        a = Automation()
        a.bind(node.id, key, f"{node.name} › {self.param_label(node, key)}", self.param_is_discrete(node, key))
        v = N.get_param(node, key)

        def do():
            if v is not None:
                a.set_key(self.clip_local_time(clip), v)
            clip.automations.append(a)
            clip.expanded = True
        self.timeline_mutate("Créer une automation", do)
        return a

    def delete_automation(self, clip_id, auto_id):
        _, clip = self.doc.timeline.find_clip(clip_id)
        if clip is None:
            return

        def do():
            clip.automations = [a for a in clip.automations if a.id != auto_id]
        self.timeline_mutate("Supprimer l'automation", do)
