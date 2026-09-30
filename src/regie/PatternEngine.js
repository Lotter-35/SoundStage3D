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
 */

import { writeAttribute, attributeType } from './attributes.js';

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
        /** @type {Map<string, {startBeat: number}>} patterns en lecture, du plus ancien au plus récent */
        this.playing = new Map();
        this.version = 0;
        this._targetCache = new Map();
    }

    _pattern(id) {
        const show = this.getShow();
        return show ? show.patterns.find((p) => p.id === id) || null : null;
    }

    isPlaying(id) {
        return this.playing.has(id);
    }

    /** Lance un pattern, calé sur le temps en cours (il passe au-dessus des autres) */
    play(id, t) {
        this.playing.delete(id);
        this.playing.set(id, { startBeat: Math.floor(this.tempo.beatAt(t)) });
        this.version++;
    }

    stop(id) {
        if (this.playing.delete(id)) this.version++;
    }

    toggle(id, t) {
        if (this.playing.has(id)) this.stop(id);
        else this.play(id, t);
    }

    stopAll() {
        if (this.playing.size === 0) return;
        this.playing.clear();
        this.version++;
    }

    /** Temps local (0…longueur) d'un pattern en lecture, ou null */
    localBeat(pattern, t) {
        const pb = this.playing.get(pattern.id);
        if (!pb) return null;
        return mod(this.tempo.beatAt(t) - pb.startBeat, Math.max(0.25, pattern.length || 4));
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
        for (const [id, pb] of this.playing) {
            const pat = this._pattern(id);
            if (!pat) {
                this.playing.delete(id);
                this.version++;
                continue;
            }
            const L = Math.max(0.25, pat.length || 4);
            const b = mod(beat - pb.startBeat, L);
            for (const tr of pat.tracks) {
                if (tr.mute) continue;
                const fixtures = this.targetsOf(tr);
                const n = fixtures.length;
                for (let i = 0; i < n; i++) {
                    const v = sampleTrack(tr, b, L, i, n);
                    if (v === null) continue;
                    const f = fixtures[i];
                    writeAttribute(frameOf(f.universe), f, tr.attr, v);
                }
            }
        }
    }
}
