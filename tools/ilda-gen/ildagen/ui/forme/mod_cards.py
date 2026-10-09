"""Cartes « Modifieurs qui agissent sur ce calque » du panneau Réglages.

Une carte par modifieur : interrupteur = modifieur visible (œil), titre, résumé court quand elle est repliée
(« · 1/4 temps », « · désactivé »), corps repliable avec ses réglages (Dosage compris). Le corps n'est construit
qu'à la première ouverture (une forme à 13 modifieurs reste rapide). Dépliée ou non : état d'affichage du
modifieur, gardé avec le projet (hors annulation).
"""

from shiboken6 import isValid

from ...core.modifiers.base import Modifier
from ..properties.common import CARD_INSET, LABEL_W, display, fmt_unit
from ..properties.forms import ParamForm
from ..widgets import Card
from ..widgets.numbers import fmt_number


def acting_modifiers(node):
    """Modifieurs qui agissent sur un calque, du plus proche au plus lointain (ordre où ils s'appliquent) :
    ceux placés au-dessus de lui dans son groupe, puis au-dessus de chacun de ses groupes. Pour un modifieur :
    ses sous-modifieurs."""
    if node.kind == "modifier":
        return [c for c in node.children if c.kind == "modifier"]
    out = []
    cur = node
    while cur.parent is not None and cur.parent.kind != "modifier":
        sibs = cur.parent.children
        out += [m for m in reversed(sibs[:sibs.index(cur)]) if m.kind == "modifier"]
        cur = cur.parent
    return out


def card_summary(node):
    """Résumé d'un modifieur replié : « 1/4 temps », « Espacement 6 % »… ; « désactivé » s'il est masqué."""
    if not node.visible:
        return "· désactivé"
    mod = node.modifier
    if mod is None:
        return ""
    if type(mod).summary is not Modifier.summary:
        text = mod.summary(node.values)
    else:
        text = ""
        for spec in mod.params:
            v = node.values.get(spec.key)
            if spec.kind in ("float", "int") and v is not None and spec.shown(node.values.get):
                f, unit, dec = display(spec)
                text = f"{spec.label} {fmt_number(float(v) * f, dec)}{unit}"
                break
            if spec.kind == "enum" and v is not None and spec.options:
                text = spec.options[int(v)]
                break
    return f"· {text}" if text else ""


class ModifierCard(Card):
    def __init__(self, editor, mod_id, parent=None):
        node = editor.find(mod_id)
        super().__init__(node.name, "", switchable=True, on=node.visible, expanded=bool(node.show_params),
                         parent=parent)
        self.editor = editor
        self.mod_id = mod_id
        self.form = None
        self.switch.setToolTip("Modifieur actif (œil du calque)")
        self.toggledOn.connect(self._switched)
        self.expandedChanged.connect(self._expanded)
        if self.is_expanded():
            self._build()
        self.refresh()

    def node(self):
        return self.editor.find(self.mod_id)

    def _build(self):
        self.form = ParamForm(self.editor, self.mod_id, label_width=LABEL_W - CARD_INSET, margins=(0, 0, 0, 0))
        self.add_widget(self.form)

    def _switched(self, on):
        node = self.node()
        if node is not None:
            self.editor.set_visible(node, on)

    def _expanded(self, on):
        node = self.node()
        if on and self.form is None:
            self._build()
        if node is not None:
            self.editor.set_card_open(node, on)
        self.refresh()

    def refresh(self):
        node = self.node()
        if node is None or not isValid(self):
            return
        if self.title.text() != node.name:
            self.set_title(node.name)
        if self.is_on() != node.visible:
            self.set_on(node.visible)
        self.set_subtitle("" if self.is_expanded() and node.visible else card_summary(node))
        locked = bool(node.locked or node.locked_ancestor() is not None)
        self.switch.setEnabled(not locked)
        tip = node.modifier.description if node.modifier is not None else ""
        self.header.setToolTip(tip)


__all__ = ["ModifierCard", "acting_modifiers", "card_summary", "fmt_unit"]
