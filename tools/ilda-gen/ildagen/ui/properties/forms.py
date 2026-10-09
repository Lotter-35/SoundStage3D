"""Formulaire des réglages d'un calque (forme, groupe, forme placée, modifieur), relié à l'éditeur.

Une ligne par réglage (fields.py) ; les réglages inutiles dans le mode choisi sont masqués (ParamSpec.visible_if) ;
bouton ∿ : oscillateur du réglage (osc_popup.py). Chaque geste (glisser, pas de molette, saisie, choix) est
une seule étape d'annulation ; Échap, Ctrl+Z ou un geste annulé ailleurs l'abandonnent.
Calque verrouillé : champs grisés. Le formulaire garde l'identifiant du calque (et non l'objet) : il reste
valable après annuler / rétablir ; refresh() remet les valeurs du document dans les champs (même un champ qui a
le focus : jamais de valeur périmée réécrite ensuite).
"""

from PySide6.QtCore import QTimer, Signal
from PySide6.QtWidgets import QVBoxLayout, QWidget
from shiboken6 import isValid

from ...core import nodes as N
from ...core.param_specs import ACTIVE_SPEC, TRANSFORM_SPECS, shape_param_spec  # noqa: F401 (réexportés)
from ...core.params import ParamSpec
from ...core.shapes import SHAPE_PARAMS
from ..widgets import osc_summary
from .common import LABEL_W, display_spec, display, scaled_osc
from .fields import ColorRow, FieldRow, ParamSlider, make_field

# « Couleur » d'une forme : par défaut (pastille « aucune ») ou unie (col.mode + col.color en une ligne)
SHAPE_COLOR = ParamSpec("col.color", "Couleur", "color", (1.0, 1.0, 1.0),
                        tip="Pastille en pointillés : couleur par défaut (celle des modifieurs, sinon le blanc)")


def form_specs(node):
    """[(spec, facteur d'affichage)] des réglages montrés pour un calque, dans l'ordre du panneau."""
    if node.kind == "modifier":
        return [(s, 1.0) for s in node.modifier.all_params()] if node.modifier is not None else []
    out = []
    if node.kind == "shape":
        out += [(shape_param_spec(node.shape, k), 1.0) for k in SHAPE_PARAMS.get(node.shape, {})]
    if node.has_transform:
        out += list(TRANSFORM_SPECS)
    if node.kind == "shape":
        out.append((SHAPE_COLOR, 1.0))
    return out


specs_for = form_specs        # ancien nom


