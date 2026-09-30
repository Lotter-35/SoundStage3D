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

/** Réglages globaux partagés par les deux matériaux */
export const LASER2_UNIFORMS = {
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
    uniform float uGain;
    uniform float uGamma;
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
            uniform float uPixelK;
            ${PHASE}

            varying float vSide;
            varying float vDist;
            varying float vLum;
            flat varying vec3 vChroma;

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
                gl_Position = projectionMatrix * vec4(vP, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            ${COMMON}
            uniform vec2 uRange;
            varying float vSide;
            varying float vDist;
            varying float vLum;
            flat varying vec3 vChroma;
            void main() {
                float x = abs(vSide);
                float prof = (1.0 - x * x) * (1.0 - x) * 1.8;   // profil gaussien approché (aire ≈ 1)
                float fade = 1.0 - smoothstep(uRange.x, uRange.y, vDist);
                vec3 c = shade(vChroma, vLum) * prof * fade;
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

            varying vec3 vWorld;
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
                gl_FragColor = vec4(shade(vCol.rgb, L) * fade, 1.0);
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
                float glow = exp(-d / halo) * 0.18;
                vec3 c = shade(vChroma, vDim.w) * uImpactK * (core + glow);
                gl_FragColor = vec4(c, 1.0);
            }
        `,
        ...baseOptions(),
    });
}
