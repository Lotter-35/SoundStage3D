/**
 * laserConstants.js — Constantes du système laser SoundStage3D
 */

// Taille initiale des pools de faisceaux (extensibles : jusqu'à plusieurs centaines par laser,
// les buffers GPU sont partagés et redimensionnés automatiquement par le LaserBatch)
export const MAX_BEAMS_PER_POD = 32;

// Physique
export const BEAM_DIVERGENCE   = 1.0;
// Profil de largeur du faisceau : fin à la sortie de la buse, puis s'élargit avec la distance
// (facteur = START + min(d, MAX_DIST) * GROWTH → 0.3× à la buse, ~6.3× à 120 m et au-delà)
export const BEAM_START_SCALE    = 0.3;
export const BEAM_GROWTH         = 0.05;
export const BEAM_GROWTH_MAX_DIST = 120;
export function beamSpread(dist) {
    return BEAM_START_SCALE + Math.min(Math.max(dist, 0), BEAM_GROWTH_MAX_DIST) * BEAM_GROWTH * BEAM_DIVERGENCE;
}
export const ARC_SUBDIVISIONS  = 96;

// Sol + plafond virtuel (remplace Room.js du projet original)
export const SCENE_FLOOR_Y = 0;
export const SCENE_CEILING_Y = 40;
export const SCENE_HALF_SIZE = 200;   // boîte virtuelle (200m de rayon)

// Portée maximale d'un rayon en plein air (ciel) : au-delà, le faisceau s'est éteint en fondu.
// Doit rester < camera.far (main.js).
export const LASER_MAX_RANGE = 3000;
// Début du fondu de fin de portée (le faisceau disparaît progressivement jusqu'à LASER_MAX_RANGE)
export const LASER_FADE_START = 2000;

export function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
export function lerp(a, b, t) {
    return a + (b - a) * t;
}
