"""Mini-éditeur de courbe (inspecteur du clip, réglage en mode « Courbe ») : mêmes gestes que les lignes de la
timeline — clic sur une clé : la sélectionner ; glisser : la déplacer (aimantée à la grille du morceau ;
Alt = libre ; Maj = valeur par défaut) ; double-clic : nouvelle clé ; clic droit : menu ; Suppr : supprimer.
"""

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QActionGroup, QColor, QPainter, QPainterPath, QPen, QPolygonF
from PySide6.QtWidgets import QMenu, QSizePolicy, QWidget

from .. import theme
from ..timeline import curves as CV

H = 44
PAD_X = 6


class MiniCurve(QWidget):
    def __init__(self, editor, clip_id, effect_id, key, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.clip_id, self.effect_id, self.key = clip_id, effect_id, key
        self.sel = None              # clé sélectionnée (objet)
        self.drag = None
        self.setFixedHeight(H)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setFocusPolicy(Qt.FocusPolicy.ClickFocus)
        self.setCursor(Qt.CursorShape.CrossCursor)

    # ── Modèle ───────────────────────────────────────────────────────────
    def track(self):
        _, e = self.editor.find_effect(self.effect_id)
        return e.params.get(self.key) if e is not None else None

    def spec(self):
        return self.editor.effect_param_spec(self.effect_id, self.key)

    def clip(self):
        return self.editor.doc.timeline.find_clip(self.clip_id)[1]

    def lmap(self):
        return CV.LaneMap(PAD_X, self.width() - PAD_X, 6, self.height() - 6, self.spec())

    def sel_index(self):
        t = self.track()
        if t is None or self.sel is None or self.sel not in t.curve.keys:
            self.sel = None
            return None
        return t.curve.keys.index(self.sel)

    def snap_u(self, u, mods):
        clip = self.clip()
        tl = self.editor.doc.timeline
        if clip is None or not tl.snap or mods & Qt.KeyboardModifier.AltModifier:
            return min(1.0, max(0.0, u))
        t = tl.snap_time(clip.start + u * clip.duration, force=True)
        return min(1.0, max(0.0, (t - clip.start) / clip.duration))

    # ── Rendu ────────────────────────────────────────────────────────────
    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(0.5, 0.5, self.width() - 1, self.height() - 1)
        path = QPainterPath()
        path.addRoundedRect(r, 2, 2)
        p.fillPath(path, theme.qc(theme.BG_FIELD))
        if self.hasFocus():
            p.setPen(QPen(theme.qc(theme.BORDER_STRONG), 1))
            p.drawPath(path)
        t = self.track()
        if t is None:
            return
        m = self.lmap()
        spec = m.spec
        if self.drag is not None and self.drag.get("guide") is not None:
            p.setPen(QPen(theme.qc(theme.TEXT_DIM), 1, Qt.PenStyle.DashLine))
            p.drawLine(QPointF(m.x0, self.drag["guide"]), QPointF(m.x1, self.drag["guide"]))
        if CV.is_color(spec):
            n = 48
            w = (m.x1 - m.x0) / n
            for i in range(n):
                v = t.curve.value_at((i + 0.5) / n)
                if isinstance(v, (tuple, list)):
                    p.fillRect(QRectF(m.x0 + i * w, self.height() / 2 - 6, w + 0.5, 12),
                               QColor.fromRgbF(*[min(1.0, max(0.0, c)) for c in v[:3]]))
        else:
            pts = m.screen(t.curve)
            if len(pts):
                p.setPen(QPen(theme.qc(theme.TEXT, 0.8), 1.3))
                p.drawPolyline(QPolygonF([QPointF(x, y) for x, y in pts]))
        for k in t.curve.keys:
            if not -1e-9 <= k.t <= 1.0 + 1e-9:
                continue
            x, y = m.key_pos(k)
            on = k is self.sel
            rr = 5.0 if on else 4.0
            p.setPen(QPen(theme.qc(theme.ACCENT) if on else theme.qc(theme.TEXT, 0.9), 1.2))
            p.setBrush(theme.qc(theme.ACCENT) if on else theme.qc(theme.BG_FIELD))
            p.drawPolygon(QPolygonF([QPointF(x, y - rr), QPointF(x + rr, y), QPointF(x, y + rr), QPointF(x - rr, y)]))
        p.end()

    # ── Souris ───────────────────────────────────────────────────────────
    def mousePressEvent(self, e):
        t = self.track()
        if t is None:
            return
        pos = e.position()
        i = self.lmap().key_at(t.curve, pos.x(), pos.y(), 6)
        self.sel = t.curve.keys[i] if i is not None else None
        if e.button() == Qt.MouseButton.RightButton:
            if self.sel is not None:
                self.key_menu().exec(e.globalPosition().toPoint())
            self.update()
            return
        if self.sel is not None and e.button() == Qt.MouseButton.LeftButton:
            self.drag = {"x0": pos.x(), "y0": pos.y(), "moved": False, "guide": None}
        self.update()

    def mouseMoveEvent(self, e):
        d = self.drag
        if d is None or self.sel is None:
            return
        pos = e.position()
        if not d["moved"]:
            if abs(pos.x() - d["x0"]) < 3 and abs(pos.y() - d["y0"]) < 3:
                return
            d["moved"] = True
            self.editor.begin("Déplacer la clé")
        m = self.lmap()
        mods = e.modifiers()
        u = self.snap_u(m.xu(pos.x()), mods)
        v = None
        d["guide"] = None
        spec = m.spec
        if not CV.is_color(spec):
            v = m.yv(pos.y())
            if mods & Qt.KeyboardModifier.ShiftModifier and spec is not None and spec.kind in ("float", "int"):
                gy = m.vy(spec.default_value())
                d["guide"] = gy
                if abs(pos.y() - gy) <= 8:
                    v = spec.default_value()
        i = self.sel_index()
        if i is not None:
            self.editor.move_curve_key(self.effect_id, self.key, i, u, v)
        self.update()

    def mouseReleaseEvent(self, e):
        d, self.drag = self.drag, None
        if d is not None and d["moved"]:
            self.editor.commit()
            self.editor.notify(timeline=True)
        self.update()

    def mouseDoubleClickEvent(self, e):
        t = self.track()
        if t is None or e.button() != Qt.MouseButton.LeftButton:
            return
        m = self.lmap()
        pos = e.position()
        if m.key_at(t.curve, pos.x(), pos.y(), 6) is not None:
            return
        u = self.snap_u(m.xu(pos.x()), e.modifiers())
        v = t.curve.value_at(u) if CV.is_color(m.spec) else m.yv(pos.y())
        i = self.editor.set_curve_key(self.effect_id, self.key, u, t.value if v is None else v)
        t = self.track()
        self.sel = t.curve.keys[i] if (t is not None and i is not None) else None
        self.update()

    # ── Clavier, menu ────────────────────────────────────────────────────
    def event(self, e):
        from PySide6.QtCore import QEvent
        if e.type() == QEvent.Type.ShortcutOverride and e.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace) \
                and self.sel_index() is not None:
            e.accept()              # Suppr : la clé sélectionnée ici, pas les clips de la timeline
            return True
        return super().event(e)

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace) and self.delete_selected():
            return
        if e.key() == Qt.Key.Key_Escape and self.sel is not None:
            self.sel = None
            self.update()
            return
        super().keyPressEvent(e)

    def delete_selected(self):
        i = self.sel_index()
        if i is None:
            return False
        self.sel = None
        self.editor.remove_curve_key(self.effect_id, self.key, i)
        return True

    def key_menu(self):
        menu = QMenu(self)
        t = self.track()
        i = self.sel_index()
        if t is None or i is None:
            return menu
        k = t.curve.keys[i]
        menu.addAction("Supprimer la clé").triggered.connect(self.delete_selected)
        if not t.curve.discrete:
            sub = menu.addMenu("Type de courbe")
            group = QActionGroup(sub)
            for cid, label in CV.CURVE_MENU:
                a = sub.addAction(label)
                a.setCheckable(True)
                a.setChecked(k.curve == cid)
                group.addAction(a)
                a.triggered.connect(lambda _=False, c=cid: self.editor.set_curve_type(
                    self.effect_id, self.key, t.curve.keys.index(k), c))
        return menu
