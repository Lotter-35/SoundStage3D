"""Thèmes de l'interface : jetons de couleur, feuille de style, changement à chaud.

Toutes les couleurs de l'interface viennent d'ici (aucune couleur écrite en dur ailleurs). Les jetons sont des
attributs du module (theme.ACCENT, theme.BG_PANEL…) : le code qui peint les lit **au moment de peindre**
(jamais « from .theme import ACCENT », qui figerait la valeur), car set_theme() les remplace.

Un thème = une base de gris neutres (Graphite, Noir, Ardoise) + un accent franc. Fixes quel que soit le thème :
rouge DANGER (BLACKOUT, suppression), vert LIVE (connecté / envoi live), couleurs de piste (TRACK_COLORS).
Changer de thème : set_theme(id) ; les widgets peints à la main repeignent tout seuls (update de tous les
widgets) et peuvent écouter notifier.changed pour reconstruire ce qu'ils ont mis en cache.
"""

from collections import namedtuple

from PySide6.QtCore import QObject, Signal
from PySide6.QtGui import QColor, QFont, QFontDatabase, QPalette
from PySide6.QtWidgets import QApplication

# ── Bases (gris) ─────────────────────────────────────────────────────────────
# BG_CARD : fond des cartes (modifieurs, effets) ; BG_POPUP : menus, infobulles, panneaux déroulants ;
# BORDER_STRONG : contour d'un bouton enfoncé ou d'un panneau déroulant ; FILL / FILL_ACT : barre des sliders
# au repos / au survol (en cours de réglage : ACCENT).
BASES = {
    "graphite": dict(BG_APP="#141414", BG_PANEL="#1c1c1c", BG_CARD="#202020", BG_FIELD="#262626",
                     BG_HOVER="#2c2c2c", BG_POPUP="#222222", SEL="#383838", BORDER="#2b2b2b",
                     BORDER_STRONG="#4a4a4a", FILL="#3c3c3c", FILL_ACT="#5a5a5a",
                     TEXT="#e4e4e4", TEXT_DIM="#9b9b9b", TEXT_OFF="#5f5f5f"),
    "noir": dict(BG_APP="#0a0a0a", BG_PANEL="#111111", BG_CARD="#151515", BG_FIELD="#1c1c1c",
                 BG_HOVER="#222222", BG_POPUP="#181818", SEL="#2a2a2a", BORDER="#222222",
                 BORDER_STRONG="#3c3c3c", FILL="#303030", FILL_ACT="#4a4a4a",
                 TEXT="#e4e4e4", TEXT_DIM="#9b9b9b", TEXT_OFF="#5f5f5f"),
    # Ardoise : gris chauds
    "ardoise": dict(BG_APP="#171615", BG_PANEL="#1f1e1c", BG_CARD="#232220", BG_FIELD="#2a2826",
                    BG_HOVER="#312f2c", BG_POPUP="#252321", SEL="#3a3734", BORDER="#2e2c29",
                    BORDER_STRONG="#4b4844", FILL="#403d39", FILL_ACT="#5c5853",
                    TEXT="#e6e3de", TEXT_DIM="#9e9993", TEXT_OFF="#625e58"),
}

# ── Couleurs fixes (identiques dans tous les thèmes) ─────────────────────────
FIXED = dict(
    BG_MIRE="#000000",        # mire, vignettes, aperçus laser
    DANGER="#e03b3b",         # BLACKOUT, suppression
    DANGER_DIM="#4a2424",     # contour du BLACKOUT au repos
    LIVE="#22b14c",           # connecté, envoi live
    SUCCESS="#22b14c",        # ancien nom de LIVE
    WARNING="#e8a317",        # image réduite, piste muette
    ON_ACCENT="#111111",      # texte posé sur un fond couleur accent
    WHITE="#ffffff",          # voiles et lignes discrètes (avec transparence)
    BLACK="#000000",
)

# Pistes de la timeline et marqueurs de parties : couleurs franches
TRACK_COLORS = ["#00c853", "#ffd000", "#d500f9", "#ff3d00", "#00e5ff", "#ff4081", "#c6ff00", "#ff9100"]
# Pastilles de couleur laser proposées (cyan, magenta, vert, jaune, rouge, blanc)
LASER_COLORS = ["#20e0ff", "#ff2bd0", "#22ff55", "#ffe600", "#ff2020", "#ffffff"]

