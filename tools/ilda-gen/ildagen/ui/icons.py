"""Icônes Lucide (SVG, licence ISC) recolorées selon le thème."""

import os
import re

from PySide6.QtCore import QByteArray, QSize, Qt
from PySide6.QtGui import QIcon, QPainter, QPixmap
from PySide6.QtSvg import QSvgRenderer

from . import theme

ICON_DIR = os.path.join(os.path.dirname(__file__), "icons")
_svg_cache = {}
_icon_cache = {}


def _svg(name, color, stroke=1.6):
    if name not in _svg_cache:
        path = os.path.join(ICON_DIR, name + ".svg")
        try:
            with open(path, encoding="utf-8") as f:
                _svg_cache[name] = f.read()
        except OSError:
            _svg_cache[name] = ""
    s = _svg_cache[name].replace("currentColor", color)
    return re.sub(r'stroke-width="[\d.]+"', f'stroke-width="{stroke}"', s)


def pixmap(name, color=theme.TEXT_DIM, size=16, dpr=2.0):
    data = _svg(name, color)
    pm = QPixmap(int(size * dpr), int(size * dpr))
    pm.fill(Qt.GlobalColor.transparent)
    if data:
        r = QSvgRenderer(QByteArray(data.encode("utf-8")))
        p = QPainter(pm)
        r.render(p)
        p.end()
    pm.setDevicePixelRatio(dpr)
    return pm


def icon(name, size=16, color=None, active_color=None):
    """Icône avec états : repos (texte secondaire), survol / actif (texte), coché (accent)."""
    key = (name, size, color, active_color)
    if key in _icon_cache:
        return _icon_cache[key]
    ic = QIcon()
    base = color or theme.TEXT_DIM
    on = active_color or theme.ACCENT
    ic.addPixmap(pixmap(name, base, size), QIcon.Mode.Normal, QIcon.State.Off)
    ic.addPixmap(pixmap(name, theme.TEXT, size), QIcon.Mode.Active, QIcon.State.Off)
    ic.addPixmap(pixmap(name, on, size), QIcon.Mode.Normal, QIcon.State.On)
    ic.addPixmap(pixmap(name, on, size), QIcon.Mode.Active, QIcon.State.On)
    ic.addPixmap(pixmap(name, theme.TEXT_OFF, size), QIcon.Mode.Disabled, QIcon.State.Off)
    _icon_cache[key] = ic
    return ic


def qsize(n):
    return QSize(n, n)
