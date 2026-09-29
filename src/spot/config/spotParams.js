/**
 * spotParams.js
 * ─────────────────────────────────────────────────────────────
 * Schéma de TOUS les paramètres d'une lyre Spot :
 *   - valeur par défaut, bornes, pas, libellé, dossier du panneau
 *   - `dmx: true`  → attribut pilotable par le profil DMX (SpotProfile.js)
 *   - `dmx: false` → réglage d'installation (placement, patch, rendu), jamais piloté en DMX
 *
 * Le même schéma sert à l'inspecteur (construction automatique des contrôles),
 * aux valeurs par défaut, au reset et à la synchronisation multijoueur.
 * ─────────────────────────────────────────────────────────────
 */

// ── Roues de la machine (l'index 0 est toujours la position « ouverte ») ──

/** Roue de couleurs fixes : filtres dichroïques (multipliés au mélange CMY) */
export const COLOR_WHEEL = [
    { name: 'Ouvert (blanc)',  rgb: [1.00, 1.00, 1.00] },
    { name: 'Rouge',           rgb: [1.00, 0.06, 0.04] },
    { name: 'Orange',          rgb: [1.00, 0.42, 0.05] },
    { name: 'Jaune',           rgb: [1.00, 0.88, 0.10] },
    { name: 'Vert',            rgb: [0.10, 1.00, 0.18] },
    { name: 'Cyan',            rgb: [0.05, 0.85, 1.00] },
    { name: 'Bleu profond',    rgb: [0.06, 0.16, 1.00] },
    { name: 'Magenta',         rgb: [0.95, 0.08, 0.90] },
    { name: 'Rose',            rgb: [1.00, 0.45, 0.70] },
    { name: 'CTO 3200 K',      rgb: [1.00, 0.72, 0.42] },
];

/** Roue de gobos fixes (couche de la texture de gobos = index) */
export const GOBO_FIXED_WHEEL = [
    'Ouvert', 'Points', 'Brisure', 'Étoile', 'Anneaux', 'Barres', 'Triangle', 'Fleur', 'Tourbillon'
];

/** Roue de gobos rotatifs (couche = 8 + index) */
export const GOBO_ROT_WHEEL = [
    'Ouvert', 'Feuillage', 'Rayons', 'Spirale', 'Grille', 'Cercles', 'Éclats', 'Nébuleuse'
];

/** Roue d'animation (couche = 15 + index) */
export const ANIM_WHEEL = ['Aucune', 'Eau', 'Feu', 'Nuages'];

export const SHUTTER_MODES = ['Fermé', 'Ouvert', 'Strobe', 'Pulse ouverture', 'Pulse fermeture', 'Strobe aléatoire'];

export const PRISMS = ['Aucun', '3 facettes', '8 facettes', 'Linéaire (4)'];

export const GOBO_ROT_MODES = ['Index', 'Rotation'];

export const MOUNT_MODES = ['Posé au sol', 'Suspendu'];

export const DMX_MODES = ['Standard (24 canaux)', 'Étendu (34 canaux)'];

/** Limites mécaniques */
export const PAN_RANGE = 540;
export const TILT_RANGE = 270;

const opt = (options, value, label, folder, dmx = true) => ({ value, options, label, folder, dmx });
const num = (value, min, max, step, label, folder, dmx = true) => ({ value, min, max, step, label, folder, dmx });
const bool = (value, label, folder, dmx = true) => ({ value, label, folder, dmx });
const color = (value, label, folder, dmx = true) => ({ value, label, folder, dmx, color: true });

export const SPOT_FOLDERS = [
    { id: 'place',   title: '📍 Placement' },
    { id: 'dmx',     title: '🔌 DMX' },
    { id: 'intens',  title: '💡 Intensité & Obturateur', power: true },
    { id: 'pos',     title: '🎯 Position (Pan / Tilt)' },
    { id: 'color',   title: '🎨 Couleur' },
    { id: 'gobo',    title: '🌀 Gobos & Animation' },
    { id: 'prism',   title: '🔷 Prisme' },
    { id: 'beam',    title: '🌫️ Faisceau (Frost / Iris)' },
    { id: 'optics',  title: '🔍 Optique (Zoom / Focus)' },
    { id: 'blades',  title: '🔪 Couteaux (Framing)', parent: 'optics' },
    { id: 'render',  title: '✨ Rendu' },
];

