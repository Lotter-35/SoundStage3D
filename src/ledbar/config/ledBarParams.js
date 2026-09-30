/**
 * ledBarParams.js
 * ─────────────────────────────────────────────────────────────
 * Schéma de TOUS les paramètres d'une barre LED motorisée (tilt 360° continu) :
 *   - valeur par défaut, bornes, pas, libellé, dossier du panneau
 *   - `dmx: true`  → attribut pilotable par le profil DMX (LedBarProfile.js)
 *   - `dmx: false` → réglage d'installation (placement, patch, rendu), jamais piloté en DMX
 *
 * Deux niveaux, comme une tête multi-éléments (MagicQ « Multi-Element Head ») :
 *   - réglages globaux de la barre (mécanique, optique, intensité, macros FX)
 *   - réglages individuels de chaque pixel (`pixels` : 1 couleur par LED)
 *
 * Couleurs : RGB dans le code (0…1), sélecteur de couleur classique (#rrggbb) dans le panneau.
 * ─────────────────────────────────────────────────────────────
 */

export const PIXEL_COUNTS = ['8', '16', '32'];
export const MAX_PIXELS = 32;

export const SHUTTER_MODES = ['Fermé', 'Ouvert', 'Strobe', 'Strobe aléatoire', 'Pulse ouverture', 'Pulse fermeture'];

export const HALF_MODES = ['Aucune', 'Gauche / Droite', 'Haut / Bas'];

/** Motifs du générateur d'effets intégré (l'index sert aussi au canal DMX) */
export const FX_PATTERNS = [
    'Aucun',
    'Chenillard',
    'Va-et-vient',
    'K2000 (scanner)',
    'Comète',
    'Vague',
    'Double vague',
    'Rebond',
    'Éclatement centre',
    'Séparation',
    'Remplissage',
    'Empilement',
    'Pair / Impair',
    'Damier',
    'Étincelles',
    'Pluie',
    'Code-barres',
    'Strobe pixel',
    'Respiration',
    'Dégradé défilant',
    'Arc-en-ciel',
    'Arc-en-ciel global',
];

export const FX_DIRECTIONS = ['Gauche → Droite', 'Droite → Gauche', 'Centre → Extérieur', 'Extérieur → Centre'];

/** Macros de mouvement (tilt automatique, calculé sur l'horloge commune) */
export const MOVE_FX = ['Aucun', 'Balancier', 'Balancier alterné', 'Vague entre barres', 'Hélice'];

export const DMX_MODES = ['Standard (26 canaux)', 'Pixel (26 + 4 × LED)'];

/** Macros de couleur (canaux DMX « couleur de premier plan / fond / demi-couleur ») */
export const COLOR_MACROS = [
    { name: 'Noir',         hex: '#000000' },
    { name: 'Blanc',        hex: '#ffffff' },
    { name: 'Rouge',        hex: '#ff0000' },
    { name: 'Orange',       hex: '#ff5a00' },
    { name: 'Ambre',        hex: '#ff9a00' },
    { name: 'Jaune',        hex: '#ffe000' },
    { name: 'Vert citron',  hex: '#9dff00' },
    { name: 'Vert',         hex: '#00ff20' },
    { name: 'Cyan',         hex: '#00ffe0' },
    { name: 'Bleu ciel',    hex: '#00a8ff' },
    { name: 'Bleu',         hex: '#0020ff' },
    { name: 'Violet',       hex: '#7a00ff' },
    { name: 'Magenta',      hex: '#ff00d0' },
    { name: 'Rose',         hex: '#ff4d8a' },
    { name: 'Blanc chaud',  hex: '#ffc480' },
    { name: 'UV',           hex: '#4b00ff' },
];

/** Limites mécaniques et optiques */
export const TILT_RANGE = 360;       // tilt en position : −180°…+180° (rotation infinie par le canal dédié)
export const ZOOM_MIN = 4;
export const ZOOM_MAX = 60;

const opt = (options, value, label, folder, dmx = true) => ({ value, options, label, folder, dmx });
const num = (value, min, max, step, label, folder, dmx = true) => ({ value, min, max, step, label, folder, dmx });
const bool = (value, label, folder, dmx = true) => ({ value, label, folder, dmx });
const color = (value, label, folder, dmx = true) => ({ value, label, folder, dmx, color: true });

export const LEDBAR_FOLDERS = [
    { id: 'place',  title: '📍 Placement' },
    { id: 'dmx',    title: '🔌 DMX' },
    { id: 'intens', title: '💡 Intensité & Obturateur', power: true },
    { id: 'move',   title: '🎯 Mouvement (Tilt 360°)' },
    { id: 'optics', title: '🔍 Optique (Zoom)' },
    { id: 'color',  title: '🎨 Couleur (Master)' },
    { id: 'pixels', title: '🟦 Pixels (couleur par LED)' },
    { id: 'fx',     title: '✨ Effets intégrés (Chenillards)' },
    { id: 'render', title: '🌫️ Rendu' },
];

