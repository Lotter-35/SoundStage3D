"""Panneau Propriétés (sous les calques, repliable)."""

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QHBoxLayout, QLabel, QScrollArea, QToolButton, QVBoxLayout, QWidget

from ...core.shapes import SHAPE_LABELS
from ...core.timeline import MAX_DURATION, MAX_START, MIN_DURATION
from .. import icons, theme
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
        self.reset_btn = QToolButton()
        self.reset_btn.setIcon(icons.icon("rotate-ccw", 14))
        self.reset_btn.setIconSize(icons.qsize(14))
        self.reset_btn.setAutoRaise(True)
        self.reset_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self.reset_btn.setToolTip("Réinitialiser tous les réglages de la sélection (Ctrl+Maj+R)")
        self.reset_btn.clicked.connect(lambda: editor.reset_params())
        self.header.extra.addWidget(self.reset_btn)
        lay.addWidget(self.header)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        lay.addWidget(self.scroll, 1)
        editor.selectionChanged.connect(self.rebuild)
        editor.structureChanged.connect(self.rebuild)
        editor.contextChanged.connect(self.rebuild)
        editor.clipSelectionChanged.connect(self.rebuild)
        editor.timelineChanged.connect(self._timeline_changed)
        editor.restored.connect(self._abort)
        theme.notifier.changed.connect(self.rebuild)      # textes colorés : nouvelles couleurs du thème
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
        ed = self.editor
        clip = ed.current_clip() if ed.workspace == "show" else None
        nodes = [] if clip is not None else ed.selected_nodes()
        self.reset_btn.setVisible(bool(nodes))
        if len(nodes) == 1:
            n = nodes[0]
            kind = KIND_LABELS.get(n.kind) or SHAPE_LABELS.get(getattr(n, "shape", ""), "Forme")
            if n.kind == "modifier":
                kind = f"Modifieur · {n.modifier.category}"
            title = QLabel(f"{n.name}   <span style='color:{theme.TEXT_DIM}'>{kind}</span>")
            title.setTextFormat(Qt.TextFormat.RichText)
            title.setContentsMargins(10, 8, 10, 0)
            lay.addWidget(title)
            if n.kind == "modifier" and n.modifier.description:
                d = QLabel(n.modifier.description)
                d.setWordWrap(True)
                d.setObjectName("dim")
                d.setContentsMargins(10, 2, 10, 0)
                lay.addWidget(d)
            if n.kind == "modifier":
                targets = self.editor.modifier_targets(n)
                if targets:
                    names = ", ".join(t.name for t in targets[:4]) + (f" (+{len(targets) - 4})" if len(targets) > 4 else "")
                    text = f"Agit sur : <b>{names}</b>"
                else:
                    text = (f"<span style='color:{theme.WARNING}'>N'agit sur rien : placez-le au-dessus des calques "
                            "à modifier</span>")
                a = QLabel(text)
                a.setTextFormat(Qt.TextFormat.RichText)
                a.setWordWrap(True)
                a.setContentsMargins(10, 4, 10, 0)
                lay.addWidget(a)
            lay.addWidget(ParamForm(self.editor, n.id))
        elif len(nodes) > 1:
            lay.addWidget(self._hint(f"{len(nodes)} calques sélectionnés"))
        elif clip is not None:
            lay.addWidget(self._clip_form())
        elif ed.workspace == "show":
            lay.addWidget(self._hint("Sélectionnez un clip dans la timeline pour voir ses réglages."))
        else:
            lay.addWidget(self._hint("Sélectionnez un calque pour voir ses réglages."))
        lay.addStretch(1)
        # L'ancien contenu est détruit plus tard : on peut être appelé depuis un de ses boutons
        old = self.scroll.takeWidget()
        if old is not None:
            old.hide()
            old.deleteLater()
        self.scroll.setWidget(w)

    def _hint(self, text):
        h = QLabel(text)
        h.setObjectName("dim")
        h.setWordWrap(True)
        h.setContentsMargins(10, 10, 10, 10)
        return h

    # ── Réglages du clip sélectionné dans la timeline ────────────────────
    CLIP_FIELDS = (("start", "Début"), ("duration", "Durée"), ("fade_in", "Fondu d'entrée"),
                   ("fade_out", "Fondu de sortie"))

    def _clip_form(self):
        from PySide6.QtWidgets import QGridLayout
        clip = self.editor.current_clip()
        d = self.editor.doc.library.get(clip.def_id)
        w = QWidget()
        g = QGridLayout(w)
        g.setContentsMargins(10, 8, 10, 8)
        g.setColumnStretch(1, 1)
        g.addWidget(QLabel(f"Clip  <span style='color:{theme.TEXT_DIM}'>{d.name if d else '?'}</span>"), 0, 0, 1, 2)
        self._clip_fields = {}
        for row, (key, label) in enumerate(self.CLIP_FIELDS, start=1):
            lab = QLabel(label)
            lab.setObjectName("dim")
            lo, hi = {"start": (0.0, MAX_START), "duration": (MIN_DURATION, MAX_DURATION)}.get(key, (0.0, MAX_DURATION))
            f = ScrubField(3, lo, hi, (0.0, 30.0 if key in ("start", "duration") else 4.0), " s")
            f.editStarted.connect(lambda: self.editor.begin("Clip"))
            f.valueEdited.connect(lambda v, k=key: self._set_clip(k, v))
            f.editFinished.connect(self._clip_done)
            g.addWidget(lab, row, 0)
            g.addWidget(f, row, 1)
            self._clip_fields[key] = f
        hint = QLabel("Les effets d'animation du clip se règlent dans l'espace Show. "
                      "Double-clic sur le clip : ouvrir sa forme.")
        hint.setObjectName("dim")
        hint.setWordWrap(True)
        g.addWidget(hint, len(self.CLIP_FIELDS) + 1, 0, 1, 2)
        self._refresh_clip()
        return w

    def _refresh_clip(self):
        clip = self.editor.current_clip()
        if clip is None or not self._clip_fields:
            return
        for key, f in self._clip_fields.items():
            f.set_value(getattr(clip, key))

    def _set_clip(self, key, v):
        """Valeur glissée / tapée, bornée (pas de chevauchement, fondus dans le clip), dans le geste en cours."""
        clip = self.editor.current_clip()
        if clip is None:
            return
        if key == "start":
            self.editor.set_clip_times(clip.id, start=v)
        elif key == "duration":
            self.editor.set_clip_times(clip.id, duration=v)
        elif key == "fade_in":
            self.editor.set_clip_fades(clip.id, fade_in=v)
        else:
            self.editor.set_clip_fades(clip.id, fade_out=v)

    def _abort(self):
        """Geste annulé (Échap, Ctrl+Z…) : un glisser en cours sur un réglage du clip s'arrête."""
        for f in (self._clip_fields or {}).values():
            f.abort()

    def _clip_done(self):
        self.editor.commit()
