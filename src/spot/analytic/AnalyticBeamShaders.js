/**
 * AnalyticBeamShaders.js
 * ─────────────────────────────────────────────────────────────
 * Rendu « Analytique » des faisceaux des lyres (3e mode, à côté de Classique et SS Depth).
 *
 * Même géométrie que le rendu classique (un cône enveloppe instancié par lyre, dessiné dans la passe des
 * faisceaux, additif) mais AUCUNE marche dans la fumée :
 *   - pour chaque facette du prisme (une seule sans prisme), intersection EXACTE du rayon de vue avec le cône
 *     oblique de la facette, bornée par la lentille, la longueur visible et la profondeur de la scène ;
 *   - lumière diffusée = ∫ image de la fenêtre × phase × fondu × ombre / z² dt, calculée par une quadrature de
 *     Gauss-Legendre (2 points pour un faisceau ouvert, profil lisse ; 4 avec gobo, couteaux, demi-couleur)
 *     répartis en 1/z quand le rayon remonte le faisceau (l'éclairement en 1/z² est alors intégré exactement) :
 *     nombre de calculs FIXE par pixel et par facette, sans bruit ni grain ;
 *   - cône coupé au sol (y = 0) dans le shader de sommets : rien n'est calculé sous la surface ;
 *   - caméra DANS un faisceau (une seule lyre, choisie par SpotManager : uInsideRow) : 12 points réguliers et une
 *     ombre par point pour cette lyre (le rayon remonte tout le faisceau : avec 2 à 4 points, le bord de l'iris
 *     faisait un disque en marches) ; les autres lyres gardent 2 à 4 points (coût borné au milieu des faisceaux) ;
 *   - prisme + frost fort (≥ 60 %) : les facettes se fondent dans le flou → UN cône (l'enveloppe) et 4 points
 *     le long du rayon, l'image des facettes lue d'un coup à chaque point (1 lecture d'atlas par facette) ;
 *     ombre, diffusion et fondu une fois par point. Sans frost fort, le prisme net garde un cône par facette ;
 *   - image de la fenêtre lue dans l'atlas (gobos, couteaux, frost) au niveau de flou correspondant à l'écart
 *     entre les points dans la fenêtre : un rayon qui traverse le motif en voit la moyenne, sans copies ;
 *   - ombre statique (cubemap de la lyre, sinon boîtes d'obstacles) : 2 lectures par facette (une par moitié
 *     du segment), réutilisées par les points de cette moitié ;
 *   - fumée uniforme, volutes lues une fois au milieu du segment.
 * Pas d'image réduite propre, pas de tri par tuile sur le CPU, pas de passe de bords : la résolution est celle
 * de la passe des faisceaux classiques (⚙️ Options › Résolution des effets › Lyres).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { GATE_GLSL, GATE_ATLAS_R, GATE_ATLAS_SIDE, GATE_ATLAS_TILE } from '../SpotShaders.js?v=5';
import { SMOKE_NOISE_UVW_SCALE } from '../../laser/LaserSmokeNoise.js';
import { MAX_OCCLUDERS } from '../SpotOcclusion.js';
import { SHADOW_GLSL } from '../lighting/shadowGLSL.js';

/**
 * Matériau des faisceaux analytiques. Les uniformes sont ceux du matériau des faisceaux classiques
 * (SpotBatch les partage) : profondeur, fumée, ombres, atlas… écrits une seule fois.
 */
