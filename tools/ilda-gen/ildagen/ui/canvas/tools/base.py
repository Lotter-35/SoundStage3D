"""Base des outils de la mire."""

from PySide6.QtCore import Qt


class ToolEvent:
    __slots__ = ("world", "screen", "button", "shift", "ctrl", "alt")

    def __init__(self, world, screen, button, mods):
        self.world = world
        self.screen = screen
        self.button = button
        self.shift = bool(mods & Qt.KeyboardModifier.ShiftModifier)
        # Sur Mac, Qt appelle « Control » la touche Cmd et « Meta » la touche Ctrl : les deux sont acceptées
        self.ctrl = bool(mods & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.MetaModifier))
        self.alt = bool(mods & Qt.KeyboardModifier.AltModifier)


class Tool:
    name = ""

    def __init__(self, view):
        self.view = view
        self.editor = view.editor

    @property
    def vt(self):
        return self.view.vt

    def press(self, ev):
        pass

    def move(self, ev):
        pass

    def release(self, ev):
        pass

    def hover(self, ev):
        pass

    def double_click(self, ev):
        pass

    def key_press(self, key, mods):
        return False

    def modifiers_changed(self, mods):
        pass

    def draw(self, p):
        pass

    def deactivate(self):
        pass

    def cursor(self):
        return Qt.CursorShape.CrossCursor

    def insert_target(self):
        """Parent et position d'insertion d'un nouveau calque."""
        return self.editor.insertion_point()
