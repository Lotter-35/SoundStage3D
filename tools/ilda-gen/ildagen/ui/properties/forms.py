"""Formulaire de réglages d'un calque (forme, groupe, instance, modifieur), relié à l'éditeur.

Le formulaire garde l'identifiant du calque (et non l'objet) : il reste valable après annuler / rétablir.
"""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QGridLayout, QLabel, QMenu, QWidget

from ...core import nodes as N
from ...core import shape_color
from ...core.params import B, F, I
from ...core.shapes import SHAPE_PARAMS
from .widgets import BoolField, ColorSwatch, EnumField, GradientBar, ScrubField

# Réglages de transformation (clés « tf. ») ; facteur d'affichage pour les échelles en %
TRANSFORM_SPECS = [
    (F("tf.tx", "Position X", 0.0, -8.0, 8.0, decimals=3, soft_min=-1, soft_max=1), 1.0),
    (F("tf.ty", "Position Y", 0.0, -8.0, 8.0, decimals=3, soft_min=-1, soft_max=1), 1.0),
    (F("tf.rot", "Rotation", 0.0, -36000.0, 36000.0, "°", 1, soft_min=-180, soft_max=180), 1.0),
    (F("tf.sx", "Échelle X", 1.0, -100.0, 100.0, " %", 1, soft_min=0, soft_max=2), 100.0),
    (F("tf.sy", "Échelle Y", 1.0, -100.0, 100.0, " %", 1, soft_min=0, soft_max=2), 100.0),
    (F("tf.shear", "Cisaillement", 0.0, -10.0, 10.0, decimals=3, soft_min=-1, soft_max=1), 1.0),
    (F("tf.tilt_x", "Inclinaison X", 0.0, -89.0, 89.0, "°", 1), 1.0),
    (F("tf.tilt_y", "Inclinaison Y", 0.0, -89.0, 89.0, "°", 1), 1.0),
]


# Actif / inactif : automatable pour n'activer un modifieur que sur une partie d'un clip
ACTIVE_SPEC = B("__active__", "Actif", True)


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
        for k, (label, default, lo, hi) in SHAPE_PARAMS.get(node.shape, {}).items():
            out.append((I("sp." + k, label, default, lo, hi), 1.0))
        out += [(s, 1.0) for s in shape_color.SPECS]
    return out


def make_field(spec, factor):
    if spec.kind in ("float", "int"):
        return ScrubField(spec.decimals, spec.min, spec.max, (spec.soft_min, spec.soft_max),
                          spec.unit, factor, integer=spec.kind == "int")
    if spec.kind == "bool":
        return BoolField()
    if spec.kind == "enum":
        return EnumField(spec.options)
    if spec.kind == "color":
        return ColorSwatch()
    if spec.kind == "gradient":
        return GradientBar()
    return QLabel("?")


class ParamForm(QWidget):
    def __init__(self, editor, node_id, compact=False, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.node_id = node_id
        self.compact = compact
        self.fields = {}
        self.specs = {}
        self._editing = False
        node = editor.find(node_id)
        grid = QGridLayout(self)
        m = (26, 2, 8, 4) if compact else (10, 6, 10, 8)
        grid.setContentsMargins(*m)
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(3 if compact else 4)
        grid.setColumnStretch(1, 1)
        if node is None:
            return
        row = 0
        for spec, factor in specs_for(node, compact):
            label = QLabel(spec.label)
            label.setObjectName("dim")
            label.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
            label.customContextMenuRequested.connect(lambda pos, s=spec, w=label: self._label_menu(s, w.mapToGlobal(pos)))
            field = make_field(spec, factor)
            if spec.kind == "gradient":
                grid.addWidget(label, row, 0, 1, 2)
                row += 1
                grid.addWidget(field, row, 0, 1, 2)
            else:
                grid.addWidget(label, row, 0)
                grid.addWidget(field, row, 1, Qt.AlignmentFlag.AlignLeft if spec.kind in ("bool", "color") else Qt.AlignmentFlag(0))
            field.editStarted.connect(lambda s=spec: self._started(s))
            field.valueEdited.connect(lambda v, s=spec: self._edited(s, v))
            field.editFinished.connect(self._finished)
            self.fields[spec.key] = field
            self.specs[spec.key] = spec
            row += 1
        self.refresh()
        editor.docChanged.connect(self.refresh)

    def node(self):
        return self.editor.find(self.node_id)

    def refresh(self):
        node = self.node()
        if node is None or self._editing:
            return
        for key, field in self.fields.items():
            if key.startswith("tf.") or key.startswith("sp.") or key == "__active__":
                v = self.editor.effective_param(node, key)
            else:
                v = self.editor.effective_param(node, key)
                if v is None:
                    v = self.specs[key].default_value()
            field.set_value(v)

    def _started(self, spec):
        self._editing = True
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
        self.editor.commit()
        self.editor.notify()

    def _label_menu(self, spec, gpos):
        node = self.node()
        if node is None:
            return
        menu = QMenu(self)
        clip = self.editor.current_clip()
        a_auto = menu.addAction("Créer une automation pour ce réglage")
        a_auto.setEnabled(clip is not None and spec.animatable and clip.automation_for(node.id, spec.key) is None)
        if clip is None:
            a_auto.setToolTip("Sélectionnez un clip dans la timeline")
        a_reset = menu.addAction("Réinitialiser")
        chosen = menu.exec(gpos)
        if chosen is a_auto:
            self.editor.automate_param(node, spec.key)
        elif chosen is a_reset:
            self.editor.begin("Réinitialiser")
            self.editor.set_param(node, spec.key, spec.default_value())
            self.editor.commit()
            self.editor.notify()


__all__ = ["ParamForm", "specs_for", "N"]
