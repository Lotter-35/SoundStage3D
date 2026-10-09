"""Mémoriser / restaurer la disposition des séparateurs d'un espace (tailles jamais réduites à zéro)."""

from PySide6.QtCore import QByteArray


def save_splits(splits):
    return {k: bytes(s.saveState().toBase64()).decode() for k, s in splits.items()}


def restore_splits(splits, state):
    if not isinstance(state, dict):
        return
    for k, s in splits.items():
        v = state.get(k)
        if not isinstance(v, str):
            continue
        before = s.sizes()
        try:
            s.restoreState(QByteArray.fromBase64(v.encode()))
        except (TypeError, ValueError):
            continue
        # Un panneau mémorisé à zéro (ancienne disposition) : on garde les tailles d'origine
        if any(x == 0 for x in s.sizes()):
            s.setSizes(before)
