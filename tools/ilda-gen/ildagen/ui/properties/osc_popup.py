"""Éditeur de l'oscillateur d'un réglage, dans un panneau déroulant ouvert par le bouton ∿ du champ.

Les valeurs sont montrées dans les unités du champ (une position en % de la mire, une échelle en %) et converties
pour le document. Chaque geste dans l'éditeur est une étape d'annulation ; « Retirer l'oscillateur » aussi.
Annuler / rétablir pendant que le panneau est ouvert : il montre l'état rétabli (ou se ferme si l'oscillateur
n'existe plus).
"""

from PySide6.QtWidgets import QVBoxLayout, QWidget
from shiboken6 import isValid

from ..shell.popup import Popup
from ..widgets import OscEditor
from .common import display, display_spec, scaled_osc


class OscPopup(Popup):
    def __init__(self, editor, node_id, key, spec, factor=1.0, parent=None):
        super().__init__(f"Oscillateur · {spec.label}", parent)
        self.editor = editor
        self.node_id = node_id
        self.key = key
        self.spec = spec
        self.k = display(spec, factor)[0]
        self.dspec = display_spec(spec, factor)
        self.setFixedWidth(310)
        box = QWidget()
        lay = QVBoxLayout(box)
        lay.setContentsMargins(12, 2, 12, 2)
        self.osc_editor = OscEditor()
        lay.addWidget(self.osc_editor)
        self.body.addWidget(box)
        self.osc_editor.editStarted.connect(lambda: editor.begin(f"Oscillateur : {spec.label}"))
        self.osc_editor.oscChanged.connect(self._changed)
        self.osc_editor.editFinished.connect(self._finished)
        self.osc_editor.removeRequested.connect(self._remove)
        editor.restored.connect(self.reload)
        self.reload()

    def node(self):
        return self.editor.find(self.node_id)

    def reload(self):
        """Montre l'oscillateur du document (ou ferme le panneau s'il a disparu)."""
        if not isValid(self):
            return
        node = self.node()
        osc = node.osc.get(self.key) if node is not None else None
        if osc is None:
            self.close()
            return
        self.osc_editor.set_osc(scaled_osc(osc, self.k), self.dspec, self.editor.doc.timeline.beats_per_bar)

    def _changed(self, osc):
        node = self.node()
        if node is not None:
            self.editor.set_osc(node, self.key, scaled_osc(osc, 1.0 / self.k))

    def _finished(self):
        if self.editor.gesture_active():
            self.editor.commit()
            self.editor.notify()

    def _remove(self):
        node = self.node()
        if node is not None:
            self.editor.clear_osc(node, self.key)
        self.close()
