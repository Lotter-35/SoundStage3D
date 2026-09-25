/**
 * laserConstants.js — Constantes du système laser SoundStage3D
 */

// Buffers GPU — par laser individuel (1 pod, max 32 beams)
export const MAX_BEAMS_PER_POD = 32;
export const TOTAL_MAX_BEAMS   = MAX_BEAMS_PER_POD;        // 1 pod par LaserShow
export const TOTAL_MAX_FAN_SEGMENTS = MAX_BEAMS_PER_POD - 1;

// Physique
export const BEAM_DIVERGENCE   = 1.0;
export const ARC_SUBDIVISIONS  = 32;

// Sol + plafond virtuel (remplace Room.js du projet original)
export const SCENE_FLOOR_Y = 0;
export const SCENE_CEILING_Y = 40;
export const SCENE_HALF_SIZE = 200;   // boîte virtuelle (200m de rayon)

export function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}
export function lerp(a, b, t) {
    return a + (b - a) * t;
}
