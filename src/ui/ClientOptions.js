/**
 * ClientOptions.js — Options propres à ce joueur (jamais synchronisées avec le serveur)
 *
 * Un seul endroit pour toutes les préférences locales : affichage, qualité des effets,
 * son et contrôles. Tout est sauvegardé dans le localStorage (clé unique) et appliqué
 * par des « applicateurs » enregistrés par main.js.
 */

import { RES_AUTO } from '../render/resolutionScale.js';

const STORAGE_KEY = 'soundstage3d:options';

export const AA_MODES = [
    'MSAA auto (4x, 2x en 4K)',
    'MSAA 4x (Matériel - Recommandé)',
    'MSAA 2x (Matériel - Rapide)',
    'MSAA 8x (Matériel - Haute qualité)',
    'SMAA (Post-process net)',
    'FXAA (Post-process rapide)',
    'MSAA 4x + FXAA (Double lissage)',
    'Aucun (Désactivé)',
];

/** Qualités de rendu des faisceaux de lyres / nappes laser → échelle de résolution (par axe) ;
 *  « Auto » : pleine résolution jusqu'en 1080p, ~¾ en 1440p, ½ en 4K (voir render/resolutionScale.js) */
export const RES_QUALITY = {
    [RES_AUTO]: 'auto',
    'Pleine résolution': 1.0,
    'Demi-résolution': 0.5,
    'Quart de résolution': 0.25,
    '1/8 de résolution': 0.125,
    '1/16 de résolution': 0.0625,
};
const RES_QUALITY_NAMES = Object.keys(RES_QUALITY);

export const OPTION_FOLDERS = [
    { id: 'display', title: '🖥️ Affichage' },
    { id: 'effects', title: '✨ Effets & performance' },
    { id: 'audio',   title: '🔊 Son' },
    { id: 'input',   title: '🖱️ Contrôles' },
];

const num = (value, min, max, step, label, folder, hint) => ({ value, min, max, step, label, folder, hint });
const opt = (options, value, label, folder, hint) => ({ options, value, label, folder, hint });
const bool = (value, label, folder, hint) => ({ value, label, folder, hint });

/** Ordre d'affichage = ordre de déclaration */
export const CLIENT_OPTIONS_SCHEMA = {
    // ── Affichage ──
    renderScale:      num(100, 25, 200, 5, 'Échelle de rendu (%)', 'display', '100 % = résolution de l\'écran (plafonnée à 1,5× sur écran haute densité)'),
    sharpness:        num(0, 0, 1, 0.01, 'Netteté', 'display', 'Accentuation des contours en post-traitement'),
    antialiasing:     opt(AA_MODES, AA_MODES[0], 'Anticrénelage', 'display'),

    // ── Effets & performance ──
    hazeResolution:   opt([RES_AUTO, '1/16 de résolution', '1/8 de résolution', 'Quart de résolution', 'Demi-résolution', 'Pleine résolution'], RES_AUTO, 'Brouillard : résolution', 'effects', 'Auto : pleine résolution jusqu’en 1080p, ½ en 4K'),
    hazeSegments:     num(2, 1, 8, 1, 'Brouillard : tranches de calcul', 'effects'),
    hazeMaxLights:    num(6, 1, 8, 1, 'Brouillard : lumières max', 'effects'),
    spotBeamQuality:  opt(RES_QUALITY_NAMES, RES_AUTO, 'Lyres : qualité des faisceaux', 'effects', 'Auto : pleine résolution jusqu’en 1080p, ½ en 4K'),
    spotRealLights:   bool(true, 'Lyres : éclairage réel de la scène', 'effects'),
    spotShadows:      bool(false, 'Lyres : ombres portées (2 max)', 'effects'),
    laserRange:       num(300, 20, 3000, 10, 'Lasers : distance d\'affichage (m)', 'effects'),
    laserFanQuality:  opt(RES_QUALITY_NAMES, RES_AUTO, 'Lasers : qualité des nappes', 'effects', 'Plus la résolution est basse, moins la fumée des nappes coûte à calculer. Auto : pleine résolution jusqu’en 1080p, ½ en 4K'),
    laserSharedSmoke: bool(true, 'Lasers : fumée partagée (nappes superposées)', 'effects', 'La fumée des nappes superposées n\'est calculée qu\'une fois par pixel'),
    grassDistance:    num(0, 0, 60, 1, 'Herbe : distance d\'affichage (m)', 'effects', '0 = pas d\'herbe'),

    // ── Son ──
    localVolume:      num(100, 0, 1000, 1, 'Volume local (%)', 'audio'),

    // ── Contrôles ──
    mouseSensitivity: num(60, 0, 200, 1, 'Sensibilité souris (%)', 'input'),
};

