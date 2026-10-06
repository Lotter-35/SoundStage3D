"""Point d'entrée de l'application."""

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
    if len(argv) > 1 and argv[1].endswith(".ildaproj"):
        win.project.open(argv[1])
    else:
        win.project.restore_session()
    if settings.get("general", "live_at_start"):
        win.connection.btn_live.setChecked(True)
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
