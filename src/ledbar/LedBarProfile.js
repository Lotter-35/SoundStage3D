/**
 * LedBarProfile.js
 * ─────────────────────────────────────────────────────────────
 * Personnalité DMX de la barre LED motorisée (« fixture profile ») :
 *   DMX (octets)  ⇄  paramètres de la barre (valeurs du panneau).
 *
 * Mode Standard : 26 canaux (mécanique, optique, intensité, master RGBW, macros FX).
 * Mode Pixel    : les 26 canaux + 4 canaux RGBW par LED (8 → 58, 16 → 90, 32 → 154 canaux).
 *
 * decode(universe, address, mode, pixelCount) → { params, reset }
 * encode(params, mode, pixelCount)            → Uint8Array (valeurs DMX équivalentes)
 * ─────────────────────────────────────────────────────────────
 */

import {
    SHUTTER_MODES, FX_PATTERNS, FX_DIRECTIONS, MOVE_FX, HALF_MODES, COLOR_MACROS, DMX_MODES,
    TILT_RANGE, ZOOM_MIN, ZOOM_MAX, MAX_PIXELS, hexToRgb, rgbToHex
} from './config/ledBarParams.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round = Math.round;
const _rgb = [0, 0, 0];

/** Index d'une liste codé sur des plages égales de 0…255 */
const listDec = (list, v) => list[Math.min(list.length - 1, Math.floor(v * list.length / 256))];
const listEnc = (list, value) => {
    const i = Math.max(0, list.indexOf(value));
    return Math.min(255, round((i + 0.5) * 256 / list.length));
};

/** Macro de couleur la plus proche d'une couleur */
function nearestMacro(hex) {
    const [r, g, b] = hexToRgb(hex, _rgb);
    let best = 0, bestD = Infinity;
    COLOR_MACROS.forEach((m, i) => {
        const c = hexToRgb(m.hex, [0, 0, 0]);
        const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
        if (d < bestD) { bestD = d; best = i; }
    });
    return best;
}
const macroDec = (v) => COLOR_MACROS[Math.min(COLOR_MACROS.length - 1, v >> 4)].hex;
const macroEnc = (hex) => nearestMacro(hex) * 16 + 8;

// Rotation continue : 0-127 arrêt (tilt en position) ; 128-189 horaire rapide → lent ; 190-193 stop ; 194-255 anti-horaire lent → rapide
function decRotation(v) {
    if (v >= 128 && v <= 189) return 100 - ((v - 128) / 61) * 95;
    if (v >= 194) return -(5 + ((v - 194) / 61) * 95);
    return 0;
}
function encRotation(s) {
    if (Math.abs(s) < 2.5) return 0;
    if (s > 0) return clamp(round(128 + ((100 - s) / 95) * 61), 128, 189);
    return clamp(round(194 + ((-s - 5) / 95) * 61), 194, 255);
}

const zoomDec = (v) => ZOOM_MIN + (v / 255) * (ZOOM_MAX - ZOOM_MIN);
const zoomEnc = (z) => round(clamp((z - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN), 0, 1) * 255);

