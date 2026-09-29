/**
 * fohTower.js — Tour de régie (échafaudage) derrière le sweet spot FOH.
 *
 * Structure en tubes d'échafaudage, plancher surélevé à 5,4 m, escalier droit de 18 marches
 * à l'arrière, garde-corps, toit, et une table de régie (consoles + écrans) tournée vers la scène.
 * Toutes les dimensions sont exportées dans FOH_TOWER_SOLIDS pour que collision.js utilise
 * EXACTEMENT les mêmes boîtes que les meshes visibles.
 */
import * as THREE from 'three';

// ─── Implantation ─────────────────────────────────────────────────────────────
const CX = 0;              // centré sur l'axe de la scène
const Z0 = 57.5;           // bord avant (côté scène)
const Z1 = 62.5;           // bord arrière (arrivée de l'escalier)
const X0 = CX - 3;
const X1 = CX + 3;
const DECK_Y = 5.4;        // dessus du plancher
const DECK_T = 0.2;        // épaisseur du plancher
const RAIL_H = 1.1;        // garde-corps
const ROOF_Y = DECK_Y + 2.6;
const TUBE = 0.1;          // section des tubes (hitbox) — visuel : Ø 4,8 cm

// Escalier : 18 marches de 0,30 × 0,30 m, 1,2 m de large, qui monte vers la scène (−z)
const NUM_STEPS = 18;
const STEP_RISE = DECK_Y / NUM_STEPS;
const STEP_RUN = 0.3;
const STAIR_X0 = CX + 1.4;
const STAIR_X1 = STAIR_X0 + 1.2;
const STAIR_Z_END = Z1 + NUM_STEPS * STEP_RUN; // pied de l'escalier

// Table de régie (le public regarde vers −z : les techniciens se tiennent côté +z de la table)
const DESK = { x0: CX - 2.2, x1: CX + 2.2, y1: DECK_Y + 0.9, z0: Z0 + 0.6, z1: Z0 + 1.5 };

// Poteaux verticaux (grille 3 × 3 sans poteau central ni avant-milieu : plancher et vue sur la scène dégagés)
const POSTS = [];
for (const x of [X0, CX, X1]) for (const z of [Z0, (Z0 + Z1) / 2, Z1]) {
    if (x !== CX || z === Z1) POSTS.push([x, z]);
}

// ─── Hitboxes (mêmes dimensions que le décor) ────────────────────────────────
/** @type {[string, number, number, number, number, number, number][]} kind, x0, x1, y0, y1, z0, z1 */
export const FOH_TOWER_SOLIDS = [];
{
    const S = (...a) => FOH_TOWER_SOLIDS.push(a);
    const h = TUBE / 2;
    for (const [x, z] of POSTS) S('truss', x - h, x + h, 0, ROOF_Y, z - h, z + h);
    // Plancher
    S('stage', X0, X1, DECK_Y - DECK_T, DECK_Y, Z0, Z1);
    // Garde-corps : avant, gauche, droite, arrière (ouverture pour l'escalier)
    const ry0 = DECK_Y + RAIL_H - 0.08, ry1 = DECK_Y + RAIL_H;
    S('rail', X0, X1, ry0, ry1, Z0 - h, Z0 + h);
    S('rail', X0 - h, X0 + h, ry0, ry1, Z0, Z1);
    S('rail', X1 - h, X1 + h, ry0, ry1, Z0, Z1);
    S('rail', X0, STAIR_X0, ry0, ry1, Z1 - h, Z1 + h);
    S('rail', STAIR_X1, X1, ry0, ry1, Z1 - h, Z1 + h);
    // Table de régie
    S('dj', DESK.x0, DESK.x1, DECK_Y, DESK.y1, DESK.z0, DESK.z1);
    // Marches (pleines jusqu'au sol, comme les escaliers de la scène) + mains courantes
    for (let i = 0; i < NUM_STEPS; i++) {
        const top = (i + 1) * STEP_RISE;
        const za = STAIR_Z_END - i * STEP_RUN;
        const zb = za - STEP_RUN;
        S('step', STAIR_X0, STAIR_X1, 0, top, zb, za);
        S('rail', STAIR_X0 - 0.08, STAIR_X0, top + 0.75, top + 0.85, zb, za);
        S('rail', STAIR_X1, STAIR_X1 + 0.08, top + 0.75, top + 0.85, zb, za);
    }
}

