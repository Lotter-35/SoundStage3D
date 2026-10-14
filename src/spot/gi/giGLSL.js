/**
 * giGLSL.js
 * ─────────────────────────────────────────────────────────────
 * Lecture de la GRILLE DE GI (lumière indirecte, voir GIGridPass.js) — GLSL commun au décor (passe des
 * taches de lumière) et au brouillard de salle (HazeShaders.js).
 *
 * La grille est une texture 3D RGBA16F (filtrage trilinéaire matériel : 1 lecture) posée sur la salle ;
 * chaque cellule contient l'éclairement indirect (W/m² dans les unités des taches de lumière) reçu par une
 * surface tournée vers les surfaces éclairées par les lyres. Hors de la grille : CHAMP LOINTAIN (résumé de toutes
 * les lumières virtuelles en 2 sources : points des faisceaux, isotropes ; points du décor, avec leur normale
 * moyenne — voir createGIFarMaterial), fondu sur 6 cellules : pas de rectangle au sol autour des lyres.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';

/** Uniformes partagés (mêmes objets dans tous les matériaux : une mise à jour suffit) */
export function createGIUniforms() {
    return {
        uGI:     { value: null },
        uGIMin:  { value: new THREE.Vector3() },
        uGISize: { value: new THREE.Vector3(1, 1, 1) },
        uGIEdge: { value: new THREE.Vector3(0.01, 0.03, 0.01) },   // demi-cellule (uvw)
        uGIFar:  { value: null },   // champ lointain (5 texels, GIGridPass.farTarget)
        uGIR0:   { value: 1 },      // adoucissement de 1/r² (comme la grille)
    };
}

export const GI_GLSL = /* glsl */`
uniform highp sampler3D uGI;
uniform vec3 uGIMin;
uniform vec3 uGISize;
uniform vec3 uGIEdge;
uniform highp sampler2D uGIFar;
uniform float uGIR0;

// Champ lointain : toutes les lumières virtuelles résumées en 2 sources étendues (centre, étalement σ²)
vec3 giFar(vec3 P) {
    vec3 E = vec3(0.0);
    vec4 b0 = texelFetch(uGIFar, ivec2(0, 0), 0);
    if (b0.w > 0.0) {
        // Points des faisceaux (fumée) : isotropes
        vec4 b1 = texelFetch(uGIFar, ivec2(1, 0), 0);
        vec3 C = b1.xyz / b0.w;
        vec3 d = P - C;
        E += b0.rgb / (dot(d, d) + max(b1.w / b0.w - dot(C, C), 0.0) + uGIR0);
    }
    vec4 s0 = texelFetch(uGIFar, ivec2(2, 0), 0);
    if (s0.w > 0.0) {
        // Points du décor : demi-espace devant leur normale moyenne
        vec4 s1 = texelFetch(uGIFar, ivec2(3, 0), 0);
        vec3 nAvg = texelFetch(uGIFar, ivec2(4, 0), 0).xyz / s0.w;
        vec3 C = s1.xyz / s0.w;
        vec3 d = P - C;
        float r2 = dot(d, d) + max(s1.w / s0.w - dot(C, C), 0.0) + uGIR0;
        E += s0.rgb * (max(dot(nAvg, d), 0.0) * inversesqrt(r2) / r2);
    }
    return E;
}

// Éclairement indirect au point P (monde) : grille, fondue sur 6 cellules aux bords horizontaux vers le champ
// lointain (½ cellule en hauteur : le sol est toujours à plus d'une cellule du bas, voir GIGridPass._autoBounds)
vec3 giAt(vec3 P) {
    vec3 uvw = (P - uGIMin) / uGISize;
    vec3 e = min(uvw, 1.0 - uvw) / (uGIEdge * vec3(12.0, 1.0, 12.0));
    float m = min(min(e.x, e.y), e.z);
    if (m >= 1.0) return texture(uGI, uvw).rgb;
    vec3 far = giFar(P);
    if (m <= 0.0) return far;
    return mix(far, texture(uGI, uvw).rgb, smoothstep(0.0, 1.0, m));
}
`;
