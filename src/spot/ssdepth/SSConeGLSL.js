/**
 * SSConeGLSL.js
 * ─────────────────────────────────────────────────────────────
 * GLSL commun aux passes qui parcourent les cônes de SSDepthLights (faisceaux SS Depth, taches de lumière) :
 * lecture des réglages d'un cône (texture uSSLights, format dans SSDepthLights.js) et image de la fenêtre
 * optique en un point (disque de l'iris, atlas de fenêtre, ou image complète calculée : GATE_GLSL).
 * À inclure après GATE_GLSL ; déclare uSSLights et uGateAtlas.
 * ─────────────────────────────────────────────────────────────
 */

import { GATE_ATLAS_R, GATE_ATLAS_SIDE, GATE_ATLAS_TILE } from '../SpotShaders.js?v=5';

export const CONE_GLSL = /* glsl */`
uniform highp sampler2D uSSLights;
uniform sampler2D uGateAtlas;

vec4 LT(int i, int k) { return texelFetch(uSSLights, ivec2(k, i), 0); }

// ── Cône en cours (lu une fois par cône touché) ──
vec3 cLens, cApexC, cW, cR, cU, cCol;
vec2 cV;
float cTanHalf, cIris, cFrostBlur, cLogFocus, cKind, cTile, cOutR2, cPlainR2;
int cRow;
int cSlot;          // emplacement de l'ombre statique (−1 = aucune)
float cIrrL;        // éclairement des taches à 1 m de l'apex
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
    // Jusqu'au niveau 5 (4 × 4 texels par tuile) : flou d'intégration le long des rayons (voir beamScatter)
    float lod = clamp(log2(max(1.0, (blur - cFrostBlur) / texelG)), 0.0, 5.0);
    return textureLod(uGateAtlas, (cell + uv) / ${GATE_ATLAS_SIDE.toFixed(1)}, lod).rgb;
}

// Coordonnées de fenêtre du point P (|g| = 1 : bord du zoom)
vec2 gateCoord(vec3 P) {
    vec3 lp = P - cApexC;
    float zA = max(dot(lp, cW), 1e-3);
    vec3 rad = lp - cW * zA;
    float zl = max(dot(P - cLens, cW), 0.0);
    return vec2(dot(rad, cR), dot(rad, cU)) / (zA * cTanHalf) - cV * (zl / zA);
}

// Image de la fenêtre au point P ; full : image complète (sinon disque ou atlas) ;
// extraBlur : flou ajouté au motif (moyenne du gobo sur la portion de rayon que l'échantillon représente)
vec3 gateAtPoint(vec3 P, bool full, float extraBlur, out float zA, out vec3 lp) {
    lp = P - cApexC;
    zA = max(dot(lp, cW), 1e-3);
    vec3 rad = lp - cW * zA;
    float zl = max(dot(P - cLens, cW), 0.0);   // distance à la lentille le long de l'axe
    vec2 g = vec2(dot(rad, cR), dot(rad, cU)) / (zA * cTanHalf) - cV * (zl / zA);
    float blur = cFrostBlur + min(0.14, abs(log(zl + 0.5) - cLogFocus) * 0.035) + extraBlur;
    if (cKind > 1.5) {
        if (cKind < 2.5) return atlasGate(g, blur);
        if (full) {
            if (dot(g, g) >= cOutR2) return vec3(0.0);
            return gateImage(cG, g, blur);
        }
    }
    return plainGate(g, blur - extraBlur);
}

vec3 gateAtPoint(vec3 P, bool full, out float zA, out vec3 lp) {
    return gateAtPoint(P, full, 0.0, zA, lp);
}

// Réglages complets du cône i (après le test d'intersection : apex, centre des sections WV, z de la lentille)
void loadCone(int i, vec3 apex, vec3 WV, float apexDist, vec4 A6) {
    vec4 A3 = LT(i, 3), A4 = LT(i, 4), A5 = LT(i, 5), A8 = LT(i, 8);
    cR = A3.xyz;
    cU = cross(cR, cW);
    cRow = int(A3.w + 0.5);
    cLens = apex + WV * apexDist;
    cApexC = cLens - cW * apexDist;
    cCol = A4.rgb;
    cTanHalf = A5.x;
    cIris = A5.y;
    cFrostBlur = A5.z;
    cLogFocus = A5.w;
    cV = A8.xy;
    cIrrL = A8.z;
    cSlot = int(floor(A8.w + 0.5));
    cKind = A6.x;
    cTile = A6.y;
    float outR = cIris + 0.012 + cFrostBlur + 0.14;
    cOutR2 = outR * outR;
    float plainR = cIris - (0.012 + cFrostBlur + 0.14);
    cPlainR2 = plainR > 0.0 ? plainR * plainR : -1.0;
    if (cKind > 0.5 && cKind < 1.5) {
        // Frost fort : transmission moyenne des gobos (dernier niveau de mipmap), comme le rendu classique
        vec4 T3 = spotParam(cRow, 3), T4 = spotParam(cRow, 4);
        float avg = 1.0;
        if (T3.x > 0.001) { float sl = mod(floor(T3.x + 0.5), 9.0); if (sl > 0.5) avg *= textureLod(uGobos, vec3(0.5, 0.5, sl), 10.0).r; }
        if (T3.y > 0.001) { float sl = mod(floor(T3.y + 0.5), 8.0); if (sl > 0.5) avg *= textureLod(uGobos, vec3(0.5, 0.5, 8.0 + sl), 10.0).r; }
        if (T4.x > 0.001 && T3.w > 0.5) avg *= mix(1.0, clamp(textureLod(uGobos, vec3(0.5, 0.5, 15.0 + T3.w), 10.0).r * 1.25, 0.0, 1.0), clamp(T4.x, 0.0, 1.0));
        cCol *= avg;
    } else if (cKind > 2.5) {
        cG = loadGate(cRow);
    }
}
`;
