"""Fil d'envoi live : calcule et envoie les images au rythme exact (horloge monotone), hors de l'interface.

- l'image est évaluée à l'heure réelle d'envoi (la lecture est extrapolée depuis l'instantané publié) ; ce qui
  est envoyé suit l'espace actif (forme en cours, timeline ou live), puis les maîtres et les réglages de sortie ;
- une image inchangée est renvoyée telle quelle (cache sur la révision du document et l'instant montré) ;
- les fragments d'une grosse image sont espacés dans l'intervalle entre deux images (pas de rafale perdue) ;
- BLACKOUT : l'envoi s'arrête au fragment près et des images éteintes partent aussitôt ;
- arrêt du live : quelques images éteintes puis le message de fermeture IDN.
Hors live, le fil ne fait rien, sauf calculer sur demande l'aperçu de la mire (compteur de points).
"""

import socket
import sys
import threading
import time

from ..core.masters import apply_masters
from ..laser.idn import IdnPacketBuilder, frame_data
from ..laser.pipeline import MAX_LIVE_POINTS, render_frame
from .live_snapshot import evaluate_at

BLANK_FRAMES = 3
BURST = 4                # fragments envoyés d'affilée
PACE_FROM = 8            # une image de moins de fragments part d'un coup (quelques ko : rien à étaler)
MAX_GAP = 0.002          # pause maximale entre deux salves (s)
EARLY = 0.002            # réveil un peu avant l'heure, la fin de l'attente est faite au plus juste
SWITCH_INTERVAL = 0.001  # Python passe la main entre fils au moins toutes les 1 ms (au lieu de 5) : le fil
                         # d'envoi récupère vite la main même si l'interface calcule


class FrameInfo:
    """Ce que l'interface affiche : points de la mire, nombre de points, image réduite / coupée, envoyée."""

    __slots__ = ("pts", "col", "count", "reduced", "static", "sent", "budget")

    def __init__(self, frame=None, sent=False):
        self.pts = frame.pts if frame is not None else None
        self.col = frame.col if frame is not None else None
        self.count = frame.count if frame is not None else 0
        self.reduced = bool(frame.reduced) if frame is not None else False
        self.static = bool(frame.static) if frame is not None else False
        self.budget = frame.budget if frame is not None else 0
        self.sent = sent

    def key(self):
        return self.count, self.reduced, self.static, self.sent


