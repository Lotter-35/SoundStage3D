/**
 * Laser2Shaders.js
 * ─────────────────────────────────────────────────────────────
 * Rendu des primitives du nouveau laser (1 draw call par type pour TOUS les lasers) :
 *   - faisceaux : quads alignés sur la caméra, largeur physique (diamètre de sortie + divergence),
 *     jamais plus fins qu'un pixel (énergie conservée → aucun fourmillement au loin)
 *   - nappes    : triangles source → A → B, énergie répartie sur l'arc balayé
 *
 * Luminosité physique (diffusion dans l'air, TOUJOURS visible, indépendante du brouillard de la scène) :
 *   luminance ∝ puissance / largeur éclairée × 1/sin(angle de vue) × diffusion vers l'avant (Henyey-Greenstein)
 * puis compression perceptive (l'œil n'est pas linéaire : un faisceau fixe reste bien plus brillant
 * qu'une nappe, sans que la nappe disparaisse).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';

// ── Volutes : bruit de Perlin 3D répétable (64³, 256 Ko), généré une fois ─────────
// 16 cellules par côté (4 texels par cellule) : bruit doux et détaillé ; le shader le combine à plusieurs
// échelles (tailles non multiples, tournées) pour que la fumée ne se répète jamais à l'œil.
const SMOKE_SIZE = 64;
const SMOKE_CELLS = 16;

function createSmokeTexture() {
    const N = SMOKE_SIZE, P = SMOKE_CELLS, step = N / P;
    // Gradients pseudo-aléatoires déterministes (mêmes volutes chez tous les joueurs), grille rebouclée
    let seed = 20240917;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const grad = new Float32Array(P * P * P * 3);
    for (let i = 0; i < P * P * P; i++) {
        const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
        grad[i * 3] = r * Math.cos(a); grad[i * 3 + 1] = r * Math.sin(a); grad[i * 3 + 2] = z;
    }
    const g = (x, y, z, dx, dy, dz) => {
        const i = (((z % P) * P + (y % P)) * P + (x % P)) * 3;
        return grad[i] * dx + grad[i + 1] * dy + grad[i + 2] * dz;
    };
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp = (a, b, t) => a + (b - a) * t;
    const vals = new Float32Array(N * N * N);
    let lo = Infinity, hi = -Infinity;
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const fx = x / step, fy = y / step, fz = z / step;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
        const dx = fx - x0, dy = fy - y0, dz = fz - z0;
        const u = fade(dx), v = fade(dy), w = fade(dz);
        const n = lerp(
            lerp(lerp(g(x0, y0, z0, dx, dy, dz), g(x0 + 1, y0, z0, dx - 1, dy, dz), u),
                 lerp(g(x0, y0 + 1, z0, dx, dy - 1, dz), g(x0 + 1, y0 + 1, z0, dx - 1, dy - 1, dz), u), v),
            lerp(lerp(g(x0, y0, z0 + 1, dx, dy, dz - 1), g(x0 + 1, y0, z0 + 1, dx - 1, dy, dz - 1), u),
                 lerp(g(x0, y0 + 1, z0 + 1, dx, dy - 1, dz - 1), g(x0 + 1, y0 + 1, z0 + 1, dx - 1, dy - 1, dz - 1), u), v),
            w);
        const i = (z * N + y) * N + x;
        vals[i] = n;
        if (n < lo) lo = n;
        if (n > hi) hi = n;
    }
    // 0,5 = 0 ; amplitude ramenée sur 0…1
    const amp = Math.max(-lo, hi);
    const data = new Uint8Array(N * N * N);
    for (let i = 0; i < data.length; i++) data[i] = Math.round((vals[i] / amp * 0.5 + 0.5) * 255);
    const tex = new THREE.Data3DTexture(data, N, N, N);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
}

/** Réglages globaux partagés par les deux matériaux */
export const LASER2_UNIFORMS = {
    uSmokeTex:  { value: createSmokeTexture() },
    uTime:      { value: 0 },              // horloge commune (s) : volutes identiques chez tous
    uPixelK:    { value: 0.001 },          // taille d'un pixel (m) par mètre de profondeur
    uRange:     { value: new THREE.Vector2(600, 1000) }, // fondu de fin de portée
    uGain:      { value: 0.1 },            // gain d'affichage
    uGamma:     { value: 0.42 },           // compression perceptive
};

