"""Fenêtre d'export ILDA : format, images / s, plage (timeline entière, boucle ou image fixe), réglages de sortie."""

import os

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QDialog, QDialogButtonBox, QFileDialog, QFormLayout,
                               QLabel, QMessageBox, QProgressDialog, QVBoxLayout)

from ..spin import SpinBox
from ...editor.export import export_ilda
from ...laser.ilda_file import FORMATS


class ExportDialog(QDialog):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setWindowTitle("Exporter en ILDA")
        self.setMinimumWidth(420)
        s = editor.settings
        lay = QVBoxLayout(self)
        form = QFormLayout()
        form.setVerticalSpacing(8)
        self.fmt = QComboBox()
        for code, label in FORMATS:
            self.fmt.addItem(label, code)
        codes = [c for c, _ in FORMATS]
        cur = int(s.get("export", "format"))
        self.fmt.setCurrentIndex(codes.index(cur) if cur in codes else 0)
        form.addRow("Format", self.fmt)
        tl = editor.doc.timeline
        self.has_anim = tl.has_clips()
        self.range = QComboBox()
        if self.has_anim:
            self.range.addItem("Toute la timeline", "all")
            if tl.loop_end > tl.loop_start:
                self.range.addItem("Zone de boucle", "loop")
        self.range.addItem("Image fixe (forme en cours)", "still")
        form.addRow("Contenu", self.range)
        self.fps = SpinBox()
        self.fps.setRange(1, 120)
        self.fps.setValue(int(s.get("export", "fps")))
        self.fps.setSuffix(" images/s")
        form.addRow("Cadence", self.fps)
        self.corrections = QCheckBox("Appliquer les réglages de sortie")
        self.corrections.setChecked(bool(s.get("export", "corrections")))
        self.corrections.setToolTip("Taille / position, trapèze, puissance, couleurs et zone de sécurité de CE laser.\n"
                                    "Décoché : le fichier contient le contenu seul (le lecteur applique ses réglages).")
        form.addRow("", self.corrections)
        lay.addLayout(form)
        info = QLabel("La timeline contient des clips : l'animation est exportée." if self.has_anim else
                      "La timeline est vide : l'image fixe de la forme en cours est exportée.")
        info.setObjectName("dim")
        info.setWordWrap(True)
        lay.addWidget(info)
        bb = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        bb.button(QDialogButtonBox.StandardButton.Ok).setText("Exporter…")
        bb.button(QDialogButtonBox.StandardButton.Cancel).setText("Annuler")
        bb.accepted.connect(self.run)
        bb.rejected.connect(self.reject)
        lay.addWidget(bb)
        self.range.currentIndexChanged.connect(self._range_changed)
        self._range_changed()

    def _range_changed(self):
        # Image fixe : la cadence ne sert pas (une seule image)
        self.fps.setEnabled(self.range.currentData() != "still")

    def run(self):
        ed = self.editor
        base = os.path.splitext(os.path.basename(ed.doc.path))[0] if ed.doc.path else "animation"
        start_dir = os.path.dirname(ed.doc.path) if ed.doc.path else os.path.expanduser("~")
        path, _ = QFileDialog.getSaveFileName(self, "Exporter en ILDA", os.path.join(start_dir, base + ".ild"),
                                              "Fichiers ILDA (*.ild)")
        if not path:
            return
        if not path.lower().endswith(".ild"):
            path += ".ild"
        fmt = self.fmt.currentData()
        fps = self.fps.value()
        ed.settings.set("export", "format", fmt)
        ed.settings.set("export", "fps", fps)
        corrections = self.corrections.isChecked()
        ed.settings.set("export", "corrections", corrections)
        ed.settings.save()
        tl = ed.doc.timeline
        mode = self.range.currentData()
        if mode == "all":
            start, end = 0.0, max(tl.content_end(), 1.0 / fps)
        elif mode == "loop":
            start, end = tl.loop_start, tl.loop_end
        else:
            start = end = 0.0
        prog = QProgressDialog("Calcul des images…", "Annuler", 0, 100, self)
        prog.setWindowModality(Qt.WindowModality.WindowModal)
        prog.setMinimumDuration(300)

        def progress(i, n):
            prog.setMaximum(n)
            prog.setValue(i)
            QApplication.processEvents()
            return not prog.wasCanceled()

        try:
            n = export_ilda(ed, path, fmt, fps, start, end, progress, corrections)
        except OSError as e:
            prog.close()
            QMessageBox.critical(self, "Export", f"Impossible d'écrire le fichier :\n{e}")
            return
        except ValueError as e:              # limites du format ILDA (images, points)
            prog.close()
            QMessageBox.critical(self, "Export", str(e))
            return
        except Exception as e:               # erreur imprévue : la fenêtre de progression ne reste jamais ouverte
            prog.close()
            QMessageBox.critical(self, "Export", f"L'export a échoué :\n{type(e).__name__} : {e}")
            return
        prog.close()
        if n:
            ed.statusMessage.emit(f"Export ILDA : {n} image(s) → {os.path.basename(path)}")
            self.accept()
