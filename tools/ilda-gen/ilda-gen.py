"""
ilda-gen.py — Générateur IDN direct pour les lasers de SoundStage3D (entrée « ILDA live »).

Dessine des formes (souris, cercle, étoile, Lissajous) et les envoie en IDN (ILDA Digital Network,
UDP 7255) au serveur du jeu. Dans le jeu : laser › Source = « ILDA live », même canal live.

Flux IDN-Stream envoyé (conforme à la norme, lu par server/ildaLive.js) :
  - service « images » (mode 0x02) ; configuration jointe au premier message de chaque image,
    avec routage vers le service = canal live 1…16 (drapeau 0x01)
  - échantillon : X, Y (16 bits), rouge 638 nm, vert 520 nm, bleu 445 nm, intensité (8 bits)
  - image en un message (bloc 0x02) ou fragmentée : 1er fragment 0x03 (avec en-tête de bloc :
    drapeaux u8 + durée u24 en µs), fragments suivants 0xC0 (données seules), le DERNIER marqué
    par le bit 0x4000 de l'identifiant de contenu ; fragments coupés à la taille d'un paquet
  - « Envoi live » : l'image est renvoyée toutes les 100 ms (le laser la retrouve si le serveur redémarre)

Préparation pour les miroirs (comme un logiciel laser) : points ajoutés le long des traits,
points d'angle, points éteints pour les sauts (plus nombreux pour un grand saut).

Lancer :  python tools/ilda-gen/ilda-gen.py
"""

import math
import socket
import struct
import time
import tkinter as tk
from tkinter import colorchooser, messagebox

ILDA_MIN = -32768
ILDA_MAX = 32767
CANVAS_SIZE = 550
MAX_PAYLOAD = 1400          # octets de données par paquet UDP (sous la taille d'un paquet Ethernet)
LIVE_REFRESH_MS = 100       # renvoi de l'image en « Envoi live »

# IDN-Hello / IDN-Stream
CMD_RT_CNLMSG = 0x40        # message de canal temps réel
CHUNK_FRAME = 0x02          # image entière dans un message
CHUNK_FRAME_FIRST = 0x03    # premier fragment d'image
CHUNK_FRAME_SEQUEL = 0xC0   # fragment suivant (pas d'en-tête de bloc)
CONTENT_CHANNEL_MSG = 0x8000
CONTENT_CONFIG_OR_LAST = 0x4000   # configuration jointe (0x02 / 0x03) ou dernier fragment (0xC0)
SERVICE_MODE_FRAMES = 0x02        # graphique discret (images)
CONFIG_ROUTING = 0x01             # la configuration désigne un service (canal live)

# X (16 bits), Y (16 bits), R 638 nm, V 520 nm, B 445 nm, intensité : 8 étiquettes = 4 mots de 32 bits
IDN_LAYOUT_TAGS = [0x4200, 0x4010, 0x4210, 0x4010, 0x527E, 0x5208, 0x51BD, 0x5C00]
IDN_SCWC = len(IDN_LAYOUT_TAGS) // 2
SAMPLE = struct.Struct(">hhBBBB")

# Préparation du tracé (unités ILDA : −32768…32767)
LINE_STEP = 1100            # distance maximale entre deux points allumés (~3 % de l'image)
CORNER_POINTS = 3           # points répétés sur un angle vif
BLANK_POINTS = 4            # points éteints à l'arrivée d'un saut (+ selon la longueur du saut)
CORNER_ANGLE = 30           # angle (°) à partir duquel un changement de direction est un angle


def canvas_to_laser(cx: float, cy: float) -> tuple[int, int]:
    nx = cx / CANVAS_SIZE
    ny = 1.0 - (cy / CANVAS_SIZE)  # Y vers le haut (norme laser)
    ix = int(nx * 65534 - 32767)
    iy = int(ny * 65534 - 32767)
    return max(ILDA_MIN, min(ILDA_MAX, ix)), max(ILDA_MIN, min(ILDA_MAX, iy))


