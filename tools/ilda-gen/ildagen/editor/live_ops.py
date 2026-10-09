"""Opérations de l'espace Live (pages, cues, lancement, effets rapides) et des maîtres.

Les pages et les cues font partie du projet (annulables). Lancer / arrêter un cue, tenir un effet rapide,
la page affichée et les maîtres n'entrent jamais dans l'historique.
"""

import time

from ..core.live import QUICK_BY_ID, QUICK_KEYS, SLOTS, Cue, Page, default_key, normalize_key


class LiveOpsMixin:
    def _live_mutate(self, label, fn):
        res = self.mutate(label, fn, structure=False)
        self.liveChanged.emit()
        return res

    def _runtime_changed(self):
        self._touch(content=False)
        self.liveChanged.emit()
        self.docChanged.emit()

    # ── Pages ────────────────────────────────────────────────────────────
    def live_page(self):
        """Page affichée (état d'affichage)."""
        live = self.doc.live
        return live.find_page(self.doc.view.get("live_page")) or live.pages[0]

    def set_live_page(self, page_id):
        if self.doc.live.find_page(page_id) is not None and self.doc.view.get("live_page") != page_id:
            self.doc.view["live_page"] = page_id
            self.view_changed()
            self.liveChanged.emit()

    def add_page(self, name=None):
        live = self.doc.live
        p = Page(name or live.next_page_name())
        self._live_mutate("Nouvelle page", lambda: live.pages.append(p))
        self.set_live_page(p.id)
        return p

    def remove_page(self, page_id):
        live = self.doc.live
        p = live.find_page(page_id)
        if p is None:
            return

        def do():
            live.pages.remove(p)
            if not live.pages:
                live.pages.append(Page("Page 1"))
        for c in p.cues:
            if c is not None:
                self.runtime.stop(c.id)
        self._live_mutate("Supprimer la page", do)

    def rename_page(self, page_id, name):
        p = self.doc.live.find_page(page_id)
        name = (name or "").strip()
        if p is not None and name and name != p.name:
            self._live_mutate("Renommer la page", lambda: setattr(p, "name", name))

    def move_page(self, page_id, index):
        live = self.doc.live
        p = live.find_page(page_id)
        if p is None:
            return
        index = max(0, min(len(live.pages) - 1, int(index)))
        if live.pages.index(p) != index:
            self._live_mutate("Déplacer la page", lambda: (live.pages.remove(p), live.pages.insert(index, p)))

    # ── Cues ─────────────────────────────────────────────────────────────
    def set_cue(self, page_id, slot, def_id):
        """Place une forme dans une case (touche par défaut de la case, ou celle du cue remplacé)."""
        p = self.doc.live.find_page(page_id)
        if p is None or not 0 <= slot < SLOTS or self.doc.library.get(def_id) is None:
            return None
        old = p.cues[slot]
        key = old.key if old is not None else default_key(slot)
        if any(c is not None and c is not old and c.key == key for c in p.cues):
            key = ""                     # touche déjà prise par une autre case de la page
        cue = Cue(def_id, key)
        if old is not None:
            self.runtime.stop(old.id)
        self._live_mutate("Placer un cue", lambda: p.cues.__setitem__(slot, cue))
        return cue

    def clear_cue(self, page_id, slot):
        p = self.doc.live.find_page(page_id)
        if p is None or not 0 <= slot < SLOTS or p.cues[slot] is None:
            return
        self.runtime.stop(p.cues[slot].id)
        self._live_mutate("Vider la case", lambda: p.cues.__setitem__(slot, None))

    def move_cue(self, page_id, src, dst):
        """Glisser un cue vers une autre case de la page (les deux cases s'échangent)."""
        p = self.doc.live.find_page(page_id)
        if p is None or src == dst or not (0 <= src < SLOTS and 0 <= dst < SLOTS) or p.cues[src] is None:
            return

        def do():
            p.cues[src], p.cues[dst] = p.cues[dst], p.cues[src]
        self._live_mutate("Déplacer le cue", do)

    def set_cue_key(self, cue_id, key):
        """Touche du clavier d'un cue (une seule case par touche sur la page : l'autre la perd)."""
        page, _, cue = self.doc.live.find_cue(cue_id)
        key = normalize_key(key)
        if key and key in QUICK_KEYS:
            self.statusMessage.emit("Les touches 1 à 8 tiennent les effets rapides : choisissez une autre touche")
            return
        if cue is None or key == cue.key:
            return

        def do():
            for c in page.cues:
                if c is not None and c is not cue and key and c.key == key:
                    c.key = ""
            cue.key = key
        self._live_mutate("Touche du cue", do)

    def set_launch(self, mode):
        """Départ : 0 immédiat, 1 au prochain temps, 2 à la prochaine mesure."""
        live = self.doc.live
        mode = int(mode)
        if 0 <= mode <= 2 and mode != live.launch:
            self._live_mutate("Mode de départ", lambda: setattr(live, "launch", mode))

    def set_multi(self, on):
        live = self.doc.live
        if bool(on) != live.multi:
            self._live_mutate("Plusieurs cues", lambda: setattr(live, "multi", bool(on)))

    # ── Lancement (hors annulation) ──────────────────────────────────────
    def trigger_cue(self, cue_id, now=None):
        """Lance un cue (départ calé selon le mode), ou l'arrête s'il joue / attend. Renvoie True s'il part."""
        _, _, cue = self.doc.live.find_cue(cue_id)
        if cue is None:
            return False
        live, tl = self.doc.live, self.doc.timeline
        now = time.perf_counter() if now is None else now
        started = self.runtime.trigger(cue.id, cue.def_id, now, live.launch, live.multi, tl.bpm, tl.beats_per_bar)
        self._runtime_changed()
        return started

    def trigger_key(self, key, now=None):
        """Touche du clavier : lance le cue de la page affichée qui a cette touche. Renvoie le cue ou None."""
        cue = self.live_page().cue_for_key(key)
        if cue is not None:
            self.trigger_cue(cue.id, now)
        return cue

    def stop_cue(self, cue_id):
        self.runtime.stop(cue_id)
        self._runtime_changed()

    def stop_all_cues(self):
        self.runtime.stop_all()
        self.runtime.held.clear()
        self._runtime_changed()

    def cue_state(self, cue_id, now=None):
        """« playing », « waiting » ou None."""
        return self.runtime.state(cue_id, time.perf_counter() if now is None else now)

    def hold_quick(self, qid, now=None):
        """Effet rapide maintenu (bouton ou touche enfoncés)."""
        if qid in QUICK_BY_ID:
            self.runtime.hold(qid, time.perf_counter() if now is None else now)
            self._runtime_changed()

    def release_quick(self, qid):
        if qid in self.runtime.held:
            self.runtime.release(qid)
            self._runtime_changed()

    def release_all_quick(self):
        """Plus aucun effet rapide tenu (la fenêtre perd la main, on quitte l'espace Live…)."""
        if self.runtime.held:
            self.runtime.held.clear()
            self._runtime_changed()

    def prune_live(self):
        """Oublie les cues lancés qui n'existent plus (case vidée par Annuler, forme supprimée)."""
        live, lib = self.doc.live, self.doc.library
        gone = [k for k, pc in self.runtime.cues.items()
                if live.find_cue(k)[2] is None or lib.get(pc.def_id) is None]
        for k in gone:
            self.runtime.stop(k)
        if gone:
            self._runtime_changed()

    def playing_cues(self, now=None):
        """Cues en cours (toutes pages) : [PlayingCue] dans l'ordre de leur départ."""
        return self.runtime.active(time.perf_counter() if now is None else now)

    def set_live_origin(self, now=None):
        """La grille des départs calés commence une mesure maintenant (Tap sur le premier temps)."""
        self.runtime.origin = time.perf_counter() if now is None else now
        self.liveChanged.emit()

    def set_tempo(self, bpm):
        """Tempo du projet (Tap de l'espace Live). Des tapes rapprochées ne font qu'une étape d'annulation."""
        tl = self.doc.timeline
        try:
            bpm = round(float(bpm), 1)
        except (TypeError, ValueError):
            return
        if not 20.0 <= bpm <= 400.0 or bpm == tl.bpm:
            return
        self.begin_action("Tempo")
        tl.bpm = bpm
        self.commit(merge="tempo")
        self.notify(timeline=True)

    # ── Maîtres (état d'affichage, hors annulation) ──────────────────────
    def set_master(self, key, value):
        """Change un maître (lumière, taille, vitesse, x, y, rotation, couleur) ; renvoie la valeur retenue."""
        m = self.doc.masters
        before = m.to_dict()
        v = m.set(key, value)
        if m.to_dict() != before:
            if key == "speed":
                self.runtime.set_speed(v, time.perf_counter())       # même horloge que la boucle de la forme
            self._touch(content=False)
            self.view_changed()
            self.mastersChanged.emit()
            self.docChanged.emit()
        return v

    def reset_masters(self):
        m = self.doc.masters
        for k, v in type(m)().to_dict().items():
            self.set_master(k, v)
