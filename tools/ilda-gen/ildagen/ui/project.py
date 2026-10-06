"""Gestion du projet : nouveau, ouvrir, enregistrer, musique, sauvegarde automatique."""

import os

from PySide6.QtCore import QObject, QTimer
from PySide6.QtWidgets import QFileDialog, QMessageBox

from ..core.document import PROJECT_EXT, Document
from ..core.settings import config_dir

FILTER = f"Projets ILDA Gen (*{PROJECT_EXT})"
AUDIO_FILTER = "Musique (*.mp3 *.wav *.flac *.ogg *.m4a *.aac *.aiff);;Tous les fichiers (*)"


class ProjectController(QObject):
    def __init__(self, window, editor, playback, waveform):
        super().__init__(window)
        self.window = window
        self.editor = editor
        self.playback = playback
        self.waveform = waveform
        self.autosave_path = os.path.join(config_dir(), "autosave" + PROJECT_EXT)
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.autosave)
        self.restart_autosave()
        waveform.loaded.connect(self._wave_loaded)
        waveform.failed.connect(lambda msg: editor.statusMessage.emit(f"Forme d'onde : {msg}"))

    # ── Fichiers ─────────────────────────────────────────────────────────
    def maybe_save(self):
        if not self.editor.dirty:
            return True
        r = QMessageBox.question(self.window, "Projet modifié", "Enregistrer les modifications du projet ?",
                                 QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard |
                                 QMessageBox.StandardButton.Cancel)
        if r == QMessageBox.StandardButton.Save:
            return self.save()
        return r == QMessageBox.StandardButton.Discard

    def new(self):
        if not self.maybe_save():
            return
        self.playback.pause()
        self.editor.set_document(Document())
        self._load_audio("")

    def open(self, path=None):
        if not self.maybe_save():
            return
        if not path:
            start = os.path.dirname(self.editor.doc.path) if self.editor.doc.path else os.path.expanduser("~")
            path, _ = QFileDialog.getOpenFileName(self.window, "Ouvrir un projet", start, FILTER)
            if not path:
                return
        try:
            doc = Document.load(path)
        except (OSError, ValueError, KeyError) as e:
            QMessageBox.critical(self.window, "Ouvrir", f"Impossible d'ouvrir ce projet :\n{e}")
            return
        self.playback.pause()
        self._apply_network(doc)
        self.editor.set_document(doc)
        self._load_audio(doc.timeline.audio_path)
        self.editor.settings.add_recent(path)
        self.editor.settings.save()
        self.editor.statusMessage.emit(f"Projet ouvert : {os.path.basename(path)}")

    def _apply_network(self, doc):
        if doc.network:
            for k, v in doc.network.items():
                self.editor.settings.set("network", k, v)
            if hasattr(self.window, "connection"):
                self.window.connection.reload()

    def save(self):
        if not self.editor.doc.path:
            return self.save_as()
        return self._write(self.editor.doc.path)

    def save_as(self):
        start = self.editor.doc.path or os.path.join(os.path.expanduser("~"), "projet" + PROJECT_EXT)
        path, _ = QFileDialog.getSaveFileName(self.window, "Enregistrer le projet", start, FILTER)
        if not path:
            return False
        if not path.endswith(PROJECT_EXT):
            path += PROJECT_EXT
        return self._write(path)

    def _write(self, path):
        doc = self.editor.doc
        doc.network = dict(self.editor.settings.section("network"))
        try:
            doc.save(path)
        except OSError as e:
            QMessageBox.critical(self.window, "Enregistrer", f"Impossible d'enregistrer :\n{e}")
            return False
        self.editor.dirty = False
        self.editor.settings.add_recent(path)
        self.editor.settings.save()
        self.editor.projectChanged.emit()
        self.editor.statusMessage.emit(f"Projet enregistré : {os.path.basename(path)}")
        return True

    # ── Musique ──────────────────────────────────────────────────────────
    def import_music(self):
        path, _ = QFileDialog.getOpenFileName(self.window, "Importer une musique", os.path.expanduser("~"), AUDIO_FILTER)
        if not path:
            return
        tl = self.editor.doc.timeline
        self.editor.timeline_mutate("Importer une musique", lambda: setattr(tl, "audio_path", path))
        self._load_audio(path)

    def _load_audio(self, path):
        self.playback.load_audio(path if path and os.path.exists(path) else "")
        self.window.timeline.canvas.set_peaks(None)
        if path and os.path.exists(path):
            self.waveform.load(path)
            self.editor.statusMessage.emit("Lecture de la forme d'onde…")
        elif path:
            self.editor.statusMessage.emit(f"Musique introuvable : {path}")

    def _wave_loaded(self, peaks, duration):
        self.editor.doc.timeline.audio_duration = duration
        self.window.timeline.canvas.set_peaks(peaks)
        self.editor.timelineChanged.emit()
        self.editor.statusMessage.emit(f"Musique chargée ({int(duration // 60)} min {int(duration % 60):02d} s)")

    # ── Sauvegarde automatique ───────────────────────────────────────────
    def restart_autosave(self):
        minutes = int(self.editor.settings.get("general", "autosave_min"))
        self.timer.stop()
        if minutes > 0:
            self.timer.start(minutes * 60 * 1000)

    def autosave(self):
        if not self.editor.dirty:
            return
        try:
            path = self.editor.doc.path
            self.editor.doc.save(self.autosave_path)
            self.editor.doc.path = path
        except OSError:
            pass

    def recover(self):
        if not os.path.exists(self.autosave_path):
            QMessageBox.information(self.window, "Sauvegarde automatique", "Aucune sauvegarde automatique.")
            return
        if not self.maybe_save():
            return
        try:
            doc = Document.load(self.autosave_path)
        except (OSError, ValueError, KeyError) as e:
            QMessageBox.critical(self.window, "Sauvegarde automatique", str(e))
            return
        doc.path = ""
        self.editor.set_document(doc)
        self.editor.dirty = True
        self._load_audio(doc.timeline.audio_path)
        self.editor.projectChanged.emit()
