/**
 * GIShaders.js
 * ─────────────────────────────────────────────────────────────
 * Shaders de la LUMIÈRE INDIRECTE (GI, plan R5) — un rebond de la lumière des lyres sur le décor :
 *
 * 1. LUMIÈRES VIRTUELLES (createVPLMaterial) : pour chaque cône de lyre (SSDepthLights, une ligne), K rayons
 *    répartis dans l'ouverture (spirale de Vogel tournée à chaque image : la grille, lissée dans le temps,
 *    moyenne les tirages). Chaque rayon s'arrête sur le décor grâce à la cubemap de distances de la lyre
 *    (ombres statiques ; repli : le sol y = 0) ; normale = 2 rayons voisins ; matériau = classement par
 *    position / normale (comme les taches). Le point touché devient une lumière virtuelle diffuse :
 *        flux réfléchi Φ = albédo × intensité × angle solide du rayon   (indépendant de la distance)
 *    + M points LE LONG DU FAISCEAU (répartis au hasard à chaque image, jusqu'au décor) : la lumière du
 *    faisceau diffusée par la fumée éclaire la salle autour de lui (comme dans un vrai concert, c'est la
 *    principale lumière « indirecte » : sur un plateau noir le rebond est faible) ; source isotrope de flux
 *        Φ = densité de la fumée × longueur du tronçon × flux du faisceau.
 *    Sortie : 2 texels RGBA32F par lumière virtuelle — (position, normale codée ou −2 = isotrope),
 *    (intensité, 1) ; w = −1 : pas de lumière.
 *
 * 2. GRILLE (createGIGridMaterial) : une couche z de la grille 3D par dessin ; chaque cellule additionne
 *    l'éclairement de toutes les lumières virtuelles (Φ/π × cos côté émetteur / (r² + r0²), demi-espace
 *    devant la surface seulement : pas de fuite à travers le plateau ou le mur). Pas de visibilité entre la
 *    lumière virtuelle et la cellule (coût). Écrit avec un mélange alpha = lissage temporel (pas de double
 *    tampon : la grille se met à jour en place).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { GATE_GLSL } from '../SpotShaders.js?v=5';
import { CONE_GLSL } from '../ssdepth/SSConeGLSL.js';
import { SHADOW_GLSL, SHADOW_FAR } from '../lighting/shadowGLSL.js';
import { SURFACE_GLSL } from '../lighting/surfaceGLSL.js';

/** Lumières virtuelles par cône, au plus : sur le décor, le long du faisceau */
export const GI_MAX_VPL_PER_CONE = 16;
export const GI_MAX_BEAM_PTS = 8;

