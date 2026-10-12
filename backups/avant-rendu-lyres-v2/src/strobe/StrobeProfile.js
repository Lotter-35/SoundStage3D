/**
 * StrobeProfile.js
 * ─────────────────────────────────────────────────────────────
 * Personnalité DMX du stroboscope (« fixture profile ») :
 *   DMX (octets)  ⇄  paramètres du stroboscope (valeurs du panneau).
 *
 * Mode Standard (8 canaux) :
 *   1 Dimmer · 2 Strobe (0–9 continu, 10–255 cadence lente → rapide) · 3 Durée du flash
 *   4 Mode (0–127 régulier, 128–255 aléatoire) · 5–7 Rouge / Vert / Bleu · 8 Éclat de l'écran
 *
 * Le dimmer module la puissance réglée dans le panneau (calibration de la machine).
 * ─────────────────────────────────────────────────────────────
 */

export const DMX_MODES = ['Standard (8 canaux)'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round = Math.round;

const SPEED_MIN = 0.5;
const SPEED_MAX = 30;
const EMISSIVE_MAX = 30;

function hexToRgb255(hex) {
    const n = parseInt(String(hex || '#ffffff').replace('#', ''), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex2 = (v) => clamp(round(v), 0, 255).toString(16).padStart(2, '0');

const CHANNELS = [
    {
        name: 'Dimmer', intensity: true,
        dec: (v, o) => { o.dimmer = (v / 255) * 100; },
        enc: p => round(clamp((p.dimmer ?? 100) / 100, 0, 1) * 255),
    },
    {
        name: 'Strobe (0–9 continu, 10–255 lent → rapide)',
        dec: (v, o) => {
            o.strobeEnabled = v >= 10;
            if (v >= 10) o.strobeSpeed = round((SPEED_MIN + ((v - 10) / 245) * (SPEED_MAX - SPEED_MIN)) * 2) / 2; // pas de 0,5 Hz
        },
        enc: p => (p.strobeEnabled ? 10 + round(clamp((p.strobeSpeed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN), 0, 1) * 245) : 0),
    },
    {
        name: 'Durée du flash',
        dec: (v, o) => { o.pulseWidth = round(1 + (v / 255) * 99); }, // pas de 1 % (comme le panneau)
        enc: p => round(clamp((p.pulseWidth - 1) / 99, 0, 1) * 255),
    },
    {
        name: 'Mode (0–127 régulier, 128–255 aléatoire)',
        dec: (v, o) => { o.strobeRandom = v >= 128; },
        enc: p => (p.strobeRandom ? 255 : 0),
    },
    { name: 'Rouge', dec: (v, o, ctx) => { ctx.r = v; }, enc: p => hexToRgb255(p.color)[0] },
    { name: 'Vert', dec: (v, o, ctx) => { ctx.g = v; }, enc: p => hexToRgb255(p.color)[1] },
    { name: 'Bleu', dec: (v, o, ctx) => { ctx.b = v; o.color = `#${hex2(ctx.r)}${hex2(ctx.g)}${hex2(v)}`; }, enc: p => hexToRgb255(p.color)[2] },
    {
        name: 'Éclat de l’écran',
        dec: (v, o) => { o.emissivePower = round((v / 255) * EMISSIVE_MAX * 2) / 2; }, // pas de 0,5
        enc: p => round(clamp((p.emissivePower ?? 3.5) / EMISSIVE_MAX, 0, 1) * 255),
    },
];

export function getFootprint() {
    return CHANNELS.length;
}

/** Liste des canaux (adresse + nom) */
export function describeChannels(mode, startAddress = 1) {
    return CHANNELS.map((c, i) => ({ address: startAddress + i, name: c.name, intensity: Boolean(c.intensity) }));
}

/**
 * @param {{get: (address: number) => number}} universe
 * @returns {{ params: object, reset: null }}
 */
export function decode(universe, address) {
    const params = {};
    const ctx = { r: 0, g: 0, b: 0 };
    CHANNELS.forEach((c, i) => c.dec(universe.get(address + i), params, ctx));
    return { params, reset: null };
}

/** Valeurs DMX équivalentes aux réglages courants */
export function encode(params) {
    return Uint8Array.from(CHANNELS.map(c => clamp(c.enc(params), 0, 255)));
}
