"""Gestion du projet : nouveau, ouvrir, enregistrer, musique, sauvegarde automatique.

Un projet illisible n'empêche jamais l'application de démarrer : un message dit pourquoi et l'on garde un
projet vide. La sauvegarde automatique d'un projet sans nom n'est jamais écrasée par un autre travail sans
en garder une copie datée (Fichier → Récupérer une sauvegarde automatique…).
"""

import json
import logging
import os

from PySide6.QtCore import QObject, QTimer
from PySide6.QtWidgets import QFileDialog, QMessageBox

from ..core import autosave as AS
from ..core.document import FORMAT_VERSION, PROJECT_EXT, Document
from ..core.settings import DEFAULTS, config_dir, valid_value

FILTER = f"Projets ILDA Gen (*{PROJECT_EXT})"
AUDIO_FILTER = "Musique (*.mp3 *.wav *.flac *.ogg *.m4a *.aac *.aiff);;Tous les fichiers (*)"

log = logging.getLogger(__name__)


def load_error(e):
    """Raison d'un échec de lecture, en français."""
    if isinstance(e, json.JSONDecodeError):
        return f"Le fichier est abîmé (texte JSON illisible, ligne {e.lineno})."
    if isinstance(e, UnicodeDecodeError):
        return "Ce n'est pas un fichier de projet (contenu illisible)."
    if isinstance(e, OSError):
        return f"Lecture impossible : {e.strerror or e}."
    if isinstance(e, ValueError) and str(e):
        return f"Contenu invalide : {e}."
    return f"Contenu inattendu ({type(e).__name__} : {e})."


