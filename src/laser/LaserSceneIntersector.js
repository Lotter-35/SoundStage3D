/**
 * LaserSceneIntersector.js
 * ─────────────────────────────────────────────────────────────
 * Remplace Room.js du projet LaserSimulation original.
 * Calcule les intersections analytiques des faisceaux laser avec
 * l'environnement SoundStage3D (festival en plein air) :
 * - Sol (y=0) → normal vers le haut (0,1,0) — surface réelle
 * - Murs virtuels (boîte ±200m) — surfaces virtuelles seulement si rayon monte
 * ─────────────────────────────────────────────────────────────
 * OPTIMISÉ : 0 allocation GC par frame (vecteurs et résultats pré-alloués),
 * pré-filtrage des obstacles par éventail laser (collectFanObstacles).
 */

import * as THREE from 'three';


import { SCENE_FLOOR_Y, SCENE_HALF_SIZE, LASER_MAX_RANGE } from './config/laserConstants.js';

// Vecteurs pré-alloués (0 GC par frame)
const _hit    = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _result = { hit: _hit, normal: _normal, isRealSurface: true };

// ── Boîtes AABB des obstacles physiques de la scène ─────────────────────────
// Dimensions calibrées au centimètre près sur les meshes 3D réels de stage.js
const STAGE_OBSTACLES = [
    // 1. Plateforme de scène (largeur 30m [-15, 15], hauteur 3m [0, 3], profondeur 10m [-10, 0])
    { minX: -15.0, minY: 0.0, minZ: -10.0, maxX: 15.0, maxY: 3.0, maxZ: 0.0 },

    // 2. Mur de fond de scène (largeur 30m [-15, 15], hauteur 20m [0, 20], profondeur 1.5m [-11.5, -10.0])
    { minX: -15.0, minY: 0.0, minZ: -11.5, maxX: 15.0, maxY: 20.0, maxZ: -10.0 },

    // 3. Toit de scène (largeur 34m [-17, 17], épaisseur 0.3m [19.85, 20.15], profondeur 14m [-10, 4])
    { minX: -17.0, minY: 19.85, minZ: -10.0, maxX: 17.0, maxY: 20.15, maxZ: 4.0 },

    // 4. Régie DJ (table + decks centrés en x=0, z=-5, y=[3.0, 4.15])
    { minX: -1.8, minY: 3.0, minZ: -5.5, maxX: 1.8, maxY: 4.15, maxZ: -4.5 },

    // 5. Les 4 Piliers métalliques verticaux (BoxGeometry 0.4 x 20 x 0.4, centrage exact)
    // Pilier avant gauche (x=-17, z=0, largeur exacte 0.4m : [-17.2, -16.8], profondeur 0.4m : [-0.2, 0.2])
    { minX: -17.2, minY: 0.0, minZ: -0.2, maxX: -16.8, maxY: 20.0, maxZ: 0.2, isPillar: true },
    // Pilier avant droit (x=+17, z=0, largeur exacte 0.4m : [16.8, 17.2], profondeur 0.4m : [-0.2, 0.2])
    { minX: 16.8, minY: 0.0, minZ: -0.2, maxX: 17.2, maxY: 20.0, maxZ: 0.2, isPillar: true },
    // Pilier arrière gauche (x=-17, z=-10, largeur exacte 0.4m : [-17.2, -16.8], profondeur 0.4m : [-10.2, -9.8])
    { minX: -17.2, minY: 0.0, minZ: -10.2, maxX: -16.8, maxY: 20.0, maxZ: -9.8, isPillar: true },
    // Pilier arrière droit (x=+17, z=-10, largeur exacte 0.4m : [16.8, 17.2], profondeur 0.4m : [-10.2, -9.8])
    { minX: 16.8, minY: 0.0, minZ: -10.2, maxX: 17.2, maxY: 20.0, maxZ: -9.8, isPillar: true },

    // 6. Blocs de subwoofers en façade (7 caissons de x=-9 à +9, largeur réelle [-10.3, 10.3], hauteur 2m, z=[-1.0, 1.05])
    { minX: -10.3, minY: 0.0, minZ: -1.0, maxX: 10.3, maxY: 2.05, maxZ: 1.05 },

    // 7. Grappes Line Array suspendues (réellement situées à x=±12m, suspendues entre y=8 et 12.5)
    { minX: -12.6, minY: 8.0, minZ: -0.5, maxX: -11.4, maxY: 12.5, maxZ: 0.5 },
    { minX: 11.4, minY: 8.0, minZ: -0.5, maxX: 12.6, maxY: 12.5, maxZ: 0.5 },
];

