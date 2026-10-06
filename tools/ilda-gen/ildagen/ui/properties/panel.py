"""Panneau Propriétés (sous les calques, repliable)."""

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QHBoxLayout, QLabel, QScrollArea, QToolButton, QVBoxLayout, QWidget

from ...core.shapes import SHAPE_LABELS
from .. import icons
from .forms import ParamForm
from .widgets import ScrubField

KIND_LABELS = {"group": "Groupe", "instance": "Forme personnalisée", "modifier": "Modifieur"}


class PanelHeader(QWidget):
    def __init__(self, title, collapsible=False, parent=None):
        super().__init__(parent)
        self.setObjectName("panelHeader")
        self.setFixedHeight(28)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(10, 0, 6, 0)
        lay.setSpacing(4)
        self.title = QLabel(title.upper())
        self.title.setObjectName("sectionTitle")
        lay.addWidget(self.title)
        lay.addStretch(1)
        self.extra = QHBoxLayout()
        self.extra.setSpacing(4)
        lay.addLayout(self.extra)
        self.toggle = None
        if collapsible:
            self.toggle = QToolButton()
            self.toggle.setAutoRaise(True)
            self.toggle.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            self.toggle.setIconSize(icons.qsize(14))
            lay.addWidget(self.toggle)


class PropertiesPanel(QWidget):
    collapsedChanged = Signal(bool)

    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.collapsed = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.header = PanelHeader("Propriétés", collapsible=True)
        self.header.toggle.clicked.connect(lambda: self.set_collapsed(not self.collapsed))
        lay.addWidget(self.header)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        lay.addWidget(self.scroll, 1)
        editor.selectionChanged.connect(self.rebuild)
        editor.structureChanged.connect(self.rebuild)
        editor.contextChanged.connect(self.rebuild)
        editor.timelineChanged.connect(self._timeline_changed)
        self._clip_fields = None
        self.set_collapsed(False)
        self.rebuild()

    def set_collapsed(self, on):
        self.collapsed = on
        self.scroll.setVisible(not on)
        self.header.toggle.setIcon(icons.icon("chevron-right" if on else "chevron-down", 14))
        self.header.toggle.setToolTip("Déplier" if on else "Replier")
        self.setMaximumHeight(self.header.height() if on else 16777215)
        self.collapsedChanged.emit(on)

    def _timeline_changed(self):
        if self._clip_fields is not None:
            self._refresh_clip()

    def rebuild(self):
        self._clip_fields = None
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        nodes = self.editor.selected_nodes()
        if len(nodes) == 1:
            n = nodes[0]
            kind = KIND_LABELS.get(n.kind) or SHAPE_LABELS.get(getattr(n, "shape", ""), "Forme")
            if n.kind == "modifier":
                kind = f"Modifieur · {n.modifier.category}"
            title = QLabel(f"{n.name}   <span style='color:#8a8d96'>{kind}</span>")
            title.setTextFormat(Qt.TextFormat.RichText)
            title.setContentsMargins(10, 8, 10, 0)
            lay.addWidget(title)
            if n.kind == "modifier" and n.modifier.description:
                d = QLabel(n.modifier.description)
                d.setWordWrap(True)
                d.setObjectName("dim")
                d.setContentsMargins(10, 2, 10, 0)
                lay.addWidget(d)
            lay.addWidget(ParamForm(self.editor, n.id))
        elif len(nodes) > 1:
            lay.addWidget(self._hint(f"{len(nodes)} calques sélectionnés"))
        elif self.editor.current_clip() is not None:
            lay.addWidget(self._clip_form())
        else:
            lay.addWidget(self._hint("Sélectionnez un calque pour voir ses réglages."))
        lay.addStretch(1)
        self.scroll.setWidget(w)

    def _hint(self, text):
        h = QLabel(text)
        h.setObjectName("dim")
        h.setWordWrap(True)
        h.setContentsMargins(10, 10, 10, 10)
        return h

    # ── Réglages du clip sélectionné dans la timeline ────────────────────
    def _clip_form(self):
        from PySide6.QtWidgets import QGridLayout
        clip = self.editor.current_clip()
        d = self.editor.doc.library.get(clip.def_id)
        w = QWidget()
        g = QGridLayout(w)
        g.setContentsMargins(10, 8, 10, 8)
        g.setColumnStretch(1, 1)
        g.addWidget(QLabel(f"Clip  <span style='color:#8a8d96'>{d.name if d else '?'}</span>"), 0, 0, 1, 2)
        self._clip_fields = {}
        for row, (key, label) in enumerate((("start", "Début"), ("duration", "Durée")), start=1):
            lab = QLabel(label)
            lab.setObjectName("dim")
            f = ScrubField(3, 0.0 if key == "start" else 0.01, None, (0.0, 30.0), " s")
            f.editStarted.connect(lambda: self.editor.begin("Clip"))
            f.valueEdited.connect(lambda v, k=key: self._set_clip(k, v))
            f.editFinished.connect(self._clip_done)
            g.addWidget(lab, row, 0)
            g.addWidget(f, row, 1)
            self._clip_fields[key] = f
        hint = QLabel("Clic droit sur le clip → Nouvelle automation, puis touchez un réglage pour la lier.")
        hint.setObjectName("dim")
        hint.setWordWrap(True)
        g.addWidget(hint, 3, 0, 1, 2)
        self._refresh_clip()
        return w

    def _refresh_clip(self):
        clip = self.editor.current_clip()
        if clip is None or not self._clip_fields:
            return
        self._clip_fields["start"].set_value(clip.start)
        self._clip_fields["duration"].set_value(clip.duration)

    def _set_clip(self, key, v):
        clip = self.editor.current_clip()
        if clip is not None:
            setattr(clip, key, max(0.01 if key == "duration" else 0.0, v))
            self.editor.notify(timeline=True)

    def _clip_done(self):
        self.editor.commit()
