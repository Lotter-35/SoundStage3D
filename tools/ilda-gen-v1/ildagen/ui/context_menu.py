"""Menu clic droit commun à l'arbre des calques et à la mire (toutes les actions sur les calques)."""

from PySide6.QtWidgets import QInputDialog, QMenu

from ..core.modifiers import SUB_MODIFIER_TYPES, by_category, registry
from . import icons


def ask_text(parent, title, label, value=""):
    text, ok = QInputDialog.getText(parent, title, label, text=value)
    return text.strip() if ok and text.strip() else None


def add_modifier_menu(menu, editor, onto=None):
    sub = menu.addMenu("Ajouter un modifieur")
    for cat, mods in by_category():
        cm = sub.addMenu(cat)
        for m in mods:
            a = cm.addAction(icons.icon(m.icon, 14), m.label)
            a.setToolTip(m.description)
            a.triggered.connect(lambda _=False, t=m.type_id: editor.add_modifier(t))
    if onto is not None and onto.kind == "modifier":
        sm = menu.addMenu("Ajouter un sous-modifieur")
        for t in SUB_MODIFIER_TYPES:
            m = registry[t]
            a = sm.addAction(icons.icon(m.icon, 14), m.label)
            a.triggered.connect(lambda _=False, tt=t: editor.add_modifier(tt, onto=onto))
    return sub


def build_layer_menu(parent, editor, actions):
    """actions : dictionnaire des QAction de la fenêtre (raccourcis affichés)."""
    menu = QMenu(parent)
    sel = editor.top_selected()
    one = sel[0] if len(sel) == 1 else None
    for key in ("cut", "copy", "paste", "duplicate", "delete"):
        menu.addAction(actions[key])
    menu.addSeparator()
    menu.addAction(actions["group"])
    menu.addAction(actions["ungroup"])
    a = menu.addAction("Nouveau groupe vide")
    a.triggered.connect(editor.new_empty_group)
    menu.addSeparator()
    if sel:
        locked = all(n.locked for n in sel)
        a = menu.addAction("Déverrouiller" if locked else "Verrouiller")
        a.triggered.connect(lambda: editor.set_locked(sel, not locked))
        vis = all(n.visible for n in sel)
        a = menu.addAction("Masquer" if vis else "Afficher")
        a.triggered.connect(editor.toggle_visible_selected)
    if one is not None:
        a = menu.addAction("Renommer…")

        def rename():
            name = ask_text(parent, "Renommer", "Nom du calque :", one.name)
            if name:
                editor.rename(one, name)
        a.triggered.connect(rename)
    if sel:
        a = menu.addAction(icons.icon("rotate-ccw", 14), "Réinitialiser les réglages")
        a.setToolTip("Réglages par défaut (modifieurs) ; position, rotation, échelle et inclinaison d'origine (formes)")
        a.triggered.connect(lambda: editor.reset_params(sel))
    if any(n.kind != "modifier" for n in sel):
        a = menu.addAction("Retourner horizontalement")
        a.triggered.connect(lambda: editor.flip_selection(True))
        a = menu.addAction("Retourner verticalement")
        a.triggered.connect(lambda: editor.flip_selection(False))
    menu.addSeparator()
    add_modifier_menu(menu, editor, one)
    menu.addSeparator()
    a = menu.addAction("Créer une forme personnalisée…")
    a.setEnabled(bool(editor.current_root() and editor.current_root().children))

    def create():
        name = ask_text(parent, "Forme personnalisée", "Nom de la nouvelle forme :",
                        f"Forme {len(editor.doc.library.defs) + 1}")
        if name:
            editor.create_custom_shape(name)
    a.triggered.connect(create)
    if one is not None and one.kind == "instance":
        a = menu.addAction("Afficher cette forme")
        a.triggered.connect(lambda: editor.enter_def(one.def_id))
    menu.addSeparator()
    menu.addAction(actions["select_all"])
    return menu