const PHASE = /* glsl */`
    // Diffusion vers l'avant (Henyey-Greenstein), normalisée à 1 pour une vue de côté
    float phaseHG(float cosT, float g) {
        float g2 = g * g;
        float side = (1.0 - g2) / pow(1.0 + g2, 1.5);
        return ((1.0 - g2) / pow(max(1e-4, 1.0 + g2 - 2.0 * g * cosT), 1.5)) / side;
    }
`;

const COMMON = /* glsl */`
    ${PHASE}
    precision highp sampler3D;
    uniform sampler3D uSmokeTex;
    uniform float uTime;
    uniform float uGain;
    uniform float uGamma;
    // Bruit signé (≈ −1…1) ; 1 unité de texture = 16 cellules
    float sn(vec3 q) { return texture(uSmokeTex, q).r * 2.0 - 1.0; }
    // Rotations entre les échelles : les répétitions de la texture ne s'alignent jamais
    const mat3 ROT_A = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
    const mat3 ROT_B = mat3(0.64, -0.48, 0.60, 0.60, 0.80, 0.00, -0.48, 0.36, 0.80);
    /**
     * Volutes au point p (monde), façon fumée de scène :
     *   - très grande échelle (dizaines de mètres) : nappes plus ou moins chargées, casse toute répétition ;
     *   - distorsion qui enroule la fumée (volutes), échelles de tailles non multiples et tournées ;
     *   - veines fines claires (filaments) et creux sombres ; chaque échelle dérive à sa vitesse.
     * Le détail fin s'efface avec la distance (pas de fourmillement) et tout s'efface au-delà de ~250 m.
     * s = intensité, taille (m), vitesse, contraste.
     */
    float smoke(vec3 p, vec4 s, float dist) {
        // Intensité perçue : 55 % donne déjà une fumée bien marquée
        float fade = pow(s.x, 0.6) * (1.0 - smoothstep(160.0, 260.0, dist));
        if (fade <= 0.001) return 1.0;
        float t = uTime * s.z;
        vec3 q = p / (s.y * 16.0);
        // Très grande échelle : zones plus denses / plus claires
        float big = sn(ROT_B * q * 0.173 + vec3(0.0, t * 0.0035, t * 0.002));
        // Distorsion (enroulement des volutes)
        vec3 wq = q * 0.47;
        vec3 w = vec3(sn(wq + vec3(0.13, 0.71, 0.37) + t * vec3(0.010, 0.017, 0.006)),
                      sn(ROT_A * wq + vec3(0.59, 0.23, 0.91) - t * vec3(0.012, 0.006, 0.014)),
                      sn(ROT_B * wq + vec3(0.31, 0.83, 0.17) + t * vec3(0.005, 0.013, -0.009)));
        vec3 qw = q + w * 0.11;
        // Échelles de la fumée ; le détail fin s'efface au loin
        float lod = smoothstep(45.0, 150.0, dist);
        float f = sn(qw + t * vec3(0.006, 0.011, 0.004));
        f += 0.55 * sn(ROT_A * qw * 2.13 - t * vec3(0.011, 0.004, 0.015));
        float veins = 0.0;
        if (lod < 0.999) {
            f += 0.30 * (1.0 - lod) * sn(ROT_B * qw * 4.37 + t * vec3(0.018, -0.009, 0.013));
            // Filaments : crêtes fines du bruit
            float rdg = 1.0 - abs(sn(ROT_A * qw * 3.31 + vec3(0.47) - t * vec3(0.008, 0.015, 0.006)));
            veins = pow(rdg, 7.0) * (1.0 - lod);
        }
        float dens = f + 0.55 * big;
        float k = 1.15 + 2.6 * s.w;
        float d = smoothstep(-0.62, 0.62, dens * k * 0.55);
        d = clamp(d + 0.45 * veins * smoothstep(-0.4, 0.3, dens), 0.0, 1.0);
        return mix(1.0, 0.03 + 1.95 * d * d * (3.0 - 2.0 * d), fade);
    }
    vec3 shade(vec3 chroma, float L) {
        return chroma * (uGain * pow(max(L, 0.0), uGamma));
    }
`;

