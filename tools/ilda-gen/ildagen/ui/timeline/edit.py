"""Gestes d'édition de la timeline : boucle, pistes (muet / solo), clips (déplacer, redimensionner, sans
chevauchement : les opérations de l'éditeur bornent les clips contre leurs voisins)."""

from .geometry import HEADER_W


class TimelineEditing:
    def abandon_drag(self):
        """Glisser interrompu (Échap, relâchement jamais reçu) : annulé, le document revient à l'état d'avant."""
        if self.drag is None:
            return False
        kind = self.drag["kind"]
        self.drag = None
        if kind not in ("scrub", "rect", "range"):
            self.editor.cancel_gesture()
        self.update()
        return True

    def _press_loop(self, t, x):
        tl = self.tl
        g = self.geo
        self.editor.begin("Boucle")
        if tl.loop_end > tl.loop_start:
            if abs(g.x(tl.loop_start) - x) <= 5:
                self.drag = {"kind": "loop_start"}
                return
            if abs(g.x(tl.loop_end) - x) <= 5:
                self.drag = {"kind": "loop_end"}
                return
            if tl.loop_start < t < tl.loop_end:
                self.drag = {"kind": "loop_move", "t0": t, "a": tl.loop_start, "b": tl.loop_end}
                return
        t = max(0.0, self.snap(t))
        tl.loop_start = tl.loop_end = t
        tl.loop_on = True
        self.drag = {"kind": "loop_end"}

    def _press_header(self, row, x, y):
        """Colonne de gauche : muet / solo de la piste."""
        tr = row.track
        for i, attr in enumerate(("muted", "solo")):
            bx = HEADER_W - 50 + i * 22
            if bx <= x <= bx + 18:
                self.editor.set_track_flag(tr.id, attr, not getattr(tr, attr))
                return

    def _drag_clip(self, d, x, y, mods):
        """Glisser un clip (ou la sélection), ou un de ses bords ; dans le geste ouvert au clic."""
        clip = d["clip"]
        g = self.geo
        ed = self.editor
        dt = (x - d["x0"]) / g.pps
        min_d = max(0.02, self.tl.grid_step if self.tl.snap else 0.02)
        if d["kind"] == "clip_body":
            start = max(0.0, self.snap(d["start"] + dt, mods))
            if d.get("group"):
                # Plusieurs clips sélectionnés : ils bougent ensemble, sans toucher leurs voisins
                ed.move_clips(d["group"], start - d["start"])
            else:
                row = g.row_at(self.rows(), y)
                ed.move_clip(clip.id, start, row.track.id if row is not None else None)
        elif d["kind"] == "clip_left":
            ed.resize_clip(clip.id, start=min(self.snap(d["start"] + dt, mods), d["end"] - min_d))
        else:
            ed.resize_clip(clip.id, end=max(self.snap(d["end"] + dt, mods), d["start"] + min_d))

    def delete_selection(self):
        if getattr(self, "range_sel", None) and self.clips_in_range():
            self.editor.delete_clips(self.clips_in_range())
            return True
        sel = self.selected_clips()
        if sel:
            self.editor.delete_clips(sel)
            return True
        return False
