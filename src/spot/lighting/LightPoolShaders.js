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
 * - Sortie : rgb + profondeur linéaire (a) pour la remontée bilatérale en ½ résolution (FinalCompositePass),
 *   ajoutée à l'image AVANT le brouillard et le bloom (comme les faisceaux).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { GATE_GLSL } from '../SpotShaders.js?v=5';
import { CONE_GLSL } from '../ssdepth/SSConeGLSL.js';
import { SS_TILES_X, SS_TILES_Y, SS_MAX_PER_TILE } from '../ssdepth/SSDepthLights.js';
import { SHADOW_GLSL, createShadowUniforms } from './shadowGLSL.js';

/** Albédo moyen (linéaire) de la pelouse de stage.js */
const GRASS_ALBEDO = [0.073, 0.141, 0.026];
/** Lino noir : 0,025 en moyenne dans la texture, relevé (poussière, micro-rayures d'un plateau réel) pour que les
 *  taches restent lisibles sur le plateau comme avec les anciennes lumières (+35 % de stage.js en plus) */
const LINO_ALBEDO = [0.05, 0.048, 0.056];

/** @param {object} [shadowUniforms] uniformes partagés des ombres statiques */
export function createLightPoolMaterial(shadowUniforms = createShadowUniforms()) {
    return new THREE.ShaderMaterial({
        uniforms: {
            ...shadowUniforms,
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
            uniform highp sampler2D uDepth;
            uniform highp usampler2D uPoolTiles;
            uniform sampler2D uGrass;
            uniform float uGrassOn;
            uniform vec2 uFull;
            uniform float uDiv;
            uniform vec3 uCamPos;
            uniform mat3 uCamRot;
            uniform vec4 uProjK;
            uniform float uNear;
            uniform float uFar;
            uniform float uGain;
            uniform float uSpecOn;

            const float PI = 3.14159265;
            const ivec2 TILES = ivec2(${SS_TILES_X}, ${SS_TILES_Y});

            float linZ(ivec2 p) { return -perspectiveDepthToViewZ(texelFetch(uDepth, p, 0).r, uNear, uFar); }
            vec3 rayView(vec2 px) {
                vec2 ndc = px / uFull * 2.0 - 1.0;
                return vec3((ndc.x + uProjK.z) * uProjK.x, (ndc.y + uProjK.w) * uProjK.y, -1.0);
            }
            vec3 viewPos(ivec2 p) { return rayView(vec2(p) + 0.5) * linZ(p); }

            // Matériau de la surface (pas de G-buffer) : sol, plateau, décor
            void surface(vec3 P, vec3 N, out vec3 albedo, out float rough, out float specK) {
                if (P.y < 0.35 && N.y > 0.6) {
                    // Pelouse (stage.js : texture répétée tous les 5 m), mate
                    albedo = uGrassOn > 0.5 ? texture(uGrass, P.xz * 0.2).rgb : vec3(${GRASS_ALBEDO.join(', ')});
                    rough = 0.9;
                    specK = 0.4;
                } else if (N.y > 0.75) {
                    // Dessus du plateau, des marches, de la table : lino noir brillant (piste de danse)
                    albedo = vec3(${LINO_ALBEDO.join(', ')}) * 1.35;
                    rough = 0.3;
                    specK = 1.5;
                } else {
                    // Reste du décor : lino satiné (mur, poteaux, toit, enceintes…)
                    albedo = vec3(${LINO_ALBEDO.join(', ')}) * 1.35;
                    rough = 0.6;
                    specK = 1.0;
                }
            }

            void main() {
                ivec2 lo = ivec2(gl_FragCoord.xy);
                ivec2 fullI = ivec2(uFull);
                ivec2 c = min(ivec2((vec2(lo) + 0.5) * uDiv), fullI - 1);
                float depth = linZ(c);
                if (depth > uFar * 0.98) { gl_FragColor = vec4(0.0, 0.0, 0.0, depth); return; }

                vec2 pc = vec2(c) + 0.5;
                ivec2 tile = min(ivec2(pc / uFull * vec2(TILES)), TILES - 1);
                int tIdx = tile.y * TILES.x + tile.x;
                int n = int(texelFetch(uPoolTiles, ivec2(0, tIdx), 0).x);
                if (n == 0) { gl_FragColor = vec4(0.0, 0.0, 0.0, depth); return; }

                vec3 vp = rayView(pc) * depth;
                vec3 P = uCamPos + uCamRot * vp;
                vec3 V = normalize(uCamPos - P);
                bool haveN = false;
                vec3 N = vec3(0.0, 1.0, 0.0);
                vec3 albedo = vec3(0.0);
                float rough = 1.0, specK = 0.0, a2 = 1.0;

                vec3 acc = vec3(0.0);
                uvec4 idx4 = uvec4(0u);
                for (int k = 0; k < ${SS_MAX_PER_TILE}; k++) {
                    if (k >= n) break;
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
                        vec3 pl = viewPos(max(c - ivec2(1, 0), ivec2(0))), pr = viewPos(min(c + ivec2(1, 0), fullI - 1));
                        vec3 pd = viewPos(max(c - ivec2(0, 1), ivec2(0))), pu = viewPos(min(c + ivec2(0, 1), fullI - 1));
                        // Bord de l'image : seul le voisin intérieur existe
                        bool useR = c.x == 0 || (c.x < fullI.x - 1 && abs(pr.z - vp.z) < abs(vp.z - pl.z));
                        bool useU = c.y == 0 || (c.y < fullI.y - 1 && abs(pu.z - vp.z) < abs(vp.z - pd.z));
                        vec3 dx = useR ? pr - vp : vp - pl;
                        vec3 dy = useU ? pu - vp : vp - pd;
                        vec3 cr = cross(dx, dy);
                        vec3 nv = dot(cr, cr) > 1e-20 ? normalize(cr) : -normalize(vp);
                        if (dot(nv, vp) > 0.0) nv = -nv;
                        N = normalize(uCamRot * nv);
                        surface(P, N, albedo, rough, specK);
                        float a = rough * rough;
                        a2 = a * a;
                    }

                    loadCone(i, apex, WV, zS, A6);
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
                // Garde-fou : une valeur invalide se propagerait au halo et au bloom
                if (any(isnan(acc)) || any(isinf(acc))) acc = vec3(0.0);
                gl_FragColor = vec4(min(acc, vec3(60000.0)), depth);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}
