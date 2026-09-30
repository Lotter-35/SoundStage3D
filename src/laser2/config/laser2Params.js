/**
 * laser2Params.js
 * ─────────────────────────────────────────────────────────────
 * Schéma de TOUS les paramètres du nouveau laser (moteur de points + galvos) :
 *   - valeur par défaut, bornes, pas, libellé, dossier du panneau
 *   - `dmx: true`  → réglage de show (pilotable plus tard par le profil DMX)
 *   - `dmx: false` → installation / fiche technique du boîtier / rendu
 *
 * Couleurs : RGB dans le code (0…1), sélecteur de couleur classique (#rrggbb) dans le panneau.
 * ─────────────────────────────────────────────────────────────
 */

/** Motifs du générateur interne (l'ordre servira au canal DMX « Motif ») */
export const PATTERNS = [
    'Mire ILDA',
    'Faisceaux (éventail)',
    'Nappe (ligne)',
    'Nappe + faisceaux',
    'Point fixe',
    'Cercle (cône)',
    'Carré',
    'Triangle',
    'Étoile',
    'Sinusoïde',
];

export const SOURCES = ['Motif interne', 'Fichier ILDA'];
export const PLAY_MODES = ['Boucle', 'Aller-retour', 'Image fixe'];
export const ILDA_COLOR_MODES = ['Couleurs du fichier', 'Couleur du laser'];

export const SHUTTER_MODES = ['Ouvert', 'Fermé', 'Strobe'];
export const PERSISTENCE_MODES = ['Œil', 'Caméra'];
export const MODULATIONS = ['Analogique', 'TTL (tout ou rien)'];
/** Vitesse nominale des scanners (points/s à 8°, norme ILDA) */
export const SCANNER_SPEEDS = ['20k', '30k', '40k', '60k'];

/** Fiches techniques types (puissances par couleur en W, scanners, optique) */
export const HARDWARE_PRESETS = {
    'RGB 1 W (club)':      { powerR: 0.3, powerG: 0.25, powerB: 0.5, scanner: '20k', divergence: 1.4, aperture: 3.5 },
    'RGB 5 W':             { powerR: 1.3, powerG: 1.2, powerB: 2.5, scanner: '30k', divergence: 1.0, aperture: 5 },
    'RGB 20 W (festival)': { powerR: 5, powerG: 5, powerB: 10, scanner: '40k', divergence: 0.8, aperture: 6 },
    'RGB 30 W (festival)': { powerR: 8, powerG: 7, powerB: 15, scanner: '60k', divergence: 0.6, aperture: 7 },
};
export const PRESET_NAMES = [...Object.keys(HARDWARE_PRESETS), 'Personnalisé'];

const opt = (options, value, label, folder, dmx = true) => ({ value, options, label, folder, dmx });
const num = (value, min, max, step, label, folder, dmx = true) => ({ value, min, max, step, label, folder, dmx });
const color = (value, label, folder, dmx = true) => ({ value, label, folder, dmx, color: true });

export const LASER2_FOLDERS = [
    { id: 'place',    title: '📍 Placement' },
    { id: 'content',  title: '🖼️ Contenu (motif)' },
    { id: 'geometry', title: '📐 Géométrie' },
    { id: 'color',    title: '🎨 Couleur & Intensité', power: true },
    { id: 'hardware', title: '⚙️ Boîtier (fiche technique)' },
    { id: 'render',   title: '👁️ Rendu' },
];

