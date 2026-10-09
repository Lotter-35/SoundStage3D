"""Clavier de l'espace Live : touches des cues (appui = lancer / arrêter), chiffres 1 à 8 (effets rapides tenus
tant que la touche est enfoncée), Échap (tout arrêter), Espace (rien : pas de lecture de la timeline ici).

Un filtre d'événements posé sur l'application tant que l'espace Live est affiché. Il passe avant les raccourcis
de la fenêtre (ShortcutOverride accepté : aucun raccourci à une touche ne part) et avant le widget qui a le
focus. Il ne fait rien quand on tape dans un champ texte, qu'un menu, un panneau déroulant ou un dialogue est
ouvert, ou qu'une touche Ctrl / Alt / Cmd est enfoncée (les raccourcis ⌘Z, ⌘S… gardent leur rôle).
"""

from PySide6.QtCore import QEvent, QObject, Qt
from PySide6.QtWidgets import (QAbstractSpinBox, QApplication, QComboBox, QLineEdit, QPlainTextEdit, QTextEdit,
                               QWidget)

from ...core.live import QUICK_EFFECTS, QUICK_KEYS, normalize_key

K = Qt.Key
MODS = Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.AltModifier | Qt.KeyboardModifier.MetaModifier
KEY_EVENTS = (QEvent.Type.ShortcutOverride, QEvent.Type.KeyPress, QEvent.Type.KeyRelease)


def key_name(e):
    """Touche d'un événement clavier → nom de touche de cue (« A », « , », « 2 », « F3 ») ou ""."""
    k = e.key()
    if K.Key_F1.value <= k <= K.Key_F12.value:
        return f"F{k - K.Key_F1.value + 1}"
    t = e.text()
    if t and t.isprintable() and not t.isspace():
        return normalize_key(t)
    if 0x21 <= k <= 0x7E:                     # événement sans texte (tests, certaines plateformes)
        return normalize_key(chr(k))
    return ""


def typing(w):
    """Vrai si l'utilisateur tape dans un champ texte (les touches gardent alors leur rôle habituel)."""
    if isinstance(w, (QLineEdit, QAbstractSpinBox, QTextEdit, QPlainTextEdit)):
        return True
    return isinstance(w, QComboBox) and w.isEditable()


class LiveKeys(QObject):
    def __init__(self, editor, window, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.window = window
        self.held = {}          # touche → id de l'effet rapide qu'elle tient
        self.installed = False

    def install(self):
        if not self.installed:
            QApplication.instance().installEventFilter(self)
            self.installed = True

    def remove(self):
        if self.installed:
            QApplication.instance().removeEventFilter(self)
            self.installed = False
        self.release_all()

    def release_all(self):
        """Lâche les effets rapides tenus au clavier (fenêtre qui perd la main, autre espace)."""
        held, self.held = self.held, {}
        for qid in held.values():
            self.editor.release_quick(qid)

    # ── Filtre ───────────────────────────────────────────────────────────
    def _ours(self, obj):
        if not isinstance(obj, QWidget) or obj.window() is not self.window:
            return False
        if QApplication.activePopupWidget() is not None or QApplication.activeModalWidget() is not None:
            return False
        return not typing(obj) and not typing(QApplication.focusWidget())

    def _owned(self, e):
        """Touche gérée par l'espace Live : (nom, rôle) avec rôle « cue », « quick », « stop », « space »."""
        if e.modifiers() & MODS:
            return None
        k = e.key()
        if k == K.Key_Escape.value:
            return "Escape", "stop"
        if k == K.Key_Space.value:
            return "Space", "space"
        name = key_name(e)
        if not name:
            return None
        return name, "quick" if name in QUICK_KEYS else "cue"

    def eventFilter(self, obj, e):
        if e.type() not in KEY_EVENTS or not self._ours(obj):
            return False
        owned = self._owned(e)
        if owned is None:
            return False
        if e.type() == QEvent.Type.ShortcutOverride:
            e.accept()                           # aucun raccourci de la fenêtre pour cette touche
            return True
        name, role = owned
        if e.isAutoRepeat():
            return True                          # touche tenue : ni relance, ni arrêt
        if e.type() == QEvent.Type.KeyRelease:
            if role == "quick" and name in self.held:
                self.editor.release_quick(self.held.pop(name))
            return True
        if role == "stop":
            self.held.clear()
            self.editor.stop_all_cues()
        elif role == "quick":
            qid = QUICK_EFFECTS[QUICK_KEYS.index(name)].id
            self.held[name] = qid
            self.editor.hold_quick(qid)
        elif role == "cue":
            self.editor.trigger_key(name)
        return True
