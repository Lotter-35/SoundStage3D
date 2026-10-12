/**
 * collision.js — Collisions de la scène 3D et visualisation des hitboxes.
 *
 * Toutes les hitboxes sont des boîtes alignées sur les axes (AABB) qui reprennent EXACTEMENT
 * les dimensions des objets 3D visibles (stage.js, speakerModels.js). La même liste SOLIDS sert
 * à la fois à la physique et à l'affichage (touche H), donc les deux ne peuvent plus diverger.
 * Aucune hitbox n'existe sans objet visible correspondant.
 *
 * Modèle : le joueur est un cylindre (rayon PLAYER_RADIUS, hauteur PLAYER_HEIGHT).
 * - Un solide dont le dessus est à moins de MAX_STEP au-dessus des pieds se monte (marche, bord de scène).
 * - Sinon il bloque, tant qu'il chevauche la hauteur du corps.
 * - Le sol sous le joueur = dessus du solide le plus haut qui se monte, sinon la pelouse (y = 0).
 */

import * as THREE from 'three';
import { FOH_TOWER_SOLIDS } from './fohTower.js?v=1';

export const PLAYER_RADIUS = 0.22;  // corps ~0.44 m de large : permet de se coller aux caissons et à la table
export const PLAYER_HEIGHT = 1.8;
const MAX_STEP = 0.45;              // franchit les marches de 0.30 m
const EPS = 1e-3;

// ─── Définition des solides (dimensions du décor réel) ────────────────────────
/** @type {{kind:string,x0:number,x1:number,y0:number,y1:number,z0:number,z1:number}[]} */
const SOLIDS = [];

function addSolid(kind, x0, x1, y0, y1, z0, z1) {
    SOLIDS.push({ kind, x0, x1, y0, y1, z0, z1 });
}

// Scène : BoxGeometry(30, 3, 10) en (0, 1.5, -5)
addSolid('stage', -15, 15, 0, 3, -10, 0);

// Mur de fond : BoxGeometry(30, 20, 1.5) en (0, 10, -10.75)
addSolid('wall', -15, 15, 0, 20, -11.5, -9.95);

// Toit : BoxGeometry(34, 0.3, 14) en (0, 20, -3)
addSolid('roof', -17, 17, 19.85, 20.15, -10, 4);

// Poteaux de truss : BoxGeometry(0.4, 20, 0.4) aux 4 coins
for (const x of [-17, 17]) {
    for (const z of [0, -10]) {
        addSolid('truss', x - 0.2, x + 0.2, 0, 20, z - 0.2, z + 0.2);
    }
}

// Caissons de basse : 7 piles de 3 (subwoofer.glb ×1.35), 1.824 × 2.282 × 0.971 m, dos contre la scène (z 0 → 0.971)
// Il y a ~1.18 m entre deux piles : on peut s'y glisser, comme visuellement.
const SUB_HALF_X = 0.912;
const SUB_STACK_HEIGHT = 3 * 0.7608;
const SUB_DEPTH = 0.971;
for (const x of [-9, -6, -3, 0, 3, 6, 9]) {
    addSolid('sub', x - SUB_HALF_X, x + SUB_HALF_X, 0, SUB_STACK_HEIGHT, 0, SUB_DEPTH);
}

// Table DJ : BoxGeometry(3.6, 0.95, 1.0) posée sur la scène en (0, 3.475, -5)
addSolid('dj', -1.8, 1.8, 3.0, 3.95, -5.5, -4.5);

// Line arrays suspendus (line-array.glb ×1.35, bas à y = 8) : ±12 m, 1.28 m de large, z ∈ [-1.109, 0.154]
for (const x of [-12, 12]) {
    addSolid('array', x - 0.641, x + 0.641, 8.0, 13.916, -1.109, 0.154);
}

// Escaliers : 10 marches de 0.38 m × 0.30 m, 2.4 m de large (z ∈ [-6.2, -3.8]), de x = ±18.8 (sol) à ±15 (scène)
const NUM_STEPS = 10;
const STEP_RUN = 3.8 / NUM_STEPS;
const STEP_RISE = 3.0 / NUM_STEPS;
for (const side of [-1, 1]) {
    for (let i = 0; i < NUM_STEPS; i++) {
        const top = (i + 1) * STEP_RISE;
        const xa = side * (18.8 - i * STEP_RUN);
        const xb = side * (18.8 - (i + 1) * STEP_RUN);
        const x0 = Math.min(xa, xb);
        const x1 = Math.max(xa, xb);
        addSolid('step', x0, x1, 0, top, -6.2, -3.8);

        // Main courante (barre visible à ~0.8 m au-dessus de la marche), de chaque côté
        addSolid('rail', x0, x1, top + 0.75, top + 0.85, -6.24, -6.16);
        addSolid('rail', x0, x1, top + 0.75, top + 0.85, -3.84, -3.76);
    }
}

// Tour de régie derrière le FOH (fohTower.js)
for (const s of FOH_TOWER_SOLIDS) addSolid(...s);

// ─── Requêtes ─────────────────────────────────────────────────────────────────

/**
 * Altitude du sol sous (x, z) pour un joueur dont les pieds sont à `y`.
 * @param {number} x
 * @param {number} z
 * @param {number} [y=0] — altitude actuelle des pieds
 * @returns {number}
 */
