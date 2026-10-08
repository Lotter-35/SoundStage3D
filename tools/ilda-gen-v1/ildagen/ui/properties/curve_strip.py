"""Mini-courbe d'automation sous un réglage envoyé dans la timeline (Calques et Propriétés).

Toute la largeur = toute la durée du clip (du début à la fin de la forme), quel que soit le zoom de la
timeline. Clic : ajouter une clé · clic sur une clé : rampe → carré → sinusoïdale · glisser : la déplacer ·
clic droit : la supprimer · Alt : sans aimant.
"""

from PySide6.QtCore import QPointF, QRectF, QSize, Qt
from PySide6.QtGui import QColor, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QWidget

from .. import theme

PAD = 4
HIT = 6


class CurveStrip(QWidget):
    def __init__(self, editor, node_id, spec, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.node_id = node_id
        self.spec = spec
        self.drag = None
        self.setFixedHeight(68)
        self.setMouseTracking(True)
        self.setToolTip("Valeur au cours du clip (gauche = début, droite = fin) · clic : ajouter un point · "
                        "clic sur un point : rampe → carré → sinusoïdale · glisser : le déplacer · clic droit : le supprimer")

    def sizeHint(self):
        return QSize(120, 68)

    # ── Données ──────────────────────────────────────────────────────────
    def target(self):
        """(clip, automation) suivis, ou (None, None)."""
        clip, _ = self.editor.automation_clip()
        if clip is None:
            return None, None
        return clip, clip.automation_for(self.node_id, self.spec.key)

    def _range(self, auto):
        from ..timeline import lanes as L
        return L.value_range(self.spec, auto)

    def _is_color(self):
        return self.spec.kind == "color"

    def _area(self):
        return QRectF(PAD, PAD, max(1.0, self.width() - 2 * PAD), max(1.0, self.height() - 2 * PAD))

    def _x(self, t, clip):
        a = self._area()
        return a.left() + (t / max(clip.duration, 1e-9)) * a.width()

    def _t(self, x, clip):
        a = self._area()
        return min(1.0, max(0.0, (x - a.left()) / a.width())) * clip.duration

    def _y(self, v, auto):
        a = self._area()
        lo, hi = self._range(auto)
        if isinstance(v, bool):
            v = 1.0 if v else 0.0
        if isinstance(v, tuple):
            return a.center().y()
        k = min(1.0, max(0.0, (float(v) - lo) / (hi - lo)))
        return a.bottom() - k * a.height()

    def _v(self, y, auto):
        a = self._area()
        lo, hi = self._range(auto)
        k = min(1.0, max(0.0, (a.bottom() - y) / a.height()))
        v = lo + k * (hi - lo)
        s = self.spec
        if s.kind == "bool":
            return v >= 0.5
        if s.kind in ("int", "enum"):
            v = int(round(v))
        return s.clamp(v) if s.kind in ("float", "int") else v

    def _key_at(self, pos, clip, auto):
        for k in auto.keys:
            if abs(self._x(clip.secs(k.t), clip) - pos.x()) <= HIT and abs(self._y(k.v, auto) - pos.y()) <= HIT + 2:
                return k
        return None

    def _snap(self, t, clip, mods):
        tl = self.editor.doc.timeline
        if mods & Qt.KeyboardModifier.AltModifier or not tl.snap:
            return t
        return min(clip.duration, max(0.0, tl.snap_time(clip.start + t) - clip.start))

    # ── Dessin ───────────────────────────────────────────────────────────
    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(0.5, 0.5, self.width() - 1, self.height() - 1)
        p.setPen(QPen(theme.qc(theme.BORDER), 1))
        p.setBrush(theme.qc(theme.BG_FIELD))
        p.drawRoundedRect(r, 3, 3)
        clip, auto = self.target()
        if auto is None:
            p.end()
            return
        a = self._area()
        self._draw_grid(p, clip, a)
        xs = [a.left() + i for i in range(int(a.width()) + 1)]
        if self._is_color():
            for x in xs:
                v = auto.value_at(clip.u(self._t(x, clip)))
                if v is not None:
                    p.fillRect(QRectF(x, a.center().y() - 5, 1.2, 10), QColor.fromRgbF(*v))
        elif auto.keys:
            pts = [QPointF(x, self._y(auto.value_at(clip.u(self._t(x, clip))), auto)) for x in xs]
            p.setPen(QPen(theme.qc(theme.TEXT, 0.8), 1.3))
            p.drawPolyline(QPolygonF(pts))
        # Tête de lecture (si elle est dans le clip)
        tl = self.editor.view_time() - clip.start
        if 0.0 <= tl <= clip.duration:
            x = self._x(tl, clip)
            p.setPen(QPen(theme.qc(theme.TEXT, 0.45), 1))
            p.drawLine(QPointF(x, r.top() + 1), QPointF(x, r.bottom() - 1))
        if getattr(self, "_guide_y", None) is not None:
            p.setPen(QPen(theme.qc(theme.TEXT_DIM, 0.8), 1, Qt.PenStyle.DashLine))
            p.drawLine(QPointF(a.left(), self._guide_y), QPointF(a.right(), self._guide_y))
        # Clés
        sel = self.drag["key"] if self.drag else None
        for k in auto.keys:
            kx, ky = self._x(clip.secs(k.t), clip), self._y(k.v, auto)
            p.setPen(QPen(theme.qc(theme.ACCENT) if k is sel else theme.qc(theme.TEXT, 0.85), 1.1))
            if self._is_color():
                p.setBrush(QColor.fromRgbF(*k.v))
            else:
                p.setBrush(theme.qc(theme.ACCENT) if k is sel else theme.qc(theme.BG_FIELD))
            p.drawPolygon(QPolygonF([QPointF(kx, ky - 4), QPointF(kx + 4, ky), QPointF(kx, ky + 4), QPointF(kx - 4, ky)]))
        p.end()

    def _draw_grid(self, p, clip, a):
        """Traits de la grille musicale choisie (mesures, temps, subdivisions), sans numéros."""
        from ..timeline.draw import grid_lines
        tl = self.editor.doc.timeline
        pps = a.width() / max(clip.duration, 1e-9)
        lines, _ = grid_lines(tl, clip.start, clip.end, pps)
        alpha = {0: 0.16, 1: 0.08, 2: 0.045}
        for t, level, _ in lines:
            if clip.start - 1e-9 <= t <= clip.end + 1e-9:
                x = self._x(t - clip.start, clip)
                p.setPen(QPen(theme.qc("#ffffff", alpha.get(level, 0.045)), 1))
                p.drawLine(QPointF(x, 1.5), QPointF(x, self.height() - 1.5))

    # ── Souris ───────────────────────────────────────────────────────────
    def mousePressEvent(self, e):
        clip, auto = self.target()
        if auto is None:
            return
        pos = e.position()
        k = self._key_at(pos, clip, auto)
        if e.button() == Qt.MouseButton.RightButton:
            if k is not None:
                self.editor.timeline_mutate("Supprimer la clé", lambda: auto.keys.remove(k))
            return
        if e.button() != Qt.MouseButton.LeftButton:
            return
        self.editor.begin("Clé d'automation")
        existing = k is not None
        if k is None:
            t = self._snap(self._t(pos.x(), clip), clip, e.modifiers())
            v = auto.value_at(clip.u(t)) if self._is_color() else self._v(pos.y(), auto)
            if v is None:
                self.editor.history.cancel()
                return
            k = auto.set_key(clip.u(t), v)
            self.editor.notify(timeline=True)
        self.drag = {"key": k, "clip": clip, "auto": auto, "pos": pos, "moved": False, "existing": existing}
        self.editor.set_preview_time(clip.start + clip.secs(k.t), clip.id)
        self.update()

    def mouseMoveEvent(self, e):
        d = self.drag
        if d is None:
            return
        clip, auto, k = d["clip"], d["auto"], d["key"]
        pos = e.position()
        if not d["moved"]:
            if abs(pos.x() - d["pos"].x()) < 3 and abs(pos.y() - d["pos"].y()) < 3:
                return          # pas encore un glisser (un simple clic change le type de courbe)
            d["moved"] = True
        k.t = clip.u(self._snap(self._t(pos.x(), clip), clip, e.modifiers()))
        self._guide_y = None
        if not self._is_color():
            k.v = self._v(pos.y(), auto)
            # Maj : la valeur s'aimante sur la valeur par défaut du réglage (0°, 0, 100 %…)
            if e.modifiers() & Qt.KeyboardModifier.ShiftModifier and self.spec.kind in ("float", "int"):
                dv = self.spec.default_value()
                gy = self._y(dv, auto)
                self._guide_y = gy
                if abs(pos.y() - gy) <= 8:
                    k.v = dv
        auto.sort()
        # La mire montre l'instant de la clé avec sa valeur (comme dans la timeline)
        self.editor.set_preview_time(clip.start + clip.secs(k.t), clip.id)
        self.editor.notify(timeline=True)

    def mouseReleaseEvent(self, e):
        d = self.drag
        if d is None:
            return
        self.drag = None
        self._guide_y = None
        if d["existing"] and not d["moved"]:
            # Simple clic sur un point : rampe → carré → sinusoïdale
            label = d["auto"].cycle_curve(d["key"])
            if label:
                self.editor.statusMessage.emit(f"Courbe : {label} (cliquer à nouveau pour changer)")
        self.editor.set_preview_time(None)
        self.editor.commit()
        self.editor.notify(timeline=True)
