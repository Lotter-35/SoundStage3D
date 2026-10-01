/**
 * laser2Params.js
 * ─────────────────────────────────────────────────────────────
 * Schéma de TOUS les paramètres du nouveau laser (moteur de points + galvos) :
 *   - valeur par défaut, bornes, pas, libellé, dossier du panneau
 *   - `dmx: true`  → réglage de show (pilotable par le profil DMX, voir Laser2Profile.js)
 *   - `dmx: false` → installation / fiche technique du boîtier / rendu
 *
 * Couleurs : RGB dans le code (0…1), sélecteur de couleur classique (#rrggbb) dans le panneau.
 * ─────────────────────────────────────────────────────────────
 */

/**
 * Motifs du générateur interne, rangés en BANQUES (canaux DMX « Banque » et « Motif »).
 * Les animations sont des suites d'images jouées comme une animation ILDA.
 */
export const PATTERN_BANKS = [
    { name: 'Faisceaux', patterns: ['Faisceaux (éventail)', 'Point fixe', 'Faisceaux en cercle', 'Double éventail', 'Faisceaux en croix', 'Faisceaux dispersés'] },
    { name: 'Nappes & tunnels', patterns: ['Nappe (ligne)', 'Nappe + faisceaux', 'Nappe verticale', 'Cercle (cône)', 'Double cercle', 'Nappe en V', 'Nappe en croix'] },
    { name: 'Graphiques', patterns: ['Mire ILDA', 'Carré', 'Triangle', 'Étoile', 'Losange', 'Cœur', 'Spirale', 'Sinusoïde', 'Zigzag'] },
    { name: 'Animations', patterns: ['Cercle pulsant', 'Vague défilante', 'Tunnel qui s\'ouvre', 'Éventail qui s\'ouvre', 'Faisceaux qui balaient', 'Étoile qui respire'] },
];
export const PATTERNS = PATTERN_BANKS.flatMap(b => b.patterns);

export const SOURCES = ['Motif interne', 'Fichier ILDA', 'ILDA live'];
export const PLAY_MODES = ['Boucle', 'Aller-retour', 'Image fixe'];
export const ILDA_COLOR_MODES = ['Couleurs du fichier', 'Couleur du laser'];

export const SHUTTER_MODES = ['Ouvert', 'Fermé', 'Strobe'];
export const ZOOM_FX = ['Aucun', 'Pulse', 'Avant-arrière'];
export const SWEEP_SHAPES = ['Sinus', 'Triangle', 'Carré', 'Cercle', 'Huit', 'Aléatoire'];
export const COLOR_MODES = ['Fixe', 'Segments', 'Arc-en-ciel défilant', 'Chenillard', 'Aléatoire par point'];
export const GRATINGS = ['Aucun', '×3', '×5', '×9'];
export const DMX_MODES = ['Standard (36 canaux)'];
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
const bool = (value, label, folder, dmx = true) => ({ value, label, folder, dmx });

