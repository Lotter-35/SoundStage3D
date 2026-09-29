/**
 * hazeParams.js
 * ─────────────────────────────────────────────────────────────
 * Réglages du brouillard de salle (boîte de fumée éclairée par les projecteurs).
 * Le même schéma sert au panneau, aux valeurs par défaut et à la synchro multijoueur.
 * ─────────────────────────────────────────────────────────────
 */

export const HAZE_MODES = ['Strobes prioritaires', 'La plus forte gagne'];
export const HAZE_RESOLUTIONS = ['1/16 de résolution', '1/8 de résolution', 'Quart de résolution', 'Demi-résolution', 'Pleine résolution'];
export const HAZE_BEAM_LINK = ['Indépendante', 'Liée au brouillard de salle'];

const num = (value, min, max, step, label, folder) => ({ value, min, max, step, label, folder });
const bool = (value, label, folder) => ({ value, label, folder });
const opt = (options, value, label, folder) => ({ options, value, label, folder });
const color = (value, label, folder) => ({ value, label, folder, color: true });

export const HAZE_FOLDERS = [
    { id: 'main',    title: '🌫️ Fumée' },
    { id: 'light',   title: '💡 Sources de lumière' },
    { id: 'box',     title: '📦 Boîte de fumée' },
    { id: 'perf',    title: '⚙️ Qualité & performance' },
];

export const HAZE_PARAMS_SCHEMA = {
    // ── Fumée ──
    enabled:      bool(true, 'Activer le brouillard', 'main'),
    density:      num(0.02, 0, 0.15, 0.001, 'Densité (m⁻¹)', 'main'),
    intensity:    num(1.0, 0, 5, 0.05, 'Intensité lumineuse', 'main'),
    multiScatter: num(0.6, 0, 2, 0.01, 'Diffusion multiple (envahit la salle)', 'main'),
    scatterReach: num(12, 0.5, 40, 0.5, 'Portée de la diffusion (m)', 'main'),
    anisotropy:   num(0.55, 0, 0.9, 0.01, 'Diffusion avant (éblouissement)', 'main'),
    tint:         color('#e8ecf2', 'Teinte / albédo de la fumée', 'main'),
    ambient:      num(0.15, 0, 2, 0.01, 'Lumière ambiante dans la fumée', 'main'),
    layerHeight:  num(3.5, 0, 30, 0.1, 'Épaisseur de la nappe au sol (m, 0 = uniforme)', 'main'),
    noise:        num(0, 0, 1, 0.01, 'Variations de densité', 'main'),
    persistence:  num(0, 0, 1, 0.01, 'Persistance après flash', 'main'),
    beamLink:     opt(HAZE_BEAM_LINK, 'Indépendante', 'Fumée des faisceaux des lyres', 'main'),

    // ── Sources ──
    mode:         opt(HAZE_MODES, 'Strobes prioritaires', 'Priorité des sources', 'light'),
    useStrobes:   bool(true, 'Stroboscopes', 'light'),
    useSpots:     bool(true, 'Lyres Spot', 'light'),
    useLasers:    bool(true, 'Lumière des lasers', 'light'),
    useScene:     bool(true, 'Lampes posées (point, spot, panneau)', 'light'),
    useSun:       bool(true, 'Soleil / lune', 'light'),
    strobeGain:   num(2, 0, 8, 0.05, 'Gain stroboscopes', 'light'),
    spotGain:     num(1, 0, 5, 0.05, 'Gain lyres', 'light'),
    laserGain:    num(1, 0, 5, 0.05, 'Gain lasers', 'light'),
    sceneGain:    num(1, 0, 10, 0.05, 'Gain lampes posées', 'light'),

    // ── Boîte (espace public + scène par défaut) ──
    boxX:         num(0, -150, 150, 0.5, 'Centre X', 'box'),
    boxY:         num(45, -10, 80, 0.5, 'Centre Y', 'box'),
    boxZ:         num(80, -150, 150, 0.5, 'Centre Z', 'box'),
    sizeX:        num(100, 1, 300, 0.5, 'Largeur (X)', 'box'),
    sizeY:        num(90, 1, 120, 0.5, 'Hauteur (Y)', 'box'),
    sizeZ:        num(200, 1, 300, 0.5, 'Profondeur (Z)', 'box'),
    edge:         num(8, 0, 20, 0.1, 'Bords doux (m)', 'box'),

    // ── Qualité ──
    resolution:   opt(HAZE_RESOLUTIONS, 'Quart de résolution', 'Résolution', 'perf'),
    maxLights:    num(6, 1, 8, 1, 'Nombre de lumières max', 'perf'),
    segments:     num(2, 1, 8, 1, 'Tranches de calcul', 'perf'),
};

/** Réglages locaux à chaque machine (jamais synchronisés) */
// Réglages de qualité propres à chaque joueur (menu ⚙️ Options, jamais synchronisés)
export const HAZE_LOCAL_KEYS = new Set(['resolution', 'maxLights', 'segments']);

export function defaultHazeParams() {
    const out = {};
    for (const [k, s] of Object.entries(HAZE_PARAMS_SCHEMA)) out[k] = s.value;
    return out;
}
