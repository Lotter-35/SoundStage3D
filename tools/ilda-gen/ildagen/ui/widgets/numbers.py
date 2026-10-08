"""Nombres affichés et tapés à la française (virgule décimale, signe moins typographique)."""

import math

MINUS = "−"


def fmt_number(v, decimals=0):
    """« 1,5 », « −0,25 », « 62 » ; jamais « −0 »."""
    s = f"{abs(v):.{decimals}f}"
    if v < 0 and float(s) != 0.0:
        s = MINUS + s
    return s.replace(".", ",")


def parse_number(text, unit=""):
    """Nombre tapé (virgule ou point, signe − ou -, unité facultative) ; None si ce n'est pas un nombre fini."""
    t = text.strip()
    u = unit.strip()
    if u and t.endswith(u):
        t = t[: -len(u)]
    t = t.replace(MINUS, "-").replace(",", ".").replace(" ", "").replace(" ", "").replace(" ", "")
    try:
        v = float(t)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


def nice_step(span):
    """Pas de molette / flèches par défaut : une puissance de 10 proche du centième de la plage."""
    if not span or not math.isfinite(span) or span <= 0:
        return 1.0
    return 10.0 ** math.floor(math.log10(span / 100.0))
