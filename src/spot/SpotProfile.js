/**
 * SpotProfile.js
 * ─────────────────────────────────────────────────────────────
 * Personnalité DMX de la lyre Spot (« fixture profile ») :
 * liste des canaux de chaque mode, plages de valeurs et conversion
 *   DMX (octets)  ⇄  paramètres de la lyre (valeurs du panneau).
 *
 * decode(universe, address, mode) → { param: valeur, … } + actions (reset)
 * encode(params, mode)            → Uint8Array (valeurs DMX équivalentes)
 *
 * Conventions reprises des lyres du marché : 16 bits coarse/fine pour pan, tilt,
 * dimmer et index de gobo ; plages « index / rotation horaire rapide→lente /
 * stop / rotation anti-horaire lente→rapide » pour les roues et le prisme.
 * ─────────────────────────────────────────────────────────────
 */

import {
    COLOR_WHEEL, GOBO_FIXED_WHEEL, GOBO_ROT_WHEEL, ANIM_WHEEL, PRISMS,
    SHUTTER_MODES, DMX_MODES, PAN_RANGE, TILT_RANGE
} from './config/spotParams.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round = Math.round;

// ── Aides pour les plages « rotation » (0 = stop) ──────────────────────────
// 128-189 : horaire rapide → lent ; 190-193 : stop ; 194-255 : anti-horaire lent → rapide
function decodeRotationRange(v) {
    if (v >= 128 && v <= 189) return 100 - ((v - 128) / 61) * 95;      // +100 … +5
    if (v >= 194) return -(5 + ((v - 194) / 61) * 95);                  // −5 … −100
    return 0;
}
function encodeRotationRange(speed) {
    if (Math.abs(speed) < 2.5) return 191;
    if (speed > 0) return clamp(round(128 + ((100 - speed) / 95) * 61), 128, 189);
    return clamp(round(194 + ((-speed - 5) / 95) * 61), 194, 255);
}

