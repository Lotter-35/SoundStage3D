"""Une image laser complète : tracés → points optimisés (dans le budget) → sortie → sécurité anti point fixe.

Utilisé par l'envoi live (avec les réglages de sortie) et par l'export (avec ou sans).
"""

import copy
import json

import numpy as np

from ..core.settings import DEFAULTS
from .color import is_static
from .optimizer import optimize
from .output import apply_output, plain_output

MAX_LIVE_POINTS = 20000     # le serveur SoundStage3D coupe les images au-delà
MAX_ILDA_POINTS = 65535     # limite du format ILDA (nombre de points d'une image sur 16 bits)
MIN_BUDGET = 100            # en dessous, plus rien de lisible : l'image est alors tracée moins souvent


def budget_for(settings, fps, cap=MAX_LIVE_POINTS):
    """Points par image : vitesse de balayage / images par seconde, dans les limites."""
    kpps = float(settings.get("laser", "scan_kpps") or 30.0)
    return max(MIN_BUDGET, min(int(cap), int(kpps * 1000.0 / max(1.0, float(fps)))))


class Frame:
    """x, y (int16), r, g, b (uint8) envoyés ; pts / col : points de la mire (aperçu) ; count : points envoyés ;
    reduced : image allégée pour tenir le budget ; static : coupée par la sécurité anti point fixe."""

    __slots__ = ("x", "y", "r", "g", "b", "pts", "col", "count", "reduced", "static", "budget", "order")

    def __init__(self, out, pts, col, reduced, static, budget, order):
        self.x, self.y, self.r, self.g, self.b = out
        self.pts, self.col = pts, col
        self.count = len(self.x)
        self.reduced, self.static, self.budget, self.order = reduced, static, budget, order


def render_frame(strokes, settings, fps, corrections=True, cap=MAX_LIVE_POINTS, previous=None):
    """Image prête à envoyer / écrire. previous : ordre des tracés de l'image précédente (stabilité)."""
    budget = budget_for(settings, fps, cap)
    opt = optimize(strokes, settings.section("laser"), budget, previous)
    out = apply_output(opt.pts, opt.col, settings) if corrections else plain_output(opt.pts, opt.col)
    static = False
    if settings.get("safety", "static_guard") and len(out[0]):
        x, y, r, g, b = out
        lit = (r > 0) | (g > 0) | (b > 0)
        if is_static(np.column_stack((x, y)).astype(float) / 32767.0, lit):
            z = np.zeros_like(r)
            out = (x, y, z, z, z)               # faisceau immobile : rien n'est allumé
            static = True
    return Frame(out, opt.pts, opt.col, opt.reduced, static, budget, opt.order)


class SettingsCopy:
    """Copie figée des réglages de sortie : le fil d'envoi la lit pendant que l'interface modifie les vrais."""

    SECTIONS = ("laser", "color", "output", "safety", "keystone", "network", "general")

    def __init__(self, settings):
        self.data = {k: copy.deepcopy(settings.section(k)) for k in self.SECTIONS}
        self.signature = json.dumps(self.data, sort_keys=True, default=str)

    def section(self, name):
        return self.data[name]

    def get(self, section, key):
        return self.data[section].get(key, DEFAULTS[section].get(key))
