/**
 * LaserProfile.js
 * ─────────────────────────────────────────────────────────────
 * Personnalité DMX du laser (« fixture profile ») :
 *   DMX (octets)  ⇄  paramètres du laser (valeurs de l'inspecteur).
 *
 * Mode Standard (21 canaux) : dimmer, couleur RVB, clignotement, faisceaux (nombre, écart,
 * forme, courbe, nappe), position du faisceau, balayages haut/bas et gauche/droite, rotation.
 * Le dimmer module la puissance réglée dans l'inspecteur (calibration de la machine).
 * ─────────────────────────────────────────────────────────────
 */

import { LASER_PARAMS_SCHEMA } from './config/laserParams.js?v=27';

export const DMX_MODES = LASER_PARAMS_SCHEMA.dmxMode.options;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round = Math.round;
const SHAPES = LASER_PARAMS_SCHEMA.patternShape.options;

function hexToRgb255(hex) {
    const n = parseInt(String(hex || '#ffffff').replace('#', ''), 16) || 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hex2 = (v) => clamp(round(v), 0, 255).toString(16).padStart(2, '0');

/** Valeur calée sur le pas du réglage dans l'inspecteur (une valeur ronde revient identique après encodage) */
function snap(key, x) {
    const step = LASER_PARAMS_SCHEMA[key] && LASER_PARAMS_SCHEMA[key].step;
    if (!step) return x;
    return Math.round(Math.round(x / step) * step * 1e6) / 1e6;
}

/** Canal linéaire 0…255 ⇄ [min, max] d'un paramètre */
function linear(name, key, min, max, extra = {}) {
    return {
        name, ...extra,
        dec: (v, o) => { o[key] = snap(key, min + (v / 255) * (max - min)); },
        enc: p => round(clamp(((p[key] ?? min) - min) / (max - min), 0, 1) * 255),
    };
}

/** Canal centré : 0 → −range, 128 → 0 exactement, 255 → +range */
function bipolar(name, key, range) {
    return {
        name,
        dec: (v, o) => { o[key] = snap(key, v < 128 ? ((v - 128) / 128) * range : ((v - 128) / 127) * range); },
        enc: p => {
            const x = clamp(p[key] ?? 0, -range, range);
            return x < 0 ? round(128 + (x / range) * 128) : round(128 + (x / range) * 127);
        },
    };
}

/** Canal tout-ou-rien : 0–127 non, 128–255 oui */
function toggle(name, key) {
    return { name, dec: (v, o) => { o[key] = v >= 128; }, enc: p => (p[key] ? 255 : 0) };
}

const CHANNELS = [
    linear('Dimmer', 'dimmer', 0, 100, { intensity: true }),
    { name: 'Rouge', dec: (v, o, ctx) => { ctx.r = v; }, enc: p => hexToRgb255(p.color)[0] },
    { name: 'Vert', dec: (v, o, ctx) => { ctx.g = v; }, enc: p => hexToRgb255(p.color)[1] },
    { name: 'Bleu', dec: (v, o, ctx) => { ctx.b = v; o.color = `#${hex2(ctx.r)}${hex2(ctx.g)}${hex2(v)}`; }, enc: p => hexToRgb255(p.color)[2] },
    {
        name: 'Clignotement (0–9 non, 10–255 lent → rapide)',
        dec: (v, o) => {
            o.strobe = v >= 10;
            if (v >= 10) o.strobeSpeed = snap('strobeSpeed', 0.5 + ((v - 10) / 245) * 29.5);
        },
        enc: p => (p.strobe ? 10 + round(clamp((p.strobeSpeed - 0.5) / 29.5, 0, 1) * 245) : 0),
    },
    {
        name: 'Nombre de faisceaux (1 → 128)',
        dec: (v, o) => { o.count = 1 + round((v * 127) / 255); },
        enc: p => round(clamp(((p.count ?? 1) - 1) / 127, 0, 1) * 255),
    },
    linear('Écart', 'spread', 0, 110),
    {
        name: `Forme du tracé (${SHAPES.join(', ')})`,
        // Plages égales ; l'encodage vise le milieu de la plage de la forme
        dec: (v, o) => { o.patternShape = SHAPES[Math.min(SHAPES.length - 1, Math.floor(v / (256 / SHAPES.length)))]; },
        enc: p => round((Math.max(0, SHAPES.indexOf(p.patternShape)) + 0.5) * (256 / SHAPES.length)),
    },
    linear('Amplitude de la courbe', 'curveAmplitude', 0, 1.5),
    linear('Fréquence de la courbe', 'curveFrequency', 0.25, 6),
    toggle('Nappe (0–127 faisceaux seuls, 128–255 nappe)', 'laserPan'),
    bipolar('Position haut / bas', 'beamPitchOffset', 60),
    bipolar('Position gauche / droite', 'beamYawOffset', 60),
    linear('Rotation du faisceau', 'beamRollOffset', 0, 360),
    linear('Balayage haut / bas – amplitude', 'pitchSweepAmp', 0, 60),
    linear('Balayage haut / bas – vitesse', 'pitchSweepSpeed', 0, 30),
    linear('Balayage gauche / droite – amplitude', 'yawSweepAmp', 0, 60),
    linear('Balayage gauche / droite – vitesse', 'yawSweepSpeed', 0, 30),
    linear('Rotation – amplitude', 'rollSweepAmp', 0, 360),
    linear('Rotation – vitesse', 'rollSweepSpeed', 0, 10),
    toggle('Rotation continue (0–127 non, 128–255 oui)', 'rollContinuous'),
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
