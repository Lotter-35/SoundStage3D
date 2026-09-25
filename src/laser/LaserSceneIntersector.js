/**
 * LaserSceneIntersector.js
 * ─────────────────────────────────────────────────────────────
 * Remplace Room.js du projet LaserSimulation original.
 * Calcule les intersections analytiques des faisceaux laser avec
 * l'environnement SoundStage3D (festival en plein air) :
 * - Sol (y=0) → normal vers le haut (0,1,0) — surface réelle
 * - Murs virtuels (boîte ±200m) — surfaces virtuelles seulement si rayon monte
 * ─────────────────────────────────────────────────────────────
 * OPTIMISÉ : 0 allocation GC par frame (vecteurs pré-alloués statiques).
 */

import * as THREE from 'three';


import { SCENE_FLOOR_Y, SCENE_HALF_SIZE } from './config/laserConstants.js';

// Vecteurs pré-alloués (0 GC par frame)
const _hit    = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _result = { hit: _hit, normal: _normal, isRealSurface: true };

/**
 * Calcule l'intersection d'un rayon (origin + direction) avec la boîte de scène.
 * @param {THREE.Vector3} origin
 * @param {THREE.Vector3} dir (doit être normalisé)
 * @returns {{ hit: THREE.Vector3, normal: THREE.Vector3, isRealSurface: boolean }}
 *   isRealSurface = false quand le faisceau monte dans le ciel et ne touche que les murs virtuels latéraux
 */
export function getSceneHit(origin, dir) {
    let tMin = Infinity;
    let nx = 0, ny = 1, nz = 0;
    let hitsSurface = false; // true = sol ou mur physique dans la direction descendante

    // Sol (y = SCENE_FLOOR_Y) — surface réelle, normal (0,+1,0)
    if (dir.y < -1e-6) {
        const t = (SCENE_FLOOR_Y - origin.y) / dir.y;
        if (t > 1e-4 && t < tMin) { tMin = t; nx = 0; ny = 1; nz = 0; hitsSurface = true; }
    }

    // Mur +X (x = +SCENE_HALF_SIZE) — normal (-1,0,0)
    if (dir.x > 1e-6) {
        const t = (SCENE_HALF_SIZE - origin.x) / dir.x;
        if (t > 1e-4 && t < tMin) { tMin = t; nx = -1; ny = 0; nz = 0; hitsSurface = (dir.y <= 0); }
    }

    // Mur -X (x = -SCENE_HALF_SIZE) — normal (+1,0,0)
    if (dir.x < -1e-6) {
        const t = (-SCENE_HALF_SIZE - origin.x) / dir.x;
        if (t > 1e-4 && t < tMin) { tMin = t; nx = 1; ny = 0; nz = 0; hitsSurface = (dir.y <= 0); }
    }

    // Mur +Z (z = +SCENE_HALF_SIZE) — normal (0,0,-1)
    if (dir.z > 1e-6) {
        const t = (SCENE_HALF_SIZE - origin.z) / dir.z;
        if (t > 1e-4 && t < tMin) { tMin = t; nx = 0; ny = 0; nz = -1; hitsSurface = (dir.y <= 0); }
    }

    // Mur -Z (z = -SCENE_HALF_SIZE) — normal (0,0,+1)
    if (dir.z < -1e-6) {
        const t = (-SCENE_HALF_SIZE - origin.z) / dir.z;
        if (t > 1e-4 && t < tMin) { tMin = t; nx = 0; ny = 0; nz = 1; hitsSurface = (dir.y <= 0); }
    }

    // Fallback — faisceau vertical pur vers le haut (ne touche rien)
    if (!isFinite(tMin)) { tMin = 1000; hitsSurface = false; }

    _hit.set(
        origin.x + dir.x * tMin,
        origin.y + dir.y * tMin,
        origin.z + dir.z * tMin
    );
    _normal.set(nx, ny, nz);
    _result.isRealSurface = hitsSurface;

    return _result;
}
