"""Menus clic droit de la timeline : règle (repères, boucle, mesure 1), pistes (couleur, nom, verrou), clips
(forme, liaison, effets, dupliquer…), clés de courbe (supprimer, type de courbe) et lignes de courbe.

Chaque menu est construit par une fonction build_… (les tests la déclenchent sans ouvrir le menu)."""

from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QActionGroup, QColor, QIcon, QPixmap
from PySide6.QtWidgets import QMenu

from ...core.effects import by_category
from ...core.timeline import TRACK_COLORS
from .. import theme
from . import curves as CV
from .geometry import HEADER_W, RULER_H

NOMOD = Qt.KeyboardModifier.NoModifier
COLOR_NAMES = ["Vert", "Jaune", "Violet", "Orange", "Cyan", "Rose", "Citron", "Ambre"]


def color_icon(hex_color):
    pm = QPixmap(14, 14)
    pm.fill(QColor(hex_color))
    return QIcon(pm)


class TimelineMenus:
    def exec_menu(self, menu, pos=None):
        from PySide6.QtGui import QCursor
        menu.exec(pos if pos is not None else QCursor.pos())

    def contextMenuEvent(self, e):
        x, y = e.pos().x(), e.pos().y()
        menu = self.build_context_menu(x, y)
        if menu is not None and not menu.isEmpty():
            menu.exec(e.globalPos())

    def build_context_menu(self, x, y):
        g = self.geo
        if y < RULER_H:
            return self.build_ruler_menu(x, y) if x >= HEADER_W else None
        if y < g.top:
            return None
        row, b, zone, lane = self.hit(x, y)
        if row is None:
            menu = QMenu(self)
            menu.addAction("Ajouter une piste").triggered.connect(self.editor.add_track)
            return menu
        if x < HEADER_W:
            return self.build_track_menu(row.track)
        if b is None:
            return self.build_empty_menu(row, x)
        if zone == "key":
            i = self.key_at(b, lane, x, y)
            self.press_key(b, lane, x, y, NOMOD)
            self.drag = None
            return self.build_key_menu(b.clip, lane, i)
        if b.clip.id not in self.sel_clips:
            self.set_clip_selection([b.clip.id])
        self.editor.select_clips(self.editor.clip_selection, b.clip.id)
        if zone == "lane":
            return self.build_lane_menu(b, lane, x, y)
        return self.build_clip_menu(b.clip)

    # ── Règle ────────────────────────────────────────────────────────────
    def build_ruler_menu(self, x, y):
        ed, tl = self.editor, self.tl
        menu = QMenu(self)
        t = max(0.0, self.snapper.snap(self.geo.t(x), NOMOD))
        self.snapper.clear()
        m = self.marker_at(x, y)
        if m is not None:
            self.sel_marker = m.id
            menu.addAction("Renommer le repère…").triggered.connect(lambda: self.rename_marker_inline(m))
            sub = menu.addMenu("Couleur du repère")
            for c, name in zip(TRACK_COLORS, COLOR_NAMES):
                a = sub.addAction(color_icon(c), name)
                a.setCheckable(True)
                a.setChecked(c == m.color)
                a.triggered.connect(lambda _=False, col=c: ed.set_marker_color(m.id, col))
            menu.addAction("Supprimer le repère").triggered.connect(lambda: ed.remove_marker(m.id))
            menu.addSeparator()
        menu.addAction("Ajouter un repère ici\tM").triggered.connect(lambda: self.add_marker_here(t))
        menu.addSeparator()
        menu.addAction("Début de boucle ici").triggered.connect(lambda: self.set_loop(t, None))
        menu.addAction("Fin de boucle ici").triggered.connect(lambda: self.set_loop(None, t))
        a = QAction("Boucle activée", menu, checkable=True, checked=tl.loop_on)
        a.setEnabled(tl.loop_end > tl.loop_start)
        a.triggered.connect(lambda on: ed.timeline_mutate("Boucle", lambda: setattr(tl, "loop_on", on)))
        menu.addAction(a)
        menu.addSeparator()
        menu.addAction("Début de la mesure 1 ici").triggered.connect(
            lambda: ed.timeline_mutate("Début de la mesure 1", lambda: setattr(tl, "bar_offset", t)))
        return menu

    def set_loop(self, a=None, b=None):
        tl = self.tl

        def do():
            s = tl.loop_start if a is None else a
            e = tl.loop_end if b is None else b
            if e < s:
                s, e = e, s
            tl.loop_start, tl.loop_end = s, e
            tl.loop_on = e - s > 1e-6
        self.editor.timeline_mutate("Boucle", do)

    # ── Pistes ───────────────────────────────────────────────────────────
    def build_color_menu(self, tr, menu=None):
        menu = menu or QMenu(self)
        group = QActionGroup(menu)
        for c, name in zip(TRACK_COLORS, COLOR_NAMES):
            a = menu.addAction(color_icon(c), name)
            a.setCheckable(True)
            a.setChecked(c == tr.color)
            group.addAction(a)
            a.triggered.connect(lambda _=False, col=c, tid=tr.id: self.editor.set_track_color(tid, col))
        return menu

    def build_track_menu(self, tr):
        ed = self.editor
        menu = QMenu(self)
        row = next((r for r in self.rows() if r.track is tr), None)
        if row is not None:
            menu.addAction("Renommer la piste").triggered.connect(lambda: self.rename_track_inline(row))
        self.build_color_menu(tr, menu.addMenu("Couleur de la piste"))
        a = menu.addAction("Verrouiller la piste")
        a.setCheckable(True)
        a.setChecked(tr.locked)
        a.triggered.connect(lambda on: ed.set_track_flag(tr.id, "locked", on))
        menu.addSeparator()
        menu.addAction("Ajouter une piste").triggered.connect(ed.add_track)
        menu.addAction("Supprimer la piste").triggered.connect(lambda: ed.remove_track(tr.id))
        return menu

    def build_empty_menu(self, row, x):
        menu = QMenu(self)
        t = max(0.0, self.snapper.snap(self.geo.t(x), NOMOD))
        self.snapper.clear()
        a = menu.addAction("Coller ici")
        a.setEnabled(bool(self.editor.clip_clipboard))
        a.triggered.connect(lambda: (self.editor.set_playhead(t), self.paste_clips()))
        menu.addAction("Ajouter une piste").triggered.connect(self.editor.add_track)
        return menu

    # ── Clips ────────────────────────────────────────────────────────────
    def build_clip_menu(self, clip):
        ed = self.editor
        menu = QMenu(self)
        menu.addAction("Ouvrir dans Forme").triggered.connect(lambda: ed.enter_def(clip.def_id))
        shared, others = ed.clip_link_state(clip)
        if shared:
            menu.addAction("Délier (animation propre à ce clip)").triggered.connect(lambda: ed.unlink_clip(clip.id))
        elif others:
            menu.addAction("Relier (animation des autres clips de la forme)").triggered.connect(
                lambda: ed.relink_clip(clip.id))
        sub = menu.addMenu("Ajouter un effet")
        for cat, types in by_category():
            if not types:
                continue
            sub.addSection(cat)
            for et in types:
                sub.addAction(et.label).triggered.connect(lambda _=False, tid=et.type_id: self.add_effect_to(clip, tid))
        if self.find_box(clip.id) is not None and self.find_box(clip.id).foldable:
            label = "Replier les courbes" if clip.expanded else "Déplier les courbes"
            menu.addAction(label).triggered.connect(lambda: ed.set_clip_expanded(clip.id, not clip.expanded))
        menu.addSeparator()
        menu.addAction("Copier\tCtrl+C").triggered.connect(self.copy_clips)
        menu.addAction("Couper\tCtrl+X").triggered.connect(self.cut_clips)
        menu.addAction("Dupliquer\tCtrl+D").triggered.connect(self.duplicate_clips)     # T10 : comme Ctrl+D
        menu.addAction("Supprimer\tSuppr").triggered.connect(lambda: (self.deselect_key(), self.delete_selection()))
        return menu

    # ── Courbes ──────────────────────────────────────────────────────────
    def build_key_menu(self, clip, lane, i):
        ed = self.editor
        menu = QMenu(self)
        curve = lane.track.curve
        if i is None or i >= len(curve.keys):
            return menu
        k = curve.keys[i]
        eid, key = lane.effect.id, lane.key
        menu.addAction("Supprimer la clé").triggered.connect(lambda: self.delete_selected_key())
        if not curve.discrete:
            sub = menu.addMenu("Type de courbe")
            group = QActionGroup(sub)
            for cid, label in CV.CURVE_MENU:
                a = sub.addAction(label)
                a.setCheckable(True)
                a.setChecked(k.curve == cid)
                group.addAction(a)
                a.triggered.connect(lambda _=False, c=cid: ed.set_curve_type(eid, key, curve.keys.index(k), c))
        if CV.is_color(lane.spec):
            sub = menu.addMenu("Couleur")
            for c in theme.LASER_COLORS:
                rgb = tuple(QColor(c).getRgbF()[:3])
                sub.addAction(color_icon(c), c).triggered.connect(
                    lambda _=False, v=rgb: ed.move_curve_key(eid, key, curve.keys.index(k), None, v))
        return menu

    def build_lane_menu(self, b, lane, x, y):
        ed = self.editor
        menu = QMenu(self)
        menu.addAction("Ajouter une clé ici").triggered.connect(lambda: self.add_key_at(b, lane, x, y, NOMOD))
        menu.addAction("Agrandir la ligne" if lane.small else "Réduire la ligne").triggered.connect(
            lambda: self.toggle_lane_small(b, lane))
        menu.addSeparator()
        menu.addAction("Réinitialiser la courbe").triggered.connect(lambda: ed.reset_curve(lane.effect.id, lane.key))
        menu.addAction("Revenir à une valeur fixe").triggered.connect(
            lambda: ed.set_track_mode(lane.effect.id, lane.key, "fixe"))
        return menu

    def add_effect_to(self, clip, type_id):
        e = self.editor.add_effect(clip.id, type_id)
        if e is not None:
            self.editor.select_clips([clip.id], clip.id)
        return e
