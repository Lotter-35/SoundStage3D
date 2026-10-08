"""Export ILDA : animation de la timeline (si elle a des clips) sinon image fixe de la forme en cours.

Par défaut le fichier contient le contenu seul, SANS les réglages de sortie (taille / position, trapèze,
puissance, couleurs, zone de sécurité) : ce sont ceux d'un laser précis, le lecteur du fichier a les siens.
Chaque image respecte le budget de points (vitesse de balayage / cadence) et la limite du format ILDA.
"""

from ..core.evaluator import evaluate_form, evaluate_timeline
from ..laser.ilda_file import MAX_FRAMES, write_ilda
from ..laser.pipeline import MAX_ILDA_POINTS, render_frame


class ExportError(ValueError):
    """Export impossible (message en français pour l'utilisateur)."""


def frame_count(start, end, fps):
    return max(1, int(round((end - start) * fps)))


def export_frames(editor, start, end, fps, progress=None, corrections=False):
    """Liste des images (x, y, r, g, b). progress(i, n) peut renvoyer False pour annuler."""
    doc = editor.doc
    settings = editor.settings
    color = editor.default_color()
    tl = doc.timeline
    if not tl.has_clips() or end <= start:
        strokes, _ = evaluate_form(editor.current_form(), doc.library, 0.0, tl.bpm, color)   # pas de timeline : la forme en cours
        fr = render_frame(strokes, settings, fps, corrections, MAX_ILDA_POINTS)
        return [(fr.x, fr.y, fr.r, fr.g, fr.b)]
    n = frame_count(start, end, fps)
    if n > MAX_FRAMES:
        raise ExportError(f"{n} images à {fps} images/s : le format ILDA en accepte au plus {MAX_FRAMES}. "
                          "Réduisez la cadence ou exportez la zone de boucle.")
    frames = []
    order = None
    for i in range(n):
        t = start + i / fps
        strokes, _ = evaluate_timeline(tl, doc.library, t, color)
        fr = render_frame(strokes, settings, fps, corrections, MAX_ILDA_POINTS, order)
        order = fr.order                       # même ordre de tracé d'une image à l'autre (pas de scintillement)
        frames.append((fr.x, fr.y, fr.r, fr.g, fr.b))
        if progress is not None and progress(i + 1, n) is False:
            return None
    return frames


def export_ilda(editor, path, fmt, fps, start, end, progress=None, corrections=False):
    frames = export_frames(editor, start, end, fps, progress, corrections)
    if frames is None:
        return 0
    write_ilda(path, frames, fmt)
    return len(frames)


__all__ = ["export_ilda", "export_frames", "frame_count", "ExportError"]