export function createAnalyticBeamMaterial(uniforms) {
    return new THREE.ShaderMaterial({
        uniforms,
        vertexShader: /* glsl */`
            uniform highp sampler2D uSpotParams;
            attribute vec4 iLens;   // position de la lentille, ligne de paramètres
            attribute vec4 iAxis;   // axe du faisceau, longueur
            attribute vec4 iRight;  // axe « droite » de la fenêtre, poids
            flat varying vec4 vLens;
            flat varying vec4 vAxis;
            flat varying vec4 vRight;
            varying vec3 vWorld;

            void main() {
                int row = int(iLens.w + 0.5);
                vec4 T7 = texelFetch(uSpotParams, ivec2(7, row), 0);
                vec4 T9 = texelFetch(uSpotParams, ivec2(9, row), 0);
                vec4 T11 = texelFetch(uSpotParams, ivec2(11, row), 0);
                vec3 W = iAxis.xyz;
                vec3 R = iRight.xyz;
                vec3 U = cross(W, R);   // repère direct : faces arrière = intérieur du cône
                float L = iAxis.w;
                float sEnd = T11.w > 0.0 ? min(T11.w, L) : L;
                // Coupe au sol (y = 0) : le bord le plus haut du cône enveloppe l'atteint à cette distance (+ 1 m) ;
                // au-delà, tout est sous la surface (le fragment n'aurait rien à ajouter mais coûterait quand même)
                float tanE = T9.y;
                float down = asin(clamp(-W.y, -1.0, 1.0)) - atan(tanE);   // angle sous l'horizontale du bord haut
                if (iLens.y > 0.0 && down > 0.02) {
                    float sGround = (iLens.y + T7.z * T7.w) / sin(down) * cos(atan(tanE)) + 1.0;
                    sEnd = min(sEnd, sGround);
                }
                float s = mix(T11.z, sEnd, position.z);
                // Cône enveloppe (toutes les facettes) + 3,5 % : le polygone contient le cercle
                float rad = (T7.z * T7.w + s * T9.y) * 1.035;
                vec3 world = iLens.xyz + W * s + (R * position.x + U * position.y) * rad;
                vWorld = world;
                vLens = iLens;
                vAxis = iAxis;
                vRight = iRight;
                gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            #include <packing>
            ${GATE_GLSL}
            ${SHADOW_GLSL}
            uniform float uClassicShadow;
            uniform highp sampler3D uNoise;
            uniform highp sampler2D uDepth;
            uniform vec2 uInvRes;
            uniform float uNear;
            uniform float uFar;
            uniform vec3 uCamFwd;
            uniform float uHaze;
            uniform float uHazeContrast;
            uniform float uHazeScale;
            uniform float uPhaseG;
            uniform vec3 uWind;
            uniform vec3 uBoxMin[${MAX_OCCLUDERS}];
            uniform vec3 uBoxMax[${MAX_OCCLUDERS}];
            uniform sampler2D uGateAtlas;
            uniform float uDebugCost;   // vue « coût des lyres » : travail du pixel au lieu de la lumière
            uniform float uInsideRow;   // ligne de la lyre dans laquelle est la caméra (−1 : aucune) : 12 points
            const int NQ_INSIDE = 12;
            flat varying vec4 vLens;
            flat varying vec4 vAxis;
            flat varying vec4 vRight;
            varying vec3 vWorld;

            const float PI = 3.14159265;
            const float NOISE_UVW = ${SMOKE_NOISE_UVW_SCALE.toFixed(8)};
            // Gauss-Legendre à 4 points sur [0, 1]
            const vec4 GX = vec4(0.0694318, 0.3300095, 0.6699905, 0.9305682);
            const vec4 GW = vec4(0.1739274, 0.3260726, 0.3260726, 0.1739274);

            float phase(float cosT) {
                float g = uPhaseG;
                float x = max(1e-4, 1.0 + g * g - 2.0 * g * cosT);
                float hg = (1.0 - g * g) * inversesqrt(x) / x;
                return 0.65 + 0.35 * hg;
            }

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

            // ── Réglages de la lyre (lus une fois par pixel) ──
            Gate G;
            vec4 gSH, gT8;
            vec3 gLens;
            int gSlot;
            bool gHasCube, gHasOcc;

            // Point P éclairé par la lyre (ombre statique, sinon boîtes d'obstacles) ?
            bool litAt(vec3 P) {
                if (gHasCube) return shadowHard(gSlot, gSH.xyz, P, 0.06 + shadowTexelSize(length(P - gSH.xyz))) >= 0.5;
                if (gHasOcc) {
                    vec3 sd = P - gLens;
                    return !segBlocked(gLens, sd, 1.0 - 0.03 / max(length(sd), 0.05), gT8);
                }
                return true;
            }
            bool aPlain;
            float aTile, aFrostBlur, aIris, aOutR2, aPlainR2, aLogFocus;

            // Image de la fenêtre en g (unités de fenêtre), flou blur (frost compris)
            vec3 gateAt(vec2 g, float blur) {
                float r2 = dot(g, g);
                if (r2 >= aOutR2) return vec3(0.0);
                if (aPlain) {
                    if (r2 < aPlainR2) return G.T0.rgb * (1.0 - 0.2 * r2);
                    float e = 0.012 + blur;
                    return G.T0.rgb * ((1.0 - smoothstep(aIris - e, aIris + e, sqrt(r2))) * (1.0 - 0.2 * min(r2, 1.0)));
                }
                if (aTile >= 0.0) {
                    vec2 uv = g * (0.5 / ${GATE_ATLAS_R.toFixed(2)}) + 0.5;
                    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
                    vec2 cell = vec2(mod(aTile, ${GATE_ATLAS_SIDE.toFixed(1)}), floor(aTile / ${GATE_ATLAS_SIDE.toFixed(1)}));
                    float texelG = ${(2 * GATE_ATLAS_R / GATE_ATLAS_TILE).toFixed(6)};
                    float lod = clamp(log2(max(1.0, (blur - aFrostBlur) / texelG)), 0.0, 5.0);
                    return textureLod(uGateAtlas, (cell + uv) / ${GATE_ATLAS_SIDE.toFixed(1)}, lod).rgb;
                }
                return gateImage(G, g, blur);
            }

            // Intersection rayon ↔ cône oblique (apex A, axe W, centres des sections A + WV·z, tan k) bornée par
            // z ∈ [zS, zE] et t ∈ [t0, t1]
            bool coneSeg(vec3 ro, vec3 rd, vec3 A, vec3 W, vec3 WV, float k, float zS, float zE, float t0, float t1,
                         out float tin, out float tout) {
                vec3 q = ro - A;
                float z0 = dot(q, W), dz = dot(rd, W);
                vec3 qa = q - WV * z0, qb = rd - WV * dz;
                float k2 = k * k;
                float QA = dot(qb, qb) - k2 * dz * dz;
                float QB = dot(qa, qb) - k2 * z0 * dz;
                float QC = dot(qa, qa) - k2 * z0 * z0;
                tin = -1e9; tout = 1e9;
                if (abs(dz) > 1e-6) {
                    float ta = (zS - z0) / dz, tb = (zE - z0) / dz;
                    tin = min(ta, tb); tout = max(ta, tb);
                } else if (z0 < zS || z0 > zE) return false;
                float disc = QB * QB - QA * QC;
                if (abs(QA) < 1e-9) {
                    if (abs(QB) > 1e-9) {
                        float ts = -QC / (2.0 * QB);
                        if (QB > 0.0) tout = min(tout, ts); else tin = max(tin, ts);
                    } else if (QC > 0.0) return false;
                } else if (QA > 0.0) {
                    if (disc < 0.0) return false;
                    float sq = sqrt(disc);
                    tin = max(tin, (-QB - sq) / QA);
                    tout = min(tout, (-QB + sq) / QA);
                } else if (disc > 0.0) {
                    float sq = sqrt(disc);
                    float r1 = (-QB + sq) / QA, r2 = (-QB - sq) / QA;
                    if (!(r2 <= tin || r1 >= tout)) {
                        if (r1 > tin) tout = min(tout, r1); else tin = max(tin, r2);
                    }
                }
                tin = max(tin, t0);
                tout = min(tout, t1);
                return tout > tin;
            }

            void main() {
                vec3 ro = cameraPosition;
                vec3 rd = normalize(vWorld - ro);
                float d = texture(uDepth, gl_FragCoord.xy * uInvRes).r;
                float tScene = d >= 1.0 ? 1e9 : -perspectiveDepthToViewZ(d, uNear, uFar) / max(1e-4, dot(rd, uCamFwd));

                int row = int(vLens.w + 0.5);
                vec3 W = vAxis.xyz;
                float L = vAxis.w;
                vec3 R = vRight.xyz;
                vec3 U = cross(R, W);
                vec4 T0 = spotParam(row, 0), T2 = spotParam(row, 2), T7 = spotParam(row, 7), T8 = spotParam(row, 8);
                vec4 T9 = spotParam(row, 9), T10 = spotParam(row, 10), T11 = spotParam(row, 11), T12 = spotParam(row, 12);
                float flux = T0.w * vRight.w;
                if (flux <= 0.0) discard;
                float tanHalf = T2.x;
                float apexDist = T7.w;
                vec3 lens = vLens.xyz;
                vec3 apexC = lens - W * apexDist;          // apex du faisceau central (repère de la fenêtre)
                float sEnd = T11.w > 0.0 ? min(T11.w, L) : L;
                float beamEnd = T12.y > 0.0 ? min(T12.y, sEnd) : sEnd;
                float fadeStart = beamEnd < L ? beamEnd * 0.75 : L * 0.7;
                float zS = apexDist + T11.z, zE = apexDist + beamEnd;

                // Réglages optiques
                G = makeGate(T0, spotParam(row, 1), T2, spotParam(row, 3), spotParam(row, 4), spotParam(row, 5), spotParam(row, 6), T7);
                aPlain = !G.hasFixed && !G.hasRot && !G.hasAnim && !G.anyBlade && !G.halfCol;
                aTile = T12.x - 1.0;
                aFrostBlur = T2.z * 0.42;
                aIris = min(T2.y, 1.0);
                float outR = aIris + 0.012 + aFrostBlur + 0.14;
                aOutR2 = outR * outR;
                float plainR = aIris - (0.012 + aFrostBlur + 0.14);
                aPlainR2 = plainR > 0.0 ? plainR * plainR : -1.0;
                aLogFocus = log(T2.w);
                float tanO = tanHalf * (outR + 0.01);
                float irr0 = flux / (PI * tanHalf * tanHalf);

                // Ombre : cubemap statique de la lyre, sinon boîtes d'obstacles
                int shSlot = int(floor(T12.z + 0.5));
                vec4 SH = (uClassicShadow > 0.5 && shSlot >= 0 && uShadowSize > 0.5) ? shadowInfo(shSlot) : vec4(0.0);
                bool hasCube = SH.w > 0.5;
                bool hasOcc = !hasCube && T8.x >= 0.0;
                gSH = SH; gT8 = T8; gLens = lens; gSlot = shSlot; gHasCube = hasCube; gHasOcc = hasOcc;
                // Faisceau ouvert, ou motif noyé dans un frost fort : profil lisse, 2 points suffisent ; motif net : 4 ;
                // lyre dans laquelle est la caméra : 12 points réguliers, ombre à chaque point
                bool inside = abs(float(row) - uInsideRow) < 0.5;
                int NQ = inside ? NQ_INSIDE : (aPlain || aFrostBlur >= 0.25) ? 2 : 4;

                // Prisme : faisceau central (poids T9.z, 1 sans prisme) + facettes (décalage v en unités de fenêtre)
                int pCount = int(T9.x + 0.5);
                float mainW = pCount > 0 ? T9.z : 1.0;
                vec2 v = T10.xy;
                vec2 vRot = T10.zw, vD = T11.xy;

                float zc0 = dot(ro - apexC, W);
                float dz = dot(rd, W);
                float t1 = min(tScene, 1e5);
                vec3 sum = vec3(0.0);
                float hazeK = -1.0;
                float work = 0.2;   // vue du coût : un fragment du cône

                // ── Prisme dans un frost fort : un seul cône (l'enveloppe), image de toutes les facettes par point ──
                bool envMode = pCount > 0 && aFrostBlur >= 0.25;
                if (envMode) {
                    float tanE = T9.y;
                    float envDist = T7.z * T7.w / tanE;    // apex de l'enveloppe (rayon à la lentille = celui des facettes)
                    vec3 envApex = lens - W * envDist;
                    float tin, tout;
                    work += 0.3;
                    if (coneSeg(ro, rd, envApex, W, W, tanE * 1.02, envDist + T11.z, envDist + beamEnd, uNear, t1, tin, tout)) {
                        float zIn = max(zc0 + dz * tin, 1e-3), zOut = max(zc0 + dz * tout, 1e-3);
                        bool imp = abs(dz) > 0.05 && max(zIn, zOut) > 1.3 * min(zIn, zOut);
                        float uIn = 1.0 / zIn, uOut = 1.0 / zOut;
                        // Flou d'intégration : écart entre 2 points dans la fenêtre du faisceau central
                        vec3 Pa = ro + rd * tin, Pb = ro + rd * tout;
                        vec3 la = Pa - apexC, lb = Pb - apexC;
                        float za = max(dot(la, W), 1e-3), zb = max(dot(lb, W), 1e-3);
                        vec2 ga = vec2(dot(la - W * za, R), dot(la - W * za, U)) / (za * tanHalf);
                        vec2 gb = vec2(dot(lb - W * zb, R), dot(lb - W * zb, U)) / (zb * tanHalf);
                        float sweep = length(gb - ga);
                        float extraBlur = sweep < 8.0 ? sweep * 0.12 : 0.96;
                        vec3 acc = vec3(0.0);
                        bool has0 = false, has1 = false, lit0 = true, lit1 = true;
                        int NE = inside ? NQ_INSIDE : 4;
                        if (inside) extraBlur *= 0.33;
                        for (int s = 0; s < NQ_INSIDE; s++) {
                            if (s >= NE) break;
                            float x = inside ? (float(s) + 0.5) / float(NE) : GX[s];
                            float wq = inside ? 1.0 / float(NE) : GW[s];
                            float t = imp ? (1.0 / mix(uIn, uOut, x) - zc0) / dz : mix(tin, tout, x);
                            vec3 P = ro + rd * t;
                            vec3 lp = P - apexC;
                            float zA = max(dot(lp, W), 1e-3);
                            vec3 radv = lp - W * zA;
                            float zl = max(dot(P - lens, W), 0.0);
                            float k = zl / zA;
                            vec2 g0 = vec2(dot(radv, R), dot(radv, U)) / (zA * tanHalf);
                            float blur = aFrostBlur + min(0.14, abs(log(zl + 0.5) - aLogFocus) * 0.035) + extraBlur;
                            // Image de toutes les facettes en ce point (faisceau central + facettes décalées)
                            vec3 gate = mainW > 0.0 ? gateAt(g0, blur) * mainW : vec3(0.0);
                            vec2 fv = T10.xy;
                            for (int i = 0; i < 8; i++) {
                                if (i >= pCount) break;
                                gate += gateAt(g0 - fv * k, blur) * T9.w;
                                fv = vec2(vRot.x * fv.x - vRot.y * fv.y, vRot.y * fv.x + vRot.x * fv.y) + vD;
                            }
                            work += 1.0 + 0.25 * float(pCount);
                            if (gate.r + gate.g + gate.b < 1e-5) continue;
                            bool lit;
                            if (inside) {
                                lit = litAt(P);
                                if (hasCube || hasOcc) work += 1.0;
                            } else if (s < 2) {
                                if (!has0) { lit0 = litAt(P); has0 = true; if (hasCube || hasOcc) work += 1.0; }
                                lit = lit0;
                            } else {
                                if (!has1) { lit1 = litAt(P); has1 = true; if (hasCube || hasOcc) work += 1.0; }
                                lit = lit1;
                            }
                            if (!lit) continue;
                            float fade = 1.0 - smoothstep(fadeStart, beamEnd, zl);
                            float cosT = dot(lp, -rd) / max(1e-4, length(lp));
                            float e = imp ? 1.0 : 1.0 / (zA * zA);
                            acc += gate * (wq * e * fade * phase(cosT));
                        }
                        float span = imp ? abs(uIn - uOut) / abs(dz) : (tout - tin);
                        vec3 Pm = ro + rd * (0.5 * (tin + tout));
                        float n = texture(uNoise, (Pm * (0.075 / uHazeScale) + uWind * 0.35) * NOISE_UVW).r * 1.12;
                        hazeK = uHaze * max(0.05, 1.0 + uHazeContrast * n);
                        sum = acc * span;
                    }
                }

                // ── Cas général : un cône par facette ──
                for (int f = 0; f < 9; f++) {
                    if (envMode) break;
                    if (f > pCount) break;
                    float w;
                    vec2 off;
                    if (f == 0) { w = mainW; off = vec2(0.0); }
                    else {
                        w = T9.w; off = v;
                        v = vec2(vRot.x * v.x - vRot.y * v.y, vRot.y * v.x + vRot.x * v.y) + vD;
                    }
                    if (w <= 0.0) continue;
                    // Cône oblique de la facette : sections centrées sur lentille + (W + V)·s
                    vec3 V = (R * off.x + U * off.y) * tanHalf;
                    vec3 WV = W + V;
                    vec3 A = lens - WV * apexDist;
                    float tin, tout;
                    work += 0.3;
                    if (!coneSeg(ro, rd, A, W, WV, tanO, zS, zE, uNear, t1, tin, tout)) continue;

                    // Quadrature : en 1/z quand le rayon remonte le faisceau (1/z² intégré exactement)
                    float zIn = max(zc0 + dz * tin, 1e-3), zOut = max(zc0 + dz * tout, 1e-3);
                    bool imp = abs(dz) > 0.05 && max(zIn, zOut) > 1.3 * min(zIn, zOut);
                    float uIn = 1.0 / zIn, uOut = 1.0 / zOut;
                    // Flou d'intégration : écart entre 2 points dans la fenêtre (pas de copies nettes du motif)
                    vec3 Pa = ro + rd * tin, Pb = ro + rd * tout;
                    vec3 la = Pa - apexC, lb = Pb - apexC;
                    float za = max(dot(la, W), 1e-3), zb = max(dot(lb, W), 1e-3);
                    vec2 ga = vec2(dot(la - W * za, R), dot(la - W * za, U)) / (za * tanHalf) - off * (max(dot(Pa - lens, W), 0.0) / za);
                    vec2 gb = vec2(dot(lb - W * zb, R), dot(lb - W * zb, U)) / (zb * tanHalf) - off * (max(dot(Pb - lens, W), 0.0) / zb);
                    float sweep = length(gb - ga);
                    float extraBlur = sweep < 8.0 ? sweep * 0.12 : 0.96;
                    if (aPlain) extraBlur = 0.0;

                    vec3 acc = vec3(0.0);
                    bool has0 = false, has1 = false, lit0 = true, lit1 = true;
                    if (inside) extraBlur *= 0.33;
                    for (int s = 0; s < NQ_INSIDE; s++) {
                        if (s >= NQ) break;
                        float x = inside ? (float(s) + 0.5) / float(NQ) : NQ == 2 ? (s == 0 ? 0.2113249 : 0.7886751) : GX[s];
                        float wq = inside ? 1.0 / float(NQ) : NQ == 2 ? 0.5 : GW[s];
                        float t = imp ? (1.0 / mix(uIn, uOut, x) - zc0) / dz : mix(tin, tout, x);
                        vec3 P = ro + rd * t;
                        vec3 lp = P - apexC;
                        float zA = max(dot(lp, W), 1e-3);
                        vec3 radv = lp - W * zA;
                        float zl = max(dot(P - lens, W), 0.0);
                        vec2 g = vec2(dot(radv, R), dot(radv, U)) / (zA * tanHalf) - off * (zl / zA);
                        float blur = aFrostBlur + min(0.14, abs(log(zl + 0.5) - aLogFocus) * 0.035) + extraBlur;
                        vec3 gate = gateAt(g, blur);
                        work += 1.0;
                        if (gate.r + gate.g + gate.b < 1e-5) continue;
                        // Ombre : une lecture par moitié du segment, réutilisée par les autres points de la moitié
                        bool lit;
                        if (inside) {
                            lit = litAt(P);
                            if (hasCube || hasOcc) work += 1.0;
                        } else if (s < NQ / 2) {
                            if (!has0) { lit0 = litAt(P); has0 = true; if (hasCube || hasOcc) work += 1.0; }
                            lit = lit0;
                        } else {
                            if (!has1) { lit1 = litAt(P); has1 = true; if (hasCube || hasOcc) work += 1.0; }
                            lit = lit1;
                        }
                        if (!lit) continue;
                        float fade = 1.0 - smoothstep(fadeStart, beamEnd, zl);
                        float cosT = dot(lp, -rd) / max(1e-4, length(lp));
                        float e = imp ? 1.0 : 1.0 / (zA * zA);
                        acc += gate * (wq * e * fade * phase(cosT));
                    }
                    float span = imp ? abs(uIn - uOut) / abs(dz) : (tout - tin);
                    if (hazeK < 0.0) {
                        // Fumée : volutes lues une fois, au milieu du premier segment touché
                        vec3 Pm = ro + rd * (0.5 * (tin + tout));
                        float n = texture(uNoise, (Pm * (0.075 / uHazeScale) + uWind * 0.35) * NOISE_UVW).r * 1.12;
                        hazeK = uHaze * max(0.05, 1.0 + uHazeContrast * n);
                    }
                    sum += acc * (span * w);
                }
                if (uDebugCost > 0.5) { gl_FragColor = vec4(vec3(work * 0.01), 1.0); return; }
                if (hazeK < 0.0) discard;
                vec3 col = sum * (irr0 * hazeK * 0.035);
                if (any(isnan(col)) || any(isinf(col))) discard;
                gl_FragColor = vec4(min(col, vec3(60000.0)), 1.0);
            }
        `,
        side: THREE.BackSide,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
}
