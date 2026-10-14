/**
 * shadowGLSL.js
 * ─────────────────────────────────────────────────────────────
 * Lecture des OMBRES STATIQUES des lyres (cuites par SpotShadowAtlas.js) — GLSL commun aux faisceaux
 * SS Depth, aux faisceaux classiques et aux taches de lumière.
 *
 * Chaque lyre a une « cubemap » de distances centrée sur le pivot de sa tête (point fixe quand elle
 * bouge en pan / tilt) : 6 faces de S × S texels rangées en bloc 3 × 2 dans un atlas 2D (8 blocs par
 * ligne). Un texel contient la distance (m) de la surface du décor la plus proche dans sa direction.
 *
 * Faces (avant, haut, droite = avant × haut) — mêmes repères que les caméras de cuisson :
 *   0 +X (+X, +Y, +Z)   1 −X (−X, +Y, −Z)   2 +Y (+Y, +Z, +X)
 *   3 −Y (−Y, +Z, −X)   4 +Z (+Z, +Y, −X)   5 −Z (−Z, +Y, +X)
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';

/** Lyres ombrées au plus (largeur de la texture d'informations). Au-delà, une lyre n'a pas de cubemap : son
 *  faisceau et sa tache traversent les murs (64 était atteint par une grille de 64 lyres + 1). L'atlas ne
 *  grandit qu'avec les lyres présentes (lignes de 8 blocs), dans la limite de la taille de texture du GPU. */
export const SHADOW_MAX_SLOTS = 256;
/** Blocs de 3 × 2 faces par ligne de l'atlas */
export const SHADOW_BLOCKS_PER_ROW = 8;
/** Distance écrite là où aucun objet du décor n'est vu (m) */
export const SHADOW_FAR = 10000;

/** Repères des 6 faces : avant, haut (la droite = avant × haut) */
export const SHADOW_FACES = [
    [[1, 0, 0], [0, 1, 0]],
    [[-1, 0, 0], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1]],
    [[0, -1, 0], [0, 0, 1]],
    [[0, 0, 1], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0]],
];

/** Uniformes partagés (mêmes objets dans tous les matériaux : une mise à jour suffit) */
export function createShadowUniforms() {
    return {
        uShadowAtlas: { value: null },
        uShadowInfo:  { value: null },
        uShadowSize:  { value: 0 },      // S (texels par face) ; 0 = ombres désactivées
    };
}

export const SHADOW_GLSL = /* glsl */`
uniform highp sampler2D uShadowAtlas;
uniform highp sampler2D uShadowInfo;
uniform float uShadowSize;

// Origine (xyz) de la cubemap de la lyre et validité (w) ; slot < 0 : pas d'ombre
vec4 shadowInfo(int slot) {
    return texelFetch(uShadowInfo, ivec2(slot, 0), 0);
}

// Position (texels, réels) dans la face qui voit la direction v ; coin de la face dans l'atlas
vec2 shadowTexel(int slot, vec3 v, out ivec2 face0) {
    vec3 a = abs(v);
    int f;
    vec2 st;
    float ma;
    if (a.x >= a.y && a.x >= a.z) { ma = a.x; if (v.x > 0.0) { f = 0; st = vec2(v.z, v.y); } else { f = 1; st = vec2(-v.z, v.y); } }
    else if (a.y >= a.z)          { ma = a.y; if (v.y > 0.0) { f = 2; st = vec2(v.x, v.z); } else { f = 3; st = vec2(-v.x, v.z); } }
    else                          { ma = a.z; if (v.z > 0.0) { f = 4; st = vec2(-v.x, v.y); } else { f = 5; st = vec2(v.x, v.y); } }
    int S = int(uShadowSize);
    face0 = ivec2((slot % ${SHADOW_BLOCKS_PER_ROW}) * 3 * S + (f % 3) * S, (slot / ${SHADOW_BLOCKS_PER_ROW}) * 2 * S + (f / 3) * S);
    return (st / max(ma, 1e-6) * 0.5 + 0.5) * uShadowSize;
}

// Ombre dure (1 lecture) : 1 = éclairé. bias en mètres.
float shadowHard(int slot, vec3 origin, vec3 P, float bias) {
    vec3 v = P - origin;
    ivec2 f0;
    vec2 t = shadowTexel(slot, v, f0);
    int S = int(uShadowSize);
    ivec2 p = clamp(ivec2(t), ivec2(0), ivec2(S - 1));
    return length(v) - bias <= texelFetch(uShadowAtlas, f0 + p, 0).r ? 1.0 : 0.0;
}

// Distance (m) de la surface du décor vue dans la direction v (1 lecture, sans filtre) ; SHADOW_FAR = rien
float shadowDepth(int slot, vec3 v) {
    ivec2 f0;
    vec2 t = shadowTexel(slot, v, f0);
    int S = int(uShadowSize);
    return texelFetch(uShadowAtlas, f0 + clamp(ivec2(t), ivec2(0), ivec2(S - 1)), 0).r;
}

// Ombre filtrée (PCF 2 × 2 bilinéaire, 4 lectures, sans déborder sur la face voisine) : 0…1
float shadowPCF(int slot, vec3 origin, vec3 P, float bias) {
    vec3 v = P - origin;
    ivec2 f0;
    vec2 t = shadowTexel(slot, v, f0) - 0.5;
    int S = int(uShadowSize);
    vec2 fl = floor(t);
    vec2 fr = t - fl;
    ivec2 b = ivec2(fl);
    float d = length(v) - bias;
    ivec2 m = ivec2(S - 1);
    float s00 = d <= texelFetch(uShadowAtlas, f0 + clamp(b, ivec2(0), m), 0).r ? 1.0 : 0.0;
    float s10 = d <= texelFetch(uShadowAtlas, f0 + clamp(b + ivec2(1, 0), ivec2(0), m), 0).r ? 1.0 : 0.0;
    float s01 = d <= texelFetch(uShadowAtlas, f0 + clamp(b + ivec2(0, 1), ivec2(0), m), 0).r ? 1.0 : 0.0;
    float s11 = d <= texelFetch(uShadowAtlas, f0 + clamp(b + ivec2(1, 1), ivec2(0), m), 0).r ? 1.0 : 0.0;
    return mix(mix(s00, s10, fr.x), mix(s01, s11, fr.x), fr.y);
}

// Taille d'un texel de la cubemap à la distance d (m)
float shadowTexelSize(float d) {
    return d * 2.0 / max(uShadowSize, 1.0);
}
`;

/** Texture d'informations vide (aucune ombre) */
export function createShadowInfoTexture() {
    const data = new Float32Array(SHADOW_MAX_SLOTS * 4);
    const tex = new THREE.DataTexture(data, SHADOW_MAX_SLOTS, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
}