export const SPOT_PARAMS_SCHEMA = {
    // ── 📍 Placement (hors DMX) ──
    posX:        num(0, -80, 80, 0.05, 'Position X', 'place', false),
    posY:        num(0.5, -5, 40, 0.05, 'Position Y', 'place', false),
    posZ:        num(0, -80, 80, 0.05, 'Position Z', 'place', false),
    yaw:         num(0, -180, 180, 1, 'Orientation (Yaw)', 'place', false),
    pitch:       num(0, -90, 90, 1, 'Inclinaison (Pitch)', 'place', false),
    roll:        num(0, -180, 180, 1, 'Rotation (Roll)', 'place', false),
    mount:       opt(MOUNT_MODES, 'Posé au sol', 'Montage', 'place', false),
    invertPan:   bool(false, 'Inverser le Pan', 'place', false),
    invertTilt:  bool(false, 'Inverser le Tilt', 'place', false),

    // ── 🔌 DMX (patch, hors DMX) ──
    dmxUniverse: num(1, 1, 64, 1, 'Univers', 'dmx', false),
    dmxAddress:  num(1, 1, 512, 1, 'Adresse de départ', 'dmx', false),
    dmxMode:     opt(DMX_MODES, 'Étendu (34 canaux)', 'Mode DMX', 'dmx', false),
    dmxControl:  bool(false, 'Piloté par le DMX', 'dmx', false),

    // ── 💡 Intensité & obturateur ──
    dimmer:       num(100, 0, 100, 0.1, 'Dimmer (%)', 'intens'),
    shutter:      opt(SHUTTER_MODES, 'Ouvert', 'Obturateur', 'intens'),
    shutterSpeed: num(40, 0, 100, 1, 'Vitesse strobe / pulse (%)', 'intens'),

    // ── 🎯 Position ──
    pan:     num(0, -PAN_RANGE / 2, PAN_RANGE / 2, 0.1, 'Pan (°)', 'pos'),
    tilt:    num(35, -TILT_RANGE / 2, TILT_RANGE / 2, 0.1, 'Tilt (°)', 'pos'),
    ptSpeed: num(100, 0, 100, 1, 'Vitesse de mouvement (%)', 'pos'),

    // ── 🎨 Couleur (mélange CMY dans le code, sélecteur RGB dans l'UI) ──
    color:        color('#ffffff', 'Couleur (CMY)', 'color'),
    colorWheel:   opt(COLOR_WHEEL.map(c => c.name), 'Ouvert (blanc)', 'Roue de couleurs', 'color'),
    colorHalf:    bool(false, 'Demi-couleur (entre 2 filtres)', 'color'),
    rainbow:      num(0, -100, 100, 1, 'Défilement rainbow (%)', 'color'),

    // ── 🌀 Gobos & animation ──
    goboFixed:    opt(GOBO_FIXED_WHEEL, 'Ouvert', 'Gobo fixe', 'gobo'),
    goboShake:    num(0, 0, 100, 1, 'Secousse gobo fixe (%)', 'gobo'),
    goboRot:      opt(GOBO_ROT_WHEEL, 'Ouvert', 'Gobo rotatif', 'gobo'),
    goboRotMode:  opt(GOBO_ROT_MODES, 'Rotation', 'Mode gobo rotatif', 'gobo'),
    goboIndex:    num(0, 0, 360, 0.5, 'Index gobo (°)', 'gobo'),
    goboSpeed:    num(25, -100, 100, 1, 'Rotation gobo (%)', 'gobo'),
    animWheel:    opt(ANIM_WHEEL, 'Aucune', 'Roue d’animation', 'gobo'),
    animSpeed:    num(30, -100, 100, 1, 'Vitesse animation (%)', 'gobo'),

    // ── 🔷 Prisme ──
    prism:        opt(PRISMS, 'Aucun', 'Prisme', 'prism'),
    prismSpeed:   num(20, -100, 100, 1, 'Rotation prisme (%)', 'prism'),
    prismIndex:   num(0, 0, 360, 0.5, 'Index prisme (°)', 'prism'),

    // ── 🌫️ Faisceau ──
    frost:        num(0, 0, 100, 1, 'Frost (%)', 'beam'),
    iris:         num(100, 20, 100, 1, 'Iris (% ouverture)', 'beam'),

    // ── 🔍 Optique ──
    zoom:         num(14, 5, 48, 0.1, 'Zoom (° d’ouverture)', 'optics'),
    focus:        num(50, 0, 100, 0.5, 'Focus (net loin ↔ près)', 'optics'),

    // ── 🔪 Couteaux ──
    blade1:       num(0, 0, 100, 0.5, 'Couteau 1 – insertion (%)', 'blades'),
    blade1Angle:  num(0, -45, 45, 0.5, 'Couteau 1 – angle (°)', 'blades'),
    blade2:       num(0, 0, 100, 0.5, 'Couteau 2 – insertion (%)', 'blades'),
    blade2Angle:  num(0, -45, 45, 0.5, 'Couteau 2 – angle (°)', 'blades'),
    blade3:       num(0, 0, 100, 0.5, 'Couteau 3 – insertion (%)', 'blades'),
    blade3Angle:  num(0, -45, 45, 0.5, 'Couteau 3 – angle (°)', 'blades'),
    blade4:       num(0, 0, 100, 0.5, 'Couteau 4 – insertion (%)', 'blades'),
    blade4Angle:  num(0, -45, 45, 0.5, 'Couteau 4 – angle (°)', 'blades'),
    bladeRot:     num(0, -45, 45, 0.5, 'Rotation du bloc couteaux (°)', 'blades'),

    // ── ✨ Rendu (réglages de simulation, hors DMX) ──
    beamIntensity: num(1, 0, 4, 0.05, 'Intensité du faisceau', 'render', false),
    lightOutput:   num(1, 0, 4, 0.05, 'Lumière émise sur la scène', 'render', false),
    lensGlare:     num(1, 0, 3, 0.05, 'Éblouissement lentille', 'render', false),
};

