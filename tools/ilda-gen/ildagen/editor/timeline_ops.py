"""Opérations de timeline (espace Show) : tête de lecture, sélection de clips, pistes, clips (sans
chevauchement, recadrage), fondus. Liaison des animations (D5) et marqueurs : marker_ops.py. Effets
d'animation : effect_ops.py.

Chaque modification passe par l'historique (une étape) ; appelée pendant un geste ouvert (glisser), elle
s'ajoute à ce geste.
"""

from ..core import placement as P
from ..core.nodes import new_id
from ..core.timeline import MAX_START, MIN_DURATION, TRACK_COLORS, Clip
from .marker_ops import LinkMarkerOpsMixin


class TimelineOpsMixin(LinkMarkerOpsMixin):
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
        """flag : « muted » (muet), « solo » ou « locked » (verrouillée)."""
        tr = self.doc.timeline.find_track(track_id)
        if tr is not None and flag in ("muted", "solo", "locked") and getattr(tr, flag) != bool(on):
            label = {"muted": "Piste muette", "solo": "Solo", "locked": "Verrouiller la piste"}[flag]
            self.timeline_mutate(label, lambda: setattr(tr, flag, bool(on)))

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
        """Déplace un clip (sur une autre piste si track_id) au plus près de `start`, sans chevauchement.
        Piste verrouillée (celle du clip ou celle d'arrivée) : rien ne bouge."""
        tl = self.doc.timeline
        tr, clip = tl.find_clip(clip_id)
        if clip is None:
            return None
        dest = tl.find_track(track_id) if track_id else tr
        dest = dest or tr
        if tr.locked or dest.locked:
            return clip

        def do():
            if dest is not tr:
                tr.clips.remove(clip)
                dest.clips.append(clip)
            clip.start = P.fit_start(dest, max(0.0, start), clip.duration, [clip])
        self._tl_edit("Déplacer le clip", do)
        return clip

    def move_clips(self, origins, delta, track_shift=0):
        """Déplace ensemble des clips de `delta` secondes et de `track_shift` pistes : origins = {id: début
        d'origine} ou {id: (début, index de piste d'origine)}. Décalage le plus proche possible sans qu'aucun
        clip ne touche un voisin (ni ne passe avant 0). Renvoie le décalage retenu, ou None si le groupe ne
        tient nulle part avec ce changement de piste (rien ne bouge alors)."""
        tl = self.doc.timeline
        moves = []
        for cid, o in origins.items():
            tr, c = tl.find_clip(cid)
            if c is None:
                continue
            s0, ti = o if isinstance(o, tuple) else (o, tl.tracks.index(tr))
            if not 0 <= ti < len(tl.tracks) or tl.tracks[ti].locked:
                return None
            moves.append((ti, c, s0))
        if not moves:
            return 0.0
        res = P.group_fit(tl.tracks, moves, delta, track_shift)
        if res is None:
            return None
        d, shift = res

        def do():
            for ti, c, s0 in moves:
                src = tl.find_clip(c.id)[0]
                dest = tl.tracks[ti + shift]
                if dest is not src:
                    src.clips.remove(c)
                    dest.clips.append(c)
                c.start = s0 + d
        self._tl_edit("Déplacer les clips", do)
        return d

    def clip_curve_keys(self, clip_id):
        """[(clé, u)] de toutes les courbes de l'animation du clip (instantané pris au début d'un recadrage)."""
        tl = self.doc.timeline
        _, clip = tl.find_clip(clip_id)
        anim = tl.animations.get(clip.anim_id) if clip is not None else None
        if anim is None:
            return []
        return [(k, k.t) for e in anim.effects for t in e.params.values() for k in t.curve.keys]

    def resize_clip(self, clip_id, start=None, end=None, ref=None, keep_times=False):
        """Change le début et / ou la fin d'un clip ; ses bords s'arrêtent contre ses voisins.
        Les clés de courbe sont en proportion de la durée : la courbe s'étire avec le clip. ref = (début, durée,
        clip_curve_keys) pris au début du geste ; keep_times : les clés gardent leurs instants en secondes
        (recadrage, Maj) — l'animation étant partagée, ses clips liés changent aussi."""
        tr, clip = self.doc.timeline.find_clip(clip_id)
        if clip is None:
            return None
        if tr.locked:
            return clip
        lo, hi = P.resize_limits(tr, clip)
        s = clip.start if start is None else min(max(lo, float(start)), clip.end - MIN_DURATION)
        e = clip.end if end is None else max(min(hi, float(end)), s + MIN_DURATION)

        def do():
            clip.start = max(0.0, s)
            clip.duration = e - clip.start
            if ref is not None:
                s0, d0, keys = ref
                for k, u0 in keys:
                    k.t = (u0 * d0 + s0 - clip.start) / clip.duration if keep_times else u0
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

    def paste_clips(self, t, move_playhead=True):
        """Colle à l'instant t (sur les mêmes pistes ; place occupée ou piste verrouillée : piste suivante libre,
        ou nouvelle), avec la même animation (liée), puis avance la tête de lecture de la longueur copiée
        (sauf move_playhead=False : Dupliquer). Renvoie (début, fin, clips collés) ou None."""
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
                while tl.tracks[i].locked or not P.is_free(tl.tracks[i], c.start, c.duration):
                    i += 1
                    if i >= len(tl.tracks):
                        tl.tracks.append(tl.new_track())
                tl.tracks[i].clips.append(c)
                tl.attach(c)          # même animation que le clip copié (ou celle de sa forme s'il n'existe plus)
        self.timeline_mutate("Coller", do)
        end = t + cb["length"]
        if move_playhead:
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
