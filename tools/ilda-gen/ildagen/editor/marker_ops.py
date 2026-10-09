"""Opérations de timeline (suite) : liaison des animations des clips (D5) et marqueurs (repères de parties).

Mêlé à TimelineOpsMixin (même historique : une étape par action, ajoutée au geste ouvert s'il y en a un).
"""

from ..core.timeline import MAX_START, TRACK_COLORS, Marker


class LinkMarkerOpsMixin:
    # ── Liaison des animations (D5) ──────────────────────────────────────
    def clip_link_state(self, clip):
        """(animation partagée avec d'autres clips, animations d'autres clips de la même forme)."""
        return self.doc.timeline.link_state(clip)

    def clip_is_linked(self, clip):
        """(lié, partagé) pour l'icône de chaîne : non lié = sa propre animation alors que d'autres clips de la
        même forme en ont une autre (« Relier » possible)."""
        shared, others = self.doc.timeline.link_state(clip)
        return shared or not others, shared

    def linked_count(self, clip):
        """Nombre d'autres clips qui jouent la même animation que ce clip."""
        return sum(1 for _, c in self.doc.timeline.all_clips() if c is not clip and c.anim_id == clip.anim_id)

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
        m = Marker(t, name or f"Repère {len(tl.markers) + 1}",
                   color or TRACK_COLORS[(len(tl.markers) + 1) % len(TRACK_COLORS)])

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
        if m is not None and color in TRACK_COLORS and color != m.color:
            self.timeline_mutate("Couleur du repère", lambda: setattr(m, "color", color))