// Résultat partagé du test rayon / boîte (0 allocation)
const _boxHit = { t: 0, nx: 0, ny: 0, nz: 0 };

/**
 * Test analytique rapide d'intersection rayon / boîte AABB (0 allocation).
 * @returns {boolean} true si impact (résultat dans _boxHit)
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
        if (tNear > tFar || tFar < 0.001) return false;
    } else if (origin.x < box.minX || origin.x > box.maxX) {
        return false;
    }

    // Y
    if (Math.abs(dir.y) > 1e-6) {
        let t1 = (box.minY - origin.y) / dir.y;
        let t2 = (box.maxY - origin.y) / dir.y;
        let n1 = -1, n2 = 1;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; n1 = 1; n2 = -1; }
        if (t1 > tNear) { tNear = t1; normX = 0; normY = n1; normZ = 0; }
        if (t2 < tFar) tFar = t2;
        if (tNear > tFar || tFar < 0.001) return false;
    } else if (origin.y < box.minY || origin.y > box.maxY) {
        return false;
    }

    // Z
    if (Math.abs(dir.z) > 1e-6) {
        let t1 = (box.minZ - origin.z) / dir.z;
        let t2 = (box.maxZ - origin.z) / dir.z;
        let n1 = -1, n2 = 1;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; n1 = 1; n2 = -1; }
        if (t1 > tNear) { tNear = t1; normX = 0; normY = 0; normZ = n1; }
        if (t2 < tFar) tFar = t2;
        if (tNear > tFar || tFar < 0.001) return false;
    } else if (origin.z < box.minZ || origin.z > box.maxZ) {
        return false;
    }

    if (tNear < 0.001) return false; // Ne bloque pas si le rayon démarre à l'intérieur

    // Si c'est un pilier et que l'intersection se fait sur une face latérale (normX !== 0)
    // alors que le rayon se propage principalement selon l'axe longitudinal Z :
    // le rayon passe à côté du pilier et ne doit pas s'accrocher sur l'épaisseur du flanc.
    if (box.isPillar && normX !== 0 && Math.abs(dir.z) > Math.abs(dir.x) * 0.4) {
        return false;
    }

    _boxHit.t = tNear;
    _boxHit.nx = normX;
    _boxHit.ny = normY;
    _boxHit.nz = normZ;
    return true;
}

// ── Pré-filtrage des obstacles par laser (calculé 1 fois par frame et par laser) ──
// Liste active des obstacles potentiellement touchés par l'éventail courant.
let _activeObstacles = null;      // Int32Array | null (null = tous les obstacles)
let _activeObstacleCount = 0;

/**
 * Détermine quels obstacles de la scène peuvent être touchés par un éventail laser
 * plan (rayons issus de `origin`, contenus dans le plan de normale `planeNormal`,
 * orientés vers l'avant `forward`). Test conservatif : on ne rejette une boîte que si
 * elle est entièrement d'un côté du plan (au-delà de `slab`) ou entièrement derrière.
 * @param {Int32Array} out Tableau de sortie (taille >= nombre d'obstacles)
 * @returns {number} nombre d'obstacles retenus
 */
