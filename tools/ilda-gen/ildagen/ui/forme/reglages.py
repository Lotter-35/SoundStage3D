"""Panneau Réglages de l'espace Forme (D10 : le seul endroit où l'on règle un calque).

- un calque : son nom et son type, ses réglages (sliders, interrupteurs, choix, couleur ; ∿ = oscillateur), puis
  les cartes des modifieurs qui agissent sur lui ; un modifieur : sa description, ce sur quoi il agit, ses réglages
  (et ses sous-modifieurs) ;
- plusieurs calques : « N calques sélectionnés » et les actions communes ; aucun : la forme en cours.

Le contenu n'est reconstruit que si la sélection ou la liste des modifieurs change ; sinon les champs sont
seulement remis à jour (œil, verrou, annuler…) et la position de défilement est gardée.
"""

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QFont
from PySide6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QScrollArea, QSizePolicy, QVBoxLayout, QWidget
from shiboken6 import isValid

from ...core.shapes import SHAPE_LABELS
from ..properties.common import ElidedLabel, PanelHead
from ..properties.forms import ParamForm
from .mod_cards import ModifierCard, acting_modifiers

KIND_LABELS = {"group": "Groupe", "instance": "Forme placée", "modifier": "Modifieur"}


def kind_label(node, library):
    if node.kind == "modifier":
        return f"Modifieur · {node.modifier.category.lower()}" if node.modifier else "Modifieur"
    if node.kind == "instance":
        d = library.get(node.def_id)
        return f"Forme placée · {d.name}" if d else "Forme placée"
    if node.kind == "shape":
        return "Tracé · " + SHAPE_LABELS.get(node.shape, "forme").lower() if node.shape != "path" else "Tracé libre"
    return KIND_LABELS.get(node.kind, "")


class TitleRow(QWidget):
    """Nom (gras, 13 px, texte brut tronqué) suivi du type (gris)."""

    def __init__(self, name, kind, parent=None):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(10, 8, 10, 6)
        lay.setSpacing(8)
        self.name = ElidedLabel(name)
        f = QFont(self.name.font())
        f.setPixelSize(13)
        f.setWeight(QFont.Weight.DemiBold)
        self.name.setFont(f)
        self.name.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Preferred)
        lay.addWidget(self.name, 0)
        self.kind = ElidedLabel(kind)
        self.kind.setObjectName("dim")
        lay.addWidget(self.kind, 1)

    def set_texts(self, name, kind):
        if self.name.full_text() != name:
            self.name.set_full_text(name)
        if self.kind.full_text() != kind:
            self.kind.set_full_text(kind)
        self.name.updateGeometry()


def section(text):
    lab = QLabel(text)
    lab.setObjectName("sectionTitle")
    lab.setContentsMargins(10, 10, 10, 4)
    return lab


def dim_text(text, wrap=True):
    lab = QLabel(text)
    lab.setTextFormat(Qt.TextFormat.PlainText)
    lab.setObjectName("dim")
    lab.setWordWrap(wrap)
    lab.setContentsMargins(10, 0, 10, 4)
    return lab


