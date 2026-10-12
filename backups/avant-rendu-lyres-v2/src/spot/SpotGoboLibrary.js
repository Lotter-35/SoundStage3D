/**
 * SpotGoboLibrary.js
 * ─────────────────────────────────────────────────────────────
 * Gobos et roue d'animation générés PAR CODE (aucun fichier externe) dans une
 * seule texture tableau (DataArrayTexture, 256 × 256 par couche, mipmappée) :
 *   couche 0        → ouvert
 *   couches 1 … 8   → roue de gobos fixes
 *   couches 9 … 15  → roue de gobos rotatifs (index 1 … 7)
 *   couches 16 … 18 → roue d'animation (Eau, Feu, Nuages), motifs répétables
 *
 * Blanc = la lumière passe, noir = métal du gobo. Les mipmaps servent au flou
 * de mise au point (focus) et au frost dans les shaders.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';

export const GOBO_SIZE = 256;
export const GOBO_LAYER_ROT_OFFSET = 8;
export const GOBO_LAYER_ANIM_OFFSET = 15;
const LAYER_COUNT = 19;

// Générateur pseudo-aléatoire déterministe (même gobo pour tous les joueurs)
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function newCanvas() {
    const c = document.createElement('canvas');
    c.width = c.height = GOBO_SIZE;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, GOBO_SIZE, GOBO_SIZE);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.translate(GOBO_SIZE / 2, GOBO_SIZE / 2);
    return { c, ctx, R: GOBO_SIZE / 2 };
}

// ── Gobos fixes ─────────────────────────────────────────────────────────────
const FIXED = [
    // 1. Points : couronne de trous + centre
    (ctx, R) => {
        const ring = (n, rad, size, off = 0) => {
            for (let i = 0; i < n; i++) {
                const a = off + (i / n) * Math.PI * 2;
                ctx.beginPath();
                ctx.arc(Math.cos(a) * rad, Math.sin(a) * rad, size, 0, Math.PI * 2);
                ctx.fill();
            }
        };
        ring(1, 0, R * 0.13);
        ring(6, R * 0.42, R * 0.11);
        ring(12, R * 0.80, R * 0.085, Math.PI / 12);
    },
    // 2. Brisure (breakup) : taches organiques irrégulières
    (ctx, R) => {
        const r = rng(11);
        for (let i = 0; i < 42; i++) {
            const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R * 0.95;
            const x = Math.cos(a) * d, y = Math.sin(a) * d;
            const s = R * (0.05 + r() * 0.11);
            ctx.beginPath();
            const pts = 7;
            for (let k = 0; k <= pts; k++) {
                const aa = (k / pts) * Math.PI * 2;
                const rr = s * (0.6 + r() * 0.7);
                const px = x + Math.cos(aa) * rr, py = y + Math.sin(aa) * rr;
                if (k === 0) ctx.moveTo(px, py); else ctx.quadraticCurveTo(x + Math.cos(aa - 0.4) * rr * 1.3, y + Math.sin(aa - 0.4) * rr * 1.3, px, py);
            }
            ctx.fill();
        }
    },
    // 3. Étoile : rayons fins en éventail
    (ctx, R) => {
        const n = 10;
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            const w = 0.085;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a - w) * R * 1.1, Math.sin(a - w) * R * 1.1);
            ctx.lineTo(Math.cos(a + w) * R * 1.1, Math.sin(a + w) * R * 1.1);
            ctx.closePath();
            ctx.fill();
        }
    },
    // 4. Anneaux concentriques
    (ctx, R) => {
        ctx.lineWidth = R * 0.075;
        for (const f of [0.18, 0.42, 0.66, 0.90]) {
            ctx.beginPath();
            ctx.arc(0, 0, R * f, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.06, 0, Math.PI * 2);
        ctx.fill();
    },
    // 5. Barres parallèles
    (ctx, R) => {
        const w = R * 0.11;
        for (let i = -4; i <= 4; i++) ctx.fillRect(i * R * 0.24 - w / 2, -R, w, 2 * R);
    },
    // 6. Triangle plein
    (ctx, R) => {
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
            const a = -Math.PI / 2 + (i / 3) * Math.PI * 2;
            const x = Math.cos(a) * R * 0.92, y = Math.sin(a) * R * 0.92;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
    },
    // 7. Fleur : pétales elliptiques
    (ctx, R) => {
        for (let i = 0; i < 8; i++) {
            ctx.save();
            ctx.rotate((i / 8) * Math.PI * 2);
            ctx.beginPath();
            ctx.ellipse(R * 0.52, 0, R * 0.38, R * 0.13, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.1, 0, Math.PI * 2);
        ctx.fill();
    },
    // 8. Tourbillon : bras spiralés
    (ctx, R) => {
        ctx.lineCap = 'round';
        for (let arm = 0; arm < 5; arm++) {
            ctx.beginPath();
            for (let t = 0; t <= 1.0001; t += 0.02) {
                const a = arm * (Math.PI * 2 / 5) + t * 3.2;
                const d = R * (0.08 + t * 0.95);
                const x = Math.cos(a) * d, y = Math.sin(a) * d;
                if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.lineWidth = R * 0.09;
            ctx.stroke();
        }
    },
];

// ── Gobos rotatifs ──────────────────────────────────────────────────────────
const ROT = [
    // 1. Feuillage : brisure dense et fine
    (ctx, R) => {
        const r = rng(77);
        for (let i = 0; i < 150; i++) {
            const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R;
            ctx.beginPath();
            ctx.ellipse(Math.cos(a) * d, Math.sin(a) * d, R * (0.02 + r() * 0.05), R * (0.01 + r() * 0.03), r() * Math.PI, 0, Math.PI * 2);
            ctx.fill();
        }
    },
    // 2. Rayons : soleil à 16 branches
    (ctx, R) => {
        for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a - 0.03) * R * 0.18, Math.sin(a - 0.03) * R * 0.18);
            ctx.lineTo(Math.cos(a - 0.07) * R * 1.1, Math.sin(a - 0.07) * R * 1.1);
            ctx.lineTo(Math.cos(a + 0.07) * R * 1.1, Math.sin(a + 0.07) * R * 1.1);
            ctx.lineTo(Math.cos(a + 0.03) * R * 0.18, Math.sin(a + 0.03) * R * 0.18);
            ctx.closePath();
            ctx.fill();
        }
    },
    // 3. Spirale continue
    (ctx, R) => {
        ctx.lineWidth = R * 0.065;
        ctx.beginPath();
        for (let t = 0; t <= 1.0001; t += 0.004) {
            const a = t * Math.PI * 2 * 4.2;
            const d = R * t;
            const x = Math.cos(a) * d, y = Math.sin(a) * d;
            if (t === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    },
    // 4. Grille de trous carrés
    (ctx, R) => {
        const s = R * 0.2;
        for (let i = -5; i <= 5; i++) {
            for (let j = -5; j <= 5; j++) {
                ctx.fillRect(i * s * 1.25 - s / 2, j * s * 1.25 - s / 2, s * 0.72, s * 0.72);
            }
        }
    },
    // 5. Cercles de cercles
    (ctx, R) => {
        const rings = [[1, 0, 0.12], [6, 0.34, 0.09], [11, 0.62, 0.075], [16, 0.88, 0.06]];
        for (const [n, rad, size] of rings) {
            for (let i = 0; i < n; i++) {
                const a = (i / n) * Math.PI * 2;
                ctx.beginPath();
                ctx.arc(Math.cos(a) * rad * R, Math.sin(a) * rad * R, size * R, 0, Math.PI * 2);
                ctx.lineWidth = R * 0.025;
                ctx.stroke();
            }
        }
    },
    // 6. Éclats : triangles pointus aléatoires
    (ctx, R) => {
        const r = rng(303);
        for (let i = 0; i < 34; i++) {
            const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R;
            const x = Math.cos(a) * d, y = Math.sin(a) * d;
            const rot = r() * Math.PI * 2, len = R * (0.1 + r() * 0.22), w = R * (0.02 + r() * 0.05);
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(rot);
            ctx.beginPath();
            ctx.moveTo(-len / 2, -w);
            ctx.lineTo(len / 2, 0);
            ctx.lineTo(-len / 2, w);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    },
    // 7. Nébuleuse : gobo verre en niveaux de gris (dégradés doux)
    (ctx, R) => {
        const r = rng(909);
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 60; i++) {
            const a = r() * Math.PI * 2, d = Math.sqrt(r()) * R * 0.9;
            const x = Math.cos(a) * d, y = Math.sin(a) * d;
            const s = R * (0.08 + r() * 0.3);
            const g = ctx.createRadialGradient(x, y, 0, x, y, s);
            const v = Math.floor(40 + r() * 70);
            g.addColorStop(0, `rgb(${v},${v},${v})`);
            g.addColorStop(1, 'rgb(0,0,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x, y, s, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
    },
];

// ── Roue d'animation : textures répétables calculées au pixel ───────────────
function periodicValueNoise(seed, period) {
    const r = rng(seed);
    const grid = new Float32Array(period * period);
    for (let i = 0; i < grid.length; i++) grid[i] = r();
    const s = t => t * t * (3 - 2 * t);
    return (x, y) => {
        const xi = Math.floor(x), yi = Math.floor(y);
        const xf = s(x - xi), yf = s(y - yi);
        const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
        const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
        const a = grid[y0 * period + x0], b = grid[y0 * period + x1];
        const c = grid[y1 * period + x0], d = grid[y1 * period + x1];
        return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
    };
}

function fbm(noise, x, y, oct, basePeriodScale) {
    let v = 0, amp = 0.5, f = 1;
    for (let o = 0; o < oct; o++) {
        v += amp * noise(x * f * basePeriodScale, y * f * basePeriodScale);
        amp *= 0.5;
        f *= 2;
    }
    return v;
}

function animLayer(kind) {
    const N = GOBO_SIZE;
    const out = new Uint8Array(N * N);
    const P = 64; // période du réseau de bruit (répétable sur la texture)
    const noise = periodicValueNoise(kind === 1 ? 5 : kind === 2 ? 17 : 29, P);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const u = x / N, v = y / N;
            let val;
            if (kind === 1) {
                // Eau : caustiques (crêtes de bruit)
                const n1 = fbm(noise, u, v, 4, P / 4);
                const n2 = fbm(noise, u + 0.37, v + 0.11, 4, P / 4);
                const ridge = 1 - Math.abs(n1 - n2) * 6.0;
                val = Math.pow(Math.max(0, ridge), 3.0) * 0.9 + 0.1;
            } else if (kind === 2) {
                // Feu : langues verticales étirées
                const n = fbm(noise, u * 2, v * 0.5, 4, P / 8);
                const streak = Math.sin((u * 10 + n * 3.5) * Math.PI * 2) * 0.5 + 0.5;
                val = Math.pow(streak * (0.35 + n), 1.6);
            } else {
                // Nuages : fbm doux
                const n = fbm(noise, u, v, 5, P / 8);
                val = Math.max(0, Math.min(1, (n - 0.28) * 2.2));
            }
            out[y * N + x] = Math.max(0, Math.min(255, Math.round(val * 255)));
        }
    }
    return out;
}

let _texture = null;

/** Texture tableau des gobos (créée au premier appel, ~40 ms) */
export function getGoboTexture() {
    if (_texture) return _texture;
    const N = GOBO_SIZE;
    const data = new Uint8Array(N * N * LAYER_COUNT);

    const writeCanvas = (layer, draw) => {
        const { c, ctx, R } = newCanvas();
        draw(ctx, R);
        const img = ctx.getImageData(0, 0, N, N).data;
        const off = layer * N * N;
        for (let i = 0; i < N * N; i++) data[off + i] = img[i * 4];
        void c;
    };

    // Couche 0 : ouvert
    data.fill(255, 0, N * N);
    FIXED.forEach((draw, i) => writeCanvas(1 + i, draw));
    ROT.forEach((draw, i) => writeCanvas(GOBO_LAYER_ROT_OFFSET + 1 + i, draw));
    for (let k = 1; k <= 3; k++) data.set(animLayer(k), (GOBO_LAYER_ANIM_OFFSET + k) * N * N);

    const tex = new THREE.DataArrayTexture(data, N, N, LAYER_COUNT);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    _texture = tex;
    return tex;
}
