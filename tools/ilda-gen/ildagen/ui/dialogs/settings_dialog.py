"""Fenêtre Paramètres : général, apparence (thème), grille, sortie laser (H4), couleurs, zone de sécurité (H1),
trapèze (H2), taille / position (H3).

Les changements s'appliquent immédiatement (laser et thème compris) et sont enregistrés à la fermeture.
« Réinitialiser cet onglet » remet les valeurs par défaut de l'onglet affiché, quel qu'il soit.
"""

from PySide6.QtWidgets import (QDialog, QFormLayout, QHBoxLayout, QLabel, QPushButton, QTabWidget, QVBoxLayout,
                               QWidget)

from ..spin import DoubleSpinBox, SpinBox
from ..properties.widgets import ColorSwatch
from ..widgets import Switch
from .appearance_tab import AppearanceTab
from ...laser.output import MIN_SCALE, MIN_ZONE
from ...laser.pipeline import budget_for

# (section, clé, libellé, type, min, max, décimales, suffixe, aide)
TABS = [
    ("Général", "general", [
        ("default_color", "Couleur par défaut", "color", None, None, 0, "", "Couleur des formes sans modifieur de couleur"),
        ("smoothing", "Lissage du crayon", "int", 0, 100, 0, " %", "Lisse et simplifie les traits à main levée"),
        ("autosave", "Enregistrer à chaque modification", "bool", None, None, 0, "",
         "Projet sans nom : gardé dans la sauvegarde automatique"),
        ("reopen_last", "Rouvrir le dernier projet au démarrage", "bool", None, None, 0, "", ""),
        ("show_blanking", "Afficher les trajets éteints", "bool", None, None, 0, "", "Déplacements laser éteint (pointillés)"),
        ("show_safety", "Afficher la zone de sécurité", "bool", None, None, 0, "", ""),
    ]),
    ("Sortie laser", "laser", [
        ("scan_kpps", "Vitesse de balayage", "float", 1.0, 100.0, 1, " kpps",
         "Points par seconde du laser, en milliers. Une image compte au plus kpps × 1000 / images par seconde "
         "points : au-delà, elle est allégée (points espacés, simplifiée)"),
        ("max_step", "Distance max entre points", "float", 0.002, 0.5, 3, "", "Plus petit = lignes plus régulières, plus de points"),
        ("blank_base", "Points éteints (saut)", "int", 0, 100, 0, "", "Points éteints ajoutés à chaque saut (accélération, freinage)"),
        ("blank_per_unit", "Points éteints par distance", "int", 0, 200, 0, "", "Points éteints en plus selon la longueur du saut"),
        ("blank_pre", "Points éteints avant un tracé", "int", 0, 50, 0, "", "Arrêt laser éteint au début de chaque tracé (les miroirs se posent)"),
        ("blank_post", "Points éteints après un tracé", "int", 0, 50, 0, "", "Arrêt laser éteint à la fin de chaque tracé, avant le saut"),
        ("corner_dwell", "Points sur les angles", "int", 0, 50, 0, "", "Répétitions sur un angle droit (moins sur un angle doux, plus sur un angle aigu)"),
        ("corner_angle", "Angle d'un coin", "int", 1, 179, 0, " °", "À partir de cet angle, un sommet est un coin"),
        ("end_dwell", "Points aux extrémités", "int", 0, 50, 0, "", "Répétitions au début et à la fin des lignes ouvertes"),
        ("reorder", "Optimiser l'ordre des tracés", "bool", None, None, 0, "", "Réduit les sauts entre les tracés"),
    ]),
    ("Couleurs", "color", [
        ("shift", "Décalage couleur", "int", 0, 20, 0, " pts",
         "Retarde les couleurs de quelques points (réglés à 30 kpps) pour compenser le retard des miroirs. "
         "Le laser du jeu compense déjà le sien : laisser à 0"),
        ("gamma", "Gamma", "float", 0.2, 5.0, 2, "", "Courbe de luminosité : au-dessus de 1, les couleurs faibles sont plus sombres"),
        ("gain_r", "Gain rouge", "float", 0.0, 100.0, 0, " %", "Équilibre des couleurs du laser"),
        ("gain_g", "Gain vert", "float", 0.0, 100.0, 0, " %", ""),
        ("gain_b", "Gain bleu", "float", 0.0, 100.0, 0, " %", ""),
        ("min_power", "Puissance minimale", "float", 0.0, 50.0, 1, " %", "En dessous, le point est éteint (diodes qui s'allument mal)"),
    ]),
    ("Zone de sécurité", "safety", [
        ("enabled", "Activer", "bool", None, None, 0, "", "Rien n'est projeté hors de la zone"),
        ("xmin", "Gauche", "float", -1.0, 1.0, 3, "", ""),
        ("xmax", "Droite", "float", -1.0, 1.0, 3, "", ""),
        ("ymin", "Bas", "float", -1.0, 1.0, 3, "", ""),
        ("ymax", "Haut", "float", -1.0, 1.0, 3, "", ""),
        ("static_guard", "Anti point fixe", "bool", None, None, 0, "",
         "Coupe une image dont tous les points allumés tiennent en un point (faisceau immobile : dangereux)"),
    ]),
    ("Trapèze", "keystone", [
        ("top", "Haut", "float", -50.0, 50.0, 1, " %", "Resserre (+) ou élargit (−) le bord haut"),
        ("bottom", "Bas", "float", -50.0, 50.0, 1, " %", ""),
        ("left", "Gauche", "float", -50.0, 50.0, 1, " %", ""),
        ("right", "Droite", "float", -50.0, 50.0, 1, " %", ""),
    ]),
    ("Taille / position", "output", [
        ("scale_x", "Largeur", "float", MIN_SCALE, 200.0, 1, " %", ""),
        ("scale_y", "Hauteur", "float", MIN_SCALE, 200.0, 1, " %", ""),
        ("offset_x", "Décalage X", "float", -1.0, 1.0, 3, "", ""),
        ("offset_y", "Décalage Y", "float", -1.0, 1.0, 3, "", ""),
        ("rotation", "Rotation", "float", -180.0, 180.0, 1, " °", ""),
        ("flip_x", "Inverser X", "bool", None, None, 0, "", ""),
        ("flip_y", "Inverser Y", "bool", None, None, 0, "", ""),
        ("power", "Puissance max", "float", 0.0, 100.0, 0, " %", "Limite la luminosité de toute la sortie"),
    ]),
]


