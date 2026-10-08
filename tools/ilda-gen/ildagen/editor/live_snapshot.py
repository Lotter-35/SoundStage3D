"""Instantané publié par l'interface pour le fil d'envoi live.

Le fil d'envoi ne lit JAMAIS le document de l'interface (qui peut changer à tout moment) : l'interface publie
une copie privée du document (refaite seulement quand le contenu change), l'espace actif (D11 : ce qui est
envoyé le suit), l'horloge du maître Vitesse, l'état du transport (Show), l'état d'exécution du Live (cues et
effets rapides) et les maîtres. Le fil calcule lui-même l'instant à montrer au moment exact de l'envoi.

- « forme » : la forme en cours au temps de boucle (oscillateurs, × maître Vitesse) ;
- « show »  : la timeline à la tête de lecture (en lecture ou non) ;
- « live »  : les cues en cours et les effets rapides maintenus.
Les maîtres s'appliquent ensuite, puis les réglages de sortie (fil d'envoi).
"""

import copy
import json
import time

from ..core.document import Document
from ..core.evaluator import evaluate_form, evaluate_timeline
from .live_runtime import evaluate_live


class Snapshot:
    """Ne change plus après sa création (partagé entre deux fils)."""

    __slots__ = ("doc_rev", "doc", "mode", "def_id", "t0", "clock", "runtime", "masters", "playing",
                 "anchor_pos", "anchor_wall", "loop", "length", "view_time", "default_color", "settings", "fps")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    def frame_time(self, now):
        """Instant à montrer à l'heure « now » (time.perf_counter)."""
        if self.mode == "live":
            return now                                 # heure murale : les cues gardent leur propre départ
        if self.mode != "show":
            # Forme en cours : temps de boucle (horloge du maître Vitesse)
            return self.clock.at(now) if self.clock is not None else now - (self.t0 or 0.0)
        if not self.playing:
            return self.view_time
        t = self.anchor_pos + (now - self.anchor_wall)
        if self.loop is not None:
            ls, le = self.loop
            if t >= le:
                t = ls + (t - ls) % (le - ls)
        elif t >= self.length:
            t = self.length                            # fin de la timeline : la lecture s'arrête là
        return t

    def masters_signature(self):
        return self.masters.signature() if self.masters is not None else None


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
    mode = editor.workspace
    return Snapshot(doc_rev=doc_rev, doc=doc, mode=mode, def_id=editor.current_form_id(),
                    t0=getattr(editor, "_t0", 0.0), clock=editor.clock.copy(),
                    runtime=editor.runtime.copy() if mode == "live" else None,
                    masters=editor.doc.masters.copy(), playing=playing, anchor_pos=pos, anchor_wall=wall,
                    loop=(tl.loop_start, tl.loop_end) if tl.loop_on and tl.loop_end > tl.loop_start else None,
                    length=tl.length(), view_time=editor.playhead, default_color=tuple(editor.default_color()),
                    settings=settings, fps=fps)


def evaluate_at(doc, snap, t):
    """Tracés à l'instant t (avant les maîtres) ; renvoie (tracés, dépend du temps)."""
    speed = snap.masters.speed if snap.masters is not None else 1.0
    if snap.mode == "show":
        strokes, _ = evaluate_timeline(doc.timeline, doc.library, t, snap.default_color, speed=speed)
        return strokes, True
    if snap.mode == "live":
        if snap.runtime is None:
            return [], True
        return evaluate_live(doc, snap.runtime, t, snap.default_color)
    d = doc.library.get(snap.def_id)
    if d is None:
        return [], False
    return evaluate_form(d, doc.library, t, doc.timeline.bpm, snap.default_color)
