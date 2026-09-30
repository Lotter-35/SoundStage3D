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

// ── Volutes : texture de bruit 3D (32³, 32 Ko) répétable, générée une fois ─────
const SMOKE_SIZE = 32;

function createSmokeTexture() {
    const N = SMOKE_SIZE, N3 = N * N * N;
    // Valeurs pseudo-aléatoires déterministes (mêmes volutes chez tous les joueurs)
    let a = new Float32Array(N3), b = new Float32Array(N3);
    let seed = 20240917;
    for (let i = 0; i < N3; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        a[i] = seed / 4294967296;
    }
    // Lissage (flou 3D séparable, bords rebouclés) : bruit doux au lieu de pixels aléatoires
    const idx = (x, y, z) => ((z + N) % N) * N * N + ((y + N) % N) * N + ((x + N) % N);
    for (let pass = 0; pass < 2; pass++) {
        for (const axis of [0, 1, 2]) {
            for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                let sum = 0;
                for (let d = -2; d <= 2; d++) {
                    sum += a[axis === 0 ? idx(x + d, y, z) : axis === 1 ? idx(x, y + d, z) : idx(x, y, z + d)];
                }
                b[idx(x, y, z)] = sum / 5;
            }
            const t = a; a = b; b = t;
        }
    }
    // Contraste ramené sur 0…1
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N3; i++) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
    const data = new Uint8Array(N3);
    for (let i = 0; i < N3; i++) data[i] = Math.round(((a[i] - lo) / (hi - lo)) * 255);
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
    /**
     * Volutes au point p (monde) : deux lectures du bruit, la seconde déformée par la première
     * (les volutes s'enroulent), qui dérivent avec le temps. s = intensité, taille (m), vitesse, contraste.
     * Au-delà de 200 m (dist), les volutes s'effacent et la texture n'est plus lue.
     */
    float smoke(vec3 p, vec4 s, float dist) {
        float fade = s.x * (1.0 - smoothstep(120.0, 200.0, dist));
        if (fade <= 0.001) return 1.0;
        vec3 q = p / s.y;
        vec3 drift = vec3(0.11, 0.045, 0.08) * uTime * s.z;
        float n1 = texture(uSmokeTex, q * 0.25 + drift).r;
        float n2 = texture(uSmokeTex, q * 0.63 - drift * 1.7 + vec3(n1 * 0.35)).r;
        float n = n1 * 0.6 + n2 * 0.4;
        n = clamp((n - 0.5) * (1.0 + 4.0 * s.w) + 0.5, 0.0, 1.0);
        return mix(1.0, 0.15 + 1.7 * n, fade);
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
                float halo = max(w * 2.5, 0.05);
                float R = w * 0.5 + halo * 2.0;
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
                float R = 0.5 * w + 2.0 * halo;
                float glow = max(0.0, exp(-d / halo) - exp(-R / halo)) * 0.18 * (1.0 - smoothstep(0.6 * R, R, d));
                vec3 c = shade(vChroma, vDim.w) * uImpactK * (core + glow);
                gl_FragColor = vec4(c, 1.0);
            }
        `,
        ...baseOptions(),
    });
}
