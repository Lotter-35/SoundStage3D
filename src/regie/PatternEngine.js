/**
 * PatternEngine.js — lecture des patterns de la régie.
 *
 * Un pattern est une boucle de N temps faite de pistes. Une piste pilote un attribut
 * (intensité, couleur, pan…) d'une cible (groupe ou liste de projecteurs) :
 *   - « Points » : valeurs placées dans le temps, interpolées (palier, linéaire, douce) ;
 *   - « Générateur » : forme d'onde répétée N fois par boucle, entre deux valeurs (ou deux couleurs).
 * Le décalage répartit la piste entre les projecteurs, dans l'ordre choisi (vague, chenillard) :
 * à 100 %, le dernier projecteur a un cycle complet de retard sur le premier.
 *
 * Les patterns en lecture s'ajoutent par-dessus les réglages manuels ; le dernier lancé passe
 * au-dessus des précédents sur les canaux qu'ils partagent.
 *
 * Lecture (clé = pattern depuis l'éditeur, ou pad du mode Live) : départ calé sur le temps ou la
 * mesure (en attente jusque-là), fondu d'entrée et de sortie (mélange avec ce qui est dessous),
 * rangée exclusive (lancer un pad arrête l'autre pad de sa rangée au même moment), niveau de
 * rangée (intensité seulement) et vitesse globale (×½, ×1, ×2…) sans saut de position.
 */

import { writeAttribute, attributeType, scaleIntensity } from './attributes.js';

export const SHAPES = [
    ['sine', 'Sinus'], ['triangle', 'Triangle'], ['square', 'Carré'], ['saw', 'Dent de scie'],
    ['ramp', 'Rampe descendante'], ['pulse', 'Impulsion'], ['random', 'Aléatoire'],
];
export const ORDERS = [
    ['patch', 'Ordre du patch'], ['ltr', 'Gauche → droite'], ['rtl', 'Droite → gauche'],
    ['center', 'Centre → extérieur'], ['edges', 'Extérieur → centre'], ['random', 'Aléatoire'],
];
export const INTERPS = [['step', 'Palier'], ['linear', 'Linéaire'], ['smooth', 'Douce']];

const mod = (a, n) => ((a % n) + n) % n;

function hash(a, b) {
    let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Forme d'onde (phase 0…1 → 0…1) ; `width` = part du cycle allumée (carré, impulsion) */
export function wave(shape, p, width = 0.5) {
    switch (shape) {
        case 'triangle': return p < 0.5 ? p * 2 : 2 - p * 2;
        case 'square': return p < width ? 1 : 0;
        case 'saw': return p;
        case 'ramp': return 1 - p;
        case 'pulse': return p < width ? Math.sin((Math.PI * p) / Math.max(0.001, width)) : 0;
        case 'sine':
        default: return 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
    }
}

const _rgb = new Map();
export function hexToRgb01(hex) {
    let c = _rgb.get(hex);
    if (!c) {
        const n = parseInt(String(hex || '#000000').replace('#', ''), 16) || 0;
        c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
        _rgb.set(hex, c);
    }
    return c;
}

const lerp = (a, b, k) => a + (b - a) * k;
const lerp3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];

/** Valeur d'une piste à points au temps b d'une boucle de longueur L (points triés par temps) */
function evalPoints(points, interp, b, L, isColor) {
    // Points au-delà de la longueur (boucle raccourcie) : gardés, mais ignorés
    let n = points ? points.length : 0;
    while (n > 0 && points[n - 1].t >= L) n--;
    if (n === 0) return null;
    const val = (pt) => (isColor ? hexToRgb01(pt.c) : pt.v);
    if (n === 1) return val(points[0]);
    let i = -1;
    for (let k = 0; k < n; k++) if (points[k].t <= b) i = k;
    const prev = i >= 0 ? points[i] : points[n - 1];
    const tPrev = i >= 0 ? prev.t : prev.t - L;
    const next = i + 1 < n ? points[i + 1] : points[0];
    const tNext = i + 1 < n ? next.t : next.t + L;
    if (interp === 'step' || tNext <= tPrev) return val(prev);
    let k = (b - tPrev) / (tNext - tPrev);
    if (interp === 'smooth') k = k * k * (3 - 2 * k);
    return isColor ? lerp3(val(prev), val(next), k) : lerp(val(prev), val(next), k);
}

