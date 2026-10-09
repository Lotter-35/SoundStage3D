"""Carte d'un effet d'animation dans l'inspecteur du clip : interrupteur (effet actif), nom, cible (« Toute la
forme » ou un calque ; « Réglage de la forme » : un calque puis un de ses réglages), retirer ; un ParamRow par
réglage. L'en-tête se glisse pour changer l'ordre des effets (appliqués de haut en bas)."""

from PySide6.QtCore import QEvent, QMimeData, QObject, QPointF, QRectF, QSize, Qt
from PySide6.QtGui import QDrag, QFontMetrics, QPainter
from PySide6.QtWidgets import QMenu, QToolButton

from ...core.effects import SHAPE_PARAM, effect_specs, get as get_effect
from ...core.param_specs import node_param_specs
from .. import icons, theme
from ..widgets import Card
from .param_row import ParamRow

MOVE_MIME = "application/x-ildagen-effect-move"
SHAPE_ICONS = {"rect": "square", "ellipse": "circle", "triangle": "triangle", "star": "star", "polygon": "hexagon",
               "line": "slash", "ilda_test": "grid-3x3"}


def node_icon(node):
    if node.kind == "group":
        return "folder"
    if node.kind == "instance":
        return "component"
    if node.kind == "modifier":
        return node.modifier.icon if node.modifier is not None else "sliders-horizontal"
    return SHAPE_ICONS.get(getattr(node, "shape", ""), "pencil")


def layers(root):
    """[(profondeur, nœud)] des calques d'une forme (racine exclue), dans l'ordre de l'arbre."""
    out = []

    def walk(n, depth):
        for c in n.children:
            out.append((depth, c))
            walk(c, depth + 1)
    if root is not None:
        walk(root, 0)
    return out


