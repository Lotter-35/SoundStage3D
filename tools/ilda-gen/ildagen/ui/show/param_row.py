"""Un réglage d'effet dans l'inspecteur du clip : libellé + « Fixe | Courbe | Oscillateur », puis
Fixe → un SliderField (ou Oui / Non, choix, couleurs) ; Courbe → mini-éditeur de courbe ; Oscillateur →
valeur centrale + OscEditor. Chaque glisser est un seul geste (une étape d'annulation)."""

from PySide6.QtWidgets import QComboBox, QHBoxLayout, QLabel, QVBoxLayout, QWidget

from ...core.animation import TRACK_MODES
from ...core.oscillator import can_oscillate
from ..widgets import ColorChips, OscEditor, Segmented, SliderField, Switch
from .mini_curve import MiniCurve


def value_field(spec, label=""):
    """Champ d'une valeur fixe selon le type du réglage, ou None."""
    if spec.kind in ("float", "int"):
        unit = spec.unit or ""
        if unit and not unit.startswith(" ") and unit != "°":
            unit = " " + unit
        return SliderField(label, spec.default, spec.min, spec.max, spec.soft_min, spec.soft_max,
                           decimals=spec.decimals, integer=spec.kind == "int", unit=unit, step=spec.step,
                           default=spec.default, label_width=0 if not label else 70)
    if spec.kind == "bool":
        return Switch(bool(spec.default))
    if spec.kind == "enum":
        if len(spec.options) <= 3 and sum(len(o) for o in spec.options) < 26:
            return Segmented(spec.options, int(spec.default), expand=True)
        c = QComboBox()
        c.addItems(spec.options)
        return c
    if spec.kind == "color":
        return ColorChips(allow_none=False)
    return None


class ParamRow(QWidget):
    def __init__(self, editor, clip_id, effect, spec, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.clip_id = clip_id
        self.effect_id = effect.id
        self.key = spec.key
        self.spec = spec
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 2, 0, 4)
        lay.setSpacing(3)
        top = QHBoxLayout()
        top.setContentsMargins(0, 0, 0, 0)
        lab = QLabel(spec.label)
        lab.setObjectName("dim")
        top.addWidget(lab)
        top.addStretch(1)
        self.modes = [m for m, _ in TRACK_MODES if m != "osc" or can_oscillate(spec)]
        self.mode = Segmented([dict(TRACK_MODES)[m] for m in self.modes])
        self.mode.currentChanged.connect(lambda i: editor.set_track_mode(self.effect_id, self.key, self.modes[i]))
        top.addWidget(self.mode)
        lay.addLayout(top)
        t = effect.params.get(spec.key)
        mode = t.mode if t is not None else "fixe"
        self.mode.set_current(self.modes.index(mode) if mode in self.modes else 0)
        self.field = self.curve = self.osc = None
        if mode == "courbe":
            self.curve = MiniCurve(editor, clip_id, effect.id, spec.key)
            lay.addWidget(self.curve)
        else:
            self.field = value_field(spec, "Centre" if mode == "osc" else "")
            if self.field is not None:
                self._wire_value(self.field)
                lay.addWidget(self.field)
            if mode == "osc":
                self.osc = OscEditor(removable=False)
                self.osc.editStarted.connect(lambda: editor.begin("Oscillateur de l'effet"))
                self.osc.oscChanged.connect(lambda o: editor.set_track_osc(self.effect_id, self.key, o))
                self.osc.editFinished.connect(self._finish)
                lay.addWidget(self.osc)
        self.refresh()

    def _wire_value(self, f):
        ed = self.editor
        set_v = lambda v: ed.set_track_value(self.effect_id, self.key, v)      # noqa: E731
        if isinstance(f, SliderField):
            f.editStarted.connect(lambda: ed.begin("Réglage de l'effet"))
            f.valueChanged.connect(set_v)
            f.editFinished.connect(lambda _v: self._finish())
            f.editCancelled.connect(lambda _v: ed.cancel_gesture())
        elif isinstance(f, Switch):
            f.clicked.connect(lambda on: set_v(bool(on)))
        elif isinstance(f, Segmented):
            f.currentChanged.connect(set_v)
        elif isinstance(f, QComboBox):
            f.activated.connect(set_v)
        elif isinstance(f, ColorChips):
            f.colorChosen.connect(lambda c: c is not None and set_v(tuple(c)))

    def _finish(self):
        self.editor.commit()
        self.editor.notify(timeline=True)

    def track(self):
        _, e = self.editor.find_effect(self.effect_id)
        return e.params.get(self.key) if e is not None else None

    def refresh(self):
        """Valeurs venues du modèle (sans signal ; un glisser en cours n'est pas dérangé)."""
        t = self.track()
        if t is None:
            return
        f = self.field
        if isinstance(f, SliderField):
            f.set_value(t.value)
        elif isinstance(f, Switch):
            f.set_value(bool(t.value))
        elif isinstance(f, Segmented):
            f.set_current(int(t.value))
        elif isinstance(f, QComboBox):
            f.blockSignals(True)
            f.setCurrentIndex(int(t.value))
            f.blockSignals(False)
        elif isinstance(f, ColorChips):
            f.set_value(t.value)
        if self.osc is not None and t.osc is not None and not self.osc.depth.is_editing() \
                and not self.osc.speed.is_editing() and not self.osc.phase.is_editing():
            self.osc.set_osc(t.osc, self.spec, self.editor.doc.timeline.beats_per_bar)
        if self.curve is not None:
            self.curve.update()

    def abort(self):
        if isinstance(self.field, SliderField):
            self.field.abort()
