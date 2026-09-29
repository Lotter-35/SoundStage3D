/**
 * SpotOcclusion.js
 * ─────────────────────────────────────────────────────────────
 * Occlusion des lyres par la structure de la scène (plateforme, mur du fond, toit,
 * régie, piliers, subs, line arrays) — mêmes boîtes que celles qui arrêtent les lasers.
 *
 * - Les boîtes sont envoyées une fois au shader des faisceaux (uniforms).
 * - Pour chaque lyre, le CPU ne retient que les boîtes (4 max) qui touchent son cône :
 *   le shader teste alors, pour chaque échantillon du faisceau, si le trajet depuis la
 *   lentille est bloqué → le faisceau s'arrête sur les murs et les objets projettent
 *   de vraies ombres volumétriques dans la fumée.
 * - Une lyre dont le cône touche un obstacle n'utilise pas de SpotLight réelle (qui
 *   traverserait les murs) : sa tache de lumière est calculée par le shader, occlusion comprise.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { getStageObstacles } from '../laser/LaserSceneIntersector.js';

export const MAX_OCCLUDERS = 16;       // boîtes envoyées au shader
export const OCCLUDERS_PER_SPOT = 4;   // boîtes testées par lyre

const _boxes = getStageObstacles().slice(0, MAX_OCCLUDERS).map(b => ({
    min: new THREE.Vector3(b.minX, b.minY, b.minZ),
    max: new THREE.Vector3(b.maxX, b.maxY, b.maxZ),
    center: new THREE.Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2),
    radius: 0.5 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ),
}));

/** Tableaux d'uniforms (bornes min / max, complétés par des boîtes vides) */
export function occluderUniforms() {
    const mins = [], maxs = [];
    for (let i = 0; i < MAX_OCCLUDERS; i++) {
        const b = _boxes[i];
        mins.push(b ? b.min.clone() : new THREE.Vector3(1e6, 1e6, 1e6));
        maxs.push(b ? b.max.clone() : new THREE.Vector3(1e6, 1e6, 1e6));
    }
    return { mins, maxs, count: _boxes.length };
}

const _cand = [];

/** Rayon (origine o, direction unitaire d) / boîte élargie de `pad` : distance d'entrée ou Infinity */
function rayPaddedBox(o, d, b, pad, maxT) {
    let tn = 0, tf = maxT;
    for (let k = 0; k < 3; k++) {
        const ax = k === 0 ? 'x' : k === 1 ? 'y' : 'z';
        const lo = b.min[ax] - pad, hi = b.max[ax] + pad;
        const oo = o[ax], dd = d[ax];
        if (Math.abs(dd) < 1e-9) {
            if (oo < lo || oo > hi) return Infinity;
            continue;
        }
        let t1 = (lo - oo) / dd, t2 = (hi - oo) / dd;
        if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
        if (t1 > tn) tn = t1;
        if (t2 < tf) tf = t2;
        if (tn > tf) return Infinity;
    }
    return tn;
}

/**
 * Boîtes pouvant bloquer le cône d'une lyre (test conservatif sphère englobante / cône).
 * @param {THREE.Vector3} lens position de la lentille
 * @param {THREE.Vector3} axis axe du faisceau (normé)
 * @param {number} tanCone tangente du demi-angle (prisme compris)
 * @param {number} r0 rayon de la lentille
 * @param {number} range portée
 * @param {Float32Array|number[]} out indices (−1 = aucun), OCCLUDERS_PER_SPOT valeurs
 * @returns {number} nombre de boîtes retenues
 */
export function findConeOccluders(lens, axis, tanCone, r0, range, out) {
    _cand.length = 0;
    for (let i = 0; i < _boxes.length; i++) {
        const b = _boxes[i];
        // Lentille à l'intérieur de la boîte (lyre posée dans un volume) : on ignore cette boîte
        if (lens.x > b.min.x && lens.x < b.max.x && lens.y > b.min.y && lens.y < b.max.y && lens.z > b.min.z && lens.z < b.max.z) continue;
        // Distance maximale (le long de l'axe) des coins de la boîte : le cône y a un rayon ≤ r(tMax)
        let tMax = -Infinity;
        for (let c = 0; c < 8; c++) {
            const x = ((c & 1) ? b.max.x : b.min.x) - lens.x;
            const y = ((c & 2) ? b.max.y : b.min.y) - lens.y;
            const z = ((c & 4) ? b.max.z : b.min.z) - lens.z;
            const a = x * axis.x + y * axis.y + z * axis.z;
            if (a > tMax) tMax = a;
        }
        if (tMax <= 0) continue; // boîte entièrement derrière la lyre
        tMax = Math.min(tMax, range);
        // Test exact et conservatif : l'axe traverse-t-il la boîte élargie du rayon du cône ?
        const tEnter = rayPaddedBox(lens, axis, b, r0 + tMax * tanCone, tMax);
        if (tEnter === Infinity) continue;
        _cand.push({ i, d: tEnter });
    }
    _cand.sort((a, b) => a.d - b.d);
    const n = Math.min(OCCLUDERS_PER_SPOT, _cand.length);
    for (let k = 0; k < OCCLUDERS_PER_SPOT; k++) out[k] = k < n ? _cand[k].i : -1;
    return n;
}