/**
 * Valeur d'une piste pour le projecteur n° i (sur n) au temps b d'une boucle de L temps
 * @returns {number|number[]|null} 0…1, [r, g, b] pour la couleur, null si la piste ne joue rien
 */
export function sampleTrack(tr, b, L, i, n) {
    const isColor = attributeType(tr.attr) === 'color';
    const off = n > 1 ? ((tr.spread || 0) * i) / n : 0;
    if (tr.mode === 'wave') {
        const cycles = Math.max(0.0625, Number(tr.cycles) || 1);
        const raw = (b / L) * cycles - off;
        const w = tr.shape === 'random' ? hash(Math.floor(raw), i + 1) : wave(tr.shape, mod(raw, 1), tr.width ?? 0.5);
        if (isColor) return lerp3(hexToRgb01(tr.colorA || '#000000'), hexToRgb01(tr.colorB || '#ffffff'), w);
        const lo = tr.low ?? 0;
        const hi = tr.high ?? 1;
        return lo + (hi - lo) * w;
    }
    return evalPoints(tr.points, tr.interp, mod(b - off * L, L), L, isColor);
}

/** Projecteurs d'une piste dans l'ordre de répartition du décalage */
function orderFixtures(list, order, seed) {
    const out = list.slice();
    switch (order) {
        case 'ltr': return out.sort((a, b) => a.x - b.x || a.z - b.z);
        case 'rtl': return out.sort((a, b) => b.x - a.x || a.z - b.z);
        case 'center': return out.sort((a, b) => Math.abs(a.x) - Math.abs(b.x) || a.x - b.x);
        case 'edges': return out.sort((a, b) => Math.abs(b.x) - Math.abs(a.x) || a.x - b.x);
        case 'random': return out
            .map((f, i) => ({ f, r: hash(seed, i + 7) }))
            .sort((a, b) => a.r - b.r)
            .map((x) => x.f);
        default: return out;
    }
}

function seedOf(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
    return h;
}

export class PatternEngine {
    /**
     * @param {object} o
     * @param {import('./FixtureStore.js').FixtureStore} o.store
     * @param {import('./TempoClock.js').TempoClock} o.tempo
     * @param {() => object|null} o.getShow   show courant ({ patterns: [...] })
     */
    constructor({ store, tempo, getShow }) {
        this.store = store;
        this.tempo = tempo;
        this.getShow = getShow;
        /**
         * Lectures en cours, de la plus ancienne à la plus récente (dessinées dans cet ordre)
         * @type {Map<string, {patternId: string, startBeat: number, fadeIn: number, stopBeat: number|null,
         *   fadeOut: number, row: string|null, level: (() => number)|null}>}
         */
        this.playing = new Map();
        this.speed = 1;
        this.version = 0;
        this._targetCache = new Map();
    }

    _pattern(id) {
        const show = this.getShow();
        return show ? show.patterns.find((p) => p.id === id) || null : null;
    }

    isPlaying(key) {
        const pb = this.playing.get(key);
        return Boolean(pb) && pb.stopBeat === null;
    }

    /** Un pattern joue-t-il, depuis l'éditeur ou un pad ? */
    isPatternPlaying(patternId) {
        for (const pb of this.playing.values()) if (pb.patternId === patternId && pb.stopBeat === null) return true;
        return false;
    }

    /**
     * État d'une lecture à l'heure t : 'pending' (attend son départ), 'playing', 'stopping'
     * (arrêt programmé ou fondu de sortie) ou null
     */
    state(key, t) {
        const pb = this.playing.get(key);
        if (!pb) return null;
        const beat = this.tempo.beatAt(t);
        if (beat < pb.startBeat) return 'pending';
        if (pb.stopBeat !== null) return 'stopping';
        return 'playing';
    }

