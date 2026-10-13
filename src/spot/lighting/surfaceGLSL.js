/**
 * surfaceGLSL.js
 * ─────────────────────────────────────────────────────────────
 * GLSL commun aux passes qui éclairent le DÉCOR sans G-buffer (taches de lumière, lumières virtuelles de la
 * GI, reflets des faisceaux) :
 *
 *   - SCREEN_GLSL : profondeur de la scène → position (repère caméra / monde) et NORMALE reconstruite depuis
 *     la profondeur (voisin de plus petit écart en x et en y : pas de halo sur les silhouettes). Déclare
 *     uDepth, uFull, uCamRot, uProjK, uNear, uFar.
 *   - SURFACE_GLSL : matériau d'un point du décor classé par sa position et sa normale (comme material() du
 *     banc C++) : pelouse (texture du sol, mate), dessus du plateau / marches / table (lino noir brillant),
 *     reste du décor (lino satiné). Déclare uGrass, uGrassOn.
 * ─────────────────────────────────────────────────────────────
 */

/** Albédo moyen (linéaire) de la pelouse de stage.js */
export const GRASS_ALBEDO = [0.073, 0.141, 0.026];
/** Lino noir : 0,025 en moyenne dans la texture, relevé (poussière, micro-rayures d'un plateau réel) pour que les
 *  taches restent lisibles sur le plateau comme avec les anciennes lumières (+35 % de stage.js en plus) */
export const LINO_ALBEDO = [0.05, 0.048, 0.056];

export const SCREEN_GLSL = /* glsl */`
uniform highp sampler2D uDepth;
uniform vec2 uFull;
uniform mat3 uCamRot;
uniform vec4 uProjK;
uniform float uNear;
uniform float uFar;

float linZ(ivec2 p) { return -perspectiveDepthToViewZ(texelFetch(uDepth, p, 0).r, uNear, uFar); }
vec3 rayView(vec2 px) {
    vec2 ndc = px / uFull * 2.0 - 1.0;
    return vec3((ndc.x + uProjK.z) * uProjK.x, (ndc.y + uProjK.w) * uProjK.y, -1.0);
}
vec3 viewPos(ivec2 p) { return rayView(vec2(p) + 0.5) * linZ(p); }

// Normale (repère monde) du pixel c de position vp (repère caméra), tournée vers la caméra
vec3 screenNormal(ivec2 c, vec3 vp) {
    ivec2 fullI = ivec2(uFull);
    vec3 pl = viewPos(max(c - ivec2(1, 0), ivec2(0))), pr = viewPos(min(c + ivec2(1, 0), fullI - 1));
    vec3 pd = viewPos(max(c - ivec2(0, 1), ivec2(0))), pu = viewPos(min(c + ivec2(0, 1), fullI - 1));
    // Bord de l'image : seul le voisin intérieur existe
    bool useR = c.x == 0 || (c.x < fullI.x - 1 && abs(pr.z - vp.z) < abs(vp.z - pl.z));
    bool useU = c.y == 0 || (c.y < fullI.y - 1 && abs(pu.z - vp.z) < abs(vp.z - pd.z));
    vec3 dx = useR ? pr - vp : vp - pl;
    vec3 dy = useU ? pu - vp : vp - pd;
    vec3 cr = cross(dx, dy);
    vec3 nv = dot(cr, cr) > 1e-20 ? normalize(cr) : -normalize(vp);
    if (dot(nv, vp) > 0.0) nv = -nv;
    return normalize(uCamRot * nv);
}
`;

export const SURFACE_GLSL = /* glsl */`
uniform sampler2D uGrass;
uniform float uGrassOn;

// Matériau de la surface (pas de G-buffer) : sol, plateau, décor
void surface(vec3 P, vec3 N, out vec3 albedo, out float rough, out float specK) {
    if (P.y < 0.35 && N.y > 0.6) {
        // Pelouse (stage.js : texture répétée tous les 5 m), mate
        albedo = uGrassOn > 0.5 ? texture(uGrass, P.xz * 0.2).rgb : vec3(${GRASS_ALBEDO.join(', ')});
        rough = 0.9;
        specK = 0.4;
    } else if (N.y > 0.75) {
        // Dessus du plateau, des marches, de la table : lino noir brillant (piste de danse)
        albedo = vec3(${LINO_ALBEDO.join(', ')}) * 1.35;
        rough = 0.3;
        specK = 1.5;
    } else {
        // Reste du décor : lino satiné (mur, poteaux, toit, enceintes…)
        albedo = vec3(${LINO_ALBEDO.join(', ')}) * 1.35;
        rough = 0.6;
        specK = 1.0;
    }
}
`;
