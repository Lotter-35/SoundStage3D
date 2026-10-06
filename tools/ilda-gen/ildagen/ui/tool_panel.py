"""Barre d'outils de gauche : outils, formes de base, formes personnalisées."""

from PySide6.QtCore import QMimeData, QSize, Qt, QTimer
from PySide6.QtGui import QPainter, QPixmap
from PySide6.QtWidgets import (QButtonGroup, QGridLayout, QLabel, QListWidget, QListWidgetItem, QMenu,
                               QMessageBox, QToolButton, QVBoxLayout, QWidget)

from ..core.evaluator import EvalContext, eval_children
from ..core.path import strokes_bbox
from ..core.shapes import BASIC_SHAPES
from . import icons, theme
from .canvas.painter import draw_strokes
from .canvas.view import DEF_MIME
from .canvas.viewport import Viewport
from .context_menu import ask_text

TOOLS = [("select", "Sélection", "mouse-pointer-2", "V"), ("pencil", "Crayon", "pencil", "B")]
SHAPE_KEYS = {"line": "L", "rect": "R", "ellipse": "E", "triangle": "T", "star": "S", "polygon": "P", "ilda_test": "M"}
THUMB = 40


def section(text):
    lab = QLabel(text.upper())
    lab.setObjectName("sectionTitle")
    lab.setContentsMargins(2, 8, 0, 2)
    return lab


def def_thumbnail(editor, d, size=THUMB):
    pm = QPixmap(size * 2, size * 2)
    pm.setDevicePixelRatio(2.0)
    pm.fill(theme.qc(theme.BG_MIRE))
    ctx = EvalContext(editor.doc.library, 0.0, editor.doc.timeline.bpm, editor.default_color())
    strokes = eval_children(d.root.children, ctx)
    b = strokes_bbox(strokes)
    if b:
        vt = Viewport()
        vt.resize(size, size)
        span = max(b[2] - b[0], b[3] - b[1], 1e-3)
        vt.zoom = 2.0 / span / 1.25
        vt.pan_x, vt.pan_y = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        p = QPainter(pm)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        draw_strokes(p, vt, strokes, width=1.2)
        p.end()
    return pm


class DefList(QListWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setIconSize(QSize(THUMB, THUMB))
        self.setDragEnabled(True)
        self.setDragDropMode(QListWidget.DragDropMode.DragOnly)
        self.setSpacing(1)
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self._menu)
        self.itemDoubleClicked.connect(lambda it: editor.enter_def(it.data(Qt.ItemDataRole.UserRole)))
        self.itemClicked.connect(self._clicked)

    def mimeData(self, items):
        md = QMimeData()
        if items:
            md.setData(DEF_MIME, items[0].data(Qt.ItemDataRole.UserRole).encode("utf-8"))
        return md

    def mimeTypes(self):
        return [DEF_MIME]

    def _clicked(self, it):
        if self.editor.display_mode() != "timeline" or self.editor.context[0] == "clip":
            self.editor.place_instance(it.data(Qt.ItemDataRole.UserRole))

    def _menu(self, pos):
        it = self.itemAt(pos)
        if it is None:
            return
        def_id = it.data(Qt.ItemDataRole.UserRole)
        d = self.editor.doc.library.get(def_id)
        m = QMenu(self)
        a_place = m.addAction("Placer dans la mire")
        a_edit = m.addAction("Éditer")
        a_ren = m.addAction("Renommer…")
        m.addSeparator()
        a_del = m.addAction("Supprimer…")
        chosen = m.exec(self.mapToGlobal(pos))
        if chosen is a_place:
            self.editor.place_instance(def_id)
        elif chosen is a_edit:
            self.editor.enter_def(def_id)
        elif chosen is a_ren:
            name = ask_text(self, "Renommer la forme", "Nom :", d.name)
            if name:
                self.editor.rename_def(def_id, name)
        elif chosen is a_del:
            r = QMessageBox.question(self, "Supprimer la forme",
                                     f"Supprimer « {d.name} » et toutes ses occurrences (scène et timeline) ?")
            if r == QMessageBox.StandardButton.Yes:
                self.editor.delete_def(def_id)


class ToolPanel(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setMinimumWidth(96)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(8, 4, 8, 8)
        lay.setSpacing(2)
        self.group = QButtonGroup(self)
        self.group.setExclusive(True)
        self.buttons = {}

        lay.addWidget(section("Outils"))
        lay.addLayout(self._grid([(t, f"{label} ({key})", ic) for t, label, ic, key in TOOLS]))
        lay.addWidget(section("Formes"))
        lay.addLayout(self._grid([(f"shape:{k}", f"{label} ({SHAPE_KEYS[k]})", ic) for k, label, ic in BASIC_SHAPES]))
        lay.addWidget(section("Formes perso"))
        self.defs = DefList(editor)
        self.defs.setToolTip("Clic : placer · Double-clic : éditer · Glisser vers la mire ou la timeline")
        lay.addWidget(self.defs, 1)
        self.empty = QLabel("Sélectionnez des calques puis clic droit → Créer une forme personnalisée.")
        self.empty.setWordWrap(True)
        self.empty.setObjectName("dim")
        lay.addWidget(self.empty)

        self._thumb_timer = QTimer(self)
        self._thumb_timer.setSingleShot(True)
        self._thumb_timer.timeout.connect(self.refresh_defs)
        editor.toolChanged.connect(self._tool_changed)
        editor.libraryChanged.connect(self.refresh_defs)
        editor.projectChanged.connect(self.refresh_defs)
        editor.docChanged.connect(self._doc_changed)
        self._tool_changed(editor.tool)
        self.refresh_defs()

    def _grid(self, items):
        g = QGridLayout()
        g.setSpacing(2)
        for i, (tool, tip, ic) in enumerate(items):
            b = QToolButton()
            b.setIcon(icons.icon(ic, 18, active_color=theme.TEXT))
            b.setIconSize(QSize(18, 18))
            b.setFixedSize(34, 30)
            b.setCheckable(True)
            b.setToolTip(tip)
            b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            b.clicked.connect(lambda _=False, t=tool: self.editor.set_tool(t))
            self.group.addButton(b)
            self.buttons[tool] = b
            g.addWidget(b, i // 2, i % 2)
        g.setColumnStretch(2, 1)
        return g

    def _tool_changed(self, tool):
        b = self.buttons.get(tool)
        if b is not None:
            b.setChecked(True)

    def _doc_changed(self):
        if self.editor.context[0] in ("def", "clip"):
            self._thumb_timer.start(400)

    def refresh_defs(self):
        cur = self.defs.currentItem().data(Qt.ItemDataRole.UserRole) if self.defs.currentItem() else None
        self.defs.clear()
        for d in self.editor.doc.library.defs:
            it = QListWidgetItem(d.name)
            it.setIcon(def_thumbnail(self.editor, d))
            it.setData(Qt.ItemDataRole.UserRole, d.id)
            self.defs.addItem(it)
            if d.id == cur:
                self.defs.setCurrentItem(it)
        has = bool(self.editor.doc.library.defs)
        self.empty.setVisible(not has)