# ── Thèmes (Paramètres → Apparence) ──────────────────────────────────────────
Theme = namedtuple("Theme", "label base accent")
THEMES = {
    "graphite-orange": Theme("Graphite · Orange", "graphite", "#ff7a00"),
    "graphite-jaune": Theme("Graphite · Jaune", "graphite", "#ffc800"),
    "graphite-citron": Theme("Graphite · Citron vert", "graphite", "#9bff00"),
    "graphite-framboise": Theme("Graphite · Framboise", "graphite", "#ff2d78"),
    "graphite-magenta": Theme("Graphite · Magenta", "graphite", "#ff2bd6"),
    "noir-violet": Theme("Noir · Violet", "noir", "#c04dff"),
    "noir-ambre": Theme("Noir · Ambre", "noir", "#ffb000"),
    "noir-menthe": Theme("Noir · Menthe", "noir", "#00e5a8"),
    "ardoise-corail": Theme("Ardoise · Corail", "ardoise", "#ff6b4a"),
    "monochrome": Theme("Monochrome", "graphite", "#e8e8e8"),
}
DEFAULT_THEME = "graphite-orange"

ROW_H = 24
RADIUS = 3


def resolve(name):
    """Identifiant d'un thème à partir de son identifiant ou de son libellé ; thème par défaut si inconnu."""
    if name in THEMES:
        return name
    for tid, t in THEMES.items():
        if t.label == name:
            return tid
    return DEFAULT_THEME


def tokens(name=None):
    """Tous les jetons de couleur d'un thème (dictionnaire nom → « #rrggbb »), sans l'appliquer."""
    t = THEMES[resolve(name or CURRENT)]
    out = dict(BASES[t.base])
    out.update(FIXED)
    out["ACCENT"] = t.accent
    return out


def label(name):
    return THEMES[resolve(name)].label


# Jetons du thème courant, attributs du module (theme.ACCENT…) : remplis ici, remplacés par set_theme()
BG_APP = BG_PANEL = BG_CARD = BG_FIELD = BG_HOVER = BG_POPUP = SEL = BORDER = BORDER_STRONG = ""
FILL = FILL_ACT = TEXT = TEXT_DIM = TEXT_OFF = ACCENT = ""
BG_MIRE = DANGER = DANGER_DIM = LIVE = SUCCESS = WARNING = ON_ACCENT = WHITE = BLACK = ""
CURRENT = DEFAULT_THEME
globals().update(tokens(DEFAULT_THEME))


class _Notifier(QObject):
    changed = Signal(str)     # identifiant du nouveau thème


notifier = _Notifier()


def qc(hex_color, alpha=None):
    c = QColor(hex_color)
    if alpha is not None:
        c.setAlphaF(alpha)
    return c


def accent_soft():
    """Fond d'une ligne sélectionnée (ancien nom : la DA n'utilise plus de fond teinté par l'accent)."""
    return qc(SEL)


def mono_font(px=11):
    f = QFontDatabase.systemFont(QFontDatabase.SystemFont.FixedFont)
    f.setPixelSize(px)
    return f


def ui_font(px=12, bold=False):
    f = QFont()
    f.setPixelSize(px)
    f.setBold(bold)
    return f


def set_theme(name, app=None):
    """Applique un thème à chaud : jetons, palette, feuille de style ; tous les widgets repeignent.
    Renvoie l'identifiant appliqué (thème par défaut si le nom est inconnu)."""
    global CURRENT, STYLESHEET
    tid = resolve(name)
    globals().update(tokens(tid))
    CURRENT = tid
    STYLESHEET = build_stylesheet()
    app = app or QApplication.instance()
    if app is not None:
        apply_palette(app)
        for w in app.allWidgets():
            w.update()
    notifier.changed.emit(tid)
    return tid