// ── Définition des canaux ──────────────────────────────────────────────────
// Chaque canal : { name, fine?: index du canal fine dans le mode, dec(v, out, v16), enc(p) }
const CH = {
    pan: {
        name: 'Pan', wide: true,
        dec: (v16, out) => { out.pan = -PAN_RANGE / 2 + (v16 / 65535) * PAN_RANGE; },
        enc: p => round(((p.pan + PAN_RANGE / 2) / PAN_RANGE) * 65535),
    },
    tilt: {
        name: 'Tilt', wide: true,
        dec: (v16, out) => { out.tilt = -TILT_RANGE / 2 + (v16 / 65535) * TILT_RANGE; },
        enc: p => round(((p.tilt + TILT_RANGE / 2) / TILT_RANGE) * 65535),
    },
    ptSpeed: {
        name: 'Vitesse Pan/Tilt',
        dec: (v, out) => { out.ptSpeed = 100 * (1 - v / 255); },
        enc: p => round((1 - p.ptSpeed / 100) * 255),
    },
    shutter: {
        name: 'Obturateur / Strobe',
        dec: (v, out) => {
            let mode = 'Ouvert', speed = null;
            if (v < 20) mode = 'Fermé';
            else if (v < 50) mode = 'Ouvert';
            else if (v < 100) { mode = 'Strobe'; speed = (v - 50) / 49; }
            else if (v < 130) { mode = 'Pulse ouverture'; speed = (v - 100) / 29; }
            else if (v < 160) { mode = 'Pulse fermeture'; speed = (v - 130) / 29; }
            else if (v < 190) { mode = 'Strobe aléatoire'; speed = (v - 160) / 29; }
            out.shutter = mode;
            if (speed !== null) out.shutterSpeed = speed * 100;
        },
        enc: p => {
            const s = clamp(p.shutterSpeed / 100, 0, 1);
            switch (p.shutter) {
                case 'Fermé': return 0;
                case 'Strobe': return 50 + round(s * 49);
                case 'Pulse ouverture': return 100 + round(s * 29);
                case 'Pulse fermeture': return 130 + round(s * 29);
                case 'Strobe aléatoire': return 160 + round(s * 29);
                default: return 255;
            }
        },
    },
    dimmer: {
        name: 'Dimmer', wide: true,
        dec: (v16, out) => { out.dimmer = (v16 / 65535) * 100; },
        enc: p => round((p.dimmer / 100) * 65535),
    },
    cyan: {
        name: 'Cyan',
        dec: (v, out, raw) => { raw.c = v; },
        enc: p => round(cmyOf(p.color)[0] * 255),
    },
    magenta: {
        name: 'Magenta',
        dec: (v, out, raw) => { raw.m = v; },
        enc: p => round(cmyOf(p.color)[1] * 255),
    },
    yellow: {
        name: 'Yellow',
        dec: (v, out, raw) => { raw.y = v; },
        enc: p => round(cmyOf(p.color)[2] * 255),
    },
    colorWheel: {
        name: 'Roue de couleurs',
        // 0-119 : 10 filtres × 12 valeurs (6 pleine couleur + 6 demi-couleur) ; 120-127 : ouvert ; 128-255 : rainbow
        dec: (v, out) => {
            if (v < 120) {
                const slot = Math.floor(v / 12);
                out.colorWheel = COLOR_WHEEL[slot].name;
                out.colorHalf = (v % 12) >= 6;
                out.rainbow = 0;
            } else if (v < 128) {
                out.colorWheel = COLOR_WHEEL[0].name;
                out.colorHalf = false;
                out.rainbow = 0;
            } else {
                out.rainbow = decodeRotationRange(v);
            }
        },
        enc: p => {
            if (Math.abs(p.rainbow) >= 2.5) return encodeRotationRange(p.rainbow);
            const slot = Math.max(0, COLOR_WHEEL.findIndex(c => c.name === p.colorWheel));
            return slot * 12 + (p.colorHalf ? 6 : 0);
        },
    },
    goboFixed: {
        name: 'Gobo fixe',
        // 0-71 : 9 positions × 8 ; 72-199 : secousse (8 gobos × 16, lent→rapide) ; 200-255 : ouvert
        dec: (v, out) => {
            if (v < 72) {
                out.goboFixed = GOBO_FIXED_WHEEL[Math.floor(v / 8)];
                out.goboShake = 0;
            } else if (v < 200) {
                const k = Math.floor((v - 72) / 16);
                out.goboFixed = GOBO_FIXED_WHEEL[1 + k];
                out.goboShake = 5 + (((v - 72) % 16) / 15) * 95;
            } else {
                out.goboFixed = GOBO_FIXED_WHEEL[0];
                out.goboShake = 0;
            }
        },
        enc: p => {
            const slot = Math.max(0, GOBO_FIXED_WHEEL.indexOf(p.goboFixed));
            if (slot > 0 && p.goboShake > 2) return 72 + (slot - 1) * 16 + round(clamp((p.goboShake - 5) / 95, 0, 1) * 15);
            return slot * 8;
        },
    },
    goboRot: {
        name: 'Gobo rotatif',
        dec: (v, out) => { out.goboRot = GOBO_ROT_WHEEL[v < 64 ? Math.floor(v / 8) : 0]; },
        enc: p => Math.max(0, GOBO_ROT_WHEEL.indexOf(p.goboRot)) * 8,
    },
    goboRotIndex: {
        name: 'Gobo rotatif – index / rotation', wide: true,
        dec: (v16, out) => {
            const coarse = v16 >> 8;
            if (coarse < 128) {
                out.goboRotMode = 'Index';
                out.goboIndex = (v16 / (128 * 256)) * 360;
            } else {
                out.goboRotMode = 'Rotation';
                out.goboSpeed = decodeRotationRange(coarse);
            }
        },
        enc: p => {
            if (p.goboRotMode === 'Index') return round(((p.goboIndex % 360) / 360) * (128 * 256 - 1));
            return encodeRotationRange(p.goboSpeed) << 8;
        },
    },
    animWheel: {
        name: 'Roue d’animation',
        dec: (v, out) => {
            let k = 0;
            if (v >= 10 && v < 70) k = 1;
            else if (v >= 70 && v < 130) k = 2;
            else if (v >= 130 && v < 190) k = 3;
            out.animWheel = ANIM_WHEEL[k];
        },
        enc: p => [0, 40, 100, 160][Math.max(0, ANIM_WHEEL.indexOf(p.animWheel))],
    },
    animSpeed: {
        name: 'Animation – vitesse',
        // 0-124 : horaire rapide→lent ; 125-130 : stop ; 131-255 : anti-horaire lent→rapide
        dec: (v, out) => {
            if (v < 125) out.animSpeed = 100 - (v / 124) * 99;
            else if (v <= 130) out.animSpeed = 0;
            else out.animSpeed = -(1 + ((v - 131) / 124) * 99);
        },
        enc: p => {
            const s = p.animSpeed;
            if (Math.abs(s) < 1) return 127;
            if (s > 0) return clamp(round(((100 - s) / 99) * 124), 0, 124);
            return clamp(round(131 + ((-s - 1) / 99) * 124), 131, 255);
        },
    },
    prism: {
        name: 'Prisme',
        dec: (v, out) => {
            let k = 0;
            if (v >= 20 && v < 80) k = 1;
            else if (v >= 80 && v < 140) k = 2;
            else if (v >= 140 && v < 200) k = 3;
            out.prism = PRISMS[k];
        },
        enc: p => [0, 50, 110, 170][Math.max(0, PRISMS.indexOf(p.prism))],
    },
    prismRot: {
        name: 'Prisme – index / rotation',
        dec: (v, out) => {
            if (v < 128) {
                out.prismSpeed = 0;
                out.prismIndex = (v / 128) * 360;
            } else {
                out.prismSpeed = decodeRotationRange(v);
            }
        },
        enc: p => (Math.abs(p.prismSpeed) >= 2.5 ? encodeRotationRange(p.prismSpeed) : round(((p.prismIndex % 360) / 360) * 127)),
    },
    frost: {
        name: 'Frost',
        dec: (v, out) => { out.frost = (v / 255) * 100; },
        enc: p => round((p.frost / 100) * 255),
    },
    iris: {
        name: 'Iris',
        // 0 = ouvert, 255 = fermé au minimum (20 %)
        dec: (v, out) => { out.iris = 100 - (v / 255) * 80; },
        enc: p => round(((100 - p.iris) / 80) * 255),
    },
    zoom: {
        name: 'Zoom',
        dec: (v, out) => { out.zoom = 2 + (v / 255) * 46; },
        enc: p => round(((p.zoom - 2) / 46) * 255),
    },
    focus: {
        name: 'Focus',
        dec: (v, out) => { out.focus = (v / 255) * 100; },
        enc: p => round((p.focus / 100) * 255),
    },
    control: {
        name: 'Contrôle / Reset',
        // 100-109 : reset Pan/Tilt ; 110-119 : reset effets ; 120-129 : reset complet
        dec: (v, out, raw) => {
            if (v >= 100 && v < 110) raw.reset = 'panTilt';
            else if (v >= 110 && v < 120) raw.reset = 'effects';
            else if (v >= 120 && v < 130) raw.reset = 'all';
            else raw.reset = null;
        },
        enc: () => 0,
    },
};