class ProjectController(QObject):
    def __init__(self, window, editor, playback, waveform):
        super().__init__(window)
        self.window = window
        self.editor = editor
        self.playback = playback
        self.waveform = waveform
        self.autosave_path = os.path.join(config_dir(), "autosave" + PROJECT_EXT)
        self.backup_dir = AS.backup_dir(config_dir())
        self._autosave_owner = None    # session de l'éditeur dont le travail est dans la sauvegarde automatique
        self._no_autosave = False      # projet d'une version plus récente : jamais écrasé automatiquement
        self.last_notice = ""          # message du dernier projet ouvert (ancien format : animations retirées)
        # Sauvegarde à chaque modification (regroupée : 0,4 s après la dernière)
        self.timer = QTimer(self)
        self.timer.setSingleShot(True)
        self.timer.setInterval(400)
        self.timer.timeout.connect(self.autosave)
        editor.historyChanged.connect(self.schedule)
        editor.gridChanged.connect(self.schedule)
        editor.viewChanged.connect(self.schedule)
        waveform.loaded.connect(self._wave_loaded)
        editor.audioChanged.connect(self._load_audio)
        waveform.failed.connect(lambda msg: editor.statusMessage.emit(f"Forme d'onde : {msg}"))

    # ── Fichiers ─────────────────────────────────────────────────────────
    def maybe_save(self):
        """Avant de quitter le projet : un projet enregistré l'est déjà automatiquement."""
        self.timer.stop()
        self.editor.cancel_gesture()        # Ctrl+N / Ctrl+O pendant un glisser : le geste est annulé
        if self.editor.doc.path and self.auto_on():
            self.autosave()
            return True
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
        self._no_autosave = False
        self._load_audio("")
        self._remember("")

    def open(self, path=None):
        """Ouvre un projet ; renvoie True si c'est fait (un fichier illisible n'est jamais fatal)."""
        if not self.maybe_save():
            return False
        if not path:
            start = os.path.dirname(self.editor.doc.path) if self.editor.doc.path else os.path.expanduser("~")
            path, _ = QFileDialog.getOpenFileName(self.window, "Ouvrir un projet", start, FILTER)
            if not path:
                return False
        doc = self._load(path, "Ouvrir")
        if doc is None:
            return False
        self._apply_network(doc)
        if not self._show(doc):
            return False
        self._no_autosave = doc.version > FORMAT_VERSION
        self._load_audio(doc.timeline.audio_path)
        self.editor.settings.add_recent(path)
        self._remember(path)
        # Ancien projet (v1–v4) : ses animations ont été retirées (D12), on le dit
        notice = doc.load_notice()
        self.last_notice = notice
        self.editor.statusMessage.emit(f"Projet ouvert : {os.path.basename(path)}" + (f" — {notice}" if notice else ""))
        return True

    def _load(self, path, title):
        """Lit un projet ; en cas d'échec, explique pourquoi et renvoie None."""
        try:
            doc = Document.load(path)
        except Exception as e:   # noqa: BLE001 — un fichier abîmé, quel qu'il soit, ne doit rien faire planter
            log.warning("Projet illisible : %s (%s : %s)", path, type(e).__name__, e)
            QMessageBox.critical(self.window, title, f"Impossible d'ouvrir « {os.path.basename(path)} ».\n\n"
                                                     f"{load_error(e)}")
            return None
        if doc.version > FORMAT_VERSION:
            QMessageBox.warning(self.window, title,
                                f"« {os.path.basename(path)} » a été créé par une version plus récente d'ILDA Gen "
                                f"(format {doc.version}, celle-ci lit le format {FORMAT_VERSION}).\n\n"
                                "Il est ouvert, mais ce que cette version ne connaît pas peut manquer. "
                                "Il ne sera pas enregistré automatiquement (Ctrl+S pour l'enregistrer quand même).")
        return doc

    def _show(self, doc):
        """Affiche le projet lu ; s'il est trop abîmé pour s'afficher, on repart d'un projet vide."""
        self.playback.pause()
        try:
            self.editor.set_document(doc)
        except Exception:   # noqa: BLE001
            log.exception("Projet impossible à afficher")
            QMessageBox.critical(self.window, "Ouvrir", "Ce projet est abîmé : un projet vide est ouvert à la place.")
            self.editor.set_document(Document())
            self._load_audio("")
            self._remember("")
            return False
        return True

    def _apply_network(self, doc):
        if doc.network:
            for k, v in doc.network.items():
                if k in DEFAULTS["network"]:
                    self.editor.settings.set("network", k, valid_value("network", k, v))   # valeur du fichier vérifiée
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

    def _write(self, path, quiet=False):
        doc = self.editor.doc
        doc.network = dict(self.editor.settings.section("network"))
        try:
            doc.save(path)
        except OSError as e:
            if not quiet:
                QMessageBox.critical(self.window, "Enregistrer", f"Impossible d'enregistrer :\n{e}")
            else:
                self.editor.statusMessage.emit(f"Sauvegarde automatique impossible : {e}")
            return False
        self.editor.dirty = False
        self.editor.view_dirty = False
        self._no_autosave = False
        if not quiet:
            self.editor.settings.add_recent(path)
            self._remember(path)
            self.editor.statusMessage.emit(f"Projet enregistré : {os.path.basename(path)}")
        self.editor.projectChanged.emit()
        return True

    def _remember(self, path):
        self.editor.settings.set("ui", "last_project", path)
        self.editor.settings.save()

    # ── Démarrage : rouvrir le dernier projet ────────────────────────────
    def restore_session(self):
        """Rouvre le dernier projet (ou le projet sans nom de la dernière session). Ne plante jamais :
        en cas de problème, un message s'affiche et l'on garde un projet vide."""
        try:
            self._restore_session()
        except Exception:   # noqa: BLE001
            log.exception("Réouverture du dernier projet impossible")
            QMessageBox.critical(self.window, "Démarrage", "Le dernier projet n'a pas pu être rouvert : "
                                                           "un projet vide est ouvert à la place.")
            self.editor.set_document(Document())
            self._remember("")

    def _restore_session(self):
        s = self.editor.settings
        if not s.get("general", "reopen_last"):
            return
        last = s.get("ui", "last_project")
        if last and os.path.exists(last):
            if not self.open(last):
                self._remember("")      # pas de nouvel essai (ni de nouveau message) au prochain lancement
        elif os.path.exists(self.autosave_path):
            # Projet sans nom de la session précédente
            if self._open_untitled(self.autosave_path, "Sauvegarde automatique", dirty=False):
                self._autosave_owner = self.editor.session      # on continue ce travail : pas de copie
                self.editor.statusMessage.emit("Projet sans nom de la dernière session rouvert")

    def _open_untitled(self, path, title, dirty=True):
        """Ouvre un fichier comme projet sans nom (sauvegarde automatique ou copie datée)."""
        doc = self._load(path, title)
        if doc is None:
            return False
        doc.path = ""
        if not self._show(doc):
            return False
        self._no_autosave = False
        self.editor.dirty = dirty
        self._load_audio(doc.timeline.audio_path)
        self.editor.projectChanged.emit()
        self.last_notice = doc.load_notice()
        if self.last_notice:
            self.editor.statusMessage.emit(self.last_notice)
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

    # ── Sauvegarde automatique (à chaque modification) ───────────────────
    def auto_on(self):
        return bool(self.editor.settings.get("general", "autosave")) and not self._no_autosave

    def schedule(self):
        if self.auto_on():
            self.timer.start()

    def autosave(self):
        """Projet enregistré : écrit dans son fichier ; projet sans nom : dans la sauvegarde automatique
        (l'ancienne, si elle contient un autre travail, est d'abord copiée dans les sauvegardes datées)."""
        ed = self.editor
        if not (ed.dirty or ed.view_dirty):
            return
        if ed.gesture_active():
            self.timer.start()      # pendant un geste (qui peut encore être annulé) : on attend sa fin
            return
        if ed.doc.path:
            if not self._no_autosave:
                self._write(ed.doc.path, quiet=True)
            return
        try:
            if self._autosave_owner != ed.session and os.path.exists(self.autosave_path):
                AS.rotate(self.autosave_path, self.backup_dir)
            ed.doc.save(self.autosave_path)
        except (OSError, TypeError, ValueError) as e:
            ed.statusMessage.emit(f"Sauvegarde automatique impossible : {e}")
            return
        finally:
            ed.doc.path = ""
        ed.view_dirty = False
        self._autosave_owner = ed.session

    def recover(self):
        """Fichier → Récupérer la sauvegarde automatique : le dernier projet sans nom."""
        if not os.path.exists(self.autosave_path):
            QMessageBox.information(self.window, "Sauvegarde automatique", "Aucune sauvegarde automatique.")
            return
        if not self.maybe_save():
            return
        if self._open_untitled(self.autosave_path, "Sauvegarde automatique"):
            self._autosave_owner = self.editor.session

    def recover_backup(self):
        """Fichier → Récupérer une sauvegarde automatique… : une copie datée d'un ancien projet sans nom."""
        if not self.maybe_save():
            return False
        path, _ = QFileDialog.getOpenFileName(self.window, "Récupérer une sauvegarde automatique", self.backup_dir,
                                              FILTER)
        return bool(path) and self.open_backup(path)

    def open_backup(self, path):
        if not self._open_untitled(path, "Sauvegarde automatique"):
            return False
        self.editor.statusMessage.emit(f"Sauvegarde récupérée ({os.path.basename(path)}) : "
                                       "projet sans nom, à enregistrer sous un nom")
        return True
