"""Inspecteur du clip actif (colonne de droite de Show) : nom et piste, Début / Durée / Fondus, liaison de
l'animation (« Animation partagée avec N clips [Délier] » ou « Animation propre [Relier…] »), effets
d'animation (cartes, ordre par glisser, « + Ajouter »), forme du clip (lecture seule, « Ouvrir dans Forme »).

Le panneau est reconstruit seulement quand sa structure change (autre clip, effets ajoutés / retirés / déplacés,
mode d'un réglage, cible…) ; sinon les valeurs sont mises à jour sur place (un glisser n'est jamais coupé).
"""

from PySide6.QtCore import QRectF, Qt, QTimer
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QLabel, QMenu, QPushButton, QScrollArea, QToolButton,
                               QVBoxLayout, QWidget)

from ...core.effects import by_category, effect_specs
from ...core.evaluator import evaluate_form
from .. import icons, theme
from ..timeline.drops import EFFECT_MIME
from ..widgets import LaserView
from .clip_fields import ClipFields
from .effect_card import MOVE_MIME, EffectCard
from .library import panel_title, separator


class EffectsArea(QWidget):
    """Liste des cartes ; accepte un effet glissé de la bibliothèque (ajout) ou une carte (nouvel ordre)."""

    def __init__(self, inspector):
        super().__init__()
        self.inspector = inspector
        self.lay = QVBoxLayout(self)
        self.lay.setContentsMargins(8, 0, 8, 0)
        self.lay.setSpacing(6)
        self.setAcceptDrops(True)
        self.drop_y = None

    def cards(self):
        return [self.lay.itemAt(i).widget() for i in range(self.lay.count())
                if isinstance(self.lay.itemAt(i).widget(), EffectCard)]

    def index_at(self, y):
        cards = self.cards()
        for i, c in enumerate(cards):
            if y < c.geometry().center().y():
                return i, c.geometry().top() - 3
        return len(cards), (cards[-1].geometry().bottom() + 3 if cards else 2)

    def dragEnterEvent(self, e):
        if e.mimeData().hasFormat(MOVE_MIME) or e.mimeData().hasFormat(EFFECT_MIME):
            e.acceptProposedAction()

    def dragMoveEvent(self, e):
        self.drop_y = self.index_at(e.position().y())[1]
        self.update()
        e.acceptProposedAction()

    def dragLeaveEvent(self, e):
        self.drop_y = None
        self.update()

    def dropEvent(self, e):
        md = e.mimeData()
        i, _ = self.index_at(e.position().y())
        self.drop_y = None
        ed = self.inspector.editor
        clip = ed.current_clip()
        if clip is None:
            return
        if md.hasFormat(MOVE_MIME):
            eid = bytes(md.data(MOVE_MIME)).decode("utf-8")
            anim, eff = ed.find_effect(eid)
            if eff is not None:
                cur = anim.effects.index(eff)
                ed.move_effect(eid, i - 1 if i > cur else i)
        else:
            ed.add_effect(clip.id, bytes(md.data(EFFECT_MIME)).decode("utf-8"), index=i)
        e.acceptProposedAction()

    def paintEvent(self, e):
        super().paintEvent(e)
        if self.drop_y is not None:
            from PySide6.QtGui import QPainter
            p = QPainter(self)
            p.fillRect(QRectF(8, self.drop_y - 1, self.width() - 16, 2), theme.qc(theme.ACCENT))
            p.end()


