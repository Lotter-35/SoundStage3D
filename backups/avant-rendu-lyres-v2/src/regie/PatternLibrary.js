/**
 * PatternLibrary.js — patterns pré-programmés de la régie.
 *
 * Chaque pattern vise des TYPES de projecteurs (toutes les lyres, tous les strobes…) et non des groupes :
 * il fonctionne dans n'importe quelle salle. Ajouté au show, il devient un pattern ordinaire (modifiable).
 * Une piste dont l'attribut n'existe pas sur un type (pan d'un strobe…) est simplement sans effet.
 *
 * Repères de valeurs (0…1) :
 *   - lyres : pan 0,5 = face (±0,056 ≈ ±30°) ; tilt 0,5 = vers le haut, 0,63 ≈ 35° vers le public, 0,83 = horizontal ;
 *   - lasers : position 0,5 = centre (±0,17 ≈ ±20°) ; « Écart » = zoom ;
 *   - strobe : 0 = lumière continue, au-delà cadence lente → rapide.
 */

import { newId, LIVE_COLS } from './ShowStore.js';

// ── Aides de construction ──────────────────────────────────────────────────
const BASE = { mode: 'wave', shape: 'sine', cycles: 1, low: 0, high: 1, width: 0.5, spread: 0, order: 'ltr', interp: 'linear', points: [], mute: false };

/** Piste « générateur » */
const wave = (kind, attr, o = {}) => ({ ...BASE, target: { kind }, attr, ...o });
/** Piste « points » (valeurs) : [[temps, valeur], …] */
const pts = (kind, attr, list, o = {}) => ({ ...BASE, target: { kind }, attr, mode: 'points', points: list.map(([t, v]) => ({ t, v })), ...o });
/** Piste « points » (couleurs) : [[temps, '#rrggbb'], …] */
const cols = (kind, list, o = {}) => ({ ...BASE, target: { kind }, attr: 'color', mode: 'points', points: list.map(([t, c]) => ({ t, c })), ...o });
/** Couleur fixe */
const color = (kind, c) => cols(kind, [[0, c]], { interp: 'step' });
/** Valeur fixe */
const fixed = (kind, attr, v) => pts(kind, attr, [[0, v]], { interp: 'step' });
/** Couleurs réparties sur la boucle */
const spread = (list, L) => list.map((c, i) => [(i * L) / list.length, c]);

const RAINBOW = ['#ff1a1a', '#ff8c00', '#ffe600', '#1aff3c', '#00e5ff', '#1a3cff', '#b01aff'];
const WHITE = '#ffffff';

export const LIBRARY_CATEGORIES = [
    ['dimmer', 'Intensité'],
    ['color', 'Couleurs'],
    ['move', 'Mouvements (lyres)'],
    ['fx', 'Strobe et effets'],
    ['laser', 'Lasers'],
    ['ledbar', 'Barres LED'],
    ['mood', 'Ambiances'],
];

