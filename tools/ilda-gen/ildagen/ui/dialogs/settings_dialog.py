"""Fenêtre Paramètres : général, sortie laser (H4), zone de sécurité (H1), trapèze (H2), taille / position (H3).

Les changements s'appliquent immédiatement (laser compris) et sont enregistrés à la fermeture.
"""

from PySide6.QtWidgets import (QCheckBox, QDialog, QDoubleSpinBox, QFormLayout, QHBoxLayout, QLabel, QPushButton,
                               QSpinBox, QTabWidget, QVBoxLayout, QWidget)

from ..properties.widgets import ColorSwatch

# (section, clé, libellé, type, min, max, décimales, suffixe, aide)
TABS = [
    ("Général", "general", [
        ("default_color", "Couleur par défaut", "color", None, None, 0, "", "Couleur des formes sans modifieur de couleur"),
        ("smoothing", "Lissage du crayon", "int", 0, 100, 0, " %", "Lisse et simplifie les traits à main levée"),
        ("autosave", "Enregistrer à chaque modification", "bool", None, None, 0, "",
         "Projet sans nom : gardé dans la sauvegarde automatique"),
        ("reopen_last", "Rouvrir le dernier projet au démarrage", "bool", None, None, 0, "", ""),
        ("live_at_start", "Envoi live au démarrage", "bool", None, None, 0, "", ""),
        ("show_blanking", "Afficher les trajets éteints", "bool", None, None, 0, "", "Déplacements laser éteint (pointillés)"),
        ("show_safety", "Afficher la zone de sécurité", "bool", None, None, 0, "", ""),
    ]),
    ("Sortie laser", "laser", [
        ("kpps", "Vitesse du scanner", "int", 1000, 100000, 0, " pts/s", "Points par seconde du laser (kpps × 1000)"),
        ("max_step", "Distance max entre points", "float", 0.002, 0.5, 3, "", "Plus petit = lignes plus régulières, plus de points"),
        ("blank_base", "Points éteints (saut)", "int", 0, 100, 0, "", "Points éteints ajoutés à chaque saut"),
        ("blank_per_unit", "Points éteints par distance", "int", 0, 200, 0, "", "Points éteints en plus selon la longueur du saut"),
        ("corner_dwell", "Points sur les angles", "int", 0, 50, 0, "", "Répétitions sur un angle vif (coins nets)"),
        ("corner_angle", "Angle d'un coin", "int", 1, 179, 0, " °", "À partir de cet angle, un sommet est un coin"),
        ("end_dwell", "Points aux extrémités", "int", 0, 50, 0, "", "Répétitions au début et à la fin des lignes ouvertes"),
        ("reorder", "Optimiser l'ordre des tracés", "bool", None, None, 0, "", "Réduit les sauts entre les tracés"),
    ]),
    ("Zone de sécurité", "safety", [
        ("enabled", "Activer", "bool", None, None, 0, "", "Rien n'est projeté hors de la zone"),
        ("xmin", "Gauche", "float", -1.0, 1.0, 3, "", ""),
        ("xmax", "Droite", "float", -1.0, 1.0, 3, "", ""),
        ("ymin", "Bas", "float", -1.0, 1.0, 3, "", ""),
        ("ymax", "Haut", "float", -1.0, 1.0, 3, "", ""),
    ]),
    ("Trapèze", "keystone", [
        ("top", "Haut", "float", -50.0, 50.0, 1, " %", "Resserre (+) ou élargit (−) le bord haut"),
        ("bottom", "Bas", "float", -50.0, 50.0, 1, " %", ""),
        ("left", "Gauche", "float", -50.0, 50.0, 1, " %", ""),
        ("right", "Droite", "float", -50.0, 50.0, 1, " %", ""),
    ]),
    ("Taille / position", "output", [
        ("scale_x", "Largeur", "float", 0.0, 200.0, 1, " %", ""),
        ("scale_y", "Hauteur", "float", 0.0, 200.0, 1, " %", ""),
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
        self.setMinimumWidth(580)
        lay = QVBoxLayout(self)
        self.tabs = QTabWidget()
        self.widgets = {}
        for title, section, fields in TABS:
            self.tabs.addTab(self._tab(section, fields), title)
        self.tabs.insertTab(1, self._grid_tab(), "Grille")
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
                f = QCheckBox()
                f.setChecked(bool(v))
                f.toggled.connect(lambda on, s=section, k=key: self._set(s, k, on))
            elif kind == "color":
                f = ColorSwatch()
                f.set_value(tuple(v))
                f.valueEdited.connect(lambda c, s=section, k=key: self._set(s, k, list(c)))
            elif kind == "int":
                f = QSpinBox()
                f.setRange(int(lo), int(hi))
                f.setValue(int(v))
                f.setSuffix(suffix)
                f.valueChanged.connect(lambda x, s=section, k=key: self._set(s, k, int(x)))
            else:
                f = QDoubleSpinBox()
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
            f = QSpinBox()
            f.setRange(lo, hi)
            f.setValue(int(getattr(g, attr)))
            f.setToolTip(tip)
            f.valueChanged.connect(lambda v, a=attr: self._set_grid(a, v))
            lab = QLabel(label)
            lab.setObjectName("dim")
            form.addRow(lab, f)
        return w

    def _set_grid(self, attr, value):
        setattr(self.editor.doc.grid, attr, int(value))
        self.editor.dirty = True
        self.editor.gridChanged.emit()

    def _set(self, section, key, value):
        self.settings.set(section, key, value)
        self.editor.notify()

    def _reset_tab(self):
        idx = self.tabs.currentIndex()
        if self.tabs.tabText(idx) == "Grille":
            return
        section = next(s for t, s, _ in TABS if t == self.tabs.tabText(idx))
        self.settings.reset_section(section)
        for (s, k), f in self.widgets.items():
            if s != section:
                continue
            v = self.settings.get(s, k)
            f.blockSignals(True)
            if isinstance(f, QCheckBox):
                f.setChecked(bool(v))
            elif isinstance(f, ColorSwatch):
                f.set_value(tuple(v))
            else:
                f.setValue(v)
            f.blockSignals(False)
        self.editor.notify()

    def done(self, r):
        self.settings.save()
        super().done(r)
