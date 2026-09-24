/**
 * collision.js — Détection et résolution des collisions de la scène 3D.
 *
 * Géométrie précise de la scène :
 * - Scène principale : X ∈ [-15.0, 15.0], Z ∈ [-10.0, 0.0], hauteur plancher Y = 3.0m
 * - Escalier gauche : X ∈ [-18.8, -15.0], Z ∈ [-6.1, -3.9], montée vers +X (0m -> 3.0m)
 * - Escalier droit  : X ∈ [15.0, 18.8],   Z ∈ [-6.1, -3.9], montée vers -X (0m -> 3.0m)
 * - Piliers truss   : 4 piliers à (±17.0, 0.0) et (±17.0, -10.0), rayon 0.35m
 * - Caissons subs   : façade Z ∈ [-0.9, 1.0], X ∈ [-10.2, 10.2], hauteur 2.1m
 * - Table DJ régie  : centre scène à (0, -5.0), X ∈ [-1.9, 1.9], Z ∈ [-5.6, -4.4], Y ∈ [3.0, 4.3]
 */

export const STAGE_BOUNDS = {
    minX: -15.0,
    maxX:  15.0,
    minZ: -10.0,
    maxZ:   0.0,
    height: 3.0,
};

export const SUBS_BOUNDS = {
    minX: -10.25, // de sub3 à gauche à sub3 à droite
    maxX:  10.25,
    minZ:   0.0,  // bord de la scène
    maxZ:   1.0,  // façade avant des caissons
    height: 2.0,  // dessus des caissons de basse
};

export const STAIRS_LEFT = {
    minX: -18.8, // bas des marches au sol (y = 0)
    maxX: -15.0, // haut des marches sur scène (y = 3)
    minZ:  -6.2,
    maxZ:  -3.8,
};

export const STAIRS_RIGHT = {
    minX:  15.0, // haut des marches sur scène (y = 3)
    maxX:  18.8, // bas des marches au sol (y = 0)
    minZ:  -6.2,
    maxZ:  -3.8,
};

/**
 * Calcule l'altitude du sol (y) à n'importe quelles coordonnées (x, z).
 * @param {number} x
 * @param {number} z
 * @returns {number} altitude du sol en mètres
 */
export function getGroundHeight(x, z) {
    // 1. Plancher de la scène principale (hauteur 3.0m)
    if (x >= STAGE_BOUNDS.minX && x <= STAGE_BOUNDS.maxX &&
        z >= STAGE_BOUNDS.minZ && z <= STAGE_BOUNDS.maxZ) {
        return STAGE_BOUNDS.height; // 3.0m
    }

    // 2. Dessus des caissons de basse (Subs) devant la scène (hauteur 2.0m)
    if (x >= SUBS_BOUNDS.minX && x <= SUBS_BOUNDS.maxX &&
        z >= SUBS_BOUNDS.minZ && z <= SUBS_BOUNDS.maxZ) {
        return SUBS_BOUNDS.height; // 2.0m
    }

    // 3. Escalier gauche : montée le long de +X vers la scène
    if (z >= STAIRS_LEFT.minZ && z <= STAIRS_LEFT.maxZ) {
        if (x >= STAIRS_LEFT.minX && x <= STAIRS_LEFT.maxX) {
            const t = (x - STAIRS_LEFT.minX) / (STAIRS_LEFT.maxX - STAIRS_LEFT.minX);
            return Math.max(0, Math.min(STAGE_BOUNDS.height, t * STAGE_BOUNDS.height));
        }
    }

    // 4. Escalier droit : montée le long de -X vers la scène
    if (z >= STAIRS_RIGHT.minZ && z <= STAIRS_RIGHT.maxZ) {
        if (x >= STAIRS_RIGHT.minX && x <= STAIRS_RIGHT.maxX) {
            const t = (STAIRS_RIGHT.maxX - x) / (STAIRS_RIGHT.maxX - STAIRS_RIGHT.minX);
            return Math.max(0, Math.min(STAGE_BOUNDS.height, t * STAGE_BOUNDS.height));
        }
    }

    // Sol naturel (pelouse)
    return 0.0;
}

/**
 * Vérifie si une position (x, z) est en collision avec un obstacle solide.
 * @param {number} x
 * @param {number} z
 * @param {number} y — altitude actuelle des pieds
 * @param {number} radius — rayon corporel (~0.35m)
 * @returns {boolean}
 */
