/**
 * Collision.js (cœur de calcul des nouveaux lasers — sans Three.js, utilisable dans un Web Worker)
 * ─────────────────────────────────────────────────────────────
 * Impacts analytiques, 0 allocation :
 *   - groupes de boîtes (obstacles de la scène, tour régie…) fournis par le jeu (setObstacleGroups) ;
 *     un rayon qui manque la boîte englobante d'un groupe saute toutes ses boîtes
 *   - sol (y = 0)
 *   - joueurs : capsules du squelette fournies à chaque image (setPlayerCapsules)
 *
 * Chaque impact porte un identifiant de SURFACE (sol, face d'une boîte, joueur, ciel) : une nappe dont les
 * deux bords touchent la même face plane se coupe exactement par un segment, sinon elle est subdivisée.
 * ─────────────────────────────────────────────────────────────
 */

export const SURF_SKY = -1;
export const SURF_GROUND = 0;
export const SURF_PLAYER = 900000;

let B = new Float32Array(0);        // boîtes : minX, minY, minZ, maxX, maxY, maxZ
let G = new Float32Array(0);        // boîte englobante de chaque groupe
let GI = new Int32Array(0);         // début, nombre de boîtes du groupe
let SPHERE = new Float32Array(0);   // sphère englobante de chaque groupe (pré-filtrage)
let NG = 0;

/**
 * Obstacles de la scène.
 * @param {number[][][]} groups liste de groupes, chaque groupe = liste de boîtes [minX, minY, minZ, maxX, maxY, maxZ]
 */
export function setObstacleGroups(groups) {
    const boxes = [];
    const gi = [];
    for (const g of groups) {
        gi.push(boxes.length, g.length);
        for (const b of g) boxes.push(b);
    }
    NG = groups.length;
    B = new Float32Array(boxes.length * 6);
    boxes.forEach((b, i) => B.set(b, i * 6));
    GI = Int32Array.from(gi);
    G = new Float32Array(NG * 6);
    SPHERE = new Float32Array(NG * 4);
    for (let g = 0; g < NG; g++) {
        const start = GI[g * 2], count = GI[g * 2 + 1];
        const e = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let i = start; i < start + count; i++) {
            for (let a = 0; a < 3; a++) {
                e[a] = Math.min(e[a], B[i * 6 + a]);
                e[a + 3] = Math.max(e[a + 3], B[i * 6 + a + 3]);
            }
        }
        G.set(e, g * 6);
        const cx = (e[0] + e[3]) / 2, cy = (e[1] + e[4]) / 2, cz = (e[2] + e[5]) / 2;
        SPHERE[g * 4] = cx; SPHERE[g * 4 + 1] = cy; SPHERE[g * 4 + 2] = cz;
        SPHERE[g * 4 + 3] = Math.hypot(e[3] - cx, e[4] - cy, e[5] - cz);
    }
}

// ── Joueurs : [nombre de joueurs, puis par joueur : aabb (6), nombre de capsules, capsules (ax ay az bx by bz r)…]
let P = new Float32Array(1);

/** Capsules des joueurs pour l'image (format compact, voir packPlayers) */
export function setPlayerCapsules(packed) {
    P = packed && packed.length ? packed : new Float32Array(1);
}

/** Emballe les capsules d'un PlayerLaserCollider (thread principal) dans le format compact */
export function packPlayers(collider, out) {
    const list = collider && collider.enabled !== false ? collider._activeColliders : null;
    if (!list || list.length === 0) {
        if (!out || out.length < 1) out = new Float32Array(1);
        out[0] = 0;
        return out;
    }
    let need = 1;
    for (const p of list) need += 7 + p.capsuleCount * 7;
    if (!out || out.length < need) out = new Float32Array(need * 2);
    let o = 0;
    out[o++] = list.length;
    for (const p of list) {
        const a = p.aabb;
        out[o++] = a.minX; out[o++] = a.minY; out[o++] = a.minZ; out[o++] = a.maxX; out[o++] = a.maxY; out[o++] = a.maxZ;
        out[o++] = p.capsuleCount;
        out.set(p.capsules.subarray(0, p.capsuleCount * 7), o);
        o += p.capsuleCount * 7;
    }
    return out;
}

