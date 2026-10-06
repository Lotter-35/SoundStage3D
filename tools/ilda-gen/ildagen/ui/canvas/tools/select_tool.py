"""Outil Sélection : clic, Ctrl / Maj + clic, rectangle, déplacement, poignées de transformation."""

import numpy as np
from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QPen

from ....core import grid as G
from ....core import mathutil as mu
from ....core.evaluator import hit_test, node_quad
from ... import theme
from ..painter import draw_guides
from . import gestures as GS
from .base import Tool
from .selection_frame import build_frame, draw_frame, handle_cursor, hit_handle, inside_frame, pickable

NUDGE = 0.005
NUDGE_BIG = 0.05


class SelectTool(Tool):
    name = "select"

    def __init__(self, view):
        super().__init__(view)
        self.drag = None
        self.marquee = None
        self.guides = []
        self._cursor = Qt.CursorShape.ArrowCursor

    def cursor(self):
        return self._cursor

    # ── Utilitaires ──────────────────────────────────────────────────────
    def frame(self, ctx=None):
        if not self.editor.editing_visible():
            return None
        return build_frame(self.editor, ctx or self.editor.eval_context())

    def transform_locked(self, frame):
        return any(n.locked and n.kind != "group" for n in frame.nodes)

    def pick(self, world, ctx):
        root = self.editor.current_root()
        if root is None:
            return None
        tol = self.vt.px(6)
        for n in pickable(root, ctx):
            if hit_test(n, world, ctx, tol):
                return n
        return None

    def _start(self, kind, ev, ctx, frame, hid=None, label="Transformer"):
        base = {n.id: self.editor.effective_transform(n, ctx) for n in frame.nodes}
        paths = {n.id: [p.copy() for p in n.local_paths()] for n in frame.nodes if n.kind == "shape"}
        geom = {n.id: (n.shape, n.rect, dict(n.sparams), [p.copy() for p in n.paths], n.transform.copy())
                for n in frame.nodes if n.kind == "shape"}
        others = []
        if kind == "move":
            sel = {n.id for n in frame.nodes}
            for n in pickable(self.editor.current_root(), ctx):
                if n.id in sel or any(a.id in sel for a in n.ancestors()):
                    continue
                q = node_quad(n, ctx)
                if q is not None:
                    others.append((q[:, 0].min(), q[:, 1].min(), q[:, 0].max(), q[:, 1].max()))
        self.drag = {"kind": kind, "hid": hid, "frame": frame, "press_w": np.array(ev.world, dtype=float),
                     "press_s": ev.screen, "base": base, "paths": paths, "geom": geom, "ctx": ctx,
                     "others": others, "baked": False}
        self.editor.begin(label)

    # ── Souris ───────────────────────────────────────────────────────────
    def press(self, ev):
        if ev.button != Qt.MouseButton.LeftButton or not self.editor.editing_visible():
            return
        ed = self.editor
        ctx = ed.eval_context()
        frame = self.frame(ctx)
        if frame is not None and not self.transform_locked(frame):
            hid = hit_handle(self.vt, frame, ev.screen)
            if hid is not None:
                label = {"rot": "Rotation", "tilt": "Inclinaison 3D", "pivot": "Déplacer le pivot"}.get(hid, "Redimensionner")
                self._start("handle", ev, ctx, frame, hid, label)
                return
        hit = self.pick(ev.world, ctx)
        if hit is not None:
            sel = set(ed.selection)
            in_sel = hit.id in sel or any(a.id in sel for a in hit.ancestors())
            if ev.ctrl:
                ed.toggle_selection(hit.id)
                return
            if ev.shift and not in_sel:
                ed.set_selection(ed.selection + [hit.id])
            elif not in_sel:
                ed.set_selection([hit.id])
            self._begin_move(ev, ctx)
            return
        if frame is not None and inside_frame(self.vt, frame, ev.screen):
            self._begin_move(ev, ctx)
            return
        if not (ev.shift or ev.ctrl):
            ed.clear_selection()
        self.marquee = (ev.world, ev.world, ev.shift or ev.ctrl)

    def _begin_move(self, ev, ctx):
        frame = self.frame(ctx)
        if frame is None or self.transform_locked(frame):
            return
        if ev.alt:
            self.editor.duplicate_selection()
            ctx = self.editor.eval_context()
            frame = self.frame(ctx)
            if frame is None:
                return
        self._start("move", ev, ctx, frame, label="Déplacer")

    def move(self, ev):
        if self.marquee is not None:
            self.marquee = (self.marquee[0], ev.world, self.marquee[2])
            self.view.update()
            return
        if self.drag is None:
            return
        d = self.drag
        if d["kind"] == "move":
            self._drag_move(ev, d)
        else:
            self._drag_handle(ev, d)
        self.view.update()

    def _drag_move(self, ev, d):
        delta = np.array(ev.world) - d["press_w"]
        self.guides = []
        if ev.shift:
            x0, y0, x1, y1 = d["frame"].bbox()
            box = (x0 + delta[0], y0 + delta[1], x1 + delta[0], y1 + delta[1])
            dx, dy, self.guides = G.smart_snap(box, d["others"], self.editor.doc.grid, self.vt.px(7))
            delta = delta + (dx, dy)
        w = mu.translation(delta[0], delta[1])
        for n in d["frame"].nodes:
            self.editor.apply_world_matrix(n, d["base"][n.id], w, d["ctx"])

    def _drag_handle(self, ev, d):
        ed = self.editor
        frame, hid, ctx = d["frame"], d["hid"], d["ctx"]
        world = np.array(ev.world, dtype=float)
        if hid == "pivot":
            p = tuple(world)
            if ev.shift:
                p = self._snap_pivot(p, frame)
            ed.set_world_pivot(frame.nodes[0], p[0], p[1], ctx)
            return
        if hid == "tilt":
            dx = ev.screen.x() - d["press_s"].x()
            dy = ev.screen.y() - d["press_s"].y()
            for n in frame.nodes:
                tf = d["base"][n.id].copy()
                tx, ty = tf.tilt_x - dy * 0.4, tf.tilt_y + dx * 0.4
                if ev.shift:
                    tx, ty = round(tx / 15) * 15, round(ty / 15) * 15
                tf.tilt_x, tf.tilt_y = max(-85.0, min(85.0, tx)), max(-85.0, min(85.0, ty))
                ed.write_transform(n, tf)
            return
        if hid == "rot":
            w, _ = GS.rotate_matrix(frame.pivot, d["press_w"], world, ev.shift)
            self._apply_all(d, w)
            return
        single_shape = frame.single and frame.nodes[0].kind == "shape"
        corner = hid.startswith("c")
        if ev.ctrl and ev.shift and ev.alt and corner and single_shape:
            quad = GS.perspective_quad(frame, hid, world - d["press_w"])
            self._bake(d, quad)
        elif ev.ctrl and ev.shift and not corner:
            self._apply_all(d, GS.skew_matrix(frame, hid, world - d["press_w"], ev.alt))
        elif ev.ctrl and corner and single_shape and not ev.shift:
            self._bake(d, GS.distort_quad(frame, hid, world))
        else:
            self._apply_all(d, GS.scale_matrix(frame, hid, world, ev.shift, ev.alt))

    def _apply_all(self, d, w):
        if d["baked"]:
            # Retour à la géométrie d'origine si une déformation a eu lieu plus tôt dans le même geste
            for n in d["frame"].nodes:
                if n.id in d["geom"]:
                    shape, rect, sparams, paths, tf = d["geom"][n.id]
                    n.shape, n.rect, n.sparams, n.paths, n.transform = shape, rect, dict(sparams), paths, tf.copy()
            d["baked"] = False
        for n in d["frame"].nodes:
            self.editor.apply_world_matrix(n, d["base"][n.id], w, d["ctx"])

    def _bake(self, d, quad):
        n = d["frame"].nodes[0]
        d["baked"] = True
        h = GS.homography_between(d["frame"].quad, quad)
        self.editor.bake_homography(n, d["base"][n.id], d["paths"][n.id], h, d["ctx"])

    def _snap_pivot(self, p, frame):
        q = frame.quad
        cands = [tuple(c) for c in q] + [tuple((q[i] + q[(i + 1) % 4]) / 2) for i in range(4)] + [tuple(q.mean(axis=0))]
        cands.append(G.snap_point(p, self.editor.doc.grid))
        return min(cands, key=lambda c: (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2)

    def release(self, ev):
        if self.marquee is not None:
            a, b, additive = self.marquee
            self.marquee = None
            self._select_in_rect(a, b, additive)
            self.view.update()
            return
        if self.drag is not None:
            self.drag = None
            self.guides = []
            self.editor.commit()
            self.editor.notify(structure=False)
            self.view.update()

    def _select_in_rect(self, a, b, additive):
        x0, x1 = sorted((a[0], b[0]))
        y0, y1 = sorted((a[1], b[1]))
        if x1 - x0 < self.vt.px(3) and y1 - y0 < self.vt.px(3):
            return
        ctx = self.editor.eval_context()
        found = []
        for n in pickable(self.editor.current_root(), ctx):
            q = node_quad(n, ctx)
            if q is None:
                continue
            if q[:, 0].max() >= x0 and q[:, 0].min() <= x1 and q[:, 1].max() >= y0 and q[:, 1].min() <= y1:
                found.append(n.id)
        self.editor.set_selection((self.editor.selection if additive else []) + found)

    def double_click(self, ev):
        hit = self.pick(ev.world, self.editor.eval_context())
        if hit is not None and hit.kind == "instance":
            self.editor.enter_def(hit.def_id)

    def hover(self, ev):
        cur = Qt.CursorShape.ArrowCursor
        frame = self.frame()
        if frame is not None and not self.transform_locked(frame):
            hid = hit_handle(self.vt, frame, ev.screen)
            if hid is not None:
                cur = handle_cursor(hid, frame)
            elif inside_frame(self.vt, frame, ev.screen):
                cur = Qt.CursorShape.SizeAllCursor
        if cur != self._cursor:
            self._cursor = cur
            self.view.setCursor(cur)

    # ── Clavier ──────────────────────────────────────────────────────────
    def key_press(self, key, mods):
        arrows = {Qt.Key.Key_Left: (-1, 0), Qt.Key.Key_Right: (1, 0), Qt.Key.Key_Up: (0, 1), Qt.Key.Key_Down: (0, -1)}
        if key in arrows:
            frame = self.frame()
            if frame is None or self.transform_locked(frame):
                return True
            step = NUDGE_BIG if mods & Qt.KeyboardModifier.ShiftModifier else NUDGE
            dx, dy = arrows[key]
            ctx = self.editor.eval_context()
            self.editor.begin("Déplacer")
            w = mu.translation(dx * step, dy * step)
            for n in frame.nodes:
                self.editor.apply_world_matrix(n, self.editor.effective_transform(n, ctx), w, ctx)
            self.editor.commit()
            self.editor.notify()
            return True
        if key == Qt.Key.Key_Escape:
            self.editor.clear_selection()
            return True
        return False

    # ── Dessin ───────────────────────────────────────────────────────────
    def draw(self, p):
        frame = self.frame()
        if frame is not None:
            locked = self.transform_locked(frame)
            draw_frame(p, self.vt, frame, handles=not locked)
        if self.guides:
            draw_guides(p, self.vt, self.guides)
        if self.marquee is not None:
            a, b, _ = self.marquee
            r = QRectF(self.vt.to_screen(*a), self.vt.to_screen(*b)).normalized()
            p.setPen(QPen(theme.qc(theme.ACCENT, 0.9), 1))
            p.setBrush(theme.qc(theme.ACCENT, 0.08))
            p.drawRect(r)
            p.setBrush(Qt.BrushStyle.NoBrush)