export function checkSolidObstacle(x, z, y, radius = 0.35) {
    // 1. Mur de fond de scène (bloque toujours à l'arrière à z = -10 pour tout y)
    if (x >= -15.2 && x <= 15.2 && z <= -9.7 + radius && z >= -10.4 - radius) {
        return true;
    }

    // 2. Blocs de la scène pour un joueur au sol ou sur les subs (y < 2.5m)
    if (y < 2.5) {
        if (y >= 1.9 && x >= SUBS_BOUNDS.minX - radius && x <= SUBS_BOUNDS.maxX + radius) {
            // Sur le dessus des subs : la façade de scène à z <= 0.0 empêche de traverser la scène
            if (z <= 0.0) {
                return true;
            }
        } else {
            // Corps de la scène principale depuis le sol
            if (x >= STAGE_BOUNDS.minX - radius && x <= STAGE_BOUNDS.maxX + radius &&
                z >= STAGE_BOUNDS.minZ - radius && z <= STAGE_BOUNDS.maxZ + radius) {

                // Autoriser le passage uniquement par l'ouverture des escaliers
                const atLeftStairs  = (x <= STAGE_BOUNDS.minX + radius && z >= STAIRS_LEFT.minZ && z <= STAIRS_LEFT.maxZ);
                const atRightStairs = (x >= STAGE_BOUNDS.maxX - radius && z >= STAIRS_RIGHT.minZ && z <= STAIRS_RIGHT.maxZ);

                if (!atLeftStairs && !atRightStairs) {
                    return true;
                }
            }
        }
    }

    // 3. Garde-corps latéraux des escaliers (empêche de traverser les rambardes à z = -6.2 et z = -3.8)
    const onLeftStairX = x >= STAIRS_LEFT.minX - 0.2 && x <= STAIRS_LEFT.maxX + 0.2;
    if (onLeftStairX) {
        if (Math.abs(z - STAIRS_LEFT.minZ) < 0.15 + radius || Math.abs(z - STAIRS_LEFT.maxZ) < 0.15 + radius) {
            return true;
        }
    }
    const onRightStairX = x >= STAIRS_RIGHT.minX - 0.2 && x <= STAIRS_RIGHT.maxX + 0.2;
    if (onRightStairX) {
        if (Math.abs(z - STAIRS_RIGHT.minZ) < 0.15 + radius || Math.abs(z - STAIRS_RIGHT.maxZ) < 0.15 + radius) {
            return true;
        }
    }

    // 4. Piliers truss aux 4 coins (cylindres verticaux, rayon 0.35m)
    const pillars = [
        [-17.0, 0.0],
        [ 17.0, 0.0],
        [-17.0, -10.0],
        [ 17.0, -10.0],
    ];
    for (const [px, pz] of pillars) {
        const dx = x - px;
        const dz = z - pz;
        if (dx * dx + dz * dz < (0.35 + radius) * (0.35 + radius)) {
            return true;
        }
    }

    // 5. Caissons de basse (Subs) devant la scène (hauteur 2.0m)
    // Bloque uniquement les joueurs au sol (y < 1.95m)
    if (y < 1.95) {
        if (x >= SUBS_BOUNDS.minX - radius && x <= SUBS_BOUNDS.maxX + radius &&
            z >= -1.0 - radius && z <= SUBS_BOUNDS.maxZ + radius) {
            return true;
        }
    }

    // 6. Table DJ au centre de la scène (hauteur 3.0m à 4.3m)
    if (y >= 2.5 && y <= 4.3) {
        if (x >= -1.9 - radius && x <= 1.9 + radius &&
            z >= -5.6 - radius && z <= -4.4 + radius) {
            return true;
        }
    }

    return false;
}

/**
 * Résout le déplacement d'un joueur avec détection d'obstacles et glissement fluide le long des parois.
 * @param {number} oldX
 * @param {number} oldZ
 * @param {number} newX
 * @param {number} newZ
 * @param {number} currentY — hauteur actuelle des pieds
 * @param {boolean} [isFlying=false]
 * @param {number} [radius=0.35]
 * @returns {{ x: number, z: number }} position résolue
 */
export function resolveCollision(oldX, oldZ, newX, newZ, currentY, isFlying = false, radius = 0.35) {
    if (isFlying) {
        // En mode vol, seul le mur de fond et la table DJ bloquent si on est à leur hauteur
        if (checkSolidObstacle(newX, newZ, currentY, radius)) {
            if (!checkSolidObstacle(newX, oldZ, currentY, radius)) return { x: newX, z: oldZ };
            if (!checkSolidObstacle(oldX, newZ, currentY, radius)) return { x: oldX, z: newZ };
            return { x: oldX, z: oldZ };
        }
        return { x: newX, z: newZ };
    }

    // Hauteur de marche franchissable (0.45m max, permet de monter les marches de 0.30m)
    const maxStep = 0.45;

    // 1. Test du déplacement direct
    const nextGroundY = getGroundHeight(newX, newZ);
    const stepTooHigh = (nextGroundY > currentY + maxStep) && currentY < 2.5;

    if (!stepTooHigh && !checkSolidObstacle(newX, newZ, currentY, radius)) {
        return { x: newX, z: newZ };
    }

    // 2. Glissement le long de l'axe X (avance en X, annule dZ)
    const groundX = getGroundHeight(newX, oldZ);
    const stepTooHighX = (groundX > currentY + maxStep) && currentY < 2.5;
    if (!stepTooHighX && !checkSolidObstacle(newX, oldZ, currentY, radius)) {
        return { x: newX, z: oldZ };
    }

    // 3. Glissement le long de l'axe Z (avance en Z, annule dX)
    const groundZ = getGroundHeight(oldX, newZ);
    const stepTooHighZ = (groundZ > currentY + maxStep) && currentY < 2.5;
    if (!stepTooHighZ && !checkSolidObstacle(oldX, newZ, currentY, radius)) {
        return { x: oldX, z: newZ };
    }

    // 4. Bloqué sur les deux axes
    return { x: oldX, z: oldZ };
}