/**
 * Groupes d'obstacles qui peuvent être touchés par un laser (cône de demi-angle `half` autour de `fwd`)
 * @returns {Int16Array} indices de groupes (terminés par -1)
 */
export function cullObstacles(O, fwd, half, range, out) {
    let n = 0;
    for (let i = 0; i < NG; i++) {
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
    const np = P[0] | 0;
    let o = 1;
    for (let p = 0; p < np; p++) {
        const vx = (P[o] + P[o + 3]) / 2 - O.x, vy = (P[o + 1] + P[o + 4]) / 2 - O.y, vz = (P[o + 2] + P[o + 5]) / 2 - O.z;
        const nc = P[o + 6] | 0;
        o += 7 + nc * 7;
        const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (d > range) continue;
        if (d < 2) return true;
        const cosA = (vx * fwd.x + vy * fwd.y + vz * fwd.z) / d;
        if (Math.acos(Math.max(-1, Math.min(1, cosA))) < half + Math.min(0.8, 1.3 / d)) return true;
    }
    return false;
}

// Rayon / boîte (slab) : t d'entrée ou Infinity
function slab(ox, oy, oz, ix, iy, iz, b, s) {
    let a0 = (b[s] - ox) * ix, a1 = (b[s + 3] - ox) * ix;
    if (a0 > a1) { const q = a0; a0 = a1; a1 = q; }
    let b0 = (b[s + 1] - oy) * iy, b1 = (b[s + 4] - oy) * iy;
    if (b0 > b1) { const q = b0; b0 = b1; b1 = q; }
    let c0 = (b[s + 2] - oz) * iz, c1 = (b[s + 5] - oz) * iz;
    if (c0 > c1) { const q = c0; c0 = c1; c1 = q; }
    const tn = a0 > b0 ? (a0 > c0 ? a0 : c0) : (b0 > c0 ? b0 : c0);
    const tf = a1 < b1 ? (a1 < c1 ? a1 : c1) : (b1 < c1 ? b1 : c1);
    return tn <= tf && tf >= 0 ? tn : Infinity;
}

const _cap = { t: 0, nx: 0, ny: 0, nz: 0 };

/** Rayon / capsule [A, B] de rayon r (corps + calottes) ; résultat dans _cap si t < maxT */
function capsule(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r, maxT) {
    let best = maxT, hit = false;
    const vx = bx - ax, vy = by - ay, vz = bz - az;
    const L2 = vx * vx + vy * vy + vz * vz;
    if (L2 > 1e-8) {
        const L = Math.sqrt(L2);
        const ux = vx / L, uy = vy / L, uz = vz / L;
        const wx = ox - ax, wy = oy - ay, wz = oz - az;
        const du = dx * ux + dy * uy + dz * uz, wu = wx * ux + wy * uy + wz * uz;
        const px = dx - du * ux, py = dy - du * uy, pz = dz - du * uz;
        const qx = wx - wu * ux, qy = wy - wu * uy, qz = wz - wu * uz;
        const a = px * px + py * py + pz * pz;
        const b = px * qx + py * qy + pz * qz;
        const c = qx * qx + qy * qy + qz * qz - r * r;
        if (a > 1e-10) {
            const disc = b * b - a * c;
            if (disc >= 0) {
                const t = (-b - Math.sqrt(disc)) / a;
                const s = wu + t * du;
                if (t > 0.001 && t < best && s >= 0 && s <= L) {
                    best = t; hit = true;
                    const cx = ax + ux * s, cy = ay + uy * s, cz = az + uz * s;
                    _cap.nx = (ox + dx * t - cx) / r; _cap.ny = (oy + dy * t - cy) / r; _cap.nz = (oz + dz * t - cz) / r;
                }
            }
        }
    }
    // Calottes sphériques
    for (let e = 0; e < 2; e++) {
        const cx = e ? bx : ax, cy = e ? by : ay, cz = e ? bz : az;
        const wx = ox - cx, wy = oy - cy, wz = oz - cz;
        const b = wx * dx + wy * dy + wz * dz;
        const c = wx * wx + wy * wy + wz * wz - r * r;
        const disc = b * b - c;
        if (disc < 0) continue;
        const t = -b - Math.sqrt(disc);
        if (t > 0.001 && t < best) {
            best = t; hit = true;
            _cap.nx = (ox + dx * t - cx) / r; _cap.ny = (oy + dy * t - cy) / r; _cap.nz = (oz + dz * t - cz) / r;
        }
    }
    _cap.t = best;
    return hit;
}

/**
 * Premier impact d'un rayon.
 * @param {{x,y,z}} O origine
 * @param {{x,y,z}} d direction normalisée
 * @param {Int16Array} groups groupes pré-filtrés (terminés par -1)
 * @param {boolean} players tester les joueurs
 * @param {number} range portée max
 * @param {{t:number,id:number,nx:number,ny:number,nz:number}} out
 */
export function laser2Hit(O, d, groups, players, range, out) {
    let t = range, id = SURF_SKY, nx = 0, ny = 1, nz = 0;
    const ox = O.x, oy = O.y, oz = O.z;
    const ix = 1 / (Math.abs(d.x) < 1e-9 ? 1e-9 : d.x);
    const iy = 1 / (Math.abs(d.y) < 1e-9 ? 1e-9 : d.y);
    const iz = 1 / (Math.abs(d.z) < 1e-9 ? 1e-9 : d.z);
    for (let k = 0; ; k++) {
        const gi = groups[k];
        if (gi < 0 || gi === undefined) break;
        const start = GI[gi * 2], count = GI[gi * 2 + 1];
        if (count > 1) {
            const gn = slab(ox, oy, oz, ix, iy, iz, G, gi * 6);
            if (gn >= t) continue;
        }
        for (let i = start; i < start + count; i++) {
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
            const tf = t1x < t1y ? (t1x < t1z ? t1x : t1z) : (t1y < t1z ? t1y : t1z);
            // Rayon qui part de l'intérieur d'une boîte (laser accroché dedans) : ignorée
            if (tn > tf || tn < 0.02 || tn >= t) continue;
            t = tn;
            id = 1 + i * 6 + face;
            nx = face === 0 ? -1 : face === 1 ? 1 : 0;
            ny = face === 2 ? -1 : face === 3 ? 1 : 0;
            nz = face === 4 ? -1 : face === 5 ? 1 : 0;
        }
    }
    // Sol
    if (d.y < -1e-9) {
        const tg = -oy * iy;
        if (tg > 0.02 && tg < t) { t = tg; id = SURF_GROUND; nx = 0; ny = 1; nz = 0; }
    }
    // Joueurs (boîte englobante, puis capsules)
    if (players) {
        const np = P[0] | 0;
        let o = 1;
        for (let p = 0; p < np; p++) {
            const nc = P[o + 6] | 0;
            const next = o + 7 + nc * 7;
            if (slab(ox, oy, oz, ix, iy, iz, P, o) < t) {
                for (let c = 0; c < nc; c++) {
                    const q = o + 7 + c * 7;
                    if (capsule(ox, oy, oz, d.x, d.y, d.z, P[q], P[q + 1], P[q + 2], P[q + 3], P[q + 4], P[q + 5], P[q + 6], t)) {
                        t = _cap.t; id = SURF_PLAYER; nx = _cap.nx; ny = _cap.ny; nz = _cap.nz;
                    }
                }
            }
            o = next;
        }
    }
    out.t = t; out.id = id; out.nx = nx; out.ny = ny; out.nz = nz;
    return out;
}
