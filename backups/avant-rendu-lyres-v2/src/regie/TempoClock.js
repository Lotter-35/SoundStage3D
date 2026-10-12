/**
 * TempoClock.js — horloge des temps musicaux de la régie.
 *
 * Temps (beats) = temps d'ancrage + durée écoulée × BPM, sur l'horloge du serveur :
 * les trames datées « maintenant + avance » sont calculées au bon temps musical.
 * Changer le BPM ré-ancre l'horloge (pas de saut de phase) ; le tap tempo règle le BPM
 * sur les derniers tapotements et cale un temps sur le dernier.
 * Une source externe (la timeline du morceau en lecture) peut imposer temps et BPM : follow().
 */

const MIN_BPM = 20;
const MAX_BPM = 300;
const TAP_RESET = 2000;  // au-delà, une nouvelle série de tapotements commence (ms)
const TAP_KEEP = 8;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class TempoClock {
    /** @param {() => number} now heure du serveur (ms) */
    constructor(now, bpm = 120) {
        this._now = now;
        this.bpm = clamp(bpm, MIN_BPM, MAX_BPM);
        this._t0 = now();
        this._b0 = 0;
        this._taps = [];
        this._source = null;
    }

    /**
     * Source prioritaire des temps : fn(t) → { beat, bpm } ou null (horloge propre)
     * @param {(t: number) => ({beat: number, bpm: number}|null)} fn
     */
    follow(fn) {
        this._source = fn;
    }

    _follow(t) {
        return this._source ? this._source(t) : null;
    }

    /** true si le tempo suit en ce moment le morceau */
    isFollowing() {
        return Boolean(this._follow(this._now()));
    }

    /** BPM en vigueur (celui du morceau quand il est suivi) */
    effectiveBpm() {
        const s = this._follow(this._now());
        return s ? s.bpm : this.bpm;
    }

    /** Temps musical (en temps, fractionnaire) à l'heure serveur t (ms) */
    beatAt(t) {
        const s = this._follow(t);
        if (s) return s.beat;
        return this._own(t);
    }

    _own(t) {
        return this._b0 + ((t - this._t0) * this.bpm) / 60000;
    }

    beatNow() {
        return this.beatAt(this._now());
    }

    setBpm(bpm) {
        const b = clamp(Number(bpm) || this.bpm, MIN_BPM, MAX_BPM);
        const t = this._now();
        this._b0 = this._own(t);
        this._t0 = t;
        this.bpm = Math.round(b * 10) / 10;
    }

    /** Tapotement : BPM moyen des derniers intervalles, temps calé sur ce tapotement */
    tap() {
        const t = this._now();
        const beat = this._own(t); // avec l'ancien BPM (continuité de phase)
        const taps = this._taps;
        if (taps.length && t - taps[taps.length - 1] > TAP_RESET) taps.length = 0;
        taps.push(t);
        if (taps.length > TAP_KEEP) taps.shift();
        if (taps.length >= 2) {
            const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
            this.bpm = Math.round(clamp(60000 / avg, MIN_BPM, MAX_BPM) * 10) / 10;
        }
        // Le temps le plus proche tombe exactement sur ce tapotement
        this._b0 = Math.round(beat);
        this._t0 = t;
        return this.bpm;
    }
}
