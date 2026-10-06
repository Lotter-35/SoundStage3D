"""Menus clic droit de la timeline (règle, pistes, clips, automations, clés)."""

from PySide6.QtGui import QAction
from PySide6.QtWidgets import QInputDialog, QMenu

from ...core.automation import CURVES
from .geometry import HEADER_W


class TimelineMenus:
    def contextMenuEvent(self, e):
        x, y = e.pos().x(), e.pos().y()
        g = self.geo
        ed = self.editor
        tl = self.tl
        menu = QMenu(self)
        t = max(0.0, self.snap(g.t(max(HEADER_W, x))))
        if y < g.top:
            menu.addAction("Début de boucle ici").triggered.connect(
                lambda: ed.timeline_mutate("Boucle", lambda: (setattr(tl, "loop_start", t), setattr(tl, "loop_end", max(t, tl.loop_end)))))
            menu.addAction("Fin de boucle ici").triggered.connect(
                lambda: ed.timeline_mutate("Boucle", lambda: (setattr(tl, "loop_end", t), setattr(tl, "loop_start", min(t, tl.loop_start)))))
            a = QAction("Boucle activée", menu, checkable=True, checked=tl.loop_on)
            a.triggered.connect(lambda on: ed.timeline_mutate("Boucle", lambda: setattr(tl, "loop_on", on)))
            menu.addAction(a)
            menu.addSeparator()
            menu.addAction("La mesure 1 commence ici").triggered.connect(
                lambda: ed.timeline_mutate("Mesure 1", lambda: setattr(tl, "bar_offset", g.t(x))))
            menu.exec(e.globalPos())
            return
        row = g.row_at(self.rows(), y)
        if row is None:
            menu.addAction("Ajouter une piste").triggered.connect(ed.add_track)
            menu.exec(e.globalPos())
            return
        if row.kind == "track":
            clip, _ = self.clip_hit(row, x) if x >= HEADER_W else (None, None)
            if clip is not None:
                ed.enter_clip(clip.id)
                self._clip_menu(menu, clip)
            else:
                tr = row.track
                menu.addAction("Renommer la piste…").triggered.connect(lambda: self._rename_track(tr))
                menu.addAction("Ajouter une piste").triggered.connect(ed.add_track)
                a = menu.addAction("Supprimer la piste")
                a.triggered.connect(lambda: ed.remove_track(tr.id))
        else:
            k = self.key_hit(row, x, y) if x >= HEADER_W else None
            if k is not None:
                self.sel_key = k
                self.update()
                for cid, label, _ in CURVES:
                    a = QAction(label, menu, checkable=True, checked=k.curve == cid)
                    a.triggered.connect(lambda _=False, c=cid: ed.timeline_mutate("Courbe", lambda: setattr(k, "curve", c)))
                    menu.addAction(a)
                menu.addSeparator()
                menu.addAction("Supprimer la clé").triggered.connect(
                    lambda: ed.timeline_mutate("Supprimer la clé", lambda: row.auto.keys.remove(k)))
            else:
                auto, clip = row.auto, row.clip
                menu.addAction("Relier à un autre réglage").triggered.connect(lambda: self._rearm(clip, auto))
                menu.addAction("Supprimer l'automation").triggered.connect(lambda: ed.delete_automation(clip.id, auto.id))
        menu.exec(e.globalPos())

    def _clip_menu(self, menu, clip):
        ed = self.editor
        menu.addAction("Nouvelle automation").triggered.connect(lambda: ed.new_automation(clip.id))
        menu.addAction("Replier" if clip.expanded else "Déplier").triggered.connect(lambda: self._toggle(clip))
        menu.addSeparator()
        menu.addAction("Éditer la forme personnalisée").triggered.connect(lambda: ed.enter_def(clip.def_id))
        menu.addAction("Dupliquer").triggered.connect(lambda: ed.duplicate_clip(clip.id))
        menu.addAction("Supprimer").triggered.connect(lambda: ed.delete_clip(clip.id))

    def _toggle(self, clip):
        clip.expanded = not clip.expanded
        self._changed()

    def _rename_track(self, tr):
        name, ok = QInputDialog.getText(self, "Renommer la piste", "Nom :", text=tr.name)
        if ok and name.strip():
            self.editor.timeline_mutate("Renommer la piste", lambda: setattr(tr, "name", name.strip()))

    def _rearm(self, clip, auto):
        def do():
            clip.automations = [a for a in clip.automations if not a.armed or a is auto]
            auto.node_id = ""
            auto.key = ""
            auto.label = "En attente : touchez un réglage"
        self.editor.timeline_mutate("Relier l'automation", do)
        self.editor.enter_clip(clip.id)
