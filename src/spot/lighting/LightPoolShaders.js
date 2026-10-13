/**
 * LightPoolShaders.js
 * ─────────────────────────────────────────────────────────────
 * TACHES DE LUMIÈRE de toutes les lyres (plan R4), en espace écran : une passe plein écran (pleine résolution
 * ou ½) qui lit la profondeur de la scène et, pour chaque pixel, parcourt les cônes de sa tuile
 * (SSDepthLights, liste des taches) :
 *
 *   éclairement = image de fenêtre (gobos, couteaux, couleurs, prisme = un cône par facette)
 *                 × lumière émise / (π tan² z²) × ombre statique (PCF 2 × 2) × N·L
 *   luminance   = éclairement × (albédo / π + spéculaire Cook-Torrance GGX)
 *
 * - Normales : reconstruites depuis la profondeur (côté de plus petit écart en x et en y : pas de halo sur
 *   les silhouettes). Pas de passe de normales supplémentaire (le relief des normal maps est ignoré).
 * - Matériaux : pas de G-buffer d'albédo → classement par la position / la normale, comme le banc C++ :
 *   sol (herbe : texture de la pelouse, mat), dessus du plateau et des praticables (lino noir brillant),
 *   reste du décor (lino, satiné). Rugosité et albédo proches des matériaux de stage.js.
 * - LUMIÈRE INDIRECTE (GI, phase C) : quand la grille de GI est active (gi/GIGridPass.js), chaque pixel du
 *   décor reçoit aussi le rebond lu dans la grille un peu devant la surface : albédo / π × éclairement
 *   indirect × gain (normale et matériau calculés pour tous les pixels, même hors des cônes).
 * - Sortie : rgb + profondeur linéaire (a) pour la remontée bilatérale en ½ résolution (FinalCompositePass),
 *   ajoutée à l'image AVANT le brouillard et le bloom (comme les faisceaux).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { GATE_GLSL } from '../SpotShaders.js?v=5';
import { CONE_GLSL } from '../ssdepth/SSConeGLSL.js';
import { SS_TILES_X, SS_TILES_Y, SS_MAX_PER_TILE } from '../ssdepth/SSDepthLights.js';
import { SHADOW_GLSL, createShadowUniforms } from './shadowGLSL.js';
import { SCREEN_GLSL, SURFACE_GLSL } from './surfaceGLSL.js';
import { GI_GLSL, createGIUniforms } from '../gi/giGLSL.js';

/**
 * @param {object} [shadowUniforms] uniformes partagés des ombres statiques
 * @param {object} [giUniforms] uniformes partagés de la grille de GI
 */
