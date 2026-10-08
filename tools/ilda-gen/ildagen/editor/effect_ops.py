"""Opérations sur les effets d'animation des clips (espace Show) : ajouter, retirer, réordonner, cible,
mode de chaque réglage (fixe / courbe / oscillateur), valeurs et clés de courbe.

Un effet est désigné par son identifiant (unique dans le projet) ; il appartient à l'animation d'un clip,
partagée par les clips liés (D5). Les clés de courbe sont en proportion 0..1 de la durée du clip.
"""

from ..core import nodes as N
from ..core.animation import MODE_IDS, new_effect
from ..core.automation import CURVE_LABELS, Keyframe
from ..core.effects import SHAPE_PARAM, effect_spec, get as get_effect
from ..core.oscillator import Osc, can_oscillate
from ..core.param_specs import param_spec


class EffectOpsMixin:
    # ── Repérage ─────────────────────────────────────────────────────────
    def find_effect(self, effect_id):
        """(animation, effet) ou (None, None)."""
        return self.doc.timeline.find_effect(effect_id)

    def effect_root(self, anim):
        """Racine de la forme jouée par une animation (celle de ses clips)."""
        tl = self.doc.timeline
        clips = tl.clips_of_anim(anim.id) if anim is not None else []
        d = self.doc.library.get(clips[0].def_id) if clips else None
        return d.root if d is not None else None

    def effect_param_spec(self, effect_id, key):
        """ParamSpec d'un réglage d'effet (« value » de « Réglage de la forme » : celui du réglage visé)."""
        anim, e = self.find_effect(effect_id)
        if e is None:
            return None
        return effect_spec(e, key, self.effect_root(anim))

    def clip_animation(self, clip_id):
        tl = self.doc.timeline
        _, clip = tl.find_clip(clip_id)
        return tl.attach(clip) if clip is not None else None

    def _track(self, effect_id, key):
        _, e = self.find_effect(effect_id)
        return e.params.get(key) if e is not None else None

    # ── Effets ───────────────────────────────────────────────────────────
    def add_effect(self, clip_id, type_id, target="", key="", index=None):
        """Ajoute un effet à l'animation du clip (et donc à ses clips liés). « Réglage de la forme » : target =
        calque, key = réglage. Renvoie l'effet, ou None."""
        tl = self.doc.timeline
        _, clip = tl.find_clip(clip_id)
        if clip is None or get_effect(type_id) is None:
            return None
        d = self.doc.library.get(clip.def_id)
        base = spec = None
        if target:
            node = d.root.find(target) if d is not None else None
            if node is None:
                self.statusMessage.emit("Ce calque n'est pas dans la forme du clip")
                return None
            if type_id == SHAPE_PARAM:
                spec = param_spec(node, key)
                if spec is None:
                    self.statusMessage.emit("Réglage inconnu pour ce calque")
                    return None
                base = N.get_param(node, key)
        e = new_effect(type_id, target, key if type_id == SHAPE_PARAM else "", base, spec)

        def do():
            anim = tl.attach(clip)
            anim.effects.insert(len(anim.effects) if index is None else max(0, int(index)), e)
        self.timeline_mutate("Ajouter un effet", do)
        return e

    def remove_effect(self, effect_id):
        anim, e = self.find_effect(effect_id)
        if e is not None:
            self.timeline_mutate("Retirer l'effet", lambda: anim.effects.remove(e))

    def move_effect(self, effect_id, index):
        """Change la place d'un effet dans la liste (appliqués de haut en bas)."""
        anim, e = self.find_effect(effect_id)
        if e is None:
            return
        index = max(0, min(len(anim.effects) - 1, int(index)))
        if anim.effects.index(e) != index:
            self.timeline_mutate("Déplacer l'effet", lambda: (anim.effects.remove(e), anim.effects.insert(index, e)))

    def set_effect_target(self, effect_id, target, key=None):
        """Cible d'un effet : "" = toute la forme, sinon un calque de la forme. « Réglage de la forme » : key
        change aussi le réglage animé (sa valeur repart de celle du calque)."""
        anim, e = self.find_effect(effect_id)
        if e is None:
            return
        root = self.effect_root(anim)
        node = root.find(target) if (root is not None and target) else None
        if target and node is None:
            return
        new_key = e.key if key is None else key
        changed = (target or "") != e.target or new_key != e.key

        def do():
            e.target = target or ""
            if e.type_id == SHAPE_PARAM and node is not None and changed:
                # Autre réglage visé : sa valeur repart de celle du calque
                spec = param_spec(node, new_key)
                if spec is not None:
                    fresh = new_effect(SHAPE_PARAM, e.target, new_key, N.get_param(node, new_key), spec)
                    e.key = new_key
                    e.params = fresh.params
        self.timeline_mutate("Cible de l'effet", do)

    def set_effect_enabled(self, effect_id, on):
        _, e = self.find_effect(effect_id)
        if e is not None and e.enabled != bool(on):
            self.timeline_mutate("Activer l'effet" if on else "Couper l'effet", lambda: setattr(e, "enabled", bool(on)))

    # ── Réglages d'un effet ──────────────────────────────────────────────
    def set_track_mode(self, effect_id, key, mode):
        """Fixe / courbe / oscillateur. Une courbe vide part de deux clés (début, fin) à la valeur fixe ; un
        oscillateur vide prend les réglages par défaut du réglage (numérique seulement)."""
        t = self._track(effect_id, key)
        spec = self.effect_param_spec(effect_id, key)
        if t is None or mode not in MODE_IDS or t.mode == mode:
            return
        if mode == "osc" and not can_oscillate(spec):
            self.statusMessage.emit("Seuls les réglages numériques peuvent osciller")
            return

        def do():
            t.mode = mode
            if mode == "courbe" and not t.curve.keys:
                t.curve.discrete = spec is not None and spec.kind in ("bool", "enum")
                t.curve.set_key(0.0, t.value)
                t.curve.set_key(1.0, t.value)
            elif mode == "osc" and t.osc is None:
                t.osc = Osc.default_for(spec)
        self._tl_edit("Mode du réglage", do)

    def set_track_value(self, effect_id, key, value):
        """Valeur fixe (et centre de l'oscillateur) d'un réglage d'effet, bornée par son ParamSpec."""
        t = self._track(effect_id, key)
        if t is None:
            return
        spec = self.effect_param_spec(effect_id, key)
        v = spec.clamp(value) if spec is not None else value
        self._tl_edit("Réglage de l'effet", lambda: setattr(t, "value", v))

    def set_track_osc(self, effect_id, key, osc):
        t = self._track(effect_id, key)
        if t is not None and isinstance(osc, Osc):
            self._tl_edit("Oscillateur de l'effet", lambda: setattr(t, "osc", osc.copy()))

    # ── Clés de courbe (u = 0..1 de la durée du clip) ────────────────────
    def set_curve_key(self, effect_id, key, u, v):
        """Ajoute (ou remplace) une clé ; renvoie son indice."""
        t = self._track(effect_id, key)
        if t is None:
            return None
        spec = self.effect_param_spec(effect_id, key)
        u = min(1.0, max(0.0, float(u)))
        v = spec.clamp(v) if spec is not None else v
        res = []
        self._tl_edit("Clé de courbe", lambda: res.append(t.curve.set_key(u, v)))
        return t.curve.keys.index(res[0]) if res else None

    def move_curve_key(self, effect_id, key, index, u=None, v=None):
        """Déplace une clé (instant et / ou valeur) ; renvoie son nouvel indice."""
        t = self._track(effect_id, key)
        if t is None or not 0 <= index < len(t.curve.keys):
            return None
        k = t.curve.keys[index]
        spec = self.effect_param_spec(effect_id, key)

        def do():
            if u is not None:
                k.t = min(1.0, max(0.0, float(u)))
            if v is not None:
                k.v = spec.clamp(v) if spec is not None else v
            t.curve.sort()
        self._tl_edit("Déplacer la clé", do)
        return t.curve.keys.index(k)

    def remove_curve_key(self, effect_id, key, index):
        t = self._track(effect_id, key)
        if t is not None and 0 <= index < len(t.curve.keys):
            k = t.curve.keys[index]
            self._tl_edit("Supprimer la clé", lambda: t.curve.keys.remove(k))

    def set_curve_type(self, effect_id, key, index, curve, handles=None):
        """Type de courbe d'une clé (vers la suivante) : linear, ease_in, ease_out, ease_in_out, hold, custom."""
        t = self._track(effect_id, key)
        if t is None or not 0 <= index < len(t.curve.keys) or curve not in CURVE_LABELS:
            return
        k = t.curve.keys[index]

        def do():
            k.curve = curve
            if handles is not None:
                k.h = [float(x) for x in handles][:4]
        self._tl_edit("Type de courbe", do)

    def reset_curve(self, effect_id, key):
        """Courbe remise à plat : une seule clé (début du clip) à la valeur fixe."""
        t = self._track(effect_id, key)
        if t is not None:
            self._tl_edit("Réinitialiser la courbe",
                          lambda: setattr(t.curve, "keys", [Keyframe(0.0, t.value, "hold" if t.curve.discrete else "linear")]))
