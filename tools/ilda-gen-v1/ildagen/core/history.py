"""Annuler / rétablir par instantanés de l'état du document.

Chaque étape garde l'état complet d'avant. La comparaison « quelque chose a-t-il changé ? » se fait sur le
contenu seul (fonction `strip`) : l'état d'affichage (grille, dépliage…) ne crée jamais d'étape.
"""

import json
import logging
import time

MAX_STEPS = 200
MERGE_WINDOW = 0.6    # s : deux modifications « fusionnables » plus rapprochées font une seule étape

log = logging.getLogger(__name__)


class Step:
    __slots__ = ("label", "before", "merge", "time")

    def __init__(self, label, before, merge=None):
        self.label = label
        self.before = before       # instantané json (état complet)
        self.merge = merge         # clé de fusion (ex. flèches répétées sur la même sélection)
        self.time = time.monotonic()


class History:
    def __init__(self, strip=None):
        self.undo_stack = []   # [Step]
        self.redo_stack = []   # [(libellé, instantané json)]
        self._pending = None   # (libellé, instantané complet, instantané du contenu)
        self._strip = strip    # état → contenu seul (sans l'état d'affichage)
        self._last = None      # dernière étape enregistrée (seule fusionnable)

    def clear(self):
        self.undo_stack.clear()
        self.redo_stack.clear()
        self._pending = None
        self._last = None

    @staticmethod
    def snapshot(state):
        return json.dumps(state, ensure_ascii=False, separators=(",", ":"))

    def _content(self, state):
        return self.snapshot(self._strip(state) if self._strip else state)

    def begin(self, label, state):
        """À appeler AVANT une modification (une seule fois pour un glisser complet).

        Une étape encore ouverte (geste jamais terminé) n'est jamais fusionnée avec la nouvelle :
        elle est enregistrée à part."""
        if self._pending is not None:
            log.warning("Étape « %s » restée ouverte : enregistrée à part avant « %s »", self._pending[0], label)
            self.commit(state)
        self._pending = (label, self.snapshot(state), self._content(state))

    def pending(self):
        return self._pending is not None

    def pending_label(self):
        return self._pending[0] if self._pending is not None else None

    def commit(self, state, merge=None):
        """À appeler APRÈS la modification : mémorise l'état d'avant si le contenu a changé.

        merge : clé de fusion ; si la dernière étape a la même clé et date de moins de MERGE_WINDOW,
        la modification la prolonge (une seule étape pour une touche maintenue)."""
        if self._pending is None:
            return False
        label, before, content = self._pending
        self._pending = None
        if content == self._content(state):
            return False
        last = self._last
        now = time.monotonic()
        if merge is not None and last is not None and self.undo_stack and self.undo_stack[-1] is last \
                and last.merge == merge and now - last.time <= MERGE_WINDOW:
            last.time = now
            self.redo_stack.clear()
            return True
        step = Step(label, before, merge)
        self.undo_stack.append(step)
        self._last = step
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

    def abort(self, state):
        """Abandonne la modification en cours ; renvoie l'état d'avant seulement si le contenu a changé
        (sinon None : rien à restaurer)."""
        if self._pending is None:
            return None
        _, before, content = self._pending
        self._pending = None
        return json.loads(before) if content != self._content(state) else None

    def undo(self, current_state):
        if not self.undo_stack:
            return None
        step = self.undo_stack.pop()
        self._last = None
        self.redo_stack.append((step.label, self.snapshot(current_state)))
        return json.loads(step.before)

    def redo(self, current_state):
        if not self.redo_stack:
            return None
        label, after = self.redo_stack.pop()
        self._last = None
        self.undo_stack.append(Step(label, self.snapshot(current_state)))
        return json.loads(after)

    def undo_label(self):
        return self.undo_stack[-1].label if self.undo_stack else ""

    def redo_label(self):
        return self.redo_stack[-1][0] if self.redo_stack else ""