/** @type {{id: string, category: string, name: string, length: number, tracks: object[]}[]} */
export const PATTERN_LIBRARY = [
    // ── Intensité ──────────────────────────────────────────────────────────
    { id: 'dim-full', category: 'dimmer', name: 'Plein feu', length: 4, tracks: [fixed('all', 'dimmer', 1)] },
    { id: 'dim-half', category: 'dimmer', name: 'Demi-teinte', length: 4, tracks: [fixed('all', 'dimmer', 0.35)] },
    { id: 'dim-breath', category: 'dimmer', name: 'Respiration lente', length: 16, tracks: [wave('all', 'dimmer', { low: 0.15 })] },
    { id: 'dim-beat', category: 'dimmer', name: 'Pulsation au temps', length: 4, tracks: [wave('all', 'dimmer', { shape: 'ramp', cycles: 4, low: 0.1 })] },
    { id: 'dim-bar', category: 'dimmer', name: 'Flash sur le 1', length: 4, tracks: [wave('all', 'dimmer', { shape: 'pulse', width: 0.2 })] },
    { id: 'dim-offbeat', category: 'dimmer', name: 'Contretemps', length: 2, tracks: [pts('all', 'dimmer', [[0, 0.1], [0.5, 1], [0.75, 0.1], [1, 0.1], [1.5, 1], [1.75, 0.1]], { interp: 'step' })] },
    { id: 'dim-chase-ltr', category: 'dimmer', name: 'Chenillard gauche → droite', length: 4, tracks: [wave('spot', 'dimmer', { shape: 'square', width: 0.18, spread: 1, order: 'ltr' })] },
    { id: 'dim-chase-rtl', category: 'dimmer', name: 'Chenillard droite → gauche', length: 4, tracks: [wave('spot', 'dimmer', { shape: 'square', width: 0.18, spread: 1, order: 'rtl' })] },
    { id: 'dim-chase-fast', category: 'dimmer', name: 'Chenillard rapide', length: 2, tracks: [wave('spot', 'dimmer', { shape: 'square', width: 0.15, spread: 1, cycles: 2 })] },
    { id: 'dim-wave', category: 'dimmer', name: 'Vague douce', length: 8, tracks: [wave('spot', 'dimmer', { spread: 1, low: 0.05 })] },
    { id: 'dim-center-out', category: 'dimmer', name: 'Vague centre → extérieur', length: 4, tracks: [wave('spot', 'dimmer', { shape: 'pulse', width: 0.4, spread: 0.8, order: 'center' })] },
    { id: 'dim-out-center', category: 'dimmer', name: 'Vague extérieur → centre', length: 4, tracks: [wave('spot', 'dimmer', { shape: 'pulse', width: 0.4, spread: 0.8, order: 'edges' })] },
    { id: 'dim-sparkle', category: 'dimmer', name: 'Scintillement aléatoire', length: 4, tracks: [wave('all', 'dimmer', { shape: 'random', cycles: 16, low: 0.1 })] },
    { id: 'dim-16th', category: 'dimmer', name: 'Hachures (doubles croches)', length: 1, tracks: [wave('spot', 'dimmer', { shape: 'square', cycles: 4, width: 0.4 })] },

    // ── Couleurs ───────────────────────────────────────────────────────────
    { id: 'col-white', category: 'color', name: 'Tout blanc', length: 4, tracks: [color('all', WHITE)] },
    { id: 'col-red', category: 'color', name: 'Tout rouge', length: 4, tracks: [color('all', '#ff1a1a')] },
    { id: 'col-blue', category: 'color', name: 'Bleu profond', length: 4, tracks: [color('all', '#1a3cff')] },
    { id: 'col-acid', category: 'color', name: 'Vert acide', length: 4, tracks: [color('all', '#39ff14')] },
    { id: 'col-rainbow', category: 'color', name: 'Arc-en-ciel lent', length: 16, tracks: [cols('all', [...spread(RAINBOW, 16)], { interp: 'smooth' })] },
    { id: 'col-rainbow-run', category: 'color', name: 'Arc-en-ciel défilant', length: 8, tracks: [cols('all', [...spread(RAINBOW, 8)], { interp: 'smooth', spread: 1 })] },
    { id: 'col-beat', category: 'color', name: 'Couleur à chaque temps', length: 8, tracks: [cols('all', [...spread([...RAINBOW, WHITE], 8)], { interp: 'step' })] },
    { id: 'col-red-blue', category: 'color', name: 'Rouge / bleu alternés', length: 4, tracks: [wave('all', 'color', { shape: 'square', cycles: 2, colorA: '#ff1a1a', colorB: '#1a3cff', spread: 0.5 })] },
    { id: 'col-warm-cold', category: 'color', name: 'Chaud ↔ froid', length: 16, tracks: [wave('all', 'color', { colorA: '#ffb347', colorB: '#00e5ff' })] },
    { id: 'col-magenta-cyan', category: 'color', name: 'Vague magenta / cyan', length: 8, tracks: [wave('all', 'color', { colorA: '#ff1ab4', colorB: '#00e5ff', spread: 1 })] },
    { id: 'col-fire', category: 'color', name: 'Feu', length: 4, tracks: [wave('all', 'color', { shape: 'random', cycles: 8, colorA: '#ff2a00', colorB: '#ffb000' }), wave('all', 'dimmer', { shape: 'random', cycles: 8, low: 0.55 })] },

    // ── Mouvements (lyres) ─────────────────────────────────────────────────
    { id: 'mv-sweep', category: 'move', name: 'Balayage lent', length: 16, tracks: [wave('spot', 'pan', { low: 0.44, high: 0.56 })] },
    { id: 'mv-sweep-fast', category: 'move', name: 'Balayage rapide', length: 4, tracks: [wave('spot', 'pan', { low: 0.45, high: 0.55 })] },
    { id: 'mv-ballyhoo', category: 'move', name: 'Ballyhoo', length: 8, tracks: [wave('spot', 'pan', { cycles: 2, low: 0.43, high: 0.57, spread: 0.5 }), wave('spot', 'tilt', { low: 0.56, high: 0.74, spread: 0.5 })] },
    { id: 'mv-circle', category: 'move', name: 'Cercles', length: 4, tracks: [
        pts('spot', 'pan', [[0, 0.5], [1, 0.535], [2, 0.5], [3, 0.465]], { interp: 'smooth' }),
        pts('spot', 'tilt', [[0, 0.6], [1, 0.645], [2, 0.69], [3, 0.645]], { interp: 'smooth' }),
    ] },
    { id: 'mv-circle-offset', category: 'move', name: 'Cercles décalés', length: 4, tracks: [
        pts('spot', 'pan', [[0, 0.5], [1, 0.535], [2, 0.5], [3, 0.465]], { interp: 'smooth', spread: 1 }),
        pts('spot', 'tilt', [[0, 0.6], [1, 0.645], [2, 0.69], [3, 0.645]], { interp: 'smooth', spread: 1 }),
    ] },
    { id: 'mv-cross', category: 'move', name: 'Croisements', length: 8, tracks: [wave('spot', 'pan', { low: 0.45, high: 0.55, spread: 0.5, order: 'center' })] },
    { id: 'mv-tilt-wave', category: 'move', name: 'Vague de tilt', length: 8, tracks: [wave('spot', 'tilt', { low: 0.55, high: 0.74, spread: 1 })] },
    { id: 'mv-nod', category: 'move', name: 'Hochements au temps', length: 2, tracks: [wave('spot', 'tilt', { shape: 'ramp', cycles: 2, low: 0.6, high: 0.72 })] },
    { id: 'mv-audience', category: 'move', name: 'Tous vers le public', length: 4, tracks: [fixed('spot', 'pan', 0.5), fixed('spot', 'tilt', 0.76)] },
    { id: 'mv-sky', category: 'move', name: 'Tous vers le ciel', length: 4, tracks: [fixed('spot', 'pan', 0.5), fixed('spot', 'tilt', 0.52)] },
    { id: 'mv-zoom', category: 'move', name: 'Zoom respirant', length: 8, tracks: [wave('spot', 'zoom', { low: 0.1, high: 0.85 })] },

    // ── Strobe et effets ───────────────────────────────────────────────────
    { id: 'fx-strobe', category: 'fx', name: 'Strobe rapide', length: 4, tracks: [fixed('all', 'dimmer', 1), fixed('all', 'strobe', 0.9), color('all', WHITE)] },
    { id: 'fx-strobe-slow', category: 'fx', name: 'Strobe lent', length: 4, tracks: [fixed('all', 'dimmer', 1), fixed('all', 'strobe', 0.25)] },
    { id: 'fx-strobe-13', category: 'fx', name: 'Strobe sur le 1 et le 3', length: 4, tracks: [
        fixed('strobe', 'dimmer', 1),
        pts('strobe', 'strobe', [[0, 0.85], [0.5, 0], [2, 0.85], [2.5, 0]], { interp: 'step' }),
    ] },
    { id: 'fx-buildup', category: 'fx', name: 'Montée (16 temps)', length: 16, tracks: [
        wave('all', 'dimmer', { shape: 'saw', low: 0.2 }),
        pts('all', 'strobe', [[0, 0], [8, 0.1], [12, 0.45], [15, 1]], { interp: 'linear' }),
        color('all', WHITE),
    ] },
    { id: 'fx-drop', category: 'fx', name: 'Drop', length: 4, tracks: [
        fixed('all', 'dimmer', 1),
        pts('all', 'strobe', [[0, 1], [1, 0]], { interp: 'step' }),
        color('all', WHITE),
    ] },
    { id: 'fx-lightning', category: 'fx', name: 'Éclairs aléatoires', length: 4, tracks: [wave('strobe', 'dimmer', { shape: 'random', cycles: 16, low: 0, high: 1, spread: 1 })] },
    { id: 'fx-blackout-pulse', category: 'fx', name: 'Noir et flash', length: 4, tracks: [pts('all', 'dimmer', [[0, 1], [0.25, 0], [3.75, 0]], { interp: 'step' }), color('all', WHITE)] },

    // ── Lasers ─────────────────────────────────────────────────────────────
    { id: 'lz-pulse', category: 'laser', name: 'Lasers pulsés', length: 4, tracks: [wave('laser', 'dimmer', { shape: 'square', cycles: 8, width: 0.5 })] },
    { id: 'lz-sweep', category: 'laser', name: 'Lasers balayage', length: 8, tracks: [wave('laser', 'pan', { low: 0.33, high: 0.67, spread: 0.5 })] },
    { id: 'lz-updown', category: 'laser', name: 'Lasers haut / bas', length: 4, tracks: [wave('laser', 'tilt', { shape: 'triangle', low: 0.4, high: 0.6 })] },
    { id: 'lz-colors', category: 'laser', name: 'Lasers couleurs au temps', length: 4, tracks: [cols('laser', [[0, '#ff1a1a'], [1, '#1aff3c'], [2, '#1a3cff'], [3, '#ffe600']], { interp: 'step' })] },
    { id: 'lz-open', category: 'laser', name: 'Lasers ouverture', length: 8, tracks: [wave('laser', 'zoom', { shape: 'triangle', low: 0.1, high: 0.9 })] },
    { id: 'lz-flash', category: 'laser', name: 'Lasers clignotants', length: 4, tracks: [fixed('laser', 'dimmer', 1), fixed('laser', 'strobe', 0.6)] },

    // ── Barres LED ─────────────────────────────────────────────────────────
    { id: 'lb-wave', category: 'ledbar', name: 'Barres vague', length: 4, tracks: [wave('ledbar', 'dimmer', { spread: 1 })] },
    { id: 'lb-chase', category: 'ledbar', name: 'Barres chenillard', length: 4, tracks: [wave('ledbar', 'dimmer', { shape: 'square', width: 0.25, spread: 1 })] },
    { id: 'lb-rainbow', category: 'ledbar', name: 'Barres arc-en-ciel', length: 8, tracks: [cols('ledbar', [...spread(RAINBOW, 8)], { interp: 'smooth', spread: 1 }), fixed('ledbar', 'dimmer', 1)] },
    { id: 'lb-tilt', category: 'ledbar', name: 'Barres bascule', length: 8, tracks: [wave('ledbar', 'tilt', { low: 0.4, high: 0.6, spread: 0.5 })] },

    // ── Ambiances ──────────────────────────────────────────────────────────
    { id: 'mood-calm', category: 'mood', name: 'Calme (bleu)', length: 16, tracks: [
        color('all', '#1a3cff'), wave('all', 'dimmer', { low: 0.3, high: 0.6 }), wave('spot', 'pan', { low: 0.47, high: 0.53, spread: 1 }),
    ] },
    { id: 'mood-techno', category: 'mood', name: 'Techno 4×4', length: 8, tracks: [
        wave('all', 'dimmer', { shape: 'ramp', cycles: 8, low: 0.08 }),
        cols('all', [[0, '#ff1a1a'], [4, WHITE]], { interp: 'step' }),
    ] },
    { id: 'mood-festival', category: 'mood', name: 'Festival', length: 8, tracks: [
        fixed('all', 'dimmer', 1), cols('all', [...spread(RAINBOW, 8)], { interp: 'smooth', spread: 1 }),
        wave('spot', 'pan', { low: 0.44, high: 0.56, spread: 0.5 }), wave('spot', 'tilt', { low: 0.6, high: 0.72, cycles: 2 }),
    ] },
    { id: 'mood-club', category: 'mood', name: 'Club violet', length: 8, tracks: [
        wave('all', 'color', { colorA: '#7a1aff', colorB: '#ff1ab4', spread: 1 }), wave('all', 'dimmer', { shape: 'ramp', cycles: 8, low: 0.3 }),
    ] },
    { id: 'mood-sunset', category: 'mood', name: 'Coucher de soleil', length: 16, tracks: [
        wave('all', 'color', { colorA: '#ff5a00', colorB: '#ff1a6e' }), fixed('all', 'dimmer', 0.7), wave('spot', 'tilt', { low: 0.7, high: 0.8 }),
    ] },
];

