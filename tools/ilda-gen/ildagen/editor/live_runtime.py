"""État d'exécution de l'espace Live (jamais enregistré, hors annulation) et évaluation de sa sortie.

- cues en cours : départ quantifié selon le mode (immédiat, au prochain temps, à la prochaine mesure) sur la
  grille du tempo (`origin` = heure murale d'un début de mesure, `timeline.bpm`) ; un cue lancé avant son
  départ est « en attente » ;
- un seul cue à la fois (`multi` coupé) : lancer un cue arrête le précédent au départ du nouveau ;
- effets rapides maintenus : appliqués à toute la sortie Live, tant qu'on les tient.

Les heures sont celles de time.perf_counter ; le temps des formes et des effets passe par l'horloge du maître
Vitesse (SpeedClock) : changer la vitesse ne fait pas sauter les animations.
"""

import math

from ..core.effects import get as get_effect
from ..core.evaluator import EvalContext, evaluate
from ..core.live import QUICK_BY_ID, QUICK_EFFECTS
from ..core.masters import SpeedClock
from ..core.oscillator import osc_overrides

LATE = 0.001     # appui jusqu'à 1 ms après un temps : le cue part sur ce temps


class PlayingCue:
    __slots__ = ("cue_id", "def_id", "start", "s_start", "stop")

    def __init__(self, cue_id, def_id, start, s_start, stop=math.inf):
        self.cue_id = cue_id
        self.def_id = def_id
        self.start = start          # heure murale du départ (quantifié)
        self.s_start = s_start      # temps de l'horloge Vitesse au départ
        self.stop = stop            # heure murale de l'arrêt (inf : jusqu'à nouvel ordre)

    def copy(self):
        return PlayingCue(self.cue_id, self.def_id, self.start, self.s_start, self.stop)


class LiveRuntime:
    def __init__(self, clock=None, origin=0.0):
        self.clock = clock if clock is not None else SpeedClock()
        self.origin = origin        # heure murale d'un début de mesure (grille des départs calés)
        self.cues = {}              # {id du cue: PlayingCue}
        self.held = {}              # {id d'effet rapide: temps de l'horloge Vitesse à l'appui}

    def copy(self):
        r = LiveRuntime(self.clock.copy(), self.origin)
        r.cues = {k: v.copy() for k, v in self.cues.items()}
        r.held = dict(self.held)
        return r

    # ── Grille du tempo ─────────────────────────────────────────────────
    def next_start(self, now, launch, bpm, beats_per_bar=4):
        """Heure du départ d'un cue lancé à `now` : tout de suite, au prochain temps ou à la prochaine mesure."""
        if launch <= 0:
            return now
        step = 60.0 / max(1.0, float(bpm)) * (1 if launch == 1 else max(1, int(beats_per_bar)))
        n = math.ceil((now - self.origin - LATE) / step)
        return self.origin + n * step

    # ── État ─────────────────────────────────────────────────────────────
    def state(self, cue_id, now):
        """« playing », « waiting » (départ à venir) ou None."""
        pc = self.cues.get(cue_id)
        if pc is None or now >= pc.stop:
            return None
        return "waiting" if now < pc.start else "playing"

    def active(self, now):
        return sorted((pc for pc in self.cues.values() if pc.start <= now < pc.stop), key=lambda pc: pc.start)

    def waiting(self, now):
        return [pc for pc in self.cues.values() if now < pc.start and pc.start < pc.stop]

    def cleanup(self, now):
        """Oublie les cues arrêtés."""
        for k in [k for k, pc in self.cues.items() if now >= pc.stop]:
            del self.cues[k]

    # ── Commandes ────────────────────────────────────────────────────────
    def trigger(self, cue_id, def_id, now, launch, multi, bpm, beats_per_bar=4):
        """Lance un cue (ou l'arrête s'il est déjà en cours / en attente). Renvoie True s'il est lancé."""
        self.cleanup(now)
        st = self.state(cue_id, now)
        if st == "waiting":
            del self.cues[cue_id]                       # en attente : annulé
            return False
        if st == "playing":
            self.cues[cue_id].stop = self.next_start(now, launch, bpm, beats_per_bar)
            return False
        start = self.next_start(now, launch, bpm, beats_per_bar)
        if not multi:
            # Un seul cue : les autres s'arrêtent au départ du nouveau (ceux en attente sont annulés)
            for k, pc in list(self.cues.items()):
                if pc.start >= start:
                    del self.cues[k]
                else:
                    pc.stop = min(pc.stop, start)
        self.cues[cue_id] = PlayingCue(cue_id, def_id, start, self.clock.at(start))
        return True

    def stop(self, cue_id):
        self.cues.pop(cue_id, None)

    def stop_all(self):
        self.cues.clear()

    def hold(self, qid, now):
        if qid in QUICK_BY_ID and qid not in self.held:
            self.held[qid] = self.clock.at(now)

    def release(self, qid):
        self.held.pop(qid, None)

    def set_speed(self, speed, now):
        """Maître Vitesse changé : l'horloge repart de sa valeur actuelle ; les cues en attente se recalent."""
        self.clock.set_speed(speed, now)
        for pc in self.cues.values():
            if pc.start > now:
                pc.s_start = self.clock.at(pc.start)


def quick_values(q, etype, t, bpm):
    """Réglages d'un effet rapide maintenu depuis t secondes (attaque progressive, oscillateurs)."""
    out = {}
    defaults = etype.mod.defaults() if etype.mod is not None else {}
    for sp in etype.params():
        if sp.key not in q.values and sp.key not in q.oscs:
            continue
        v = q.values.get(sp.key, sp.default_value())
        if q.attack > 0 and sp.kind in ("float", "int") and sp.key in q.values:
            neutral = float(defaults.get(sp.key, v))
            v = neutral + (float(v) - neutral) * min(1.0, max(0.0, t) / q.attack)
        osc = q.oscs.get(sp.key)
        if osc is not None:
            v = osc.value(v, t, sp, bpm, 0.0)
        out[sp.key] = sp.clamp(v)
    return out


def evaluate_live(doc, runtime, now, default_color=(1.0, 1.0, 1.0)):
    """Sortie Live à l'heure `now` : chaque cue en cours (sa forme au temps local depuis son départ,
    oscillateurs compris), puis les effets rapides maintenus. Renvoie (tracés, animé)."""
    bpm = doc.timeline.bpm
    s_now = runtime.clock.at(now)
    strokes = []
    for pc in runtime.active(now):
        d = doc.library.get(pc.def_id)
        if d is None:
            continue
        local = max(0.0, s_now - pc.s_start)
        ctx = EvalContext(doc.library, local, bpm, default_color, None, 0.0)
        ctx.overrides = osc_overrides(d.root, local, ctx, 0.0)
        strokes.extend(evaluate(d.root, ctx))
    for q in QUICK_EFFECTS:
        if q.id not in runtime.held:
            continue
        et = get_effect(q.type_id)
        if et is None:
            continue
        t = max(0.0, s_now - runtime.held[q.id])
        ctx = EvalContext(doc.library, t, bpm, default_color, None, 0.0)
        strokes = et.apply(strokes, quick_values(q, et, t, bpm), ctx)
    return strokes, True
