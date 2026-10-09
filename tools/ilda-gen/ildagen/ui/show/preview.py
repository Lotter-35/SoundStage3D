"""Aperçu de la timeline à la tête de lecture (non modifiable), maîtres compris."""

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QHBoxLayout, QLabel, QVBoxLayout, QWidget

from ...core.masters import apply_masters
from ..widgets import LaserView


class ShowPreview(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        lay = QVBoxLayout(self)
        lay.setContentsMargins(8, 4, 8, 8)
        lay.setSpacing(4)
        head = QHBoxLayout()
        title = QLabel("Aperçu")
        title.setObjectName("dim")
        head.addWidget(title)
        head.addStretch(1)
        lay.addLayout(head)
        self.view = LaserView(margin=4)
        lay.addWidget(self.view, 1)
        self.timer = QTimer(self)
        self.timer.setInterval(33)
        self.timer.timeout.connect(self.refresh)
        for sig in (editor.docChanged, editor.playheadChanged, editor.mastersChanged, editor.workspaceChanged):
            sig.connect(lambda *_: self.refresh())

    def refresh(self):
        ed = self.editor
        if not self.isVisible() or ed.workspace != "show":
            self.timer.stop()
            return
        self.view.set_strokes(apply_masters(ed.display_strokes(), ed.doc.masters))
        if ed.is_animated():
            if not self.timer.isActive():
                self.timer.start()
        else:
            self.timer.stop()

    def showEvent(self, e):
        super().showEvent(e)
        self.refresh()