for (let i = 1; i <= 4; i++) {
    CH['blade' + i] = {
        name: `Couteau ${i} – insertion`,
        dec: (v, out) => { out['blade' + i] = (v / 255) * 100; },
        enc: p => round((p['blade' + i] / 100) * 255),
    };
    CH['blade' + i + 'Angle'] = {
        name: `Couteau ${i} – angle`,
        dec: (v, out) => { out['blade' + i + 'Angle'] = -45 + (v / 255) * 90; },
        enc: p => round(((p['blade' + i + 'Angle'] + 45) / 90) * 255),
    };
}
CH.bladeRot = {
    name: 'Rotation du bloc couteaux',
    dec: (v, out) => { out.bladeRot = -45 + (v / 255) * 90; },
    enc: p => round(((p.bladeRot + 45) / 90) * 255),
};

/**
 * Plan des canaux par mode : liste ordonnée de { key, part: 'coarse'|'fine'|undefined }.
 * Les attributs 16 bits déclarent leur canal fine séparément (il peut ne pas être contigu).
 */
const LAYOUTS = {
    [DMX_MODES[0]]: [ // Standard (24 canaux)
        ['pan', 'coarse'], ['pan', 'fine'], ['tilt', 'coarse'], ['tilt', 'fine'], ['ptSpeed'],
        ['shutter'], ['dimmer', 'coarse'], ['cyan'], ['magenta'], ['yellow'], ['colorWheel'],
        ['goboFixed'], ['goboRot'], ['goboRotIndex', 'coarse'], ['animWheel'], ['animSpeed'],
        ['prism'], ['prismRot'], ['frost'], ['iris'], ['zoom'], ['focus'], ['dimmer', 'fine'], ['control'],
    ],
    [DMX_MODES[1]]: [ // Étendu (34 canaux)
        ['pan', 'coarse'], ['pan', 'fine'], ['tilt', 'coarse'], ['tilt', 'fine'], ['ptSpeed'],
        ['shutter'], ['dimmer', 'coarse'], ['dimmer', 'fine'], ['cyan'], ['magenta'], ['yellow'],
        ['colorWheel'], ['goboFixed'], ['goboRot'], ['goboRotIndex', 'coarse'], ['goboRotIndex', 'fine'],
        ['animWheel'], ['animSpeed'], ['prism'], ['prismRot'], ['frost'], ['iris'], ['zoom'], ['focus'],
        ['blade1'], ['blade1Angle'], ['blade2'], ['blade2Angle'], ['blade3'], ['blade3Angle'],
        ['blade4'], ['blade4Angle'], ['bladeRot'], ['control'],
    ],
};

