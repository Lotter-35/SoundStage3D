"""Souris dans la timeline : aiguillage vers la règle, la ligne de la musique, les en-têtes des pistes, les
clips (corps, bords, fondus, chevron), les lignes de courbe (clés) ou le vide (rectangle de sélection).

Clic sur un clip : il devient le clip actif et SEUL sélectionné (sauf s'il fait déjà partie d'une
sélection : on peut alors la glisser entière ; relâché sans bouger, il reste seul) ; Maj ou Cmd/Ctrl + clic :
ajouter / retirer. Tout clic ailleurs que sur une clé désélectionne la clé (T3, T4).
"""

from PySide6.QtCore import Qt

from .clipboard import range_modifier
from .geometry import HEADER_W, RULER_H


class TimelineMouse:
    # ── Repérage ─────────────────────────────────────────────────────────
    def hit(self, x, y):
        """(ligne, boîte, zone, ligne de courbe) sous (x, y) dans la zone des pistes."""
        g = self.geo
        row = g.row_at(self.rows(), y)
        if row is None or x < HEADER_W:
            return row, None, None, None
        b = g.box_at(row, x, y)
        if b is None:
            return row, None, None, None
        if y >= b.lanes_top:
            lane = next((ln for ln in b.lanes if ln.y <= y < ln.y + ln.h), None)
            if lane is not None and self.key_at(b, lane, x, y) is not None:
                return row, b, "key", lane          # une clé passe avant le bord du clip
        zone, lane = g.zone(b, x, y)
        return row, b, zone, lane

    # ── Appui ────────────────────────────────────────────────────────────
    def mousePressEvent(self, e):
        self.setFocus()
        self.close_inline(commit=True)
        if e.button() != Qt.MouseButton.LeftButton:
            return
        self.abandon_drag()         # relâchement précédent jamais reçu
        x, y = e.position().x(), e.position().y()
        mods = e.modifiers()
        g = self.geo
        if y < RULER_H:
            if x >= HEADER_W:
                self.press_ruler(x, y, mods)
            return
        if y < g.top:                                    # ligne de la musique : tête de lecture
            if x >= HEADER_W:
                self.start_scrub(x, mods)
            return
        if x < HEADER_W:
            row = g.row_at(self.rows(), y)
            if row is not None:
                self.press_header(row, x, y)
            return
        row, b, zone, lane = self.hit(x, y)
        if range_modifier(mods):
            self.deselect_key()
            self.start_range(x, mods, b.clip if b is not None else None)
            return
        self.clear_range()
        if b is None:
            self.deselect_key()
            self.start_rect(x, y, bool(mods & Qt.KeyboardModifier.ShiftModifier))
            return
        self.press_clip(row, b, zone, lane, x, y, mods)

    def press_clip(self, row, b, zone, lane, x, y, mods):
        clip = b.clip
        ed = self.editor
        self.sel_marker = None
        if zone == "key":
            self.press_key(b, lane, x, y, mods)
            return
        self.deselect_key()
        if zone == "chevron":
            ed.set_clip_expanded(clip.id, not clip.expanded)
            return
        if zone == "lane" and self.lane_label_hit(b, lane, x, y):
            self.toggle_lane_small(b, lane)
            return
        if mods & Qt.KeyboardModifier.ShiftModifier and zone not in ("left", "right"):
            self.toggle_clip(clip)          # Maj + clic : ajouter / retirer (Maj sur un bord : recadrer, T11)
            return
        multi = clip.id in self.sel_clips and len(self.sel_clips) > 1
        if not multi:
            self.set_clip_selection([clip.id])
        ed.select_clips(ed.clip_selection, clip.id)
        if row.track.locked:
            ed.statusMessage.emit("Piste verrouillée : déverrouillez-la (cadenas) pour modifier ses clips")
            return
        if zone in ("fade_in", "fade_out"):
            self.start_fade(b, zone, x)
        elif zone in ("left", "right"):
            self.start_resize(b, zone, x, mods)
        elif zone == "body":
            self.start_move(row, b, x, y, multi)
        self.update()

    # ── Glisser ──────────────────────────────────────────────────────────
    def mouseMoveEvent(self, e):
        x, y = e.position().x(), e.position().y()
        d = self.drag
        if d is not None and not (e.buttons() & Qt.MouseButton.LeftButton):
            self.abandon_drag()     # bouton relâché hors de la fenêtre : le glisser est annulé
            d = None
        if d is None:
            self._hover(x, y)
            return
        mods = e.modifiers()
        kind = d["kind"]
        if kind == "scrub":
            self.drag_scrub(x, mods)
        elif kind == "range":
            self.drag_range(x, mods)
        elif kind == "rect":
            self.drag_rect(x, y)
        elif kind.startswith("loop"):
            self.drag_loop(x, mods)
        elif kind == "marker":
            self.drag_marker(x, mods)
        elif kind == "track_move":
            self.drag_track(y)
        elif kind in ("key", "handle"):
            self.drag_key(x, y, mods)
        elif kind in ("fade_in", "fade_out"):
            self.drag_fade(x, mods)
        elif kind.startswith("clip_"):
            self.drag_clip(x, y, mods)
        self.update()

    def mouseReleaseEvent(self, e):
        d = self.drag
        if d is None:
            return
        kind = d["kind"]
        if kind == "rect":
            self.end_rect(e)
        elif kind == "range":
            self.end_range()
        elif kind.startswith("loop"):
            self.end_loop()
        elif kind == "marker":
            self.end_marker()
        elif kind == "track_move":
            self.end_track()
        elif kind in ("key", "handle"):
            self.end_key()
        elif kind != "scrub":
            self.end_clip_drag(e)
        self.drag = None
        self.ghost = None
        self.snapper.clear()
        self.update()

    # ── Double-clic ──────────────────────────────────────────────────────
    def mouseDoubleClickEvent(self, e):
        if e.button() != Qt.MouseButton.LeftButton:
            return
        x, y = e.position().x(), e.position().y()
        g = self.geo
        if y < RULER_H:
            m = self.marker_at(x, y)
            if m is not None:
                self.rename_marker_inline(m)
            return
        if y < g.top:
            return
        if x < HEADER_W:
            row = g.row_at(self.rows(), y)
            if row is not None and self.header_zone(row, x, y) == "name":
                self.rename_track_inline(row)        # T13 : jamais sur M / S / cadenas / couleur
            return
        row, b, zone, lane = self.hit(x, y)
        if b is None or zone == "chevron":
            return                                    # T9 : le chevron ne bascule qu'une fois
        if zone == "lane":
            if not self.lane_label_hit(b, lane, x, y):
                self.add_key_at(b, lane, x, y, e.modifiers())
            return
        if zone == "key":
            return
        self.editor.enter_def(b.clip.def_id)          # sa forme s'ouvre dans l'espace Forme

    # ── Survol ───────────────────────────────────────────────────────────
    def _hover(self, x, y):
        g = self.geo
        cur = Qt.CursorShape.ArrowCursor
        hover = {}
        if y < RULER_H and x >= HEADER_W:
            hover["ruler"] = x
            if self.marker_at(x, y) is not None:
                cur = Qt.CursorShape.OpenHandCursor
            elif y >= RULER_H - 7 and self.loop_edge_at(x) is not None:
                cur = Qt.CursorShape.SizeHorCursor
        elif y >= g.top:
            row, b, zone, _ = self.hit(x, y)
            if row is not None:
                hover["row"] = row.track.id
            if b is not None:
                hover["box"] = b.clip.id
                if zone in ("left", "right", "fade_in", "fade_out"):
                    cur = Qt.CursorShape.SizeHorCursor
                elif zone == "body":
                    cur = Qt.CursorShape.OpenHandCursor
                elif zone in ("chevron", "key"):
                    cur = Qt.CursorShape.PointingHandCursor
                elif zone == "lane":
                    cur = Qt.CursorShape.CrossCursor
        self.setCursor(cur)
        if hover != self.hover:
            self.hover = hover
            self.update()                  # seulement quand ce qui est survolé change

    def leaveEvent(self, e):
        if self.hover:
            self.hover = {}
            self.update()
        super().leaveEvent(e)