class ReglagesPanel(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setMinimumWidth(250)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)
        self.head = PanelHead("Réglages")
        self.reset_btn = self.head.add_button("rotate-ccw", "Réinitialiser les réglages de la sélection (Ctrl+Maj+R)",
                                              lambda: editor.reset_params())
        lay.addWidget(self.head)
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        lay.addWidget(self.scroll, 1)
        self._key = None
        self.form = None
        self.cards = []
        self.title = None
        self.extra = {}
        for sig in (editor.selectionChanged, editor.structureChanged, editor.contextChanged, editor.restored,
                    editor.projectChanged):
            sig.connect(self.sync)
        editor.docChanged.connect(self.refresh)
        self.sync()

    # ── Contenu ──────────────────────────────────────────────────────────
    def _content_key(self):
        ed = self.editor
        nodes = ed.selected_nodes()
        key = (ed.current_form_id(), tuple(n.id for n in nodes))
        if len(nodes) == 1:
            n = nodes[0]
            key += (n.kind, getattr(n, "shape", None), tuple(m.id for m in acting_modifiers(n)))
        return key

    def sync(self):
        """Sélection ou structure changée : reconstruit seulement si le contenu du panneau change."""
        key = self._content_key()
        if key == self._key:
            self.refresh()
            return
        same = self._key is not None and key[:2] == self._key[:2]
        pos = self.scroll.verticalScrollBar().value()
        self._key = key
        self._build()
        if same:
            # Même calque (structure changée autour de lui) : on reste à la même hauteur
            QTimer.singleShot(0, lambda: isValid(self) and self.scroll.verticalScrollBar().setValue(pos))

    def _build(self):
        ed = self.editor
        w = QWidget()
        w.setObjectName("reglages")
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 8)
        lay.setSpacing(0)
        self.form, self.cards, self.title, self.extra = None, [], None, {}
        nodes = ed.selected_nodes()
        if len(nodes) == 1:
            self._single(lay, nodes[0])
        elif nodes:
            self._multi(lay, nodes)
        else:
            d = ed.current_form()
            n = len(d.root.children) if d else 0
            self.title = TitleRow(d.name if d else "", f"Forme · {n} calque{'s' if n > 1 else ''}")
            lay.addWidget(self.title)
            lay.addWidget(dim_text("Aucun calque sélectionné"))
        lay.addStretch(1)
        old = self.scroll.takeWidget()
        if old is not None:
            old.hide()
            old.deleteLater()        # détruit plus tard : on peut être appelé depuis un de ses boutons
        self.scroll.setWidget(w)
        self.refresh()

    def _single(self, lay, n):
        ed = self.editor
        self.title = TitleRow(n.name, kind_label(n, ed.doc.library))
        lay.addWidget(self.title)
        if n.kind == "modifier":
            if n.modifier is not None and n.modifier.description:
                lay.addWidget(dim_text(n.modifier.description))
            self.extra["targets"] = dim_text("")
            lay.addWidget(self.extra["targets"])
        if n.kind == "instance":
            b = QPushButton("Ouvrir cette forme")
            b.clicked.connect(lambda: ed.enter_def(n.def_id))
            row = QHBoxLayout()
            row.setContentsMargins(10, 0, 10, 6)
            row.addWidget(b)
            row.addStretch(1)
            lay.addLayout(row)
        self.form = ParamForm(ed, n.id)
        lay.addWidget(self.form)
        mods = acting_modifiers(n)
        if mods:
            lay.addWidget(section("Sous-modifieurs" if n.kind == "modifier" else "Modifieurs qui agissent sur ce calque"))
            box = QVBoxLayout()
            box.setContentsMargins(8, 0, 8, 0)
            box.setSpacing(6)
            for m in mods:
                card = ModifierCard(ed, m.id)
                self.cards.append(card)
                box.addWidget(card)
            lay.addLayout(box)

    def _multi(self, lay, nodes):
        ed = self.editor
        n = len(nodes)
        self.title = TitleRow(f"{n} calques sélectionnés", "")
        lay.addWidget(self.title)
        grid = QVBoxLayout()
        grid.setContentsMargins(10, 2, 10, 4)
        grid.setSpacing(4)
        actions = [("group", "Grouper", ed.group_selected),
                   ("visible", "Masquer", ed.toggle_visible_selected),
                   ("lock", "Verrouiller", lambda: self._toggle_lock()),
                   ("duplicate", "Dupliquer", ed.duplicate_selection),
                   ("reset", "Réinitialiser les réglages", lambda: ed.reset_params()),
                   ("delete", "Supprimer", ed.delete_selected)]
        for i in range(0, len(actions), 2):
            row = QHBoxLayout()
            row.setSpacing(4)
            for key, text, slot in actions[i:i + 2]:
                b = QPushButton(text)
                b.clicked.connect(lambda _=False, s=slot: s())
                self.extra[key] = b
                row.addWidget(b, 1)
            grid.addLayout(row)
        lay.addLayout(grid)

    def _toggle_lock(self):
        sel = self.editor.top_selected()
        if sel:
            self.editor.set_locked(sel, not all(x.locked for x in sel))

    # ── Mise à jour (sans reconstruire) ──────────────────────────────────
    def refresh(self):
        if not isValid(self):
            return
        ed = self.editor
        nodes = ed.selected_nodes()
        if len(nodes) == 1 and self.title is not None:
            n = nodes[0]
            self.title.set_texts(n.name, kind_label(n, ed.doc.library))
            if "targets" in self.extra:
                self.extra["targets"].setText(self._targets_text(n))
        elif len(nodes) > 1 and self.extra:
            self.extra["visible"].setText("Masquer" if all(x.visible for x in nodes) else "Afficher")
            self.extra["lock"].setText("Déverrouiller" if all(x.locked for x in nodes) else "Verrouiller")
        for c in self.cards:
            c.refresh()
        self.reset_btn.setVisible(bool(nodes))
        self.reset_btn.setEnabled(self.form is None or not self.form.is_default())

    def _targets_text(self, m):
        targets = self.editor.modifier_targets(m)
        if not targets:
            return "N'agit sur rien : placez-le au-dessus des calques à modifier"
        names = ", ".join(t.name for t in targets[:4]) + (f" (+{len(targets) - 4})" if len(targets) > 4 else "")
        return f"Agit sur : {names}"
