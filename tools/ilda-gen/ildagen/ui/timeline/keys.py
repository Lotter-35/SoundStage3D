"""Clés de courbe dans les lignes d'un clip déplié.

- clic sur une clé : elle est SÉLECTIONNÉE (accent) ; glisser : elle bouge (aimantée dans le temps ; Alt =
  libre ; Maj = la valeur s'accroche à la valeur par défaut du réglage, ligne guide) ;
- double-clic dans la ligne : nouvelle clé ; clic droit sur une clé : menu (Supprimer, type de courbe) ;
- clic sur le nom de la ligne : la réduire / l'agrandir ;
- Suppr : supprime la clé sélectionnée (seulement si son clip est sélectionné : ce qui se voit, T4).
"""

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QFontMetrics, QPen

from .. import theme
from . import curves as CV
from .draw_clip import lane_map
from .geometry import HEADER_W, KEY_GRAB, LANE_LABEL_H

DEFAULT_SNAP_PX = 8


class KeyEditing:
    # ── Repérage ─────────────────────────────────────────────────────────
    def key_at(self, b, lane, x, y):
        t = lane.track
        if t is None:
            return None
        return lane_map(b, lane).key_at(t.curve, x, y, KEY_GRAB)

    def lane_label_hit(self, b, lane, x, y):
        if lane is None:
            return False
        fm = QFontMetrics(theme.ui_font(10))
        lx = max(b.x, HEADER_W) + 5
        w = min(fm.horizontalAdvance(lane.label) + 16, max(0.0, b.right - lx - 4))
        return lane.y <= y < lane.y + LANE_LABEL_H + 1 and lx - 2 <= x <= lx + w

    def lane_of(self, clip_id, effect_id, key):
        b = self.find_box(clip_id)
        if b is None:
            return None, None
        return b, next((ln for ln in b.lanes if ln.effect.id == effect_id and ln.key == key), None)

    def valid_key(self):
        """(clip, effet, réglage, indice) de la clé sélectionnée si elle se voit encore, sinon None."""
        s = self.sel_key
        if s is None:
            return None
        cid, eid, key, k = s
        _, clip = self.tl.find_clip(cid)
        _, e = self.editor.find_effect(eid)
        t = e.params.get(key) if e is not None else None
        if clip is None or t is None or k not in t.curve.keys or cid not in self.editor.clip_selection:
            self.sel_key = None
            return None
        return clip, e, key, t.curve.keys.index(k)

    def deselect_key(self):
        if self.sel_key is not None:
            self.sel_key = None
            self.update()

    def toggle_lane_small(self, b, lane):
        ident = lane.ident(b.clip)
        self.small_lanes ^= {ident}
        self._changed()

    # ── Gestes ───────────────────────────────────────────────────────────
    def press_key(self, b, lane, x, y, mods):
        clip = b.clip
        ed = self.editor
        if clip.id not in ed.clip_selection:
            ed.select_clips([clip.id], clip.id)
        else:
            ed.select_clips(ed.clip_selection, clip.id)
        curve = lane.track.curve
        m = lane_map(b, lane)
        cur = self.valid_key()
        if cur is not None and cur[1] is lane.effect and cur[2] == lane.key:
            k = curve.keys[cur[3]]
            if k.curve == "custom":
                h = m.handles(curve, cur[3])
                for which, (hx, hy) in ((0, h[2]), (1, h[3])) if h else ():
                    if abs(hx - x) <= 5 and abs(hy - y) <= 5:
                        self.drag = {"kind": "handle", "clip": clip, "eid": lane.effect.id, "key": lane.key,
                                     "which": which, "x0": x, "y0": y, "moved": False, "gesture": False}
                        return
        i = m.key_at(curve, x, y, KEY_GRAB)
        if i is None:
            return
        k = curve.keys[i]
        self.sel_key = (clip.id, lane.effect.id, lane.key, k)
        self.drag = {"kind": "key", "clip": clip, "eid": lane.effect.id, "key": lane.key, "k": k,
                     "x0": x, "y0": y, "moved": False, "gesture": False, "guide": None}
        self.update()

    def drag_key(self, x, y, mods):
        d = self.drag
        if not d["moved"]:
            if abs(x - d["x0"]) < 3 and abs(y - d["y0"]) < 3:
                return                      # un simple clic sélectionne seulement
            d["moved"] = True
            d["gesture"] = True
            self.editor.begin("Déplacer la clé" if d["kind"] == "key" else "Courbe")
        clip = d["clip"]
        b, lane = self.lane_of(clip.id, d["eid"], d["key"])
        if lane is None:
            return
        m = lane_map(b, lane)
        curve = lane.track.curve
        ed = self.editor
        if d["kind"] == "handle":
            i = self.valid_key()
            if i is not None:
                hv = m.handle_values(curve, i[3], d["which"], x, y)
                if hv is not None:
                    ed.set_curve_type(d["eid"], d["key"], i[3], "custom", hv)
            return
        k = d["k"]
        if k not in curve.keys:
            return
        t = self.snapper.snap(self.geo.t(x), mods)
        u = min(1.0, max(0.0, (t - clip.start) / clip.duration))
        v = None
        d["guide"] = None
        if not CV.is_color(lane.spec):
            v = m.yv(y)
            sp = lane.spec
            if mods & Qt.KeyboardModifier.ShiftModifier and sp is not None and sp.kind in ("float", "int"):
                dv = sp.default_value()
                gy = m.vy(dv)
                d["guide"] = (b.x, b.right, gy)
                if abs(y - gy) <= DEFAULT_SNAP_PX:
                    v = dv
        ed.move_curve_key(d["eid"], d["key"], curve.keys.index(k), u, v)

    def end_key(self):
        d = self.drag
        if d.get("gesture"):
            self.editor.commit()
            self.editor.notify(timeline=True)

    def add_key_at(self, b, lane, x, y, mods):
        """Double-clic dans une ligne : nouvelle clé (aimantée dans le temps), sélectionnée."""
        clip = b.clip
        t = lane.track
        if t is None:
            return None
        tt = self.snapper.snap(self.geo.t(x), mods)
        self.snapper.clear()
        u = min(1.0, max(0.0, (tt - clip.start) / clip.duration))
        m = lane_map(b, lane)
        v = t.curve.value_at(u) if CV.is_color(lane.spec) else m.yv(y)
        if v is None:
            v = t.value
        i = self.editor.set_curve_key(lane.effect.id, lane.key, u, v)
        t = lane.track
        if i is not None and t is not None:
            if clip.id not in self.editor.clip_selection:
                self.editor.select_clips([clip.id], clip.id)
            self.sel_key = (clip.id, lane.effect.id, lane.key, t.curve.keys[i])
        self.update()
        return i

    def delete_selected_key(self):
        cur = self.valid_key()
        if cur is None:
            return False
        clip, e, key, i = cur
        self.sel_key = None
        self.editor.remove_curve_key(e.id, key, i)
        self.editor.statusMessage.emit("Clé supprimée")
        return True

    def nudge_key(self, steps=0, vsteps=0):
        """Flèches : la clé avance d'un pas de grille, ou sa valeur d'un vingtième de la plage."""
        cur = self.valid_key()
        if cur is None:
            return False
        clip, e, key, i = cur
        k = e.params[key].curve.keys[i]
        spec = self.editor.effect_param_spec(e.id, key)
        u = min(1.0, max(0.0, k.t + steps * self.tl.grid_step / clip.duration)) if steps else None
        v = None
        if vsteps and not CV.is_color(spec):
            lo, hi = CV.value_range(spec)
            v = CV.denorm(CV.norm(k.v, (lo, hi)) + vsteps / 20.0, spec, (lo, hi))
        self.editor.begin("Déplacer la clé")
        self.editor.move_curve_key(e.id, key, i, u, v)
        self.editor.commit(merge=("key", e.id, key))
        return True

    def draw_key_guides(self, p):
        """Ligne guide de la valeur par défaut (Maj pendant le glisser d'une clé)."""
        d = self.drag
        if d is None or d.get("kind") != "key" or not d.get("guide"):
            return
        x0, x1, gy = d["guide"]
        pen = QPen(theme.qc(theme.TEXT_DIM), 1, Qt.PenStyle.DashLine)
        p.setPen(pen)
        p.drawLine(QPointF(max(x0, HEADER_W), gy), QPointF(x1, gy))

    def key_rect(self, clip_id, effect_id, key, index):
        """Position à l'écran d'une clé (tests, menus)."""
        b, lane = self.lane_of(clip_id, effect_id, key)
        if lane is None:
            return None
        k = lane.track.curve.keys[index]
        x, y = lane_map(b, lane).key_pos(k)
        return QRectF(x - 4, y - 4, 8, 8)
