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
 *    - diffusion intégrée par QUADRATURE DE GAUSS à 3 points (0,1127 / 0,5 / 0,8873, poids 5/18, 8/18, 5/18),
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
 * 2. RETOUCHE DES BORDS en pleine résolution (même matériau, define REFINE) : pour chaque pixel, les 3×3 pixels
 *    réduits voisins ; s'ils sont tous semblables (intérieur d'un faisceau, fond vide), remontée bilatérale 3×3
 *    guidée par la profondeur ; sinon (bord d'un faisceau, faisceau plus fin qu'un pixel réduit près de la
 *    lentille, bord d'objet) les faisceaux de CE pixel sont recalculés exactement. Plus de tache étalée autour
 *    des faisceaux fins, même en ¼. Seulement dans les tuiles où passent peu de cônes (uRefineMax) : avec
 *    des centaines de cônes (prismes), chaque pixel de bord les recalculait tous (plusieurs ms).
 *    La passe finale (FinalCompositePass) lit cette image en pleine résolution (1 lecture), avant le brouillard
 *    (transmittance et bloom s'appliquent aux faisceaux SS comme aux faisceaux classiques).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { GATE_GLSL } from '../SpotShaders.js?v=5';
import { occluderUniforms } from '../SpotOcclusion.js';
import { SS_TILES_X, SS_TILES_Y, SS_MAX_PER_TILE } from './SSDepthLights.js';
import { CONE_GLSL } from './SSConeGLSL.js';
import { BEAM_RAY_GLSL } from './SSBeamGLSL.js';
import { SHADOW_GLSL, createShadowUniforms } from '../lighting/shadowGLSL.js';

const VERT = /* glsl */`
    void main() {
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

/**
 * @param {object} [shadowUniforms] uniformes partagés des ombres statiques (SpotShadowAtlas.uniforms)
 * @param {object} [o]
 * @param {boolean} [o.refine] variante de retouche des bords en pleine résolution (voir 2. plus haut)
 */
export function createSSBeamMaterial(shadowUniforms = createShadowUniforms(), { refine = false } = {}) {
    const occ = occluderUniforms();
    return new THREE.ShaderMaterial({
        defines: refine ? { REFINE: 1 } : {},
        uniforms: {
            tBeamLow:    { value: null },   // retouche : faisceaux réduits (a = profondeur du pixel réduit)
            tSoft:       { value: null },   // faisceaux flous (1/8 de résolution, a = profondeur)
            uSoftScale:  { value: new THREE.Vector2(1, 1) },
            uSoftOn:     { value: 0 },
            uSat:        { value: 3 },      // lumière au-delà de laquelle le pixel est blanc (voir SpotManager.setRoomFog)
            uRefineMax:  { value: 24 },     // retouche : nombre de cônes de la tuile au-delà duquel on ne recalcule pas
            uLowScale:   { value: new THREE.Vector2(1, 1) },
            uSharp:      { value: 1.5 },
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
            ${BEAM_RAY_GLSL}
            uniform highp sampler2D uDepth;
            uniform highp usampler2D uSSTiles;
            uniform vec2 uFull;
            uniform float uDiv;
            uniform vec3 uCamPos;
            uniform mat3 uCamRot;
            uniform vec4 uProjK;
            uniform float uNear;
            uniform float uFar;
            uniform float uHazeK;
            uniform float uSplashOn;

            const float PI = 3.14159265;
            const ivec2 TILES = ivec2(${SS_TILES_X}, ${SS_TILES_Y});
            // Pixel saturé : au-delà de uSat, l'écran (sans tone mapping : max 1) reste blanc, fumée de salle comprise
            uniform float uSat;
            // Cônes dont la diffusion est calculée au plus par pixel (les plus lumineux : listes triées par importance)
            const int MAX_HITS = 48;

            float linZ(ivec2 p) { return -perspectiveDepthToViewZ(texelFetch(uDepth, p, 0).r, uNear, uFar); }
            vec3 rayView(vec2 px) {
                vec2 ndc = px / uFull * 2.0 - 1.0;
                return vec3((ndc.x + uProjK.z) * uProjK.x, (ndc.y + uProjK.w) * uProjK.y, -1.0);
            }

            // Faisceaux (et tache simple) vus par le rayon du point pc (pixels pleine résolution), surface à la
            // profondeur viewDepth ; b, d00, d10, d01 : texels de profondeur pour la normale de la surface
            vec3 shadeBeams(vec2 pc, float viewDepth, ivec2 b, float d00, float d10, float d01) {
                ivec2 tile = min(ivec2(pc / uFull * vec2(TILES)), TILES - 1);
                int tIdx = tile.y * TILES.x + tile.x;
                int n = int(texelFetch(uSSTiles, ivec2(0, tIdx), 0).x);
                if (n == 0) return vec3(0.0);

                vec3 rv = rayView(pc);
                vec3 rd = normalize(uCamRot * rv);
                vec3 ro = uCamPos;
                float surfDist = viewDepth * length(rv);
                bool sky = viewDepth > uFar * 0.98;
                vec3 sceneP = ro + rd * surfDist;
                vec3 nrm = vec3(0.0);
                bool haveN = false;

                vec3 acc = vec3(0.0);
                int hits = 0;
                uvec4 idx4 = uvec4(0u);
                for (int k = 0; k < ${SS_MAX_PER_TILE}; k++) {
                    if (k >= n || hits >= MAX_HITS) break;
                    // Pixel déjà blanc : les cônes suivants (moins lumineux) ne changeraient rien
                    if (all(greaterThanEqual(acc, vec3(uSat)))) break;
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

                    // Intersection rayon ↔ cône oblique, bornée par les plans z ∈ [zS, zE] et la surface
                    float tin, tout, z0, dz;
                    bool hit = coneRay(ro, rd, apex, tanO, zS, WV, zE, surfDist, tin, tout, z0, dz);
                    float k2 = tanO * tanO;
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
                    if (hit) hit = clipBeamEnd(zS, beamEnd, z0, dz, tin, tout);
                    bool splash = inSurf && splashW > 0.001;
                    if (!hit && !splash) continue;

                    // ── Réglages du cône ──
                    float apexDist = zS;
                    loadCone(i, apex, WV, apexDist, A6);
                    // Couleur qui n'ajouterait qu'à des canaux déjà saturés (ex. vert sur vert saturé) : rien à voir
                    if (dot(step(vec3(1e-4), cCol), step(acc, vec3(uSat))) < 0.5) continue;
                    hits++;
                    float irr = LT(i, 4).w;
                    // OMBRE : cubemap statique de la lyre si elle est cuite, sinon obstacles (boîtes) de la lyre
                    vec4 SH = cSlot >= 0 && uShadowSize > 0.5 ? shadowInfo(cSlot) : vec4(0.0);
                    bool hasCube = SH.w > 0.5;
                    bool hasOcc = !hasCube && A6.w > 0.5;
                    vec4 T8 = hasOcc ? spotParam(cRow, 8) : vec4(-1.0);

                    // ── Diffusion : quadrature de Gauss à 3 points ──
                    if (hit) acc += beamScatter(ro, rd, tin, tout, dz, apexDist, fadeB, beamEnd, SH, hasCube, hasOcc, T8) * (irr * uHazeK);

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
                                    // Normale de la surface : 3 texels de profondeur voisins
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
                return min(acc, vec3(60000.0));
            }

        #ifndef REFINE
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
                gl_FragColor = vec4(shadeBeams(vec2(b) + 1.0, viewDepth, b, d00, d10, d01), viewDepth);
            }
        #else
            uniform sampler2D tBeamLow;
            uniform sampler2D tSoft;
            uniform vec2 uSoftScale;
            uniform int uSoftOn;
            uniform int uRefineMax;
            uniform vec2 uLowScale;
            uniform float uSharp;

            float lum(vec3 c) { return c.r + c.g + c.b; }

            // Faisceaux flous (1/8) : interpolation bilinéaire pondérée par la profondeur (pas de fuite sur un objet
            // au premier plan) ; aucun texel à la bonne profondeur : le plus proche en profondeur
            vec3 softUp(ivec2 p, float cz) {
                if (uSoftOn == 0) return vec3(0.0);
                vec2 suv = (vec2(p) + 0.5) / uFull * uSoftScale;
                ivec2 size = textureSize(tSoft, 0);
                vec2 pos = suv * vec2(size) - 0.5;
                ivec2 i0 = ivec2(floor(pos));
                vec2 f = pos - vec2(i0);
                vec3 sum = vec3(0.0);
                float wSum = 0.0, best = 1e9;
                vec3 bestC = vec3(0.0);
                for (int k = 0; k < 4; k++) {
                    ivec2 o = ivec2(k & 1, k >> 1);
                    vec4 s = texelFetch(tSoft, clamp(i0 + o, ivec2(0), size - 1), 0);
                    vec2 wv = mix(1.0 - f, f, vec2(o));
                    float rel = abs(cz - s.a) / max(cz, 0.5);
                    float w = wv.x * wv.y * exp(-rel * rel * 35.0) + 1e-5;
                    sum += s.rgb * w;
                    wSum += w;
                    if (rel < best) { best = rel; bestC = s.rgb; }
                }
                return best > 0.5 ? bestC : sum / wSum;
            }

            void main() {
                ivec2 p = ivec2(gl_FragCoord.xy);
                ivec2 fullI = ivec2(uFull);
                float cz = max(linZ(p), 0.1);
                vec2 suv = (vec2(p) + 0.5) / uFull * uLowScale;
                ivec2 size = textureSize(tBeamLow, 0);
                vec2 pos = suv * vec2(size) - 0.5;
                ivec2 cc = ivec2(floor(pos + 0.5));
                // Pixels réduits voisins (3×3 autour du plus proche) : tous semblables ou non ? (2×2 ne suffisait pas :
                // près de la lentille, des pixels juste à côté d'un faisceau fin recevaient sa lumière étalée → points)
                float lMin = 1e9, lMax = 0.0;
                bool depthEdge = false;
                for (int k = 0; k < 9; k++) {
                    vec4 s = texelFetch(tBeamLow, clamp(cc + ivec2(k % 3 - 1, k / 3 - 1), ivec2(0), size - 1), 0);
                    float l = lum(s.rgb);
                    lMin = min(lMin, l);
                    lMax = max(lMax, l);
                    if (abs(s.a - cz) > 0.1 * cz) depthEdge = true;
                }
                bool edge = depthEdge || (lMax > 0.003 && lMax - lMin > 0.15 * lMax);
                if (edge) {
                    // Tuile chargée (prismes, dizaines de lyres) : remontée seule
                    vec2 pc = vec2(p) + 0.5;
                    ivec2 tile = min(ivec2(pc / uFull * vec2(TILES)), TILES - 1);
                    int n = int(texelFetch(uSSTiles, ivec2(0, tile.y * TILES.x + tile.x), 0).x);
                    if (n > uRefineMax) edge = false;
                }
                if (!edge) {
                    // Remontée bilatérale 3×3 guidée par la profondeur (comme la passe finale)
                    float sharp = 35.0 * uSharp;
                    ivec2 c0 = ivec2(floor(pos + 0.5));
                    vec2 f = pos - vec2(c0);
                    vec3 sum = vec3(0.0);
                    float wSum = 0.0;
                    for (int dy = -1; dy <= 1; dy++) {
                        for (int dx = -1; dx <= 1; dx++) {
                            ivec2 q = clamp(c0 + ivec2(dx, dy), ivec2(0), size - 1);
                            vec4 c4 = texelFetch(tBeamLow, q, 0);
                            vec3 c = c4.rgb;
                            float za = c4.a;
                            vec2 d = abs(vec2(float(dx), float(dy)) - f);
                            float ws = max(0.0, 1.0 - d.x) * max(0.0, 1.0 - d.y) + 0.02;
                            float rel = abs(cz - za) / max(cz, 0.5);
                            float w = ws * exp(-rel * rel * sharp);
                            sum += c * w;
                            wSum += w;
                        }
                    }
                    gl_FragColor = vec4((wSum > 1e-3 ? sum / wSum : vec3(0.0)) + softUp(p, cz), 1.0);
                    return;
                }
                // Bord : faisceaux recalculés pour ce pixel
                ivec2 b = min(p, fullI - 2);
                float d10 = linZ(b + ivec2(1, 0)), d01 = linZ(b + ivec2(0, 1));
                gl_FragColor = vec4(shadeBeams(vec2(p) + 0.5, linZ(p), b, linZ(b), d10, d01) + softUp(p, cz), 1.0);
            }
        #endif
        `,
        depthTest: false,
        depthWrite: false,
    });
}
