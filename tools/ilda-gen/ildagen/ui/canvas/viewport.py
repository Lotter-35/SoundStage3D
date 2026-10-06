"""Correspondance écran ↔ mire (zoom, déplacement de la vue)."""

import numpy as np
from PySide6.QtCore import QPointF

MIN_ZOOM = 0.2
MAX_ZOOM = 400.0
FILL = 0.44   # demi-côté de la mire / plus petit côté de la zone, au zoom 1


class Viewport:
    def __init__(self):
        self.zoom = 1.0
        self.pan_x = 0.0   # centre de la vue, en unités de mire
        self.pan_y = 0.0
        self.w = 1
        self.h = 1

    def resize(self, w, h):
        self.w, self.h = max(1, w), max(1, h)

    @property
    def half(self):
        return min(self.w, self.h) * FILL * self.zoom

    def to_screen(self, x, y):
        h = self.half
        return QPointF(self.w / 2 + (x - self.pan_x) * h, self.h / 2 - (y - self.pan_y) * h)

    def to_screen_arr(self, pts):
        h = self.half
        out = np.empty_like(pts, dtype=float)
        out[:, 0] = self.w / 2 + (pts[:, 0] - self.pan_x) * h
        out[:, 1] = self.h / 2 - (pts[:, 1] - self.pan_y) * h
        return out

    def to_world(self, sx, sy):
        h = self.half
        return (sx - self.w / 2) / h + self.pan_x, -(sy - self.h / 2) / h + self.pan_y

    def px(self, n):
        """n pixels écran en unités de mire."""
        return n / self.half

    def zoom_at(self, factor, sx, sy):
        wx, wy = self.to_world(sx, sy)
        self.zoom = min(MAX_ZOOM, max(MIN_ZOOM, self.zoom * factor))
        nx, ny = self.to_world(sx, sy)
        self.pan_x += wx - nx
        self.pan_y += wy - ny

    def pan_pixels(self, dx, dy):
        self.pan_x -= dx / self.half
        self.pan_y += dy / self.half

    def fit(self):
        self.zoom = 1.0
        self.pan_x = self.pan_y = 0.0