export function collectFanObstacles(origin, planeNormal, forward, slab, out) {
    let count = 0;
    const nx = planeNormal.x, ny = planeNormal.y, nz = planeNormal.z;
    const fx = forward.x, fy = forward.y, fz = forward.z;
    for (let i = 0; i < STAGE_OBSTACLES.length; i++) {
        const b = STAGE_OBSTACLES[i];
        let minD = Infinity, maxD = -Infinity, maxF = -Infinity;
        for (let c = 0; c < 8; c++) {
            const x = ((c & 1) ? b.maxX : b.minX) - origin.x;
            const y = ((c & 2) ? b.maxY : b.minY) - origin.y;
            const z = ((c & 4) ? b.maxZ : b.minZ) - origin.z;
            const d = x * nx + y * ny + z * nz;
            if (d < minD) minD = d;
            if (d > maxD) maxD = d;
            const f = x * fx + y * fy + z * fz;
            if (f > maxF) maxF = f;
        }
        if (minD > slab || maxD < -slab) continue; // boîte entièrement hors du plan
        if (maxF < 0) continue;                     // boîte entièrement derrière le laser
        out[count++] = i;
    }
    return count;
}

/**
 * Restreint les tests d'obstacles de getSceneHit() à une liste (null = tous).
 */
export function setActiveObstacles(list, count) {
    _activeObstacles = list;
    _activeObstacleCount = count;
}
const OPEN_AIR_MAX_DISTANCE = LASER_MAX_RANGE;

let _playerCollider = null;
const _playerHit = { t: Infinity, nx: 0, ny: 0, nz: 0 };

export const STAGE_OBSTACLE_COUNT = STAGE_OBSTACLES.length;

export function registerPlayerCollider(collider) {
    _playerCollider = collider;
}

/**
 * true si au moins un joueur (local ou distant) peut intercepter les lasers cette frame
 */
export function hasActivePlayers() {
    return Boolean(_playerCollider && _playerCollider.enabled !== false &&
        _playerCollider._activeColliders && _playerCollider._activeColliders.length > 0);
}

/**
 * Teste si un joueur actif peut se trouver dans le secteur angulaire dirA -> dirB
 * @param {THREE.Vector3} origin
 * @param {THREE.Vector3} dirA
 * @param {THREE.Vector3} dirB
 * @param {number} maxDist
 * @returns {boolean}
 */
export function isPlayerInWedge(origin, dirA, dirB, maxDist = 65) {
    if (!_playerCollider) return false;
    return _playerCollider.isPlayerInWedge(origin, dirA, dirB, maxDist);
}

/**
 * Calcule l'intersection d'un rayon (origin + direction) avec l'environnement :
 * sol du festival, obstacles physiques réels de la scène, joueurs 3D, ou espace ouvert (ciel/lointain).
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
    //    Restreint aux obstacles pré-filtrés pour l'éventail courant si une liste est active.
    const list = _activeObstacles;
    const nObs = list ? _activeObstacleCount : STAGE_OBSTACLES.length;
    for (let k = 0; k < nObs; k++) {
        const box = STAGE_OBSTACLES[list ? list[k] : k];
        if (intersectBox(origin, dir, box) && _boxHit.t < tMin) {
            tMin = _boxHit.t;
            nx = _boxHit.nx;
            ny = _boxHit.ny;
            nz = _boxHit.nz;
            hitsSurface = true;
        }
    }

    // 2. Test des joueurs (modèles 3D dynamiques temps réel — local et multijoueur)
    if (_playerCollider && _playerCollider.enabled !== false) {
        if (_playerCollider.intersectRay(origin, dir, tMin, _playerHit)) {
            tMin = _playerHit.t;
            nx = _playerHit.nx;
            ny = _playerHit.ny;
            nz = _playerHit.nz;
            hitsSurface = true;
        }
    }

    // 3. Sol extérieur (y = SCENE_FLOOR_Y = 0) — surface réelle dans l'enceinte du festival
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
