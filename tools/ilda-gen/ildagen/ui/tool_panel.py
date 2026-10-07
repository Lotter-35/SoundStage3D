"""Barre d'outils de gauche : outils, formes de base, couleur, liste des formes du projet."""

from PySide6.QtCore import QMimeData, QSize, Qt, QTimer
from PySide6.QtGui import QPainter, QPixmap
from PySide6.QtWidgets import (QButtonGroup, QGridLayout, QHBoxLayout, QLabel, QListWidget, QListWidgetItem,
                               QMenu, QToolButton, QVBoxLayout, QWidget)

from ..core.evaluator import EvalContext, eval_children
from ..core.path import strokes_bbox
from ..core.shapes import BASIC_SHAPES
from . import icons, theme
from .canvas.painter import draw_strokes
from .canvas.view import DEF_MIME
from .canvas.viewport import Viewport
from .color_panel import ColorPanel
from .context_menu import ask_text

TOOLS = [("select", "Sélection", "mouse-pointer-2", "V"), ("pencil", "Crayon", "pencil", "B"),
         ("bucket", "Seau : colorier une forme ou une zone", "paint-bucket", "G")]
SHAPE_KEYS = {"line": "L", "rect": "R", "ellipse": "E", "triangle": "T", "star": "S", "polygon": "P", "ilda_test": "M"}
THUMB = 40


class ToolButton(QToolButton):
    """Bouton d'outil avec la lettre du raccourci en petit dans le coin."""

    def __init__(self, key, parent=None):
        super().__init__(parent)
        self.key = key

    def paintEvent(self, e):
        super().paintEvent(e)
        if not self.key:
            return
        p = QPainter(self)
        p.setFont(theme.ui_font(8, True))
        p.setPen(theme.qc(theme.TEXT_DIM if self.isChecked() else theme.TEXT_OFF))
        p.drawText(self.rect().adjusted(0, 0, -3, -1), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignBottom, self.key)
        p.end()


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
        # Un clic choisit la forme : la mire et les calques la montrent, on l'édite directement
        self.itemClicked.connect(lambda it: editor.enter_def(it.data(Qt.ItemDataRole.UserRole)))
        self.itemDoubleClicked.connect(self._rename)

    def mimeData(self, items):
        md = QMimeData()
        if items:
            md.setData(DEF_MIME, items[0].data(Qt.ItemDataRole.UserRole).encode("utf-8"))
        return md

    def mimeTypes(self):
        return [DEF_MIME]

    def delete_current(self):
        it = self.currentItem()
        if it is not None:
            d = self.editor.doc.library.get(it.data(Qt.ItemDataRole.UserRole))
            self.editor.delete_def(it.data(Qt.ItemDataRole.UserRole))
            if d is not None:
                self.editor.statusMessage.emit(f"Forme « {d.name} » supprimée (Ctrl+Z pour annuler)")

    def _rename(self, it):
        def_id = it.data(Qt.ItemDataRole.UserRole)
        d = self.editor.doc.library.get(def_id)
        if d is None:
            return
        name = ask_text(self, "Renommer la forme", "Nom :", d.name)
        if name:
            self.editor.rename_def(def_id, name)

    def _menu(self, pos):
        it = self.itemAt(pos)
        m = QMenu(self)
        a_new = m.addAction("Nouvelle forme")
        a_place = a_ren = a_dup = a_del = None
        if it is not None:
            def_id = it.data(Qt.ItemDataRole.UserRole)
            cur = self.editor.current_form()
            m.addSeparator()
            a_ren = m.addAction("Renommer… (double-clic)")
            a_dup = m.addAction("Dupliquer")
            if cur is not None and cur.id != def_id:
                a_place = m.addAction(f"Placer dans « {cur.name} »")
            m.addSeparator()
            a_del = m.addAction("Supprimer (Suppr)")
        chosen = m.exec(self.mapToGlobal(pos))
        if chosen is None:
            return
        if chosen is a_new:
            self.editor.new_form()
        elif chosen is a_place:
            self.editor.place_instance(def_id)
        elif chosen is a_ren:
            self._rename(it)
        elif chosen is a_dup:
            self.editor.duplicate_form(def_id)
        elif chosen is a_del:
            self.setCurrentItem(it)
            self.delete_current()


class ToolPanel(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setMinimumWidth(150)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(8, 4, 8, 8)
        lay.setSpacing(2)
        self.group = QButtonGroup(self)
        self.group.setExclusive(True)
        self.buttons = {}

        lay.addWidget(section("Outils"))
        lay.addLayout(self._grid([(t, f"{label} ({key})", ic, key) for t, label, ic, key in TOOLS]))
        lay.addWidget(section("Formes"))
        lay.addLayout(self._grid([(f"shape:{k}", f"{label} ({SHAPE_KEYS[k]})", ic, SHAPE_KEYS[k])
                                  for k, label, ic in BASIC_SHAPES]))
        lay.addWidget(section("Couleur"))
        lay.addWidget(ColorPanel(editor))
        head = QHBoxLayout()
        head.setContentsMargins(0, 0, 0, 0)
        head.addWidget(section("Formes perso"))
        head.addStretch(1)
        self.btn_new = QToolButton()
        self.btn_new.setIcon(icons.icon("plus", 14))
        self.btn_new.setIconSize(QSize(14, 14))
        self.btn_new.setAutoRaise(True)
        self.btn_new.setToolTip("Nouvelle forme (vide)")
        self.btn_new.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.btn_new.clicked.connect(lambda: editor.new_form())
        head.addWidget(self.btn_new, 0, Qt.AlignmentFlag.AlignBottom)
        lay.addLayout(head)
        self.defs = DefList(editor)
        self.defs.setToolTip("Clic : afficher et éditer la forme · Double-clic : renommer · "
                             "Glisser vers la timeline (ou dans une autre forme) · Suppr : supprimer")
        lay.addWidget(self.defs, 1)

        self._thumb_timer = QTimer(self)
        self._thumb_timer.setSingleShot(True)
        self._thumb_timer.timeout.connect(self.refresh_defs)
        editor.toolChanged.connect(self._tool_changed)
        editor.libraryChanged.connect(self.refresh_defs)
        editor.projectChanged.connect(self.refresh_defs)
        editor.docChanged.connect(self._doc_changed)
        editor.contextChanged.connect(self.highlight_context)
        self._tool_changed(editor.tool)
        self.refresh_defs()

    def _grid(self, items):
        g = QGridLayout()
        g.setSpacing(2)
        for i, (tool, tip, ic, key) in enumerate(items):
            b = ToolButton(key)
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
        self._thumb_timer.start(400)

    def highlight_context(self):
        """La forme en cours (ou celle du clip sélectionné dans la timeline) est surlignée dans la liste."""
        def_id = self.editor.current_form_id()
        if def_id is None:
            return
        for i in range(self.defs.count()):
            it = self.defs.item(i)
            if it.data(Qt.ItemDataRole.UserRole) == def_id:
                self.defs.setCurrentItem(it)
                self.defs.scrollToItem(it)
                return

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
        self.highlight_context()
