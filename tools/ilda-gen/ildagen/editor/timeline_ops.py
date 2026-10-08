"""Opérations de timeline : pistes, clips, automations, tête de lecture."""

from ..core.automation import Automation
from ..core.timeline import Clip, Track


class TimelineOpsMixin:
    def set_playhead(self, t):
        t = max(0.0, float(t))
        if abs(t - self.playhead) > 1e-9:
            self.playhead = t
            self._touch(content=False)
            self.playheadChanged.emit(t)
            self.docChanged.emit()

    def set_preview_time(self, t, clip_id=None):
        """Pendant le déplacement d'une clé, la mire montre cet instant ; None = retour à la tête de lecture."""
        if t is not None:
            t = max(0.0, float(t))
        self.preview_clip = clip_id if t is not None else None
        if t != self.preview_time:
            self.preview_time = t
            self._touch(content=False)
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
            self.enter_def()

        def do():
            tl.tracks.remove(tr)
            if not tl.tracks:
                tl.tracks.append(Track("Piste 1"))
        self.timeline_mutate("Supprimer la piste", do)

    def add_clip(self, def_id, track_id, start, duration=None):
        tl = self.doc.timeline
        tr = tl.find_track(track_id) or tl.tracks[0]
        clip = Clip(def_id, max(0.0, start), duration or tl.bar_len)
        d = self.doc.library.get(def_id)
        if d is not None:
            clip.automations = d.automations      # lié à la forme : automations partagées
        self.timeline_mutate("Ajouter un clip", lambda: tr.clips.append(clip))
        return clip

    # ── Copier / coller des clips (avec leurs automations et l'espace vide copié) ──
    def copy_clips(self, clips, start, length):
        """clips : [(piste, clip)] ; start / length : zone de temps copiée (le vide compris)."""
        tl = self.doc.timeline
        self.clip_clipboard = {
            "length": float(length),
            "items": [(tl.tracks.index(tr), c.start - start, c.to_dict()) for tr, c in clips],
        }
        n = len(clips)
        self.statusMessage.emit(f"{n} clip(s) copié(s) · {length:.3f} s" if n else "Zone vide copiée")

    def paste_clips(self, t):
        """Colle à l'instant t (sur les mêmes pistes) puis avance la tête de lecture de la longueur copiée.
        Renvoie (début, fin, clips collés) ou None."""
        cb = self.clip_clipboard
        if not cb:
            return None
        from ..core.nodes import new_id
        tl = self.doc.timeline
        new = []
        for ti, off, d in cb["items"]:
            if self.doc.library.get(d.get("def_id")) is None:
                continue
            c = Clip.from_dict(d)
            c.id = new_id()
            c.start = max(0.0, t + off)
            # Le clip collé est lié à sa forme : mêmes automations (partagées)
            c.automations = self.doc.library.get(c.def_id).automations
            new.append((ti, c))

        def do():
            for ti, c in new:
                while len(tl.tracks) <= ti:
                    tl.tracks.append(Track(f"Piste {len(tl.tracks) + 1}"))
                tl.tracks[ti].clips.append(c)
        self.timeline_mutate("Coller", do)
        end = t + cb["length"]
        self.set_playhead(end)
        return t, end, [c for _, c in new]

    def clip_is_linked(self, clip):
        """(lié à une forme de la liste, partagé avec d'autres clips) ; une copie déliée est cachée."""
        d = self.doc.library.get(clip.def_id)
        if d is None or d.hidden:
            return False, False
        n = sum(1 for _, c in self.doc.timeline.all_clips() if c.def_id == d.id)
        return True, n > 1

    def unlink_clip(self, clip_id):
        """Délier : le clip reçoit sa propre copie de la forme (modifiable seule, absente de la liste)."""
        from ..core.library import unlink_clip
        _, clip = self.doc.timeline.find_clip(clip_id)
        if clip is None:
            return None
        res = []
        self.mutate("Délier le clip", lambda: res.append(unlink_clip(self.doc.library, clip)),
                    library=True, timeline=True)
        if self.context[0] == "clip" and self.context[1] == clip_id:
            self._set_context(("clip", clip_id), "timeline")
        self.statusMessage.emit("Clip délié : sa forme se modifie seule (elle n'est pas dans la liste des formes)")
        return res[0] if res else None

    def relink_clip(self, clip_id):
        """Relier : le clip délié reprend la forme d'origine et ses automations (sa copie est abandonnée)."""
        from ..core.library import relink_clip
        _, clip = self.doc.timeline.find_clip(clip_id)
        if clip is None:
            return None
        res = []
        self.mutate("Relier le clip", lambda: res.append(relink_clip(self.doc.library, clip)),
                    library=True, timeline=True)
        if self.context[0] == "clip" and self.context[1] == clip_id:
            self._set_context(("clip", clip_id), "timeline")
        src = res[0] if res else None
        if src is None:
            self.statusMessage.emit("Impossible de relier : la forme d'origine n'existe plus")
        else:
            self.statusMessage.emit(f"Clip relié à « {src.name} »")
        return src

    def delete_clips(self, clips, label="Supprimer les clips"):
        ids = {c.id for _, c in clips}
        if not ids:
            return
        if self.context[0] == "clip" and self.context[1] in ids:
            self.enter_def()
            self.set_view_source("timeline")

        def do():
            for tr in self.doc.timeline.tracks:
                tr.clips = [c for c in tr.clips if c.id not in ids]
        self.timeline_mutate(label, do)

    def delete_clip(self, clip_id):
        tl = self.doc.timeline
        tr, clip = tl.find_clip(clip_id)
        if clip is None:
            return
        if self.context == ("clip", clip_id):
            self.enter_def()
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
            clip.automations[:] = [x for x in clip.automations if not x.armed]
            clip.automations.append(a)
            clip.expanded = True
        self.timeline_mutate("Nouvelle automation", do)
        if self.context != ("clip", clip_id):
            self.enter_clip(clip_id)
        self.statusMessage.emit("Automation en attente : modifiez un réglage (Propriétés ou mire) pour la lier")
        return a

    def automation_clip(self):
        """Clip qui reçoit un réglage envoyé dans la timeline : le clip sélectionné, sinon un clip de la forme
        en cours (ses clips liés partagent les mêmes automations). Renvoie (clip, message d'erreur)."""
        clip = self.current_clip()
        if clip is not None:
            return clip, None
        fid = self.current_form_id()
        clips = sorted((c for _, c in self.doc.timeline.all_clips() if c.def_id == fid), key=lambda c: c.start)
        if not clips:
            return None, "Glissez d'abord cette forme dans la timeline (liste de gauche → piste)"
        return clips[0], None        # clips liés : ils partagent les mêmes automations

    def param_in_timeline(self, node, key):
        clip, _ = self.automation_clip()
        return clip is not None and clip.automation_for(node.id, key) is not None

    def automate_param(self, node, key):
        """Envoie un réglage dans la timeline : une ligne d'automation apparaît sous le clip (clé à la tête
        de lecture avec la valeur actuelle). Déjà présent : il est retiré de la timeline."""
        clip, err = self.automation_clip()
        if clip is None:
            self.statusMessage.emit(err)
            return None
        label = f"{node.name} › {self.param_label(node, key)}"
        existing = clip.automation_for(node.id, key)
        if existing is not None:
            self.timeline_mutate("Retirer de la timeline", lambda: clip.automations.remove(existing))
            self.statusMessage.emit(f"« {label} » retiré de la timeline")
            return None
        from ..core import nodes as N
        a = Automation()
        a.bind(node.id, key, label, self.param_is_discrete(node, key))
        v = N.get_param(node, key)
        t_local = min(max(self.playhead - clip.start, 0.0), clip.duration)

        def do():
            if v is not None:
                a.set_key(clip.u(t_local), v)
            clip.automations.append(a)
            clip.expanded = True
        self.timeline_mutate("Envoyer dans la timeline", do)
        if self.context != ("clip", clip.id):
            self.enter_clip(clip.id, keep_selection=True)     # on reste sur le calque en cours de réglage
        self.statusMessage.emit(f"« {label} » ajouté à la timeline : modifiez-le à différents instants "
                                "ou posez des points dans sa ligne")
        return a

    def delete_automation(self, clip_id, auto_id):
        _, clip = self.doc.timeline.find_clip(clip_id)
        if clip is None:
            return

        def do():
            clip.automations[:] = [a for a in clip.automations if a.id != auto_id]
        self.timeline_mutate("Supprimer l'automation", do)
