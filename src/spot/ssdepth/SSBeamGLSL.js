/**
 * SSBeamGLSL.js
 * ─────────────────────────────────────────────────────────────
 * GLSL commun aux passes qui intègrent la DIFFUSION d'un faisceau le long d'un rayon (SS Depth, plan R1) :
 * faisceaux vus par la caméra (SSDepthShaders.js) et faisceaux vus en reflet sur les surfaces brillantes
 * (reflect/BeamReflectShaders.js, plan R6).
 *
 *   - coneRay : intersection EXACTE rayon / cône oblique (facette du prisme), bornée par la lentille, le
 *     bout du cône et une distance maximale (3 lectures de la texture des cônes faites par l'appelant) ;
 *   - clipBeamEnd : arrêt à la longueur visible du faisceau ;
 *   - beamScatter : quadrature de Gauss à 3 points (en 1/z quand le rayon remonte le faisceau), image de
 *     fenêtre complète sur l'échantillon du milieu, ombre à chaque échantillon (cubemap statique, sinon
 *     boîtes de SpotOcclusion), phase de Mie identique au rendu classique. Lyre à gobo (atlas ou image
 *     calculée) : 4 à 12 échantillons réguliers (pas en 1/z) selon la portion du motif que le rayon traverse,
 *     décalés d'un pixel à l'autre et légèrement floutés : rais droits du gobo comme le rendu classique, au
 *     lieu de copies nettes et décalées (3 échantillons fixes donnaient des spirales en double et des arcs).
 *
 * À inclure après GATE_GLSL, CONE_GLSL et SHADOW_GLSL ; déclare uBoxMin / uBoxMax, uPhaseG.
 * ─────────────────────────────────────────────────────────────
 */

import { MAX_OCCLUDERS } from '../SpotOcclusion.js';