export const LASER2_PARAMS_SCHEMA = {
    // ── 📍 Placement (hors DMX) ──
    posX:        num(0, -80, 80, 0.05, 'Position X', 'place', false),
    posY:        num(14, -5, 40, 0.05, 'Position Y', 'place', false),
    posZ:        num(0, -80, 80, 0.05, 'Position Z', 'place', false),
    yaw:         num(0, -180, 180, 1, 'Orientation (Yaw)', 'place', false),
    pitch:       num(0, -90, 90, 1, 'Inclinaison (Pitch)', 'place', false),
    roll:        num(0, -180, 180, 1, 'Rotation (Roll)', 'place', false),

    // ── 🖼️ Contenu ──
    source:      opt(SOURCES, 'Motif interne', 'Source', 'content'),
    pattern:     opt(PATTERNS, 'Faisceaux (éventail)', 'Motif', 'content'),
    // Forme ILDA : chemin dans la bibliothèque du serveur (« Banque/forme.ild »), choisie par banque dans le panneau
    ildaFile:    { value: '', label: 'Forme ILDA', folder: 'content', dmx: true, custom: true },
    playMode:    opt(PLAY_MODES, 'Boucle', 'Lecture', 'content'),
    ildaFps:     num(30, 1, 60, 1, 'Vitesse d\'animation (images/s)', 'content'),
    ildaFrame:   num(0, 0, 999, 1, 'Image affichée (image fixe)', 'content'),
    ildaColor:   opt(ILDA_COLOR_MODES, 'Couleurs du fichier', 'Couleurs', 'content'),
    scanRate:    num(30, 5, 60, 0.5, 'Vitesse de dessin (kpps)', 'content'),
    beamCount:   num(8, 1, 64, 1, 'Nombre de faisceaux', 'content'),
    beamDwell:   num(14, 1, 60, 1, 'Points par faisceau', 'content'),
    density:     num(60, 5, 100, 1, 'Densité de points (%)', 'content'),
    cornerPoints: num(4, 0, 16, 1, 'Points d\'angle', 'content'),
    blankPoints: num(6, 0, 20, 1, 'Points de masquage', 'content'),

    // ── 📐 Géométrie ──
    sizeX:       num(60, 0, 100, 0.1, 'Taille X (%)', 'geometry'),
    sizeY:       num(60, 0, 100, 0.1, 'Taille Y (%)', 'geometry'),
    offsetX:     num(0, -100, 100, 0.1, 'Position X (%)', 'geometry'),
    offsetY:     num(0, -100, 100, 0.1, 'Position Y (%)', 'geometry'),
    rotation:    num(0, -180, 180, 0.5, 'Rotation Z (°)', 'geometry'),
    rotSpeed:    num(0, -100, 100, 1, 'Rotation continue (%)', 'geometry'),

    // ── 🎨 Couleur & intensité ──
    color:       color('#20ff40', 'Couleur', 'color'),
    dimmer:      num(100, 0, 100, 0.1, 'Dimmer (%)', 'color'),
    shutter:     opt(SHUTTER_MODES, 'Ouvert', 'Obturateur', 'color'),
    strobeRate:  num(8, 0.5, 25, 0.1, 'Fréquence strobe (Hz)', 'color'),

    // ── ⚙️ Boîtier (fiche technique, hors DMX) ──
    preset:      opt(PRESET_NAMES, 'RGB 20 W (festival)', 'Modèle', 'hardware', false),
    powerR:      num(5, 0, 40, 0.05, 'Puissance rouge 638 nm (W)', 'hardware', false),
    powerG:      num(5, 0, 40, 0.05, 'Puissance verte 520 nm (W)', 'hardware', false),
    powerB:      num(10, 0, 40, 0.05, 'Puissance bleue 450 nm (W)', 'hardware', false),
    scanner:     opt(SCANNER_SPEEDS, '40k', 'Scanners (pts/s à 8°)', 'hardware', false),
    maxAngle:    num(30, 5, 40, 0.5, 'Angle de balayage max (± °)', 'hardware', false),
    damping:     num(0.8, 0.2, 1.5, 0.01, 'Amortissement des galvos', 'hardware', false),
    aperture:    num(6, 1, 12, 0.1, 'Diamètre de sortie (mm)', 'hardware', false),
    divergence:  num(0.8, 0.2, 4, 0.05, 'Divergence (mrad)', 'hardware', false),
    modulation:  opt(MODULATIONS, 'Analogique', 'Modulation', 'hardware', false),
    threshold:   num(6, 0, 40, 0.5, 'Seuil des diodes (%)', 'hardware', false),
    colorShift:  num(6, 0, 20, 1, 'Décalage couleur (points)', 'hardware', false),

    // ── 👁️ Rendu (hors DMX) ──
    persistence: opt(PERSISTENCE_MODES, 'Œil', 'Persistance', 'render', false),
    visibility:  num(1, 0, 3, 0.01, 'Visibilité des faisceaux', 'render', false),
    forwardScatter: num(35, 0, 90, 1, 'Diffusion vers l\'avant (%)', 'render', false),
};

export function defaultLaser2Params() {
    const out = {};
    for (const [k, s] of Object.entries(LASER2_PARAMS_SCHEMA)) out[k] = s.value;
    return out;
}

/** Points/s nominaux des scanners */
export function scannerPps(name) {
    const n = parseInt(name, 10);
    return (Number.isFinite(n) ? n : 30) * 1000;
}

export function hexToRgb(hex, out = [0, 0, 0]) {
    const v = parseInt(String(hex || '#000000').replace('#', ''), 16) || 0;
    out[0] = ((v >> 16) & 255) / 255;
    out[1] = ((v >> 8) & 255) / 255;
    out[2] = (v & 255) / 255;
    return out;
}
