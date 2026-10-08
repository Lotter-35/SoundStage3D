"""Actions de la fenêtre (menus + raccourcis clavier)."""

import sys

from PySide6.QtGui import QAction, QActionGroup, QKeySequence
from PySide6.QtWidgets import QApplication, QLineEdit, QAbstractSpinBox

from ..core.shapes import BASIC_SHAPES
from .tool_panel import SHAPE_KEYS

SK = QKeySequence.StandardKey


def _typing():
    """Vrai si l'utilisateur tape dans un champ texte (les raccourcis à une touche ne doivent pas agir)."""
    w = QApplication.focusWidget()
    return isinstance(w, (QLineEdit, QAbstractSpinBox))


def build_actions(win):
    ed = win.editor
    A = {}

    def act(key, text, slot, shortcut=None, checkable=False):
        a = QAction(text, win)
        if shortcut is not None:
            items = shortcut if isinstance(shortcut, (list, tuple)) else [shortcut]
            seqs = []
            for s in items:
                seqs += QKeySequence.keyBindings(s) if isinstance(s, SK) else [QKeySequence(s)]
            if sys.platform == "darwin":
                # « Ctrl » = Cmd sur Mac ; on accepte aussi la touche Ctrl physique (Meta pour Qt)
                extra = []
                for q in seqs:
                    txt = q.toString(QKeySequence.SequenceFormat.PortableText)
                    if "Ctrl+" in txt:
                        extra.append(QKeySequence(txt.replace("Ctrl+", "Meta+")))
                seqs += extra
            a.setShortcuts(seqs)
        a.setCheckable(checkable)
        a.triggered.connect(slot)
        win.addAction(a)
        A[key] = a
        return a

    # Fichier
    act("new", "Nouveau projet", win.project.new, SK.New)
    act("open", "Ouvrir…", lambda: win.project.open(), SK.Open)
    act("save", "Enregistrer", win.project.save, SK.Save)
    act("save_as", "Enregistrer sous…", win.project.save_as, "Ctrl+Shift+S")
    act("music", "Importer une musique…", win.project.import_music, "Ctrl+Shift+I")
    act("export", "Exporter en ILDA…", win.export_ilda, "Ctrl+E")
    act("recover", "Récupérer la sauvegarde automatique", win.project.recover)
    act("recover_backup", "Récupérer une sauvegarde automatique…", win.project.recover_backup)
    act("quit", "Quitter", win.close, SK.Quit)

    # Édition
    act("undo", "Annuler", ed.undo, SK.Undo)
    act("redo", "Rétablir", ed.redo, [QKeySequence(SK.Redo), QKeySequence("Ctrl+Y")])
    # Échap pendant un geste (glisser, réglage…) : il est annulé. Active seulement pendant un geste,
    # sinon Échap garde son rôle habituel (désélectionner, fermer une saisie…)
    act("cancel_gesture", "Annuler le geste en cours", win.cancel_gesture, "Escape").setEnabled(False)
    act("cut", "Couper", win.cut_pressed, SK.Cut)
    act("copy", "Copier", win.copy_pressed, SK.Copy)
    act("paste", "Coller", win.paste_pressed, SK.Paste)
    act("duplicate", "Dupliquer", win.duplicate_pressed, "Ctrl+D")
    act("delete", "Supprimer", win.delete_pressed, [QKeySequence("Delete"), QKeySequence("Backspace")])
    act("select_all", "Tout sélectionner", win.select_all_pressed, SK.SelectAll)
    act("group", "Grouper", ed.group_selected, "Ctrl+G")
    act("reset", "Réinitialiser les réglages", lambda: ed.reset_params(), "Ctrl+Shift+R")
    act("ungroup", "Dégrouper", ed.ungroup_selected, "Ctrl+Shift+G")

    # Affichage
    grid_group = QActionGroup(win)
    for i, label in enumerate(("Sans grille", "Grille orthogonale", "Grille polaire")):
        a = act(f"grid{i}", label, lambda _=False, m=i: ed.set_grid_mode(m), f"Ctrl+{i + 1}", checkable=True)
        grid_group.addAction(a)
    act("snap", "Aimant (grille)", lambda: ed.set_snap(not ed.doc.grid.snap), "Ctrl+;", checkable=True)
    act("symmetry", "Symétrie de dessin (marche / arrêt)", ed.toggle_symmetry, "Ctrl+Shift+M", checkable=True)
    act("fit", "Ajuster la vue", lambda: win.canvas.view.fit_view(), "Ctrl+0")
    act("zoom_in", "Zoomer", lambda: win.canvas.view.zoom_by(1.4), SK.ZoomIn)
    act("zoom_out", "Dézoomer", lambda: win.canvas.view.zoom_by(1 / 1.4), SK.ZoomOut)
    act("view_scene", "Afficher la forme", lambda: ed.set_view_source("form"))
    act("view_tl", "Afficher la timeline", lambda: ed.set_view_source("timeline"))

    # Lecture
    act("play", "Lecture / pause", lambda: None if _typing() else win.playback.toggle(), "Space")
    act("stop", "Stop", win.playback.stop)
    act("add_track", "Ajouter une piste", ed.add_track)

    # Outils (touches simples, ignorées pendant la saisie)
    def tool(t):
        return lambda: None if _typing() else ed.set_tool(t)
    act("tool_select", "Sélection", tool("select"), "V")
    act("tool_pencil", "Crayon", tool("pencil"), "B")
    act("tool_bucket", "Seau", tool("bucket"), "G")
    act("swap_colors", "Inverser les couleurs", lambda: None if _typing() else ed.swap_colors(), "X")
    act("reset_colors", "Couleurs par défaut", lambda: None if _typing() else ed.reset_colors(), "D")
    for k, label, _ in BASIC_SHAPES:
        act("tool_" + k, label, tool("shape:" + k), SHAPE_KEYS[k])

    act("settings", "Paramètres…", win.open_settings, SK.Preferences if not QKeySequence(SK.Preferences).isEmpty() else "Ctrl+,")
    act("about", "À propos", win.about)
    return A


