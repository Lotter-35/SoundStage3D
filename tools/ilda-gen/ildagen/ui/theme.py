"""Thème sombre : couleurs centralisées et feuille de style. Aucune couleur écrite en dur ailleurs."""

from PySide6.QtGui import QColor, QFont, QFontDatabase, QPalette

BG_APP = "#16171a"
BG_PANEL = "#1d1e22"
BG_MIRE = "#0b0b0d"
BG_FIELD = "#26272c"
BG_HOVER = "#2a2b31"
BORDER = "#2e3036"
TEXT = "#d6d7db"
TEXT_DIM = "#8a8d96"
TEXT_OFF = "#55585f"
ACCENT = "#4a90e2"
DANGER = "#e5484d"
SUCCESS = "#3fb950"
WARNING = "#d29922"

ROW_H = 24
RADIUS = 3


def qc(hex_color, alpha=None):
    c = QColor(hex_color)
    if alpha is not None:
        c.setAlphaF(alpha)
    return c


def accent_soft():
    return qc(ACCENT, 0.20)


def mono_font(px=11):
    f = QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont)
    f.setPixelSize(px)
    return f


def ui_font(px=12, bold=False):
    f = QFont()
    f.setPixelSize(px)
    f.setBold(bold)
    return f


def apply_palette(app):
    pal = QPalette()
    pal.setColor(QPalette.ColorRole.Window, qc(BG_PANEL))
    pal.setColor(QPalette.ColorRole.WindowText, qc(TEXT))
    pal.setColor(QPalette.ColorRole.Base, qc(BG_FIELD))
    pal.setColor(QPalette.ColorRole.AlternateBase, qc(BG_PANEL))
    pal.setColor(QPalette.ColorRole.Text, qc(TEXT))
    pal.setColor(QPalette.ColorRole.Button, qc(BG_FIELD))
    pal.setColor(QPalette.ColorRole.ButtonText, qc(TEXT))
    pal.setColor(QPalette.ColorRole.Highlight, qc(ACCENT))
    pal.setColor(QPalette.ColorRole.HighlightedText, qc("#ffffff"))
    pal.setColor(QPalette.ColorRole.ToolTipBase, qc(BG_FIELD))
    pal.setColor(QPalette.ColorRole.ToolTipText, qc(TEXT))
    pal.setColor(QPalette.ColorRole.PlaceholderText, qc(TEXT_OFF))
    for role in (QPalette.ColorRole.Text, QPalette.ColorRole.WindowText, QPalette.ColorRole.ButtonText):
        pal.setColor(QPalette.ColorGroup.Disabled, role, qc(TEXT_OFF))
    app.setPalette(pal)
    app.setFont(ui_font(12))
    app.setStyleSheet(STYLESHEET)


