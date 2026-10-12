/**
 * LaserSmokeNoise.js
 * ─────────────────────────────────────────────────────────────
 * Texture 3D de bruit volumétrique pré-calculée (une seule fois, ~30 ms)
 * qui remplace les 5 évaluations de simplex-noise 3D par pixel du shader
 * de fumée du plan PAN par 5 lectures de texture 3D filtrées en matériel.
 *
 * - Bruit de gradient (Perlin amélioré) PÉRIODIQUE → texture répétable sans couture
 * - Échantillonnée en coordonnées MONDE 3D (isotrope) : aucun étirement quelle
 *   que soit l'orientation du plan laser (≠ bake 2D en XZ).
 * - Calibré pour reproduire la signature du simplex Ashima d'origine :
 *   fréquence ×1.6 (même courbe d'autocorrélation) et amplitude ×1.403
 *   (même écart-type) → même taille de volutes et même contraste.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';

const TEX_SIZE      = 128;  // voxels par côté (128³ half-float = 4 Mo GPU)
const LATTICE       = 16;   // cellules de gradient par période de texture
const FREQ_MATCH    = 1.6;  // fréquence Perlin équivalente au simplex Ashima
const AMP_MATCH     = 1.403; // écart-type simplex / Perlin

/** Facteur à appliquer aux coordonnées "simplex" pour obtenir les UVW de la texture */
export const SMOKE_NOISE_UVW_SCALE = FREQ_MATCH / LATTICE;

let _texture = null;

function buildNoiseData() {
    // Table de permutation déterministe (même fumée pour tous les joueurs)
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    let seed = 12345;
    for (let i = 255; i > 0; i--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const j = seed % (i + 1);
        const t = perm[i]; perm[i] = perm[j]; perm[j] = t;
    }

    // 12 directions de gradient (Perlin amélioré)
    const G = [
        1, 1, 0,  -1, 1, 0,  1, -1, 0,  -1, -1, 0,
        1, 0, 1,  -1, 0, 1,  1, 0, -1,  -1, 0, -1,
        0, 1, 1,  0, -1, 1,  0, 1, -1,  0, -1, -1
    ];

    // Gradients pré-calculés pour chaque nœud du réseau périodique
    const L = LATTICE;
    const grads = new Float32Array(L * L * L * 3);
    for (let z = 0; z < L; z++) {
        for (let y = 0; y < L; y++) {
            for (let x = 0; x < L; x++) {
                const h = perm[(perm[(perm[x] + y) & 255] + z) & 255] % 12;
                const o = ((z * L + y) * L + x) * 3;
                grads[o] = G[h * 3]; grads[o + 1] = G[h * 3 + 1]; grads[o + 2] = G[h * 3 + 2];
            }
        }
    }

    const N = TEX_SIZE;
    const VPC = N / L; // voxels par cellule
    const fracs = new Float32Array(VPC);
    const fades = new Float32Array(VPC);
    for (let i = 0; i < VPC; i++) {
        const f = i / VPC;
        fracs[i] = f;
        fades[i] = f * f * f * (f * (f * 6 - 15) + 10);
    }

    const out = new Uint16Array(N * N * N);
    const toHalf = THREE.DataUtils.toHalfFloat;

    const g = (ix, iy, iz, fx, fy, fz) => {
        const o = (((iz % L) * L + (iy % L)) * L + (ix % L)) * 3;
        return grads[o] * fx + grads[o + 1] * fy + grads[o + 2] * fz;
    };

    let idx = 0;
    for (let z = 0; z < N; z++) {
        const cz = (z / VPC) | 0, fz = fracs[z % VPC], w = fades[z % VPC];
        for (let y = 0; y < N; y++) {
            const cy = (y / VPC) | 0, fy = fracs[y % VPC], v = fades[y % VPC];
            for (let x = 0; x < N; x++) {
                const cx = (x / VPC) | 0, fx = fracs[x % VPC], u = fades[x % VPC];

                const n000 = g(cx,     cy,     cz,     fx,     fy,     fz);
                const n100 = g(cx + 1, cy,     cz,     fx - 1, fy,     fz);
                const n010 = g(cx,     cy + 1, cz,     fx,     fy - 1, fz);
                const n110 = g(cx + 1, cy + 1, cz,     fx - 1, fy - 1, fz);
                const n001 = g(cx,     cy,     cz + 1, fx,     fy,     fz - 1);
                const n101 = g(cx + 1, cy,     cz + 1, fx - 1, fy,     fz - 1);
                const n011 = g(cx,     cy + 1, cz + 1, fx,     fy - 1, fz - 1);
                const n111 = g(cx + 1, cy + 1, cz + 1, fx - 1, fy - 1, fz - 1);

                const x00 = n000 + (n100 - n000) * u;
                const x10 = n010 + (n110 - n010) * u;
                const x01 = n001 + (n101 - n001) * u;
                const x11 = n011 + (n111 - n011) * u;
                const y0 = x00 + (x10 - x00) * v;
                const y1 = x01 + (x11 - x01) * v;

                out[idx++] = toHalf((y0 + (y1 - y0) * w) * AMP_MATCH);
            }
        }
    }
    return out;
}

/** Retourne (et crée au premier appel) la texture 3D de bruit partagée par tous les lasers */
export function getSmokeNoiseTexture() {
    if (_texture) return _texture;
    const data = buildNoiseData();
    const tex = new THREE.Data3DTexture(data, TEX_SIZE, TEX_SIZE, TEX_SIZE);
    tex.format = THREE.RedFormat;
    tex.type = THREE.HalfFloatType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.wrapR = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    _texture = tex;
    return tex;
}