export const LEDBAR_PARAMS_SCHEMA = {
    // ── 📍 Placement (hors DMX) ──
    posX:        num(0, -80, 80, 0.05, 'Position X', 'place', false),
    posY:        num(6, -5, 40, 0.05, 'Position Y', 'place', false),
    posZ:        num(0, -80, 80, 0.05, 'Position Z', 'place', false),
    yaw:         num(0, -180, 180, 1, 'Orientation (Yaw)', 'place', false),
    pitch:       num(0, -90, 90, 1, 'Inclinaison (Pitch)', 'place', false),
    roll:        num(0, -180, 180, 1, 'Rotation (Roll)', 'place', false),
    pixelCount:  opt(PIXEL_COUNTS, '16', 'Nombre de LED', 'place', false),
    invertTilt:  bool(false, 'Inverser le Tilt', 'place', false),

    // ── 🔌 DMX (patch, hors DMX) ──
    dmxUniverse: num(1, 1, 64, 1, 'Univers', 'dmx', false),
    dmxAddress:  num(1, 1, 512, 1, 'Adresse de départ', 'dmx', false),
    dmxMode:     opt(DMX_MODES, 'Standard (26 canaux)', 'Mode DMX', 'dmx', false),
    dmxControl:  bool(false, 'Pilotée par le DMX', 'dmx', false),

    // ── 💡 Intensité & obturateur ──
    dimmer:      num(100, 0, 100, 0.01, 'Master Dimmer (%)', 'intens'),
    shutter:     opt(SHUTTER_MODES, 'Ouvert', 'Obturateur', 'intens'),
    strobeRate:  num(8, 1, 30, 0.1, 'Fréquence strobe / pulse (Hz)', 'intens'),

    // ── 🎯 Mouvement ──
    tilt:        num(0, -TILT_RANGE / 2, TILT_RANGE / 2, 0.01, 'Tilt (°)', 'move'),
    rotation:    num(0, -100, 100, 1, 'Rotation continue (%)', 'move'),
    moveSpeed:   num(100, 0, 100, 1, 'Vitesse des moteurs (%)', 'move'),
    moveFx:      opt(MOVE_FX, 'Aucun', 'Macro de mouvement', 'move'),
    moveFxAmp:   num(45, 0, 180, 1, 'Amplitude macro (°)', 'move'),
    moveFxSpeed: num(30, 0, 100, 1, 'Vitesse macro (%)', 'move'),

    // ── 🔍 Optique ──
    zoom:        num(5, ZOOM_MIN, ZOOM_MAX, 0.1, 'Zoom (°)', 'optics'),
    zoomSplit:   bool(false, 'Zoom segmenté G / D', 'optics'),
    zoomRight:   num(30, ZOOM_MIN, ZOOM_MAX, 0.1, 'Zoom côté droit (°)', 'optics'),

    // ── 🎨 Couleur master (RGBW) ──
    color:       color('#ffffff', 'Couleur master', 'color'),
    white:       num(0, 0, 100, 1, 'Blanc (W) %', 'color'),
    halfMode:    opt(HALF_MODES, 'Aucune', 'Demi-couleur dans le faisceau', 'color'),
    halfColor:   color('#0020ff', 'Seconde couleur', 'color'),
    halfPos:     num(0, -100, 100, 1, 'Position de la séparation (%)', 'color'),

    // ── 🟦 Pixels ──
    pixelMode:   bool(false, 'Couleur par LED', 'pixels'),

    // ── ✨ Effets intégrés ──
    fxPattern:   opt(FX_PATTERNS, 'Aucun', 'Motif', 'fx'),
    fxSpeed:     num(40, 0, 100, 1, 'Vitesse (%)', 'fx'),
    fxDirection: opt(FX_DIRECTIONS, 'Gauche → Droite', 'Sens', 'fx'),
    fxFade:      num(35, 0, 100, 1, 'Fondu (0 = net / carré)', 'fx'),
    fxSize:      num(25, 1, 100, 1, 'Taille du motif (%)', 'fx'),
    fxFg:        color('#ff0060', 'Couleur premier plan', 'fx'),
    fxBg:        color('#000000', 'Couleur de fond', 'fx'),

    // ── 🌫️ Rendu (hors DMX) ──
    beamIntensity: num(1, 0, 3, 0.05, 'Intensité des faisceaux', 'render', false),
    splash:      bool(true, 'Tache de lumière au sol', 'render', false),
    lensGlare:   num(1, 0, 3, 0.05, 'Éblouissement des LED', 'render', false),
};

/** Couleurs par défaut des pixels (blanc) */
export function defaultPixels() {
    return new Array(MAX_PIXELS).fill('#ffffff');
}

export function defaultLedBarParams() {
    const out = {};
    for (const [k, s] of Object.entries(LEDBAR_PARAMS_SCHEMA)) out[k] = s.value;
    out.pixels = defaultPixels();
    return out;
}

/** Nombre de LED d'une configuration */
export function pixelCountOf(params) {
    const n = parseInt(params.pixelCount, 10);
    return n === 8 || n === 32 ? n : 16;
}

// ── Couleurs ──────────────────────────────────────────────────────────────
export function hexToRgb(hex, out = [0, 0, 0]) {
    const v = parseInt(String(hex || '#000000').replace('#', ''), 16) || 0;
    out[0] = ((v >> 16) & 255) / 255;
    out[1] = ((v >> 8) & 255) / 255;
    out[2] = (v & 255) / 255;
    return out;
}

export function rgbToHex(r, g, b) {
    const c = (x) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
}
