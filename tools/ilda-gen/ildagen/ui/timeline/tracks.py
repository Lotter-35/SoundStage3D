"""En-têtes des pistes : bande de couleur (clic : choisir la couleur), nom (double-clic : renommer sur place ;
glisser : changer l'ordre des pistes), cadenas, muet (M), solo (S). Champ de saisie posé sur un nom (pistes,
repères) : Entrée ou clic ailleurs valide, Échap annule."""

from PySide6.QtCore import QEvent, QObject, QRectF, Qt
from PySide6.QtWidgets import QLineEdit

from .draw import header_buttons
from .geometry import HEADER_W

COLOR_W = 8


class _InlineFilter(QObject):
    def __init__(self, canvas, parent):
        super().__init__(parent)
        self.canvas = canvas

    def eventFilter(self, obj, e):
        if e.type() == QEvent.Type.KeyPress and e.key() == Qt.Key.Key_Escape:
            self.canvas.close_inline(commit=False)
            return True
        if e.type() == QEvent.Type.ShortcutOverride and e.key() == Qt.Key.Key_Escape:
            e.accept()
            return True
        if e.type() == QEvent.Type.FocusOut:
            self.canvas.close_inline(commit=True)
        return False


class TrackHeaders:
    # ── Zones ────────────────────────────────────────────────────────────
    def header_zone(self, row, x, y):
        if x < COLOR_W:
            return "color"
        for name, (bx, by, bw, bh) in header_buttons(row).items():
            if bx - 1 <= x <= bx + bw + 1 and by - 2 <= y <= by + bh + 2:
                return name
        return "name"

    def press_header(self, row, x, y):
        zone = self.header_zone(row, x, y)
        tr = row.track
        ed = self.editor
        if zone == "color":
            self.exec_menu(self.build_color_menu(tr))
        elif zone == "lock":
            ed.set_track_flag(tr.id, "locked", not tr.locked)
        elif zone in ("muted", "solo"):
            ed.set_track_flag(tr.id, zone, not getattr(tr, zone))
        else:
            self.drag = {"kind": "track_move", "id": tr.id, "y0": y, "moved": False, "index": row.index}

    # ── Ordre des pistes (glisser l'en-tête) ─────────────────────────────
    def drag_track(self, y):
        d = self.drag
        if not d["moved"] and abs(y - d["y0"]) < 5:
            return
        d["moved"] = True
        rows = self.rows()
        i = len(rows)
        for r in rows:
            if y < r.y + r.h / 2:
                i = r.index
                break
        d["index"] = i
        d["line"] = rows[i].y if i < len(rows) else (rows[-1].y + rows[-1].h if rows else self.geo.top)

    def end_track(self):
        d = self.drag
        if not d["moved"]:
            return
        tl = self.tl
        tr = tl.find_track(d["id"])
        if tr is None:
            return
        cur = tl.tracks.index(tr)
        dest = d["index"] - (1 if d["index"] > cur else 0)
        self.editor.move_track(tr.id, dest)

    def track_drop_y(self):
        d = self.drag
        if d is not None and d.get("kind") == "track_move" and d.get("moved"):
            return d.get("line")
        return None

    # ── Renommer sur place ───────────────────────────────────────────────
    def rename_track_inline(self, row):
        h = min(row.h, 64)
        r = QRectF(6, row.y + (h - 22) / 2, HEADER_W - 64, 22)
        self.open_inline(r, row.track.name, lambda name, tid=row.track.id: self.editor.rename_track(tid, name))

    def open_inline(self, rect, text, on_commit):
        self.close_inline(commit=False)
        le = QLineEdit(self)
        le.setText(text)
        le.setGeometry(rect.toAlignedRect())
        le.installEventFilter(_InlineFilter(self, le))
        le.returnPressed.connect(lambda: self.close_inline(commit=True))
        self.inline = (le, on_commit)
        le.show()
        le.setFocus(Qt.FocusReason.OtherFocusReason)
        le.selectAll()

    def close_inline(self, commit=True):
        if self.inline is None:
            return False
        le, on_commit = self.inline
        self.inline = None
        text = le.text().strip()
        le.blockSignals(True)
        le.hide()
        le.deleteLater()
        if commit and text:
            on_commit(text)
        self.setFocus()
        self.update()
        return True
