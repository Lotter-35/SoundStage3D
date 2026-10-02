import struct
import time
from tkinter import messagebox
try:
    from ..core.constants import (
        SAMPLE,
        CONFIG_ROUTING,
        SERVICE_MODE_FRAMES,
        IDN_SCWC,
        IDN_LAYOUT_TAGS,
        MAX_PAYLOAD,
        CHUNK_FRAME,
        CHUNK_FRAME_FIRST,
        CHUNK_FRAME_SEQUEL,
        CONTENT_CONFIG_OR_LAST,
        CMD_RT_CNLMSG,
        CONTENT_CHANNEL_MSG,
        LIVE_REFRESH_MS,
    )
    from ..core.laser_stroke import prepare_stroke
except (ImportError, ValueError):
    from core.constants import (
        SAMPLE,
        CONFIG_ROUTING,
        SERVICE_MODE_FRAMES,
        IDN_SCWC,
        IDN_LAYOUT_TAGS,
        MAX_PAYLOAD,
        CHUNK_FRAME,
        CHUNK_FRAME_FIRST,
        CHUNK_FRAME_SEQUEL,
        CONTENT_CONFIG_OR_LAST,
        CMD_RT_CNLMSG,
        CONTENT_CHANNEL_MSG,
        LIVE_REFRESH_MS,
    )
    from core.laser_stroke import prepare_stroke


class NetworkIdnMixin:
    """Gestion du réseau UDP et du protocole IDN (ILDA Digital Network stream)."""

    def update_count(self):
        pts = self.build_point_list()
        self.lbl_points.config(text=f"Points : {len(pts)} (envoyés)")

    def build_point_list(self):
        """Génère tous les points laser pour les calques actifs."""
        out = []
        active_fn = getattr(self, "is_layer_active_for_render", None)
        for l in self.layers:
            if not l.enabled:
                continue
            if active_fn is not None and not active_fn(l):
                continue
            strokes = l.get_render_strokes(is_layer_active_fn=active_fn)
            for wpts, stroke_color, is_closed, shape_type in strokes:
                if not wpts:
                    continue
                r, g, b = stroke_color
                stroke = []
                for wx, wy in wpts:
                    ix = int(round(wx * 32767))
                    iy = int(round(wy * 32767))
                    stroke.append((ix, iy, r, g, b))
                prepare_stroke(stroke, out, is_closed=is_closed)
        return out

    def _live_tick(self):
        # Ne pas saturer le thread UI si l'utilisateur est en train de manipuler le canvas
        if not getattr(self, "_drag_mode", None):
            if self.live_stream_var.get():
                self.send_idn(silent=True)
        self.root.after(LIVE_REFRESH_MS, self._live_tick)

    def _message(self, chunk_type, flags, payload):
        content = CONTENT_CHANNEL_MSG | chunk_type | flags
        timestamp = int((time.perf_counter() - self.t0) * 1e6) & 0xFFFFFFFF
        msg = struct.pack(">HHI", 8 + len(payload), content, timestamp) + payload
        seq = self.sequence_num
        self.sequence_num = (self.sequence_num + 1) & 0xFFFF
        return struct.pack(">BBH", CMD_RT_CNLMSG, 0x00, seq) + msg

    def send_idn(self, silent=False):
        points = self.build_point_list()
        if not points:
            if not silent:
                messagebox.showwarning("Vide", "Trace ou importe une forme avant d'envoyer.")
                return
            points = [(0, 0, 0, 0, 0, True)]

        host = self.entry_host.get().strip()
        try:
            port = int(self.entry_port.get().strip())
            live = int(self.entry_channel.get().strip())
            kpps = float(self.entry_kpps.get().strip().replace(",", "."))
            if not (1 <= live <= 16) or kpps <= 0:
                raise ValueError
        except ValueError:
            if not silent:
                self.lbl_status.config(text="Config invalide (canal 1-16)", fg="#ef5350")
            return

        data = bytearray()
        for x, y, r, g, b, blank in points:
            data += SAMPLE.pack(x, y, 0 if blank else r, 0 if blank else g, 0 if blank else b, 0 if blank else 255)

        config = struct.pack(">BBBB", IDN_SCWC, CONFIG_ROUTING, live, SERVICE_MODE_FRAMES) + struct.pack(">8H", *IDN_LAYOUT_TAGS)
        duration = min(0xFFFFFF, int(len(points) / (kpps * 1000) * 1e6))
        chunk_header = struct.pack(">I", duration & 0xFFFFFF)

        try:
            first_room = MAX_PAYLOAD - len(config) - len(chunk_header)
            if len(data) <= first_room:
                packets = [self._message(CHUNK_FRAME, CONTENT_CONFIG_OR_LAST, config + chunk_header + bytes(data))]
            else:
                packets = [self._message(CHUNK_FRAME_FIRST, CONTENT_CONFIG_OR_LAST, config + chunk_header + bytes(data[:first_room]))]
                rest = data[first_room:]
                while rest:
                    part, rest = rest[:MAX_PAYLOAD], rest[MAX_PAYLOAD:]
                    packets.append(self._message(CHUNK_FRAME_SEQUEL, 0 if rest else CONTENT_CONFIG_OR_LAST, bytes(part)))
            for p in packets:
                try:
                    self.udp_sock.sendto(p, (host, port))
                except (BlockingIOError, InterruptedError):
                    pass
            if not silent:
                self.lbl_status.config(text=f"Envoyé : {len(points)} pts → canal live {live}", fg="#66bb6a")
        except OSError as e:
            if not silent:
                self.lbl_status.config(text="Erreur UDP", fg="#ef5350")
                messagebox.showerror("Erreur UDP", str(e))
