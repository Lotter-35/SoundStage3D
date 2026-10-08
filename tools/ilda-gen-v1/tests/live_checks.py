"""Vérifications de la sortie live (fil d'envoi) et des fenêtres Paramètres / Export, appelées par test_ui.py.

Un vrai socket UDP local joue le serveur : on vérifie ce qui arrive réellement sur le réseau.
"""

import socket
import struct
import time

CMD_CNLMSG, CMD_CLOSE = 0x40, 0x44


def wait_for(app, cond, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        app.processEvents()
        if cond():
            return True
        time.sleep(0.005)
    app.processEvents()
    return cond()


class Receiver:
    """Serveur IDN factice : garde les paquets reçus (commande, contenu, données)."""

    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.setblocking(False)
        self.port = self.sock.getsockname()[1]
        self.packets = []

    def poll(self):
        while True:
            try:
                data = self.sock.recv(4096)
            except (BlockingIOError, OSError):
                return self.packets
            if len(data) >= 12 and data[0] in (CMD_CNLMSG, CMD_CLOSE):
                cmd, _, seq = struct.unpack(">BBH", data[:4])
                content = struct.unpack(">H", data[6:8])[0]
                self.packets.append((cmd, seq, content & 0xFF, time.monotonic(), data))

    def frames(self, since=0):
        """Images complètes reçues (paquet unique 0x02 ou dernier fragment) depuis l'indice since."""
        return [p for p in self.poll()[since:] if p[2] == 0x02 or (p[2] == 0xC0 and p[4][6] & 0x40)]


def blank(pkt):
    """Image entièrement éteinte (un seul paquet, couleurs nulles) ?"""
    data = pkt[4]
    if pkt[2] != 0x02:
        return False
    samples = data[4 + 8 + 4 + 16 + 4:]
    return all(samples[i + 4:i + 8] == b"\0\0\0\0" for i in range(0, len(samples), 8))


def live_checks(app, win, check):
    ed, live = win.editor, win.live
    rx = Receiver()
    win.settings.set("network", "host", "127.0.0.1")
    win.settings.set("network", "port", rx.port)
    win.connection.reload()
    t0 = time.perf_counter()
    live.set_live(True)
    check("envoi live actif", live.live)
    ok = wait_for(app, lambda: len(rx.frames()) >= 3)
    check("le fil d'envoi envoie des images au rythme choisi", ok, f"{len(rx.frames())} image(s)")
    ok = wait_for(app, lambda: live.stats.sent and live.stats.count > 0)
    check("compteur : points envoyés", ok, f"{live.stats.count} points")
    check("interface libre pendant l'envoi (calcul hors du fil de l'interface)", time.perf_counter() - t0 < 3.5)
    # Cadence : une image toutes les 1 / images par seconde (horloge du fil d'envoi)
    wait_for(app, lambda: len(rx.frames()) >= 12, 2.0)
    t = [p[3] for p in rx.frames()]
    gaps = sorted(b - a for a, b in zip(t, t[1:]))
    period = 1.0 / win.live.fps()
    check("cadence régulière", gaps and abs(gaps[len(gaps) // 2] - period) < 0.006,
          f"médiane {gaps[len(gaps) // 2] * 1000:.1f} ms" if gaps else "")
    # Fragments d'une même image : numéros de séquence consécutifs
    ok = True
    seq = None
    for p in rx.poll():
        if p[2] == 0x03:
            seq = p[1]
        elif p[2] == 0xC0 and seq is not None:
            ok = ok and p[1] == (seq + 1) & 0xFFFF
            seq = p[1]
    check("fragments numérotés à la suite", ok)
    # Blackout : coupure immédiate, des images éteintes partent aussitôt, plus rien d'allumé ensuite
    n0 = len(rx.poll())
    t_black = time.monotonic()
    live.set_blackout(True)
    check("blackout coupe l'envoi", not live.live and live.blackout)
    wait_for(app, lambda: any(blank(p) for p in rx.poll()[n0:]), 1.0)
    after = rx.poll()[n0:]
    first_blank = next((p for p in after if blank(p)), None)
    check("blackout : image éteinte immédiate", first_blank is not None and first_blank[3] - t_black < 0.1)
    time.sleep(0.15)
    lit_after = [p for p in rx.frames(n0) if not blank(p) and p[3] > t_black + 0.05]
    check("blackout : plus aucune image allumée", not lit_after, f"{len(lit_after)} image(s)")
    live.set_blackout(False)
    # Arrêt du live : images éteintes puis message de fermeture IDN
    live.set_live(True)
    wait_for(app, lambda: len(rx.frames(n0)) >= 2)
    n1 = len(rx.poll())
    live.set_live(False)
    wait_for(app, lambda: any(p[0] == CMD_CLOSE for p in rx.poll()[n1:]), 1.0)
    tail = rx.poll()[n1:]
    check("arrêt du live : images éteintes + fermeture IDN",
          sum(1 for p in tail if blank(p)) >= 2 and any(p[0] == CMD_CLOSE for p in tail))
    # Hors live : aucun envoi
    n2 = len(rx.poll())
    time.sleep(0.2)
    app.processEvents()
    check("hors live : rien n'est envoyé", len(rx.poll()) == n2)
    ed.notify()
    ok = wait_for(app, lambda: not live.stats.sent and live.last_points is not None, 1.0)
    check("hors live : aperçu de la mire calculé à la demande", ok)
    rx.sock.close()
    win.settings.set("network", "port", 7255)
    win.connection.reload()
    settings_checks(app, win, check)


def settings_checks(app, win, check):
    from ildagen.ui.dialogs.export_dialog import ExportDialog
    from ildagen.ui.dialogs.settings_dialog import SettingsDialog
    dlg = SettingsDialog(win.editor, win.live, win)
    w = dlg.widgets
    w[("safety", "xmin")].setValue(0.5)
    w[("safety", "xmax")].setValue(-0.5)
    sz = win.settings.section("safety")
    check("zone de sécurité : gauche toujours à gauche de la droite", sz["xmin"] < sz["xmax"],
          f"{sz['xmin']} / {sz['xmax']}")
    w[("output", "scale_x")].setValue(0.0)
    check("taille de sortie : minimum 5 %", win.settings.get("output", "scale_x") >= 5.0)
    check("budget de points affiché", "1 000 points" in dlg.budget.text(), dlg.budget.text())
    dlg.tabs.setCurrentIndex(next(i for i in range(dlg.tabs.count()) if dlg.tabs.tabText(i) == "Zone de sécurité"))
    dlg._reset_tab()
    dlg.tabs.setCurrentIndex(next(i for i in range(dlg.tabs.count()) if dlg.tabs.tabText(i) == "Taille / position"))
    dlg._reset_tab()
    dlg.reject()
    check("réinitialisation des onglets", win.settings.get("safety", "xmin") == -1.0
          and win.settings.get("output", "scale_x") == 100.0)
    exp = ExportDialog(win.editor, win)
    still_only = exp.range.count() == 1
    check("export : cadence désactivée pour une image fixe", (not exp.fps.isEnabled()) == still_only
          or exp.range.currentData() == "still" and not exp.fps.isEnabled())
    check("export : réglages de sortie non appliqués par défaut", not exp.corrections.isChecked())
    exp.reject()
