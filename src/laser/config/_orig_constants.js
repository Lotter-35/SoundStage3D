/**
 * constants.js
 * ─────────────────────────────────────────────────────────────
 * Source de vérité unique pour toutes les constantes physiques,
 * géométriques et GPU du Laser Show.
 * Importé par Room, SceneSetup, LaserRenderer, etc.
 * ─────────────────────────────────────────────────────────────
 */

// ── Dimensions de la pièce 3D (mètres)
export const ROOM_W = 50;
export const ROOM_H = 40;
export const ROOM_D = 100;
export const HALF_W = ROOM_W / 2;
export const HALF_H = ROOM_H / 2;
export const HALF_D = ROOM_D / 2;

// ── Capacités des buffers GPU (limites maximales allouées une seule fois)
export const MAX_PODS          = 12;
export const MAX_BEAMS_PER_POD = 64;
export const TOTAL_MAX_BEAMS   = MAX_PODS * MAX_BEAMS_PER_POD;
export const TOTAL_MAX_FAN_SEGMENTS = MAX_PODS * (MAX_BEAMS_PER_POD - 1);

// ── Physique laser
/** Divergence angulaire du faisceau — élargissement physique avec la distance */
export const BEAM_DIVERGENCE = 1.0;

/**
 * Subdivisions de l'arc galvanomètre.
 * Chaque intervalle angulaire entre deux traits est subdivisé en N sous-arcs.
 * ARC_SUBDIVISIONS est le maximum autorisé par intervalle (mode horizontal).
 * En mode courbe, la densité est calculée dynamiquement selon la fréquence.
 * À 64 subs : ~0.8° par segment à spread 50° → sinus parfaitement lisse.
 */
export const ARC_SUBDIVISIONS = 64;

// ── Utilitaires mathématiques
/** Clamp v dans [min, max] */
export function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

/** Interpolation linéaire entre a et b par t ∈ [0, 1] */
export function lerp(a, b, t) {
    return a + (b - a) * t;
}