export function createLightPoolMaterial(shadowUniforms = createShadowUniforms(), giUniforms = createGIUniforms(), { refine = false } = {}) {
    return new THREE.ShaderMaterial({
        defines: refine ? { REFINE: 1 } : {},
        uniforms: {
            tLow:        { value: null },   // retouche : taches en ½ (a = profondeur)
            uLowScale:   { value: new THREE.Vector2(1, 1) },
            uSharp:      { value: 1.5 },
            ...shadowUniforms,
            ...giUniforms,
            uGIGain:     { value: 0 },     // 0 = pas de lumière indirecte
            uGIOffset:   { value: 0.7 },   // lecture de la grille devant la surface (m)
            uPoolsOn:    { value: 1 },     // 0 = GI seule (taches de lumière désactivées)
            uDepth:      { value: null },
            uSpotParams: { value: null },
            uGobos:      { value: null },
            uGateAtlas:  { value: null },
            uSSLights:   { value: null },
            uPoolTiles:  { value: null },
            uGrass:      { value: null },
            uGrassOn:    { value: 0 },
            uFull:       { value: new THREE.Vector2(1, 1) },
            uDiv:        { value: 1 },
            uCamPos:     { value: new THREE.Vector3() },
            uCamRot:     { value: new THREE.Matrix3() },
            uProjK:      { value: new THREE.Vector4(1, 1, 0, 0) },
            uNear:       { value: 0.1 },
            uFar:        { value: 5000 },
            uGain:       { value: 60 },    // lumière émise → éclairement (même échelle que les anciennes SpotLight)
            uSpecOn:     { value: 1 },
            uSat:        { value: 3 },     // éclairement au-delà duquel la surface est blanche
        },
        vertexShader: /* glsl */`
            void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
        `,
        fragmentShader: /* glsl */`
            precision highp float;
            precision highp int;
            #include <packing>
            ${GATE_GLSL}
            ${CONE_GLSL}
            ${SHADOW_GLSL}
            ${SCREEN_GLSL}
            ${SURFACE_GLSL}
            ${GI_GLSL}
            uniform highp usampler2D uPoolTiles;
            uniform float uDiv;
            uniform vec3 uCamPos;
            uniform float uGain;
            uniform float uSpecOn;
            uniform float uGIGain;
            uniform float uGIOffset;
            uniform float uPoolsOn;
            uniform float uSat;

            const float PI = 3.14159265;
            const ivec2 TILES = ivec2(${SS_TILES_X}, ${SS_TILES_Y});

            // Taches (et rebond de la GI) au pixel pleine résolution c, de profondeur linéaire depth
            vec3 shadePool(ivec2 c, float depth) {

                vec2 pc = vec2(c) + 0.5;
                ivec2 tile = min(ivec2(pc / uFull * vec2(TILES)), TILES - 1);
                int tIdx = tile.y * TILES.x + tile.x;
                int n = uPoolsOn > 0.5 ? int(texelFetch(uPoolTiles, ivec2(0, tIdx), 0).x) : 0;
                bool gi = uGIGain > 0.0;
                if (n == 0 && !gi) return vec3(0.0);

                vec3 vp = rayView(pc) * depth;
                vec3 P = uCamPos + uCamRot * vp;
                vec3 V = normalize(uCamPos - P);
                bool haveN = false;
                vec3 N = vec3(0.0, 1.0, 0.0);
                vec3 albedo = vec3(0.0);
                float rough = 1.0, specK = 0.0, a2 = 1.0;

                vec3 acc = vec3(0.0);
                // Lumière indirecte : normale et matériau pour tous les pixels, grille lue devant la surface
                if (gi) {
                    haveN = true;
                    N = screenNormal(c, vp);
                    surface(P, N, albedo, rough, specK);
                    float a = rough * rough;
                    a2 = a * a;
                    acc += albedo * (uGIGain / PI) * giAt(P + N * uGIOffset);
                }
                uvec4 idx4 = uvec4(0u);
                int hits = 0;
                for (int k = 0; k < ${SS_MAX_PER_TILE}; k++) {
                    // Surface déjà blanche (uSat) ou 48 taches calculées (les plus lumineuses : listes triées par
                    // importance) : les suivantes ne se verraient pas
                    if (k >= n || hits >= 48 || all(greaterThanEqual(acc, vec3(uSat)))) break;
                    if ((k & 3) == 0) idx4 = texelFetch(uPoolTiles, ivec2(1 + (k >> 2), tIdx), 0);
                    int i = int(idx4[k & 3]);

                    // ── Le point est-il dans le cône ? (3 lectures) ──
                    vec4 A0 = LT(i, 0), A1 = LT(i, 1), A2 = LT(i, 2);
                    vec3 apex = A0.xyz;
                    cW = A1.xyz;
                    float zS = A1.w;
                    vec3 WV = cW + A2.xyz;
                    vec3 qs = P - apex;
                    float zs = dot(qs, cW);
                    vec3 rs = qs - WV * zs;
                    if (zs <= zS || dot(rs, rs) >= A0.w * A0.w * zs * zs) continue;

                    vec4 A6 = LT(i, 6), A7 = LT(i, 7);
                    float range = A7.z, fadeS = A7.w;
                    if (zs - zS >= range) continue;

                    // Normale et matériau : une seule fois, au premier cône qui touche le pixel
                    if (!haveN) {
                        haveN = true;
                        N = screenNormal(c, vp);
                        surface(P, N, albedo, rough, specK);
                        float a = rough * rough;
                        a2 = a * a;
                    }

                    loadCone(i, apex, WV, zS, A6);
                    if (dot(step(vec3(1e-4), cCol), step(acc, vec3(uSat))) < 0.5) continue;
                    hits++;
                    float zA; vec3 lp;
                    vec3 gate = gateAtPoint(P, true, zA, lp);
                    if (gate.r + gate.g + gate.b < 1e-5) continue;
                    float dl = length(lp);
                    vec3 L = -lp / max(dl, 1e-4);
                    float ndl = dot(N, L);
                    if (ndl <= 0.0) continue;

                    // Ombre statique (cubemap de la lyre), décalage le long de la normale + biais de pente
                    float sh = 1.0;
                    if (cSlot >= 0 && uShadowSize > 0.5) {
                        vec4 SH = shadowInfo(cSlot);
                        if (SH.w > 0.5) {
                            float d = length(P - SH.xyz);
                            float ts = shadowTexelSize(d);
                            sh = shadowPCF(cSlot, SH.xyz, P + N * (0.5 * ts + 0.02), 0.03 + ts * 1.5 / max(ndl, 0.25));
                            if (sh <= 0.0) continue;
                        }
                    }

                    float zl = zA - zS;
                    float E = cIrrL * uGain / (zA * zA) * (1.0 - smoothstep(fadeS, range, zl)) * ndl * sh;
                    vec3 brdf = albedo * (1.0 / PI);
                    if (uSpecOn > 0.5) {
                        // Cook-Torrance : GGX, Fresnel de Schlick (F0 = 0,04), visibilité de Kelemen (comme le banc C++)
                        vec3 H = normalize(L + V);
                        float NoH = max(dot(N, H), 0.0), VoH = max(dot(V, H), 0.0), LoH = max(dot(L, H), 0.0);
                        float dd = NoH * NoH * (a2 - 1.0) + 1.0;
                        float D = a2 / (PI * dd * dd);
                        float F = 0.04 + 0.96 * pow(1.0 - VoH, 5.0);
                        float vis = 0.25 / max(LoH * LoH, 0.05);
                        brdf += vec3(D * F * vis * specK);
                    }
                    acc += gate * brdf * E;
                }
                // Garde-fou : une valeur invalide se propagerait au bloom
                if (any(isnan(acc)) || any(isinf(acc))) acc = vec3(0.0);
                return min(acc, vec3(60000.0));
            }

        #ifndef REFINE
            void main() {
                ivec2 lo = ivec2(gl_FragCoord.xy);
                ivec2 fullI = ivec2(uFull);
                ivec2 c = min(ivec2((vec2(lo) + 0.5) * uDiv), fullI - 1);
                float depth = linZ(c);
                if (depth > uFar * 0.98) { gl_FragColor = vec4(0.0, 0.0, 0.0, depth); return; }
                gl_FragColor = vec4(shadePool(c, depth), depth);
            }
        #else
            // Retouche des bords en pleine résolution : pixels dont les 3×3 voisins réduits diffèrent (bord d'une
            // tache, d'une ombre, d'un objet) recalculés exactement ; ailleurs remontée bilatérale guidée par la profondeur
            uniform sampler2D tLow;
            uniform vec2 uLowScale;
            uniform float uSharp;
            void main() {
                ivec2 p = ivec2(gl_FragCoord.xy);
                float depth = linZ(p);
                if (depth > uFar * 0.98) { gl_FragColor = vec4(0.0); return; }
                float cz = max(depth, 0.1);
                vec2 suv = (vec2(p) + 0.5) / uFull * uLowScale;
                ivec2 size = textureSize(tLow, 0);
                vec2 pos = suv * vec2(size) - 0.5;
                ivec2 cc = ivec2(floor(pos + 0.5));
                vec2 f = pos - vec2(cc);
                float lMin = 1e9, lMax = 0.0;
                bool depthEdge = false;
                float sharp = 35.0 * uSharp;
                vec3 sum = vec3(0.0);
                float wSum = 0.0;
                for (int k = 0; k < 9; k++) {
                    ivec2 o = ivec2(k % 3 - 1, k / 3 - 1);
                    vec4 s = texelFetch(tLow, clamp(cc + o, ivec2(0), size - 1), 0);
                    float l = s.r + s.g + s.b;
                    lMin = min(lMin, l);
                    lMax = max(lMax, l);
                    float rel = abs(cz - s.a) / max(cz, 0.5);
                    if (rel > 0.1) depthEdge = true;
                    vec2 d = abs(vec2(o) - f);
                    float w = (max(0.0, 1.0 - d.x) * max(0.0, 1.0 - d.y) + 0.02) * exp(-rel * rel * sharp);
                    sum += s.rgb * w;
                    wSum += w;
                }
                bool edge = depthEdge || (lMax > 0.003 && lMax - lMin > 0.15 * lMax);
                if (edge) {
                    // Tuile chargée (plus de 24 taches) : remontée seule (recalculer des centaines de cônes sur
                    // chaque pixel de bord coûtait plus de 10 ms ; le détail ne s'y voit pas)
                    vec2 pc = vec2(p) + 0.5;
                    ivec2 tile = min(ivec2(pc / uFull * vec2(TILES)), TILES - 1);
                    int n = int(texelFetch(uPoolTiles, ivec2(0, tile.y * TILES.x + tile.x), 0).x);
                    if (n > 24) edge = false;
                }
                if (!edge) { gl_FragColor = vec4(wSum > 1e-3 ? sum / wSum : vec3(0.0), 1.0); return; }
                gl_FragColor = vec4(shadePool(p, depth), 1.0);
            }
        #endif
        `,
        depthTest: false,
        depthWrite: false,
    });
}
