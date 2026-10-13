/**
 * BeamReflectShaders.js
 * ─────────────────────────────────────────────────────────────
 * REFLETS DES FAISCEAUX sur les surfaces brillantes (plan R6), en basse résolution (¼ ou ⅛ de l'image) :
 *
 * 1. PASSE MIROIR (createBeamReflectMaterial) : pour chaque pixel réduit, profondeur → point du décor,
 *    normale reconstruite, matériau (classement des taches de lumière : seul le dessus du plateau, lino noir
 *    brillant, est réfléchissant ; les autres surfaces sortent tout de suite). Rayon de vue réfléchi autour
 *    de la normale ; diffusion des faisceaux SS Depth intégrée le long de ce rayon, exactement comme les
 *    faisceaux vus directement (SSBeamGLSL : intersection exacte, 3 échantillons, gobos, ombres), avec la
 *    liste de cônes de la tuile triée en miroir (SSReflectBins). Pondération de Fresnel (Schlick, F0 = 0,04)
 *    × brillance du lino. Le rayon réfléchi n'a pas de profondeur : il s'arrête au bout du faisceau ou
 *    dans l'ombre (le toit coupe déjà les faisceaux par les ombres statiques).
 * 2. FLOU DE RUGOSITÉ (createReflectBlurMaterial) : 3 × 3 texels écartés, pondérés par la profondeur
 *    (pas de fuite d'un objet à l'autre) — lino satiné : le reflet est flou.
 * Sortie rgb + profondeur linéaire (a) : remontée bilatérale par FinalCompositePass, avant le brouillard.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { GATE_GLSL } from '../SpotShaders.js?v=5';
import { occluderUniforms } from '../SpotOcclusion.js';
import { CONE_GLSL } from '../ssdepth/SSConeGLSL.js';
import { BEAM_RAY_GLSL } from '../ssdepth/SSBeamGLSL.js';
import { SS_TILES_X, SS_TILES_Y, SS_MAX_PER_TILE } from '../ssdepth/SSDepthLights.js';
import { SHADOW_GLSL } from '../lighting/shadowGLSL.js';
import { SCREEN_GLSL } from '../lighting/surfaceGLSL.js';

const VERT = /* glsl */`
    void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** @param {object} shadowUniforms uniformes partagés des ombres statiques */
export function createBeamReflectMaterial(shadowUniforms) {
    const occ = occluderUniforms();
    return new THREE.ShaderMaterial({
        uniforms: {
            ...shadowUniforms,
            uDepth:      { value: null },
            uSpotParams: { value: null },
            uGobos:      { value: null },
            uGateAtlas:  { value: null },
            uSSLights:   { value: null },
            uReflTiles:  { value: null },
            uBoxMin:     { value: occ.mins },
            uBoxMax:     { value: occ.maxs },
            uFull:       { value: new THREE.Vector2(1, 1) },
            uDiv:        { value: 4 },
            uCamPos:     { value: new THREE.Vector3() },
            uCamRot:     { value: new THREE.Matrix3() },
            uProjK:      { value: new THREE.Vector4(1, 1, 0, 0) },
            uNear:       { value: 0.1 },
            uFar:        { value: 5000 },
            uHazeK:      { value: 0.6 * 0.035 },
            uPhaseG:     { value: 0.72 },
            uPlaneY:     { value: 3.0 },
            uPlaneTol:   { value: 0.15 },
            uGain:       { value: 1 },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */`
            precision highp float;
            precision highp int;
            #include <packing>
            ${GATE_GLSL}
            ${CONE_GLSL}
            ${SHADOW_GLSL}
            ${BEAM_RAY_GLSL}
            ${SCREEN_GLSL}
            uniform highp usampler2D uReflTiles;
            uniform float uDiv;
            uniform vec3 uCamPos;
            uniform float uHazeK;
            uniform float uPlaneY;
            uniform float uPlaneTol;
            uniform float uGain;

            const ivec2 TILES = ivec2(${SS_TILES_X}, ${SS_TILES_Y});
            // Lino noir brillant du plateau (taches de lumière : rugosité 0,3, spéculaire × 1,5)
            const float SPEC_K = 1.5;

            void main() {
                ivec2 lo = ivec2(gl_FragCoord.xy);
                ivec2 fullI = ivec2(uFull);
                ivec2 c = min(ivec2((vec2(lo) + 0.5) * uDiv), fullI - 1);
                float depth = linZ(c);
                vec2 pc = vec2(c) + 0.5;
                ivec2 tile = min(ivec2(pc / uFull * vec2(TILES)), TILES - 1);
                int tIdx = tile.y * TILES.x + tile.x;
                int n = int(texelFetch(uReflTiles, ivec2(0, tIdx), 0).x);
                if (n == 0 || depth > uFar * 0.98) { gl_FragColor = vec4(0.0, 0.0, 0.0, depth); return; }

                vec3 vp = rayView(pc) * depth;
                vec3 P = uCamPos + uCamRot * vp;
                // Surface brillante : dessus du plateau (plan de tri des cônes)
                if (abs(P.y - uPlaneY) > uPlaneTol) { gl_FragColor = vec4(0.0, 0.0, 0.0, depth); return; }
                vec3 N = screenNormal(c, vp);
                if (N.y < 0.9) { gl_FragColor = vec4(0.0, 0.0, 0.0, depth); return; }

                vec3 V = normalize(uCamPos - P);
                vec3 rd = reflect(-V, N);
                vec3 ro = P + N * 0.02;
                float NoV = max(dot(N, V), 0.0);
                float F = 0.04 + 0.96 * pow(1.0 - NoV, 5.0);

                vec3 acc = vec3(0.0);
                uvec4 idx4 = uvec4(0u);
                for (int k = 0; k < ${SS_MAX_PER_TILE}; k++) {
                    if (k >= n) break;
                    if ((k & 3) == 0) idx4 = texelFetch(uReflTiles, ivec2(1 + (k >> 2), tIdx), 0);
                    int i = int(idx4[k & 3]);
                    vec4 A0 = LT(i, 0), A1 = LT(i, 1), A2 = LT(i, 2);
                    cW = A1.xyz;
                    float zS = A1.w;
                    vec3 WV = cW + A2.xyz;
                    float tin, tout, z0, dz;
                    if (!coneRay(ro, rd, A0.xyz, A0.w, zS, WV, A2.w, 400.0, tin, tout, z0, dz)) continue;
                    vec4 A6 = LT(i, 6), A7 = LT(i, 7);
                    float beamEnd = A7.x, fadeB = A7.y;
                    if (!clipBeamEnd(zS, beamEnd, z0, dz, tin, tout)) continue;
                    loadCone(i, A0.xyz, WV, zS, A6);
                    float irr = LT(i, 4).w;
                    vec4 SH = cSlot >= 0 && uShadowSize > 0.5 ? shadowInfo(cSlot) : vec4(0.0);
                    bool hasCube = SH.w > 0.5;
                    bool hasOcc = !hasCube && A6.w > 0.5;
                    vec4 T8 = hasOcc ? spotParam(cRow, 8) : vec4(-1.0);
                    acc += beamScatter(ro, rd, tin, tout, dz, zS, fadeB, beamEnd, SH, hasCube, hasOcc, T8) * (irr * uHazeK);
                }
                acc *= F * SPEC_K * uGain;
                if (any(isnan(acc)) || any(isinf(acc))) acc = vec3(0.0);
                gl_FragColor = vec4(min(acc, vec3(60000.0)), depth);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}

export function createReflectBlurMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            tSrc:   { value: null },
            uStep:  { value: 1.5 },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */`
            precision highp float;
            uniform sampler2D tSrc;
            uniform float uStep;
            void main() {
                ivec2 p = ivec2(gl_FragCoord.xy);
                ivec2 size = textureSize(tSrc, 0);
                vec4 c = texelFetch(tSrc, p, 0);
                float cz = max(c.a, 0.1);
                vec2 texel = 1.0 / vec2(size);
                vec2 uv = (vec2(p) + 0.5) * texel;
                vec3 sum = c.rgb;
                float wSum = 1.0;
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        if (dx == 0 && dy == 0) continue;
                        // Lecture bilinéaire entre les texels : 9 lectures couvrent ≈ (2 × pas + 1)² texels
                        vec4 s = texture(tSrc, uv + vec2(float(dx), float(dy)) * uStep * texel);
                        float rel = abs(max(s.a, 0.1) - cz) / cz;
                        float w = (dx == 0 || dy == 0 ? 0.6 : 0.4) * exp(-rel * rel * 60.0);
                        sum += s.rgb * w;
                        wSum += w;
                    }
                }
                gl_FragColor = vec4(sum / wSum, c.a);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}