/** Paramètres par défaut d'une lyre */
export function defaultSpotParams() {
    const out = {};
    for (const [k, s] of Object.entries(SPOT_PARAMS_SCHEMA)) out[k] = s.value;
    return out;
}

/** Réglages globaux partagés par toutes les lyres (fumée / qualité) */
export const SPOT_GLOBAL_SCHEMA = {
    hazeDensity:  { value: 0.6,  min: 0, max: 3, step: 0.01, label: 'Densité de la fumée (haze)' },
    hazeContrast: { value: 0.65, min: 0, max: 1.5, step: 0.01, label: 'Volutes (contraste)' },
    hazeScale:    { value: 1.0,  min: 0.2, max: 4, step: 0.05, label: 'Taille des volutes' },
    scattering:   { value: 0.72, min: 0, max: 0.95, step: 0.01, label: 'Diffusion avant (Mie)' },
    beamQuality:  { value: 'Demi-résolution', options: ['Demi-résolution', 'Pleine résolution'], label: 'Qualité des faisceaux' },
    realLights:   { value: true, label: 'Éclairage réel de la scène' },
    lightShadows: { value: false, label: 'Ombres portées (2 lyres max)' },
};

/** Réglages de rendu propres à chaque joueur (menu ⚙️ Options, jamais synchronisés) */
export const SPOT_LOCAL_GLOBALS = new Set(['beamQuality', 'realLights', 'lightShadows']);

export function defaultSpotGlobals() {
    const out = {};
    for (const [k, s] of Object.entries(SPOT_GLOBAL_SCHEMA)) out[k] = s.value;
    return out;
}