class ClipInspector(QScrollArea):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setWidgetResizable(True)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setMinimumWidth(260)
        self._sig = None
        self.cards = []
        self.fields = None
        self.expanded = {}            # id d'effet → carte dépliée (affichage)
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(0)
        self._timer.timeout.connect(self.rebuild)
        editor.clipSelectionChanged.connect(self.sync)
        editor.timelineChanged.connect(self.sync)
        editor.docChanged.connect(self.sync)
        editor.libraryChanged.connect(self.sync)
        editor.restored.connect(self._abort)
        self._sig = self.signature()
        self.rebuild()

    # ── Structure ────────────────────────────────────────────────────────
    def signature(self):
        ed = self.editor
        clip = ed.current_clip()
        if clip is None:
            return None
        tl = ed.doc.timeline
        tr, _ = tl.find_clip(clip.id)
        d = ed.doc.library.get(clip.def_id)
        anim = tl.animations.get(clip.anim_id)
        shared, others = tl.link_state(clip)
        effects = tuple((e.id, e.type_id, e.target, e.key, tuple((k, t.mode) for k, t in e.params.items()))
                        for e in (anim.effects if anim else []))
        return (clip.id, clip.anim_id, tr.name if tr else "", d.name if d else "", shared, ed.linked_count(clip),
                len(others), effects, len(ed.doc.library.defs))

    def sync(self):
        sig = self.signature()
        if sig != self._sig:
            self._sig = sig
            # Reconstruit juste après : le widget qui a déclenché le changement (clic) n'est pas détruit
            # pendant son propre signal
            self._timer.start()
        elif not self._timer.isActive():
            self.refresh()

    def rebuild(self):
        ed = self.editor
        self._sig = self.signature()
        old = self.takeWidget()
        if old is not None:
            old.hide()
            old.deleteLater()
        for c in self.cards:
            self.expanded[c.effect_id] = c.is_expanded()
        self.cards = []
        self.fields = None
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 10)
        lay.setSpacing(0)
        lay.addWidget(panel_title("Clip"))
        clip = ed.current_clip()
        if clip is None:
            h = QLabel("Sélectionnez un clip dans la timeline pour régler ses effets d'animation.")
            h.setObjectName("dim")
            h.setWordWrap(True)
            h.setContentsMargins(10, 4, 10, 4)
            lay.addWidget(h)
            lay.addStretch(1)
            self.setWidget(w)
            self.effects_area = None
            return
        tl = ed.doc.timeline
        tr, _ = tl.find_clip(clip.id)
        d = ed.doc.library.get(clip.def_id)
        root = d.root if d is not None else None
        title = QLabel(f"<b style='font-size:13px'>{d.name if d else '?'}</b>&nbsp;&nbsp;"
                       f"<span style='color:{theme.TEXT_DIM}'>{tr.name if tr else ''}</span>")
        title.setContentsMargins(10, 2, 10, 6)
        lay.addWidget(title)
        self.fields = ClipFields(ed)
        lay.addWidget(self.fields)
        lay.addWidget(self._link_row(clip))
        lay.addWidget(separator())
        head = QHBoxLayout()
        head.setContentsMargins(0, 0, 8, 0)
        head.addWidget(panel_title("Effets d'animation"))
        head.addStretch(1)
        self.add_btn = QToolButton()
        self.add_btn.setText("Ajouter")
        self.add_btn.setIcon(icons.icon("plus", 13))
        self.add_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.add_btn.setToolTip("Ajouter un effet d'animation (ou glisser un effet de la bibliothèque)")
        self.add_btn.clicked.connect(lambda: self.add_menu().exec(self.add_btn.mapToGlobal(self.add_btn.rect().bottomLeft())))
        head.addWidget(self.add_btn)
        lay.addLayout(head)
        self.effects_area = EffectsArea(self)
        anim = tl.animations.get(clip.anim_id)
        for e in (anim.effects if anim else []):
            card = EffectCard(ed, clip, e, root, self.expanded.get(e.id, True))
            self.cards.append(card)
            self.effects_area.lay.addWidget(card)
        if not self.cards:
            h = QLabel("Aucun effet : glissez-en un depuis la bibliothèque, ou « Ajouter ».")
            h.setObjectName("dim")
            h.setWordWrap(True)
            h.setContentsMargins(2, 0, 2, 6)
            self.effects_area.lay.addWidget(h)
        lay.addWidget(self.effects_area)
        lay.addSpacing(6)
        lay.addWidget(separator())
        lay.addWidget(panel_title("Forme du clip"))
        lay.addWidget(self._form_block(clip, d))
        lay.addStretch(1)
        self.setWidget(w)
        self.refresh()

    def _link_row(self, clip):
        ed = self.editor
        shared, others = ed.clip_link_state(clip)
        box = QFrame()
        box.setObjectName("card")
        h = QHBoxLayout(box)
        h.setContentsMargins(8, 4, 6, 4)
        h.setSpacing(8)
        ic = QLabel()
        ic.setPixmap(icons.pixmap("link" if shared else "unlink", theme.TEXT_DIM, 13))
        h.addWidget(ic)
        n = ed.linked_count(clip)
        txt = (f"Animation partagée avec {n} clip{'s' if n > 1 else ''}" if shared else "Animation propre")
        lab = QLabel(txt)
        lab.setObjectName("dim")
        h.addWidget(lab, 1)
        self.link_btn = None
        if shared:
            self.link_btn = QPushButton("Délier")
            self.link_btn.setToolTip("Ce clip reçoit sa propre copie de l'animation (la forme reste commune)")
            self.link_btn.clicked.connect(lambda: ed.unlink_clip(clip.id))
        elif others:
            self.link_btn = QPushButton("Relier…")
            self.link_btn.setToolTip("Reprendre l'animation d'un autre clip de la même forme")
            self.link_btn.clicked.connect(lambda: self.relink(clip))
        if self.link_btn is not None:
            self.link_btn.setFixedHeight(22)
            h.addWidget(self.link_btn)
        wrap = QWidget()
        wl = QVBoxLayout(wrap)
        wl.setContentsMargins(8, 6, 8, 8)
        wl.addWidget(box)
        return wrap

    def relink(self, clip):
        ed = self.editor
        _, others = ed.clip_link_state(clip)
        if len(others) <= 1:
            ed.relink_clip(clip.id)
            return
        menu = QMenu(self)
        tl = ed.doc.timeline
        for aid in others:
            c = next(c for c in tl.clips_of_anim(aid))
            bar, beat, sub = tl.position(c.start)
            menu.addAction(f"Comme le clip à {bar}.{beat}.{sub}").triggered.connect(
                lambda _=False, a=aid: ed.relink_clip(clip.id, a))
        menu.exec(self.link_btn.mapToGlobal(self.link_btn.rect().bottomLeft()))

    def _form_block(self, clip, d):
        ed = self.editor
        box = QFrame()
        box.setObjectName("card")
        h = QHBoxLayout(box)
        h.setContentsMargins(8, 7, 8, 7)
        h.setSpacing(10)
        self.form_view = LaserView(glow=True, fit=True, margin=3, frame=False)
        self.form_view.setFixedSize(40, 40)
        if d is not None:
            strokes, _ = evaluate_form(d, ed.doc.library, 0.0, ed.doc.timeline.bpm, ed.default_color())
            self.form_view.set_strokes(strokes)
        h.addWidget(self.form_view)
        n = sum(1 for _ in d.root.walk()) - 1 if d is not None else 0
        lab = QLabel(f"{d.name if d else '?'}<br><span style='color:{theme.TEXT_DIM}; font-size:11px'>"
                     f"{n} calque{'s' if n > 1 else ''}</span>")
        h.addWidget(lab, 1)
        self.open_btn = QPushButton("Ouvrir dans Forme")
        self.open_btn.setIcon(icons.icon("pen-line", 13, color=theme.TEXT))
        self.open_btn.setToolTip("Modifier le dessin de cette forme (espace Forme) — aussi : double-clic sur le clip")
        self.open_btn.clicked.connect(lambda: ed.enter_def(clip.def_id))
        h.addWidget(self.open_btn)
        wrap = QWidget()
        wl = QVBoxLayout(wrap)
        wl.setContentsMargins(8, 0, 8, 0)
        wl.addWidget(box)
        return wrap

    def add_menu(self):
        ed = self.editor
        menu = QMenu(self)
        clip = ed.current_clip()
        for cat, types in by_category():
            if not types:
                continue
            menu.addSection(cat)
            for et in types:
                a = menu.addAction(icons.icon(et.icon, 14), et.label)
                a.setToolTip(et.description)
                a.triggered.connect(lambda _=False, t=et.type_id: clip is not None and ed.add_effect(clip.id, t))
        return menu

    # ── Valeurs ──────────────────────────────────────────────────────────
    def refresh(self):
        if self.fields is not None:
            self.fields.refresh()
        for c in self.cards:
            c.refresh()

    def _abort(self):
        if self.fields is not None:
            self.fields.abort()
        for c in self.cards:
            c.abort()

    def card(self, effect_id):
        return next((c for c in self.cards if c.effect_id == effect_id), None)


__all__ = ["ClipInspector", "effect_specs"]
