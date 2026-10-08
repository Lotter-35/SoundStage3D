"""Sauvegardes automatiques d'un projet sans nom : jamais écrasées sans copie.

Avant que la sauvegarde automatique ne reçoive un AUTRE travail (nouveau projet, projet rouvert…), l'ancienne
est rangée dans un dossier de copies datées ; on garde les KEEP plus récentes
(Fichier → Récupérer une sauvegarde automatique…).
"""

import json
import os
import time

from .atomic import write_json

KEEP = 10
PREFIX = "sans-nom-"


def backup_dir(config):
    path = os.path.join(config, "sauvegardes-auto")
    os.makedirs(path, exist_ok=True)
    return path


def _has_content(d):
    """Le projet contient-il quelque chose (un calque, un clip, une musique) ?"""
    if not isinstance(d, dict):
        return True        # illisible : on le garde par prudence
    for dfn in d.get("library") or []:
        root = dfn.get("root") if isinstance(dfn, dict) else None
        if not isinstance(root, dict) or root.get("children"):
            return True
    tl = d.get("timeline") if isinstance(d.get("timeline"), dict) else {}
    if tl.get("audio_path"):
        return True
    return any(isinstance(tr, dict) and tr.get("clips") for tr in tl.get("tracks") or [])


def rotate(autosave_path, folder, keep=KEEP):
    """Range la sauvegarde automatique actuelle dans `folder` (copie datée) ; renvoie le chemin de la copie
    ou None (pas de fichier, ou projet vide)."""
    try:
        with open(autosave_path, encoding="utf-8") as f:
            d = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        d = None
    if d is not None and not _has_content(d):
        return None
    now = time.time()
    stamp = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime(now)) + f".{int(now * 1000) % 1000:03d}"
    dest = os.path.join(folder, f"{PREFIX}{stamp}.ildaproj")
    n = 2
    while os.path.exists(dest):
        dest = os.path.join(folder, f"{PREFIX}{stamp}-{n}.ildaproj")
        n += 1
    if d is None:
        # Fichier illisible : copié tel quel
        with open(autosave_path, "rb") as src, open(dest, "wb") as out:
            out.write(src.read())
    else:
        tl = d.get("timeline")
        ap = tl.get("audio_path") if isinstance(tl, dict) else None
        if isinstance(ap, str) and ap and not os.path.isabs(ap):
            # Chemin de la musique relatif à l'ancien emplacement : rendu absolu
            tl["audio_path"] = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(autosave_path)), ap))
        write_json(dest, d, separators=(",", ":"))
    prune(folder, keep)
    return dest


def backups(folder):
    """Copies datées, de la plus récente à la plus ancienne."""
    try:
        names = [n for n in os.listdir(folder) if n.startswith(PREFIX) and n.endswith(".ildaproj")]
    except OSError:
        return []
    return [os.path.join(folder, n) for n in sorted(names, reverse=True)]     # noms datés : ordre chronologique


def prune(folder, keep=KEEP):
    for p in backups(folder)[keep:]:
        try:
            os.remove(p)
        except OSError:
            pass
