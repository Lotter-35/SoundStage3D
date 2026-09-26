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

// ── Boîtes AABB des obstacles physiques de la scène ─────────────────────────
const STAGE_OBSTACLES = [
    // 1. Plateforme de scène (largeur 30m, hauteur 3m, profondeur 10m centrée en z=-5)
    { minX: -15.0, minY: 0.0,   minZ: -10.0, maxX: 15.0, maxY: 3.0,   maxZ: 0.0 },
    // 2. Toit de scène (largeur 34m, épaisseur 0.3m, profondeur 14m)
    { minX: -17.0, minY: 19.8,  minZ: -10.0, maxX: 17.0, maxY: 20.2,  maxZ: 4.0 },
    // 3. Régie DJ (table + decks)
    { minX: -1.9,  minY: 3.0,   minZ: -5.6,  maxX: 1.9,  maxY: 4.15,  maxZ: -4.4 },
    // 4. Piliers métalliques gauche & droite
    { minX: -17.3, minY: 0.0,   minZ: -0.3,  maxX: -16.7, maxY: 20.0, maxZ: 0.3 },
    { minX: 16.7,  minY: 0.0,   minZ: -0.3,  maxX: 17.3,  maxY: 20.0, maxZ: 0.3 },
    { minX: -17.3, minY: 0.0,   minZ: -10.3, maxX: -16.7, maxY: 20.0, maxZ: -9.7 },
    { minX: 16.7,  minY: 0.0,   minZ: -10.3, maxX: 17.3,  maxY: 20.0, maxZ: -9.7 },
    // 5. Blocs de subwoofers en façade
    { minX: -13.0, minY: 0.0,   minZ: 0.0,   maxX: 13.0,  maxY: 2.1,   maxZ: 2.2 },
    // 6. Line arrays suspendus gauche & droite
    { minX: -17.5, minY: 4.0,   minZ: -1.8,  maxX: -15.5, maxY: 18.0,  maxZ: 0.2 },
    { minX: 15.5,  minY: 4.0,   minZ: -1.8,  maxX: 17.5,  maxY: 18.0,  maxZ: 0.2 },
];

/**
 * Test analytique rapide d'intersection rayon / boîte AABB (0 allocation)
 */
function intersectBox(origin, dir, box) {
    let tNear = -Infinity;
    let tFar = Infinity;
    let normX = 0, normY = 0, normZ = 0;

    // X
    if (Math.abs(dir.x) > 1e-6) {
        let t1 = (box.minX - origin.x) / dir.x;
        let t2 = (box.maxX - origin.x) / dir.x;
        let n1 = -1, n2 = 1;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; n1 = 1; n2 = -1; }
        if (t1 > tNear) { tNear = t1; normX = n1; normY = 0; normZ = 0; }
        if (t2 < tFar) tFar = t2;
        if (tNear > tFar || tFar < 0.001) return null;
    } else if (origin.x < box.minX || origin.x > box.maxX) {
        return null;
    }

    // Y
    if (Math.abs(dir.y) > 1e-6) {
        let t1 = (box.minY - origin.y) / dir.y;
        let t2 = (box.maxY - origin.y) / dir.y;
        let n1 = -1, n2 = 1;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; n1 = 1; n2 = -1; }
        if (t1 > tNear) { tNear = t1; normX = 0; normY = n1; normZ = 0; }
        if (t2 < tFar) tFar = t2;
        if (tNear > tFar || tFar < 0.001) return null;
    } else if (origin.y < box.minY || origin.y > box.maxY) {
        return null;
    }

    // Z
    if (Math.abs(dir.z) > 1e-6) {
        let t1 = (box.minZ - origin.z) / dir.z;
        let t2 = (box.maxZ - origin.z) / dir.z;
        let n1 = -1, n2 = 1;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; n1 = 1; n2 = -1; }
        if (t1 > tNear) { tNear = t1; normX = 0; normY = 0; normZ = n1; }
        if (t2 < tFar) tFar = t2;
        if (tNear > tFar || tFar < 0.001) return null;
    } else if (origin.z < box.minZ || origin.z > box.maxZ) {
        return null;
    }

    if (tNear < 0.001) return null; // Ne bloque pas si le rayon démarre à l'intérieur
    return { t: tNear, nx: normX, ny: normY, nz: normZ };
}
const OPEN_AIR_MAX_DISTANCE = 500;

/**
 * Calcule l'intersection d'un rayon (origin + direction) avec l'environnement :
 * sol du festival, obstacles physiques réels de la scène, ou espace ouvert (ciel/lointain).
 * Aucun mur virtuel plat n'est imposé : les faisceaux en plein air s'étendent naturellement.
 * @param {THREE.Vector3} origin
 * @param {THREE.Vector3} dir (doit être normalisé)
 * @returns {{ hit: THREE.Vector3, normal: THREE.Vector3, isRealSurface: boolean }}
 */
export function getSceneHit(origin, dir) {
    let tMin = Infinity;
    let nx = 0, ny = 1, nz = 0;
    let hitsSurface = false; // true = surface physique réelle

    // 1. Test des obstacles physiques réels de la scène (plateforme, régie DJ, piliers, subs, line arrays)
    for (let i = 0; i < STAGE_OBSTACLES.length; i++) {
        const hit = intersectBox(origin, dir, STAGE_OBSTACLES[i]);
        if (hit && hit.t < tMin) {
            tMin = hit.t;
            nx = hit.nx;
            ny = hit.ny;
            nz = hit.nz;
            hitsSurface = true;
        }
    }

    // 2. Sol extérieur (y = SCENE_FLOOR_Y = 0) — surface réelle dans l'enceinte du festival
    if (dir.y < -1e-6) {
        const t = (SCENE_FLOOR_Y - origin.y) / dir.y;
        if (t > 1e-4 && t < tMin) {
            const hx = origin.x + dir.x * t;
            const hz = origin.z + dir.z * t;
            // Point d'impact réel sur le sol du festival
            if (Math.abs(hx) <= SCENE_HALF_SIZE && Math.abs(hz) <= SCENE_HALF_SIZE) {
                tMin = t;
                nx = 0;
                ny = 1;
                nz = 0;
                hitsSurface = true;
            }
        }
    }

    // 3. Espace ouvert en plein air (ciel, arrière-scène ouverte, horizon) :
    // Portée maximale naturelle sans coupure brutale sur des murs invisibles
    if (!isFinite(tMin) || tMin > OPEN_AIR_MAX_DISTANCE) {
        tMin = OPEN_AIR_MAX_DISTANCE;
        hitsSurface = false;
        nx = 0;
        ny = 1;
        nz = 0;
    }

    _hit.set(
        origin.x + dir.x * tMin,
        origin.y + dir.y * tMin,
        origin.z + dir.z * tMin
    );
    _normal.set(nx, ny, nz);
    _result.isRealSurface = hitsSurface;

    return _result;
}