export const LASER2_FOLDERS = [
    { id: 'place',    title: '📍 Placement' },
    { id: 'dmx',      title: '🔌 DMX' },
    { id: 'content',  title: '🖼️ Contenu (motif)' },
    { id: 'geometry', title: '📐 Géométrie' },
    { id: 'effects',  title: '✨ Effets' },
    { id: 'color',    title: '🎨 Couleur & Intensité', power: true },
    { id: 'hardware', title: '⚙️ Boîtier (fiche technique)' },
    { id: 'smoke',    title: '🌫️ Volutes' },
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

    // ── 🔌 DMX (patch, hors DMX) ──
    dmxUniverse: num(4, 1, 64, 1, 'Univers', 'dmx', false),
    dmxAddress:  num(1, 1, 512, 1, 'Adresse de départ', 'dmx', false),
    dmxMode:     opt(DMX_MODES, 'Standard (36 canaux)', 'Mode DMX', 'dmx', false),
    dmxControl:  bool(false, 'Piloté par le DMX', 'dmx', false),

    // ── 🖼️ Contenu ──
    source:      opt(SOURCES, 'Motif interne', 'Source', 'content'),
    pattern:     opt(PATTERNS, 'Faisceaux (éventail)', 'Motif', 'content'),
    // Forme ILDA : chemin dans la bibliothèque du serveur (« Banque/forme.ild »), choisie par banque dans le panneau
    ildaFile:    { value: '', label: 'Forme ILDA', folder: 'content', dmx: true, custom: true },
    // Réglage automatique : vitesse de dessin, décalage couleur et vitesse d'animation choisis pour le
    // meilleur rendu, formes ILDA trop peu détaillées complétées (physique des galvos conservée)
    autoTune:    bool(true, 'Réglage automatique (meilleur rendu)', 'content', false),
    liveChannel: num(1, 1, 16, 1, 'Canal ILDA live', 'content'),
    playMode:    opt(PLAY_MODES, 'Boucle', 'Lecture', 'content'),
    ildaFps:     num(30, 1, 60, 1, 'Vitesse d\'animation (images/s)', 'content'),
    ildaFrame:   num(0, 0, 999, 1, 'Image affichée (image fixe)', 'content'),
    ildaColor:   opt(ILDA_COLOR_MODES, 'Couleurs du fichier', 'Couleurs', 'content'),
    scanRate:    num(30, 5, 60, 0.5, 'Vitesse de dessin (kpps)', 'content'),
    beamCount:   num(8, 1, 64, 1, 'Nombre de faisceaux', 'content'),
    beamDwell:   num(14, 1, 60, 1, 'Points par faisceau', 'content'),
    fanSpread:   num(100, 0, 100, 0.1, 'Ouverture de l\'éventail (%)', 'content'),
    fanBlend:    num(0, 0, 100, 1, 'Faisceaux ↔ nappe (%)', 'content'),
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
    rotX:        num(0, -180, 180, 0.5, 'Rotation 3D X (°)', 'geometry'),
    rotXSpeed:   num(0, -100, 100, 1, 'Rotation 3D X continue (%)', 'geometry'),
    rotY:        num(0, -180, 180, 0.5, 'Rotation 3D Y (°)', 'geometry'),
    rotYSpeed:   num(0, -100, 100, 1, 'Rotation 3D Y continue (%)', 'geometry'),

    // ── ✨ Effets ──
    drawStart:   num(0, 0, 100, 0.1, 'Tracé : début (%)', 'effects'),
    drawEnd:     num(100, 0, 100, 0.1, 'Tracé : fin (%)', 'effects'),
    dots:        num(0, 0, 100, 1, 'Pointillés', 'effects'),
    zoomFx:      opt(ZOOM_FX, 'Aucun', 'Zoom automatique', 'effects'),
    zoomFxSpeed: num(30, 0, 100, 1, 'Vitesse du zoom (%)', 'effects'),
    sweepX:      num(0, 0, 100, 0.1, 'Balayage X (amplitude %)', 'effects'),
    sweepY:      num(0, 0, 100, 0.1, 'Balayage Y (amplitude %)', 'effects'),
    sweepSpeed:  num(30, 0, 100, 1, 'Vitesse du balayage (%)', 'effects'),
    sweepShape:  opt(SWEEP_SHAPES, 'Sinus', 'Forme du balayage', 'effects'),
    waveAmp:     num(0, 0, 100, 1, 'Vague (amplitude %)', 'effects'),
    waveSpeed:   num(40, 0, 100, 1, 'Vitesse de la vague (%)', 'effects'),
    grating:     opt(GRATINGS, 'Aucun', 'Réseau de diffraction', 'effects'),

    // ── 🎨 Couleur & intensité ──
    color:       color('#20ff40', 'Couleur', 'color'),
    colorMode:   opt(COLOR_MODES, 'Fixe', 'Effet de couleur', 'color'),
    colorSpeed:  num(30, 0, 100, 1, 'Vitesse de l\'effet (%)', 'color'),
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
    colorShift:  num(6, 0, 20, 1, 'Décalage couleur (points à 30 kpps)', 'hardware', false),
    galvoFx:     bool(true, 'Effet des galvos (inertie, vitesse limitée)', 'hardware', false),

    // ── 🌫️ Volutes (hors DMX) : fumée qui bouge dans les nappes, identique chez tous les joueurs ──
    smokeOn:       bool(true, 'Volutes', 'smoke', false),
    smokeAmount:   num(55, 0, 100, 1, 'Intensité (%)', 'smoke', false),
    smokeScale:    num(2.5, 0.3, 10, 0.1, 'Taille des volutes (m)', 'smoke', false),
    smokeSpeed:    num(25, 0, 100, 1, 'Vitesse (%)', 'smoke', false),
    smokeContrast: num(50, 0, 100, 1, 'Contraste (%)', 'smoke', false),
    smokeBeams:    bool(true, 'Aussi dans les faisceaux', 'smoke', false),

    // ── 👁️ Rendu (hors DMX) ──
    persistence: opt(PERSISTENCE_MODES, 'Œil', 'Persistance', 'render', false),
    visibility:  num(1, 0, 3, 0.01, 'Visibilité des faisceaux', 'render', false),
    forwardScatter: num(35, 0, 90, 1, 'Diffusion vers l\'avant (%)', 'render', false),
    audienceMask: bool(false, 'Masquage du public (sol et joueurs)', 'render'),
    sourceGlow:   num(1, 0, 4, 0.05, 'Point lumineux à la sortie', 'render', false),
    sourceGlowRadius: num(0.4, 0.1, 3, 0.05, 'Taille du point de sortie (m)', 'render', false),
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