def apply_palette(app):
    """Palette, police et feuille de style du thème courant."""
    g = globals()
    pal = QPalette()
    R = QPalette.ColorRole
    for role, tok in ((R.Window, "BG_PANEL"), (R.WindowText, "TEXT"), (R.Base, "BG_FIELD"),
                      (R.AlternateBase, "BG_PANEL"), (R.Text, "TEXT"), (R.Button, "BG_FIELD"),
                      (R.ButtonText, "TEXT"), (R.Highlight, "SEL"), (R.HighlightedText, "TEXT"),
                      (R.ToolTipBase, "BG_POPUP"), (R.ToolTipText, "TEXT"), (R.PlaceholderText, "TEXT_OFF"),
                      (R.Link, "ACCENT"), (R.BrightText, "WHITE"), (R.Light, "BORDER_STRONG"),
                      (R.Midlight, "SEL"), (R.Mid, "BORDER"), (R.Dark, "BG_APP"), (R.Shadow, "BLACK")):
        pal.setColor(role, qc(g[tok]))
    for role in (R.Text, R.WindowText, R.ButtonText):
        pal.setColor(QPalette.ColorGroup.Disabled, role, qc(g["TEXT_OFF"]))
    app.setPalette(pal)
    app.setFont(ui_font(12))
    app.setStyleSheet(build_stylesheet())


def build_stylesheet():
    """Feuille de style de l'application pour le thème courant (coins de 3 px au plus, aucun dégradé)."""
    return _QSS.format(R=RADIUS, H=ROW_H, **tokens(CURRENT))


