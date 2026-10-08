"""Opérations de timeline (espace Show) : tête de lecture, sélection de clips, pistes, clips (sans
chevauchement), liaison des animations (D5), fondus, marqueurs. Effets d'animation : effect_ops.py.

Chaque modification passe par l'historique (une étape) ; appelée pendant un geste ouvert (glisser), elle
s'ajoute à ce geste.
"""

from ..core import placement as P
from ..core.nodes import new_id
from ..core.timeline import MAX_START, MIN_DURATION, TRACK_COLORS, Clip, Marker


class TimelineOpsMixin:
    def set_playhead(self, t):
        t = max(0.0, float(t))
        if abs(t - self.playhead) > 1e-9:
            self.playhead = t
            self._touch(content=False)
            self.playheadChanged.emit(t)
            self.docChanged.emit()

    def timeline_mutate(self, label, fn):
        return self.mutate(label, fn, structure=False, timeline=True)

    def _tl_edit(self, label, fn):
        return self._edit(label, fn, timeline=True)

    # ── Sélection de clips (un seul modèle : le clip actif fait partie de la sélection) ──
    def select_clips(self, ids, active=None):
        tl = self.doc.timeline
        ids = [i for i in dict.fromkeys(ids) if tl.find_clip(i)[1] is not None]
        if active not in ids:
            active = self.selected_clip if self.selected_clip in ids else (ids[-1] if ids else None)
        changed = active != self.selected_clip
        if ids != self.clip_selection or changed:
            self.clip_selection = ids
            self.selected_clip = active
            self.clipSelectionChanged.emit()
            if changed:
                self.clipSelected.emit(active or "")

    def select_clip(self, clip_id):
        self.select_clips([clip_id] if clip_id else [], clip_id)

    def current_clip(self):
        """Clip actif (Show), ou None."""
        return self.doc.timeline.find_clip(self.selected_clip)[1] if self.selected_clip else None

    def selected_clip_items(self):
        """[(piste, clip)] sélectionnés, dans l'ordre du temps."""
        sel = set(self.clip_selection)
        return sorted(((tr, c) for tr, c in self.doc.timeline.all_clips() if c.id in sel), key=lambda tc: tc[1].start)

    # ── Pistes ───────────────────────────────────────────────────────────
    def add_track(self, name=None):
        tl = self.doc.timeline
        tr = tl.new_track(name)
        self.timeline_mutate("Ajouter une piste", lambda: tl.tracks.append(tr))
        return tr

    def remove_track(self, track_id):
        tl = self.doc.timeline
        tr = tl.find_track(track_id)
        if tr is None:
            return

        def do():
            tl.tracks.remove(tr)
            if not tl.tracks:
                tl.tracks.append(tl.new_track("Piste 1"))
            tl.prune_animations()
        self.timeline_mutate("Supprimer la piste", do)
        self.select_clips([i for i in self.clip_selection if tl.find_clip(i)[1] is not None])

    def rename_track(self, track_id, name):
        tr = self.doc.timeline.find_track(track_id)
        name = (name or "").strip()
        if tr is not None and name and name != tr.name:
            self.timeline_mutate("Renommer la piste", lambda: setattr(tr, "name", name))

    def set_track_color(self, track_id, color):
        tr = self.doc.timeline.find_track(track_id)
        if tr is not None and color in TRACK_COLORS and color != tr.color:
            self.timeline_mutate("Couleur de la piste", lambda: setattr(tr, "color", color))

    def move_track(self, track_id, index):
        tl = self.doc.timeline
        tr = tl.find_track(track_id)
        if tr is None:
            return
        index = max(0, min(len(tl.tracks) - 1, int(index)))
        if tl.tracks.index(tr) != index:
            self.timeline_mutate("Déplacer la piste", lambda: (tl.tracks.remove(tr), tl.tracks.insert(index, tr)))

    def set_track_flag(self, track_id, flag, on):
        """flag : « muted » (muet) ou « solo »."""
        tr = self.doc.timeline.find_track(track_id)
        if tr is not None and flag in ("muted", "solo"):
            self.timeline_mutate("Piste", lambda: setattr(tr, flag, bool(on)))

    # ── Clips ────────────────────────────────────────────────────────────
    def add_clip(self, def_id, track_id=None, start=0.0, duration=None):
        """Nouveau clip d'une forme ; place occupée : juste après. Il reprend l'animation d'un clip de la même
        forme s'il y en a un (D5)."""
        tl = self.doc.timeline
        tr = tl.find_track(track_id) or tl.tracks[0]
        clip = Clip(def_id, max(0.0, start), duration or tl.bar_len)
        clip.start = P.place_after(tr, clip.start, clip.duration)

        def do():
            tr.clips.append(clip)
            tl.attach(clip)
        self.timeline_mutate("Ajouter un clip", do)
        return clip

    def move_clip(self, clip_id, start, track_id=None):
        """Déplace un clip (sur une autre piste si track_id) au plus près de `start`, sans chevauchement."""
        tl = self.doc.timeline
        tr, clip = tl.find_clip(clip_id)
        if clip is None:
            return None
        dest = tl.find_track(track_id) if track_id else tr
        dest = dest or tr

        def do():
            if dest is not tr:
                tr.clips.remove(clip)
                dest.clips.append(clip)
            clip.start = P.fit_start(dest, max(0.0, start), clip.duration, [clip])
        self._tl_edit("Déplacer le clip", do)
        return clip

    def move_clips(self, origins, delta):
        """Déplace ensemble des clips : origins = {id: début d'origine} ; le décalage est borné pour qu'aucun
        clip ne touche un voisin (ni ne passe avant 0)."""
        tl = self.doc.timeline
        moves = []
        for cid, s0 in origins.items():
            tr, c = tl.find_clip(cid)
            if c is not None:
                moves.append((tr, c, s0))
        if not moves:
            return 0.0
        d = P.group_delta(moves, delta)

        def do():
            for _, c, s0 in moves:
                c.start = s0 + d
        self._tl_edit("Déplacer les clips", do)
        return d

    def resize_clip(self, clip_id, start=None, end=None):
        """Change le début et / ou la fin d'un clip ; ses bords s'arrêtent contre ses voisins."""
        tr, clip = self.doc.timeline.find_clip(clip_id)
        if clip is None:
            return None
        lo, hi = P.resize_limits(tr, clip)
        s = clip.start if start is None else min(max(lo, float(start)), clip.end - MIN_DURATION)
        e = clip.end if end is None else max(min(hi, float(end)), s + MIN_DURATION)

        def do():
            clip.start = max(0.0, s)
            clip.duration = e - clip.start
        self._tl_edit("Durée du clip", do)
        return clip

    def set_clip_fades(self, clip_id, fade_in=None, fade_out=None):
        """Fondus d'entrée / de sortie (s) ; leur somme ne dépasse pas la durée du clip."""
        _, clip = self.doc.timeline.find_clip(clip_id)
        if clip is not None:
            self._tl_edit("Fondus du clip", lambda: clip.set_fades(fade_in, fade_out))

    # ── Copier / coller des clips (avec leur animation et l'espace vide copié) ──
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
        """Colle à l'instant t (sur les mêmes pistes ; place occupée : piste suivante libre, ou nouvelle), avec
        la même animation (liée), puis avance la tête de lecture de la longueur copiée.
        Renvoie (début, fin, clips collés) ou None."""
        cb = self.clip_clipboard
        if not cb:
            return None
        tl = self.doc.timeline
        new = []
        for ti, off, d in cb["items"]:
            if self.doc.library.get(d.get("def_id")) is None:
                continue
            c = Clip.from_dict(d)
            c.id = new_id()
            c.start = max(0.0, t + off)
            new.append((ti, c))

        def do():
            for ti, c in new:
                while len(tl.tracks) <= ti:
                    tl.tracks.append(tl.new_track())
                i = ti
                while not P.is_free(tl.tracks[i], c.start, c.duration):
                    i += 1
                    if i >= len(tl.tracks):
                        tl.tracks.append(tl.new_track())
                tl.tracks[i].clips.append(c)
                tl.attach(c)          # même animation que le clip copié (ou celle de sa forme s'il n'existe plus)
        self.timeline_mutate("Coller", do)
        end = t + cb["length"]
        self.set_playhead(end)
        return t, end, [c for _, c in new]

    def delete_clips(self, clips, label="Supprimer les clips"):
        ids = {c.id for _, c in clips}
        if not ids:
            return
        tl = self.doc.timeline

        def do():
            for tr in tl.tracks:
                tr.clips = [c for c in tr.clips if c.id not in ids]
            tl.prune_animations()
        self.timeline_mutate(label, do)
        self.select_clips([i for i in self.clip_selection if i not in ids])

    def delete_clip(self, clip_id):
        tr, clip = self.doc.timeline.find_clip(clip_id)
        if clip is not None:
            self.delete_clips([(tr, clip)], "Supprimer le clip")

    def duplicate_clip(self, clip_id):
        """Copie juste après le clip (même animation) ; place occupée : juste après."""
        tr, clip = self.doc.timeline.find_clip(clip_id)
        if clip is None:
            return None
        c = Clip.from_dict(clip.to_dict())
        c.id = new_id()
        c.start = P.place_after(tr, clip.end, c.duration)
        self.timeline_mutate("Dupliquer le clip", lambda: tr.clips.append(c))
        return c

    def set_clip_expanded(self, clip_id, on):
        """Clip déplié dans la timeline : état d'affichage (hors annulation, enregistré)."""
        _, clip = self.doc.timeline.find_clip(clip_id)
        if clip is not None and clip.expanded != bool(on):
            clip.expanded = bool(on)
            self.view_changed()
            self.timelineChanged.emit()

    def set_clip_times(self, clip_id, start=None, duration=None):
        """Début / durée tapés (panneau du clip) : bornés contre les voisins."""
        _, clip = self.doc.timeline.find_clip(clip_id)
        if clip is None:
            return
        if start is not None:
            self.move_clip(clip_id, min(MAX_START, float(start)))
        if duration is not None:
            self.resize_clip(clip_id, end=clip.start + float(duration))

    # ── Liaison des animations (D5) ──────────────────────────────────────
    def clip_link_state(self, clip):
        """(animation partagée avec d'autres clips, animations d'autres clips de la même forme)."""
        return self.doc.timeline.link_state(clip)

    def clip_is_linked(self, clip):
        """(lié, partagé) pour l'icône de chaîne : non lié = sa propre animation alors que d'autres clips de la
        même forme en ont une autre (« Relier » possible)."""
        shared, others = self.doc.timeline.link_state(clip)
        return shared or not others, shared

    def unlink_clip(self, clip_id):
        """« Délier » : le clip reçoit une copie de son animation (la forme reste commune)."""
        tl = self.doc.timeline
        _, clip = tl.find_clip(clip_id)
        if clip is None:
            return None
        res = []
        self.timeline_mutate("Délier le clip", lambda: res.append(tl.unlink(clip)))
        self.statusMessage.emit("Clip délié : son animation se modifie seule (la forme reste commune)")
        return res[0] if res else None

    def relink_clip(self, clip_id, anim_id=None):
        """« Relier » : le clip reprend l'animation d'un autre clip de la même forme."""
        tl = self.doc.timeline
        _, clip = tl.find_clip(clip_id)
        if clip is None:
            return None
        if not tl.link_state(clip)[1]:
            self.statusMessage.emit("Aucun autre clip de cette forme à qui se relier")
            return None
        res = []
        self.timeline_mutate("Relier le clip", lambda: res.append(tl.relink(clip, anim_id)))
        if res and res[0] is not None:
            self.statusMessage.emit("Clip relié : il partage l'animation des autres clips de sa forme")
        return res[0] if res else None

    # ── Marqueurs ────────────────────────────────────────────────────────
    def add_marker(self, t, name=None, color=None):
        tl = self.doc.timeline
        m = Marker(t, name or f"Repère {len(tl.markers) + 1}", color or TRACK_COLORS[len(tl.markers) % len(TRACK_COLORS)])

        def do():
            tl.markers.append(m)
            tl.markers.sort(key=lambda x: x.t)
        self.timeline_mutate("Ajouter un repère", do)
        return m

    def remove_marker(self, marker_id):
        tl = self.doc.timeline
        m = tl.find_marker(marker_id)
        if m is not None:
            self.timeline_mutate("Supprimer le repère", lambda: tl.markers.remove(m))

    def move_marker(self, marker_id, t):
        tl = self.doc.timeline
        m = tl.find_marker(marker_id)
        if m is not None:
            def do():
                m.t = min(MAX_START, max(0.0, float(t)))
                tl.markers.sort(key=lambda x: x.t)
            self._tl_edit("Déplacer le repère", do)

    def rename_marker(self, marker_id, name):
        m = self.doc.timeline.find_marker(marker_id)
        name = (name or "").strip()
        if m is not None and name and name != m.name:
            self.timeline_mutate("Renommer le repère", lambda: setattr(m, "name", name))

    def set_marker_color(self, marker_id, color):
        m = self.doc.timeline.find_marker(marker_id)
        if m is not None and color in TRACK_COLORS:
            self.timeline_mutate("Couleur du repère", lambda: setattr(m, "color", color))