function baseOptions() {
    return {
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        toneMapped: false,
    };
}

// ── Faisceaux ──────────────────────────────────────────────────────────────
export function createLaser2BeamMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: { ...LASER2_UNIFORMS },
        vertexShader: /* glsl */`
            attribute vec3 aCorner;       // x : côté (-1/1), y : 0 source → 1 bout
            attribute vec4 aO;            // source.xyz, diamètre de sortie (m)
            attribute vec4 aE;            // bout.xyz, divergence (rad)
            attribute vec4 aC;            // chroma.rgb (max = 1), puissance affichée
            attribute float aG;           // diffusion vers l'avant (g)
            attribute vec4 aS;            // volutes : intensité, taille, vitesse, contraste
            uniform float uPixelK;
            ${PHASE}

            varying float vSide;
            varying float vDist;
            varying float vLum;
            varying vec3 vWorld;
            varying float vCam;
            flat varying vec3 vChroma;
            flat varying vec4 vSmoke;

            void main() {
                vec3 O = aO.xyz;
                vec3 E = aE.xyz;
                vec3 axis = E - O;
                float len = length(axis);
                vec3 dir = axis / max(len, 1e-5);
                vec3 P = O + axis * aCorner.y;
                float r = len * aCorner.y;

                vec3 vP = (viewMatrix * vec4(P, 1.0)).xyz;
                vec3 vDir = normalize(mat3(viewMatrix) * dir);
                vec3 toP = normalize(vP);
                vec3 side = cross(vDir, toP);
                float sl = length(side);
                side = sl < 1e-4 ? vec3(1.0, 0.0, 0.0) : side / sl;

                float phys = aO.w + r * aE.w;
                float pix = max(-vP.z, 0.05) * uPixelK;
                float w = max(phys, pix * 1.6);
                vP += side * aCorner.x * w * 0.5;

                // Luminance (sans compression) : puissance / largeur, angle de vue, diffusion vers l'avant
                float sinB = max(sl, 0.2);
                float cosT = dot(vDir, -toP);
                vLum = aC.w / w / sinB * phaseHG(cosT, aG);
                vChroma = aC.rgb;
                vSide = aCorner.x;
                vDist = r;
                vWorld = P;
                vCam = -vP.z;
                vSmoke = aS;
                gl_Position = projectionMatrix * vec4(vP, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            ${COMMON}
            uniform vec2 uRange;
            varying float vSide;
            varying float vDist;
            varying float vLum;
            varying vec3 vWorld;
            varying float vCam;
            flat varying vec3 vChroma;
            flat varying vec4 vSmoke;
            void main() {
                float x = abs(vSide);
                float prof = (1.0 - x * x) * (1.0 - x) * 1.8;   // profil gaussien approché (aire ≈ 1)
                float fade = 1.0 - smoothstep(uRange.x, uRange.y, vDist);
                vec3 c = shade(vChroma, vLum) * prof * fade * smoke(vWorld, vSmoke, vCam);
                gl_FragColor = vec4(c, 1.0);
            }
        `,
        ...baseOptions(),
    });
}