// ── Canaux du mode Standard (le canal « fine » suit toujours son canal « coarse ») ──
const CHANNELS = [
    { name: 'Tilt', wide: true,
      dec: (v16, o) => { o.tilt = -TILT_RANGE / 2 + (v16 / 65535) * TILT_RANGE; },
      enc: p => round(((p.tilt + TILT_RANGE / 2) / TILT_RANGE) * 65535) },
    { name: 'Rotation continue (sens / vitesse)',
      dec: (v, o) => { o.rotation = decRotation(v); },
      enc: p => encRotation(p.rotation) },
    { name: 'Vitesse moteurs',
      dec: (v, o) => { o.moveSpeed = 100 * (1 - v / 255); },
      enc: p => round((1 - p.moveSpeed / 100) * 255) },
    { name: 'Zoom (gauche / global)',
      dec: (v, o) => { o.zoom = zoomDec(v); },
      enc: p => zoomEnc(p.zoom) },
    { name: 'Zoom droite (0 = suit le zoom global)',
      dec: (v, o) => { o.zoomSplit = v > 0; if (v > 0) o.zoomRight = zoomDec(v); },
      enc: p => (p.zoomSplit ? Math.max(1, zoomEnc(p.zoomRight)) : 0) },
    { name: 'Master Dimmer', wide: true,
      dec: (v16, o) => { o.dimmer = (v16 / 65535) * 100; },
      enc: p => round(clamp(p.dimmer / 100, 0, 1) * 65535) },
    { name: 'Obturateur / Strobe',
      dec: (v, o) => {
          let mode = 'Ouvert', speed = null;
          if (v < 20) mode = 'Fermé';
          else if (v < 50) mode = 'Ouvert';
          else if (v < 100) { mode = 'Strobe'; speed = (v - 50) / 49; }
          else if (v < 130) { mode = 'Pulse ouverture'; speed = (v - 100) / 29; }
          else if (v < 160) { mode = 'Pulse fermeture'; speed = (v - 130) / 29; }
          else if (v < 190) { mode = 'Strobe aléatoire'; speed = (v - 160) / 29; }
          o.shutter = mode;
          if (speed !== null) o.strobeRate = 1 + speed * 29;
      },
      enc: p => {
          const s = clamp((p.strobeRate - 1) / 29, 0, 1);
          switch (p.shutter) {
              case 'Fermé': return 0;
              case 'Strobe': return 50 + round(s * 49);
              case 'Pulse ouverture': return 100 + round(s * 29);
              case 'Pulse fermeture': return 130 + round(s * 29);
              case 'Strobe aléatoire': return 160 + round(s * 29);
              default: return 255;
          }
      } },
    { name: 'Master Rouge', dec: (v, o, ctx) => { ctx.r = v; }, enc: p => round(hexToRgb(p.color, _rgb)[0] * 255) },
    { name: 'Master Vert',  dec: (v, o, ctx) => { ctx.g = v; }, enc: p => round(hexToRgb(p.color, _rgb)[1] * 255) },
    { name: 'Master Bleu',  dec: (v, o, ctx) => { ctx.b = v; o.color = rgbToHex(ctx.r / 255, ctx.g / 255, v / 255); },
      enc: p => round(hexToRgb(p.color, _rgb)[2] * 255) },
    { name: 'Master Blanc (W)', dec: (v, o) => { o.white = (v / 255) * 100; }, enc: p => round(clamp(p.white / 100, 0, 1) * 255) },
    { name: 'Demi-couleur (0-9 aucune, 10-127 G/D, 128-255 H/B : position)',
      dec: (v, o) => {
          if (v < 10) { o.halfMode = HALF_MODES[0]; return; }
          if (v < 128) { o.halfMode = HALF_MODES[1]; o.halfPos = -100 + ((v - 10) / 117) * 200; return; }
          o.halfMode = HALF_MODES[2]; o.halfPos = -100 + ((v - 128) / 127) * 200;
      },
      enc: p => {
          const t = clamp((p.halfPos + 100) / 200, 0, 1);
          if (p.halfMode === HALF_MODES[1]) return 10 + round(t * 117);
          if (p.halfMode === HALF_MODES[2]) return 128 + round(t * 127);
          return 0;
      } },
    { name: 'Seconde couleur (macro)', dec: (v, o) => { o.halfColor = macroDec(v); }, enc: p => macroEnc(p.halfColor) },
    { name: 'Motif FX', dec: (v, o) => { o.fxPattern = listDec(FX_PATTERNS, v); }, enc: p => listEnc(FX_PATTERNS, p.fxPattern) },
    { name: 'Vitesse FX', dec: (v, o) => { o.fxSpeed = (v / 255) * 100; }, enc: p => round(clamp(p.fxSpeed / 100, 0, 1) * 255) },
    { name: 'Sens FX', dec: (v, o) => { o.fxDirection = listDec(FX_DIRECTIONS, v); }, enc: p => listEnc(FX_DIRECTIONS, p.fxDirection) },
    { name: 'Fondu FX (crossfade)', dec: (v, o) => { o.fxFade = (v / 255) * 100; }, enc: p => round(clamp(p.fxFade / 100, 0, 1) * 255) },
    { name: 'Taille FX', dec: (v, o) => { o.fxSize = 1 + (v / 255) * 99; }, enc: p => round(clamp((p.fxSize - 1) / 99, 0, 1) * 255) },
    { name: 'Couleur premier plan (macro)', dec: (v, o) => { o.fxFg = macroDec(v); }, enc: p => macroEnc(p.fxFg) },
    { name: 'Couleur de fond (macro)', dec: (v, o) => { o.fxBg = macroDec(v); }, enc: p => macroEnc(p.fxBg) },
    { name: 'Macro de mouvement', dec: (v, o) => { o.moveFx = listDec(MOVE_FX, v); }, enc: p => listEnc(MOVE_FX, p.moveFx) },
    { name: 'Amplitude macro', dec: (v, o) => { o.moveFxAmp = (v / 255) * 180; }, enc: p => round(clamp(p.moveFxAmp / 180, 0, 1) * 255) },
    { name: 'Vitesse macro', dec: (v, o) => { o.moveFxSpeed = (v / 255) * 100; }, enc: p => round(clamp(p.moveFxSpeed / 100, 0, 1) * 255) },
    { name: 'Contrôle (200-219 reset tilt, 220-239 reset zoom, 240-255 reset complet)',
      dec: (v, o, ctx) => { ctx.reset = v >= 240 ? 'all' : v >= 220 ? 'zoom' : v >= 200 ? 'tilt' : null; },
      enc: () => 0 },
];