const VERT = /* glsl */`
    void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Normale unitaire ↔ un flottant (octaédrique, 2 × 12 bits : exact en float32)
const NORMAL_PACK_GLSL = /* glsl */`
float packNormal(vec3 n) {
    n /= abs(n.x) + abs(n.y) + abs(n.z);
    vec2 e = n.y >= 0.0 ? n.xz : (1.0 - abs(n.zx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.z >= 0.0 ? 1.0 : -1.0);
    vec2 q = floor(clamp(e * 0.5 + 0.5, 0.0, 1.0) * 4095.0 + 0.5);
    return q.x * 4096.0 + q.y;
}
vec3 unpackNormal(float f) {
    float qx = floor(f / 4096.0);
    vec2 e = vec2(qx, f - qx * 4096.0) / 4095.0 * 2.0 - 1.0;
    vec3 n = vec3(e.x, 1.0 - abs(e.x) - abs(e.y), e.y);
    if (n.y < 0.0) n.xz = (1.0 - abs(n.zx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.z >= 0.0 ? 1.0 : -1.0);
    return normalize(n);
}
`;

/** @param {object} shadowUniforms uniformes partagés des ombres statiques */
export function createVPLMaterial(shadowUniforms) {
    return new THREE.ShaderMaterial({
        uniforms: {
            ...shadowUniforms,
            uSpotParams: { value: null },
            uGobos:      { value: null },
            uGateAtlas:  { value: null },
            uSSLights:   { value: null },
            uGrass:      { value: null },
            uGrassOn:    { value: 0 },
            uK:          { value: 8 },
            uM:          { value: 4 },
            uSpin:       { value: 0 },
            uGain:       { value: 60 },
            uHazeK:      { value: 0.02 },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */`
            precision highp float;
            precision highp int;
            ${GATE_GLSL}
            ${CONE_GLSL}
            ${SHADOW_GLSL}
            ${SURFACE_GLSL}
            ${NORMAL_PACK_GLSL}
            uniform int uK;
            uniform int uM;
            uniform float uSpin;
            uniform float uGain;
            uniform float uHazeK;

            const float PI = 3.14159265;

            // Point du décor touché dans la direction d (depuis le pivot de la tête : origine de la cubemap)
            bool hitDecor(vec3 o, vec3 d, vec4 SH, out vec3 X, out vec3 N) {
                // Sorties toujours écrites : sinon Direct3D (ANGLE) rejette le shader à la validation et le
                // recompile sans optimisation (chargement « Préparation du rendu » très long, shader plus lent)
                X = o;
                N = vec3(0.0, 1.0, 0.0);
                if (SH.w > 0.5) {
                    float dist = shadowDepth(cSlot, d);
                    if (dist > ${(SHADOW_FAR * 0.5).toFixed(1)}) return false;
                    X = SH.xyz + d * dist;
                    // Normale : deux rayons voisins (≈ 1,5 texel de la cubemap)
                    vec3 t1 = normalize(cross(d, abs(d.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
                    vec3 t2 = cross(d, t1);
                    float e = 3.0 / max(uShadowSize, 1.0);
                    vec3 d1 = normalize(d + t1 * e), d2 = normalize(d + t2 * e);
                    float r1 = shadowDepth(cSlot, d1), r2 = shadowDepth(cSlot, d2);
                    N = -d;
                    if (abs(r1 - dist) < 0.25 * dist && abs(r2 - dist) < 0.25 * dist) {
                        vec3 c = cross(SH.xyz + d1 * r1 - X, SH.xyz + d2 * r2 - X);
                        if (dot(c, c) > 1e-12) N = normalize(c);
                    }
                    if (dot(N, d) > 0.0) N = -N;
                    return true;
                }
                // Pas de cubemap (ombres désactivées, cuisson en attente) : le sol
                if (d.y > -1e-3) return false;
                X = o + d * (-o.y / d.y);
                N = vec3(0.0, 1.0, 0.0);
                return true;
            }

            const vec4 NONE = vec4(0.0, 0.0, 0.0, -1.0);

            void main() {
                ivec2 p = ivec2(gl_FragCoord.xy);
                int i = p.y, k = p.x >> 1;
                if (k >= uK + uM) { gl_FragColor = NONE; return; }
                vec4 A0 = LT(i, 0), A1 = LT(i, 1), A2 = LT(i, 2);
                cW = A1.xyz;
                float zS = A1.w;
                vec3 WV = cW + A2.xyz;
                vec4 A6 = LT(i, 6), A7 = LT(i, 7);
                loadCone(i, A0.xyz, WV, zS, A6);
                if (!(cIrrL > 0.0)) { gl_FragColor = NONE; return; }
                float rDisc = min(cIris, 1.0);
                float range = A7.z, fadeS = A7.w;
                vec4 SH = cSlot >= 0 && uShadowSize > 0.5 ? shadowInfo(cSlot) : vec4(0.0);
                vec3 X = vec3(0.0), N = vec3(0.0, 1.0, 0.0);

                if (k >= uK) {
                    // ── Point le long du faisceau (lumière diffusée par la fumée), jusqu'au décor ──
                    if (uHazeK <= 0.0) { gl_FragColor = NONE; return; }
                    vec3 d = normalize(cW + cTanHalf * (cV.x * cR + cV.y * cU));
                    // Portée complète (pas la longueur visible) : raccourcir le faisceau ne change pas l'éclairage
                    // de la salle ni du sol, comme la tache de lumière
                    float len = min(A7.z, 60.0);
                    if (hitDecor(cLens, d, SH, X, N)) len = min(len, length(X - cLens));
                    int j = k - uK;
                    float u = (float(j) + fract(uSpin * 0.159155 + float(j) * 0.618034)) / float(uM);
                    X = cLens + d * (u * len);
                    // Flux du faisceau (éclairement à 1 m × ouverture) × densité × longueur du tronçon, isotrope (/ 4π)
                    vec3 col = cKind > 1.5 ? cCol * 0.5 : cCol;
                    float flux = cIrrL * uGain * PI * cTanHalf * cTanHalf * rDisc * rDisc;
                    vec3 I = col * (flux * uHazeK * len / float(uM) / (4.0 * PI));
                    if (any(isnan(I)) || any(isinf(I))) { gl_FragColor = NONE; return; }
                    gl_FragColor = (p.x & 1) == 0 ? vec4(X, -2.0) : vec4(I, 1.0);
                    return;
                }

                // ── Rayon k : spirale de Vogel dans le disque de l'iris (unités de fenêtre), tournée à chaque image ──
                float r = sqrt((float(k) + 0.5) / float(uK)) * rDisc;
                float a = float(k) * 2.39996323 + uSpin;
                vec2 g = r * vec2(cos(a), sin(a)) + cV;
                vec3 d = normalize(cW + cTanHalf * (g.x * cR + g.y * cU));
                if (!hitDecor(cLens, d, SH, X, N)) { gl_FragColor = NONE; return; }

                float zA; vec3 lp;
                vec3 gate = gateAtPoint(X, true, zA, lp);
                float zl = zA - zS;
                if (zl <= 0.0 || zl >= range || gate.r + gate.g + gate.b < 1e-5) { gl_FragColor = NONE; return; }
                vec3 albedo; float rough, specK;
                surface(X, N, albedo, rough, specK);
                // Flux réfléchi : albédo × intensité (éclairement à 1 m) × angle solide du rayon
                float t2 = cTanHalf * cTanHalf * dot(g, g);
                float omega = PI * cTanHalf * cTanHalf * rDisc * rDisc / float(uK) / pow(1.0 + t2, 1.5);
                vec3 phi = albedo * gate * (cIrrL * uGain * omega * (1.0 - smoothstep(fadeS, range, zl)));
                if (any(isnan(phi)) || any(isinf(phi))) { gl_FragColor = NONE; return; }
                // Texel pair : position + normale ; impair : Φ / π (intensité diffuse dans l'axe de la normale)
                gl_FragColor = (p.x & 1) == 0 ? vec4(X + N * 0.05, packNormal(N)) : vec4(phi * (1.0 / PI), 1.0);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}

export function createGIGridMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            uVPL:    { value: null },
            uCones:  { value: 0 },
            uK:      { value: 8 },
            uM:      { value: 4 },
            uMin:    { value: new THREE.Vector3() },
            uCell:   { value: new THREE.Vector3(1, 1, 1) },
            uZ:      { value: 0 },
            uR0:     { value: 1 },
            uAlpha:  { value: 1 },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */`
            precision highp float;
            precision highp int;
            ${NORMAL_PACK_GLSL}
            uniform highp sampler2D uVPL;
            uniform int uCones;
            uniform int uK;
            uniform int uM;
            uniform vec3 uMin;
            uniform vec3 uCell;
            uniform float uZ;
            uniform float uR0;
            uniform float uAlpha;

            void main() {
                vec3 P = uMin + vec3(gl_FragCoord.xy, uZ + 0.5) * uCell;
                vec3 E = vec3(0.0);
                for (int i = 0; i < 1024; i++) {
                    if (i >= uCones) break;
                    for (int k = 0; k < ${GI_MAX_VPL_PER_CONE + GI_MAX_BEAM_PTS}; k++) {
                        if (k >= uK + uM) break;
                        vec4 a = texelFetch(uVPL, ivec2(2 * k, i), 0);
                        if (a.w == -1.0) continue;
                        vec3 d = P - a.xyz;
                        float r2 = dot(d, d);
                        float c = 1.0;             // point du faisceau : isotrope
                        if (a.w >= 0.0) {
                            c = dot(unpackNormal(a.w), d) * inversesqrt(r2 + 1e-6);
                            if (c <= 0.0) continue;    // derrière la surface
                        }
                        vec3 f = texelFetch(uVPL, ivec2(2 * k + 1, i), 0).rgb;
                        E += f * (c / (r2 + uR0));
                    }
                }
                gl_FragColor = vec4(min(E, vec3(30000.0)), uAlpha);
            }
        `,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.ZeroFactor,
    });
}
