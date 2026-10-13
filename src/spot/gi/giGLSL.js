/**
 * giGLSL.js
 * ─────────────────────────────────────────────────────────────
 * Lecture de la GRILLE DE GI (lumière indirecte, voir GIGridPass.js) — GLSL commun au décor (passe des
 * taches de lumière) et au brouillard de salle (HazeShaders.js).
 *
 * La grille est une texture 3D RGBA16F (filtrage trilinéaire matériel : 1 lecture) posée sur la salle ;
 * chaque cellule contient l'éclairement indirect (W/m² dans les unités des taches de lumière) reçu par une
 * surface tournée vers les surfaces éclairées par les lyres. Hors de la grille : rien (fondu d'une
 * demi-cellule sur les bords).
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
    };
}

export const GI_GLSL = /* glsl */`
uniform highp sampler3D uGI;
uniform vec3 uGIMin;
uniform vec3 uGISize;
uniform vec3 uGIEdge;

// Éclairement indirect au point P (monde)
vec3 giAt(vec3 P) {
    vec3 uvw = (P - uGIMin) / uGISize;
    vec3 e = min(uvw, 1.0 - uvw) / uGIEdge;
    float m = min(min(e.x, e.y), e.z);
    if (m <= 0.0) return vec3(0.0);
    return texture(uGI, uvw).rgb * min(m, 1.0);
}
`;
