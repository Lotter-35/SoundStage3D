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

/** Résolution de la passe des faisceaux SS Depth → diviseur de l'image (par axe) */
export const SS_RESOLUTIONS = { '½': 2, '⅓': 3, '¼': 4 };
/** Ombres statiques des lyres → texels par face de la cubemap (0 = désactivées) */
export const SPOT_SHADOW_SIZES = { 'Désactivées': 0, '128': 128, '256': 256 };
/** Résolution des taches de lumière → diviseur ('auto' : pleine jusqu'en 1080p, ½ au-delà) */
export const POOL_RESOLUTIONS = { 'Auto': 'auto', 'Pleine': 1, '½': 2 };
/** Qualité de la lumière indirecte (grille de GI) des lyres */
export const GI_QUALITIES = ['Désactivée', 'Basse', 'Haute'];
/** Résolution des reflets des faisceaux → diviseur de l'image (par axe) */
export const REFLECT_RESOLUTIONS = { '¼': 4, '⅛': 8 };


export const OPTION_FOLDERS = [
    { id: 'display', title: '🖥️ Affichage' },
    { id: 'effects', title: '✨ Effets & performance' },
    { id: 'audio',   title: '🔊 Son' },
    { id: 'input',   title: '🖱️ Contrôles' },
];

/** Sous-dossiers (fermés sauf `open`) : option.sub → dossier dans son dossier principal */
export const OPTION_SUBFOLDERS = {
    effects: [
        { id: 'res',   title: '📐 Résolution des effets', open: true },
        { id: 'haze',  title: '🌫️ Brouillard' },
        { id: 'spot',  title: '🔦 Lyres' },
        { id: 'laser', title: '🔴 Lasers' },
        { id: 'grass', title: '🌿 Herbe' },
    ],
};

const num = (value, min, max, step, label, folder, hint) => ({ value, min, max, step, label, folder, hint });
const opt = (options, value, label, folder, hint) => ({ options, value, label, folder, hint });
const bool = (value, label, folder, hint) => ({ value, label, folder, hint });
/** Range une option dans un sous-dossier (voir OPTION_SUBFOLDERS) */
const sub = (id, o) => ({ ...o, sub: id });

