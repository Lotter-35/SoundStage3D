"""Menus clic droit de la timeline (règle, pistes, clips)."""

from PySide6.QtGui import QAction
from PySide6.QtWidgets import QInputDialog, QMenu

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
            menu.addAction("Ajouter un repère ici").triggered.connect(lambda: ed.add_marker(t))
            menu.addAction("Début de la mesure 1 ici").triggered.connect(
                lambda: ed.timeline_mutate("Mesure 1", lambda: setattr(tl, "bar_offset", g.t(x))))
            menu.exec(e.globalPos())
            return
        row = g.row_at(self.rows(), y, x)
        if row is None:
            menu.addAction("Ajouter une piste").triggered.connect(ed.add_track)
            menu.exec(e.globalPos())
            return
        clip, _ = self.clip_hit(row, x) if x >= HEADER_W else (None, None)
        if clip is not None:
            if clip.id not in self.sel_clips:
                self.set_clip_selection([clip.id])
            ed.select_clips(ed.clip_selection, clip.id)
            self._clip_menu(menu, clip)
        else:
            tr = row.track
            menu.addAction("Renommer la piste…").triggered.connect(lambda: self._rename_track(tr))
            menu.addAction("Ajouter une piste").triggered.connect(ed.add_track)
            a = menu.addAction("Supprimer la piste")
            a.triggered.connect(lambda: ed.remove_track(tr.id))
        menu.exec(e.globalPos())

    def _clip_menu(self, menu, clip):
        ed = self.editor
        linked, shared = ed.clip_is_linked(clip)
        if not linked:
            menu.addAction("Relier (reprendre l'animation des autres clips de la forme)").triggered.connect(
                lambda: ed.relink_clip(clip.id))
            menu.addSeparator()
        elif shared:
            menu.addAction("Délier (animation propre à ce clip)").triggered.connect(lambda: ed.unlink_clip(clip.id))
            menu.addSeparator()
        menu.addAction("Ouvrir dans Forme").triggered.connect(lambda: ed.enter_def(clip.def_id))
        menu.addAction("Dupliquer").triggered.connect(lambda: ed.duplicate_clip(clip.id))
        menu.addAction("Supprimer").triggered.connect(lambda: ed.delete_clip(clip.id))

    def _rename_track(self, tr):
        name, ok = QInputDialog.getText(self, "Renommer la piste", "Nom :", text=tr.name)
        if ok and name.strip():
            self.editor.rename_track(tr.id, name)
