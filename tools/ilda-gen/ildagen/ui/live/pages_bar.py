"""Barre des pages de l'espace Live : onglets des pages (Intro, Couplet…) et « + » à gauche ; à droite le mode de
départ (Immédiat | Au temps | À la mesure), « Plusieurs cues » et « Tout arrêter ».

Onglets : clic = afficher la page, double-clic = renommer sur place, glisser = déplacer, clic droit = menu
(renommer, déplacer, nouvelle page, supprimer).
"""

from PySide6.QtCore import QRectF, QSize, Qt, Signal
from PySide6.QtGui import QFont, QFontMetrics, QPainter, QPainterPath
from PySide6.QtWidgets import (QApplication, QHBoxLayout, QLabel, QLineEdit, QPushButton, QSizePolicy,
                               QToolButton, QWidget)

from ...core.live import LAUNCH_MODES
from .. import icons, theme
from ..widgets import Segmented, Switch
from .menus import page_menu

PAD, GAP, TAB_H = 12, 2, 24


class _NameEdit(QLineEdit):
    """Champ de renommage posé sur l'onglet : Entrée ou clic ailleurs = valider, Échap = annuler."""
    cancelled = Signal()

    def keyPressEvent(self, e):
        if e.key() == Qt.Key.Key_Escape.value:
            self.cancelled.emit()
            return
        super().keyPressEvent(e)


class PageTabs(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self._hover = -1
        self._press = None        # (position, index) du clic
        self._target = None       # glisser : place visée
        self._edit = None
        self.setMouseTracking(True)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)

    def pages(self):
        return self.editor.doc.live.pages

    def _fonts(self):
        f = theme.ui_font(12)
        fb = QFont(f)
        fb.setWeight(QFont.Weight.DemiBold)
        return f, fb

    def tab_rects(self):
        fb = QFontMetrics(self._fonts()[1])
        out, x = [], 0.0
        y = (self.height() - TAB_H) / 2
        for p in self.pages():
            w = fb.horizontalAdvance(p.name) + 2 * PAD
            out.append(QRectF(x, y, w, TAB_H))
            x += w + GAP
        return out

    def sizeHint(self):
        rects = self.tab_rects()
        return QSize(int(rects[-1].right()) + 2 if rects else 10, 28)

    def minimumSizeHint(self):
        return QSize(60, 28)

    def index_at(self, pos):
        return next((i for i, r in enumerate(self.tab_rects()) if r.contains(pos)), -1)

    def refresh(self):
        self.updateGeometry()
        self.update()

    # ── Rendu ────────────────────────────────────────────────────────────
    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        f, fb = self._fonts()
        cur = self.editor.live_page().id
        rects = self.tab_rects()
        for i, (r, page) in enumerate(zip(rects, self.pages())):
            on = page.id == cur
            if on or i == self._hover:
                path = QPainterPath()
                path.addRoundedRect(r, theme.RADIUS, theme.RADIUS)
                p.fillPath(path, theme.qc(theme.SEL if on else theme.BG_HOVER))
            if on:
                p.fillRect(QRectF(r.left(), r.bottom() - 2, r.width(), 2), theme.qc(theme.ACCENT))
            p.setFont(fb if on else f)
            p.setPen(theme.qc(theme.TEXT if on or i == self._hover else theme.TEXT_DIM))
            p.drawText(r, Qt.AlignmentFlag.AlignCenter, page.name)
        if self._target is not None and self._press is not None and rects:
            src = self._press[1]
            r = rects[self._target]
            x = r.left() - GAP / 2 if self._target < src else r.right() + GAP / 2
            p.fillRect(QRectF(x - 1, r.top(), 2, r.height()), theme.qc(theme.ACCENT))
        p.end()

    # ── Souris ───────────────────────────────────────────────────────────
    def mousePressEvent(self, e):
        i = self.index_at(e.position())
        if e.button() != Qt.MouseButton.LeftButton or i < 0:
            return
        self._press = (e.position(), i)
        self.editor.set_live_page(self.pages()[i].id)

    def mouseMoveEvent(self, e):
        if self._press is not None and e.buttons() & Qt.MouseButton.LeftButton:
            if (self._target is not None
                    or (e.position() - self._press[0]).manhattanLength() >= QApplication.startDragDistance()):
                rects = self.tab_rects()
                x = e.position().x()
                self._target = max(0, min(len(rects) - 1, next(
                    (i for i, r in enumerate(rects) if x < r.right()), len(rects) - 1)))
                self.update()
            return
        i = self.index_at(e.position())
        if i != self._hover:
            self._hover = i
            self.update()

    def mouseReleaseEvent(self, e):
        press, target = self._press, self._target
        self._press = self._target = None
        if press is not None and target is not None and target != press[1]:
            self.editor.move_page(self.pages()[press[1]].id, target)
        self.update()

    def leaveEvent(self, e):
        self._hover = -1
        self.update()
        super().leaveEvent(e)

    def mouseDoubleClickEvent(self, e):
        i = self.index_at(e.position())
        if i >= 0:
            self.start_rename(self.pages()[i].id)

    def contextMenuEvent(self, e):
        i = self.index_at(e.pos().toPointF())
        if i >= 0:
            page_menu(self, self.editor, self.pages()[i]).exec(e.globalPos())

    # ── Renommer sur place ───────────────────────────────────────────────
    def start_rename(self, page_id):
        page = self.editor.doc.live.find_page(page_id)
        if page is None:
            return
        self.finish_rename(False)
        r = self.tab_rects()[self.pages().index(page)]
        ed = _NameEdit(page.name, self)
        ed.setGeometry(r.adjusted(0, 0, 40, 0).toRect())
        ed.selectAll()
        ed.editingFinished.connect(lambda: self.finish_rename(True))
        ed.cancelled.connect(lambda: self.finish_rename(False))
        ed.page_id = page_id
        self._edit = ed
        ed.show()
        ed.setFocus()

    def finish_rename(self, commit):
        ed, self._edit = self._edit, None
        if ed is None:
            return
        if commit:
            self.editor.rename_page(ed.page_id, ed.text())
        ed.hide()
        ed.deleteLater()