// Pré-calcul : pour chaque mode, position coarse/fine de chaque attribut
const COMPILED = {};
for (const [mode, layout] of Object.entries(LAYOUTS)) {
    const attrs = new Map(); // key → { coarse, fine }
    layout.forEach(([key, part], offset) => {
        if (!attrs.has(key)) attrs.set(key, { coarse: -1, fine: -1 });
        const a = attrs.get(key);
        if (part === 'fine') a.fine = offset;
        else a.coarse = offset;
    });
    COMPILED[mode] = { layout, attrs };
}

export function getFootprint(mode) {
    return (LAYOUTS[mode] || LAYOUTS[DMX_MODES[1]]).length;
}

/**
 * Description lisible des canaux d'un mode (panneau DMX, régie) :
 * { address, name, intensity? (canal de dimmer), fine? (octet fin), fineAddress? (octet fin d'un canal 16 bits) }
 */
export function describeChannels(mode, startAddress = 1) {
    const layout = LAYOUTS[mode] || LAYOUTS[DMX_MODES[1]];
    return layout.map(([key, part], i) => {
        const out = {
            address: startAddress + i,
            name: CH[key].name + (part === 'fine' ? ' (fine)' : ''),
        };
        if (key === 'dimmer') out.intensity = true;
        if (part === 'fine') out.fine = true;
        else if (CH[key].wide) {
            const j = layout.findIndex(([k, p]) => k === key && p === 'fine');
            if (j >= 0) out.fineAddress = startAddress + j;
        }
        return out;
    });
}

/** Couleur #rrggbb → drapeaux CMY [0…1] (soustractif : C = 1 − R …) */
export function cmyOf(hex) {
    const n = parseInt(String(hex).replace('#', ''), 16) || 0;
    return [1 - ((n >> 16) & 255) / 255, 1 - ((n >> 8) & 255) / 255, 1 - (n & 255) / 255];
}

export function hexFromCmy(c, m, y) {
    const to = v => clamp(round((1 - v) * 255), 0, 255).toString(16).padStart(2, '0');
    return '#' + to(c) + to(m) + to(y);
}

/**
 * Décode les canaux d'une lyre.
 * @param {import('../dmx/DmxUniverse.js').DmxUniverse} universe
 * @param {number} address Adresse de départ (1…512)
 * @param {string} mode
 * @returns {{ params: object, reset: string|null }}
 */
export function decode(universe, address, mode) {
    const { attrs } = COMPILED[mode] || COMPILED[DMX_MODES[1]];
    const out = {};
    const raw = { c: 0, m: 0, y: 0, reset: null };
    for (const [key, pos] of attrs) {
        const def = CH[key];
        const coarse = universe.get(address + pos.coarse);
        if (def.wide) {
            const fine = pos.fine >= 0 ? universe.get(address + pos.fine) : 0;
            def.dec((coarse << 8) | fine, out, raw);
        } else {
            def.dec(coarse, out, raw);
        }
    }
    out.color = hexFromCmy(raw.c / 255, raw.m / 255, raw.y / 255);
    return { params: out, reset: raw.reset };
}

/**
 * Encode les paramètres courants en valeurs DMX (moniteur, export vers une console…)
 * @returns {Uint8Array}
 */
export function encode(params, mode) {
    const { layout } = COMPILED[mode] || COMPILED[DMX_MODES[1]];
    const bytes = new Uint8Array(layout.length);
    const cache = new Map();
    layout.forEach(([key, part], i) => {
        const def = CH[key];
        if (!cache.has(key)) cache.set(key, def.enc(params));
        const v = cache.get(key);
        if (def.wide) bytes[i] = part === 'fine' ? (v & 255) : ((v >> 8) & 255);
        else bytes[i] = clamp(v, 0, 255);
    });
    return bytes;
}

export { SHUTTER_MODES };