    /** Prochain départ calé sur `q` temps (1 = temps, 4 = mesure, 0 = tout de suite) */
    _quantized(beat, q) {
        if (!(q > 0)) return beat;
        const k = Math.ceil(beat / q - 1e-6) * q;
        return k;
    }

    /**
     * Lance une lecture ; elle passe au-dessus des autres
     * @param {string} key   identifiant de la lecture (pattern ou pad)
     * @param {number} t     heure serveur de la trame en préparation
     * @param {object} [o]
     * @param {string} [o.pattern]   pattern joué (par défaut : key)
     * @param {number} [o.quantize]  départ calé sur ce nombre de temps (sans : calé sur le temps en cours)
     * @param {number} [o.fade]      fondu d'entrée (et de sortie de la lecture remplacée), en temps
     * @param {string} [o.row]       rangée exclusive
     * @param {() => number} [o.level] niveau d'intensité (0…1)
     */
    play(key, t, o = {}) {
        const beat = this.tempo.beatAt(t);
        const startBeat = o.quantize === undefined ? Math.floor(beat) : this._quantized(beat, o.quantize);
        const fade = Math.max(0, o.fade || 0);
        if (o.row) {
            for (const [k, pb] of this.playing) {
                if (k === key || pb.row !== o.row || pb.stopBeat !== null) continue;
                pb.stopBeat = Math.max(startBeat, pb.startBeat);
                pb.fadeOut = fade;
            }
        }
        this.playing.delete(key);
        this.playing.set(key, {
            patternId: o.pattern || key, startBeat, fadeIn: o.quantize === undefined ? 0 : fade,
            stopBeat: null, fadeOut: 0, row: o.row || null, level: o.level || null,
        });
        this.version++;
    }

    /**
     * Arrête une lecture (tout de suite, ou au prochain temps / à la prochaine mesure, avec fondu)
     * @param {object} [o] { quantize, fade } comme pour play()
     */
    stop(key, t, o = {}) {
        const pb = this.playing.get(key);
        if (!pb) return;
        const fade = Math.max(0, o.fade || 0);
        if (t === undefined || (!(o.quantize > 0) && fade === 0)) {
            this.playing.delete(key);
        } else {
            const beat = this.tempo.beatAt(t);
            pb.stopBeat = Math.max(pb.startBeat, this._quantized(beat, o.quantize));
            pb.fadeOut = fade;
        }
        this.version++;
    }

    toggle(key, t, o) {
        if (this.isPlaying(key)) this.stop(key, t, o);
        else this.play(key, t, o);
    }

    /** Arrête la lecture en cours d'une rangée */
    stopRow(row, t, o) {
        for (const [k, pb] of this.playing) if (pb.row === row && pb.stopBeat === null) this.stop(k, t, o);
    }

    stopAll() {
        if (this.playing.size === 0) return;
        this.playing.clear();
        this.version++;
    }

    /** Vitesse de toutes les lectures ; chacune garde sa position (pas de saut) */
    setSpeed(v, t) {
        const speed = Math.max(0.125, Math.min(8, Number(v) || 1));
        if (speed === this.speed) return;
        const beat = this.tempo.beatAt(t);
        for (const pb of this.playing.values()) {
            if (beat > pb.startBeat) pb.startBeat = beat - ((beat - pb.startBeat) * this.speed) / speed;
        }
        this.speed = speed;
        this.version++;
    }

    /** Position (0…longueur, en temps du pattern) d'une lecture à l'heure t, ou null */
    localBeatOf(key, pattern, t) {
        const pb = this.playing.get(key);
        if (!pb) return null;
        const beat = this.tempo.beatAt(t);
        if (beat < pb.startBeat) return null;
        return mod((beat - pb.startBeat) * this.speed, Math.max(0.25, pattern.length || 4));
    }

    /** Position d'un pattern lancé depuis l'éditeur, ou null */
    localBeat(pattern, t) {
        return this.localBeatOf(pattern.id, pattern, t);
    }