// ─── Visuel ───────────────────────────────────────────────────────────────────
/**
 * @param {THREE.Scene} scene
 * @returns {THREE.Group}
 */
export function createFohTower(scene) {
    const group = new THREE.Group();
    group.name = 'foh-tower';

    const steel = new THREE.MeshStandardMaterial({ color: 0xa9adb2, metalness: 0.75, roughness: 0.38 });
    const redTape = new THREE.MeshStandardMaterial({ color: 0xc0281e, metalness: 0.2, roughness: 0.6 });
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x6d6a64, metalness: 0.5, roughness: 0.7 });
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x121214, metalness: 0.2, roughness: 0.65 });
    const flightMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, metalness: 0.35, roughness: 0.5 });
    const screenMat = new THREE.MeshStandardMaterial({
        color: 0x0a0f14, emissive: 0x3a86c8, emissiveIntensity: 0.9, roughness: 0.3,
    });
    const faderMat = new THREE.MeshStandardMaterial({
        color: 0x111111, emissive: 0x25c46a, emissiveIntensity: 0.6, roughness: 0.4,
    });

    const tubeGeo = new THREE.CylinderGeometry(0.024, 0.024, 1, 8);
    const addMesh = (geo, mat, x, y, z, shadow = true) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.castShadow = shadow;
        m.receiveShadow = true;
        group.add(m);
        return m;
    };
    /** Tube entre deux points */
    const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
    const tube = (x0, y0, z0, x1, y1, z1, mat = steel) => {
        _a.set(x0, y0, z0); _b.set(x1, y1, z1);
        const len = _a.distanceTo(_b);
        const m = addMesh(tubeGeo, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        m.scale.set(1, len, 1);
        m.quaternion.setFromUnitVectors(_up, _b.sub(_a).normalize());
        return m;
    };

    // Poteaux + bagues rouges (repères d'échafaudage) + platines au sol
    const ringGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.08, 8);
    const plateGeo = new THREE.BoxGeometry(0.25, 0.02, 0.25);
    for (const [x, z] of POSTS) {
        tube(x, 0, z, x, ROOF_Y, z);
        addMesh(plateGeo, steel, x, 0.01, z, false);
        for (let y = 1; y < ROOF_Y; y += 2) addMesh(ringGeo, redTape, x, y, z, false);
    }

    // Lisses horizontales tous les 2 m + croisillons en façade et sur les côtés
    const levels = [0.3, 2.0, 3.7, DECK_Y - DECK_T];
    for (const y of levels) {
        for (const z of [Z0, (Z0 + Z1) / 2, Z1]) tube(X0, y, z, X1, y, z);
        for (const x of [X0, CX, X1]) tube(x, y, Z0, x, y, Z1);
    }
    for (const z of [Z0, Z1]) {
        tube(X0, 0.3, z, CX, DECK_Y - DECK_T, z);
        tube(X1, 0.3, z, CX, DECK_Y - DECK_T, z);
    }
    for (const x of [X0, X1]) {
        tube(x, 0.3, Z0, x, DECK_Y - DECK_T, Z1);
        tube(x, 0.3, Z1, x, DECK_Y - DECK_T, Z0);
    }

    // Plancher
    addMesh(new THREE.BoxGeometry(X1 - X0, DECK_T, Z1 - Z0), deckMat, CX, DECK_Y - DECK_T / 2, (Z0 + Z1) / 2);

    // Garde-corps (lisse haute + lisse intermédiaire + plinthe noire)
    const railRun = (x0, z0, x1, z1) => {
        tube(x0, DECK_Y + RAIL_H, z0, x1, DECK_Y + RAIL_H, z1);
        tube(x0, DECK_Y + 0.55, z0, x1, DECK_Y + 0.55, z1);
    };
    railRun(X0, Z0, X1, Z0);
    railRun(X0, Z0, X0, Z1);
    railRun(X1, Z0, X1, Z1);
    railRun(X0, Z1, STAIR_X0, Z1);
    railRun(STAIR_X1, Z1, X1, Z1);
    // Bâche noire sur la façade avant du garde-corps
    addMesh(new THREE.BoxGeometry(X1 - X0, RAIL_H - 0.05, 0.02), blackMat, CX, DECK_Y + (RAIL_H - 0.05) / 2, Z0 - 0.04);

    // Toit (bâche noire tendue sur cadre)
    addMesh(new THREE.BoxGeometry(X1 - X0 + 0.6, 0.06, Z1 - Z0 + 0.6), blackMat, CX, ROOF_Y + 0.03, (Z0 + Z1) / 2);
    for (const z of [Z0, Z1]) tube(X0, ROOF_Y, z, X1, ROOF_Y, z);
    for (const x of [X0, X1]) tube(x, ROOF_Y, Z0, x, ROOF_Y, Z1);

    // Escalier : limons, marches (métal ajouré sombre), mains courantes
    const stepGeo = new THREE.BoxGeometry(STAIR_X1 - STAIR_X0, 0.05, STEP_RUN);
    for (let i = 0; i < NUM_STEPS; i++) {
        const top = (i + 1) * STEP_RISE;
        const zc = STAIR_Z_END - (i + 0.5) * STEP_RUN;
        addMesh(stepGeo, deckMat, (STAIR_X0 + STAIR_X1) / 2, top - 0.025, zc);
    }
    const stringerLen = Math.hypot(DECK_Y, STAIR_Z_END - Z1);
    const stringerGeo = new THREE.BoxGeometry(0.06, 0.25, stringerLen);
    const stringerAngle = Math.atan2(DECK_Y, STAIR_Z_END - Z1);
    for (const x of [STAIR_X0, STAIR_X1]) {
        const s = addMesh(stringerGeo, steel, x, DECK_Y / 2 - 0.1, (Z1 + STAIR_Z_END) / 2);
        s.rotation.x = stringerAngle;
        // Main courante inclinée + poteaux
        tube(x, 0.9, STAIR_Z_END, x, DECK_Y + 0.9, Z1);
        tube(x, 0, STAIR_Z_END, x, 0.9, STAIR_Z_END);
        tube(x, DECK_Y / 2, (Z1 + STAIR_Z_END) / 2, x, DECK_Y / 2 + 0.9, (Z1 + STAIR_Z_END) / 2);
        tube(x, 0, (Z1 + STAIR_Z_END) / 2, x, DECK_Y / 2, (Z1 + STAIR_Z_END) / 2);
    }

    // Table de régie : flight-cases + consoles + écrans tournés vers les techniciens (+z)
    const deskW = DESK.x1 - DESK.x0, deskD = DESK.z1 - DESK.z0, deskZ = (DESK.z0 + DESK.z1) / 2;
    addMesh(new THREE.BoxGeometry(deskW, 0.8, deskD), flightMat, CX, DECK_Y + 0.4, deskZ);
    // Consoles (son à gauche, lumière à droite), plateau incliné vers l'opérateur
    for (const [x, w] of [[CX - 1.1, 1.8], [CX + 1.1, 1.8]]) {
        const console_ = addMesh(new THREE.BoxGeometry(w, 0.1, deskD - 0.1), blackMat, x, DECK_Y + 0.85, deskZ);
        console_.rotation.x = -0.12;
        const faders = addMesh(new THREE.BoxGeometry(w - 0.2, 0.012, 0.25), faderMat, x, DECK_Y + 0.91, deskZ + 0.18, false);
        faders.rotation.x = -0.12;
        // Écrans
        for (const dx of [-0.45, 0.45]) {
            const scr = addMesh(new THREE.BoxGeometry(0.45, 0.26, 0.03), screenMat, x + dx, DECK_Y + 1.0, DESK.z0 + 0.12);
            scr.rotation.x = -0.45;
        }
    }

    // Petits projecteurs sur le toit tournés vers la scène (décor, non allumés)
    const canGeo = new THREE.CylinderGeometry(0.12, 0.16, 0.35, 12);
    for (const x of [X0 + 0.8, CX - 0.6, CX + 0.6, X1 - 0.8]) {
        const c = addMesh(canGeo, blackMat, x, ROOF_Y + 0.25, Z0 - 0.1);
        c.rotation.x = Math.PI / 2 + 0.25;
    }

    scene.add(group);
    return group;
}
