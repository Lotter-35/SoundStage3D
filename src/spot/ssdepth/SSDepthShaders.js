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
 *    - ombre des obstacles de la scène (boîtes de SpotOcclusion) à chaque échantillon ;
 *      phase B : cubemaps d'ombre statiques (voir le point d'accroche « OMBRE » ci-dessous) ;
 *    - tache de lumière au sol (lyres sans lumière réelle), comme le rendu classique ;
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
import { GATE_GLSL, GATE_ATLAS_R, GATE_ATLAS_SIDE, GATE_ATLAS_TILE } from '../SpotShaders.js?v=5';
import { occluderUniforms, MAX_OCCLUDERS } from '../SpotOcclusion.js';
import { SS_TILES_X, SS_TILES_Y, SS_MAX_PER_TILE } from './SSDepthLights.js';

const VERT = /* glsl */`
    void main() {
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

export function createSSBeamMaterial() {
    const occ = occluderUniforms();
    return new THREE.ShaderMaterial({
        uniforms: {
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
        },
        vertexShader: VERT,
        fragmentShader: /* glsl */`
            precision highp float;
            precision highp int;
            #include <packing>
            ${GATE_GLSL}
            uniform highp sampler2D uDepth;
            uniform highp sampler2D uSSLights;
            uniform highp usampler2D uSSTiles;
            uniform sampler2D uGateAtlas;
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

            const float PI = 3.14159265;
            const ivec2 TILES = ivec2(${SS_TILES_X}, ${SS_TILES_Y});

            vec4 LT(int i, int k) { return texelFetch(uSSLights, ivec2(k, i), 0); }
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

            // ── Cône en cours (lu une fois par cône touché) ──
            vec3 cLens, cApexC, cW, cR, cU, cCol;
            vec2 cV;
            float cTanHalf, cIris, cFrostBlur, cLogFocus, cKind, cTile, cOutR2, cPlainR2;
            Gate cG;

            // Disque de l'iris (faisceau ouvert) : formule exacte du rendu classique
            vec3 plainGate(vec2 g, float blur) {
                float r2 = dot(g, g);
                if (r2 >= cOutR2) return vec3(0.0);
                if (r2 < cPlainR2) return cCol * (1.0 - 0.2 * r2);
                float e = 0.012 + blur;
                return cCol * ((1.0 - smoothstep(cIris - e, cIris + e, sqrt(r2))) * (1.0 - 0.2 * min(r2, 1.0)));
            }

            vec3 atlasGate(vec2 g, float blur) {
                vec2 uv = g * (0.5 / ${GATE_ATLAS_R.toFixed(2)}) + 0.5;
                if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
                vec2 cell = vec2(mod(cTile, ${GATE_ATLAS_SIDE.toFixed(1)}), floor(cTile / ${GATE_ATLAS_SIDE.toFixed(1)}));
                float texelG = ${(2 * GATE_ATLAS_R / GATE_ATLAS_TILE).toFixed(6)};
                float lod = clamp(log2(max(1.0, (blur - cFrostBlur) / texelG)), 0.0, 3.0);
                return textureLod(uGateAtlas, (cell + uv) / ${GATE_ATLAS_SIDE.toFixed(1)}, lod).rgb;
            }

            // Image de la fenêtre au point P ; full : échantillon du milieu (image complète)
            vec3 gateAtPoint(vec3 P, bool full, out float zA, out vec3 lp) {
                lp = P - cApexC;
                zA = max(dot(lp, cW), 1e-3);
                vec3 rad = lp - cW * zA;
                float zl = max(dot(P - cLens, cW), 0.0);   // distance à la lentille le long de l'axe
                vec2 g = vec2(dot(rad, cR), dot(rad, cU)) / (zA * cTanHalf) - cV * (zl / zA);
                float blur = cFrostBlur + min(0.14, abs(log(zl + 0.5) - cLogFocus) * 0.035);
                if (cKind > 1.5) {
                    if (cKind < 2.5) return atlasGate(g, blur);
                    if (full) {
                        if (dot(g, g) >= cOutR2) return vec3(0.0);
                        return gateImage(cG, g, blur);
                    }
                }
                return plainGate(g, blur);
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

                    // Rejet rapide : sphère englobante
                    vec4 S = LT(i, 4);
                    vec3 oc = S.xyz - ro;
                    float tp = dot(oc, rd);
                    float d2 = dot(oc, oc) - tp * tp;
                    if (d2 > S.w * S.w || tp + S.w < 0.0 || tp - S.w > surfDist) continue;

                    vec4 A0 = LT(i, 0), A1 = LT(i, 1), A2 = LT(i, 2), A3 = LT(i, 3);
                    vec3 apex = A0.xyz;
                    cW = A1.xyz;
                    float apexDist = A1.w;
                    cR = A2.xyz;
                    float tanO = A2.w;
                    cU = cross(cR, cW);
                    vec3 Vw = cR * A3.x + cU * A3.y;
                    vec3 WV = cW + Vw;

                    // ── Intersection rayon ↔ cône oblique, bornée par les plans z ∈ [zS, zE] (z depuis l'apex) ──
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
                        float ta = (A3.z - z0) / dz, tb = (A3.w - z0) / dz;
                        tin = min(ta, tb); tout = max(ta, tb);
                    } else if (z0 < A3.z || z0 > A3.w) hit = false;
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

                    vec4 A7 = LT(i, 7);
                    float splashW = A7.z;
                    if (!hit && (splashW <= 0.001 || sky)) continue;

                    // ── Réglages du cône ──
                    vec4 A5 = LT(i, 5), A6 = LT(i, 6), A8 = LT(i, 8);
                    int row = int(A0.w + 0.5);
                    cLens = apex + WV * apexDist;
                    cApexC = cLens - cW * apexDist;
                    cCol = A5.rgb;
                    float irr = A5.w;
                    cTanHalf = A6.x;
                    cIris = A6.y;
                    cFrostBlur = A6.z;
                    cLogFocus = A6.w;
                    cV = A3.xy / cTanHalf;
                    cKind = A7.x;
                    cTile = A7.y;
                    float outR = cIris + 0.012 + cFrostBlur + 0.14;
                    cOutR2 = outR * outR;
                    float plainR = cIris - (0.012 + cFrostBlur + 0.14);
                    cPlainR2 = plainR > 0.0 ? plainR * plainR : -1.0;
                    if (cKind > 0.5 && cKind < 1.5) {
                        // Frost fort : transmission moyenne des gobos (dernier niveau de mipmap), comme le rendu classique
                        vec4 T3 = spotParam(row, 3), T4 = spotParam(row, 4);
                        float avg = 1.0;
                        if (T3.x > 0.001) { float sl = mod(floor(T3.x + 0.5), 9.0); if (sl > 0.5) avg *= textureLod(uGobos, vec3(0.5, 0.5, sl), 10.0).r; }
                        if (T3.y > 0.001) { float sl = mod(floor(T3.y + 0.5), 8.0); if (sl > 0.5) avg *= textureLod(uGobos, vec3(0.5, 0.5, 8.0 + sl), 10.0).r; }
                        if (T4.x > 0.001 && T3.w > 0.5) avg *= mix(1.0, clamp(textureLod(uGobos, vec3(0.5, 0.5, 15.0 + T3.w), 10.0).r * 1.25, 0.0, 1.0), clamp(T4.x, 0.0, 1.0));
                        cCol *= avg;
                    } else if (cKind > 2.5) {
                        cG = loadGate(row);
                    }
                    // OMBRE : obstacles (boîtes) de la lyre ; phase B → cubemap d'ombre statique de la lyre
                    bool hasOcc = A7.w > 0.5;
                    vec4 T8 = hasOcc ? spotParam(row, 8) : vec4(-1.0);
                    float beamEnd = A8.x, fadeB = A8.y, range = A8.z, fadeS = A8.w;

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
                            if (hasOcc) {
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

                    // ── Tache de lumière sur la surface (lyres sans lumière réelle) ──
                    if (splashW > 0.001 && !sky) {
                        float zA; vec3 lp;
                        vec3 gate = gateAtPoint(sceneP, true, zA, lp);
                        float zl = zA - apexDist;
                        if (zl > 0.0 && zl < range && gate.r + gate.g + gate.b > 1e-5) {
                            bool blocked = false;
                            if (hasOcc) {
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
