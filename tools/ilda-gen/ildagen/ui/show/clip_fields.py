"""Champs de temps du clip actif : Début (mesure.temps.subdivision · secondes), Durée (en mesures / temps quand
c'est rond, sinon en secondes), Fondus d'entrée et de sortie. Saisie en secondes ; valeurs toujours finies et
bornées (« inf », « nan » refusés ; pas de chevauchement avec les voisins, fondus dans le clip)."""

from PySide6.QtWidgets import QGridLayout, QHBoxLayout, QLabel, QWidget

from ...core.timeline import MAX_DURATION, MAX_START, MIN_DURATION
from ..widgets import SliderField, fmt_number

LABEL_W = 70


def musical_duration(d, tl):
    """« 2 mesures », « 3 temps », sinon None."""
    for unit, one, many in ((tl.bar_len, "mesure", "mesures"), (tl.beat_len, "temps", "temps")):
        n = d / unit
        if n >= 1 and abs(n - round(n)) < 1e-4:
            n = int(round(n))
            return f"{n} {one if n == 1 else many}"
    return None


class TimeField(SliderField):
    """SliderField en secondes, affiché en temps musical."""

    def __init__(self, kind, editor, lo, hi, soft_hi):
        super().__init__("", 0.0, lo, hi, 0.0, soft_hi, decimals=3, unit=" s", label_width=0)
        self.kind = kind
        self.editor = editor

    def display_text(self):
        tl = self.editor.doc.timeline
        v = self.value()
        secs = fmt_number(v, 3 if v < 10 else 2) + " s"
        if self.kind == "start":
            bar, beat, sub = tl.position(v)
            return f"{bar}.{beat}.{sub} · {secs}"
        if self.kind == "duration":
            mus = musical_duration(v, tl)
            return f"{mus} · {secs}" if mus else secs
        if v <= 0:
            return "0"
        mus = musical_duration(v, tl)
        return mus or secs


class ClipFields(QWidget):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        g = QGridLayout(self)
        g.setContentsMargins(10, 2, 10, 4)
        g.setHorizontalSpacing(8)
        g.setVerticalSpacing(3)
        g.setColumnMinimumWidth(0, LABEL_W)
        g.setColumnStretch(1, 1)
        self.fields = {
            "start": TimeField("start", editor, 0.0, MAX_START, 60.0),
            "duration": TimeField("duration", editor, MIN_DURATION, MAX_DURATION, 16.0),
            "fade_in": TimeField("fade", editor, 0.0, MAX_DURATION, 4.0),
            "fade_out": TimeField("fade", editor, 0.0, MAX_DURATION, 4.0),
        }
        self.fields["fade_in"].setToolTip("Fondu d'entrée")
        self.fields["fade_out"].setToolTip("Fondu de sortie")
        for row, (label, keys) in enumerate((("Début", ["start"]), ("Durée", ["duration"]),
                                             ("Fondus", ["fade_in", "fade_out"]))):
            lab = QLabel(label)
            lab.setObjectName("dim")
            g.addWidget(lab, row, 0)
            box = QHBoxLayout()
            box.setSpacing(4)
            for k in keys:
                box.addWidget(self.fields[k])
            g.addLayout(box, row, 1)
        for key, f in self.fields.items():
            f.editStarted.connect(lambda: editor.begin("Clip"))
            f.valueChanged.connect(lambda v, k=key: self._set(k, v))
            f.editFinished.connect(lambda _v: self._done())
            f.editCancelled.connect(lambda _v: editor.cancel_gesture())

    def _set(self, key, v):
        """Valeur glissée / tapée, bornée (pas de chevauchement, fondus dans le clip), dans le geste en cours."""
        ed = self.editor
        clip = ed.current_clip()
        if clip is None:
            return
        if key == "start":
            ed.set_clip_times(clip.id, start=v)
        elif key == "duration":
            ed.set_clip_times(clip.id, duration=v)
        elif key == "fade_in":
            ed.set_clip_fades(clip.id, fade_in=v)
        else:
            ed.set_clip_fades(clip.id, fade_out=v)

    def _done(self):
        self.editor.commit()
        self.editor.notify(timeline=True)
        self.refresh()

    def refresh(self):
        clip = self.editor.current_clip()
        if clip is None:
            return
        tl = self.editor.doc.timeline
        if any(f.is_editing() for f in self.fields.values()):
            for key, f in self.fields.items():
                f.set_value(getattr(clip, key))
            return
        self.fields["start"].set_range(0.0, MAX_START, 0.0, max(60.0, tl.length()))
        self.fields["duration"].set_range(MIN_DURATION, MAX_DURATION, 0.0, max(16.0, clip.duration * 2))
        for k in ("fade_in", "fade_out"):
            self.fields[k].set_range(0.0, MAX_DURATION, 0.0, max(0.1, clip.duration))
        for key, f in self.fields.items():
            f.set_value(getattr(clip, key))

    def abort(self):
        for f in self.fields.values():
            f.abort()
