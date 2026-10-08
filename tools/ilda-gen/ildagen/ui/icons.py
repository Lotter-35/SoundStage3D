"""Icônes Lucide (SVG, licence ISC) recolorées selon le thème, gardées en cache.

- icon(nom) : QIcon dont les images sont dessinées au moment de l'affichage avec les couleurs du thème courant
  (repos : texte secondaire, survol : texte, coché : accent, désactivé : texte désactivé). Un changement de
  thème les recolore sans rien reconstruire.
- pixmap(nom, couleur, taille) : image seule, pour le code qui peint.

Couleur : nom d'un jeton du thème (« ACCENT », « TEXT », « LIVE »…) ou « #rrggbb ». Une couleur égale à un
jeton du thème courant (theme.TEXT…) est retenue comme ce jeton : elle suit le thème.
Cache des images : (nom, taille, couleur, échelle d'écran), vidé à chaque changement de thème.
"""

import os
import re

from PySide6.QtCore import QByteArray, QRectF, QSize, Qt
from PySide6.QtGui import QIcon, QIconEngine, QPainter, QPixmap
from PySide6.QtSvg import QSvgRenderer

from . import theme

ICON_DIR = os.path.join(os.path.dirname(__file__), "icons")
STROKE = 1.6
_svg_cache = {}       # nom → texte SVG
_pm_cache = {}        # (nom, taille, couleur, échelle) → QPixmap
_MAX_CACHE = 3000
# Jetons qu'une couleur passée en « #rrggbb » peut désigner (par ordre de priorité)
_FOLLOW = ("ACCENT", "TEXT", "TEXT_DIM", "TEXT_OFF", "DANGER", "LIVE", "ON_ACCENT")


def _svg(name, color):
    if name not in _svg_cache:
        try:
            with open(os.path.join(ICON_DIR, name + ".svg"), encoding="utf-8") as f:
                s = f.read()
        except OSError:
            s = ""
        _svg_cache[name] = re.sub(r'stroke-width="[\d.]+"', f'stroke-width="{STROKE}"', s)
    return _svg_cache[name].replace("currentColor", color)


def color_of(color, fallback="TEXT_DIM"):
    """Couleur « #rrggbb » à utiliser maintenant : jeton du thème, couleur fixe, ou fallback (jeton) si None."""
    if not color:
        color = fallback
    if not color.startswith("#"):
        return getattr(theme, color, theme.TEXT_DIM)
    return color


def follow(color):
    """Couleur retenue par une icône : le nom du jeton si elle vaut un jeton du thème courant (suit le thème)."""
    if not color or not color.startswith("#"):
        return color
    low = color.lower()
    return next((t for t in _FOLLOW if getattr(theme, t).lower() == low), color)


def pixmap(name, color=None, size=16, dpr=2.0):
    """Icône peinte d'une couleur (jeton ou « #rrggbb » ; None = texte secondaire), à l'échelle d'écran dpr."""
    col = color_of(color)
    key = (name, int(size), col, round(float(dpr), 2))
    pm = _pm_cache.get(key)
    if pm is not None:
        return pm
    n = max(1, round(size * dpr))
    pm = QPixmap(n, n)
    pm.fill(Qt.GlobalColor.transparent)
    data = _svg(name, col)
    if data:
        r = QSvgRenderer(QByteArray(data.encode("utf-8")))
        p = QPainter(pm)
        r.render(p, QRectF(0, 0, n, n))
        p.end()
    pm.setDevicePixelRatio(dpr)
    if len(_pm_cache) >= _MAX_CACHE:
        _pm_cache.clear()
    _pm_cache[key] = pm
    return pm


def clear_cache():
    _pm_cache.clear()


def cache_size():
    return len(_pm_cache)


class ThemedIconEngine(QIconEngine):
    """Moteur de QIcon : chaque état est peint à la demande avec les couleurs du thème courant (en cache)."""

    def __init__(self, name, color=None, active_color=None):
        super().__init__()
        self.name = name
        self.color = follow(color)
        self.active_color = follow(active_color)

    def color_for(self, mode, state):
        if mode == QIcon.Mode.Disabled:
            return theme.TEXT_OFF
        if state == QIcon.State.On:
            return color_of(self.active_color, "ACCENT")
        if mode in (QIcon.Mode.Active, QIcon.Mode.Selected) and self.color in (None, "TEXT_DIM", "TEXT_OFF"):
            return theme.TEXT           # survol : le gris s'éclaircit (une icône colorée garde sa couleur)
        return color_of(self.color)

    def scaledPixmap(self, size, mode, state, scale):
        n = min(size.width(), size.height())
        return pixmap(self.name, self.color_for(mode, state), n, max(1.0, float(scale)))

    def pixmap(self, size, mode, state):
        return self.scaledPixmap(size, mode, state, 1.0)

    def paint(self, painter, rect, mode, state):
        dpr = painter.device().devicePixelRatioF() if painter.device() is not None else 1.0
        painter.drawPixmap(rect, self.scaledPixmap(rect.size(), mode, state, dpr))

    def actualSize(self, size, mode, state):
        return size

    def clone(self):
        return ThemedIconEngine(self.name, self.color, self.active_color)

    def key(self):
        return "ildagen-themed"


def icon(name, size=16, color=None, active_color=None):
    """Icône avec états : repos (color, sinon texte secondaire), survol (texte ; une icône colorée garde sa
    couleur), coché (active_color, sinon accent), désactivé. size est gardé pour compatibilité : la taille vient
    de l'endroit où l'icône est affichée."""
    return QIcon(ThemedIconEngine(name, color, active_color))


def qsize(n):
    return QSize(n, n)


theme.notifier.changed.connect(lambda _tid: clear_cache())
