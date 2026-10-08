"""Formulaire de réglages d'un calque (forme, groupe, instance, modifieur), relié à l'éditeur.

Le formulaire garde l'identifiant du calque (et non l'objet) : il reste valable après annuler / rétablir.
(Les oscillateurs des réglages seront proposés par le panneau Réglages de l'espace Forme.)
"""

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QGridLayout, QLabel, QMenu, QToolButton, QWidget
from shiboken6 import isValid

from ...core import nodes as N
from ...core import shape_color
from ...core.param_specs import ACTIVE_SPEC, TRANSFORM_SPECS, shape_param_spec  # noqa: F401 (réexportés)
from ...core.shapes import SHAPE_PARAMS
from .. import icons
from .widgets import BoolField, ColorSwatch, EnumField, GradientBar, PaletteField, ScrubField


def specs_for(node, compact):
    """[(spec, facteur d'affichage)] des réglages à montrer pour un calque."""
    out = []
    if node.kind == "modifier":
        if not compact:
            out.append((ACTIVE_SPEC, 1.0))
        out += [(s, 1.0) for s in node.modifier.all_params()]
        return out
    if compact:
        return out
    if node.has_transform:
        out += TRANSFORM_SPECS
    if node.kind == "shape":
        for k in SHAPE_PARAMS.get(node.shape, {}):
            out.append((shape_param_spec(node.shape, k), 1.0))
        out += [(s, 1.0) for s in shape_color.SPECS]
    return out


def same_value(a, b):
    """Comparaison tolérante (nombres, couleurs, dégradés)."""
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(same_value(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(float(a) - float(b)) < 1e-6
    return a == b


def make_field(spec, factor):
    if spec.kind in ("float", "int"):
        return ScrubField(spec.decimals, spec.min, spec.max, (spec.soft_min, spec.soft_max),
                          spec.unit, factor, integer=spec.kind == "int")
    if spec.kind == "bool":
        return BoolField()
    if spec.kind == "enum":
        return EnumField(spec.options)
    if spec.kind == "color":
        return ColorSwatch(cancellable=True)
    if spec.kind == "gradient":
        return GradientBar()
    if spec.kind == "palette":
        return PaletteField()
    return QLabel("?")


class ParamForm(QWidget):
    heightChanged = Signal()     # la hauteur du formulaire a changé (la ligne du calque la suit)

    def __init__(self, editor, node_id, compact=False, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.node_id = node_id
        self.compact = compact
        self.fields = {}
        self.specs = {}
        self.resets = {}
        self._editing = False
        node = editor.find(node_id)
        grid = QGridLayout(self)
        m = (8, 2, 6, 4) if compact else (10, 6, 10, 8)
        grid.setContentsMargins(*m)
        grid.setHorizontalSpacing(4 if compact else 8)
        grid.setVerticalSpacing(3 if compact else 4)
        grid.setColumnStretch(2, 1)
        if node is None:
            return
        row = 0
        for spec, factor in specs_for(node, compact):
            label = QLabel(spec.label)
            label.setObjectName("dim")
            label.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
            label.customContextMenuRequested.connect(lambda pos, s=spec, w=label: self._label_menu(s, w.mapToGlobal(pos)))
            field = make_field(spec, factor)
            reset = QToolButton()
            reset.setIcon(icons.icon("rotate-ccw", 12))
            reset.setIconSize(icons.qsize(12))
            reset.setAutoRaise(True)
            reset.setFocusPolicy(Qt.FocusPolicy.NoFocus)
            reset.setFixedSize(18, 18)
            reset.setToolTip(f"Réinitialiser « {spec.label} »")
            reset.clicked.connect(lambda _=False, s=spec: self._reset(s))
            self.resets[spec.key] = reset
            if spec.kind == "gradient":
                grid.addWidget(label, row, 1, 1, 2)
                grid.addWidget(reset, row, 3)
                row += 1
                grid.addWidget(field, row, 1, 1, 2)
            else:
                grid.addWidget(label, row, 1)
                # Les champs prennent toute la largeur disponible (sauf case à cocher / couleur)
                grid.addWidget(field, row, 2, Qt.AlignmentFlag.AlignLeft if spec.kind in ("bool", "color", "palette") else Qt.AlignmentFlag(0))
                grid.addWidget(reset, row, 3)
            label.setToolTip("Clic droit : réinitialiser · Alt + clic sur la valeur : réinitialiser")
            if hasattr(field, "resetRequested"):
                field.resetRequested.connect(lambda s=spec: self._reset(s))
            field.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
            field.customContextMenuRequested.connect(lambda pos, s=spec, w=field: self._label_menu(s, w.mapToGlobal(pos)))
            field.editStarted.connect(lambda s=spec: self._started(s))
            field.valueEdited.connect(lambda v, s=spec: self._edited(s, v))
            field.editFinished.connect(self._finished)
            if hasattr(field, "editCancelled"):
                field.editCancelled.connect(self._cancelled)
            self.fields[spec.key] = field
            self.specs[spec.key] = spec
            row += 1
        self.refresh()
        editor.docChanged.connect(self.refresh)
        editor.restored.connect(self._abort)

    def node(self):
        return self.editor.find(self.node_id)

    def refresh(self):
        node = self.node()
        if node is None or self._editing or not isValid(self):
            return
        for key, field in self.fields.items():
            v = self.editor.effective_param(node, key)
            if v is None:
                v = self.specs[key].default_value()
            field.set_value(v)
            # Le bouton ↺ s'allume quand la valeur n'est plus celle par défaut
            self.resets[key].setEnabled(not same_value(v, self.specs[key].default_value()))

    def _started(self, spec):
        self._editing = True
        self.editor.param_editing = True
        self.editor.begin(f"Réglage : {spec.label}")

    def _edited(self, spec, v):
        node = self.node()
        if node is None:
            return
        if spec.key.startswith("sp."):
            v = int(round(v))
        elif spec.kind != "gradient":
            v = spec.clamp(v)
        self.editor.set_param(node, spec.key, v)

    def _finished(self):
        self._editing = False
        self.editor.param_editing = False
        self.editor.commit()
        self.editor.notify()

    def _cancelled(self):
        """Sélecteur de couleur annulé : rien n'est écrit, le réglage revient à l'état d'avant."""
        self._editing = False
        self.editor.cancel_gesture()

    def _abort(self):
        """Geste annulé ailleurs (Échap, Ctrl+Z…) : le réglage glissé en cours s'arrête là."""
        if not isValid(self):
            return
        self._editing = False
        for f in self.fields.values():
            if hasattr(f, "abort"):
                f.abort()
        self.refresh()

    def _label_menu(self, spec, gpos):
        node = self.node()
        if node is None:
            return
        menu = QMenu(self)
        a_reset = menu.addAction("Réinitialiser (Alt + clic)")
        a_all = menu.addAction("Réinitialiser tous les réglages du calque")
        chosen = menu.exec(gpos)
        if chosen is a_reset:
            self._reset(spec)
        elif chosen is a_all:
            self.editor.reset_params([node])

    def _reset(self, spec):
        node = self.node()
        if node is None:
            return
        self.editor.begin(f"Réinitialiser : {spec.label}")
        self.editor.set_param(node, spec.key, self.default_for(node, spec))
        self.editor.commit()
        self.editor.notify()

    @staticmethod
    def default_for(node, spec):
        return spec.default_value()


__all__ = ["ParamForm", "specs_for", "N"]
