/**
 * Laser2Collision.js
 * ─────────────────────────────────────────────────────────────
 * Impacts des nouveaux lasers sur la scène (tests analytiques, 0 allocation) :
 *   - obstacles de la scène (plateau, mur, toit, piliers, subs, line arrays, régie DJ)
 *   - tour régie FOH (poteaux, plancher, table, marches, garde-corps)
 *   - sol, joueurs (capsules du squelette, local et multijoueur)
 *
 * Chaque impact porte un identifiant de SURFACE (sol, face d'une boîte, joueur, ciel) :
 * une nappe dont les deux bords touchent la même face plane se coupe exactement par un segment ;
 * sinon elle est subdivisée à la frontière (voir Laser2Fixture).
 *
 * Pré-filtrage : chaque laser ne teste que les boîtes qui peuvent entrer dans son cône de balayage
 * (calculé quand il bouge), et les joueurs seulement s'ils y sont.
 * ─────────────────────────────────────────────────────────────
 */

import { getStageObstacles } from '../laser/LaserSceneIntersector.js';
import { FOH_TOWER_SOLIDS } from '../scene/fohTower.js';

export const SURF_SKY = -1;
export const SURF_GROUND = 0;
export const SURF_PLAYER = 900000;

// Boîtes : minX, minY, minZ, maxX, maxY, maxZ
const BOX = [];
for (const b of getStageObstacles()) BOX.push([b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ]);
for (const [, x0, x1, y0, y1, z0, z1] of FOH_TOWER_SOLIDS) BOX.push([x0, y0, z0, x1, y1, z1]);
const NB = BOX.length;
const B = new Float32Array(NB * 6);
const SPHERE = new Float32Array(NB * 4);    // centre, rayon (pré-filtrage)
BOX.forEach((b, i) => {
    B.set(b, i * 6);
    const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = (b[2] + b[5]) / 2;
    SPHERE[i * 4] = cx; SPHERE[i * 4 + 1] = cy; SPHERE[i * 4 + 2] = cz;
    SPHERE[i * 4 + 3] = Math.hypot(b[3] - cx, b[4] - cy, b[5] - cz);
});

let _players = null;
const _ph = { t: Infinity, nx: 0, ny: 0, nz: 0 };

/** Collider des joueurs (PlayerLaserCollider) */
export function setLaser2PlayerCollider(collider) {
    _players = collider;
}

/**
 * Liste des boîtes qui peuvent être touchées par un laser (cône de demi-angle `half` autour de `fwd`)
 * @returns {Int16Array} indices (terminés par -1)
 */
export function cullObstacles(O, fwd, half, range, out) {
    let n = 0;
    for (let i = 0; i < NB; i++) {
        const s = i * 4;
        const vx = SPHERE[s] - O.x, vy = SPHERE[s + 1] - O.y, vz = SPHERE[s + 2] - O.z;
        const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
        const r = SPHERE[s + 3];
        if (d - r > range) continue;
        if (d > r) {
            const cosA = (vx * fwd.x + vy * fwd.y + vz * fwd.z) / d;
            const ang = Math.acos(Math.max(-1, Math.min(1, cosA)));
            if (ang > half + Math.asin(Math.min(1, r / d)) + 0.02) continue;
        }
        if (n + 1 >= out.length) break;
        out[n++] = i;
    }
    out[n] = -1;
    return out;
}

/** Un joueur actif peut-il se trouver dans le cône de balayage ? */
export function playersInCone(O, fwd, half, range) {
    const list = _players && _players.enabled !== false ? _players._activeColliders : null;
    if (!list || list.length === 0) return false;
    for (let p = 0; p < list.length; p++) {
        const a = list[p].aabb;
        const vx = (a.minX + a.maxX) / 2 - O.x, vy = (a.minY + a.maxY) / 2 - O.y, vz = (a.minZ + a.maxZ) / 2 - O.z;
        const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (d > range) continue;
        if (d < 2) return true;
        const cosA = (vx * fwd.x + vy * fwd.y + vz * fwd.z) / d;
        if (Math.acos(Math.max(-1, Math.min(1, cosA))) < half + Math.min(0.8, 1.3 / d)) return true;
    }
    return false;
}

/**
 * Premier impact d'un rayon.
 * @param {{x,y,z}} O origine
 * @param {{x,y,z}} d direction normalisée
 * @param {Int16Array} boxes indices pré-filtrés (terminés par -1)
 * @param {boolean} players tester les joueurs
 * @param {number} range portée max
 * @param {{t:number,id:number,nx:number,ny:number,nz:number}} out
 */
export function laser2Hit(O, d, boxes, players, range, out) {
    let t = range, id = SURF_SKY, nx = 0, ny = 1, nz = 0;
    const ox = O.x, oy = O.y, oz = O.z;
    const ix = 1 / (Math.abs(d.x) < 1e-9 ? 1e-9 : d.x);
    const iy = 1 / (Math.abs(d.y) < 1e-9 ? 1e-9 : d.y);
    const iz = 1 / (Math.abs(d.z) < 1e-9 ? 1e-9 : d.z);
    for (let k = 0; ; k++) {
        const i = boxes[k];
        if (i < 0 || i === undefined) break;
        const s = i * 6;
        let t0x = (B[s] - ox) * ix, t1x = (B[s + 3] - ox) * ix;
        let fx = 0;
        if (t0x > t1x) { const q = t0x; t0x = t1x; t1x = q; fx = 1; }
        let t0y = (B[s + 1] - oy) * iy, t1y = (B[s + 4] - oy) * iy;
        let fy = 2;
        if (t0y > t1y) { const q = t0y; t0y = t1y; t1y = q; fy = 3; }
        let t0z = (B[s + 2] - oz) * iz, t1z = (B[s + 5] - oz) * iz;
        let fz = 4;
        if (t0z > t1z) { const q = t0z; t0z = t1z; t1z = q; fz = 5; }
        let tn = t0x, face = fx;
        if (t0y > tn) { tn = t0y; face = fy; }
        if (t0z > tn) { tn = t0z; face = fz; }
        const tf = Math.min(t1x, t1y, t1z);
        // Rayon qui part de l'intérieur d'une boîte (laser accroché dedans) : ignorée
        if (tn > tf || tn < 0.02 || tn >= t) continue;
        t = tn;
        id = 1 + i * 6 + face;
        // Normale : face d'entrée (min → -1, max → +1)
        nx = face === 0 ? -1 : face === 1 ? 1 : 0;
        ny = face === 2 ? -1 : face === 3 ? 1 : 0;
        nz = face === 4 ? -1 : face === 5 ? 1 : 0;
    }
    // Sol
    if (d.y < -1e-9) {
        const tg = -oy * iy;
        if (tg > 0.02 && tg < t) { t = tg; id = SURF_GROUND; nx = 0; ny = 1; nz = 0; }
    }
    // Joueurs
    if (players && _players && _players.intersectRay(O, d, t, _ph)) {
        t = _ph.t; id = SURF_PLAYER; nx = _ph.nx; ny = _ph.ny; nz = _ph.nz;
    }
    out.t = t; out.id = id; out.nx = nx; out.ny = ny; out.nz = nz;
    return out;
}