def build_menus(win, A):
    mb = win.menuBar()
    m = mb.addMenu("Fichier")
    for k in ("new", "open"):
        m.addAction(A[k])
    win.recent_menu = m.addMenu("Récents")
    m.addSeparator()
    for k in ("save", "save_as"):
        m.addAction(A[k])
    m.addSeparator()
    m.addAction(A["music"])
    m.addAction(A["export"])
    m.addSeparator()
    m.addAction(A["recover"])
    m.addAction(A["recover_backup"])
    m.addSeparator()
    m.addAction(A["quit"])

    m = mb.addMenu("Édition")
    for k in ("undo", "redo", None, "cut", "copy", "paste", "duplicate", "delete", None, "select_all", None,
              "group", "ungroup", None, "reset"):
        m.addSeparator() if k is None else m.addAction(A[k])

    m = mb.addMenu("Affichage")
    for k in ("grid0", "grid1", "grid2", "snap", None, "symmetry"):
        m.addSeparator() if k is None else m.addAction(A[k])
    from .canvas.symmetry_menu import build_symmetry_menu
    m.addMenu(build_symmetry_menu(win.editor, m, "Mode de symétrie"))
    for k in (None, "view_scene", "view_tl", None, "fit", "zoom_in", "zoom_out"):
        m.addSeparator() if k is None else m.addAction(A[k])

    m = mb.addMenu("Lecture")
    for k in ("play", "stop", None, "add_track"):
        m.addSeparator() if k is None else m.addAction(A[k])

    m = mb.addMenu("Paramètres")
    m.addAction(A["settings"])
    m.addSeparator()
    m.addAction(A["about"])