/** Nombre de canaux du mode Standard (canaux fine compris) */
export const STANDARD_FOOTPRINT = CHANNELS.reduce((n, c) => n + (c.wide ? 2 : 1), 0);

export function isPixelMode(mode) {
    return mode === DMX_MODES[1];
}

export function getFootprint(mode, pixelCount) {
    return STANDARD_FOOTPRINT + (isPixelMode(mode) ? 4 * pixelCount : 0);
}

/** Liste des canaux (adresse + nom) pour le moniteur du panneau */
export function describeChannels(mode, startAddress, pixelCount) {
    const out = [];
    let a = startAddress;
    for (const c of CHANNELS) {
        out.push({ address: a++, name: c.name });
        if (c.wide) out.push({ address: a++, name: c.name + ' fine' });
    }
    if (isPixelMode(mode)) {
        for (let i = 0; i < pixelCount; i++) {
            for (const k of ['R', 'G', 'B', 'W']) out.push({ address: a++, name: `LED ${i + 1} ${k}` });
        }
    }
    return out;
}

/**
 * Décode les canaux d'une barre.
 * @returns {{ params: object, reset: string|null }}
 */
export function decode(universe, address, mode, pixelCount) {
    const params = {};
    const ctx = { r: 0, g: 0, b: 0, reset: null };
    let a = address;
    for (const c of CHANNELS) {
        if (c.wide) { c.dec(universe.get16(a), params, ctx); a += 2; }
        else { c.dec(universe.get(a), params, ctx); a += 1; }
    }
    if (isPixelMode(mode)) {
        // Mode pixel : chaque LED a ses canaux RGBW ; tous à zéro → la barre revient à la couleur master
        const pixels = new Array(MAX_PIXELS).fill('#000000');
        let any = false;
        for (let i = 0; i < pixelCount; i++) {
            const r = universe.get(a), g = universe.get(a + 1), b = universe.get(a + 2), w = universe.get(a + 3);
            a += 4;
            if (r || g || b || w) any = true;
            const wf = w / 255;
            pixels[i] = rgbToHex(Math.min(1, r / 255 + wf), Math.min(1, g / 255 + wf), Math.min(1, b / 255 + wf));
        }
        params.pixelMode = any;
        if (any) params.pixels = pixels;
    }
    return { params, reset: ctx.reset };
}

/** Valeurs DMX équivalentes aux réglages courants (moniteur du panneau) */
export function encode(params, mode, pixelCount) {
    const out = [];
    for (const c of CHANNELS) {
        const v = c.enc(params);
        if (c.wide) { out.push((v >> 8) & 255, v & 255); }
        else out.push(clamp(v, 0, 255));
    }
    if (isPixelMode(mode)) {
        for (let i = 0; i < pixelCount; i++) {
            if (!params.pixelMode) { out.push(0, 0, 0, 0); continue; }
            const [r, g, b] = hexToRgb(params.pixels[i], _rgb);
            out.push(round(r * 255), round(g * 255), round(b * 255), 0);
        }
    }
    return Uint8Array.from(out);
}
