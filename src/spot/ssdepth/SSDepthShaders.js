/**
 * SSDepthShaders.js
 * ─────────────────────────────────────────────────────────────
 * Shaders des faisceaux « SS Depth » (adaptation WebGL2 du mode 5 du banc LightBench) :
 *
 * 1. PASSE DES FAISCEAUX (createSSBeamMaterial), en basse résolution (½, ⅓ ou ¼ de l'image) :
 *    - profondeur réduite en DAMIER min/max (2×2 texels de la profondeur de la scène) : les silhouettes
 *      fines restent présentes dans un pixel sur deux ;
 *    - rayon de vue reconstruit, liste des cônes de la tuile (SSDepthLights.bin) ;
 *    - par cône : rejet par sphère englobante, intersection EXACTE rayon / cône oblique (facette du prisme)
 *      bornée par la lentille, la longueur visible et la profondeur de la scène ;
 *    - diffusion intégrée par QUADRATURE DE GAUSS à 3 points (0,2113 / 0,5 / 0,7887, poids 0,28 / 0,44 / 0,28),
 *      répartis en 1/z quand le rayon remonte le faisceau (éclairement en 1/z² intégré exactement) ;
 *      image de fenêtre complète (gobos, couteaux, demi-couleurs, animation) sur l'échantillon du milieu,
 *      lue dans l'atlas (1 lecture) aux 2 autres quand la lyre en a une ; phase de Mie (Henyey-Greenstein,
 *      même formule que le rendu classique) ; pas de bruit de fumée ;
 *    - OMBRE à chaque échantillon : cubemap statique de la lyre (lighting/SpotShadowAtlas.js, 1 lecture) quand
 *      elle est cuite, sinon boîtes de SpotOcclusion ;
 *    - tache simple sur la surface seulement si la passe des taches de lumière (lighting/LightPoolPass.js)
 *      est désactivée ;
 *    - sortie : rgb = faisceaux, a = profondeur linéaire du pixel réduit (pour la remontée bilatérale).
 *
 * 2. HALO ATMOSPHÉRIQUE (createSSHaloMaterial), même résolution : 8 échantillons (disque de Poisson tourné
 *    par pixel) de l'image de la scène + faisceaux, occultation ASYMÉTRIQUE par la profondeur (un objet au
 *    premier plan bloque la lumière de derrière, une lumière devant un mur diffuse librement son halo).
 *    Sortie = faisceaux + halo (tout est additif) : une seule remontée dans la passe finale.
 *
 * 3. La remontée bilatérale 3×3 guidée par la profondeur est faite par FinalCompositePass (avant le
 *    brouillard : transmittance et bloom s'appliquent aux faisceaux SS comme aux faisceaux classiques).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { GATE_GLSL } from '../SpotShaders.js?v=5';
import { occluderUniforms, MAX_OCCLUDERS } from '../SpotOcclusion.js';
import { SS_TILES_X, SS_TILES_Y, SS_MAX_PER_TILE } from './SSDepthLights.js';
import { CONE_GLSL } from './SSConeGLSL.js';
import { SHADOW_GLSL, createShadowUniforms } from '../lighting/shadowGLSL.js';

const VERT = /* glsl */`
    void main() {
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

/** @param {object} [shadowUniforms] uniformes partagés des ombres statiques (SpotShadowAtlas.uniforms) */
export function createSSBeamMaterial(shadowUniforms = createShadowUniforms()) {
    const occ = occluderUniforms();
    return new THREE.ShaderMaterial({
        uniforms: {
            ...shadowUniforms,
            uDepth:      { value: null },
            uSpotParams: { value: null },
            uGobos:      { value: null },
            uGateAtlas:  { value: null },
            uSSLights:   { value: null },
            uSSTiles:    { value: null },
            uBoxMin:     { value: occ.mins },
            uBoxMax:     { value: occ.maxs },
            uFull:       { value: new THREE.Vector2(1, 1) },   // taille de l'image (pixels)
            uDiv:        { value: 3 },
            uCamPos:     { value: new THREE.Vector3() },
            uCamRot:     { value: new THREE.Matrix3() },
            uProjK:      { value: new THREE.Vector4(1, 1, 0, 0) }, // 1/P0, 1/P5, P8, P9
            uNear:       { value: 0.1 },
            uFar:        { value: 5000 },
            uHazeK:      { value: 0.6 * 0.035 },
            uPhaseG:     { value: 0.72 },
            uSplashOn:   { value: 1 },     // tache simple sur la surface (passe des taches désactivée)
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */`
            precision highp float;
            precision highp int;
            #include <packing>
            ${GATE_GLSL}
            ${CONE_GLSL}
            ${SHADOW_GLSL}
            uniform highp sampler2D uDepth;
            uniform highp usampler2D uSSTiles;
            uniform vec3 uBoxMin[${MAX_OCCLUDERS}];
            uniform vec3 uBoxMax[${MAX_OCCLUDERS}];
            uniform vec2 uFull;
            uniform float uDiv;
            uniform vec3 uCamPos;
            uniform mat3 uCamRot;
            uniform vec4 uProjK;
            uniform float uNear;
            uniform float uFar;
            uniform float uHazeK;
            uniform float uPhaseG;
            uniform float uSplashOn;

            const float PI = 3.14159265;
            const ivec2 TILES = ivec2(${SS_TILES_X}, ${SS_TILES_Y});

            float linZ(ivec2 p) { return -perspectiveDepthToViewZ(texelFetch(uDepth, p, 0).r, uNear, uFar); }
            vec3 rayView(vec2 px) {
                vec2 ndc = px / uFull * 2.0 - 1.0;
                return vec3((ndc.x + uProjK.z) * uProjK.x, (ndc.y + uProjK.w) * uProjK.y, -1.0);
            }

            // Le segment a → a + d·t (t < tMax) traverse-t-il un des obstacles de la lyre ? (comme le rendu classique)
            bool segBlocked(vec3 a, vec3 d, float tMax, vec4 idx) {
                vec3 dd = mix(vec3(1e-7), d, step(1e-7, abs(d)));
                vec3 inv = 1.0 / dd;
                for (int k = 0; k < 4; k++) {
                    float fi = idx[k];
                    if (fi < 0.0) break;
                    int i = int(fi + 0.5);
                    vec3 t0 = (uBoxMin[i] - a) * inv;
                    vec3 t1 = (uBoxMax[i] - a) * inv;
                    vec3 tl = min(t0, t1);
                    vec3 th = max(t0, t1);
                    float tn = max(max(tl.x, tl.y), tl.z);
                    float tf = min(min(th.x, th.y), th.z);
                    if (tn <= tf && tf > 0.0 && tn < tMax) return true;
                }
                return false;
            }

            // Phase de diffusion : identique au rendu classique (35 % Henyey-Greenstein + 65 % isotrope)
            float phase(float cosT) {
                float g = uPhaseG;
                float x = max(1e-4, 1.0 + g * g - 2.0 * g * cosT);
                float hg = (1.0 - g * g) * inversesqrt(x) / x;
                return 0.65 + 0.35 * hg;
            }

            void main() {
                ivec2 lo = ivec2(gl_FragCoord.xy);
                ivec2 fullI = ivec2(uFull);
                // Profondeur réduite en damier min / max sur 2×2 texels au centre du bloc
                ivec2 b = clamp(ivec2(floor((vec2(lo) + 0.5) * uDiv - 0.5)), ivec2(0), fullI - 2);
                float d00 = linZ(b), d10 = linZ(b + ivec2(1, 0)), d01 = linZ(b + ivec2(0, 1)), d11 = linZ(b + ivec2(1, 1));
                float dMin = min(min(d00, d10), min(d01, d11));
                float dMax = max(max(d00, d10), max(d01, d11));
                // Damier seulement sur une vraie discontinuité (silhouette) ; surface continue (même de biais) :
                // profondeur moyenne, sinon le damier se verrait (écart que la remontée bilatérale ne sépare pas)
                float viewDepth = (dMax - dMin) < 0.1 * max(dMin, 0.5) ? 0.5 * (dMin + dMax)
                                : (((lo.x + lo.y) & 1) == 0 ? dMin : dMax);

                vec2 pc = vec2(b) + 1.0;
                ivec2 tile = min(ivec2(pc / uFull * vec2(TILES)), TILES - 1);
                int tIdx = tile.y * TILES.x + tile.x;
                int n = int(texelFetch(uSSTiles, ivec2(0, tIdx), 0).x);
                if (n == 0) { gl_FragColor = vec4(0.0, 0.0, 0.0, viewDepth); return; }

                vec3 rv = rayView(pc);
                vec3 rd = normalize(uCamRot * rv);
                vec3 ro = uCamPos;
                float surfDist = viewDepth * length(rv);
                bool sky = viewDepth > uFar * 0.98;
                vec3 sceneP = ro + rd * surfDist;
                vec3 nrm = vec3(0.0);
                bool haveN = false;

                vec3 acc = vec3(0.0);
                uvec4 idx4 = uvec4(0u);
                for (int k = 0; k < ${SS_MAX_PER_TILE}; k++) {
                    if (k >= n) break;
                    if ((k & 3) == 0) idx4 = texelFetch(uSSTiles, ivec2(1 + (k >> 2), tIdx), 0);
                    int i = int(idx4[k & 3]);

                    // ── Test d'intersection : 3 lectures seulement (un cône que le pixel ne touche pas ne coûte que ça) ──
                    vec4 A0 = LT(i, 0), A1 = LT(i, 1), A2 = LT(i, 2);
                    vec3 apex = A0.xyz;
                    float tanO = A0.w;
                    cW = A1.xyz;
                    float zS = A1.w;            // lentille (z depuis l'apex) = distance apex → lentille
                    vec3 WV = cW + A2.xyz;      // centre des sections : apex + WV·z
                    float zE = A2.w;

                    // Intersection rayon ↔ cône oblique, bornée par les plans z ∈ [zS, zE]
                    vec3 q = ro - apex;
                    float z0 = dot(q, cW), dz = dot(rd, cW);
                    vec3 qa = q - WV * z0;
                    vec3 qb = rd - WV * dz;
                    float k2 = tanO * tanO;
                    float QA = dot(qb, qb) - k2 * dz * dz;
                    float QB = dot(qa, qb) - k2 * z0 * dz;
                    float QC = dot(qa, qa) - k2 * z0 * z0;
                    float tin = -1e9, tout = 1e9;
                    bool hit = true;
                    if (abs(dz) > 1e-6) {
                        float ta = (zS - z0) / dz, tb = (zE - z0) / dz;
                        tin = min(ta, tb); tout = max(ta, tb);
                    } else if (z0 < zS || z0 > zE) hit = false;
                    if (hit) {
                        float disc = QB * QB - QA * QC;
                        if (abs(QA) < 1e-9) {
                            if (abs(QB) > 1e-9) {
                                float ts = -QC / (2.0 * QB);
                                if (QB > 0.0) tout = min(tout, ts); else tin = max(tin, ts);
                            } else if (QC > 0.0) hit = false;
                        } else if (QA > 0.0) {
                            if (disc < 0.0) hit = false;
                            else {
                                float sq = sqrt(disc);
                                tin = max(tin, (-QB - sq) / QA);
                                tout = min(tout, (-QB + sq) / QA);
                            }
                        } else if (disc > 0.0) {
                            // Double cône ouvert vers le rayon : la partie avant (z > 0) est d'un seul tenant
                            float sq = sqrt(disc);
                            float r1 = (-QB + sq) / QA, r2 = (-QB - sq) / QA;   // QA < 0 : r1 < r2
                            if (!(r2 <= tin || r1 >= tout)) {
                                if (r1 > tin) tout = min(tout, r1); else tin = max(tin, r2);
                            }
                        }
                        tin = max(tin, 0.0);
                        tout = min(tout, surfDist);
                        hit = tout > tin;
                    }
                    // Surface du pixel dans le cône (tache au sol possible) ?
                    bool inSurf = false;
                    if (!sky && uSplashOn > 0.5) {
                        vec3 qs = sceneP - apex;
                        float zs = dot(qs, cW);
                        vec3 rs = qs - WV * zs;
                        inSurf = zs > zS && zs < zE && dot(rs, rs) < k2 * zs * zs;
                    }
                    if (!hit && !inSurf) continue;

                    vec4 A6 = LT(i, 6), A7 = LT(i, 7);
                    float splashW = A6.z;
                    float beamEnd = A7.x, fadeB = A7.y, range = A7.z, fadeS = A7.w;
                    // Diffusion arrêtée à la longueur visible (le cône va plus loin quand la tache au sol porte plus loin)
                    if (hit) {
                        float zEnd = zS + beamEnd;
                        if (abs(dz) > 1e-6) {
                            float tl = (zEnd - z0) / dz;
                            if (dz > 0.0) tout = min(tout, tl); else tin = max(tin, tl);
                        } else if (z0 > zEnd) tout = tin;
                        hit = tout > tin;
                    }
                    bool splash = inSurf && splashW > 0.001;
                    if (!hit && !splash) continue;

                    // ── Réglages du cône ──
                    float apexDist = zS;
                    loadCone(i, apex, WV, apexDist, A6);
                    float irr = LT(i, 4).w;
                    // OMBRE : cubemap statique de la lyre si elle est cuite, sinon obstacles (boîtes) de la lyre
                    vec4 SH = cSlot >= 0 && uShadowSize > 0.5 ? shadowInfo(cSlot) : vec4(0.0);
                    bool hasCube = SH.w > 0.5;
                    bool hasOcc = !hasCube && A6.w > 0.5;
                    vec4 T8 = hasOcc ? spotParam(cRow, 8) : vec4(-1.0);

                    // ── Diffusion : quadrature de Gauss à 3 points ──
                    if (hit) {
                        float zc0 = dot(ro - cApexC, cW);
                        float zIn = max(zc0 + dz * tin, 1e-3);
                        float zOut = max(zc0 + dz * tout, 1e-3);
                        bool imp = abs(dz) > 0.05 && max(zIn, zOut) > 1.3 * min(zIn, zOut);
                        float uIn = 1.0 / zIn, uOut = 1.0 / zOut;
                        vec3 sum = vec3(0.0);
                        for (int s = 0; s < 3; s++) {
                            float x = s == 0 ? 0.2113 : (s == 1 ? 0.5 : 0.7887);
                            float w = s == 1 ? 0.44 : 0.28;
                            float t;
                            if (imp) {
                                float z = 1.0 / mix(uIn, uOut, x);
                                t = (z - zc0) / dz;
                            } else {
                                t = mix(tin, tout, x);
                            }
                            vec3 P = ro + rd * t;
                            float zA; vec3 lp;
                            vec3 gate = gateAtPoint(P, s == 1, zA, lp);
                            if (gate.r + gate.g + gate.b < 1e-5) continue;
                            if (hasCube) {
                                float dl = length(P - SH.xyz);
                                if (shadowHard(cSlot, SH.xyz, P, 0.06 + shadowTexelSize(dl)) < 0.5) continue;
                            } else if (hasOcc) {
                                vec3 sd = P - cLens;
                                if (segBlocked(cLens, sd, 1.0 - 0.03 / max(length(sd), 0.05), T8)) continue;
                            }
                            float zl = zA - apexDist;
                            float fade = 1.0 - smoothstep(fadeB, beamEnd, zl);
                            float cosT = dot(lp, -rd) / max(1e-4, length(lp));
                            // Répartition en 1/z : l'éclairement 1/z² est intégré exactement (poids sans 1/z²)
                            float e = imp ? 1.0 : 1.0 / (zA * zA);
                            sum += gate * (w * e * fade * phase(cosT));
                        }
                        float span = imp ? abs(uIn - uOut) / abs(dz) : (tout - tin);
                        acc += sum * (irr * span * uHazeK);
                    }

                    // ── Tache simple sur la surface (passe des taches de lumière désactivée) ──
                    if (splash) {
                        float zA; vec3 lp;
                        vec3 gate = gateAtPoint(sceneP, true, zA, lp);
                        float zl = zA - apexDist;
                        if (zl > 0.0 && zl < range && gate.r + gate.g + gate.b > 1e-5) {
                            bool blocked = false;
                            if (hasCube) {
                                float dl = length(sceneP - SH.xyz);
                                blocked = shadowHard(cSlot, SH.xyz, sceneP, 0.1 + 2.0 * shadowTexelSize(dl)) < 0.5;
                            } else if (hasOcc) {
                                vec3 sd = sceneP - cLens;
                                blocked = segBlocked(cLens, sd, 1.0 - 0.06 / max(length(sd), 0.1), T8);
                            }
                            if (!blocked) {
                                if (!haveN) {
                                    // Normale de la surface : 3 des 4 texels de profondeur lus plus haut
                                    vec3 p00 = uCamRot * (rayView(vec2(b) + 0.5) * d00);
                                    vec3 p10 = uCamRot * (rayView(vec2(b) + vec2(1.5, 0.5)) * d10);
                                    vec3 p01 = uCamRot * (rayView(vec2(b) + vec2(0.5, 1.5)) * d01);
                                    nrm = normalize(cross(p10 - p00, p01 - p00));
                                    if (dot(nrm, rd) > 0.0) nrm = -nrm;
                                    haveN = true;
                                }
                                float ndl = max(0.0, dot(nrm, -normalize(lp)));
                                acc += gate * (irr / (zA * zA) * ndl * splashW * 0.06 * (1.0 - smoothstep(fadeS, range, zl)));
                            }
                        }
                    }
                }
                gl_FragColor = vec4(min(acc, vec3(60000.0)), viewDepth);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}