class TargetChip(QToolButton):
    """Pastille de la cible (« Toute la forme », « ⬡ Hexagone ») peinte avec les couleurs du thème."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.icon_name = ""
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.NoFocus)

    def set_target(self, text, icon_name=""):
        self.setText(text)
        self.icon_name = icon_name
        self.updateGeometry()
        self.update()

    def sizeHint(self):
        fm = QFontMetrics(theme.ui_font(11))
        return QSize(fm.horizontalAdvance(self.text()) + 14 + (16 if self.icon_name else 0), 18)

    def paintEvent(self, _e):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        r = QRectF(self.rect()).adjusted(0, 0, 0, 0)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(theme.qc(theme.SEL if self.underMouse() else theme.BG_HOVER))
        p.drawRoundedRect(r, 2, 2)
        x = 6
        if self.icon_name:
            p.drawPixmap(QPointF(x, (self.height() - 12) / 2), icons.pixmap(self.icon_name, theme.TEXT_DIM, 12))
            x += 16
        p.setFont(theme.ui_font(11))
        p.setPen(theme.qc(theme.TEXT_DIM))
        p.drawText(QRectF(x, 0, self.width() - x - 4, self.height()), Qt.AlignmentFlag.AlignVCenter, self.text())
        p.end()


class _HeaderDrag(QObject):
    """Clic sur l'en-tête : replier / déplier ; glisser : déplacer l'effet dans la liste."""

    def __init__(self, card):
        super().__init__(card)
        self.card = card
        self.press = None

    def eventFilter(self, obj, e):
        t = e.type()
        if t == QEvent.Type.MouseButtonPress and e.button() == Qt.MouseButton.LeftButton:
            self.press = e.position().toPoint()
            return True
        if t == QEvent.Type.MouseMove and self.press is not None and (e.position().toPoint() - self.press).manhattanLength() > 6:
            self.press = None
            md = QMimeData()
            md.setData(MOVE_MIME, self.card.effect_id.encode("utf-8"))
            drag = QDrag(self.card)
            drag.setMimeData(md)
            drag.setPixmap(self.card.header.grab())
            drag.exec(Qt.DropAction.MoveAction)
            return True
        if t == QEvent.Type.MouseButtonRelease and self.press is not None:
            self.press = None
            self.card._toggle_expanded()
            return True
        return False


class EffectCard(Card):
    def __init__(self, editor, clip, effect, root, expanded=True, parent=None):
        et = get_effect(effect.type_id)
        super().__init__(et.label if et is not None else effect.type_id, "", True, effect.enabled, expanded)
        self.editor = editor
        self.effect_id = effect.id
        self.root = root
        self.setToolTip(et.description if et is not None else "")
        self.toggledOn.connect(lambda on: editor.set_effect_enabled(self.effect_id, on))
        self.target = TargetChip()
        self.target.setToolTip("Cible de l'effet : toute la forme ou un seul calque")
        self.target.clicked.connect(lambda: self.target_menu().exec(self.target.mapToGlobal(self.target.rect().bottomLeft())))
        self.title.parentWidget().layout().insertWidget(2, self.target)
        rm = QToolButton()
        rm.setIcon(icons.icon("trash-2", 13))
        rm.setToolTip("Retirer l'effet")
        rm.setAutoRaise(True)
        rm.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        rm.clicked.connect(lambda: editor.remove_effect(self.effect_id))
        self.add_header_widget(rm)
        self._update_target(effect)
        self.rows = []
        for sp in effect_specs(effect, root):
            row = ParamRow(editor, clip.id, effect, sp)
            self.rows.append(row)
            self.add_widget(row)
        if not self.rows and effect.type_id == SHAPE_PARAM:
            self.add_widget(self._hint("Choisissez un calque et le réglage à animer (bouton cible)."))
        self.header.installEventFilter(_HeaderDrag(self))

    @staticmethod
    def _hint(text):
        from PySide6.QtWidgets import QLabel
        h = QLabel(text)
        h.setObjectName("dim")
        h.setWordWrap(True)
        return h

    def _update_target(self, effect):
        node = self.root.find(effect.target) if (self.root is not None and effect.target) else None
        if node is None:
            self.target.set_target("Choisir…" if effect.type_id == SHAPE_PARAM else "Toute la forme",
                                   "crosshair" if effect.type_id == SHAPE_PARAM else "")
        elif effect.type_id == SHAPE_PARAM:
            sp = next((s for s, _ in node_param_specs(node) if s.key == effect.key), None)
            self.target.set_target(f"{node.name} · {sp.label if sp else effect.key}", node_icon(node))
        else:
            self.target.set_target(node.name, node_icon(node))

    def target_menu(self):
        ed = self.editor
        _, e = ed.find_effect(self.effect_id)
        menu = QMenu(self)
        if e is None:
            return menu
        shape_param = e.type_id == SHAPE_PARAM
        if not shape_param:
            a = menu.addAction("Toute la forme")
            a.setCheckable(True)
            a.setChecked(not e.target)
            a.triggered.connect(lambda: ed.set_effect_target(self.effect_id, ""))
            menu.addSeparator()
        for depth, node in layers(self.root):
            label = "    " * depth + node.name
            if shape_param:
                sub = menu.addMenu(icons.icon(node_icon(node), 13), label)
                for sp, _f in node_param_specs(node):
                    if not sp.animatable:
                        continue
                    a = sub.addAction(sp.label)
                    a.setCheckable(True)
                    a.setChecked(e.target == node.id and e.key == sp.key)
                    a.triggered.connect(lambda _=False, nid=node.id, k=sp.key: ed.set_effect_target(self.effect_id, nid, k))
            elif node.kind != "modifier":
                a = menu.addAction(icons.icon(node_icon(node), 13), label)
                a.setCheckable(True)
                a.setChecked(e.target == node.id)
                a.triggered.connect(lambda _=False, nid=node.id: ed.set_effect_target(self.effect_id, nid))
        return menu

    def refresh(self):
        _, e = self.editor.find_effect(self.effect_id)
        if e is None:
            return
        self.set_on(e.enabled)
        self._update_target(e)
        for r in self.rows:
            r.refresh()

    def abort(self):
        for r in self.rows:
            r.abort()
