"""Petites briques des panneaux de l'espace Forme : en-tête de panneau, bouton icône, libellé tronqué,
affichage des réglages (unité, facteur, décimales) et oscillateur converti dans les unités affichées."""

import math

from PySide6.QtCore import QSize, Qt
from PySide6.QtWidgets import QHBoxLayout, QLabel, QSizePolicy, QToolButton, QWidget

from ...core.params import ParamSpec
from .. import icons

HEAD_H = 28
LABEL_W = 92        # colonne des libellés (alignée d'une carte à l'autre)
CARD_INSET = 8      # retrait des réglages dans une carte (marge + bord + marge intérieure − marge du panneau)


def icon_button(name, tip, slot=None, size=14, checkable=False):
    """Bouton icône sans cadre (en-têtes, barres), sans prise du focus clavier."""
    b = QToolButton()
    b.setIcon(icons.icon(name, size))
    b.setIconSize(QSize(size, size))
    b.setToolTip(tip)
    b.setAutoRaise(True)
    b.setCheckable(checkable)
    b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
    if slot is not None:
        b.clicked.connect(lambda *_: slot())
    return b


class PanelHead(QWidget):
    """En-tête d'un panneau (28 px) : titre à gauche (11 px, gris), boutons icônes à droite."""

    def __init__(self, title, parent=None):
        super().__init__(parent)
        self.setFixedHeight(HEAD_H)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(10, 0, 6, 0)
        lay.setSpacing(2)
        self.title = QLabel(title)
        self.title.setObjectName("sectionTitle")
        lay.addWidget(self.title)
        lay.addStretch(1)
        self.right = lay

    def add_button(self, name, tip, slot=None, size=14):
        b = icon_button(name, tip, slot, size)
        self.right.addWidget(b)
        return b


class ElidedLabel(QLabel):
    """Libellé en texte brut (jamais interprété comme du HTML), tronqué avec « … » s'il manque de place."""

    def __init__(self, text="", parent=None):
        super().__init__(parent)
        self.setTextFormat(Qt.TextFormat.PlainText)
        self.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self.setMinimumWidth(10)
        self._full = ""
        self.set_full_text(text)

    def set_full_text(self, text):
        self._full = text or ""
        self.setToolTip(self._full if len(self._full) > 18 else "")
        self._elide()

    def full_text(self):
        return self._full

    def resizeEvent(self, e):
        super().resizeEvent(e)
        self._elide()

    def _elide(self):
        w = max(10, self.width() - 2)
        self.setText(self.fontMetrics().elidedText(self._full, Qt.TextElideMode.ElideRight, w))

    def sizeHint(self):
        s = super().sizeHint()
        return QSize(self.fontMetrics().horizontalAdvance(self._full) + 4, s.height())


# ── Affichage des réglages ──────────────────────────────────────────────────
def fmt_unit(unit):
    """Unité affichée après la valeur : « 62 % », « 45° », « 2 Hz »."""
    u = (unit or "").strip()
    if not u:
        return ""
    return u if u.startswith("°") else " " + u


def display(spec, factor=1.0):
    """(facteur, unité, décimales) affichés d'un réglage numérique."""
    f, unit = spec.display()
    if f == 1.0 and factor != 1.0:
        f = factor
    dec = spec.decimals if spec.kind == "float" else 0
    if spec.scale:
        dec = max(0, dec - int(round(math.log10(f)))) if f > 0 else dec
    return f, fmt_unit(unit), dec


def display_spec(spec, factor=1.0):
    """Copie du réglage dans les unités affichées (éditeur d'oscillateur, résumé « ~ 45 °/s »)."""
    f, unit, dec = display(spec, factor)

    def k(v):
        return None if v is None else v * f
    return ParamSpec(spec.key, spec.label, spec.kind, k(spec.default) if spec.kind != "enum" else spec.default,
                     k(spec.min), k(spec.max), spec.step, unit.strip(), spec.options, dec, k(spec.soft_min),
                     k(spec.soft_max))


def scaled_osc(osc, k):
    """Oscillateur dont l'amplitude et la vitesse sont multipliées par k (unités affichées ↔ réglage)."""
    o = osc.copy()
    o.depth *= k
    o.speed *= k
    return o


def same_shown(a, b, decimals):
    """Valeurs égales une fois arrondies à ce qui est affiché (0,0004 affiché « 0,000 » = 0)."""
    try:
        return round(float(a), decimals) == round(float(b), decimals)
    except (TypeError, ValueError):
        return a == b
