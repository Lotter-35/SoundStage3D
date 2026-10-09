"""Fenêtre principale : assemble les panneaux (tout est redimensionnable)."""

import os

from PySide6.QtCore import QByteArray, Qt, QTimer
from PySide6.QtWidgets import QApplication, QMainWindow, QMessageBox, QStackedWidget, QStatusBar

from ..core.document import WORKSPACES
from ..editor.live_output import LiveOutput
from ..editor.playback import Playback
from ..editor.state import EditorState
from ..editor.waveform import WaveformLoader
from .actions import build_actions, build_menus
from .context_menu import build_layer_menu
from .dialogs import ExportDialog, SettingsDialog
from .forme import FormeWorkspace
from .live import LiveWorkspace
from .project import ProjectController
from .shell import TopBar
from .show import ShowWorkspace

APP_NAME = "ILDA Gen"


class MainWindow(QMainWindow):
    """Barre du haut (menus, onglets Forme / Show / Live, connexion, Live, BLACKOUT, Maîtres) au-dessus de la
    pile des trois espaces de travail ; chaque espace garde sa propre disposition."""

    def __init__(self, settings):
        super().__init__()
        self.settings = settings
        self.editor = EditorState(settings)
        self.live = LiveOutput(self.editor)
        self.playback = Playback(self.editor)
        self.live.attach_playback(self.playback)
        self.waveform = WaveformLoader()
        self.resize(1440, 900)
        self.setMinimumSize(1000, 640)

        self.top = TopBar(self.editor, self.live)
        self.connection = self.top           # réglages réseau, boutons Live et BLACKOUT
        self.setMenuWidget(self.top)

        self.forme = FormeWorkspace(self)
        self.show_space = ShowWorkspace(self)
        self.live_space = LiveWorkspace(self)
        self.spaces = {"forme": self.forme, "show": self.show_space, "live": self.live_space}
        self.stack = QStackedWidget()
        for ws in WORKSPACES:
            self.stack.addWidget(self.spaces[ws])
        self.setCentralWidget(self.stack)
        # Raccourcis vers les panneaux (menus, tests)
        self.tools, self.canvas = self.forme.tools, self.forme.canvas
        self.layers, self.properties = self.forme.layers, self.forme.properties
        self.timeline = self.show_space.timeline
        self.project = ProjectController(self, self.editor, self.playback, self.waveform)

        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.editor.statusMessage.connect(lambda msg: self.status.showMessage(msg, 5000))

        self.actions_ = build_actions(self)
        build_menus(self, self.actions_)
        builder = lambda parent: build_layer_menu(parent, self.editor, self.actions_)  # noqa: E731
        self.canvas.view.context_menu_builder = builder
        self.layers.tree.context_menu_builder = builder

        self.editor.workspaceChanged.connect(self._workspace)
        self.editor.projectChanged.connect(self.update_title)
        self.editor.historyChanged.connect(self.update_title)
        self.editor.historyChanged.connect(self._history_actions)
        self.editor.gridChanged.connect(self._grid_actions)
        self.editor.projectChanged.connect(self._recent_menu)
        self.editor.gestureChanged.connect(self.actions_["cancel_gesture"].setEnabled)
        # L'application perd la main pendant un geste (autre application au premier plan) : il est annulé
        QApplication.instance().applicationStateChanged.connect(self._app_state)
        self.update_title()
        self._history_actions()
        self._grid_actions()
        self._recent_menu()
        self._workspace(self.editor.workspace)
        self.restore_layout()
        QTimer.singleShot(0, self.canvas.view.setFocus)

    def _workspace(self, ws):
        self.cancel_gesture()             # changer d'espace pendant un geste : il est annulé
        self.stack.setCurrentWidget(self.spaces[ws])
        for k, w in (("forme", "view_scene"), ("show", "view_tl"), ("live", "view_live")):
            self.actions_[w].setChecked(k == ws)
        if ws == "forme":
            QTimer.singleShot(0, self.canvas.view.setFocus)
        elif ws == "show":
            QTimer.singleShot(0, self.timeline.canvas.setFocus)

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

    # ── Gestes ───────────────────────────────────────────────────────────
    def cancel_gesture(self):
        """Échap pendant un geste : la mire, la timeline ou un réglage revient à l'état d'avant le geste."""
        if self.canvas.view.cancel_gesture() or self.editor.cancel_gesture():
            self.editor.statusMessage.emit("Geste annulé")

    def _app_state(self, state):
        if state != Qt.ApplicationState.ApplicationActive and QApplication.activeModalWidget() is None:
            self.cancel_gesture()

    # ── Actions ──────────────────────────────────────────────────────────
    def delete_pressed(self):
        w = QApplication.focusWidget()
        if self.editor.workspace == "show":
            self.timeline.canvas.delete_selection()
        elif self.editor.workspace == "live":
            return
        elif w is self.tools.defs:
            self.tools.defs.delete_current()
        else:
            self.editor.delete_selected()

    # Copier / couper / coller : les clips dans Show, les calques dans Forme
    def _timeline_focused(self):
        return self.editor.workspace == "show"

    def copy_pressed(self):
        if self._timeline_focused():
            self.timeline.canvas.copy_clips()
        elif self.editor.workspace == "forme":
            self.editor.copy_selection()

    def cut_pressed(self):
        if self._timeline_focused():
            self.timeline.canvas.cut_clips()
        elif self.editor.workspace == "forme":
            self.editor.cut_selection()

    def paste_pressed(self):
        if self._timeline_focused():
            self.timeline.canvas.paste_clips()
        elif self.editor.workspace == "forme":
            self.editor.paste()

    def duplicate_pressed(self):
        if self._timeline_focused():
            self.timeline.canvas.duplicate_clips()
        elif self.editor.workspace == "forme":
            self.editor.duplicate_selection()

    def select_all_pressed(self):
        if self._timeline_focused():
            self.timeline.canvas.select_all_clips()
        elif self.editor.workspace == "forme":
            self.editor.select_all()

    def export_ilda(self):
        ExportDialog(self.editor, self).exec()

    def open_settings(self):
        SettingsDialog(self.editor, self.live, self).exec()
        self.live.apply_fps()

    def about(self):
        QMessageBox.about(self, APP_NAME, f"<b>{APP_NAME}</b><br>Générateur ILDA pour SoundStage3D.<br>"
                                          "Icônes : Lucide (licence ISC).")

    # ── Disposition des panneaux (une par espace) ─────────────────────────
    def restore_layout(self):
        ui = self.settings.section("ui")
        try:
            if ui.get("geometry"):
                self.restoreGeometry(QByteArray.fromBase64(ui["geometry"].encode()))
        except (TypeError, ValueError):
            pass
        spaces = ui.get("spaces")
        if isinstance(spaces, dict):
            for ws, w in self.spaces.items():
                w.restore_layout(spaces.get(ws))

    def save_layout(self):
        ui = self.settings.section("ui")
        ui["geometry"] = bytes(self.saveGeometry().toBase64()).decode()
        ui["spaces"] = {ws: w.save_layout() for ws, w in self.spaces.items()}

    def reset_layout(self):
        """Affichage → Réinitialiser la disposition : chaque espace reprend ses tailles d'origine."""
        self.settings.section("ui").pop("spaces", None)
        self.forme.split.setSizes([200, 900, 340])
        self.forme.right_split.setSizes([360, 460])
        self.show_space.v_split.setSizes([320, 520])
        self.show_space.split.setSizes([1100, 340])
        self.live_space.reset_layout()
        self.editor.statusMessage.emit("Disposition réinitialisée")

    def closeEvent(self, e):
        self.cancel_gesture()       # quitter pendant un geste : il est annulé (jamais enregistré à moitié)
        if self.project.auto_on():
            # Sauvegarde automatique : rien à demander, le projet sera rouvert au prochain lancement
            self.project.timer.stop()
            self.project.autosave()
        elif not self.project.maybe_save():
            e.ignore()
            return
        self.playback.pause()
        # Le live reprendra au prochain lancement s'il était actif à la fermeture
        self.settings.set("general", "live_last", bool(self.live.live))
        self.live.shutdown()
        self.save_layout()
        self.settings.save()
        e.accept()
