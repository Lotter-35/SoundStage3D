"""Gestes d'édition de la timeline : boucle, pistes, clips, clés et poignées de courbe."""

from PySide6.QtCore import Qt

from ...core import nodes as N
from . import draw as D
from . import lanes as L
from .geometry import HEADER_W, lane_reset_rect, lane_toggle_rect


class TimelineEditing:
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

    def reset_lane(self, row):
        """↺ d'une ligne : supprime l'automation (le réglage reprend sa valeur fixe) ;
        sans automation, remet la valeur fixe par défaut."""
        clip, auto = row.clip, row.auto
        if auto in clip.automations:
            self.sel_key = None
            self.editor.delete_automation(clip.id, auto.id)
            self.editor.statusMessage.emit(f"Automation « {auto.label} » supprimée")
            return
        node, spec = L.target(self.editor, clip, auto)
        if node is None or spec is None:
            return
        from ...core import nodes as N
        self.editor.mutate("Réinitialiser", lambda: N.set_param(node, auto.key, spec.default_value()),
                           structure=False, timeline=True)

    def set_lane_small(self, row, small):
        """Réduire / agrandir une ligne de réglage (choix gardé avec le clip)."""
        lid = L.lane_id(row.auto)
        auto_small = not L.assigned(self.editor, row.clip, row.auto)
        if small == auto_small:
            row.clip.lane_sizes.pop(lid, None)    # retour au comportement automatique
        else:
            row.clip.lane_sizes[lid] = "small" if small else "big"
        self._changed()

    def toggle_group(self, row):
        """Déplie / replie les réglages d'un modifieur sous le clip."""
        ids = row.clip.closed_nodes
        if row.node.id in ids:
            ids.remove(row.node.id)
        else:
            ids.append(row.node.id)
        self._changed()

    def _press_header(self, row, x, y):
        """Colonne de gauche : seulement les pistes (muet / solo)."""
        if row.kind != "track":
            return
        tr = row.track
        for i, attr in enumerate(("muted", "solo")):
            bx = HEADER_W - 50 + i * 22
            if bx <= x <= bx + 18:
                self.editor.timeline_mutate("Piste", lambda a=attr: setattr(tr, a, not getattr(tr, a)))
                return

    def _press_lane(self, row, x, y, e):
        clip, auto = row.clip, row.auto
        if self.editor.context != ("clip", clip.id):
            self.editor.enter_clip(clip.id)
        if auto.armed or not (self.geo.x(clip.start) - 6 <= x <= self.geo.x(clip.end) + 6):
            return
        if self.key_hit(row, x, y) is None:
            # Flèche et ↺ en haut de la ligne, dans le clip
            tx, ty, tw, th = lane_toggle_rect(self.geo, row)
            bx, by, bw, bh = lane_reset_rect(self.geo, row)
            if ty <= y <= ty + th and tx - 2 <= x <= tx + tw + 2:
                self.set_lane_small(row, not row.small)
                return
            if by <= y <= by + bh and bx - 2 <= x <= bx + bw + 2 and self.geo.x(clip.end) - self.geo.x(clip.start) > 66:
                self.reset_lane(row)
                return
        if row.small and self.key_hit(row, x, y) is None:
            # Ligne réduite : un clic l'agrandit d'abord (pour poser les clés avec précision)
            self.set_lane_small(row, False)
            return
        hidx = self.handle_hit(row, x, y)
        if hidx is not None:
            self.editor.begin("Courbe")
            self.drag = {"kind": "handle", "row": row, "which": hidx}
            return
        k = self.key_hit(row, x, y)
        existing = k is not None
        node, spec = L.target(self.editor, clip, auto)
        self.editor.begin("Clé d'automation")
        if k is None:
            t_local = min(max(self.snap(self.geo.t(x), e.modifiers()) - clip.start, 0.0), clip.duration)
            if L.is_color(spec):
                v = auto.value_at(clip.u(t_local))
                if v is None and node is not None:
                    v = N.get_param(node, auto.key)
            else:
                v = L.y_to_v(y, row, L.value_range(spec, auto), spec, auto)
            if v is None:
                self.editor.history.cancel()
                return
            if auto not in clip.automations:
                # Premier clic sur un réglage pas encore animé : l'automation est créée
                clip.automations.append(auto)
            k = auto.set_key(clip.u(t_local), v, clip.duration)
            self.editor.notify(timeline=True)
        self.sel_key = k
        self.drag = {"kind": "key", "row": row, "key": k, "spec": spec, "x0": x, "y0": y,
                     "moved": False, "existing": existing}
        self.editor.set_preview_time(row.clip.start + row.clip.secs(k.t), row.clip.id)
        self.update()

    def _drag_clip(self, d, x, y, mods):
        clip = d["clip"]
        g = self.geo
        dt = (x - d["x0"]) / g.pps
        min_d = max(0.02, self.tl.grid_step if self.tl.snap else 0.02)
        if d["kind"] == "clip_body":
            clip.start = max(0.0, self.snap(d["start"] + dt, mods))
            group = d.get("group") or []
            if group:
                # Plusieurs clips sélectionnés : ils bougent ensemble (sans passer avant 0)
                delta = max(clip.start - d["start"], -min(s0 for _, s0 in group))
                clip.start = d["start"] + delta
                for c, s0 in group:
                    c.start = s0 + delta
            row = g.row_at(self.rows(), y)
            if row is not None and row.kind == "track" and row.track is not d["track"]:
                d["track"].clips.remove(clip)
                row.track.clips.append(clip)
                d["track"] = row.track
        elif d["kind"] == "clip_left":
            s = min(self.snap(d["start"] + dt, mods), d["end"] - min_d)
            clip.start = max(0.0, s)
            clip.duration = d["end"] - clip.start
        else:
            e_ = max(self.snap(d["end"] + dt, mods), d["start"] + min_d)
            clip.duration = e_ - clip.start
        if d["kind"] != "clip_body":
            self._stretch_keys(d, clip, mods)
        self.editor.notify(timeline=True)

    @staticmethod
    def _stretch_keys(d, clip, mods):
        """Les clés sont placées en proportion de la durée du clip : changer la durée étire déjà la courbe
        (une montée sur 10 s ramenée à 5 s va toujours jusqu'au bout). Maj : les clés gardent leurs
        instants en secondes (on coupe) — ce qui vaut pour tous les clips liés à la forme."""
        old = d["end"] - d["start"]
        keep = bool(mods & Qt.KeyboardModifier.ShiftModifier)
        for k, u0 in d["keys"]:
            if not keep or clip.duration <= 1e-9:
                k.t = u0
                continue
            secs = u0 * old + (d["start"] - clip.start if d["kind"] == "clip_left" else 0.0)
            k.t = secs / clip.duration

    def _drag_key(self, d, x, y, mods):
        if not d["moved"]:
            if abs(x - d["x0"]) < 3 and abs(y - d["y0"]) < 3:
                return          # pas encore un glisser (un simple clic change le type de courbe)
            d["moved"] = True
        row, k, spec = d["row"], d["key"], d["spec"]
        clip, auto = row.clip, row.auto
        k.t = clip.u(min(max(self.snap(self.geo.t(x), mods) - clip.start, 0.0), clip.duration))
        self.default_guide = None
        if not L.is_color(spec):
            rng = L.value_range(spec, auto)
            k.v = L.y_to_v(y, row, rng, spec, auto)
            # Maj : la valeur s'aimante sur la valeur par défaut du réglage (0°, 0, 100 %…)
            if mods & Qt.KeyboardModifier.ShiftModifier and spec is not None and spec.kind in ("float", "int"):
                dv = spec.default_value()
                gy = L.v_to_y(dv, row, rng)
                self.default_guide = (row, gy)
                if abs(y - gy) <= 10:
                    k.v = dv
        auto.sort()
        # La mire montre l'instant de la clé, avec sa nouvelle valeur
        self.editor.set_preview_time(clip.start + clip.secs(k.t), clip.id)
        self.editor.notify(timeline=True)

    def _drag_handle(self, d, x, y):
        row = d["row"]
        k = self.sel_key
        node, spec = L.target(self.editor, row.clip, row.auto)
        h = D.bezier_handles(self.geo, row, row.clip, row.auto, k, L.value_range(spec, row.auto))
        if h is None:
            return
        (ax, ay), (bx, by) = h[0], h[1]
        hx = min(1.0, max(0.0, (x - ax) / ((bx - ax) or 1.0)))
        hy = (y - ay) / (by - ay) if abs(by - ay) > 2 else (ay - y) / 40.0
        hy = max(-2.0, min(3.0, hy))
        if d["which"] == 0:
            k.h[0], k.h[1] = hx, hy
        else:
            k.h[2], k.h[3] = hx, hy
        self.editor.notify(timeline=True)

    def delete_selection(self):
        if getattr(self, "range_sel", None) and self.clips_in_range():
            self.editor.delete_clips(self.clips_in_range())
            return
        if self.sel_key is None and len(self.sel_clips) > 1:
            self.editor.delete_clips(self.selected_clips())
            self.set_clip_selection(())
            return
        if self.sel_key is not None:
            for _, c in self.tl.all_clips():
                for a in c.automations:
                    if self.sel_key in a.keys:
                        k = self.sel_key
                        self.sel_key = None
                        self.editor.timeline_mutate("Supprimer la clé", lambda a=a, k=k: a.keys.remove(k))
                        return True
        clip = self.editor.current_clip()
        if clip is not None:
            self.editor.delete_clip(clip.id)
            return True
        return False

