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

import * as THREE from 'three';

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

    // 3. Garde-corps latéraux des escaliers (rambardes physiques à z = -6.2 et z = -3.8)
    const onLeftStairX = x >= STAIRS_LEFT.minX - 0.2 && x <= STAIRS_LEFT.maxX + 0.2;
    if (onLeftStairX) {
        const stairY = getGroundHeight(x, -5.0);
        if (y >= stairY - 0.2 && y < stairY + 1.15) {
            if (Math.abs(z - STAIRS_LEFT.minZ) < 0.15 + radius || Math.abs(z - STAIRS_LEFT.maxZ) < 0.15 + radius) {
                return true;
            }
        }
    }
    const onRightStairX = x >= STAIRS_RIGHT.minX - 0.2 && x <= STAIRS_RIGHT.maxX + 0.2;
    if (onRightStairX) {
        const stairY = getGroundHeight(x, -5.0);
        if (y >= stairY - 0.2 && y < stairY + 1.15) {
            if (Math.abs(z - STAIRS_RIGHT.minZ) < 0.15 + radius || Math.abs(z - STAIRS_RIGHT.maxZ) < 0.15 + radius) {
                return true;
            }
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

/**
 * Crée et gère la visualisation 3D de l'ensemble des hitboxes de collision de la scène.
 * @param {THREE.Scene} scene
 * @returns {{ group: THREE.Group, toggle: (force?: boolean) => boolean, update: (pos: THREE.Vector3) => void, isVisible: boolean }}
 */
export function createHitboxVisualizer(scene) {
    const group = new THREE.Group();
    group.name = 'hitbox-visualizer';
    group.visible = false;

    // Helper pour créer une boîte de collision colorée translucide avec arêtes nettes
    function addBox(w, h, d, x, y, z, color = 0x00ff88) {
        const subGroup = new THREE.Group();
        const geo = new THREE.BoxGeometry(w, h, d);

        const fillMat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        subGroup.add(new THREE.Mesh(geo, fillMat));

        const edgeGeo = new THREE.EdgesGeometry(geo);
        const lineMat = new THREE.LineBasicMaterial({ color, linewidth: 2 });
        subGroup.add(new THREE.LineSegments(edgeGeo, lineMat));

        subGroup.position.set(x, y, z);
        group.add(subGroup);
        return subGroup;
    }

    // Helper pour créer un cylindre de collision (piliers truss, joueur)
    function addCylinder(r, h, x, y, z, color = 0xff2222) {
        const subGroup = new THREE.Group();
        const geo = new THREE.CylinderGeometry(r, r, h, 16);

        const fillMat = new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            side: THREE.DoubleSide
        });
        subGroup.add(new THREE.Mesh(geo, fillMat));

        const edgeGeo = new THREE.EdgesGeometry(geo);
        const lineMat = new THREE.LineBasicMaterial({ color, linewidth: 2 });
        subGroup.add(new THREE.LineSegments(edgeGeo, lineMat));

        subGroup.position.set(x, y, z);
        group.add(subGroup);
        return subGroup;
    }

    // 1. Plancher scène principale (marchable Y=3.0m - Vert)
    addBox(30.0, 0.1, 10.0, 0, 3.0, -5.0, 0x00ff88);
    // Corps scène (obstacle bloquant Y ∈ [0, 3.0] - Rouge)
    addBox(30.0, 2.9, 10.0, 0, 1.45, -5.0, 0xff3333);

    // 2. Caissons de basse Subs (marchable dessus Y=2.0m - Cyan)
    addBox(20.5, 0.1, 1.0, 0, 2.0, 0.5, 0x00e5ff);
    // Façade subs (obstacle bloquant Y ∈ [0, 2.0] - Orange)
    addBox(20.5, 1.9, 1.0, 0, 0.95, 0.5, 0xff8800);

    // 3. Escaliers (10 marches physiques - Vert)
    const numSteps = 10;
    const runX = 3.8;
    const totalRise = 3.0;
    const stepW = runX / numSteps;
    const stepH = totalRise / numSteps;

    // Escalier gauche (montée vers +X)
    for (let i = 0; i < numSteps; i++) {
        const h = (i + 1) * stepH;
        const x = -18.8 + (i + 0.5) * stepW;
        addBox(stepW, h, 2.4, x, h / 2, -5.0, 0x00ff88);
    }
    // Escalier droit (montée vers -X)
    for (let i = 0; i < numSteps; i++) {
        const h = (i + 1) * stepH;
        const x = 18.8 - (i + 0.5) * stepW;
        addBox(stepW, h, 2.4, x, h / 2, -5.0, 0x00ff88);
    }

    // Rambardes bloquantes des escaliers (Rouge)
    addBox(3.8, 1.2, 0.15, -16.9, 2.0, -3.8, 0xff2222);
    addBox(3.8, 1.2, 0.15, -16.9, 2.0, -6.2, 0xff2222);
    addBox(3.8, 1.2, 0.15,  16.9, 2.0, -3.8, 0xff2222);
    addBox(3.8, 1.2, 0.15,  16.9, 2.0, -6.2, 0xff2222);

    // 4. 4 Piliers truss (cylindres verticaux rayon 0.35m, hauteur 20m - Rouge)
    addCylinder(0.35, 20.0, -17.0, 10.0,   0.0, 0xff2222);
    addCylinder(0.35, 20.0,  17.0, 10.0,   0.0, 0xff2222);
    addCylinder(0.35, 20.0, -17.0, 10.0, -10.0, 0xff2222);
    addCylinder(0.35, 20.0,  17.0, 10.0, -10.0, 0xff2222);

    // 5. Mur de fond de scène (bloquant arrière - Rouge foncé)
    addBox(30.4, 20.0, 0.7, 0, 10.0, -10.05, 0xcc0033);

    // 6. Table régie DJ (bloquant Y ∈ [3.0, 4.3] - Jaune doré)
    addBox(3.8, 1.3, 1.2, 0, 3.65, -5.0, 0xffbb00);

    // 7. Hitbox dynamique du joueur local (Cylindre Magenta fluo)
    const playerHitbox = new THREE.Group();
    playerHitbox.name = 'player-hitbox-marker';
    const pGeo = new THREE.CylinderGeometry(0.35, 0.35, 1.8, 16);
    const pMat = new THREE.MeshBasicMaterial({
        color: 0xff00cc,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        side: THREE.DoubleSide
    });
    playerHitbox.add(new THREE.Mesh(pGeo, pMat));
    playerHitbox.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(pGeo),
        new THREE.LineBasicMaterial({ color: 0xff00ff, linewidth: 2 })
    ));
    group.add(playerHitbox);

    scene.add(group);

    return {
        group,
        toggle(forceState) {
            group.visible = (forceState !== undefined) ? forceState : !group.visible;
            return group.visible;
        },
        update(pos) {
            if (!group.visible || !pos) return;
            playerHitbox.position.set(pos.x, pos.y + 0.9, pos.z);
        },
        get isVisible() {
            return group.visible;
        }
    };
}
