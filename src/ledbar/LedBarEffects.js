/**
 * LedBarEffects.js
 * ─────────────────────────────────────────────────────────────
 * Générateur d'effets intégré de la barre LED (macros « FX channels ») :
 * chaque motif donne, pour chaque LED, un niveau 0…1 entre la couleur de fond
 * et la couleur de premier plan (ou une couleur propre pour les arcs-en-ciel).
 *
 * Tout est calculé à partir de l'horloge COMMUNE à tous les joueurs (aucun état) :
 * le même chenillard s'affiche au même instant chez tout le monde, sans trafic réseau.
 * ─────────────────────────────────────────────────────────────
 */

import { FX_DIRECTIONS, FX_PATTERNS, hexToRgb } from './config/ledBarParams.js';

const TAU = Math.PI * 2;

const fract = (x) => x - Math.floor(x);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const tri = (x) => 1 - Math.abs(fract(x) * 2 - 1);            // 0 → 1 → 0
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Pseudo-aléatoire déterministe à partir de 2 entiers */
function hash(a, b) {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
}

/** Bord de motif : net (carré) si soft = 0, fondu progressif sinon. d = distance au centre, hw = demi-largeur */
function band(d, hw, soft) {
    if (soft < 0.01) return d <= hw ? 1 : 0;
    const e = Math.max(1e-3, hw * soft * 1.5 + soft * 0.04);
    return 1 - smooth(hw - e * 0.5, hw + e, d);
}

/** Distance circulaire sur [0, 1[ */
const cdist = (a, b) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

function hsv(h, out, o) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const q = 1 - f, t = f;
    let r, g, b;
    switch (((i % 6) + 6) % 6) {
        case 0: r = 1; g = t; b = 0; break;
        case 1: r = q; g = 1; b = 0; break;
        case 2: r = 0; g = 1; b = t; break;
        case 3: r = 0; g = q; b = 1; break;
        case 4: r = t; g = 0; b = 1; break;
        default: r = 1; g = 0; b = q;
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b;
}

const _fg = [0, 0, 0];
const _bg = [0, 0, 0];

/** Cycles par seconde selon la vitesse (0…100 %) */
export function fxRate(speed) {
    const s = Math.max(0, Math.min(100, speed)) / 100;
    return 0.04 + 3.96 * Math.pow(s, 1.6);
}

/**
 * Calcule les couleurs des LED pour le motif courant.
 * @param {object} p paramètres de la barre
 * @param {number} n nombre de LED
 * @param {number} time horloge commune (s)
 * @param {Float32Array} out n × 3 valeurs RGB (0…1)
 * @param {number} [seed] numéro de la barre (motifs aléatoires différents d'une barre à l'autre)
 * @returns {boolean} false si aucun motif n'est actif
 */
