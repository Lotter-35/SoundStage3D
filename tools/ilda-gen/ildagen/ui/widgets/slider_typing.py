"""Saisie au clavier d'un SliderField : un champ texte posé sur la barre (double-clic, Entrée ou F2).

Entrée ou clic ailleurs = valider (refusé si ce n'est pas un nombre fini, sinon borné) ; Échap = annuler.
Classe mêlée à SliderField (elle utilise sa valeur, son format et _commit_value).
"""

from PySide6.QtCore import QEvent, Qt
from PySide6.QtWidgets import QLineEdit

from .numbers import fmt_number, parse_number


class TypingMixin:
    _editor = None

    def start_typing(self):
        if self._editor is not None or not self.isEnabled():
            return
        self._end_burst()
        ed = QLineEdit(self)
        ed.setObjectName("sliderEdit")
        ed.setStyleSheet("QLineEdit#sliderEdit { padding: 0 6px; min-height: 0px; }")
        ed.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        ed.setText(fmt_number(self._value * self.factor, self.decimals))
        ed.setGeometry(self.bar_rect().toAlignedRect())
        ed.installEventFilter(self)
        ed.editingFinished.connect(self._commit_typing)
        self._editor = ed
        ed.show()
        ed.setFocus(Qt.FocusReason.OtherFocusReason)
        ed.selectAll()
        self.update()

    def typing_editor(self):
        return self._editor

    def eventFilter(self, obj, e):
        if obj is self._editor and e.type() == QEvent.Type.KeyPress:
            if e.key() == Qt.Key.Key_Escape:
                self._close_editor(refocus=True)
                return True
            if e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
                self._commit_typing()           # gardée ici : la touche n'arrive pas au champ (nouvelle saisie)
                return True
        if obj is self._editor and e.type() == QEvent.Type.ShortcutOverride and e.key() == Qt.Key.Key_Escape:
            e.accept()                          # Échap ferme la saisie, pas un raccourci de la fenêtre
            return True
        return super().eventFilter(obj, e)

    def _close_editor(self, refocus=False):
        ed = self._editor
        if ed is None:
            return None
        self._editor = None
        had_focus = ed.hasFocus()
        ed.blockSignals(True)
        text = ed.text()
        ed.hide()
        ed.deleteLater()
        if refocus or had_focus:
            self.setFocus(Qt.FocusReason.OtherFocusReason)
        self.update()
        return text

    def _commit_typing(self):
        text = self._close_editor()
        if text is None:
            return
        v = parse_number(text, self.unit)
        if v is not None:                   # texte, « inf », « nan »… : refusé, la valeur reste
            self._commit_value(v / self.factor)

    def resizeEvent(self, e):
        if self._editor is not None:
            self._editor.setGeometry(self.bar_rect().toAlignedRect())
        super().resizeEvent(e)
