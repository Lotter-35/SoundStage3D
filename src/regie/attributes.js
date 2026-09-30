/**
 * attributes.js — attributs communs à tous les projecteurs (intensité, couleur, pan, tilt, zoom, strobe)
 * et leur traduction vers les canaux DMX de chaque type.
 *
 * Un pattern parle en attributs : la même piste « Couleur » sait piloter une lyre (CMY),
 * une barre LED, un strobe ou un laser (RVB). Les autres canaux restent accessibles un à un
 * (« Canal · nom », valeur 0…255 brute).
 */

import { channelsOf } from './fixtureTypes.js';

export const ATTRIBUTES = [
    { id: 'dimmer', label: 'Intensité', type: 'scalar' },
    { id: 'color', label: 'Couleur', type: 'color' },
    { id: 'pan', label: 'Pan', type: 'scalar' },
    { id: 'tilt', label: 'Tilt', type: 'scalar' },
    { id: 'zoom', label: 'Zoom', type: 'scalar' },
    { id: 'strobe', label: 'Strobe', type: 'scalar' },
];

// Noms exacts des canaux dans les profils (src/*/…Profile.js)
const MAP = {
    spot: {
        dimmer: { ch: 'Dimmer' },
        color: { cmy: ['Cyan', 'Magenta', 'Yellow'] },
        pan: { ch: 'Pan' },
        tilt: { ch: 'Tilt' },
        zoom: { ch: 'Zoom' },
        strobe: { shutter: 'Obturateur / Strobe' },
    },
    ledbar: {
        dimmer: { ch: 'Master Dimmer' },
        color: { rgb: ['Master Rouge', 'Master Vert', 'Master Bleu'] },
        tilt: { ch: 'Tilt' },
        zoom: { ch: 'Zoom (gauche / global)' },
        strobe: { shutter: 'Obturateur / Strobe' },
    },
    strobe: {
        dimmer: { ch: 'Dimmer' },
        color: { rgb: ['Rouge', 'Vert', 'Bleu'] },
        strobe: { rate: 'Strobe (0–9 continu, 10–255 lent → rapide)' },
    },
    laser: {
        dimmer: { ch: 'Dimmer' },
        color: { rgb: ['Rouge', 'Vert', 'Bleu'] },
        pan: { ch: 'Position gauche / droite' },
        tilt: { ch: 'Position haut / bas' },
        zoom: { ch: 'Écart' },
        strobe: { rate: 'Clignotement (0–9 non, 10–255 lent → rapide)' },
    },
};

export const CHANNEL_PREFIX = 'ch:';
export const shortChannelName = (name) => name.replace(/\s*\(.*\)\s*$/, '').trim() || name;

/** Libellé d'un attribut (commun ou canal) */
export function attributeLabel(id) {
    if (id.startsWith(CHANNEL_PREFIX)) return `Canal · ${shortChannelName(id.slice(CHANNEL_PREFIX.length))}`;
    const a = ATTRIBUTES.find((x) => x.id === id);
    return a ? a.label : id;
}

export function attributeType(id) {
    const a = ATTRIBUTES.find((x) => x.id === id);
    return a ? a.type : 'scalar';
}

/**
 * Attributs utilisables sur une liste de projecteurs : les attributs communs qu'au moins un
 * sait jouer, puis chacun de leurs canaux
 */
export function attributesFor(fixtures) {
    const common = ATTRIBUTES.filter((a) => fixtures.some((f) => MAP[f.kind] && MAP[f.kind][a.id]));
    const names = [];
    const seen = new Set();
    for (const f of fixtures) {
        for (const c of channelsOf(f)) {
            if (c.fine || seen.has(c.name)) continue;
            seen.add(c.name);
            names.push(c.name);
        }
    }
    return [
        ...common.map((a) => ({ id: a.id, label: a.label })),
        ...names.map((n) => ({ id: CHANNEL_PREFIX + n, label: attributeLabel(CHANNEL_PREFIX + n) })),
    ];
}

// ── Écriture ──────────────────────────────────────────────────────────────
const _compiled = new Map();

function findChannel(f, name) {
    return channelsOf(f).find((c) => c.name === name && !c.fine) || null;
}

/** Traduction compilée (adresses) d'un attribut pour un projecteur, ou null s'il ne l'a pas */
function compile(f, attr) {
    const key = `${f.kind}|${f.mode}|${f.address}|${f.pixelCount || 0}|${attr}`;
    if (_compiled.has(key)) return _compiled.get(key);
    let out = null;
    if (attr.startsWith(CHANNEL_PREFIX)) {
        const c = findChannel(f, attr.slice(CHANNEL_PREFIX.length));
        if (c) out = { kind: 'ch', c };
    } else {
        const m = MAP[f.kind] && MAP[f.kind][attr];
        if (m && m.ch) {
            const c = findChannel(f, m.ch);
            if (c) out = { kind: 'ch', c };
        } else if (m && (m.rgb || m.cmy)) {
            const cs = (m.rgb || m.cmy).map((n) => findChannel(f, n));
            if (cs.every(Boolean)) out = { kind: m.rgb ? 'rgb' : 'cmy', cs };
        } else if (m && m.shutter) {
            const c = findChannel(f, m.shutter);
            if (c) out = { kind: 'shutter', c };
        } else if (m && m.rate) {
            const c = findChannel(f, m.rate);
            if (c) out = { kind: 'rate', c };
        }
    }
    _compiled.set(key, out);
    return out;
}

function put(frame, c, v01) {
    const v = Math.max(0, Math.min(1, v01));
    if (c.fineAddress) {
        const v16 = Math.round(v * 65535);
        frame[c.address - 1] = v16 >> 8;
        frame[c.fineAddress - 1] = v16 & 255;
    } else {
        frame[c.address - 1] = Math.round(v * 255);
    }
}

/**
 * Écrit la valeur d'un attribut d'un projecteur dans l'univers (Uint8Array) de sortie
 * @param {Uint8Array} frame
 * @param {object} f projecteur
 * @param {string} attr
 * @param {number|number[]} value 0…1, ou [r, g, b] 0…1 pour la couleur
 * @returns {boolean} false si le projecteur n'a pas cet attribut
 */
export function writeAttribute(frame, f, attr, value) {
    const w = compile(f, attr);
    if (!w) return false;
    switch (w.kind) {
        case 'ch':
            put(frame, w.c, Array.isArray(value) ? value[0] : value);
            return true;
        case 'rgb':
            for (let i = 0; i < 3; i++) put(frame, w.cs[i], Array.isArray(value) ? value[i] : value);
            return true;
        case 'cmy':
            for (let i = 0; i < 3; i++) put(frame, w.cs[i], 1 - (Array.isArray(value) ? value[i] : value));
            return true;
        case 'shutter': {
            // 0 = ouvert ; au-delà : strobe lent → rapide (plage 50–99 des lyres et barres)
            const s = Array.isArray(value) ? value[0] : value;
            frame[w.c.address - 1] = s <= 0.001 ? 255 : 50 + Math.round(Math.min(1, s) * 49);
            return true;
        }
        case 'rate': {
            // 0 = lumière continue ; au-delà : cadence lente → rapide (plage 10–255 des strobes et lasers)
            const s = Array.isArray(value) ? value[0] : value;
            frame[w.c.address - 1] = s <= 0.001 ? 0 : 10 + Math.round(Math.min(1, s) * 245);
            return true;
        }
        default:
            return false;
    }
}

export function hasAttribute(f, attr) {
    return compile(f, attr) !== null;
}