class OutputWorker(threading.Thread):
    def __init__(self, on_frame):
        super().__init__(name="ildagen-sortie-live", daemon=True)
        self._cv = threading.Condition()
        self._on_frame = on_frame          # appelé depuis ce fil (l'interface le relaie par un signal en file)
        self._snap = None
        self._live = False
        self._blackout = False
        self._quit = False
        self._blanks = 0                   # images éteintes à envoyer dès que possible
        self._close = False
        self._preview = None
        self._next = 0.0
        self.builder = IdnPacketBuilder()
        self.sock = None
        self._addr_cache = (None, None)
        self._cache = (None, None, None)   # (clé, image, octets)
        self._animated = {}
        self._order = None
        self._preview_order = None
        self.frames_sent = 0
        self.last_error = ""

    # ── Commandes (depuis l'interface) ───────────────────────────────────
    def publish(self, snap):
        with self._cv:
            self._snap = snap
            self._cv.notify()

    def set_live(self, on):
        with self._cv:
            if on and not self._live:
                self._next = time.perf_counter()
            elif not on and self._live:
                self._blanks, self._close = BLANK_FRAMES, True
            self._live = bool(on)
            self._cv.notify()

    def set_blackout(self, on):
        with self._cv:
            self._blackout = bool(on)
            if on:
                self._blanks = max(self._blanks, BLANK_FRAMES)
            self._cv.notify()

    def request_preview(self, strokes, settings, fps):
        with self._cv:
            self._preview = (strokes, settings, fps)
            self._cv.notify()

    def stop(self, timeout=1.0):
        with self._cv:
            if self._live:
                self._blanks, self._close = BLANK_FRAMES, True
            self._live = False
            self._quit = True
            self._cv.notify()
        if self.is_alive():
            self.join(timeout)

    # ── Boucle ───────────────────────────────────────────────────────────
    def run(self):
        sys.setswitchinterval(min(sys.getswitchinterval(), SWITCH_INTERVAL))
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1 << 20)
        except OSError:
            pass
        while True:
            with self._cv:
                while not (self._blanks or self._preview is not None or self._quit):
                    if self._live and not self._blackout and self._snap is not None:
                        wait = self._next - time.perf_counter()
                        if wait <= EARLY:
                            break
                        self._cv.wait(min(wait - EARLY, 0.1))
                    else:
                        self._cv.wait(0.5)
                blanks, close, self._blanks, self._close = self._blanks, self._close, 0, False
                preview, self._preview = self._preview, None
                quit_, snap = self._quit, self._snap
                live = self._live and not self._blackout and snap is not None
            if blanks and snap is not None:
                self._send_blanks(snap, blanks, close)
            if quit_:
                break
            if preview is not None and not live:
                self._run_preview(*preview)
            if live and time.perf_counter() >= self._next - EARLY:
                self._sleep_until(self._next)
                interval = 1.0 / max(1, int(snap.fps))
                self._send_frame(snap, interval)
                self._next += interval
                now = time.perf_counter()
                if self._next < now:
                    self._next = now + interval        # en retard : pas de rattrapage en rafale
        try:
            self.sock.close()
        except OSError:
            pass

    @staticmethod
    def _sleep_until(t):
        d = t - time.perf_counter()
        if d > 0:
            time.sleep(d)          # une seule attente (chaque réveil doit reprendre la main à l'interface)

    # ── Images ───────────────────────────────────────────────────────────
    def _render(self, snap, t):
        """(image, octets, nouvelle ?) à l'instant t ; une image déjà calculée est réutilisée.
        Les maîtres s'appliquent avant les réglages de sortie."""
        akey = (snap.doc_rev, snap.mode, snap.def_id)
        base = (snap.doc_rev, snap.mode, snap.def_id, snap.masters_signature(), snap.default_color,
                snap.settings.signature, snap.fps)
        always = snap.mode in ("show", "live")
        timed = always or self._animated.get(akey, True)
        key = base + (round(t, 4) if timed else None,)
        if key == self._cache[0]:
            return self._cache[1], self._cache[2], False
        strokes, animated = evaluate_at(snap.doc, snap, t)
        strokes = apply_masters(strokes, snap.masters)
        if len(self._animated) > 64:
            self._animated.clear()                      # anciennes révisions du document
        self._animated[akey] = animated
        key = base + (round(t, 4) if (always or animated) else None,)
        frame = render_frame(strokes, snap.settings, snap.fps, True, MAX_LIVE_POINTS, self._order)
        self._order = frame.order
        data = frame_data(frame.x, frame.y, frame.r, frame.g, frame.b)
        self._cache = (key, frame, data)
        return frame, data, True

    def _send_frame(self, snap, interval):
        try:
            frame, data, new = self._render(snap, snap.frame_time(time.perf_counter()))
        except Exception as e:                          # jamais d'arrêt du fil : image éteinte à la place
            self.last_error = f"{type(e).__name__}: {e}"
            self._send_blanks(snap, 1, False)
            return
        if self._blackout or not self._live:
            return
        net = snap.settings.section("network")
        pkts = self.builder.data_packets(data, frame.count, int(net.get("channel", 1)),
                                         float(snap.settings.get("laser", "scan_kpps")) * 1000.0)
        self._send_paced(snap, pkts, interval)
        self.frames_sent += 1
        if new:
            self._on_frame(FrameInfo(frame, sent=True))

    def _send_paced(self, snap, pkts, interval):
        """Fragments par petites salves, étalées sur une partie de l'intervalle entre deux images."""
        if len(pkts) < PACE_FROM:
            self._send(snap, pkts)
            return
        bursts = (len(pkts) + BURST - 1) // BURST
        gap = min(MAX_GAP, 0.5 * interval / max(1, bursts))
        for i in range(0, len(pkts), BURST):
            if self._blackout:
                return                                  # coupure immédiate : le reste de l'image ne part pas
            self._send(snap, pkts[i:i + BURST])
            if i + BURST < len(pkts):
                time.sleep(gap)

    def _send_blanks(self, snap, count, close):
        net = snap.settings.section("network")
        ch = int(net.get("channel", 1))
        kpps = float(snap.settings.get("laser", "scan_kpps")) * 1000.0
        for k in range(count):
            self._send(snap, self.builder.blank_packets(ch, kpps))
            if k + 1 < count:
                time.sleep(0.004)
        if close:
            self._send(snap, self.builder.close_packets(ch, kpps))
        self._cache = (None, None, None)

    def _send(self, snap, pkts):
        addr = self._address(snap)
        if addr is None:
            return
        for p in pkts:
            try:
                self.sock.sendto(p, addr)
            except OSError as e:
                self.last_error = str(e)
                return

    def _address(self, snap):
        net = snap.settings.section("network")
        key = (str(net.get("host", "127.0.0.1")).strip() or "127.0.0.1", int(net.get("port", 7255)))
        if self._addr_cache[0] != key:
            try:
                self._addr_cache = (key, (socket.gethostbyname(key[0]), key[1]))
            except OSError as e:
                self.last_error = str(e)
                self._addr_cache = (key, None)
        return self._addr_cache[1]

    def _run_preview(self, strokes, settings, fps):
        try:
            frame = render_frame(strokes, settings, fps, True, MAX_LIVE_POINTS, self._preview_order)
        except Exception as e:
            self.last_error = f"{type(e).__name__}: {e}"
            return
        self._preview_order = frame.order
        self._on_frame(FrameInfo(frame, sent=False))