def prepare_stroke(stroke, out):
    """Ajoute un tracé prêt à projeter : saut éteint, points intermédiaires, points d'angle."""
    fx, fy = stroke[0][0], stroke[0][1]
    # Saut éteint vers le début du tracé (plus long saut = plus de temps pour les miroirs)
    if out:
        px, py = out[-1][0], out[-1][1]
        jump = math.hypot(fx - px, fy - py) / 65536
    else:
        jump = 1.0
    for _ in range(BLANK_POINTS + int(jump * 8)):
        out.append((fx, fy, 0, 0, 0, True))

    for i, (x, y, r, g, b) in enumerate(stroke):
        if i > 0:
            x0, y0 = stroke[i - 1][0], stroke[i - 1][1]
            n = max(1, math.ceil(math.hypot(x - x0, y - y0) / LINE_STEP))
            for k in range(1, n + 1):
                t = k / n
                out.append((round(x0 + (x - x0) * t), round(y0 + (y - y0) * t), r, g, b, False))
        # Angle : les miroirs marquent un temps d'arrêt (sinon le coin s'arrondit)
        first, last = i == 0, i == len(stroke) - 1
        if first or last or is_corner(stroke, i):
            for _ in range(CORNER_POINTS if not first else CORNER_POINTS + 1):
                out.append((x, y, r, g, b, False))
    # Extinction sur le dernier point
    lx, ly = stroke[-1][0], stroke[-1][1]
    out.append((lx, ly, 0, 0, 0, True))


def is_corner(stroke, i):
    ax, ay = stroke[i - 1][0], stroke[i - 1][1]
    bx, by = stroke[i][0], stroke[i][1]
    cx, cy = stroke[i + 1][0], stroke[i + 1][1]
    d1 = math.atan2(by - ay, bx - ax)
    d2 = math.atan2(cy - by, cx - bx)
    turn = abs((d2 - d1 + math.pi) % (2 * math.pi) - math.pi)
    return math.degrees(turn) >= CORNER_ANGLE


class IDNGeneratorApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("Générateur IDN — SoundStage3D (UDP 7255)")
        self.root.configure(bg="#1e1e1e")
        self.root.resizable(False, False)

        self.strokes: list[list[tuple[int, int, int, int, int]]] = []
        self.current_stroke: list[tuple[int, int, int, int, int]] = []
        self.current_color = (0, 255, 128)
        self.sequence_num = 0
        self.t0 = time.perf_counter()

        self.udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

        self._build_ui()
        self._live_tick()

    def _build_ui(self):
        # 1. Réseau
        net_bar = tk.Frame(self.root, bg="#181818", padx=10, pady=6)
        net_bar.pack(side=tk.TOP, fill=tk.X)

        def field(label, width, value):
            tk.Label(net_bar, text=label, fg="#aaaaaa", bg="#181818").pack(side=tk.LEFT, padx=2)
            e = tk.Entry(net_bar, width=width, bg="#2a2a2a", fg="#ffffff", relief=tk.FLAT, insertbackground="#ffffff")
            e.insert(0, value)
            e.pack(side=tk.LEFT, padx=3)
            return e

        self.entry_host = field("IP :", 12, "127.0.0.1")
        self.entry_port = field("Port :", 6, "7255")
        self.entry_channel = field("Canal live :", 3, "1")
        self.entry_kpps = field("kpps :", 3, "30")

        self.live_stream_var = tk.BooleanVar(value=False)
        tk.Checkbutton(
            net_bar, text="Envoi live", variable=self.live_stream_var,
            bg="#181818", fg="#dddddd", selectcolor="#2a2a2a", activebackground="#181818",
        ).pack(side=tk.LEFT, padx=8)

        self.lbl_status = tk.Label(net_bar, text="Prêt", fg="#66bb6a", bg="#181818")
        self.lbl_status.pack(side=tk.RIGHT, padx=5)

        # 2. Formes
        tool_bar = tk.Frame(self.root, bg="#2a2a2a", padx=10, pady=8)
        tool_bar.pack(side=tk.TOP, fill=tk.X)
        for name, cmd in [("Cercle", self.draw_circle), ("Étoile", self.draw_star), ("Lissajous", self.draw_lissajous)]:
            tk.Button(tool_bar, text=name, command=cmd, bg="#3c3f41", fg="#ffffff", relief=tk.FLAT).pack(side=tk.LEFT, padx=3)
        self.btn_color = tk.Button(tool_bar, text="Couleur", command=self.choose_color, bg="#00ff80", fg="#000000", relief=tk.FLAT)
        self.btn_color.pack(side=tk.LEFT, padx=10)
        tk.Button(tool_bar, text="Effacer", command=self.clear_canvas, bg="#8b2525", fg="#ffffff", relief=tk.FLAT).pack(side=tk.LEFT, padx=3)

        # 3. Zone de dessin
        self.canvas = tk.Canvas(self.root, width=CANVAS_SIZE, height=CANVAS_SIZE, bg="#000000", cursor="crosshair", highlightthickness=0)
        self.canvas.pack(padx=10, pady=10)
        self._draw_axes()
        self.canvas.bind("<Button-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)

        # 4. Envoi
        bot_bar = tk.Frame(self.root, bg="#2a2a2a", padx=10, pady=8)
        bot_bar.pack(side=tk.BOTTOM, fill=tk.X)
        self.lbl_points = tk.Label(bot_bar, text="Points : 0", fg="#888888", bg="#2a2a2a")
        self.lbl_points.pack(side=tk.LEFT, padx=5)
        tk.Button(
            bot_bar, text="Envoyer en IDN (UDP)", command=self.send_idn,
            bg="#00897b", fg="#ffffff", font=("Segoe UI", 9, "bold"), relief=tk.FLAT, padx=12,
        ).pack(side=tk.RIGHT, padx=5)

    def _draw_axes(self):
        mid = CANVAS_SIZE // 2
        self.canvas.create_line(mid, 0, mid, CANVAS_SIZE, fill="#1a1a1a", dash=(2, 4))
        self.canvas.create_line(0, mid, CANVAS_SIZE, mid, fill="#1a1a1a", dash=(2, 4))

    def _hex(self):
        return f"#{self.current_color[0]:02x}{self.current_color[1]:02x}{self.current_color[2]:02x}"

    def choose_color(self):
        col = colorchooser.askcolor(title="Couleur laser")[0]
        if col:
            self.current_color = (int(col[0]), int(col[1]), int(col[2]))
            self.btn_color.configure(bg=self._hex())

    # ── Dessin à la souris ──────────────────────────────────────────────────
    def on_press(self, event):
        ix, iy = canvas_to_laser(event.x, event.y)
        self.current_stroke = [(ix, iy, *self.current_color)]
        self._last_cx, self._last_cy = event.x, event.y

    def on_drag(self, event):
        if (event.x - self._last_cx) ** 2 + (event.y - self._last_cy) ** 2 < 9:
            return
        ix, iy = canvas_to_laser(event.x, event.y)
        self.current_stroke.append((ix, iy, *self.current_color))
        self.canvas.create_line(self._last_cx, self._last_cy, event.x, event.y, fill=self._hex(), width=2)
        self._last_cx, self._last_cy = event.x, event.y
        self.update_count()

    def on_release(self, _event):
        if len(self.current_stroke) > 1:
            self.strokes.append(self.current_stroke)
        self.current_stroke = []
        self.update_count()

    # ── Formes ──────────────────────────────────────────────────────────────
    def add_shape(self, points):
        stroke = []
        for i in range(len(points) - 1):
            p1, p2 = points[i], points[i + 1]
            self.canvas.create_line(p1[0], p1[1], p2[0], p2[1], fill=self._hex(), width=2)
        for p in points:
            ix, iy = canvas_to_laser(p[0], p[1])
            stroke.append((ix, iy, *self.current_color))
        self.strokes.append(stroke)
        self.update_count()

    def draw_circle(self):
        cx, cy, r = CANVAS_SIZE // 2, CANVAS_SIZE // 2, 180
        self.add_shape([(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(0, 361, 5)])

    def draw_star(self):
        cx, cy = CANVAS_SIZE // 2, CANVAS_SIZE // 2
        pts = []
        for i in range(11):
            angle = i * (math.pi / 5) - (math.pi / 2)
            r = 180 if i % 2 == 0 else 80
            pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
        self.add_shape(pts)

    def draw_lissajous(self):
        cx, cy = CANVAS_SIZE // 2, CANVAS_SIZE // 2
        self.add_shape([(cx + 180 * math.sin(3 * t + math.pi / 2), cy + 180 * math.sin(4 * t)) for t in [i * 0.02 for i in range(315)]])

    def clear_canvas(self):
        self.strokes.clear()
        self.current_stroke.clear()
        self.canvas.delete("all")
        self._draw_axes()
        self.update_count()
        if self.live_stream_var.get():
            self.send_idn(silent=True)   # le laser s'éteint tout de suite

    def update_count(self):
        n = len(self.build_point_list())
        self.lbl_points.config(text=f"Points : {n} (envoyés)")

    def build_point_list(self):
        """Liste des points laser (x, y, r, g, b, éteint) prête pour les miroirs."""
        out = []
        strokes = list(self.strokes)
        if len(self.current_stroke) > 1:
            strokes.append(self.current_stroke)
        for stroke in strokes:
            if stroke:
                prepare_stroke(stroke, out)
        return out

    # ── Envoi IDN ───────────────────────────────────────────────────────────
    def _live_tick(self):
        if self.live_stream_var.get():
            self.send_idn(silent=True)
        self.root.after(LIVE_REFRESH_MS, self._live_tick)

    def _message(self, chunk_type, flags, payload):
        """Paquet IDN : en-tête IDN-Hello (4 octets) + message de canal (8 octets) + contenu."""
        content = CONTENT_CHANNEL_MSG | chunk_type | flags  # canal IDN 0 : le service choisit le canal live
        timestamp = int((time.perf_counter() - self.t0) * 1e6) & 0xFFFFFFFF
        msg = struct.pack(">HHI", 8 + len(payload), content, timestamp) + payload
        seq = self.sequence_num
        self.sequence_num = (self.sequence_num + 1) & 0xFFFF
        return struct.pack(">BBH", CMD_RT_CNLMSG, 0x00, seq) + msg

    def send_idn(self, silent=False):
        points = self.build_point_list()
        if not points:
            if not silent:
                messagebox.showwarning("Vide", "Trace une forme avant d'envoyer.")
                return
            # Envoi live, toile effacée : image éteinte (un point masqué au centre), le laser n'affiche plus rien
            points = [(0, 0, 0, 0, 0, True)]
        host = self.entry_host.get().strip()
        try:
            port = int(self.entry_port.get().strip())
            live = int(self.entry_channel.get().strip())
            kpps = float(self.entry_kpps.get().strip().replace(",", "."))
            if not (1 <= live <= 16) or kpps <= 0:
                raise ValueError
        except ValueError:
            self.lbl_status.config(text="Config invalide (canal 1-16)", fg="#ef5350")
            return

        # Échantillons (X, Y, R, V, B, intensité)
        data = bytearray()
        for x, y, r, g, b, blank in points:
            data += SAMPLE.pack(x, y, 0 if blank else r, 0 if blank else g, 0 if blank else b, 0 if blank else 255)

        # Configuration : 4 mots, routage vers le service (= canal live), mode images
        config = struct.pack(">BBBB", IDN_SCWC, CONFIG_ROUTING, live, SERVICE_MODE_FRAMES) + struct.pack(">8H", *IDN_LAYOUT_TAGS)
        # En-tête de bloc : drapeaux (u8) + durée de l'image en µs (u24)
        duration = min(0xFFFFFF, int(len(points) / (kpps * 1000) * 1e6))
        chunk_header = struct.pack(">I", duration & 0xFFFFFF)

        try:
            first_room = MAX_PAYLOAD - len(config) - len(chunk_header)
            if len(data) <= first_room:
                packets = [self._message(CHUNK_FRAME, CONTENT_CONFIG_OR_LAST, config + chunk_header + bytes(data))]
            else:
                # Fragments : le 1er porte la configuration et l'en-tête de bloc, les suivants seulement des données
                packets = [self._message(CHUNK_FRAME_FIRST, CONTENT_CONFIG_OR_LAST, config + chunk_header + bytes(data[:first_room]))]
                rest = data[first_room:]
                while rest:
                    part, rest = rest[:MAX_PAYLOAD], rest[MAX_PAYLOAD:]
                    packets.append(self._message(CHUNK_FRAME_SEQUEL, 0 if rest else CONTENT_CONFIG_OR_LAST, bytes(part)))
            for p in packets:
                self.udp_sock.sendto(p, (host, port))
            self.lbl_status.config(text=f"Envoyé : {len(points)} pts, {len(packets)} paquet(s) → canal live {live}", fg="#66bb6a")
        except OSError as e:
            self.lbl_status.config(text="Erreur UDP", fg="#ef5350")
            if not silent:
                messagebox.showerror("Erreur UDP", str(e))


if __name__ == "__main__":
    app_root = tk.Tk()
    app = IDNGeneratorApp(app_root)
    app_root.mainloop()
