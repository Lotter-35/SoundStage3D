"""Écriture de fichiers sans risque : fichier temporaire puis renommage (jamais de fichier à moitié écrit)."""

import json
import os
import tempfile


def write_json(path, data, **dump_args):
    """Écrit `data` en JSON dans `path` de façon atomique (l'ancien fichier reste intact en cas d'erreur)."""
    folder = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=os.path.splitext(path)[1], dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, **dump_args)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, _mode(path))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _mode(path):
    """Droits du fichier remplacé (ou droits habituels d'un nouveau fichier)."""
    try:
        return os.stat(path).st_mode & 0o777
    except OSError:
        umask = os.umask(0)
        os.umask(umask)
        return 0o666 & ~umask
