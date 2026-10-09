"""Bibliothèque de Show, partie « Effets » : recherche, catégories, favoris ★ (gardés dans les réglages,
ui.fav_effects ; l'étoile à droite du champ de recherche ne montre que les favoris).

Glisser un effet sur un clip de la timeline = l'y poser ; double-clic = le poser sur le clip actif.
Infobulle : la description de l'effet.
"""

from PySide6.QtCore import QEvent, QMimeData, QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QDrag, QPainter
from PySide6.QtWidgets import QHBoxLayout, QLineEdit, QSizePolicy, QToolButton, QToolTip, QVBoxLayout, QWidget

from ...core.effects import by_category
from .. import icons, theme
from ..timeline.drops import EFFECT_MIME

ROW_H = 24
CAT_H = 24


def _fold(s):
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


class EffectRows(QWidget):
    """Liste peinte : en-têtes de catégorie et lignes d'effet (icône, nom, étoile)."""
    addRequested = Signal(str)

    def __init__(self, settings, parent=None):
        super().__init__(parent)
        self.settings = settings
        self.query = ""
        self.only_fav = False
        self.items = []           # [(« cat » | « fx », texte | type d'effet, y)]
        self.hover = -1
        self._press = None
        self.setMouseTracking(True)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.relayout()

    # ── Favoris ──────────────────────────────────────────────────────────
    def favorites(self):
        v = self.settings.section("ui").get("fav_effects", [])
        return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []

    def toggle_fav(self, type_id):
        fav = self.favorites()
        fav = [f for f in fav if f != type_id] if type_id in fav else fav + [type_id]
        self.settings.set("ui", "fav_effects", fav)
        self.relayout()

    # ── Contenu ──────────────────────────────────────────────────────────
    def set_filter(self, query=None, only_fav=None):
        if query is not None:
            self.query = query
        if only_fav is not None:
            self.only_fav = only_fav
        self.relayout()

    def relayout(self):
        q = _fold(self.query.strip())
        fav = set(self.favorites())
        items = []
        y = 0
        for cat, types in by_category():
            shown = [et for et in types if (not q or q in _fold(et.label) or q in _fold(et.description))
                     and (not self.only_fav or et.type_id in fav)]
            if not shown:
                continue
            items.append(("cat", cat, y))
            y += CAT_H
            for et in shown:
                items.append(("fx", et, y))
                y += ROW_H
        self.items = items
        self.setFixedHeight(max(ROW_H, y + 6))
        self.update()

    def visible_types(self):
        return [it[1].type_id for it in self.items if it[0] == "fx"]

    def index_at(self, y):
        for i, (kind, _, iy) in enumerate(self.items):
            if iy <= y < iy + (CAT_H if kind == "cat" else ROW_H):
                return i
        return -1

    def star_rect(self, iy):
        return QRectF(self.width() - 26, iy + 4, 16, 16)

    def sizeHint(self):
        return QSize(220, self.height())

    # ── Rendu ────────────────────────────────────────────────────────────
    def paintEvent(self, _e):
        p = QPainter(self)
        fav = set(self.favorites())
        for i, (kind, obj, y) in enumerate(self.items):
            if kind == "cat":
                p.setFont(theme.ui_font(11, True))
                p.setPen(theme.qc(theme.TEXT_OFF))
                p.drawText(QRectF(10, y + 6, self.width() - 20, CAT_H - 6), Qt.AlignmentFlag.AlignVCenter, obj)
                continue
            r = QRectF(0, y, self.width(), ROW_H)
            if i == self.hover:
                p.fillRect(r, theme.qc(theme.BG_HOVER))
            p.drawPixmap(QPointF(10, y + 5), icons.pixmap(obj.icon, theme.TEXT_DIM, 14))
            p.setFont(theme.ui_font(12))
            p.setPen(theme.qc(theme.TEXT))
            p.drawText(QRectF(32, y, self.width() - 64, ROW_H), Qt.AlignmentFlag.AlignVCenter, obj.label)
            on = obj.type_id in fav
            if on or i == self.hover:
                col = theme.TEXT if on else theme.TEXT_OFF
                sr = self.star_rect(y)
                p.drawPixmap(QPointF(sr.left() + 1, sr.top() + 1), icons.pixmap("star", col, 14))
        p.end()

    # ── Souris ───────────────────────────────────────────────────────────
    def mouseMoveEvent(self, e):
        y = e.position().y()
        i = self.index_at(y)
        if i != self.hover:
            self.hover = i
            self.update()
        if self._press is not None and (e.buttons() & Qt.MouseButton.LeftButton) \
                and (e.position() - self._press[1]).manhattanLength() > 6:
            type_id = self._press[0]
            self._press = None
            drag = QDrag(self)
            drag.setMimeData(self.mime(type_id))
            drag.exec(Qt.DropAction.CopyAction)

    def mime(self, type_id):
        md = QMimeData()
        md.setData(EFFECT_MIME, type_id.encode("utf-8"))
        return md

    def mousePressEvent(self, e):
        i = self.index_at(e.position().y())
        if e.button() != Qt.MouseButton.LeftButton or i < 0 or self.items[i][0] != "fx":
            return
        et = self.items[i][1]
        if self.star_rect(self.items[i][2]).adjusted(-4, -4, 4, 4).contains(e.position()):
            self.toggle_fav(et.type_id)
            return
        self._press = (et.type_id, e.position())

    def mouseReleaseEvent(self, e):
        self._press = None

    def mouseDoubleClickEvent(self, e):
        i = self.index_at(e.position().y())
        if i >= 0 and self.items[i][0] == "fx":
            self.addRequested.emit(self.items[i][1].type_id)

    def leaveEvent(self, e):
        self.hover = -1
        self.update()
        super().leaveEvent(e)

    def event(self, e):
        if e.type() == QEvent.Type.ToolTip:
            i = self.index_at(e.pos().y())
            if i >= 0 and self.items[i][0] == "fx" and self.items[i][1].description:
                QToolTip.showText(e.globalPos(), self.items[i][1].description, self)
            else:
                QToolTip.hideText()
            return True
        return super().event(e)


class EffectBrowser(QWidget):
    """Recherche + étoile « favoris seulement » + liste des effets."""

    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        row = QHBoxLayout()
        row.setContentsMargins(8, 2, 8, 4)
        row.setSpacing(4)
        self.search = QLineEdit()
        self.search.setPlaceholderText("Rechercher")
        self.search.setClearButtonEnabled(True)
        self.search.addAction(icons.icon("search", 14), QLineEdit.ActionPosition.LeadingPosition)
        self.search.textChanged.connect(lambda t: self.rows.set_filter(query=t))
        row.addWidget(self.search, 1)
        self.fav_btn = QToolButton()
        self.fav_btn.setCheckable(True)
        self.fav_btn.setIcon(icons.icon("star", 14))
        self.fav_btn.setToolTip("Favoris seulement (★ à droite d'un effet pour l'ajouter)")
        self.fav_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.fav_btn.toggled.connect(lambda on: self.rows.set_filter(only_fav=on))
        row.addWidget(self.fav_btn)
        lay.addLayout(row)
        self.rows = EffectRows(editor.settings)
        self.rows.addRequested.connect(self.add_to_current)
        lay.addWidget(self.rows)
        lay.addStretch(1)

    def add_to_current(self, type_id):
        ed = self.editor
        clip = ed.current_clip()
        if clip is None:
            ed.statusMessage.emit("Sélectionnez d'abord un clip dans la timeline (ou glissez l'effet sur un clip)")
            return None
        return ed.add_effect(clip.id, type_id)