_QSS = """
QMainWindow, QDialog {{ background: {BG_APP}; }}
QWidget {{ color: {TEXT}; font-size: 12px; }}
QToolTip {{ background: {BG_POPUP}; color: {TEXT}; border: 1px solid {BORDER_STRONG}; padding: 3px 6px; }}

QMenuBar {{ background: {BG_PANEL}; border-bottom: 1px solid {BORDER}; padding: 1px 4px; }}
QMenuBar::item {{ padding: 4px 9px; background: transparent; border-radius: {R}px; }}
QMenuBar::item:selected {{ background: {BG_HOVER}; }}
QMenuBar::item:pressed {{ background: {SEL}; }}
QWidget#topbar {{ background: {BG_PANEL}; border-bottom: 1px solid {BORDER}; }}
QWidget#topbar QMenuBar {{ background: transparent; border: none; padding: 0; }}
QMenu {{ background: {BG_POPUP}; border: 1px solid {BORDER_STRONG}; padding: 4px 0; }}
QMenu::item {{ padding: 4px 26px 4px 18px; }}
QMenu::item:selected {{ background: {SEL}; color: {TEXT}; }}
QMenu::item:disabled {{ color: {TEXT_OFF}; }}
QMenu::separator {{ height: 1px; background: {BORDER}; margin: 4px 0; }}
QMenu::indicator {{ width: 12px; height: 12px; left: 4px; }}

QSplitter::handle {{ background: {BG_APP}; }}
QSplitter::handle:horizontal {{ width: 3px; }}
QSplitter::handle:vertical {{ height: 3px; }}
QSplitter::handle:hover {{ background: {BORDER_STRONG}; }}

QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox {{
    background: {BG_FIELD}; border: 1px solid {BORDER}; border-radius: {R}px; padding: 2px 5px; min-height: 18px;
    selection-background-color: {ACCENT}; selection-color: {ON_ACCENT};
}}
QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus {{ border-color: {ACCENT}; }}
QLineEdit:disabled, QSpinBox:disabled, QDoubleSpinBox:disabled, QComboBox:disabled {{ color: {TEXT_OFF}; }}
QSpinBox::up-button, QSpinBox::down-button, QDoubleSpinBox::up-button, QDoubleSpinBox::down-button {{
    width: 0; border: none; }}
QComboBox::drop-down {{ border: none; width: 16px; }}
QComboBox QAbstractItemView {{ background: {BG_POPUP}; border: 1px solid {BORDER_STRONG};
    selection-background-color: {SEL}; selection-color: {TEXT}; outline: 0; }}

QPushButton {{ background: {BG_FIELD}; border: 1px solid {BORDER}; border-radius: {R}px; padding: 3px 10px; }}
QPushButton:hover {{ background: {BG_HOVER}; }}
QPushButton:pressed {{ background: {SEL}; }}
QPushButton:checked {{ background: {SEL}; border-color: {BORDER_STRONG}; border-bottom: 2px solid {ACCENT};
    padding-bottom: 2px; }}
QPushButton:disabled {{ color: {TEXT_OFF}; }}

QPushButton[tb="normal"], QPushButton[tb="plain"], QPushButton[tb="danger"], QPushButton[tb="live"] {{
    padding: 0 10px; font-weight: 500; }}
QPushButton[tb="plain"] {{ background: transparent; border-color: transparent; color: {TEXT_DIM}; font-weight: 400; }}
QPushButton[tb="plain"]:hover {{ color: {TEXT}; }}
QPushButton[tb="danger"] {{ color: {DANGER}; border-color: {DANGER_DIM}; font-weight: 700; }}
QPushButton[tb="danger"]:hover {{ border-color: {DANGER}; }}
QPushButton[tb="danger"]:checked {{ background: {DANGER}; border: 1px solid {DANGER}; color: {WHITE};
    padding: 0 10px; }}
QPushButton[tb="live"]:checked, QPushButton[tb="normal"]:checked {{ background: {SEL};
    border: 1px solid {BORDER_STRONG}; padding: 0 10px; }}
QPushButton[tb="normal"]:disabled, QPushButton[tb="danger"]:disabled, QPushButton[tb="live"]:disabled {{
    color: {TEXT_OFF}; border-color: {BORDER}; }}

QToolButton {{ background: transparent; border: 1px solid transparent; border-radius: {R}px; padding: 3px; }}
QToolButton:hover {{ background: {BG_HOVER}; }}
QToolButton:pressed {{ background: {SEL}; }}
QToolButton:checked {{ background: {SEL}; border-color: transparent; }}
QToolButton:disabled {{ color: {TEXT_OFF}; }}

QCheckBox {{ spacing: 6px; }}

QScrollBar:vertical {{ background: transparent; width: 9px; margin: 0; }}
QScrollBar:horizontal {{ background: transparent; height: 9px; margin: 0; }}
QScrollBar::handle {{ background: {SEL}; border-radius: {R}px; min-height: 24px; min-width: 24px; }}
QScrollBar::handle:hover {{ background: {TEXT_OFF}; }}
QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}
QScrollArea {{ background: transparent; }}

QTreeView, QListView, QListWidget {{ background: {BG_PANEL}; border: none; outline: 0; show-decoration-selected: 0; }}
QTreeView::branch:selected {{ background: transparent; }}
QTreeView::item, QListWidget::item {{ height: {H}px; }}
QListView::item:selected, QListWidget::item:selected {{ background: {SEL}; color: {TEXT}; }}
QListView::item:hover:!selected, QListWidget::item:hover:!selected {{ background: {BG_HOVER}; }}

QTabWidget::pane {{ border: 1px solid {BORDER}; top: -1px; }}
QTabBar::tab {{ background: transparent; padding: 5px 12px; color: {TEXT_DIM}; border-bottom: 2px solid transparent;
    border-top-left-radius: {R}px; border-top-right-radius: {R}px; }}
QTabBar::tab:hover {{ color: {TEXT}; }}
QTabBar::tab:selected {{ color: {TEXT}; background: {SEL}; border-bottom-color: {ACCENT}; }}

QStatusBar {{ background: {BG_PANEL}; color: {TEXT_DIM}; border-top: 1px solid {BORDER}; }}
QStatusBar::item {{ border: none; }}
QGroupBox {{ border: 1px solid {BORDER}; border-radius: {R}px; margin-top: 10px; padding-top: 6px; }}
QGroupBox::title {{ subcontrol-origin: margin; left: 8px; color: {TEXT_DIM}; }}
QProgressBar {{ background: {BG_FIELD}; border: 1px solid {BORDER}; border-radius: {R}px; text-align: center; }}
QProgressBar::chunk {{ background: {ACCENT}; }}

QLabel#sectionTitle {{ color: {TEXT_DIM}; font-size: 11px; font-weight: 600; }}
QLabel#dim {{ color: {TEXT_DIM}; }}
QLabel#off {{ color: {TEXT_OFF}; }}
QLabel#warning {{ color: {WARNING}; }}
QWidget#panelFooter {{ background: {BG_PANEL}; border-top: 1px solid {BORDER}; }}
QWidget#panelHeader {{ background: {BG_PANEL}; border-bottom: 1px solid {BORDER}; }}
QWidget#bar {{ background: {BG_PANEL}; border-bottom: 1px solid {BORDER}; }}
QFrame#card {{ background: {BG_CARD}; border: 1px solid {BORDER}; border-radius: {R}px; }}
QLabel#cardTitle {{ font-weight: 600; }}
QLabel#cardTitle[off="true"] {{ color: {TEXT_DIM}; }}
QFrame#popup {{ background: {BG_POPUP}; border: 1px solid {BORDER_STRONG}; border-radius: {R}px; }}
"""

STYLESHEET = build_stylesheet()
