"""Fenêtre principale : assemble les panneaux (tout est redimensionnable)."""

import os

from PySide6.QtCore import QByteArray, Qt, QTimer
from PySide6.QtWidgets import QApplication, QMainWindow, QMessageBox, QSplitter, QStatusBar, QVBoxLayout, QWidget

from ..editor.live_output import LiveOutput
from ..editor.playback import Playback
from ..editor.state import EditorState
from ..editor.waveform import WaveformLoader
from .actions import build_actions, build_menus
from .canvas import CanvasArea
from .connection_bar import ConnectionBar
from .context_menu import build_layer_menu
from .dialogs import ExportDialog, SettingsDialog
from .layers import LayersPanel
from .project import ProjectController
from .properties import PropertiesPanel
from .timeline import TimelinePanel
from .tool_panel import ToolPanel

APP_NAME = "ILDA Gen"


class MainWindow(QMainWindow):
    def __init__(self, settings):
        super().__init__()
        self.settings = settings
        self.editor = EditorState(settings)
        self.live = LiveOutput(self.editor)
        self.playback = Playback(self.editor)
        self.waveform = WaveformLoader()
        self.resize(1440, 900)
        self.setMinimumSize(900, 600)

        # Panneaux
        self.connection = ConnectionBar(self.editor, self.live)
        self.tools = ToolPanel(self.editor)
        self.canvas = CanvasArea(self.editor, self.live)
        self.layers = LayersPanel(self.editor)
        self.properties = PropertiesPanel(self.editor)
        self.timeline = TimelinePanel(self.editor, self.playback)
        self.project = ProjectController(self, self.editor, self.playback, self.waveform)

        self.right_split = QSplitter(Qt.Orientation.Vertical)
        self.right_split.addWidget(self.layers)
        self.right_split.addWidget(self.properties)
        self.right_split.setStretchFactor(0, 3)
        self.right_split.setStretchFactor(1, 2)
        self.right_split.setChildrenCollapsible(False)
        self.properties.collapsedChanged.connect(self._properties_collapsed)

        self.h_split = QSplitter(Qt.Orientation.Horizontal)
        self.h_split.addWidget(self.tools)
        self.h_split.addWidget(self.canvas)
        self.h_split.addWidget(self.right_split)
        self.h_split.setStretchFactor(0, 0)
        self.h_split.setStretchFactor(1, 1)
        self.h_split.setStretchFactor(2, 0)
        self.h_split.setCollapsible(1, False)
        self.h_split.setSizes([180, 880, 320])

        top = QWidget()
        tl = QVBoxLayout(top)
        tl.setContentsMargins(0, 0, 0, 0)
        tl.setSpacing(0)
        tl.addWidget(self.connection)
        tl.addWidget(self.h_split, 1)

        self.v_split = QSplitter(Qt.Orientation.Vertical)
        self.v_split.addWidget(top)
        self.v_split.addWidget(self.timeline)
        self.v_split.setStretchFactor(0, 3)
        self.v_split.setStretchFactor(1, 1)
        self.v_split.setCollapsible(0, False)
        self.v_split.setSizes([620, 260])
        self.setCentralWidget(self.v_split)

        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.editor.statusMessage.connect(lambda msg: self.status.showMessage(msg, 5000))

        self.actions_ = build_actions(self)
        build_menus(self, self.actions_)
        builder = lambda parent: build_layer_menu(parent, self.editor, self.actions_)  # noqa: E731
        self.canvas.view.context_menu_builder = builder
        self.layers.tree.context_menu_builder = builder

        self.editor.projectChanged.connect(self.update_title)
        self.editor.historyChanged.connect(self.update_title)
        self.editor.historyChanged.connect(self._history_actions)
        self.editor.gridChanged.connect(self._grid_actions)
        self.editor.projectChanged.connect(self._recent_menu)
        self.update_title()
        self._history_actions()
        self._grid_actions()
        self._recent_menu()
        self.restore_layout()
        QTimer.singleShot(0, self.canvas.view.setFocus)

    # ── Titre, menus dynamiques ──────────────────────────────────────────
    def update_title(self):
        name = os.path.basename(self.editor.doc.path) if self.editor.doc.path else "Sans titre"
        self.setWindowTitle(f"{'• ' if self.editor.dirty else ''}{name} — {APP_NAME}")

    def _history_actions(self):
        h = self.editor.history
        self.actions_["undo"].setText(f"Annuler {h.undo_label()}".strip())
        self.actions_["redo"].setText(f"Rétablir {h.redo_label()}".strip())

    def _grid_actions(self):
        self.actions_[f"grid{self.editor.doc.grid.mode}"].setChecked(True)
        self.actions_["snap"].setChecked(self.editor.doc.grid.snap)
        self.actions_["symmetry"].setChecked(bool(self.editor.doc.grid.sym))

    def _recent_menu(self):
        m = self.recent_menu
        m.clear()
        recent = [p for p in self.settings.get("ui", "recent") if os.path.exists(p)]
        for p in recent:
            m.addAction(os.path.basename(p), lambda path=p: self.project.open(path))
        m.setEnabled(bool(recent))

    def _properties_collapsed(self, collapsed):
        if collapsed:
            total = sum(self.right_split.sizes())
            self.right_split.setSizes([total - self.properties.header.height(), self.properties.header.height()])

    # ── Actions ──────────────────────────────────────────────────────────
    def delete_pressed(self):
        w = QApplication.focusWidget()
        if w is self.timeline.canvas:
            self.timeline.canvas.delete_selection()
        elif w is self.tools.defs:
            self.tools.defs.delete_current()
        else:
            self.editor.delete_selected()

    # Copier / couper / coller : la timeline (clips) si elle a le focus, sinon les calques
    def _timeline_focused(self):
        return QApplication.focusWidget() is self.timeline.canvas

    def copy_pressed(self):
        if not (self._timeline_focused() and self.timeline.canvas.copy_clips()):
            self.editor.copy_selection()

    def cut_pressed(self):
        if not (self._timeline_focused() and self.timeline.canvas.cut_clips()):
            self.editor.cut_selection()

    def paste_pressed(self):
        if not (self._timeline_focused() and self.timeline.canvas.paste_clips()):
            self.editor.paste()

    def duplicate_pressed(self):
        if not (self._timeline_focused() and self.timeline.canvas.duplicate_clips()):
            self.editor.duplicate_selection()

    def select_all_pressed(self):
        if self._timeline_focused():
            self.timeline.canvas.select_all_clips()
        else:
            self.editor.select_all()

    def export_ilda(self):
        ExportDialog(self.editor, self).exec()

    def open_settings(self):
        SettingsDialog(self.editor, self.live, self).exec()
        self.live.apply_fps()

    def about(self):
        QMessageBox.about(self, APP_NAME, f"<b>{APP_NAME}</b><br>Générateur ILDA pour SoundStage3D.<br>"
                                          "Icônes : Lucide (licence ISC).")

    # ── Disposition des panneaux ─────────────────────────────────────────
    def restore_layout(self):
        ui = self.settings.section("ui")
        try:
            if ui.get("geometry"):
                self.restoreGeometry(QByteArray.fromBase64(ui["geometry"].encode()))
            for key, split in (("h_split", self.h_split), ("v_split", self.v_split), ("r_split", self.right_split)):
                if ui.get(key):
                    split.restoreState(QByteArray.fromBase64(ui[key].encode()))
        except (TypeError, ValueError):
            pass

    def save_layout(self):
        ui = self.settings.section("ui")
        ui["geometry"] = bytes(self.saveGeometry().toBase64()).decode()
        ui["h_split"] = bytes(self.h_split.saveState().toBase64()).decode()
        ui["v_split"] = bytes(self.v_split.saveState().toBase64()).decode()
        ui["r_split"] = bytes(self.right_split.saveState().toBase64()).decode()

    def closeEvent(self, e):
        if self.project.auto_on():
            # Sauvegarde automatique : rien à demander, le projet sera rouvert au prochain lancement
            self.project.timer.stop()
            self.project.autosave()
        elif not self.project.maybe_save():
            e.ignore()
            return
        self.playback.pause()
        self.live.shutdown()
        self.save_layout()
        self.settings.save()
        e.accept()
