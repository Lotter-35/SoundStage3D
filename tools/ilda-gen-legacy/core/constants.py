import struct

ILDA_MIN = -32768
ILDA_MAX = 32767
CANVAS_SIZE = 550
MAX_PAYLOAD = 1400          # octets de données par paquet UDP
LIVE_REFRESH_MS = 100       # renvoi de l'image en « Envoi live »

# IDN-Hello / IDN-Stream
CMD_RT_CNLMSG = 0x40
CHUNK_FRAME = 0x02
CHUNK_FRAME_FIRST = 0x03
CHUNK_FRAME_SEQUEL = 0xC0
CONTENT_CHANNEL_MSG = 0x8000
CONTENT_CONFIG_OR_LAST = 0x4000
SERVICE_MODE_FRAMES = 0x02
CONFIG_ROUTING = 0x01

IDN_LAYOUT_TAGS = [0x4200, 0x4010, 0x4210, 0x4010, 0x527E, 0x5208, 0x51BD, 0x5C00]
IDN_SCWC = len(IDN_LAYOUT_TAGS) // 2
SAMPLE = struct.Struct(">hhBBBB")

LINE_STEP = 1100            # distance maximale entre deux points allumés
CORNER_POINTS = 3           # points répétés sur un angle vif
BLANK_POINTS = 4            # points éteints pour le saut galvo
CORNER_ANGLE = 30           # angle en degrés pour marquer un coin
