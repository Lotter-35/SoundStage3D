"""Point d'entrée de l'application."""

import logging
import sys

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from .core.settings import Settings
from .ui import theme
from .ui.main_window import APP_NAME, MainWindow


def main(argv=None):
    argv = sys.argv if argv is None else argv
    QApplication.setHighDpiScaleFactorRoundingPolicy(Qt.HighDpiScaleFactorRoundingPolicy.PassThrough)
    app = QApplication(argv)
    app.setApplicationName(APP_NAME)
    app.setOrganizationName("IldaGen")
    app.setStyle("Fusion")
    theme.apply_palette(app)
    settings = Settings()
    win = MainWindow(settings)
    win.show()
    try:
        if len(argv) > 1 and argv[1].endswith(".ildaproj"):
            win.project.open(argv[1])
        else:
            win.project.restore_session()
    except Exception:   # noqa: BLE001 — un projet abîmé n'empêche jamais de démarrer (projet vide)
        logging.getLogger(__name__).exception("Ouverture du projet impossible au démarrage")
    if settings.get("general", "live_at_start"):
        win.connection.btn_live.setChecked(True)
    code = app.exec()
    shutdown(win, app)
    return code


def shutdown(win, app):
    """Fermeture propre : on détruit la fenêtre et ses objets Qt AVANT l'application (évite un plantage à la sortie)."""
    import gc
    win.playback.player.stop()
    win.waveform.decoder.stop()
    win.live.frame_timer.stop()
    win.live.ping_timer.stop()
    for obj in (win.live, win.playback, win.waveform, win.editor):
        try:
            obj.blockSignals(True)
        except RuntimeError:
            pass
    # Presse-papiers : des calques copiés y sont détenus par Qt mais créés en Python ; on les retire avant
    # que Python ne s'arrête (sinon Qt les détruit trop tard et l'application plante en quittant)
    from .editor.layer_ops import CLIP_MIME
    cb = app.clipboard()
    md = cb.mimeData()
    if md is not None and md.hasFormat(CLIP_MIME):
        cb.clear()
    win.deleteLater()
    app.processEvents()
    del win
    gc.collect()


if __name__ == "__main__":
    sys.exit(main())
