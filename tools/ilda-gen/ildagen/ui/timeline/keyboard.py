"""Clavier dans la timeline (quand elle a le focus) :

- flèches ← → : la clé, le repère ou les clips sélectionnés avancent d'un pas de grille ; ↑ ↓ : valeur de la
  clé, ou clips sur la piste du dessus / dessous ;
- Début / Fin : tête de lecture au début / à la fin du contenu ; Z : zoom sur la sélection (sinon tout),
  Maj + Z : tout ; M : repère à la tête de lecture ;
- Échap : annule le glisser en cours, sinon désélectionne tout (clé, repère, clips, zone de temps) ;
- Suppr : ce qui est en surbrillance (edit.delete_selection). Espace (lecture) reste un raccourci de la fenêtre.

Les touches simples propres à la timeline passent avant les raccourcis de la fenêtre (M, Z… servent aussi
d'outils dans l'espace Forme).
"""

from PySide6.QtCore import Qt

K = Qt.Key
OWN_KEYS = (K.Key_Left, K.Key_Right, K.Key_Up, K.Key_Down, K.Key_Home, K.Key_End, K.Key_Z, K.Key_M)


class TimelineKeyboard:
    def override_shortcut(self, e):
        """ShortcutOverride : la timeline garde ses touches simples."""
        mods = e.modifiers() & ~(Qt.KeyboardModifier.ShiftModifier | Qt.KeyboardModifier.KeypadModifier)
        return e.key() in OWN_KEYS and mods == Qt.KeyboardModifier.NoModifier and self.inline is None

    def keyPressEvent(self, e):
        key = e.key()
        shift = bool(e.modifiers() & Qt.KeyboardModifier.ShiftModifier)
        if key == K.Key_Shift:
            self.modifiers_changed()
            return
        if key == K.Key_Escape:
            if not self.abandon_drag() and not self.close_inline(commit=False):
                self.clear_all()
            return
        if key in (K.Key_Delete, K.Key_Backspace):
            self.delete_selection()
            return
        if not self.override_shortcut(e):
            super().keyPressEvent(e)
            return
        if key in (K.Key_Left, K.Key_Right):
            step = 1 if key == K.Key_Right else -1
            if not self.nudge_key(steps=step) and not self.nudge_marker(step):
                self.nudge_clips(step)
        elif key in (K.Key_Up, K.Key_Down):
            step = 1 if key == K.Key_Up else -1
            if not self.nudge_key(vsteps=step):
                self.nudge_clips(0, -step)
        elif key == K.Key_Home:
            self.playback.seek(0.0)
        elif key == K.Key_End:
            self.playback.seek(self.tl.content_end())
        elif key == K.Key_Z:
            self.zoom_fit(selection=not shift)
        elif key == K.Key_M:
            self.add_marker_here()
        self.update()

    def keyReleaseEvent(self, e):
        if e.key() == K.Key_Shift:
            self.modifiers_changed()
            return
        super().keyReleaseEvent(e)

    def clear_all(self):
        """Échap : plus rien de sélectionné dans la timeline."""
        self.sel_key = None
        self.sel_marker = None
        self.clear_range()
        self.set_clip_selection(())
        self.update()

    def nudge_marker(self, steps):
        m = self.tl.find_marker(self.sel_marker) if self.sel_marker else None
        if m is None:
            return False
        ed = self.editor
        ed.begin("Déplacer le repère")
        ed.move_marker(m.id, max(0.0, m.t + steps * self.tl.grid_step))
        ed.commit(merge=("marker", m.id))
        return True
