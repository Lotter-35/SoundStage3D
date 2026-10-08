"""Instantané publié par l'interface pour le fil d'envoi live.

Le fil d'envoi ne lit JAMAIS le document de l'interface (qui peut changer à tout moment) : l'interface publie
une copie privée du document (refaite seulement quand le contenu change), ce qu'il faut montrer (forme en
cours ou timeline) et l'état du transport (lecture, position et heure de référence, boucle). Le fil calcule
lui-même l'instant à montrer au moment exact de l'envoi.
"""

import copy
import json
import time

from ..core.document import Document
from ..core.evaluator import EvalContext, evaluate, evaluate_timeline


class Snapshot:
    """Ne change plus après sa création (partagé entre deux fils)."""

    __slots__ = ("doc_rev", "doc", "mode", "def_id", "t0", "playing", "anchor_pos", "anchor_wall", "loop",
                 "length", "view_time", "preview", "hold", "default_color", "settings", "fps")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    def frame_time(self, now):
        """Instant à montrer à l'heure « now » (time.perf_counter)."""
        if self.mode != "timeline":
            return now - self.t0                       # forme en cours : animations à l'heure murale
        if self.preview or not self.playing:
            return self.view_time
        t = self.anchor_pos + (now - self.anchor_wall)
        if self.loop is not None:
            ls, le = self.loop
            if t >= le:
                t = ls + (t - ls) % (le - ls)
        elif t >= self.length:
            t = self.length                            # fin de la timeline : la lecture s'arrête là
        return t


def copy_document(doc):
    """Copie privée du document pour le fil d'envoi (copie profonde : rapide, même pour un gros projet)."""
    try:
        return copy.deepcopy(doc)
    except Exception:              # objet non copiable ajouté un jour au document : passage par le format projet
        d = Document()
        d.load_dict(json.loads(json.dumps(doc.to_dict())))
        return d


def take(editor, playback, doc, doc_rev, settings, fps):
    """Instantané de l'état de l'éditeur (à appeler depuis l'interface)."""
    tl = editor.doc.timeline
    if playback is not None:
        playing, pos, wall = playback.transport()
    else:
        playing, pos, wall = editor.playing, editor.playhead, time.perf_counter()
    preview = editor.preview_time is not None
    return Snapshot(doc_rev=doc_rev, doc=doc, mode=editor.display_mode(),
                    def_id=editor.current_form_id(), t0=getattr(editor, "_t0", 0.0), playing=playing,
                    anchor_pos=pos, anchor_wall=wall,
                    loop=(tl.loop_start, tl.loop_end) if tl.loop_on and tl.loop_end > tl.loop_start else None,
                    length=tl.length(), view_time=editor.view_time(), preview=preview,
                    hold=editor.preview_clip if preview else None, default_color=tuple(editor.default_color()),
                    settings=settings, fps=fps)


def evaluate_at(doc, snap, t):
    """Tracés à l'instant t ; renvoie (tracés, dépend du temps)."""
    if snap.mode == "timeline":
        strokes, _ = evaluate_timeline(doc.timeline, doc.library, t, snap.default_color, hold=snap.hold)
        return strokes, True
    d = doc.library.get(snap.def_id)
    if d is None:
        return [], False
    ctx = EvalContext(doc.library, t, doc.timeline.bpm, snap.default_color, None, doc.timeline.bar_offset)
    return evaluate(d.root, ctx), ctx.animated