STYLESHEET = f"""
QMainWindow, QDialog {{ background: {BG_APP}; }}
QWidget {{ color: {TEXT}; font-size: 12px; }}
QToolTip {{ background: {BG_FIELD}; color: {TEXT}; border: 1px solid {BORDER}; padding: 3px 6px; }}

QMenuBar {{ background: {BG_APP}; border-bottom: 1px solid {BORDER}; padding: 1px 4px; }}
QMenuBar::item {{ padding: 4px 9px; background: transparent; border-radius: {RADIUS}px; }}
QMenuBar::item:selected {{ background: {BG_HOVER}; }}
QMenu {{ background: {BG_PANEL}; border: 1px solid {BORDER}; padding: 4px 0; }}
QMenu::item {{ padding: 4px 26px 4px 18px; }}
QMenu::item:selected {{ background: {ACCENT}; color: #ffffff; }}
QMenu::item:disabled {{ color: {TEXT_OFF}; }}
QMenu::separator {{ height: 1px; background: {BORDER}; margin: 4px 0; }}
QMenu::indicator {{ width: 12px; height: 12px; left: 4px; }}

QSplitter::handle {{ background: {BG_APP}; }}
QSplitter::handle:horizontal {{ width: 3px; }}
QSplitter::handle:vertical {{ height: 3px; }}
QSplitter::handle:hover {{ background: {ACCENT}; }}

QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox {{
    background: {BG_FIELD}; border: 1px solid {BORDER}; border-radius: {RADIUS}px;
    padding: 2px 5px; min-height: 18px; selection-background-color: {ACCENT};
}}
QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus {{ border-color: {ACCENT}; }}
QLineEdit:disabled, QSpinBox:disabled, QDoubleSpinBox:disabled, QComboBox:disabled {{ color: {TEXT_OFF}; }}
QSpinBox::up-button, QSpinBox::down-button, QDoubleSpinBox::up-button, QDoubleSpinBox::down-button {{ width: 0; border: none; }}
QComboBox::drop-down {{ border: none; width: 16px; }}
QComboBox QAbstractItemView {{ background: {BG_PANEL}; border: 1px solid {BORDER};
    selection-background-color: {ACCENT}; outline: 0; }}

QPushButton {{ background: {BG_FIELD}; border: 1px solid {BORDER}; border-radius: {RADIUS}px; padding: 3px 10px; }}
QPushButton:hover {{ background: {BG_HOVER}; }}
QPushButton:pressed {{ background: {BORDER}; }}
QPushButton:checked {{ background: {ACCENT}; border-color: {ACCENT}; color: #ffffff; }}
QPushButton:disabled {{ color: {TEXT_OFF}; }}
QPushButton#danger {{ background: transparent; border: 1px solid {DANGER}; color: {DANGER}; font-weight: 600; }}
QPushButton#danger:hover {{ background: {DANGER}; color: #ffffff; }}
QPushButton#danger:checked {{ background: {DANGER}; color: #ffffff; }}
QPushButton#live:checked {{ background: {DANGER}; border-color: {DANGER}; color: #ffffff; }}

QToolButton {{ background: transparent; border: 1px solid transparent; border-radius: {RADIUS}px; padding: 3px; }}
QToolButton:hover {{ background: {BG_HOVER}; }}
QToolButton:checked {{ background: {BG_FIELD}; border-color: {BORDER}; }}
QToolButton:disabled {{ color: {TEXT_OFF}; }}

QCheckBox {{ spacing: 6px; }}
QCheckBox::indicator {{ width: 13px; height: 13px; border: 1px solid {BORDER}; border-radius: 2px; background: {BG_FIELD}; }}
QCheckBox::indicator:checked {{ background: {ACCENT}; border-color: {ACCENT}; }}

QScrollBar:vertical {{ background: transparent; width: 9px; margin: 0; }}
QScrollBar:horizontal {{ background: transparent; height: 9px; margin: 0; }}
QScrollBar::handle {{ background: {BORDER}; border-radius: 3px; min-height: 24px; min-width: 24px; }}
QScrollBar::handle:hover {{ background: {TEXT_OFF}; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}

QTreeView, QListView, QListWidget {{ background: {BG_PANEL}; border: none; outline: 0; show-decoration-selected: 0; }}
QTreeView::branch:selected {{ background: transparent; }}
QTreeView::item, QListWidget::item {{ height: {ROW_H}px; }}

QTabWidget::pane {{ border: 1px solid {BORDER}; top: -1px; }}
QTabBar::tab {{ background: transparent; padding: 5px 12px; color: {TEXT_DIM}; border-bottom: 2px solid transparent; }}
QTabBar::tab:selected {{ color: {TEXT}; border-bottom-color: {ACCENT}; }}

QStatusBar {{ background: {BG_APP}; color: {TEXT_DIM}; border-top: 1px solid {BORDER}; }}
QStatusBar::item {{ border: none; }}
QGroupBox {{ border: 1px solid {BORDER}; border-radius: {RADIUS}px; margin-top: 10px; padding-top: 6px; }}
QGroupBox::title {{ subcontrol-origin: margin; left: 8px; color: {TEXT_DIM}; }}
QProgressBar {{ background: {BG_FIELD}; border: 1px solid {BORDER}; border-radius: {RADIUS}px; text-align: center; }}
QProgressBar::chunk {{ background: {ACCENT}; }}

QLabel#sectionTitle {{ color: {TEXT_DIM}; font-size: 10px; font-weight: 600; letter-spacing: 1px; }}
QLabel#dim {{ color: {TEXT_DIM}; }}
QWidget#panelHeader {{ background: {BG_PANEL}; border-bottom: 1px solid {BORDER}; }}
QWidget#bar {{ background: {BG_APP}; border-bottom: 1px solid {BORDER}; }}
"""
