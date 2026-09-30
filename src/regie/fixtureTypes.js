/**
 * fixtureTypes.js — types de projecteurs connus de la régie.
 *
 * Les profils DMX sont ceux du jeu (mêmes fichiers) : la régie sait donc exactement
 * quels canaux chaque projecteur écoute, et peut décoder ce qu'elle envoie pour
 * l'aperçu du plan (couleur × intensité).
 */

import * as SpotProfile from '../spot/SpotProfile.js';
import * as LedBarProfile from '../ledbar/LedBarProfile.js';
import * as StrobeProfile from '../strobe/StrobeProfile.js';
import * as LaserProfile from '../laser/LaserProfile.js';
import * as Laser2Profile from '../laser2/Laser2Profile.js';

export const KINDS = {
    spot:   { label: 'Lyre',      plural: 'Lyres',      profile: SpotProfile },
    ledbar: { label: 'Barre LED', plural: 'Barres LED', profile: LedBarProfile },
    strobe: { label: 'Strobe',    plural: 'Strobes',    profile: StrobeProfile },
    laser:  { label: 'Laser',     plural: 'Lasers',     profile: LaserProfile },
    laser2: { label: 'Laser (points)', plural: 'Lasers (points)', profile: Laser2Profile },
};
export const KIND_ORDER = ['spot', 'ledbar', 'strobe', 'laser', 'laser2'];

export const fixtureKey = (f) => `${f.kind}:${f.id}`;
export const fixtureName = (f) => `${(KINDS[f.kind] || { label: f.kind }).label} ${f.number}`;

const _channels = new Map();

/**
 * Canaux d'un projecteur (adresses absolues dans son univers) :
 * { address, name, intensity?, fine?, fineAddress? }
 */
export function channelsOf(f) {
    const key = `${f.kind}|${f.mode}|${f.address}|${f.pixelCount || 0}`;
    let list = _channels.get(key);
    if (!list) {
        const kind = KINDS[f.kind];
        list = kind ? kind.profile.describeChannels(f.mode, f.address, f.pixelCount || 0) : [];
        _channels.set(key, list);
    }
    return list;
}

/** Lecture d'un univers (Uint8Array de 512 octets) au format attendu par les profils */
function universeReader(data) {
    return {
        get: (a) => (data && a >= 1 && a <= 512 ? data[a - 1] : 0),
        get16: (a) => (data && a >= 1 && a < 512 ? (data[a - 1] << 8) | data[a] : 0),
    };
}

/** Réglages décodés d'un projecteur depuis les valeurs DMX de son univers */
export function decodeFixture(f, data) {
    const kind = KINDS[f.kind];
    if (!kind) return {};
    try {
        return kind.profile.decode(universeReader(data), f.address, f.mode, f.pixelCount || 0).params;
    } catch (_) {
        return {};
    }
}

function hexToRgb(hex) {
    const n = parseInt(String(hex || '#000000').replace('#', ''), 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Couleur d'aperçu (0…1) d'un projecteur d'après ses réglages décodés : couleur × intensité
 * @returns {[number, number, number]}
 */
export function previewColor(f, params) {
    let k = (params.dimmer ?? 100) / 100;
    if (f.kind === 'spot' && params.shutter === 'Fermé') k = 0;
    if (f.kind === 'ledbar' && params.shutter === 'Fermé') k = 0;
    const [r, g, b] = hexToRgb(params.color || '#ffffff');
    return [r * k, g * k, b * k];
}
