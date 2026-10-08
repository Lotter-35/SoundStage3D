"""Annuler / rétablir, gestes en cours (glisser, réglage…) et état d'affichage hors historique.

Un geste (glisser dans la mire ou la timeline, réglage glissé, couleur choisie…) ouvre une étape au début
et l'enregistre à la fin. Échap, Ctrl+Z, un changement d'outil ou l'application qui perd la main pendant
le geste l'ANNULENT : le document revient exactement à l'état d'avant le geste.

L'état d'affichage (grille, aimant, symétrie de dessin, maîtres, espace actif, dépliage des clips et des
calques…) n'entre pas dans l'historique : annuler ne le change pas, et le modifier ne crée pas d'étape (il est quand même
enregistré avec le projet).
"""

import logging

from ..core import view_state
from ..core.document import Document

log = logging.getLogger(__name__)


class HistoryOpsMixin:
    # ── Étapes ───────────────────────────────────────────────────────────
    def state_dict(self):
        return self.doc.to_dict()

    def begin(self, label):
        """À appeler AVANT une modification (une seule fois pour un geste complet)."""
        if self.history.pending():
            # Jamais de fusion avec une étape restée ouverte : elle est enregistrée à part
            log.warning("Geste « %s » resté ouvert : terminé avant « %s »", self.history.pending_label(), label)
            self.end_gesture()
        self.history.begin(label, self.state_dict())
        self._gesture_state()

    def commit(self, merge=None):
        """À appeler APRÈS la modification. merge : clé de fusion avec l'étape précédente (flèches répétées)."""
        if self.history.commit(self.state_dict(), merge):
            self.dirty = True
            self.historyChanged.emit()
            self.projectChanged.emit()
        self._gesture_state()

    def begin_action(self, label):
        """Étape d'une action (menu, raccourci) : un geste en cours se termine d'abord (sans fusion)."""
        self.end_gesture()
        self.begin(label)

    def mutate(self, label, fn, structure=True, library=False, timeline=False):
        self.begin_action(label)
        try:
            res = fn()
        except Exception:
            # Une opération qui échoue ne laisse ni étape ouverte ni document à moitié modifié
            self.cancel_gesture()
            raise
        self.commit()
        self.notify(structure=structure, library=library, timeline=timeline)
        return res

    # ── Gestes ───────────────────────────────────────────────────────────
    def gesture_active(self):
        return self.history.pending()

    def _gesture_state(self):
        on = self.history.pending()
        if on != self._gesture_on:
            self._gesture_on = on
            self.gestureChanged.emit(on)

    def _drop_gesture_flags(self):
        self.param_editing = False

    def cancel_gesture(self):
        """Annule le geste en cours : rien n'est enregistré, le document revient à l'état d'avant.
        Renvoie False s'il n'y avait pas de geste."""
        was = self.history.pending()
        self._drop_gesture_flags()
        before = self.history.abort(self.state_dict())
        self._gesture_state()
        if before is not None:
            self.restore(before)
        elif was:
            # Rien n'avait changé : les outils abandonnent quand même leur geste
            self._touch()
            self.restored.emit()
            self.docChanged.emit()
        return was

    def end_gesture(self):
        """Termine le geste en cours tel quel (une étape) ; les outils l'abandonnent."""
        if not self.history.pending():
            return False
        self._drop_gesture_flags()
        self.commit()
        self.restored.emit()
        return True

    # ── Annuler / rétablir ───────────────────────────────────────────────
    def restore(self, d):
        """Remplace le contenu par un état de l'historique ; l'état d'affichage actuel est gardé."""
        path = self.doc.path
        old_audio = self.doc.timeline.audio_path
        view = view_state.capture(self.doc)
        doc = Document()
        doc.load_dict(d)
        view_state.apply(doc, view)
        doc.path = path
        self.doc = doc
        root = self.current_root()
        if root is None:
            self.form_id = self.doc.library.visible()[0].id
            root = self.current_root()
        self.selection = [i for i in self.selection if root.find(i) is not None]
        clips = {c.id for _, c in self.doc.timeline.all_clips()}
        self.clip_selection = [i for i in self.clip_selection if i in clips]
        if self.selected_clip not in clips:
            self.selected_clip = self.clip_selection[-1] if self.clip_selection else None
        self.notify(structure=True, library=True, timeline=True)
        self.selectionChanged.emit()
        self.clipSelectionChanged.emit()
        self.contextChanged.emit()
        self.gridChanged.emit()
        self.liveChanged.emit()
        self.restored.emit()
        if self.doc.timeline.audio_path != old_audio:
            self.audioChanged.emit(self.doc.timeline.audio_path)

    def undo(self):
        """Pendant un geste : annule seulement ce geste. Sinon : annule la dernière action."""
        if self.cancel_gesture():
            self.statusMessage.emit("Geste annulé")
            return
        d = self.history.undo(self.state_dict())
        if d is not None:
            self.restore(d)
            self.dirty = True
            self.historyChanged.emit()
            self.statusMessage.emit("Annulé")

    def redo(self):
        """Pendant un geste : annule seulement ce geste. Sinon : rétablit la dernière action annulée."""
        if self.cancel_gesture():
            self.statusMessage.emit("Geste annulé")
            return
        d = self.history.redo(self.state_dict())
        if d is not None:
            self.restore(d)
            self.dirty = True
            self.historyChanged.emit()
            self.statusMessage.emit("Rétabli")

    # ── État d'affichage (enregistré avec le projet, hors historique) ────
    def view_changed(self):
        self.view_dirty = True
        self.viewChanged.emit()

    def set_grid_mode(self, mode):
        self.doc.grid.mode = mode
        self.gridChanged.emit()
        self.view_changed()

    def set_symmetry(self, mode=None, count=None):
        """Symétrie de dessin (aide au tracé, comme la grille)."""
        from ..core import draw_symmetry as DS
        g = self.doc.grid
        if mode is not None:
            g.sym = int(mode)
            if g.sym:
                g.sym_last = g.sym
        if count is not None:
            g.sym_count = int(count)
            if g.sym not in (4, 5):
                g.sym = g.sym_last = 4
        self.gridChanged.emit()
        self.view_changed()
        self.statusMessage.emit("Symétrie de dessin : " + DS.describe(g) if g.sym else "Symétrie de dessin désactivée")

    def toggle_symmetry(self):
        g = self.doc.grid
        self.set_symmetry(0 if g.sym else (g.sym_last or 1))

    def set_snap(self, on):
        self.doc.grid.snap = bool(on)
        self.gridChanged.emit()
        self.view_changed()
        self.statusMessage.emit("Aimant activé" if on else "Aimant désactivé")
