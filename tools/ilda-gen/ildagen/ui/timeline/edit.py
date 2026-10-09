"""Gestes sur les clips : déplacer (un ou plusieurs, d'une piste à l'autre — T12), redimensionner, fondus.

- Pas de chevauchement : l'éditeur place les clips au plus près sans toucher un voisin ; quand la place visée
  est occupée, un contour rouge la montre (ghost).
- Aimant : bords des autres clips, repères, tête de lecture, boucle (ligne pointillée), sinon la grille.
- Bord glissé = la durée change et la courbe s'étire avec le clip ; Maj (avant ou pendant le glisser, T11) =
  recadrer : les clés gardent leurs instants (animation partagée : les clips liés changent aussi, dit la
  barre d'état).
"""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from .geometry import CLIP_HEAD, STRIP_H

SHIFT = Qt.KeyboardModifier.ShiftModifier


class TimelineEditing:
    def abandon_drag(self):
        """Glisser interrompu (Échap, relâchement jamais reçu) : annulé, le document revient à l'état d'avant."""
        d = self.drag
        if d is None:
            return False
        self.drag = None
        self.ghost = None
        self.snapper.clear()
        if d.get("gesture"):
            self.editor.cancel_gesture()
        self.update()
        return True

    # ── Déplacer ─────────────────────────────────────────────────────────
    def start_move(self, row, b, x, y, multi):
        ed = self.editor
        tl = self.tl
        clip = b.clip
        items = self.selected_clips() if multi else [(row.track, clip)]
        group = {c.id: (c.start, tl.tracks.index(tr)) for tr, c in items}
        if any(tr.locked for tr, _ in items):
            group = {clip.id: (clip.start, row.index)}
        ed.begin("Déplacer les clips" if len(group) > 1 else "Déplacer le clip")
        self.drag = {"kind": "clip_body", "clip": clip, "x0": x, "y0": y, "start": clip.start, "row0": row.index,
                     "group": group, "moved": False, "gesture": True, "multi": multi, "shift": 0}

    def _row_index_at(self, y):
        rows = self.rows()
        if not rows:
            return 0
        if y < rows[0].y:
            return 0
        row = self.geo.row_at(rows, y)
        return row.index if row is not None else rows[-1].index

    def drag_clip(self, x, y, mods):
        d = self.drag
        d["last"] = (x, y)
        if d["kind"] != "clip_body":
            self.drag_resize(x, mods)
            return
        if not d["moved"] and abs(x - d["x0"]) < 3 and abs(y - d["y0"]) < 3:
            return
        d["moved"] = True
        clip = d["clip"]
        g = self.geo
        want = d["start"] + (x - d["x0"]) / g.pps
        s = self.snapper.snap_span(max(0.0, want), clip.duration, mods, exclude=d["group"])
        shift = self._row_index_at(y) - d["row0"]
        res = self.editor.move_clips(d["group"], s - d["start"], shift)
        track_blocked = res is None
        if track_blocked:
            res = self.editor.move_clips(d["group"], s - d["start"], d["shift"])    # piste visée occupée
        else:
            d["shift"] = shift
        b = self.find_box(clip.id)
        if track_blocked or res is None or b is None or abs(b.x - g.x(s)) > 1.0:
            rows = self.rows()
            ri = max(0, min(len(rows) - 1, d["row0"] + shift))
            ry = rows[ri].y + 5 if rows else y
            self.ghost = (g.x(s), ry, max(4.0, clip.duration * g.pps), CLIP_HEAD + STRIP_H)
            self.snapper.clear()
        else:
            self.ghost = None

    # ── Redimensionner (étirer, ou recadrer avec Maj) ────────────────────
    def start_resize(self, b, zone, x, mods):
        clip = b.clip
        ed = self.editor
        ed.begin("Recadrer le clip" if mods & SHIFT else "Durée du clip")
        ref = (clip.start, clip.duration, ed.clip_curve_keys(clip.id))
        self.drag = {"kind": "clip_" + zone, "clip": clip, "x0": x, "start": clip.start, "end": clip.end,
                     "ref": ref, "warned": False, "gesture": True, "last": (x, 0)}

    def drag_resize(self, x, mods):
        d = self.drag
        clip = d["clip"]
        g = self.geo
        tl = self.tl
        dt = (x - d["x0"]) / g.pps
        min_d = max(0.02, tl.grid_step if tl.snap else 0.02)
        keep = bool(mods & SHIFT)
        ed = self.editor
        if d["kind"] == "clip_left":
            want = min(self.snapper.snap(d["start"] + dt, mods, exclude=[clip.id]), d["end"] - min_d)
            ed.resize_clip(clip.id, start=want, ref=d["ref"], keep_times=keep)
            got = clip.start
        else:
            want = max(self.snapper.snap(d["end"] + dt, mods, exclude=[clip.id]), d["start"] + min_d)
            ed.resize_clip(clip.id, end=want, ref=d["ref"], keep_times=keep)
            got = clip.end
        b = self.find_box(clip.id)
        if b is not None and abs(want - got) * g.pps > 1.0:
            a, z = sorted((want, got))
            self.ghost = (g.x(a), b.y, (z - a) * g.pps, CLIP_HEAD + STRIP_H)
        else:
            self.ghost = None
        if keep and not d["warned"] and ed.linked_count(clip) > 0:
            d["warned"] = True
            ed.statusMessage.emit("Recadrage : l'animation est partagée, les clips liés changent aussi")

    def modifiers_changed(self):
        """Maj enfoncée ou relâchée pendant un glisser de bord : le recadrage suit tout de suite (T11)."""
        d = self.drag
        if d is not None and d["kind"] in ("clip_left", "clip_right"):
            self.drag_resize(d["last"][0], QApplication.keyboardModifiers())
            self.update()

    # ── Fondus ───────────────────────────────────────────────────────────
    def start_fade(self, b, zone, x):
        clip = b.clip
        self.editor.begin("Fondus du clip")
        self.drag = {"kind": zone, "clip": clip, "x0": x, "gesture": True,
                     "f0": clip.fade_in if zone == "fade_in" else clip.fade_out}

    def drag_fade(self, x, mods):
        d = self.drag
        clip = d["clip"]
        dt = (x - d["x0"]) / self.geo.pps
        if d["kind"] == "fade_in":
            t = self.snapper.snap(clip.start + d["f0"] + dt, mods, exclude=[clip.id])
            v = min(max(0.0, t - clip.start), max(0.0, clip.duration - clip.fade_out))
            self.editor.set_clip_fades(clip.id, fade_in=v)
        else:
            t = self.snapper.snap(clip.end - d["f0"] + dt, mods, exclude=[clip.id])
            v = min(max(0.0, clip.end - t), max(0.0, clip.duration - clip.fade_in))
            self.editor.set_clip_fades(clip.id, fade_out=v)

    def end_clip_drag(self, e):
        d = self.drag
        if d["kind"] == "clip_body" and d.get("multi") and not d.get("moved"):
            self.set_clip_selection([d["clip"].id])     # simple clic dans une sélection : ce clip seul
        self.editor.commit()
        self.editor.notify(timeline=True)

    # ── Supprimer : seulement ce qui est en surbrillance (T3) ────────────
    def delete_selection(self):
        """Clé sélectionnée, sinon repère sélectionné, sinon zone de temps, sinon clips sélectionnés."""
        if self.delete_selected_key():
            return True
        if self.sel_marker is not None:
            mid, self.sel_marker = self.sel_marker, None
            self.editor.remove_marker(mid)
            return True
        if getattr(self, "range_sel", None) and self.clips_in_range():
            self.editor.delete_clips([(tr, c) for tr, c in self.clips_in_range() if not tr.locked])
            return True
        sel = [(tr, c) for tr, c in self.selected_clips() if not tr.locked]
        if sel:
            self.editor.delete_clips(sel)
            return True
        return False

    # ── Flèches : un pas de grille ───────────────────────────────────────
    def nudge_clips(self, steps, tracks=0):
        sel = self.selected_clips()
        if not sel:
            return False
        tl = self.tl
        ed = self.editor
        group = {c.id: (c.start, tl.tracks.index(tr)) for tr, c in sel}
        ed.begin("Déplacer les clips")
        res = ed.move_clips(group, steps * tl.grid_step, tracks)
        ed.commit(merge=("nudge", tuple(sorted(group))))
        if res is None or (steps and abs(res - steps * tl.grid_step) > 1e-9):
            ed.statusMessage.emit("Place occupée : les clips ne se chevauchent pas")
        return True
