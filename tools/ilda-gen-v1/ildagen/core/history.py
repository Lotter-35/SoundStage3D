"""Annuler / rétablir par instantanés de l'état du document."""

import json

MAX_STEPS = 200


class History:
    def __init__(self):
        self.undo_stack = []   # [(libellé, instantané json)]
        self.redo_stack = []
        self._pending = None

    def clear(self):
        self.undo_stack.clear()
        self.redo_stack.clear()
        self._pending = None

    @staticmethod
    def snapshot(state):
        return json.dumps(state, ensure_ascii=False, separators=(",", ":"))

    def begin(self, label, state):
        """À appeler AVANT une modification (une seule fois pour un glisser complet)."""
        if self._pending is None:
            self._pending = (label, self.snapshot(state))

    def pending(self):
        return self._pending is not None

    def commit(self, state):
        """À appeler APRÈS la modification : mémorise l'état d'avant si quelque chose a changé."""
        if self._pending is None:
            return False
        label, before = self._pending
        self._pending = None
        if before == self.snapshot(state):
            return False
        self.undo_stack.append((label, before))
        if len(self.undo_stack) > MAX_STEPS:
            self.undo_stack.pop(0)
        self.redo_stack.clear()
        return True

    def cancel(self):
        """Abandonne la modification en cours ; renvoie l'état d'avant (json) ou None."""
        if self._pending is None:
            return None
        before = self._pending[1]
        self._pending = None
        return json.loads(before)

    def undo(self, current_state):
        if not self.undo_stack:
            return None
        label, before = self.undo_stack.pop()
        self.redo_stack.append((label, self.snapshot(current_state)))
        return json.loads(before)

    def redo(self, current_state):
        if not self.redo_stack:
            return None
        label, after = self.redo_stack.pop()
        self.undo_stack.append((label, self.snapshot(current_state)))
        return json.loads(after)

    def undo_label(self):
        return self.undo_stack[-1][0] if self.undo_stack else ""

    def redo_label(self):
        return self.redo_stack[-1][0] if self.redo_stack else ""