// ── Nappes ─────────────────────────────────────────────────────────────────
export function createLaser2SheetMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: { ...LASER2_UNIFORMS },
        vertexShader: /* glsl */`
            attribute float aCornerId;    // 0 source, 1 A, 2 B
            attribute vec4 aO;            // source.xyz, diamètre de sortie (m)
            attribute vec4 aA;            // A.xyz, divergence (rad)
            attribute vec4 aB;            // B.xyz, angle A→B (rad)
            attribute vec4 aC;            // chroma.rgb, puissance affichée
            attribute float aG;
            attribute vec4 aS;            // volutes

            varying vec3 vWorld;
            flat varying vec4 vSmoke;
            flat varying vec3 vO;
            flat varying vec3 vN;
            flat varying vec4 vPar;       // diamètre, divergence, angle, g
            flat varying vec4 vCol;

            void main() {
                vec3 P = aCornerId < 0.5 ? aO.xyz : (aCornerId < 1.5 ? aA.xyz : aB.xyz);
                vWorld = P;
                vO = aO.xyz;
                vN = normalize(cross(aA.xyz - aO.xyz, aB.xyz - aO.xyz) + vec3(0.0, 1e-7, 0.0));
                vPar = vec4(aO.w, aA.w, aB.w, aG);
                vCol = aC;
                vSmoke = aS;
                gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            ${COMMON}
            uniform vec2 uRange;
            varying vec3 vWorld;
            flat varying vec3 vO;
            flat varying vec3 vN;
            flat varying vec4 vPar;
            flat varying vec4 vCol;
            flat varying vec4 vSmoke;
            void main() {
                vec3 d = vWorld - vO;
                float r = length(d);
                vec3 dir = d / max(r, 1e-4);
                vec3 view = normalize(vWorld - cameraPosition);
                // Largeur éclairée : l'arc balayé, jamais moins que le faisceau lui-même
                float w = max(r * vPar.z, vPar.x + r * vPar.y);
                float cosA = max(abs(dot(vN, view)), 0.25);
                float L = vCol.w / w / cosA * phaseHG(dot(dir, -view), vPar.w);
                float fade = 1.0 - smoothstep(uRange.x, uRange.y, r);
                float camDist = length(vWorld - cameraPosition);
                gl_FragColor = vec4(shade(vCol.rgb, L) * fade * smoke(vWorld, vSmoke, camDist), 1.0);
            }
        `,
        ...baseOptions(),
    });
}