export function createSSHaloMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            tScene:     { value: null },
            tSS:        { value: null },
            tClassic:   { value: null },
            uClassicOn: { value: 0 },
            tPool:      { value: null },
            uPoolOn:    { value: 0 },
            uPoolScale: { value: new THREE.Vector2(1, 1) },
            uFull:      { value: new THREE.Vector2(1, 1) },
            uLow:       { value: new THREE.Vector2(1, 1) },
            uDiv:       { value: 3 },
            uIntensity: { value: 0.5 },
            uRadius:    { value: 1 },
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */`
            precision highp float;
            uniform sampler2D tScene;
            uniform sampler2D tSS;
            uniform sampler2D tClassic;
            uniform int uClassicOn;
            uniform sampler2D tPool;
            uniform int uPoolOn;
            uniform vec2 uPoolScale;
            uniform vec2 uFull;
            uniform vec2 uLow;
            uniform float uDiv;
            uniform float uIntensity;
            uniform float uRadius;

            const vec2 POISSON[8] = vec2[8](
                vec2(-0.326, -0.406), vec2(-0.840, -0.074),
                vec2(-0.696,  0.457), vec2(-0.203,  0.621),
                vec2( 0.962, -0.195), vec2( 0.473, -0.480),
                vec2( 0.519,  0.767), vec2( 0.185, -0.893)
            );

            void main() {
                ivec2 lo = ivec2(gl_FragCoord.xy);
                vec4 c = texelFetch(tSS, lo, 0);
                float cd = max(c.a, 0.1);
                vec2 uv = (vec2(lo) + 0.5) * uDiv / uFull;     // position dans l'image pleine résolution
                vec2 toLow = uFull / (uDiv * uLow);              // uv plein écran → uv de l'image réduite
                float rad = uRadius * 0.022 / clamp(cd * 0.06, 0.45, 2.5);
                vec2 st = vec2(rad * uFull.y / uFull.x, rad);
                // Disque tourné d'un pixel à l'autre (motif fixe dans le temps) : pas d'images fantômes des points brillants
                float a = 6.2831853 * fract(52.9829189 * fract(dot(vec2(lo), vec2(0.06711056, 0.00583715))));
                mat2 rot = mat2(cos(a), sin(a), -sin(a), cos(a));
                // Lecture bilinéaire à cheval sur 2×2 pixels de la scène (moins de scintillement des petits points)
                vec2 pxHalf = 0.5 / uFull;
                vec3 accum = vec3(0.0);
                float wSum = 0.0;
                for (int i = 0; i < 8; i++) {
                    vec2 tuv = clamp(uv + rot * POISSON[i] * st, vec2(0.001), vec2(0.999));
                    vec4 b = texture2D(tSS, tuv * toLow);
                    vec3 col = texture2D(tScene, tuv + pxHalf).rgb + b.rgb;
                    if (uClassicOn == 1) col += texture2D(tClassic, tuv).rgb;
                    if (uPoolOn == 1) col += texture2D(tPool, tuv * uPoolScale).rgb;
                    float dz = max(b.a, 0.1) - cd;
                    // Occultation asymétrique : un objet au premier plan bloque la lumière de derrière ;
                    // une lumière devant un mur diffuse librement son halo
                    float wOcc = dz > 0.3 ? exp(-dz * dz * 1.8) : exp(-dz * dz * 0.03);
                    accum += col * wOcc;
                    wSum += wOcc;
                }
                vec3 glow = wSum > 1e-4 ? accum / wSum : vec3(0.0);
                gl_FragColor = vec4(c.rgb + glow * (0.45 * clamp(uIntensity * 0.5, 0.0, 0.85)), c.a);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}