export function getGroundHeight(x, z, y = 0) {
    let ground = 0;
    const limit = y + MAX_STEP + EPS;
    for (let i = 0; i < SOLIDS.length; i++) {
        const s = SOLIDS[i];
        if (s.y1 > ground && s.y1 <= limit &&
            x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1) {
            ground = s.y1;
        }
    }
    return ground;
}

/**
 * Vrai si le cylindre du joueur en (x, z), pieds à `y`, heurte un solide.
 * @param {number} x
 * @param {number} z
 * @param {number} y — altitude des pieds
 * @param {number} [radius]
 * @returns {boolean}
 */
export function checkSolidObstacle(x, z, y, radius = PLAYER_RADIUS) {
    const head = y + PLAYER_HEIGHT;
    const r2 = radius * radius;
    for (let i = 0; i < SOLIDS.length; i++) {
        const s = SOLIDS[i];
        if (s.y1 <= y + MAX_STEP) continue; // sous les pieds ou marche franchissable
        if (s.y0 >= head) continue;         // au-dessus de la tête
        const dx = x - Math.max(s.x0, Math.min(x, s.x1));
        const dz = z - Math.max(s.z0, Math.min(z, s.z1));
        if (dx * dx + dz * dz < r2) return true;
    }
    return false;
}

/**
 * Résout un déplacement avec glissement le long des parois.
 * Le déplacement est découpé en petits pas pour ne jamais traverser un obstacle mince (main courante).
 * @param {number} oldX
 * @param {number} oldZ
 * @param {number} newX
 * @param {number} newZ
 * @param {number} currentY — altitude des pieds
 * @param {boolean} [isFlying=false]
 * @param {number} [radius]
 * @returns {{ x: number, z: number }}
 */
export function resolveCollision(oldX, oldZ, newX, newZ, currentY, isFlying = false, radius = PLAYER_RADIUS) {
    // Déjà coincé dans un solide (téléportation, changement de rayon…) : on laisse sortir librement
    if (checkSolidObstacle(oldX, oldZ, currentY, radius)) {
        return { x: newX, z: newZ };
    }

    const dist = Math.hypot(newX - oldX, newZ - oldZ);
    const steps = Math.max(1, Math.ceil(dist / 0.15));
    const sx = (newX - oldX) / steps;
    const sz = (newZ - oldZ) / steps;

    let x = oldX;
    let z = oldZ;
    for (let i = 0; i < steps; i++) {
        const tx = x + sx;
        const tz = z + sz;
        if (!checkSolidObstacle(tx, tz, currentY, radius)) {
            x = tx; z = tz;
        } else if (!checkSolidObstacle(tx, z, currentY, radius)) {
            x = tx;
        } else if (!checkSolidObstacle(x, tz, currentY, radius)) {
            z = tz;
        } else {
            break;
        }
    }
    return { x, z };
}

// ─── Visualisation (touche H / bouton Hitbox) ─────────────────────────────────

const KIND_COLORS = {
    stage: 0xff3333,
    wall:  0xcc0033,
    roof:  0xcc0033,
    truss: 0xff2222,
    sub:   0xff8800,
    dj:    0xffbb00,
    array: 0xff8800,
    step:  0x00ff88,
    rail:  0xff2222,
};

/**
 * Crée l'affichage 3D des hitboxes, généré depuis la liste SOLIDS (donc fidèle à la physique).
 * @param {THREE.Scene} scene
 * @returns {{ group: THREE.Group, toggle: (force?: boolean) => boolean, update: (pos: THREE.Vector3) => void, isVisible: boolean }}
 */
export function createHitboxVisualizer(scene) {
    const group = new THREE.Group();
    group.name = 'hitbox-visualizer';
    group.visible = false;

    const fillMats = {};
    const lineMats = {};
    for (const [kind, color] of Object.entries(KIND_COLORS)) {
        fillMats[kind] = new THREE.MeshBasicMaterial({
            color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide,
        });
        lineMats[kind] = new THREE.LineBasicMaterial({ color });
    }

    for (const s of SOLIDS) {
        const geo = new THREE.BoxGeometry(s.x1 - s.x0, s.y1 - s.y0, s.z1 - s.z0);
        const sub = new THREE.Group();
        sub.add(new THREE.Mesh(geo, fillMats[s.kind]));
        sub.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), lineMats[s.kind]));
        sub.position.set((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2, (s.z0 + s.z1) / 2);
        group.add(sub);
    }

    // Hitbox dynamique du joueur local (cylindre magenta)
    const playerHitbox = new THREE.Group();
    playerHitbox.name = 'player-hitbox-marker';
    const pGeo = new THREE.CylinderGeometry(PLAYER_RADIUS, PLAYER_RADIUS, PLAYER_HEIGHT, 16);
    playerHitbox.add(new THREE.Mesh(pGeo, new THREE.MeshBasicMaterial({
        color: 0xff00cc, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide,
    })));
    playerHitbox.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(pGeo),
        new THREE.LineBasicMaterial({ color: 0xff00ff })
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
            playerHitbox.position.set(pos.x, pos.y + PLAYER_HEIGHT / 2, pos.z);
        },
        get isVisible() {
            return group.visible;
        }
    };
}