/** Ordre d’affichage = ordre de déclaration */
export const CLIENT_OPTIONS_SCHEMA = {
    // ── Affichage ──
    renderScale:      num(100, 25, 200, 5, 'Échelle rendu (%)', 'display', '100 % = résolution de l\'écran (plafonnée à 1,5× sur écran haute densité)'),
    dynamicResolution: bool(true, 'Rés. dynamique', 'display', 'Baisse l’échelle de rendu (jusqu’à 67 %) quand la carte graphique ne tient pas les FPS visés ; l’échelle de rendu choisie reste le maximum'),
    dynamicResolutionTarget: num(100, 30, 100, 5, 'FPS visés (% écran)', 'display', '100 % = fréquence de l’écran (ex. 120 Hz → 120 FPS, 50 % → 60 FPS). Mise à jour quand la fenêtre change d’écran'),
    sharpness:        num(0, 0, 1, 0.01, 'Netteté', 'display', 'Accentuation des contours en post-traitement'),
    antialiasing:     opt(AA_MODES, AA_MODES[0], 'Anticrénelage', 'display', 'Modes MSAA : géométrie de la scène (MSAA) + image finale entière (SMAA : faisceaux, lasers, brouillard, personnage devant une lumière)'),
    gpuPassTimings:   bool(false, 'Mesures GPU par passe', 'display', 'Affiche le temps GPU de chaque passe (scène, faisceaux classiques / SS Depth, halo, brouillard, blooms, composition). La résolution dynamique est figée pendant la mesure'),

    // ── Effets & performance ──
    hazeResolution:   sub('res', opt([RES_AUTO, '1/16 de résolution', '1/8 de résolution', 'Quart de résolution', 'Demi-résolution', 'Pleine résolution'], RES_AUTO, 'Brouillard', 'effects', 'Résolution du brouillard. Auto : pleine résolution jusqu’en 1080p, ½ en 4K')),
    spotBeamQuality:  sub('res', opt(RES_QUALITY_NAMES, RES_AUTO, 'Lyres', 'effects', 'Résolution des faisceaux des lyres. Auto : pleine résolution jusqu’en 1080p, ½ en 4K')),
    laserFanQuality:  sub('res', opt(RES_QUALITY_NAMES, RES_AUTO, 'Lasers', 'effects', 'Résolution des nappes laser : plus elle est basse, moins la fumée des nappes coûte à calculer. Auto : pleine résolution jusqu’en 1080p, ½ en 4K')),
    hazeSegments:     sub('haze', num(2, 1, 8, 1, 'Tranches', 'effects', 'Tranches de calcul du brouillard')),
    hazeMaxLights:    sub('haze', num(6, 1, 8, 1, 'Lumières max', 'effects', 'Nombre maximal de lumières qui éclairent le brouillard')),
    spotShadowRes:    sub('spot', opt(Object.keys(SPOT_SHADOW_SIZES), '128', 'Ombres des lyres', 'effects', 'Ombres du décor dans les faisceaux et les taches de lumière de toutes les lyres : une carte de distances par lyre (6 faces de 128² ou 256²), calculée une fois puis seulement quand une lyre est déplacée ou que le décor change')),
    spotClassicShadows: sub('spot', bool(true, 'Ombres dans les faisceaux classiques', 'effects', 'Les lyres en rendu Classique utilisent aussi la carte d’ombres (sinon : boîtes simplifiées de la scène)')),
    spotPoolResolution: sub('spot', opt(Object.keys(POOL_RESOLUTIONS), 'Auto', 'Résolution des taches', 'effects', 'Taches de lumière des lyres sur le décor : pleine résolution ou ½ (remontée guidée par la profondeur). Auto : pleine jusqu’en 1080p, ½ au-delà')),
    spotGIQuality:    sub('spot', opt(GI_QUALITIES, 'Basse', 'Qualité GI', 'effects', 'Lumière indirecte des lyres (rebond sur le décor, brume éclairée) : grille 3D de la salle. Basse : 32 × 12 × 40 cellules, ⅛ mise à jour par image ; Haute : 48 × 16 × 64, ¼ par image. Désactivée : aucun coût')),
    spotReflectResolution: sub('spot', opt(Object.keys(REFLECT_RESOLUTIONS), '¼', 'Résolution des reflets', 'effects', 'Reflets des faisceaux sur le plateau brillant : calculés à cette fraction de l’image (par axe), floutés puis remontés en suivant la profondeur')),
    spotSSResolution: sub('spot', opt(Object.keys(SS_RESOLUTIONS), '⅓', 'Résolution des faisceaux SS', 'effects', 'Faisceaux des lyres en rendu SS Depth : calculés à cette fraction de l’image (par axe) puis remontés en pleine résolution en suivant la profondeur. ⅓ conseillé en 4K')),
    spotSSSharpness:  sub('spot', num(1.5, 0.2, 4, 0.05, 'Netteté des bords', 'effects', 'Faisceaux SS Depth : plus la valeur est haute, plus les bords des faisceaux devant ou derrière les objets sont nets (filtre bilatéral guidé par la profondeur)')),
    laserRange:       sub('laser', num(300, 20, 3000, 10, 'Distance (m)', 'effects', 'Distance d’affichage des lasers')),
    laserSharedSmoke: sub('laser', bool(true, 'Fumée partagée', 'effects', 'La fumée des nappes superposées n’est calculée qu’une fois par pixel')),
    grassDistance:    sub('grass', num(0, 0, 60, 1, 'Distance (m)', 'effects', 'Distance d’affichage de l’herbe (0 = pas d’herbe)')),

    // ── Son ──
    localVolume:      num(100, 0, 1000, 1, 'Volume local (%)', 'audio'),

    // ── Contrôles ──
    mouseSensitivity: num(60, 0, 200, 1, 'Sensibilité souris (%)', 'input'),
    snapGrid:         num(1, 0.05, 10, 0.05, 'Grille gizmo (m)', 'input', 'Maj enfoncée en déplaçant une lumière au gizmo : position calée sur la grille du monde'),
    snapAngle:        num(45, 1, 90, 1, 'Palier rotation (°)', 'input', 'Maj enfoncée en faisant pivoter une lumière au gizmo : angle calé sur ces paliers'),
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