export function defaultClientOptions() {
    const out = {};
    for (const [k, s] of Object.entries(CLIENT_OPTIONS_SCHEMA)) out[k] = s.value;
    return out;
}

function sanitize(key, v) {
    const s = CLIENT_OPTIONS_SCHEMA[key];
    if (!s) return undefined;
    if (s.options) return s.options.includes(v) ? v : undefined;
    if (typeof s.value === 'boolean') return typeof v === 'boolean' ? v : undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return key === 'mouseSensitivity' ? Math.max(s.min, n) : Math.min(s.max, Math.max(s.min, n));
}

/** Reprise des anciennes clés (réglages éparpillés avant le menu Options) */
function readLegacy() {
    const out = {};
    try {
        const u = JSON.parse(localStorage.getItem('soundstage3d:user-settings') || 'null');
        if (u && typeof u === 'object') {
            if (u['local-volume'] !== undefined) out.localVolume = u['local-volume'];
            if (u['grass-distance'] !== undefined) out.grassDistance = u['grass-distance'];
            if (u['mouse-sensitivity'] !== undefined) out.mouseSensitivity = u['mouse-sensitivity'];
        }
        const aa = localStorage.getItem('soundstage.antialiasing');
        if (aa) out.antialiasing = aa;
        const range = localStorage.getItem('soundstage.laserRange');
        if (range) out.laserRange = parseFloat(range);
        localStorage.removeItem('soundstage3d:user-settings');
        localStorage.removeItem('soundstage.antialiasing');
        localStorage.removeItem('soundstage.laserRange');
    } catch (_) { /* stockage indisponible */ }
    return out;
}

class ClientOptionsStore {
    constructor() {
        this.values = defaultClientOptions();
        this._appliers = new Map();
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { saved = null; }
        const src = (saved && typeof saved === 'object') ? saved : readLegacy();
        for (const [k, v] of Object.entries(src)) {
            const clean = sanitize(k, v);
            if (clean !== undefined) this.values[k] = clean;
        }
        // Une seule fois : l'ancien réglage par défaut (MSAA 4x) passe au mode automatique (2x en 4K)
        let migrated = false;
        if (saved && saved._aaAuto) {
            this.values._aaAuto = true;
        } else {
            if (this.values.antialiasing === 'MSAA 4x (Matériel - Recommandé)') this.values.antialiasing = AA_MODES[0];
            this.values._aaAuto = true;
            migrated = true;
        }
        // Une seule fois : l'ancienne résolution par défaut des effets (½, trop grossière en 1080p) passe en Auto
        if (saved && saved._resAuto) {
            this.values._resAuto = true;
        } else {
            for (const k of ['hazeResolution', 'spotBeamQuality', 'laserFanQuality']) {
                if (this.values[k] === 'Demi-résolution') this.values[k] = RES_AUTO;
            }
            this.values._resAuto = true;
            migrated = true;
        }
        if (!saved || migrated) this._save();
    }

    get(key) { return this.values[key]; }

    /** Enregistre la fonction qui applique une option ; elle est appelée tout de suite avec la valeur courante */
    bind(key, fn) {
        this._appliers.set(key, fn);
        try { fn(this.values[key]); } catch (e) { console.warn('[Options]', key, e); }
    }

    set(key, value) {
        const clean = sanitize(key, value);
        if (clean === undefined) return;
        this.values[key] = clean;
        this._save();
        const fn = this._appliers.get(key);
        if (fn) { try { fn(clean); } catch (e) { console.warn('[Options]', key, e); } }
    }

    resetAll() {
        for (const [k, s] of Object.entries(CLIENT_OPTIONS_SCHEMA)) this.set(k, s.value);
    }

    _save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values)); } catch (_) { /* stockage indisponible */ }
    }
}

export const clientOptions = new ClientOptionsStore();