class PagesBar(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setObjectName("bar")
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground)
        self.setFixedHeight(36)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(8, 0, 10, 0)
        lay.setSpacing(4)
        self.tabs = PageTabs(editor)
        lay.addWidget(self.tabs, 0)
        self.btn_add = QToolButton()
        self.btn_add.setIcon(icons.icon("plus", 14))
        self.btn_add.setIconSize(icons.qsize(14))
        self.btn_add.setToolTip("Nouvelle page")
        self.btn_add.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.btn_add.clicked.connect(lambda: editor.add_page())
        lay.addWidget(self.btn_add)
        lay.addStretch(1)

        lay.addWidget(self._label("Départ"))
        lay.addSpacing(4)
        self.launch = Segmented(LAUNCH_MODES, editor.doc.live.launch)
        self.launch.set_tooltips(["Le cue part tout de suite", "Le cue part au prochain temps",
                                  "Le cue part au début de la prochaine mesure"])
        self.launch.currentChanged.connect(editor.set_launch)
        lay.addWidget(self.launch)
        lay.addSpacing(18)
        lay.addWidget(self._label("Plusieurs cues"))
        lay.addSpacing(4)
        self.multi = Switch(editor.doc.live.multi, text=False)
        self.multi.setToolTip("Oui : les cues lancés jouent ensemble. Non : un cue lancé arrête le précédent")
        self.multi.clicked.connect(editor.set_multi)
        lay.addWidget(self.multi)
        lay.addSpacing(14)
        self.btn_stop = QPushButton("Tout arrêter")
        self.btn_stop.setIcon(icons.icon("square-stop", 13, color="TEXT"))
        self.btn_stop.setIconSize(icons.qsize(13))
        self.btn_stop.setFixedHeight(22)
        self.btn_stop.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.btn_stop.setToolTip("Arrêter tous les cues et les effets rapides (Échap)")
        self.btn_stop.clicked.connect(editor.stop_all_cues)
        lay.addWidget(self.btn_stop)

    @staticmethod
    def _label(text):
        lab = QLabel(text)
        lab.setObjectName("dim")
        return lab

    def refresh(self):
        live = self.editor.doc.live
        self.launch.set_current(live.launch)
        self.multi.set_value(live.multi)
        self.tabs.refresh()