class SettingsDialog(QDialog):
    def __init__(self, editor, live, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.live = live
        self.settings = editor.settings
        self.setWindowTitle("Paramètres")
        self.setMinimumWidth(780)          # tous les onglets visibles
        lay = QVBoxLayout(self)
        self.tabs = QTabWidget()
        self.widgets = {}
        self.resets = {}             # onglet → fonction de « Réinitialiser cet onglet »
        self.grid_fields = {}
        pages = {}
        for title, section, fields in TABS:
            pages[section] = self._tab(section, fields)
            self.tabs.addTab(pages[section], title)
            self.resets[pages[section]] = lambda s=section: self._reset_section(s)
        self.appearance = AppearanceTab(self.settings)
        self.tabs.insertTab(1, self.appearance, "Apparence")
        self.resets[self.appearance] = self.appearance.reset
        grid = self._grid_tab()
        self.tabs.insertTab(2, grid, "Grille")
        self.resets[grid] = self._reset_grid
        self.budget = QLabel()
        self.budget.setObjectName("dim")
        self.budget.setWordWrap(True)
        pages["laser"].layout().addRow(self.budget)
        self._sync_budget()
        for lo, hi in (("xmin", "xmax"), ("ymin", "ymax")):
            self.widgets[("safety", lo)].valueChanged.connect(self._sync_zone)
            self.widgets[("safety", hi)].valueChanged.connect(self._sync_zone)
        self._sync_zone()
        lay.addWidget(self.tabs)
        row = QHBoxLayout()
        reset = QPushButton("Réinitialiser cet onglet")
        reset.clicked.connect(self._reset_tab)
        close = QPushButton("Fermer")
        close.setDefault(True)
        close.clicked.connect(self.accept)
        row.addWidget(reset)
        row.addStretch(1)
        row.addWidget(close)
        lay.addLayout(row)

    def _tab(self, section, fields):
        w = QWidget()
        form = QFormLayout(w)
        form.setContentsMargins(14, 14, 14, 14)
        form.setVerticalSpacing(8)
        for key, label, kind, lo, hi, dec, suffix, tip in fields:
            v = self.settings.get(section, key)
            if kind == "bool":
                f = Switch(bool(v), focusable=True)
                f.toggled.connect(lambda on, s=section, k=key: self._set(s, k, on))
            elif kind == "color":
                f = ColorSwatch()
                f.set_value(tuple(v))
                f.valueEdited.connect(lambda c, s=section, k=key: self._set(s, k, list(c)))
            elif kind == "int":
                f = SpinBox()
                f.setRange(int(lo), int(hi))
                f.setValue(int(v))
                f.setSuffix(suffix)
                f.valueChanged.connect(lambda x, s=section, k=key: self._set(s, k, int(x)))
            else:
                f = DoubleSpinBox()
                f.setRange(lo, hi)
                f.setDecimals(dec)
                f.setSingleStep(10 ** (-dec) if dec else 1.0)
                f.setValue(float(v))
                f.setSuffix(suffix)
                f.valueChanged.connect(lambda x, s=section, k=key: self._set(s, k, float(x)))
            if tip:
                f.setToolTip(tip)
            lab = QLabel(label)
            lab.setObjectName("dim")
            lab.setToolTip(tip)
            form.addRow(lab, f)
            self.widgets[(section, key)] = f
        return w

    def _grid_tab(self):
        """Densité des grilles (enregistrée avec le projet)."""
        w = QWidget()
        form = QFormLayout(w)
        form.setContentsMargins(14, 14, 14, 14)
        form.setVerticalSpacing(8)
        g = self.editor.doc.grid
        for attr, label, lo, hi, tip in (("divisions", "Cases par demi-axe (orthogonale)", 1, 64, "8 = pas de 1/8"),
                                         ("rings", "Cercles (polaire)", 1, 64, ""),
                                         ("rays", "Rayons (polaire)", 2, 360, "16 = un rayon tous les 22,5°")):
            f = SpinBox()
            f.setRange(lo, hi)
            f.setValue(int(getattr(g, attr)))
            f.setToolTip(tip)
            f.valueChanged.connect(lambda v, a=attr: self._set_grid(a, v))
            lab = QLabel(label)
            lab.setObjectName("dim")
            form.addRow(lab, f)
            self.grid_fields[attr] = f
        return w

    def _reset_grid(self):
        """Densités de grille par défaut (le mode, l'aimant et la symétrie ne changent pas)."""
        defaults = type(self.editor.doc.grid)()
        for attr, f in self.grid_fields.items():
            f.setValue(int(getattr(defaults, attr)))      # applique et prévient la mire (_set_grid)

    def _set_grid(self, attr, value):
        setattr(self.editor.doc.grid, attr, int(value))
        self.editor.dirty = True
        self.editor.gridChanged.emit()

    def _set(self, section, key, value):
        self.settings.set(section, key, value)
        if section == "laser":
            self._sync_budget()
        self.editor.notify()

    def _sync_budget(self):
        fps = max(1, int(self.settings.get("network", "fps")))
        kpps = float(self.settings.get("laser", "scan_kpps"))
        n = budget_for(self.settings, fps)
        self.budget.setText(f"Budget : {n:,} points par image ({kpps:g} kpps à {fps} images/s). ".replace(",", " ")
                            + "Les nombres de points sont réglés pour 30 kpps et suivent la vitesse de balayage.")

    def _sync_zone(self, *_):
        """Zone de sécurité jamais retournée : la gauche reste à gauche de la droite, le bas sous le haut."""
        for lo, hi in (("xmin", "xmax"), ("ymin", "ymax")):
            a, b = self.widgets[("safety", lo)], self.widgets[("safety", hi)]
            b.setMinimum(min(1.0, a.value() + MIN_ZONE))
            a.setMaximum(max(-1.0, b.value() - MIN_ZONE))

    def _reset_tab(self):
        """« Réinitialiser cet onglet » : chaque onglet a sa remise à zéro (F5 : rien ne se passait sur Grille)."""
        reset = self.resets.get(self.tabs.currentWidget())
        if reset is not None:
            reset()

    def _reset_section(self, section):
        keep = {k: self.settings.get("general", k) for k in ("live_last",)} if section == "general" else {}
        self.settings.reset_section(section)
        for k, v in keep.items():
            self.settings.set(section, k, v)     # état mémorisé, pas un réglage de l'onglet
        for (s, k), f in self.widgets.items():
            if s != section:
                continue
            v = self.settings.get(s, k)
            f.blockSignals(True)
            if isinstance(f, Switch):
                f.set_value(bool(v))
            elif isinstance(f, ColorSwatch):
                f.set_value(tuple(v))
            else:
                f.setValue(v)
            f.blockSignals(False)
        self._sync_zone()
        self._sync_budget()
        self.editor.notify()

    def done(self, r):
        self.settings.save()
        super().done(r)