/** Copie d'un pattern de la bibliothèque prête à ajouter au show (nouveaux identifiants) */
export function instantiate(def) {
    return {
        id: newId('p'),
        lib: def.id,
        name: def.name,
        length: def.length,
        tracks: def.tracks.map((t) => ({ ...JSON.parse(JSON.stringify(t)), id: newId('t') })),
    };
}

/** Ajoute (une fois) un pattern de la bibliothèque au show ; renvoie le pattern du show */
export function addToShow(show, def) {
    const existing = show.patterns.find((p) => p.lib === def.id);
    if (existing) return existing;
    const p = instantiate(def);
    show.patterns.push(p);
    return p;
}

/**
 * Remplit les pads vides du mode Live avec la bibliothèque : une rangée par famille
 * (intensité, couleurs, mouvements, effets), les patterns ajoutés au show si besoin.
 * @returns {number} nombre de pads remplis
 */
export function fillLive(show) {
    const live = show.live;
    const plan = [
        ['Intensité', ['dimmer']],
        ['Couleurs', ['color']],
        ['Mouvements', ['move']],
        ['Effets', ['fx', 'laser', 'ledbar', 'mood']],
    ];
    let filled = 0;
    plan.forEach(([name, cats], r) => {
        const row = live.rows[r];
        if (!row) return;
        const defs = PATTERN_LIBRARY.filter((d) => cats.includes(d.category));
        const used = new Set(row.pads.filter(Boolean).map((pad) => {
            const p = show.patterns.find((x) => x.id === pad.pattern);
            return p && p.lib;
        }));
        let k = 0;
        for (let col = 0; col < (live.cols || LIVE_COLS); col++) {
            if (row.pads[col]) continue;
            while (k < defs.length && used.has(defs[k].id)) k++;
            if (k >= defs.length) break;
            const p = addToShow(show, defs[k++]);
            row.pads[col] = { pattern: p.id, mode: 'toggle' };
            filled++;
        }
        if (/^Rangée \d+$/.test(row.name)) row.name = name;
    });
    return filled;
}