export function computeFxPixels(p, n, time, out, seed = 0) {
    const pattern = FX_PATTERNS.indexOf(p.fxPattern);
    if (pattern <= 0) return false;
    hexToRgb(p.fxFg, _fg);
    hexToRgb(p.fxBg, _bg);
    const ph = time * fxRate(p.fxSpeed);
    const soft = Math.max(0, Math.min(100, p.fxFade)) / 100;
    const w = Math.max(1, Math.min(100, p.fxSize)) / 100;
    const dir = Math.max(0, FX_DIRECTIONS.indexOf(p.fxDirection));
    const name = FX_PATTERNS[pattern];

    for (let i = 0; i < n; i++) {
        const x = n > 1 ? i / (n - 1) : 0.5;
        // Coordonnée orientée selon le sens choisi
        let u;
        if (dir === 1) u = 1 - x;
        else if (dir === 2) u = Math.abs(x - 0.5) * 2;
        else if (dir === 3) u = 1 - Math.abs(x - 0.5) * 2;
        else u = x;
        const o = i * 3;
        let l = 0;

        switch (name) {
            case 'Chenillard':
                l = band(cdist(u, fract(ph)), w * 0.5, soft);
                break;
            case 'Va-et-vient':
                l = band(Math.abs(u - tri(ph * 0.5)), w * 0.5, soft);
                break;
            case 'K2000 (scanner)': {
                const t = ph * 0.5;
                const pos = tri(t);
                const goingUp = fract(t) < 0.5;
                const behind = goingUp ? pos - u : u - pos;
                const head = band(Math.abs(u - pos), 0.5 / n + w * 0.1, soft);
                const tail = behind > 0 ? Math.exp(-behind / Math.max(0.02, w * 0.6)) * 0.85 : 0;
                l = Math.max(head, tail);
                break;
            }
            case 'Comète': {
                const len = Math.max(0.05, w);
                const head = fract(ph) * (1 + len);
                const db = head - u;
                l = db >= 0 && db <= len ? Math.pow(1 - db / len, 1 + 2 * (1 - soft)) : 0;
                break;
            }
            case 'Vague': {
                const wl = Math.max(0.06, w * 2);
                const s = 0.5 + 0.5 * Math.sin(TAU * (u / wl - ph));
                l = soft < 0.01 ? (s > 0.5 ? 1 : 0) : smooth(0.5 - soft * 0.5, 0.5 + soft * 0.5, s);
                break;
            }
            case 'Double vague': {
                const wl = Math.max(0.06, w * 2);
                const a = 0.5 + 0.5 * Math.sin(TAU * (x / wl - ph));
                const b = 0.5 + 0.5 * Math.sin(TAU * (x / wl + ph * 0.8));
                const s = Math.max(a, b) * Math.min(1, a + b);
                l = soft < 0.01 ? (s > 0.6 ? 1 : 0) : smooth(0.6 - soft * 0.5, 0.6 + soft * 0.4, s);
                break;
            }
            case 'Rebond': {
                // Balle qui rebondit (gravité) depuis le début de la barre
                const f = fract(ph * 0.7);
                const pos = 1 - Math.pow(f * 2 - 1, 2);
                l = band(Math.abs(u - pos), Math.max(0.5 / n, w * 0.25), soft);
                break;
            }
            case 'Éclatement centre': {
                const c = Math.abs(x - 0.5) * 2;
                const r = dir === 1 || dir === 3 ? 1 - fract(ph) : fract(ph);
                l = band(Math.abs(c - r), w * 0.4, soft) * (1 - 0.6 * r * (dir === 1 || dir === 3 ? 0 : 1));
                break;
            }
            case 'Séparation': {
                const d = tri(ph * 0.5) * 0.5;
                const dd = Math.min(Math.abs(x - (0.5 + d)), Math.abs(x - (0.5 - d)));
                l = band(dd, w * 0.35, soft);
                break;
            }
            case 'Remplissage': {
                // La barre se remplit puis se vide (bord net ou fondu)
                const f = tri(ph * 0.5) * (1 + 1 / n) - 0.5 / n;
                if (u <= f) l = 1;
                else l = soft < 0.01 ? 0 : 1 - smooth(f, f + soft * 0.3 + 1e-3, u);
                break;
            }
            case 'Empilement': {
                // Des blocs traversent la barre et s'empilent au bout, puis tout se vide
                const size = Math.max(1 / n, w * 0.5);
                const slots = Math.max(1, Math.floor(1 / size));
                const total = ph * 2;
                const cycle = Math.floor(total / (slots + 1));
                const k = Math.floor(total) - cycle * (slots + 1);      // blocs déjà empilés
                const f = fract(total);
                const stackTop = 1 - k * size;
                if (u >= stackTop) l = 1;
                else if (k < slots) {
                    const target = stackTop - size * 0.5;
                    const pos = f * target;
                    l = band(Math.abs(u - pos), size * 0.5, soft);
                }
                break;
            }
            case 'Pair / Impair': {
                const t = ph * 2;
                const s = soft < 0.01 ? (Math.floor(t) % 2) : smooth(0.5 - soft * 0.5, 0.5 + soft * 0.5, tri(t * 0.5));
                l = (i % 2 === 0) ? s : 1 - s;
                break;
            }
            case 'Damier': {
                const g = Math.max(1, Math.round(w * n * 0.5));
                const t = ph * 2;
                const s = soft < 0.01 ? (Math.floor(t) % 2) : smooth(0.5 - soft * 0.5, 0.5 + soft * 0.5, tri(t * 0.5));
                l = (Math.floor(i / g) % 2 === 0) ? s : 1 - s;
                break;
            }
            case 'Étincelles': {
                const t = ph * 6;
                const k = Math.floor(t + hash(i, seed) );
                const f = fract(t + hash(i, seed));
                const on = hash(i + seed * 57, k) < 0.1 + w * 0.6;
                l = on ? Math.pow(1 - f, 1 + 5 * (1 - soft)) : 0;
                break;
            }
            case 'Pluie': {
                let m = 0;
                for (let k = 0; k < 3; k++) {
                    const t = ph * (0.8 + hash(k, seed) * 0.6) + hash(k + 11, seed);
                    const head = fract(t) * 1.4;
                    const db = head - u;
                    const len = Math.max(0.05, w * 0.6);
                    if (db >= 0 && db <= len) m = Math.max(m, Math.pow(1 - db / len, 1.5 + 2 * (1 - soft)));
                }
                l = m;
                break;
            }
            case 'Code-barres': {
                const beat = Math.floor(ph * 4);
                const g = 1 + Math.floor(hash(beat, seed) * Math.max(1, w * n * 0.5));
                l = hash(Math.floor(i / g) + seed * 13, beat) > 0.5 ? 1 : 0;
                if (soft > 0.01) l *= 1 - smooth(1 - soft, 1, fract(ph * 4)) * 0.6;
                break;
            }
            case 'Strobe pixel': {
                const beat = Math.floor(ph * 12);
                const on = hash(i + seed * 31, beat) > 1 - (0.06 + w * 0.5);
                l = on && fract(ph * 12) < 0.45 + soft * 0.5 ? 1 : 0;
                break;
            }
            case 'Respiration': {
                const s = 0.5 - 0.5 * Math.cos(TAU * ph * 0.5);
                l = soft < 0.01 ? (s > 0.5 ? 1 : 0) : Math.pow(s, 1.6);
                break;
            }
            case 'Dégradé défilant': {
                const s = fract(u / Math.max(0.1, w * 2) - ph);
                l = soft < 0.01 ? s : tri(s) ;
                break;
            }
            case 'Arc-en-ciel':
                hsv(fract(u / Math.max(0.1, w * 3) - ph), out, o);
                continue;
            case 'Arc-en-ciel global':
                hsv(fract(ph * 0.25), out, o);
                continue;
            default:
                l = 0;
        }
        l = clamp01(l);
        out[o] = _bg[0] + (_fg[0] - _bg[0]) * l;
        out[o + 1] = _bg[1] + (_fg[1] - _bg[1]) * l;
        out[o + 2] = _bg[2] + (_fg[2] - _bg[2]) * l;
    }
    return true;
}
