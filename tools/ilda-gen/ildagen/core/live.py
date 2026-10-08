"""Espace Live : pages de cues (8 × 4 cases), mode de départ, un ou plusieurs cues, effets rapides.

Une case = une forme (avec ses oscillateurs, en boucle), lancée au clic ou à sa touche du clavier. L'état
d'exécution (cues en cours, en attente, effets rapides maintenus) n'est pas enregistré :
voir editor/live_runtime.py.
"""

from .nodes import new_id
from .oscillator import Osc

COLS = 8
ROWS = 4
SLOTS = COLS * ROWS
LAUNCH_MODES = ["Immédiat", "Au temps", "À la mesure"]

# Touches par défaut, ligne par ligne (clavier AZERTY) ; 4e ligne : les chiffres
DEFAULT_KEYS = ["AZERTYUI", "QSDFGHJK", "WXCVBN,;", "12345678"]
# Rangée des chiffres d'un clavier AZERTY sans Maj (&é"'(-è_) : mêmes cases que 1 à 8
AZERTY_DIGITS = {c: str(i + 1) for i, c in enumerate("&é\"'(-è_")}


def default_key(slot):
    if not 0 <= slot < SLOTS:
        return ""
    return DEFAULT_KEYS[slot // COLS][slot % COLS]


def normalize_key(text):
    """Texte d'une touche → touche de cue (majuscule ; « é » de la rangée des chiffres → « 2 »…)."""
    if not isinstance(text, str) or not text:
        return ""
    k = text[:1]
    return AZERTY_DIGITS.get(k, k.upper())


class Cue:
    def __init__(self, def_id, key="", cue_id=None):
        self.id = cue_id or new_id()
        self.def_id = def_id
        self.key = key

    def to_dict(self):
        return {"id": self.id, "def_id": self.def_id, "key": self.key}

    @classmethod
    def from_dict(cls, d):
        return cls(str(d.get("def_id", "")), normalize_key(d.get("key", "")), d.get("id"))


class Page:
    def __init__(self, name="Page 1", page_id=None):
        self.id = page_id or new_id()
        self.name = name
        self.cues = [None] * SLOTS

    def find(self, cue_id):
        return next((c for c in self.cues if c is not None and c.id == cue_id), None)

    def slot_of(self, cue_id):
        return next((i for i, c in enumerate(self.cues) if c is not None and c.id == cue_id), None)

    def cue_for_key(self, key):
        key = normalize_key(key)
        return next((c for c in self.cues if c is not None and key and c.key == key), None)

    def to_dict(self):
        return {"id": self.id, "name": self.name, "cues": [c.to_dict() if c else None for c in self.cues]}

    @classmethod
    def from_dict(cls, d):
        p = cls(str(d.get("name", "Page")), d.get("id"))
        cues = d.get("cues") if isinstance(d.get("cues"), list) else []
        for i, c in enumerate(cues[:SLOTS]):
            if isinstance(c, dict) and c.get("def_id"):
                p.cues[i] = Cue.from_dict(c)
        return p


class LiveSet:
    def __init__(self):
        self.pages = [Page("Page 1")]
        self.launch = 1              # 0 immédiat, 1 au prochain temps, 2 à la prochaine mesure
        self.multi = False           # plusieurs cues à la fois (sinon un nouveau cue arrête le précédent)

    def find_page(self, page_id):
        return next((p for p in self.pages if p.id == page_id), None)

    def find_cue(self, cue_id):
        """(page, case, cue) ou (None, None, None)."""
        for p in self.pages:
            i = p.slot_of(cue_id)
            if i is not None:
                return p, i, p.cues[i]
        return None, None, None

    def all_cues(self):
        for p in self.pages:
            for c in p.cues:
                if c is not None:
                    yield p, c

    def remove_def(self, def_id):
        """Forme supprimée : ses cases se vident."""
        for p in self.pages:
            p.cues = [None if c is not None and c.def_id == def_id else c for c in p.cues]

    def next_page_name(self):
        names = {p.name for p in self.pages}
        i = len(self.pages) + 1
        while f"Page {i}" in names:
            i += 1
        return f"Page {i}"

    def to_dict(self):
        return {"pages": [p.to_dict() for p in self.pages], "launch": self.launch, "multi": self.multi}

    @classmethod
    def from_dict(cls, d):
        ls = cls()
        if not isinstance(d, dict):
            return ls
        pages = [Page.from_dict(p) for p in d.get("pages", []) or [] if isinstance(p, dict)]
        ls.pages = pages or ls.pages
        launch = d.get("launch", 1)
        ls.launch = launch if isinstance(launch, int) and not isinstance(launch, bool) and 0 <= launch <= 2 else 1
        ls.multi = d.get("multi") is True
        return ls


class QuickEffect:
    """Effet rapide du Live : un effet du registre avec des réglages tout faits, actif tant qu'on le maintient.
    attack (s) : les réglages numériques fixes partent de la valeur neutre du modifieur et rejoignent la leur
    en ce temps (fondu au noir progressif…)."""

    def __init__(self, qid, label, icon, type_id, values=None, oscs=None, attack=0.0):
        self.id = qid
        self.label = label
        self.icon = icon
        self.type_id = type_id
        self.values = values or {}        # {clé: valeur fixe}
        self.oscs = oscs or {}            # {clé: Osc} (autour de la valeur fixe)
        self.attack = attack


# 1/8 de temps dans les divisions du stroboscope / de la pulsation (core/modifiers/intensity_mods.py)
_STROBE_1_8 = 5
_PULSE_1_TEMPS = 2

QUICK_EFFECTS = [
    QuickEffect("strobe", "Strobo 1/8", "zap", "strobe", {"sync": 1, "division": _STROBE_1_8, "duty": 50.0}),
    QuickEffect("rotate", "Rotation", "rotate-cw", "rotate", {"angle": 0.0, "pivot": 2},
                {"angle": Osc("vitesse", speed=90.0, sync=True)}),
    QuickEffect("rainbow", "Arc-en-ciel", "rainbow", "rainbow", {"speed": 1.0, "cycles": 1.0}),
    QuickEffect("blackout", "Fondu noir", "sun", "dimmer", {"level": 0.0}, attack=0.5),
    QuickEffect("pulse", "Pulsation", "activity", "pulse", {"sync": 1, "division": _PULSE_1_TEMPS, "depth": 100.0}),
    QuickEffect("wave", "Onde", "waves", "wave", {"amp": 0.06, "freq": 4.0, "phase": 0.0},
                {"phase": Osc("vitesse", speed=360.0, sync=False)}),
    QuickEffect("mirror", "Miroir", "flip-horizontal-2", "radial_sym", {"count": 2, "kaleido": True}),
    QuickEffect("dots", "Points", "ellipsis", "dots", {"spacing": 0.05, "size": 3}),
]

QUICK_BY_ID = {q.id: q for q in QUICK_EFFECTS}
