/**
 * laserConstants.js — Constantes du système laser SoundStage3D
 */

// Taille initiale des pools de faisceaux (extensibles : jusqu'à plusieurs centaines par laser,
// les buffers GPU sont partagés et redimensionnés automatiquement par le LaserBatch)
export const MAX_BEAMS_PER_POD = 32;

// Physique
export const BEAM_DIVERGENCE   = 1.0;

// Profil de largeur des faisceaux : très fin à la sortie de la buse, puis s'épaissit.
// facteur = mix(START, 1, smoothstep(0, NARROW_DIST, d)) × (1 + min(d, GROWTH_MAX_DIST) × GROWTH)
export const BEAM_START_SCALE     = 0.15;  // largeur relative à la sortie de la buse
export const BEAM_NARROW_DIST     = 20;    // distance (m) où le faisceau atteint sa largeur nominale
export const BEAM_GROWTH          = 0.02;  // élargissement par mètre ensuite
export const BEAM_GROWTH_MAX_DIST = 150;   // au-delà, plus d'élargissement (×4 max)
export function beamSpread(dist) {
    const d = Math.max(dist, 0);
    const t = Math.min(d / BEAM_NARROW_DIST, 1);
    const s = t * t * (3 - 2 * t);
    return (BEAM_START_SCALE + (1 - BEAM_START_SCALE) * s) * (1 + Math.min(d, BEAM_GROWTH_MAX_DIST) * BEAM_GROWTH * BEAM_DIVERGENCE);
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
