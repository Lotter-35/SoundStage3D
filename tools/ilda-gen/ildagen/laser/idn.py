"""Construction des paquets IDN (ILDA Digital Network, IDN-Hello + IDN-Stream) — sans réseau.

Compatible avec l'entrée « ILDA live » du serveur SoundStage3D (server/ildaLive.js, UDP 7255).
"""

import struct
import time

import numpy as np

IDN_PORT = 7255
MAX_PAYLOAD = 1400

CMD_PING_REQUEST = 0x08
CMD_PING_RESPONSE = 0x09
CMD_RT_CNLMSG = 0x40
CMD_RT_CNLMSG_CLOSE = 0x44

CHUNK_FRAME = 0x02
CHUNK_FRAME_FIRST = 0x03
CHUNK_FRAME_SEQUEL = 0xC0
CONTENT_CHANNEL_MSG = 0x8000
CONTENT_CONFIG_OR_LAST = 0x4000
SERVICE_MODE_FRAMES = 0x02
CONFIG_ROUTING = 0x01

# X 16 bits, Y 16 bits, rouge 638 nm, vert 520 nm, bleu 445 nm, intensité
LAYOUT_TAGS = [0x4200, 0x4010, 0x4210, 0x4010, 0x527E, 0x5208, 0x51BD, 0x5C00]
SAMPLE_DTYPE = np.dtype([("x", ">i2"), ("y", ">i2"), ("r", "u1"), ("g", "u1"), ("b", "u1"), ("i", "u1")])


def frame_data(x, y, r, g, b):
    """Échantillons d'une image au format IDN (octets)."""
    samples = np.empty(len(x), dtype=SAMPLE_DTYPE)
    samples["x"] = x
    samples["y"] = y
    samples["r"] = r
    samples["g"] = g
    samples["b"] = b
    samples["i"] = np.where((r > 0) | (g > 0) | (b > 0), 255, 0)
    return samples.tobytes()


class IdnPacketBuilder:
    def __init__(self):
        self.seq = 0
        self.t0 = time.perf_counter()

    def _next_seq(self):
        s = self.seq
        self.seq = (self.seq + 1) & 0xFFFF
        return s

    def _channel_message(self, chunk_type, flags, payload, cmd=CMD_RT_CNLMSG):
        content = CONTENT_CHANNEL_MSG | chunk_type | flags
        ts = int((time.perf_counter() - self.t0) * 1e6) & 0xFFFFFFFF
        msg = struct.pack(">HHI", 8 + len(payload), content, ts) + payload
        return struct.pack(">BBH", cmd, 0x00, self._next_seq()) + msg

    def frame_packets(self, x, y, r, g, b, channel, kpps, cmd=CMD_RT_CNLMSG):
        """Paquets UDP d'une image (x, y int16 ; r, g, b uint8) vers le canal live 1..16."""
        return self.data_packets(frame_data(x, y, r, g, b), len(x), channel, kpps, cmd)

    def data_packets(self, data, n, channel, kpps, cmd=CMD_RT_CNLMSG):
        """Paquets d'une image déjà convertie (frame_data) : chaque envoi reçoit de nouveaux numéros de séquence,
        consécutifs d'un fragment à l'autre (le serveur jette une image dont un fragment manque)."""
        config = struct.pack(">BBBB", len(LAYOUT_TAGS) // 2, CONFIG_ROUTING, int(channel), SERVICE_MODE_FRAMES)
        config += struct.pack(">%dH" % len(LAYOUT_TAGS), *LAYOUT_TAGS)
        duration = min(0xFFFFFF, int(n / max(1.0, kpps) * 1e6))
        chunk_header = struct.pack(">I", duration & 0xFFFFFF)
        first_room = MAX_PAYLOAD - len(config) - len(chunk_header)
        first_room -= first_room % SAMPLE_DTYPE.itemsize
        if len(data) <= first_room:
            return [self._channel_message(CHUNK_FRAME, CONTENT_CONFIG_OR_LAST, config + chunk_header + data, cmd)]
        packets = [self._channel_message(CHUNK_FRAME_FIRST, CONTENT_CONFIG_OR_LAST,
                                         config + chunk_header + data[:first_room], cmd)]
        rest = data[first_room:]
        while rest:
            part, rest = rest[:MAX_PAYLOAD], rest[MAX_PAYLOAD:]
            packets.append(self._channel_message(CHUNK_FRAME_SEQUEL, 0 if rest else CONTENT_CONFIG_OR_LAST, part, cmd))
        return packets

    def blank_packets(self, channel, kpps, cmd=CMD_RT_CNLMSG):
        z = np.zeros(1, dtype=np.int16)
        u = np.zeros(1, dtype=np.uint8)
        return self.frame_packets(z, z, u, u, u, channel, kpps, cmd)

    def close_packets(self, channel, kpps):
        """Fin de l'envoi : une image éteinte portée par le message de fermeture du canal."""
        return self.blank_packets(channel, kpps, CMD_RT_CNLMSG_CLOSE)

    def ping_packet(self):
        seq = self._next_seq()
        return seq, struct.pack(">BBH", CMD_PING_REQUEST, 0x00, seq) + b"ildagen"


def is_ping_response(data):
    return len(data) >= 4 and data[0] == CMD_PING_RESPONSE
