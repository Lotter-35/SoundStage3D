"""Règle de la timeline : tête de lecture (clic, glisser), repères (glisser pour déplacer, double-clic pour
renommer, M ou clic droit pour en ajouter) et barre de boucle (en bas de la règle : glisser pour la tracer,
ses bords pour la régler, son milieu pour la déplacer). Un simple clic sur la barre de boucle place la tête
de lecture : il ne crée jamais une boucle vide (T13)."""

from PySide6.QtCore import QRectF
from PySide6.QtGui import QFontMetrics

from .. import theme
from .draw import MARKER_H
from .geometry import HEADER_W, RULER_H

LOOP_ZONE = 8         # bas de la règle : barre de boucle
EDGE_PX = 5


class RulerEditing:
    # ── Repérage ─────────────────────────────────────────────────────────
    def marker_at(self, x, y):
        if not 3 <= y <= 4 + MARKER_H + 1:
            return None
        fm = QFontMetrics(theme.ui_font(10, True))
        for m in reversed(self.tl.markers):
            mx = self.geo.x(m.t)
            if QRectF(mx - 2, 3, fm.horizontalAdvance(m.name) + 14, MARKER_H + 2).contains(x, y):
                return m
        return None

    def loop_edge_at(self, x):
        tl = self.tl
        if tl.loop_end <= tl.loop_start:
            return None
        if abs(self.geo.x(tl.loop_start) - x) <= EDGE_PX:
            return "loop_start"
        if abs(self.geo.x(tl.loop_end) - x) <= EDGE_PX:
            return "loop_end"
        return None

    # ── Appui ────────────────────────────────────────────────────────────
    def press_ruler(self, x, y, mods):
        self.deselect_key()
        m = self.marker_at(x, y)
        if m is not None:
            self.sel_marker = m.id
            self.drag = {"kind": "marker", "id": m.id, "x0": x, "t0": m.t, "moved": False, "gesture": False}
            self.update()
            return
        self.sel_marker = None
        if y >= RULER_H - LOOP_ZONE:
            self.press_loop(x, mods)
            return
        self.start_scrub(x, mods)

    def start_scrub(self, x, mods):
        self.sel_marker = None
        self.drag = {"kind": "scrub"}
        self.playback.seek(max(0.0, self.snapper.snap(self.geo.t(x), mods)))

    def drag_scrub(self, x, mods):
        self.playback.seek(max(0.0, self.snapper.snap(self.geo.t(max(HEADER_W, x)), mods)))

    # ── Boucle ───────────────────────────────────────────────────────────
    def press_loop(self, x, mods):
        tl = self.tl
        t = self.geo.t(x)
        edge = self.loop_edge_at(x)
        if edge is not None:
            self.editor.begin("Boucle")
            self.drag = {"kind": edge, "gesture": True}
        elif tl.loop_end > tl.loop_start and tl.loop_start < t < tl.loop_end:
            self.editor.begin("Boucle")
            self.drag = {"kind": "loop_move", "t0": t, "a": tl.loop_start, "b": tl.loop_end, "gesture": True}
        else:
            # Nouvelle boucle seulement si on glisse (un simple clic : tête de lecture)
            self.drag = {"kind": "loop_new", "x0": x, "t0": max(0.0, self.snapper.snap(t, mods)), "gesture": False}

    def drag_loop(self, x, mods):
        d = self.drag
        tl = self.tl
        t = max(0.0, self.snapper.snap(self.geo.t(max(HEADER_W, x)), mods))
        kind = d["kind"]
        if kind == "loop_new":
            if abs(x - d["x0"]) < 4:
                return
            self.editor.begin("Boucle")
            d.update(kind="loop_end", gesture=True)
            tl.loop_start = tl.loop_end = d["t0"]
            tl.loop_on = True
            kind = "loop_end"
        if kind == "loop_start":
            tl.loop_start, tl.loop_end = min(t, tl.loop_end), max(t, tl.loop_end)
        elif kind == "loop_end":
            tl.loop_start, tl.loop_end = min(t, tl.loop_start), max(t, tl.loop_start)
        else:
            dt = self.snapper.snap(d["a"] + self.geo.t(x) - d["t0"], mods) - d["a"]
            dt = max(dt, -d["a"])          # la boucle ne commence jamais avant 0
            tl.loop_start, tl.loop_end = d["a"] + dt, d["b"] + dt
        self.editor.notify(timeline=True)

    def end_loop(self):
        d = self.drag
        if d["kind"] == "loop_new":
            self.playback.seek(d["t0"])              # simple clic : la tête de lecture, pas de boucle vide
            return
        tl = self.tl
        if tl.loop_end - tl.loop_start < 1e-6:
            tl.loop_on = False                        # boucle de longueur nulle : jamais active
        self.editor.commit()
        self.editor.notify(timeline=True)

    # ── Repères ──────────────────────────────────────────────────────────
    def drag_marker(self, x, mods):
        d = self.drag
        if not d["moved"]:
            if abs(x - d["x0"]) < 3:
                return
            d["moved"] = True
            d["gesture"] = True
            self.editor.begin("Déplacer le repère")
        tl = self.tl
        m = tl.find_marker(d["id"])
        if m is None:
            return
        t = self.snapper.snap(d["t0"] + (x - d["x0"]) / self.geo.pps, mods, skip_marker=m.id)
        self.editor.move_marker(d["id"], max(0.0, t))

    def end_marker(self):
        if self.drag.get("gesture"):
            self.editor.commit()
            self.editor.notify(timeline=True)

    def add_marker_here(self, t=None):
        """Touche M ou menu de la règle : un repère à la tête de lecture (ou à l'instant donné), sélectionné."""
        t = self.editor.playhead if t is None else t
        m = self.editor.add_marker(max(0.0, t))
        self.sel_marker = m.id
        self.deselect_key()
        self.update()
        return m

    def rename_marker_inline(self, m):
        fm = QFontMetrics(theme.ui_font(10, True))
        r = QRectF(self.geo.x(m.t), 3, max(90, fm.horizontalAdvance(m.name) + 30), MARKER_H + 2)
        self.open_inline(r, m.name, lambda name, mid=m.id: self.editor.rename_marker(mid, name))
