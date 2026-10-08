"""Formulaire de réglages d'un calque (forme, groupe, instance, modifieur), relié à l'éditeur.

Le formulaire garde l'identifiant du calque (et non l'objet) : il reste valable après annuler / rétablir.
"""

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import QGridLayout, QLabel, QMenu, QToolButton, QWidget

from ...core import nodes as N
from ...core import shape_color
from ...core.params import B, F, I
from ...core.shapes import SHAPE_PARAMS
from .. import icons, theme
from .curve_strip import CurveStrip
from .widgets import BoolField, ColorSwatch, EnumField, GradientBar, PaletteField, ScrubField

# Réglages de transformation (clés « tf. ») ; facteur d'affichage pour les échelles en %
TRANSFORM_SPECS = [
    (F("tf.tx", "Position X", 0.0, -8.0, 8.0, decimals=3, soft_min=-1, soft_max=1), 1.0),
    (F("tf.ty", "Position Y", 0.0, -8.0, 8.0, decimals=3, soft_min=-1, soft_max=1), 1.0),
    (F("tf.rot", "Rotation", 0.0, -360.0, 360.0, "°", 1, soft_min=0, soft_max=360), 1.0),
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
        return ColorSwatch()
    if spec.kind == "gradient":
        return GradientBar()
    if spec.kind == "palette":
        return PaletteField()
    return QLabel("?")


class ParamForm(QWidget):
    heightChanged = Signal()     # une mini-courbe est apparue / a disparu

    def __init__(self, editor, node_id, compact=False, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.node_id = node_id
        self.compact = compact
        self.fields = {}
        self.specs = {}
        self.resets = {}
        self.autos = {}         # boutons « envoyer dans la timeline »
        self.strips = {}        # mini-courbes des réglages envoyés dans la timeline
        self.strip_resets = {}  # ↺ à droite de chaque mini-courbe
        self._editing = False
        node = editor.find(node_id)
        grid = QGridLayout(self)
        m = (8, 2, 6, 4) if compact else (10, 6, 10, 8)
        grid.setContentsMargins(*m)
        grid.setHorizontalSpacing(4 if compact else 8)
        grid.setVerticalSpacing(3 if compact else 4)
        grid.setColumnStretch(2, 1)
        self.chevrons = {}      # flèche « afficher la courbe » (réglage envoyé dans la timeline)
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
            auto = None
            if spec.animatable:
                # Envoyer ce réglage dans la timeline (pour le faire varier dans le temps)
                auto = QToolButton()
                auto.setIcon(icons.icon("spline", 12, active_color=theme.ACCENT))
                auto.setIconSize(icons.qsize(12))
                auto.setAutoRaise(True)
                auto.setCheckable(True)
                auto.setFocusPolicy(Qt.FocusPolicy.NoFocus)
                auto.setFixedSize(18, 18)
                auto.clicked.connect(lambda _=False, s=spec: self._automate(s))
                self.autos[spec.key] = auto
            if auto is not None:
                # Flèche (fermée par défaut) : afficher la courbe du réglage sous la ligne
                chev = QToolButton()
                chev.setAutoRaise(True)
                chev.setFocusPolicy(Qt.FocusPolicy.NoFocus)
                chev.setFixedSize(20, 20)
                chev.setIconSize(icons.qsize(14))
                chev.setToolTip("Afficher / masquer la courbe au cours du clip")
                chev.clicked.connect(lambda _=False, s=spec: self._toggle_strip(s))
                chev.setVisible(False)
                self.chevrons[spec.key] = chev
                grid.addWidget(chev, row, 0)
            if spec.kind == "gradient":
                grid.addWidget(label, row, 1, 1, 2)
                grid.addWidget(reset, row, 3)
                if auto is not None:
                    grid.addWidget(auto, row, 4)
                row += 1
                grid.addWidget(field, row, 1, 1, 2)
            else:
                grid.addWidget(label, row, 1)
                # Les champs prennent toute la largeur disponible (sauf case à cocher / couleur)
                grid.addWidget(field, row, 2, Qt.AlignmentFlag.AlignLeft if spec.kind in ("bool", "color", "palette") else Qt.AlignmentFlag(0))
                grid.addWidget(reset, row, 3)
                if auto is not None:
                    grid.addWidget(auto, row, 4)
            label.setToolTip("Clic droit : réinitialiser / automatiser · Alt + clic sur la valeur : réinitialiser")
            if hasattr(field, "resetRequested"):
                field.resetRequested.connect(lambda s=spec: self._reset(s))
            field.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
            field.customContextMenuRequested.connect(lambda pos, s=spec, w=field: self._label_menu(s, w.mapToGlobal(pos)))
            field.editStarted.connect(lambda s=spec: self._started(s))
            field.valueEdited.connect(lambda v, s=spec: self._edited(s, v))
            field.editFinished.connect(self._finished)
            self.fields[spec.key] = field
            self.specs[spec.key] = spec
            row += 1
            if auto is not None:
                # Sous le réglage : sa courbe au cours du clip (visible quand il est dans la timeline)
                strip = CurveStrip(editor, node_id, spec)
                strip.setVisible(False)
                grid.addWidget(strip, row, 1, 1, 3)
                self.strips[spec.key] = strip
                sreset = QToolButton()
                sreset.setIcon(icons.icon("rotate-ccw", 12))
                sreset.setIconSize(icons.qsize(12))
                sreset.setAutoRaise(True)
                sreset.setFocusPolicy(Qt.FocusPolicy.NoFocus)
                sreset.setFixedSize(18, 18)
                sreset.setToolTip(f"Réinitialiser la courbe de « {spec.label} » (un seul point, valeur par défaut)")
                sreset.clicked.connect(lambda _=False, s=spec: self._reset_curve(s))
                sreset.setVisible(False)
                grid.addWidget(sreset, row, 4, Qt.AlignmentFlag.AlignTop)
                self.strip_resets[spec.key] = sreset
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
            # Le bouton ↺ s'allume quand la valeur n'est plus celle par défaut
            self.resets[key].setEnabled(not same_value(v, self.specs[key].default_value()))
        resized = False
        for key, btn in self.autos.items():
            on = self.editor.param_in_timeline(node, key)
            btn.setChecked(on)
            chev = self.chevrons.get(key)
            opened = on and (self.node_id, key) in self.editor.open_strips
            if chev is not None:
                chev.setVisible(on)
                chev.setIcon(icons.icon("chevron-down" if opened else "chevron-right", 14))
            strip = self.strips.get(key)
            if strip is not None:
                self.strip_resets[key].setVisible(opened)
                if strip.isVisibleTo(self) != opened:
                    strip.setVisible(opened)
                    resized = True
                elif opened:
                    strip.update()
            label = self.specs[key].label
            btn.setToolTip(f"« {label} » est dans la timeline (clic : l'en retirer)" if on else
                           f"Envoyer « {label} » dans la timeline pour le faire varier dans le temps")
        if resized:
            self.adjustSize()
            self.heightChanged.emit()

    def _reset_curve(self, spec):
        """Courbe remise à plat : un seul point (début du clip) à la valeur par défaut du réglage."""
        node = self.node()
        if node is None:
            return
        clip, _ = self.editor.automation_clip()
        auto = clip.automation_for(node.id, spec.key) if clip is not None else None
        if auto is None:
            return
        from ...core.automation import Keyframe
        v = self.default_for(node, spec)

        def do():
            auto.keys = [Keyframe(0.0, v, "hold" if auto.discrete else "linear")]
        self.editor.timeline_mutate("Réinitialiser la courbe", do)
        self.editor.statusMessage.emit(f"Courbe de « {spec.label} » réinitialisée")

    def _toggle_strip(self, spec):
        k = (self.node_id, spec.key)
        self.editor.open_strips ^= {k}
        self.refresh()

    def _automate(self, spec):
        node = self.node()
        if node is not None:
            self.editor.automate_param(node, spec.key)
        self.refresh()

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

    def _label_menu(self, spec, gpos):
        node = self.node()
        if node is None:
            return
        menu = QMenu(self)
        inside = self.editor.param_in_timeline(node, spec.key)
        a_auto = menu.addAction("Retirer de la timeline" if inside else "Envoyer dans la timeline")
        a_auto.setEnabled(spec.animatable)
        a_reset = menu.addAction("Réinitialiser (Alt + clic)")
        a_all = menu.addAction("Réinitialiser tous les réglages du calque")
        chosen = menu.exec(gpos)
        if chosen is a_auto:
            self._automate(spec)
        elif chosen is a_reset:
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