export const BEAM_RAY_GLSL = /* glsl */`
uniform vec3 uBoxMin[${MAX_OCCLUDERS}];
uniform vec3 uBoxMax[${MAX_OCCLUDERS}];
uniform float uPhaseG;
float gWork = 0.0;   // vue « coût des lyres » : travail du pixel (render/costDebug.js)

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

// Intersection rayon ↔ cône oblique (axe cW déjà chargé), bornée par les plans z ∈ [zS, zE] et t ∈ [0, tMax].
// z0, dz : position / pente du rayon le long de l'axe depuis l'apex (toujours calculés).
bool coneRay(vec3 ro, vec3 rd, vec3 apex, float tanO, float zS, vec3 WV, float zE, float tMax,
             out float tin, out float tout, out float z0, out float dz) {
    vec3 q = ro - apex;
    z0 = dot(q, cW);
    dz = dot(rd, cW);
    vec3 qa = q - WV * z0;
    vec3 qb = rd - WV * dz;
    float k2 = tanO * tanO;
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
        // Double cône ouvert vers le rayon : la partie avant (z > 0) est d'un seul tenant
        float sq = sqrt(disc);
        float r1 = (-QB + sq) / QA, r2 = (-QB - sq) / QA;   // QA < 0 : r1 < r2
        if (!(r2 <= tin || r1 >= tout)) {
            if (r1 > tin) tout = min(tout, r1); else tin = max(tin, r2);
        }
    }
    tin = max(tin, 0.0);
    tout = min(tout, tMax);
    return tout > tin;
}

// Diffusion arrêtée à la longueur visible (le cône va plus loin quand la tache au sol porte plus loin)
bool clipBeamEnd(float zS, float beamEnd, float z0, float dz, inout float tin, inout float tout) {
    float zEnd = zS + beamEnd;
    if (abs(dz) > 1e-6) {
        float tl = (zEnd - z0) / dz;
        if (dz > 0.0) tout = min(tout, tl); else tin = max(tin, tl);
    } else if (z0 > zEnd) tout = tin;
    return tout > tin;
}

// Diffusion du cône chargé (loadCone) sur [tin, tout] : quadrature de Gauss à 3 points (gobo : 4 à 12 points
// réguliers décalés par pixel), × longueur du segment
// (à multiplier par l'éclairement du faisceau et la densité de la fumée)
vec3 beamScatter(vec3 ro, vec3 rd, float tin, float tout, float dz, float apexDist, float fadeB, float beamEnd,
                 vec4 SH, bool hasCube, bool hasOcc, vec4 T8) {
    float zc0 = dot(ro - cApexC, cW);
    float zIn = max(zc0 + dz * tin, 1e-3);
    float zOut = max(zc0 + dz * tout, 1e-3);
    // Répartition en 1/z (échantillons serrés près de la lentille) : pas pour les gobos, dont le motif doit être
    // échantillonné régulièrement sur toute la traversée (sinon la partie lointaine montre des arcs du gobo)
    bool imp = cKind < 1.5 && abs(dz) > 0.05 && max(zIn, zOut) > 1.3 * min(zIn, zOut);
    float uIn = 1.0 / zIn, uOut = 1.0 / zOut;
    // Portion du motif (en unités de fenêtre) que le rayon traverse dans le cône
    float sweep = length(gateCoord(ro + rd * tout) - gateCoord(ro + rd * tin));
    if (!(sweep < 1e3)) sweep = 1e3;   // infini ou NaN
    int N = 3;
    bool gauss = true;
    if (cKind > 1.5) {
        // Toujours décalés d'un pixel à l'autre : un sous-échantillonnage donne un grain fin, pas des arcs
        N = int(clamp(ceil(sweep * 6.0), 4.0, 12.0));
        gauss = false;
    }
    // Flou d'intégration : le quart de l'écart entre 2 échantillons, mesuré dans la fenêtre ; échantillons
    // décalés d'un pixel à l'autre (comme le rendu classique) : les rais du gobo restent nets, sans copies
    float extraBlur = gauss ? 0.0 : min(0.4, sweep / float(N) * 0.25);
    float jit = gauss ? 0.5 : fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    int mid = N / 2;
    vec3 sum = vec3(0.0);
    for (int s = 0; s < 12; s++) {
        if (s >= N) break;
        // Gauss-Legendre à 3 points sur [0, 1] : nœuds 0,1127 / 0,5 / 0,8873, poids 5/18, 8/18, 5/18
        // (les nœuds à 2 points 0,2113 / 0,7887 avec ces poids surestimaient le faisceau de 20 à 40 %)
        float x = gauss ? (s == 0 ? 0.1127017 : (s == 1 ? 0.5 : 0.8872983)) : (float(s) + jit) / float(N);
        float w = gauss ? (s == 1 ? 0.4444444 : 0.2777778) : 1.0 / float(N);
        float t;
        if (imp) {
            float z = 1.0 / mix(uIn, uOut, x);
            t = (z - zc0) / dz;
        } else {
            t = mix(tin, tout, x);
        }
        vec3 P = ro + rd * t;
        float zA; vec3 lp;
        vec3 gate = gateAtPoint(P, s == mid, extraBlur, zA, lp);
        gWork += (hasCube || hasOcc) ? 2.0 : 1.0;
        if (gate.r + gate.g + gate.b < 1e-5) continue;
        if (hasCube) {
            float dl = length(P - SH.xyz);
            if (shadowHard(cSlot, SH.xyz, P, 0.06 + shadowTexelSize(dl)) < 0.5) continue;
        } else if (hasOcc) {
            vec3 sd = P - cLens;
            if (segBlocked(cLens, sd, 1.0 - 0.03 / max(length(sd), 0.05), T8)) continue;
        }
        float zl = zA - apexDist;
        float fade = beamFade(zl, fadeB, beamEnd);
        float cosT = dot(lp, -rd) / max(1e-4, length(lp));
        // Répartition en 1/z : l'éclairement 1/z² est intégré exactement (poids sans 1/z²)
        float e = imp ? 1.0 : 1.0 / (zA * zA);
        sum += gate * (w * e * fade * phase(cosT));
    }
    float span = imp ? abs(uIn - uOut) / abs(dz) : (tout - tin);
    return sum * span;
}
`;
