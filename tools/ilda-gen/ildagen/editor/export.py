"""Export ILDA : animation de la timeline (si elle a des clips) sinon image fixe de la forme en cours."""

import numpy as np

from ..core.evaluator import EvalContext, evaluate, evaluate_timeline
from ..laser.ilda_file import write_ilda
from ..laser.optimizer import build_points
from ..laser.output import apply_output


def frame_from_strokes(strokes, settings):
    pts, col = build_points(strokes, settings.section("laser"))
    return apply_output(pts, col, settings)


def export_frames(editor, start, end, fps, progress=None):
    """Liste des images (x, y, r, g, b). progress(i, n) peut renvoyer False pour annuler."""
    doc = editor.doc
    color = editor.default_color()
    if not doc.timeline.has_clips() or end <= start:
        ctx = EvalContext(doc.library, 0.0, doc.timeline.bpm, color)
        root = editor.current_form().root      # pas de timeline : la forme en cours
        return [frame_from_strokes(evaluate(root, ctx), editor.settings)]
    n = max(1, int(round((end - start) * fps)))
    frames = []
    for i in range(n):
        t = start + i / fps
        strokes, _ = evaluate_timeline(doc.timeline, doc.library, t, color)
        frames.append(frame_from_strokes(strokes, editor.settings))
        if progress is not None and progress(i + 1, n) is False:
            return None
    return frames


def export_ilda(editor, path, fmt, fps, start, end, progress=None):
    frames = export_frames(editor, start, end, fps, progress)
    if frames is None:
        return 0
    write_ilda(path, frames, fmt)
    return len(frames)


__all__ = ["export_ilda", "export_frames", "np"]