    /** Projecteurs visés par une piste (groupe ou liste), dans l'ordre du décalage */
    targetsOf(tr) {
        const store = this.store;
        const tgt = tr.target || {};
        const key = `${store.version}|${tgt.group || ''}|${(tgt.keys || []).join(',')}|${tr.order || 'patch'}`;
        const cached = this._targetCache.get(tr.id);
        if (cached && cached.key === key) return cached.list;
        let keys = [];
        if (tgt.group) {
            const g = store.groups.find((x) => x.id === tgt.group);
            keys = g ? store.groupKeys(g) : [];
        } else if (Array.isArray(tgt.keys)) {
            keys = tgt.keys.filter((k) => store.byKey.has(k));
        }
        const list = orderFixtures(keys.map((k) => store.get(k)).filter(Boolean), tr.order, seedOf(tr.id || ''));
        this._targetCache.set(tr.id, { key, list });
        return list;
    }

    /**
     * Écrit les patterns en lecture dans les univers de sortie (appelé à chaque trame)
     * @param {(universe: number) => Uint8Array} frameOf
     * @param {number} t heure serveur de la trame (ms)
     */
    apply(frameOf, t) {
        if (this.playing.size === 0) return;
        const beat = this.tempo.beatAt(t);
        for (const [key, pb] of this.playing) {
            const pat = this._pattern(pb.patternId);
            if (!pat) {
                this.playing.delete(key);
                this.version++;
                continue;
            }
            if (beat < pb.startBeat) continue; // en attente de son départ
            // Poids : fondu d'entrée, puis arrêt (net ou fondu de sortie)
            let w = pb.fadeIn > 0 ? (beat - pb.startBeat) / pb.fadeIn : 1;
            if (pb.stopBeat !== null && beat >= pb.stopBeat) {
                if (!(pb.fadeOut > 0) || beat >= pb.stopBeat + pb.fadeOut) {
                    this.playing.delete(key);
                    this.version++;
                    continue;
                }
                w = Math.min(w, 1 - (beat - pb.stopBeat) / pb.fadeOut);
            }
            w = Math.max(0, Math.min(1, w));
            if (w <= 0) continue;
            const level = pb.level ? Math.max(0, Math.min(1, pb.level())) : 1;
            const L = Math.max(0.25, pat.length || 4);
            this.applyPattern(pat, mod((beat - pb.startBeat) * this.speed, L), w, level, frameOf);
        }
    }

    /**
     * Écrit un pattern à la position b (temps du pattern) dans les univers de sortie
     * @param {object} pat
     * @param {number} b      position dans la boucle (0…longueur)
     * @param {number} w      poids (fondu : mélange avec ce qu'il y a dessous), 1 = plein
     * @param {number} level  niveau d'intensité (0…1)
     * @param {(universe: number) => Uint8Array} frameOf
     */
    applyPattern(pat, b, w, level, frameOf) {
        const L = Math.max(0.25, pat.length || 4);
        // Fondu : on écrit dans les univers puis on mélange avec ce qu'il y avait dessous
        let target = frameOf;
        let snaps = null;
        if (w < 1) {
            snaps = new Map();
            target = (n) => {
                const f = frameOf(n);
                if (!snaps.has(n)) snaps.set(n, f.slice());
                return f;
            };
        }
        const touched = level < 1 ? new Set() : null;
        for (const tr of pat.tracks) {
            if (tr.mute) continue;
            const fixtures = this.targetsOf(tr);
            const n = fixtures.length;
            for (let i = 0; i < n; i++) {
                const v = sampleTrack(tr, b, L, i, n);
                if (v === null) continue;
                const f = fixtures[i];
                writeAttribute(target(f.universe), f, tr.attr, v);
                if (touched) touched.add(f);
            }
        }
        // Niveau de rangée : intensité des projecteurs du pattern (qu'il la pilote ou non)
        if (touched) for (const f of touched) scaleIntensity(target(f.universe), f, level);
        if (snaps) {
            for (const [n, before] of snaps) {
                const f = frameOf(n);
                for (let i = 0; i < f.length; i++) {
                    if (f[i] !== before[i]) f[i] = Math.round(before[i] + (f[i] - before[i]) * w);
                }
            }
        }
    }
}