def same_value(a, b):
    """Comparaison tolérante (nombres, couleurs, dégradés)."""
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(same_value(x, y) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(float(a) - float(b)) < 1e-6
    return a == b


def get_value(node, key):
    """Valeur d'un réglage telle que le formulaire la montre (couleur d'une forme : None = par défaut)."""
    if key == "col.color" and node.kind == "shape":
        return None if node.color_mode == 0 else tuple(node.color)
    return N.get_param(node, key)


class ParamForm(QWidget):
    heightChanged = Signal()     # des lignes sont apparues / ont disparu

    def __init__(self, editor, node_id, compact=False, label_width=LABEL_W, margins=(10, 2, 10, 4), parent=None):
        super().__init__(parent)
        self.editor = editor
        self.node_id = node_id
        self.fields = {}         # clé → champ qui porte la valeur
        self.rows = {}           # clé → ligne (montrée ou masquée selon le mode)
        self.specs = {}
        self.factors = {}
        self._editing = None     # clé du réglage en cours de geste
        lay = QVBoxLayout(self)
        lay.setContentsMargins(*margins)
        lay.setSpacing(0)
        node = editor.find(node_id)
        if node is None:
            return
        for spec, factor in form_specs(node):
            if spec is None:
                continue
            if spec is SHAPE_COLOR:
                field = ColorRow(allow_none=True, none_tip="Couleur par défaut")
                row = FieldRow(spec.label, field, label_width, spec.tip)
            else:
                row, field = make_field(spec, label_width, factor)
                if row is None:
                    continue
            self._wire(spec.key, field)
            self.fields[spec.key], self.rows[spec.key] = field, row
            self.specs[spec.key], self.factors[spec.key] = spec, factor
            lay.addWidget(row)
        self.refresh()
        # Plusieurs changements d'affilée (geste, annuler) : une seule mise à jour des champs
        self._later = QTimer(self)
        self._later.setSingleShot(True)
        self._later.timeout.connect(self.refresh)
        editor.docChanged.connect(self.refresh_later)
        editor.restored.connect(self._abort)

    def node(self):
        return self.editor.find(self.node_id)

    def refresh_later(self):
        if isValid(self) and not self._later.isActive():
            self._later.start(0)

    # ── Liaison des champs ───────────────────────────────────────────────
    def _wire(self, key, f):
        f.editStarted.connect(lambda k=key: self._started(k))
        if isinstance(f, ParamSlider):
            f.valueChanged.connect(lambda v, k=key: self._edited(k, v))
            f.editFinished.connect(lambda _v: self._finished())
            f.editCancelled.connect(lambda _v: self._cancelled())
            f.oscRequested.connect(lambda k=key: self.open_osc(k))
            return
        f.valueEdited.connect(lambda v, k=key: self._edited(k, v))
        f.editFinished.connect(self._finished)
        if hasattr(f, "editCancelled"):
            f.editCancelled.connect(self._cancelled)

    def _started(self, key):
        if self._editing is not None:
            self._finished()
        self._editing = key
        self.editor.param_editing = True
        self.editor.begin(f"Réglage : {self.specs[key].label}")

    def _edited(self, key, v):
        node = self.node()
        if node is None:
            return
        spec = self.specs[key]
        if key == "col.color" and node.kind == "shape":
            N.set_param(node, "col.mode", 0 if v is None else 1)
            if v is not None:
                N.set_param(node, "col.color", tuple(v))
            self.editor.set_param(node, "col.mode", node.color_mode)
            return
        if spec.kind == "int" or key.startswith("sp."):
            v = int(round(float(v)))
        if spec.kind != "gradient":
            v = spec.clamp(v)
        self.editor.set_param(node, key, v)

    def _finished(self):
        if self._editing is None:
            return
        self._editing = None
        self.editor.param_editing = False
        self.editor.commit()
        self.editor.notify()

    def _cancelled(self):
        """Geste abandonné (Échap, sélecteur de couleur annulé) : le document revient à l'état d'avant."""
        self._editing = None
        self.editor.cancel_gesture()

    def _abort(self):
        """Geste annulé ailleurs (Échap, Ctrl+Z…) : le réglage en cours s'arrête là."""
        if not isValid(self):
            return
        self._editing = None
        for f in self.fields.values():
            if hasattr(f, "abort"):
                f.abort()
        self.refresh_later()

    # ── Affichage ────────────────────────────────────────────────────────
    def refresh(self):
        node = self.node()
        if node is None or not isValid(self):
            return
        locked = bool(node.locked or node.locked_ancestor() is not None)
        bpb = self.editor.doc.timeline.beats_per_bar
        changed = False
        for key, field in self.fields.items():
            spec, row = self.specs[key], self.rows[key]
            shown = spec.shown(lambda k: get_value(node, k))
            if row.isHidden() == shown:
                row.setVisible(shown)
                changed = True
            if row.isEnabled() == locked:
                row.setEnabled(not locked)
            if key == self._editing:
                continue
            v = get_value(node, key)
            if v is None and not (key == "col.color" and node.kind == "shape"):
                v = spec.default_value()
            field.set_value(v)
            if isinstance(field, ParamSlider):
                osc = node.osc.get(key)
                k = display(spec, self.factors[key])[0]
                field.set_summary(osc_summary(scaled_osc(osc, k), display_spec(spec, self.factors[key]), bpb)
                                  if osc is not None else "")
        if changed:
            self.heightChanged.emit()

    def shown_keys(self):
        return [k for k, r in self.rows.items() if not r.isHidden()]

    def is_default(self):
        """Tous les réglages montrés ont-ils leur valeur par défaut (arrondie à ce qui est affiché : 0,0004 montré
        « 0 » compte pour 0) ? La couleur et les oscillateurs ne sont pas des réglages à réinitialiser."""
        node = self.node()
        if node is None:
            return True
        for key in self.shown_keys():
            spec = self.specs[key]
            v = get_value(node, key)
            if spec.kind in ("float", "int"):
                f = self.fields[key]
                if round(float(v) * f.factor, f.decimals) != round(float(spec.default_value()) * f.factor, f.decimals):
                    return False
            elif key != "col.color" and not same_value(v, spec.default_value()):
                return False
        return True

    # ── Oscillateurs ─────────────────────────────────────────────────────
    def open_osc(self, key):
        """Bouton ∿ : pose un oscillateur (s'il n'y en a pas) et ouvre son éditeur sous le champ."""
        from .osc_popup import OscPopup
        node = self.node()
        if node is None or node.locked or node.locked_ancestor() is not None:
            return None
        if key not in node.osc and self.editor.set_osc(node, key) is None:
            return None
        pop = OscPopup(self.editor, self.node_id, key, self.specs[key], self.factors[key], self)
        pop.show_under(self.fields[key])
        self.popup = pop
        return pop


__all__ = ["ParamForm", "form_specs", "specs_for", "same_value", "get_value", "SHAPE_COLOR", "N"]