// ── Impacts sur les surfaces (points des faisceaux, traits des nappes) ─────
// Éclairement de la surface = puissance / (largeur × longueur du trait) : un point fixe éclate,
// un grand trait balayé est bien plus faible (même énergie étalée).
export function createLaser2ImpactMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: { ...LASER2_UNIFORMS, uImpactK: { value: 2.5 } },
        vertexShader: /* glsl */`
            attribute vec2 aCorner;       // x : côté (-1/1), y : 0 début → 1 fin
            attribute vec4 aP0;           // début.xyz, largeur (m)
            attribute vec4 aP1;           // fin.xyz, puissance affichée
            attribute vec3 aN;            // normale de la surface
            attribute vec3 aC;            // chroma
            uniform float uPixelK;

            varying vec2 vUV;             // (le long du trait, en travers) en mètres
            flat varying vec4 vDim;       // longueur, largeur, rayon du halo, éclairement
            flat varying vec3 vChroma;

            void main() {
                vec3 P0 = aP0.xyz, P1 = aP1.xyz;
                vec3 axis = P1 - P0;
                float L = length(axis);
                vec3 n = normalize(aN + vec3(0.0, 1e-6, 0.0));
                vec3 ref = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
                vec3 u = L > 1e-4 ? axis / L : normalize(cross(n, ref));
                vec3 v = normalize(cross(n, u));
                vec4 vp = viewMatrix * vec4((P0 + P1) * 0.5, 1.0);
                float pix = max(-vp.z, 0.05) * uPixelK;
                float w = max(aP0.w, pix * 1.5);
                float halo = max(w * 1.2, 0.03);
                float R = w * 0.5 + halo * 2.4;
                float along = aCorner.y < 0.5 ? -R : L + R;
                float across = aCorner.x * R;
                vec3 P = P0 + u * along + v * across + n * 0.012;
                vUV = vec2(along, across);
                vDim = vec4(L, w, halo, aP1.w / (w * max(L, w)));
                vChroma = aC;
                gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            ${COMMON}
            uniform float uImpactK;
            varying vec2 vUV;
            flat varying vec4 vDim;
            flat varying vec3 vChroma;
            void main() {
                float L = vDim.x, w = vDim.y, halo = vDim.z;
                float a = vUV.x < 0.0 ? -vUV.x : max(0.0, vUV.x - L);
                float d = length(vec2(a, vUV.y));
                float k = d / (0.5 * w);
                float core = exp(-2.0 * k * k);
                // Halo ramené à zéro avant le bord du quad (sinon coupé net → carré, amplifié par le bloom)
                float R = 0.5 * w + 2.4 * halo;
                // Halo gaussien (sans pointe au centre, fondu doux jusqu'au bord) : pas de rond à bord net
                float gk = d / halo;
                float glow = max(0.0, exp(-gk * gk * 1.3) - exp(-(R / halo) * (R / halo) * 1.3)) * 0.12 * (1.0 - smoothstep(0.3 * R, R, d));
                vec3 c = shade(vChroma, vDim.w) * uImpactK * (core + glow);
                gl_FragColor = vec4(c, 1.0);
            }
        `,
        ...baseOptions(),
    });
}

// ── Point lumineux à la sortie du laser (billboard face caméra) ────────────
// Même principe que l'éclat de buse des anciens lasers : cœur blanc très localisé + aura à la couleur
// émise. Vu de face (dans l'axe de sortie) il est bien plus fort que vu de derrière.
// Halo ramené à zéro avant le bord du quad (jamais carré, même avec le bloom).
export function createLaser2SourceMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {},
        vertexShader: /* glsl */`
            attribute vec2 aCorner;       // -1..1
            attribute vec4 aP;            // sortie.xyz, rayon du point (m)
            attribute vec4 aF;            // axe de sortie.xyz, -
            attribute vec4 aC;            // chroma.rgb, intensité
            varying vec2 vD;              // position dans le quad (m)
            flat varying float vHalf;
            flat varying float vR;
            flat varying vec4 vCol;
            void main() {
                vec3 toCam = normalize(cameraPosition - aP.xyz);
                float facing = 0.3 + 0.7 * smoothstep(-0.2, 0.6, dot(toCam, aF.xyz));
                float hs = max(0.9, aP.w * 2.25);
                vec4 mv = viewMatrix * vec4(aP.xyz, 1.0);
                mv.xy += aCorner * hs;
                vD = aCorner * hs;
                vHalf = hs;
                vR = aP.w;
                vCol = vec4(aC.rgb, aC.w * facing);
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: /* glsl */`
            varying vec2 vD;
            flat varying float vHalf;
            flat varying float vR;
            flat varying vec4 vCol;
            void main() {
                float d = length(vD);
                if (d >= vHalf) discard;
                float s = d / max(0.05, vR);
                float core = exp(-s * s * 12.0) * vCol.w * 4.0;
                float aura = exp(-s * 3.2) * 0.8 * vCol.w * 4.0 * (1.0 - smoothstep(0.6 * vHalf, vHalf, d));
                vec3 col = mix(vCol.rgb, vec3(1.0), clamp(core * 0.9, 0.0, 1.0));
                float a = clamp(core * 0.9 + aura * 0.6, 0.0, 1.0);
                gl_FragColor = vec4(col * a, 1.0);
            }
        `,
        ...baseOptions(),
    });
}
