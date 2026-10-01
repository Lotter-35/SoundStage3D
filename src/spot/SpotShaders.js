/**
 * SpotShaders.js
 * ─────────────────────────────────────────────────────────────
 * Shaders des lyres Spot :
 *
 * 1. FAISCEAU VOLUMÉTRIQUE (createVolumeMaterial)
 *    Cône instancié (1 instance par lyre, 1 draw call pour toutes les lyres) rendu en
 *    faces arrière. Avec un prisme, le cône est l'ENVELOPPE des facettes : chaque pixel
 *    n'est calculé qu'une fois et additionne l'image de fenêtre de toutes les facettes
 *    (fumée, ombre et profondeur lues une seule fois au lieu d'une fois par facette).
 *    Pour chaque pixel :
 *      - intersection ANALYTIQUE rayon de vue ↔ cône (+ plans lentille / portée)
 *      - arrêt exact sur la scène grâce à la profondeur (DepthTexture)
 *      - intégration de la diffusion le long du rayon (jusqu'à 18 pas tramés ; répartis selon
 *        l'éclairement quand on regarde le long du faisceau ; arrêt dès que le pixel est saturé) :
 *          éclairement en 1/d² depuis l'apex optique, fumée volumétrique 3D
 *          animée par le vent, phase de Mie (Henyey-Greenstein : le faisceau est
 *          bien plus brillant quand on regarde vers la lyre)
 *      - image de la fenêtre optique (« gate ») projetée dans le volume :
 *          gobos fixes / rotatifs (glissement des roues), roue d'animation,
 *          iris, 4 couteaux + rotation du bloc, demi-couleurs, frost, focus
 *          (le gobo est net à la distance de mise au point, flou ailleurs)
 *      - tache de lumière sur les surfaces pour les lyres sans lumière réelle
 *
 * 2. COMPOSITION (createCompositeMaterial) : ajoute les faisceaux (rendus en
 *    demi-résolution) à l'image de la scène.
 *
 * 3. TEXTURE DE PROJECTION (createGateMapMaterial) : dessine la même image de
 *    fenêtre (gobos, prisme, couleurs…) dans la texture `map` des SpotLight réels
 *    → le gobo projeté sur le décor correspond exactement au faisceau.
 *
 * 4. ÉBLOUISSEMENT (createGlareMaterial) : halo de lentille quand on regarde
 *    dans le faisceau (bloom lampes).
 *
 * Les paramètres de chaque lyre sont lus dans une DataTexture float
 * (SPOT_TEXELS texels RGBA par lyre), comme pour les lasers.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { SMOKE_NOISE_UVW_SCALE } from '../laser/LaserSmokeNoise.js';
import { occluderUniforms, MAX_OCCLUDERS } from './SpotOcclusion.js';

/** Texels RGBA par lyre dans la texture de paramètres */
export const SPOT_TEXELS = 13;

/**
 * Atlas de l'image de fenêtre : une tuile par lyre (gobos, roue d'animation, couteaux, couleurs, frost),
 * dessinée une fois par image. Le faisceau la lit en un accès au lieu de recalculer les roues à chaque
 * pas et pour chaque facette du prisme. Le flou de mise au point passe par les niveaux de mipmap.
 */
export const GATE_ATLAS_SIDE = 8;        // tuiles par côté (64 lyres)
export const GATE_ATLAS_TILE = 128;      // pixels par tuile
export const GATE_ATLAS_R = 1.6;         // la tuile couvre g ∈ [−R, R] (iris + flou maximal)
/*
 * T0 : couleur A (rgb)            , flux (intensité × dimmer × obturateur)
 * T1 : couleur B (rgb)            , position de la frontière des demi-couleurs (2 = aucune)
 * T2 : tan(zoom/2)                , iris [0.05…1] , frost [0…1] , distance de mise au point (m)
 * T3 : position roue gobos fixes  , position roue gobos rotatifs , angle gobo rotatif , emplacement anim
 * T4 : insertion anim             , angle anim , poids de la tache de surface , rayon de lentille
 * T5 : couteau 1 (ins, angle)     , couteau 2 (ins, angle)
 * T6 : couteau 3 (ins, angle)     , couteau 4 (ins, angle)
 * T7 : rotation bloc couteaux     , éblouissement , tan(demi-angle du cône) , distance apex → lentille
 * T8 : indices des 4 obstacles de la scène à tester (−1 = aucun) — voir SpotOcclusion.js
 * T9 : nombre de facettes du prisme (0…8) , tan(demi-angle de l'enveloppe) , poids du faisceau central , poids d'une facette
 * T10: décalage de la 1re facette (xy, unités de fenêtre) , passage d'une facette à la suivante : rotation (cos, sin)
 * T11: passage d'une facette à la suivante : translation (xy, prisme linéaire) ,
 *      début du rendu (m depuis la lentille) , fin du rendu (m, 0 = portée entière)
 *      (facette i+1 = rotation(facette i) + translation ; son image est décalée de décalage × s / z,
 *       s = distance à la lentille, z = distance à l'apex : toutes les facettes sortent de la lentille)
 *
 * Ligne d'une BARRE LED (instance de poids < 0 : toutes les LED d'une barre en un seul volume) :
 * T0 : –, pondération du flux des LED | T1 : 2e couleur (rgb), frontière des demi-couleurs (2 = aucune)
 * T2 : –, iris (1), frost (0), mise au point | T4 : –, –, poids de la tache de surface, rayon d'une LED
 * T7 : –, éblouissement, tan(demi-angle du cône le plus large), – | T8 : obstacles
 * T9 : tan(zoom/2) gauche, droite, 1re LED du côté droit, tan(cône) / tan(zoom/2)
 * T10: 1re ligne des LED (lignes consécutives : couleur, flux) , nombre de LED , pas (m) , demi-couleur selon la hauteur
 * T11: – , – , début du volume (m : les faisceaux individuels couvrent la zone plus proche) , –
 *
 * T12 (toutes les lignes) : tuile de l'atlas de fenêtre + 1 (0 = aucune : image calculée dans le shader) , – , – , –
 */

// ─────────────────────────────────────────────────────────────────────────────
// GLSL commun : lecture des paramètres + image de la fenêtre optique
// ─────────────────────────────────────────────────────────────────────────────
const GATE_GLSL = /* glsl */`
uniform highp sampler2D uSpotParams;
uniform highp sampler2DArray uGobos;

vec4 spotParam(int row, int texel) {
    return texelFetch(uSpotParams, ivec2(texel, row), 0);
}

const float GOBO_SPACING = 2.35;   // écart entre 2 gobos sur la roue (unités de fenêtre)
const float WHEEL_HOLE = 1.08;     // rayon du trou d'un emplacement de roue

// Un emplacement de roue : trou circulaire + motif (couche de la texture de gobos)
float slotImage(float slot, float layerBase, vec2 p, float lod, float edge) {
    float hole = 1.0 - smoothstep(WHEEL_HOLE - edge, WHEEL_HOLE + edge, length(p));
    if (hole <= 0.0) return 0.0;
    if (slot < 0.5) return hole;
    float layer = layerBase + slot;
    return hole * textureLod(uGobos, vec3(p * 0.5 + 0.5, layer), lod).r;
}

// Roue de gobos à N emplacements, position continue (le motif glisse dans la fenêtre)
float wheelMask(float pos, float n, float layerBase, vec2 g, float lod, float edge, mat2 rot) {
    float a = floor(pos);
    float f = pos - a;
    float s0 = mod(a, n);
    float m = slotImage(s0, layerBase, rot * (g + vec2(f * GOBO_SPACING, 0.0)), lod, edge);
    if (f > 0.001) {
        float s1 = mod(a + 1.0, n);
        m += slotImage(s1, layerBase, rot * (g - vec2((1.0 - f) * GOBO_SPACING, 0.0)), lod, edge);
    }
    return m;
}

// Réglages optiques d'une lyre, lus et préparés UNE fois (et non à chaque échantillon du faisceau)
struct Gate {
    vec4 T0, T1, T2, T3, T4;
    mat2 rotWheel;      // rotation de la roue de gobos rotatifs
    mat2 rotAnim;       // rotation de la roue d'animation
    vec4 blade[4];      // couteau k : centre de coupe (xy), normale (zw)
    vec4 bladeIns;      // insertion des 4 couteaux
    bool anyBlade;
    bool hasFixed;      // gobo fixe inséré
    bool hasRot;        // gobo rotatif inséré
    bool hasAnim;       // roue d'animation insérée
    bool halfCol;       // demi-couleurs
};

Gate makeGate(vec4 T0, vec4 T1, vec4 T2, vec4 T3, vec4 T4, vec4 T5, vec4 T6, vec4 T7) {
    Gate G;
    G.T0 = T0; G.T1 = T1; G.T2 = T2; G.T3 = T3; G.T4 = T4;
    G.hasFixed = T3.x > 0.001;
    G.hasRot = T3.y > 0.001;
    G.hasAnim = T4.x > 0.001 && T3.w > 0.5;
    G.halfCol = T1.w < 1.9;
    G.bladeIns = vec4(T5.x, T5.z, T6.x, T6.z);
    G.anyBlade = max(max(G.bladeIns.x, G.bladeIns.y), max(G.bladeIns.z, G.bladeIns.w)) >= 0.001;
    // Rotations et couteaux : calculés seulement s'ils servent
    G.rotWheel = mat2(1.0);
    G.rotAnim = mat2(1.0);
    if (G.hasRot) {
        float c = cos(T3.z), s = sin(T3.z);
        G.rotWheel = mat2(c, s, -s, c);
    }
    if (G.hasAnim) {
        float c = cos(T4.y), s = sin(T4.y);
        G.rotAnim = mat2(c, s, -s, c);
    }
    for (int k = 0; k < 4; k++) G.blade[k] = vec4(0.0);
    if (G.anyBlade) {
        vec4 bladeAng = vec4(T5.y, T5.w, T6.y, T6.w);
        const float HP = 1.5707963;
        for (int k = 0; k < 4; k++) {
            float baseA = T7.x + float(k) * HP;
            vec2 c0 = vec2(cos(baseA), sin(baseA)) * (1.06 - G.bladeIns[k] * 1.5);
            float a = baseA + bladeAng[k];
            G.blade[k] = vec4(c0, cos(a), sin(a));
        }
    }
    return G;
}

Gate loadGate(int row) {
    return makeGate(spotParam(row, 0), spotParam(row, 1), spotParam(row, 2), spotParam(row, 3),
                    spotParam(row, 4), spotParam(row, 5), spotParam(row, 6), spotParam(row, 7));
}

float bladeCut(vec2 g, float ins, vec4 b, float edge) {
    if (ins < 0.001) return 1.0;
    float d = dot(g - b.xy, b.zw);
    return 1.0 - smoothstep(-edge, edge, d);
}

// Image de la fenêtre optique en coordonnées de fenêtre g (|g| = 1 : bord du zoom).
// blur : flou (frost + mise au point) en unités de fenêtre.
vec3 gateImage(Gate G, vec2 g, float blur) {
    float r = length(g);
    float edge = 0.012 + blur;
    float iris = G.T2.y;
    // Diaphragme (iris) puis fenêtre (gate)
    float mask = 1.0 - smoothstep(min(iris, 1.0) - edge, min(iris, 1.0) + edge, r);
    if (mask <= 0.0) return vec3(0.0);

    float lod = log2(max(1.0, edge * 110.0));

    // Roue de gobos fixes (couches 0…8) et roue de gobos rotatifs (couches 9…15)
    if (G.hasFixed) mask *= wheelMask(G.T3.x, 9.0, 0.0, g, lod, edge, mat2(1.0));
    if (G.hasRot) mask *= wheelMask(G.T3.y, 8.0, 8.0, g, lod, edge, G.rotWheel);
    if (mask <= 0.0) return vec3(0.0);

    // Roue d'animation : disque gravé qui tourne hors de l'axe et entre par le bas
    if (G.hasAnim) {
        vec2 q = G.rotAnim * (g - vec2(2.6, 0.0)) * 0.24;
        float pat = textureLod(uGobos, vec3(q, 15.0 + G.T3.w), lod).r;
        // Le disque entre par le bas de la fenêtre et la recouvre entièrement une fois inséré
        float cover = 1.0 - smoothstep(G.T4.x * 2.6 - 1.3 - 0.2, G.T4.x * 2.6 - 1.3 + 0.2, g.y);
        mask *= mix(1.0, clamp(pat * 1.25, 0.0, 1.0), cover);
    }

    // Couteaux (framing) : 4 lames + rotation du bloc
    if (G.anyBlade) {
        mask *= bladeCut(g, G.bladeIns.x, G.blade[0], edge);
        mask *= bladeCut(g, G.bladeIns.y, G.blade[1], edge);
        mask *= bladeCut(g, G.bladeIns.z, G.blade[2], edge);
        mask *= bladeCut(g, G.bladeIns.w, G.blade[3], edge);
    }

    // Champ légèrement plus chaud au centre (réflecteur + optique)
    mask *= 1.0 - 0.2 * min(r * r, 1.0);

    // Demi-couleurs : frontière entre 2 filtres de la roue qui traverse la fenêtre
    vec3 col = G.T0.rgb;
    if (G.halfCol) col = mix(G.T0.rgb, G.T1.rgb, smoothstep(G.T1.w - edge, G.T1.w + edge, g.x));
    return col * mask;
}

vec3 spotGate(int row, vec2 g, float blur) {
    return gateImage(loadGate(row), g, blur);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Faisceau volumétrique
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {object} [o]
 * @param {boolean} [o.bar] volume des barres LED (toutes les LED d'une barre en une instance)
 * @param {boolean} [o.prism] lyres à prisme (somme des facettes)
 * Variantes séparées : le code du prisme ou des barres alourdirait le shader de toutes les lyres
 * (plus de registres → moins de pixels calculés en parallèle, ~15 % plus lent)
 */
export function createVolumeMaterial(paramsTexture, goboTexture, noiseTexture, { bar = false, prism = false } = {}) {
    const occ = occluderUniforms();
    return new THREE.ShaderMaterial({
        uniforms: {
            uBoxMin:     { value: occ.mins },
            uGateAtlas:  { value: null },
            uBoxMax:     { value: occ.maxs },
            uSpotParams: { value: paramsTexture },
            uGobos:      { value: goboTexture },
            uNoise:      { value: noiseTexture },
            uDepth:      { value: null },
            uInvRes:     { value: new THREE.Vector2(1, 1) },
            uNear:       { value: 0.1 },
            uFar:        { value: 5000 },
            uCamFwd:     { value: new THREE.Vector3(0, 0, -1) },
            uHaze:       { value: 0.6 },
            uHazeContrast: { value: 0.65 },
            uHazeScale:  { value: 1.0 },
            uPhaseG:     { value: 0.72 },
            uWind:       { value: new THREE.Vector3() },
            uTime:       { value: 0 },
        },
        vertexShader: /* glsl */`
            uniform highp sampler2D uSpotParams;
            attribute vec4 iLens;   // position de la lentille, ligne de paramètres
            attribute vec4 iAxis;   // axe du faisceau, longueur
            attribute vec4 iRight;  // axe « droite » de la fenêtre, poids de la facette
            flat varying vec4 vLens;
            flat varying vec4 vAxis;
            flat varying vec4 vRight;
            varying vec3 vWorld;

            void main() {
                int row = int(iLens.w + 0.5);
                vec4 T4 = texelFetch(uSpotParams, ivec2(4, row), 0);
                vec4 T9 = texelFetch(uSpotParams, ivec2(9, row), 0);
                vec3 W = iAxis.xyz;
                vec3 R = iRight.xyz;
                // Repère DIRECT (R, W×R, W) : conserve le sens des triangles (faces arrière = intérieur du cône)
                vec3 U = cross(W, R);
                float L = iAxis.w;
                vec4 T11 = texelFetch(uSpotParams, ivec2(11, row), 0);
                float sEnd = T11.w > 0.0 ? min(T11.w, L) : L;
                float s = mix(T11.z, sEnd, position.z);  // distance à la lentille (début → fin du rendu)
                vec3 world;
#ifdef BAR_MODE
                    // Barre LED : tronc de pyramide (LED alignées sur R) inscrit dans une ellipse (× √2 + marge du polygone)
                    vec4 T7 = texelFetch(uSpotParams, ivec2(7, row), 0);
                    vec4 T10 = texelFetch(uSpotParams, ivec2(10, row), 0);
                    float grow = T4.w + s * T7.z;
                    float halfX = 0.5 * (T10.y - 1.0) * T10.z;
                    world = iLens.xyz + W * s + (R * position.x * (halfX + grow) + U * position.y * grow) * 1.43;
#else
                    // rayon réel du cône (enveloppe des facettes du prisme) à cette distance (+3 % : le polygone contient le cercle)
                    float rad = (T4.w + s * T9.y) * 1.035;
                    world = iLens.xyz + W * s + (R * position.x + U * position.y) * rad;
#endif
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
            uniform float uTime;
            uniform vec3 uBoxMin[${MAX_OCCLUDERS}];
            uniform vec3 uBoxMax[${MAX_OCCLUDERS}];
            uniform sampler2D uGateAtlas;
            flat varying vec4 vLens;
            flat varying vec4 vAxis;
            flat varying vec4 vRight;
            varying vec3 vWorld;

            const float PI = 3.14159265;

            // Le segment a → a + d·t (t < tMax) traverse-t-il un des obstacles de la lyre ?
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
            const float NOISE_UVW = ${SMOKE_NOISE_UVW_SCALE.toFixed(8)};

            // Fumée : 2 octaves de bruit ; 1 seule (amplitude compensée) quand la caméra est dans le
            // faisceau — le détail fin ne se voit pas dans un faisceau qui éblouit
            float hazeNoise(vec3 p, bool coarse) {
                vec3 q = (p * (0.075 / uHazeScale) + uWind * 0.35) * NOISE_UVW;
                float n = texture(uNoise, q).r;
                if (coarse) n *= 1.12;
                else n += 0.5 * texture(uNoise, q * 2.7 + vec3(0.31, 0.17, 0.53) + vec3(uTime * 0.004)).r;
                return n;
            }
            float hazeFromNoise(float n) {
                return uHaze * max(0.05, 1.0 + uHazeContrast * n);
            }

            // Phase de diffusion : 35 % Henyey-Greenstein (diffusion avant de la fumée) + 65 % isotrope
            // normalisée pour valoir ≈ 1 vue de côté. x^1.5 = x·√x (sans pow)
            float phase(float cosT) {
                float g = uPhaseG;
                float x = max(1e-4, 1.0 + g * g - 2.0 * g * cosT);
                float hg = (1.0 - g * g) * inversesqrt(x) / x;
                return 0.65 + 0.35 * hg;
            }

            float ign(vec2 p) {
                return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
            }

            // Prisme et raccourci du faisceau ouvert : lus une fois par pixel
            float pMainW, pFacetW, pPlainR2, pOutR2;
            float pTile, pFrostBlur;   // tuile de l'atlas (−1 : aucune), flou du frost déjà dans la tuile
            int pCount;
            vec2 pV0, pRot, pD;
            bool pPlain;

            // Image de la fenêtre en g ; nulle hors de l'iris (+ flou maximal) ; cœur d'un faisceau ouvert
            // (ni gobo, ni couteau, ni demi-couleur) : résultat exact sans calcul
            vec3 gateAt(Gate G, vec2 g, float blur) {
                float r2 = dot(g, g);
                if (r2 >= pOutR2) return vec3(0.0);
                if (pPlain) {
                    // Faisceau ouvert (ni gobo, ni couteau, ni demi-couleur) : iris au bord flou, formule exacte
                    if (r2 < pPlainR2) return G.T0.rgb * (1.0 - 0.2 * r2);
                    float e = 0.012 + blur, ir = min(G.T2.y, 1.0);
                    return G.T0.rgb * ((1.0 - smoothstep(ir - e, ir + e, sqrt(r2))) * (1.0 - 0.2 * min(r2, 1.0)));
                }
                if (pTile >= 0.0) {
                    // Image précalculée (atlas) : flou de mise au point en plus du frost → niveau de mipmap
                    vec2 uv = g * (0.5 / ${GATE_ATLAS_R.toFixed(2)}) + 0.5;
                    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
                    vec2 cell = vec2(mod(pTile, ${GATE_ATLAS_SIDE.toFixed(1)}), floor(pTile / ${GATE_ATLAS_SIDE.toFixed(1)}));
                    float texelG = ${(2 * GATE_ATLAS_R / GATE_ATLAS_TILE).toFixed(6)};
                    float lod = clamp(log2(max(1.0, (blur - pFrostBlur) / texelG)), 0.0, 3.0);
                    return textureLod(uGateAtlas, (cell + uv) / ${GATE_ATLAS_SIDE.toFixed(1)}, lod).rgb;
                }
                return gateImage(G, g, blur);
            }

            // Somme des images de toutes les facettes ; g0 = coordonnées dans le faisceau central,
            // k = s / z (décalage des facettes : nul à la lentille, entier au loin)
#ifndef PRISM
            vec3 prismImage(Gate G, vec2 g0, float k, float blur) {
                return gateAt(G, g0, blur);
            }
#else
            vec3 prismImage(Gate G, vec2 g0, float k, float blur) {
                vec3 c = vec3(0.0);
                if (pMainW > 0.0) c = gateAt(G, g0, blur) * pMainW;
                vec2 v = pV0;
                for (int i = 0; i < 8; i++) {
                    if (i >= pCount) break;
                    c += gateAt(G, g0 - v * k, blur) * pFacetW;
                    v = vec2(pRot.x * v.x - pRot.y * v.y, pRot.y * v.x + pRot.x * v.y) + pD;
                }
                return c;
            }
#endif

#ifdef BAR_MODE
            // ── Barre LED : toutes les LED en un seul volume ──
            // Réglages de la barre (lus une fois par pixel)
            int bFirst, bCount, bSplitI;
            float bPitch, bHalfX, bLedR, bTanM, bThL, bThR, bConeK, bSplit;
            bool bSplitU;
            vec3 bColB;

            // Éclairement de toutes les LED au point (x, y) du plan à la distance s des lentilles
            // (x le long de la barre, y en hauteur) : seules les LED dont le cône contient le point sont lues
            vec3 barLight(float s, float x, float y, float blur) {
                float rM = bLedR + s * bTanM;
                if (s < 0.0 || abs(y) > rM) return vec3(0.0);
                float fx = x + bHalfX;
                int lo = max(0, int(ceil((fx - rM) / bPitch)));
                int hi = min(bCount - 1, int(floor((fx + rM) / bPitch)));
                float edge = 0.012 + blur;
                vec3 c = vec3(0.0);
                for (int k = 0; k < 32; k++) {
                    int i = lo + k;
                    if (i > hi) break;
                    float th = i < bSplitI ? bThL : bThR;
                    float zA = s + bLedR / (th * bConeK);
                    vec2 g = vec2(fx - float(i) * bPitch, y) / (zA * th);
                    float r2 = dot(g, g);
                    if (r2 >= (1.0 + edge) * (1.0 + edge)) continue;
                    vec4 A = spotParam(bFirst + i, 0);
                    float m = (1.0 - smoothstep(1.0 - edge, 1.0 + edge, sqrt(r2))) * (1.0 - 0.2 * min(r2, 1.0));
                    vec3 col = A.rgb;
                    if (bSplit < 1.9) col = mix(A.rgb, bColB, smoothstep(bSplit - edge, bSplit + edge, bSplitU ? -g.y : g.x));
                    c += col * (m * A.w / (PI * th * th * zA * zA));
                }
                return c;
            }

            // a + b·t ≤ c : resserre l'intervalle [tin, tout] du rayon
            void clipLin(float a, float b, float c, inout float tin, inout float tout) {
                if (abs(b) < 1e-8) { if (a > c) tout = -1e9; return; }
                float t = (c - a) / b;
                if (b > 0.0) tout = min(tout, t); else tin = max(tin, t);
            }

            vec3 barBeam(vec3 ro, vec3 rd, float tScene, vec3 sceneP, vec3 nrm, int row, vec3 C, vec3 W, vec3 R, vec3 U, float L) {
                vec4 T0 = spotParam(row, 0);
                vec4 T1 = spotParam(row, 1);
                vec4 T2 = spotParam(row, 2);
                vec4 T4 = spotParam(row, 4);
                vec4 T7 = spotParam(row, 7);
                vec4 T8 = spotParam(row, 8);
                vec4 T9 = spotParam(row, 9);
                vec4 T10 = spotParam(row, 10);
                vec4 T11 = spotParam(row, 11);
                bFirst = int(T10.x + 0.5);
                bCount = int(T10.y + 0.5);
                bPitch = T10.z;
                bSplitU = T10.w > 0.5;
                bHalfX = 0.5 * float(bCount - 1) * bPitch;
                bLedR = T4.w;
                bTanM = T7.z;
                bThL = T9.x; bThR = T9.y; bSplitI = int(T9.z + 0.5); bConeK = T9.w;
                bColB = T1.rgb; bSplit = T1.w;
                float s0 = T11.z;
                bool hasOcc = T8.x >= 0.0;

                // ── Intersection rayon ↔ tronc de pyramide : s0 ≤ s ≤ L, |x| ≤ X0 + s·tan, |y| ≤ rayon LED + s·tan ──
                vec3 q = ro - C;
                float qs = dot(q, W), qx = dot(q, R), qy = dot(q, U);
                float ds = dot(rd, W), dx = dot(rd, R), dy = dot(rd, U);
                float X0 = bHalfX + bLedR;
                float tin = -1e9, tout = 1e9;
                clipLin(-qs, -ds, -s0, tin, tout);
                clipLin(qs, ds, L, tin, tout);
                clipLin(qx - bTanM * qs, dx - bTanM * ds, X0, tin, tout);
                clipLin(-qx - bTanM * qs, -dx - bTanM * ds, X0, tin, tout);
                clipLin(qy - bTanM * qs, dy - bTanM * ds, bLedR, tin, tout);
                clipLin(-qy - bTanM * qs, -dy - bTanM * ds, bLedR, tin, tout);
                tin = max(tin, uNear);
                bool hitSurface = tScene < tout && tScene > tin;
                tout = min(tout, tScene);
                if (tout <= tin) discard;

                float frostBlur = T2.z * 0.42;
                float logFocus = log(T2.w);
                float fadeStart = L * 0.7;
                float fluxK = T0.w;

                // Échantillons : répartis selon l'éclairement quand le rayon remonte la barre (comme les lyres)
                float zOff = bLedR / bTanM;
                float span = tout - tin;
                float zIn = max(qs + ds * tin + zOff, 1e-3);
                float zOut = max(qs + ds * tout + zOff, 1e-3);
                bool imp = abs(ds) > 0.05 && max(zIn, zOut) > 1.3 * min(zIn, zOut);
                float nS = clamp(ceil(span * 2.0), 5.0, imp ? 8.0 : 14.0);
                float dt = span / nS;
                float invIn = 1.0 / zIn;
                float invOut = 1.0 / zOut;
                float impW = abs(invIn - invOut) / (abs(ds) * nS);
                float jit = ign(gl_FragCoord.xy);
                float cs = qs + zOff;

                vec3 sum = vec3(0.0);
                for (int i = 0; i < 14; i++) {
                    if (float(i) >= nS) break;
                    float t, w;
                    if (imp) {
                        float z = 1.0 / mix(invIn, invOut, (float(i) + jit) / nS);
                        t = (z - cs) / ds;
                        w = impW * z * z;
                    } else {
                        t = tin + (float(i) + jit) * dt;
                        w = dt;
                    }
                    vec3 P = ro + rd * t;
                    vec3 lp = P - C;
                    float sp = dot(lp, W);
                    float blur = frostBlur + min(0.14, abs(log(sp + 0.5) - logFocus) * 0.035);
                    vec3 E = barLight(sp, dot(lp, R), dot(lp, U), blur);
                    if (E.r + E.g + E.b < 1e-6) continue;
                    if (hasOcc) {
                        // Ombre : départ tiré le long de la barre (pénombre douce)
                        vec3 a = C + R * (bHalfX * (2.0 * fract(jit * 7.13 + float(i) * 0.618) - 1.0));
                        vec3 sd = P - a;
                        if (segBlocked(a, sd, 1.0 - 0.03 / max(length(sd), 0.05), T8)) continue;
                    }
                    float fade = 1.0 - smoothstep(fadeStart, L, sp);
                    float cosT = dot(lp + W * zOff, -rd) / max(1e-4, length(lp + W * zOff));
                    sum += E * (fluxK * fade * hazeFromNoise(hazeNoise(P, t > 25.0)) * phase(cosT) * w);
                    if (all(greaterThanEqual(sum, vec3(64.0 / 0.035)))) break;
                }
                vec3 col = sum * 0.035;

                // ── Tache de lumière sur les surfaces ──
                float splashW = T4.z;
                if (hitSurface && splashW > 0.001) {
                    bool blocked = false;
                    if (hasOcc) {
                        vec3 sd = sceneP - C;
                        blocked = segBlocked(C, sd, 1.0 - 0.06 / max(length(sd), 0.1), T8);
                    }
                    if (!blocked) {
                        vec3 lp = sceneP - C;
                        float sp = dot(lp, W);
                        float blur = frostBlur + min(0.14, abs(log(sp + 0.5) - logFocus) * 0.035);
                        vec3 n = normalize(nrm);
                        if (dot(n, rd) > 0.0) n = -n;
                        float ndl = max(0.0, dot(n, -normalize(lp + W * zOff)));
                        col += barLight(sp, dot(lp, R), dot(lp, U), blur) * (fluxK * ndl * splashW * 0.06 * (1.0 - smoothstep(fadeStart, L, sp)));
                    }
                }
                return col;
            }
#endif

            void main() {
                vec3 ro = cameraPosition;
                vec3 rd = normalize(vWorld - ro);

                // Point de la scène derrière ce pixel (profondeur) — calculé AVANT tout discard
                float d = texture(uDepth, gl_FragCoord.xy * uInvRes).r;
                float viewZ = perspectiveDepthToViewZ(d, uNear, uFar);
                float tScene = -viewZ / max(1e-4, dot(rd, uCamFwd));
                vec3 sceneP = ro + rd * tScene;
                vec3 nrm = cross(dFdx(sceneP), dFdy(sceneP));

                int row = int(vLens.w + 0.5);
                vec3 W = vAxis.xyz;
                float L = vAxis.w;
                vec3 R = vRight.xyz;
                vec3 U = cross(R, W);
                float weight = vRight.w;
#ifdef BAR_MODE
                gl_FragColor = vec4(barBeam(ro, rd, tScene, sceneP, nrm, row, vLens.xyz, W, R, U, L), 1.0);
                return;
#endif

                vec4 T0 = spotParam(row, 0);
                vec4 T2 = spotParam(row, 2);
                vec4 T4 = spotParam(row, 4);
                vec4 T7 = spotParam(row, 7);
                vec4 T8 = spotParam(row, 8);
                vec4 T9 = spotParam(row, 9);
                bool hasOcc = T8.x >= 0.0;
                float flux = T0.w * weight;
                if (flux <= 0.0) discard;
                float tanHalf = T2.x;
                // Cône d'une facette (image de la fenêtre) : apex à apexDist derrière la lentille
                float apexDist = T7.w;
                vec3 apex = vLens.xyz - W * apexDist;
                // Cône enveloppe (toutes les facettes) : c'est lui qu'on intersecte
                float tanEnv = T9.y;
                float envDist = T4.w / tanEnv;
                vec3 envApex = vLens.xyz - W * envDist;

                // ── Intersection analytique rayon ↔ cône ──
                float c2 = 1.0 / (1.0 + tanEnv * tanEnv);
                vec3 co = ro - envApex;
                float dv = dot(rd, W);
                float cv = dot(co, W);
                float qa = dv * dv - c2;
                float qb = dv * cv - dot(rd, co) * c2;
                float qc = cv * cv - dot(co, co) * c2;
                float disc = qb * qb - qa * qc;
                if (disc < 0.0) discard;
                float sq = sqrt(disc);
                float tin, tout;
                if (abs(qa) < 1e-7) {
                    float t = -qc / (2.0 * qb);
                    if (dv > 0.0) { tin = t; tout = 1e9; } else { tin = -1e9; tout = t; }
                } else {
                    float r0 = (-qb - sq) / qa;
                    float r1 = (-qb + sq) / qa;
                    float tA = min(r0, r1), tB = max(r0, r1);
                    if (qa < 0.0) {
                        tin = tA; tout = tB;
                        if (cv + dv * 0.5 * (tA + tB) < 0.0) discard;
                    } else if (dv > 0.0) {
                        tin = tB; tout = 1e9;
                    } else {
                        tin = -1e9; tout = tA;
                    }
                }
                // Plans de la lentille et de fin de portée
                // Plans de début et de fin du rendu (lentille et fin de portée, sauf faisceau raccourci)
                vec4 T11 = spotParam(row, 11);
                float sStart = T11.z;
                float sEnd = T11.w > 0.0 ? min(T11.w, L) : L;
                if (abs(dv) > 1e-6) {
                    float ta = (envDist + sStart - cv) / dv;
                    float tb = (envDist + sEnd - cv) / dv;
                    tin = max(tin, min(ta, tb));
                    tout = min(tout, max(ta, tb));
                } else if (cv < envDist + sStart || cv > envDist + sEnd) {
                    discard;
                }
                tin = max(tin, uNear);
                bool hitSurface = tScene < tout && tScene > tin;
                tout = min(tout, tScene);
                if (tout <= tin) discard;

                float focusDist = T2.w;
                float frostBlur = T2.z * 0.42;
                pFrostBlur = frostBlur;
                pTile = spotParam(row, 12).x - 1.0;
                float logFocus = log(focusDist);
                float irr0 = flux / (PI * tanHalf * tanHalf);
                float invTanHalf = 1.0 / tanHalf;
                float fadeStart = L * 0.7;

                // Réglages optiques lus une seule fois pour tout le rayon
                Gate G = makeGate(T0, spotParam(row, 1), T2, spotParam(row, 3), T4, spotParam(row, 5), spotParam(row, 6), T7);

                // Faisceau ouvert (ni gobo, ni couteau, ni roue d'animation, ni demi-couleur) : à l'intérieur de
                // l'iris moins sa marge de flou maximale, l'image de la fenêtre vaut exactement couleur × (1 − 0,2 r²)
                pPlain = !G.hasFixed && !G.hasRot && !G.hasAnim && !G.anyBlade && !G.halfCol;
                // Frost fort (≥ 70 %) : le motif des gobos est entièrement flouté dans le faisceau → transmission
                // moyenne de chaque gobo (dernier niveau de mipmap), lue une fois ; la fenêtre redevient un disque
                // flou (calcul exact rapide) au lieu de 3 roues × facettes × pas
                if (!pPlain && G.T2.z >= 0.7 && !G.anyBlade && !G.halfCol) {
                    float avg = 1.0;
                    if (G.hasFixed) { float sl = mod(floor(G.T3.x + 0.5), 9.0); if (sl > 0.5) avg *= textureLod(uGobos, vec3(0.5, 0.5, sl), 10.0).r; }
                    if (G.hasRot) { float sl = mod(floor(G.T3.y + 0.5), 8.0); if (sl > 0.5) avg *= textureLod(uGobos, vec3(0.5, 0.5, 8.0 + sl), 10.0).r; }
                    if (G.hasAnim) avg *= mix(1.0, clamp(textureLod(uGobos, vec3(0.5, 0.5, 15.0 + G.T3.w), 10.0).r * 1.25, 0.0, 1.0), clamp(G.T4.x, 0.0, 1.0));
                    G.T0.rgb *= avg;
                    pPlain = true;
                }
                float plainR = min(G.T2.y, 1.0) - (0.012 + frostBlur + 0.14);
                pPlainR2 = plainR > 0.0 ? plainR * plainR : -1.0;
                float outR = min(G.T2.y, 1.0) + 0.012 + frostBlur + 0.14;
                pOutR2 = outR * outR;
                pCount = int(T9.x + 0.5);
                pMainW = T9.z;
                pFacetW = T9.w;
                vec4 T10 = spotParam(row, 10);
                pV0 = T10.xy;
                pRot = T10.zw;
                pD = T11.xy;

                // Caméra DANS le faisceau (on est visé) : cas le plus coûteux (faisceau plein écran)
                bool inside = cv > envDist + sStart && cv < envDist + sEnd && cv * cv >= dot(co, co) * c2;
                // Distances le long de l'axe désormais comptées depuis l'apex des facettes (éclairement en 1/z²)
                cv += apexDist - envDist;

                // ── Intégration de la diffusion le long du rayon ──
                // Distance le long de l'axe aux deux bouts du trajet dans le faisceau
                float span = tout - tin;
                float zIn = max(cv + dv * tin, 1e-3);
                float zOut = max(cv + dv * tout, 1e-3);
                // Rayon qui remonte ou descend le faisceau : l'éclairement (1/z²) varie beaucoup → échantillons
                // répartis selon la lumière (serrés près de la lyre), moins nombreux pour une qualité équivalente.
                // Faisceau vu de côté : répartition régulière, inchangée.
                bool imp = abs(dv) > 0.05 && max(zIn, zOut) > 1.3 * min(zIn, zOut);
                // Faisceau ouvert : rien à montrer le long du rayon à part la fumée → moins de pas
                float nS = pPlain ? clamp(ceil(span * 1.6), 4.0, imp ? 6.0 : 8.0)
                         : (weight < 0.99 || pCount > 0) ? clamp(ceil(span * 1.6), 4.0, imp ? 6.0 : 11.0)
                                                         : clamp(ceil(span * 2.6), 6.0, imp ? 8.0 : 18.0);
                float dt = span / nS;
                float invIn = 1.0 / zIn;
                float invOut = 1.0 / zOut;
                float impW = abs(invIn - invOut) / (abs(dv) * nS);
                float jit = ign(gl_FragCoord.xy);

                // Pixel déjà blanc (saturé) : inutile de continuer à accumuler (sans effet visible).
                // Seuil large (×64) : reste saturé même derrière le brouillard de salle.
                // Canaux absents des couleurs de la lyre : seuil nul (déjà « pleins »).
                vec3 colMask = step(vec3(1e-4), T0.rgb + (G.halfCol ? G.T1.rgb : vec3(0.0)));
                vec3 satThr = colMask * (64.0 / 0.035);

                vec3 sum = vec3(0.0);
                // ── Caméra DANS le faisceau (on est visé) : faisceau plein écran, le cas qui faisait ramer ──
                // Intégrale ANALYTIQUE de l'éclairement le long du rayon (∫ dt / z² exacte) ; fumée, phase,
                // image de la fenêtre et ombre lues une seule fois au point pondéré par l'éclairement.
                // 1 échantillon au lieu de 6 à 18 : le détail fin ne se voit pas dans un faisceau qui éblouit.
                if (inside) {
                    nS = 0.0; // saute la boucle d'intégration
                    float zs = 2.0 / (invIn + invOut);
                    bool axial = abs(dv) > 1e-4;
                    float ts = axial ? clamp((zs - cv) / dv, tin, tout) : 0.5 * (tin + tout);
                    float I = axial ? (invIn - invOut) / dv : span * invIn * invIn;
                    vec3 P = ro + rd * ts;
                    vec3 lp = P - apex;
                    float zA = max(dot(lp, W), 1e-3);
                    vec3 rad = lp - W * zA;
                    vec2 g = vec2(dot(rad, R), dot(rad, U)) * (invTanHalf / zA);
                    float zl = max(zA - apexDist, 0.0);
                    float r2 = dot(g, g);
                    vec3 gate;
                    if (pPlain && pCount == 0 && r2 < pPlainR2) {
                        gate = G.T0.rgb * (1.0 - 0.2 * r2);
                    } else {
                        float blur = frostBlur + min(0.14, abs(log(zl + 0.5) - logFocus) * 0.035);
                        gate = prismImage(G, g, zl / zA, blur);
                        // Rayon qui traverse le faisceau de biais : 2e lecture au milieu du trajet (demi-couleurs, gobos, prisme)
                        vec3 P2 = ro + rd * (0.5 * (tin + tout));
                        vec3 lp2 = P2 - apex;
                        float zA2 = max(dot(lp2, W), 1e-3);
                        vec3 rad2 = lp2 - W * zA2;
                        vec2 g2 = vec2(dot(rad2, R), dot(rad2, U)) * (invTanHalf / zA2);
                        gate = mix(gate, prismImage(G, g2, max(zA2 - apexDist, 0.0) / zA2, blur), 0.35);
                    }
                    bool blocked = false;
                    if (hasOcc) {
                        vec3 sd = P - vLens.xyz;
                        blocked = segBlocked(vLens.xyz, sd, 1.0 - 0.03 / max(length(sd), 0.05), T8);
                    }
                    if (!blocked) {
                        float fade = 1.0 - smoothstep(fadeStart, L, zl);
                        float cosT = dot(lp, -rd) / max(1e-4, length(lp));
                        sum = gate * (irr0 * I * fade * hazeFromNoise(hazeNoise(P, true)) * phase(cosT));
                    }
                }
                bool lastBlocked = false;
                float lastNoise = 0.0;
                bool haveNoise = false;
                for (int i = 0; i < 18; i++) {
                    if (float(i) >= nS) break;
                    float t, w;
                    if (imp) {
                        // Tirage uniforme en 1/z : densité d'échantillons ∝ 1/z² (∝ éclairement)
                        float z = 1.0 / mix(invIn, invOut, (float(i) + jit) / nS);
                        t = (z - cv) / dv;
                        w = impW * z * z;
                    } else {
                        t = tin + (float(i) + jit) * dt;
                        w = dt;
                    }
                    vec3 P = ro + rd * t;
                    vec3 lp = P - apex;
                    float zA = dot(lp, W);
                    vec3 rad = lp - W * zA;
                    vec2 g = vec2(dot(rad, R), dot(rad, U)) * (invTanHalf / zA);
                    float zl = max(zA - apexDist, 0.0);
                    vec3 gate;
                    float r2 = dot(g, g);
                    if (pPlain && pCount == 0 && r2 < pPlainR2) {
                        // Cœur d'un faisceau ouvert sans prisme : résultat exact sans calcul
                        gate = G.T0.rgb * (1.0 - 0.2 * r2);
                    } else {
                        float blur = frostBlur + min(0.14, abs(log(zl + 0.5) - logFocus) * 0.035);
                        gate = prismImage(G, g, zl / zA, blur);
                        // Entre les facettes (ou hors de l'iris) : ni fumée ni ombre à calculer
                        if (gate.r + gate.g + gate.b < 1e-4) continue;
                    }
                    // Ombre de la structure de la scène : départ tiré sur la surface de la lentille (pénombre douce).
                    // Dans le faisceau : testée un échantillon sur deux (le résultat précédent est réutilisé).
                    if (hasOcc) {
                        if (!inside || (i & 1) == 0) {
                            float ang = 6.2831853 * fract(jit * 7.13 + float(i) * 0.618);
                            float rr = T4.w * sqrt(fract(jit * 3.71 + float(i) * 0.382));
                            vec3 a = vLens.xyz + (R * cos(ang) + U * sin(ang)) * rr;
                            vec3 sd = P - a;
                            lastBlocked = segBlocked(a, sd, 1.0 - 0.03 / max(length(sd), 0.05), T8);
                        }
                        if (lastBlocked) continue;
                    }
                    float E = irr0 / (zA * zA);
                    float fade = 1.0 - smoothstep(fadeStart, L, zl);
                    float cosT = dot(lp, -rd) / max(1e-4, length(lp));
                    // Dans le faisceau : bruit relu un échantillon sur deux (volutes de ~13 m : même valeur)
                    // Loin de la caméra (> 25 m) : une seule échelle de fumée (le détail fin ne se voit plus)
                    if (!inside || !haveNoise || (i & 1) == 0) { lastNoise = hazeNoise(P, inside || t > 25.0); haveNoise = true; }
                    sum += gate * (E * fade * hazeFromNoise(lastNoise) * phase(cosT) * w);
                    if (all(greaterThanEqual(sum, satThr))) break;
                }
                vec3 col = sum * 0.035;

                // ── Tache de lumière sur les surfaces (lyres sans lumière réelle) ──
                float splashW = T4.z;
                bool splashBlocked = false;
                if (hitSurface && splashW > 0.001 && hasOcc) {
                    vec3 sd = sceneP - vLens.xyz;
                    splashBlocked = segBlocked(vLens.xyz, sd, 1.0 - 0.06 / max(length(sd), 0.1), T8);
                }
                if (hitSurface && splashW > 0.001 && !splashBlocked) {
                    vec3 lp = sceneP - apex;
                    float zA = dot(lp, W);
                    vec3 rad = lp - W * zA;
                    vec2 g = vec2(dot(rad, R), dot(rad, U)) / (zA * tanHalf);
                    float zl = max(zA - apexDist, 0.0);
                    float blur = frostBlur + min(0.14, abs(log((zl + 0.5) / focusDist)) * 0.035);
                    vec3 n = normalize(nrm);
                    if (dot(n, rd) > 0.0) n = -n;
                    float ndl = max(0.0, dot(n, -normalize(lp)));
                    float E = irr0 / (zA * zA);
                    col += prismImage(G, g, zl / max(zA, 1e-3), blur) * (E * ndl * splashW * 0.06 * (1.0 - smoothstep(fadeStart, L, zl)));
                }

                gl_FragColor = vec4(col, 1.0);
            }
        `,
        defines: bar ? { BAR_MODE: 1 } : prism ? { PRISM: 1 } : {},
        side: THREE.BackSide,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Composition : image de la scène + faisceaux (sur-échantillonnés)
// ─────────────────────────────────────────────────────────────────────────────
export function createCompositeMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            tDiffuse: { value: null },
            tVolume:  { value: null },
            tDepth:   { value: null },
            uVolRes:  { value: new THREE.Vector2(1, 1) },
            uNear:    { value: 0.1 },
            uFar:     { value: 1000 },
            uUseDepth: { value: 0 },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            #include <packing>
            uniform sampler2D tDiffuse;
            uniform sampler2D tVolume;
            uniform highp sampler2D tDepth;
            uniform vec2 uVolRes;
            uniform float uNear;
            uniform float uFar;
            uniform float uUseDepth;
            varying vec2 vUv;

            float linZ(vec2 uv) {
                return -perspectiveDepthToViewZ(texture2D(tDepth, uv).r, uNear, uFar);
            }

            void main() {
                vec4 base = texture2D(tDiffuse, vUv);
                vec3 beams;
                if (uUseDepth > 0.5) {
                    // Sur-échantillonnage sensible à la profondeur : chaque texel du volume (demi-résolution)
                    // n'est repris que s'il se trouve à la même profondeur que le pixel plein format.
                    // Évite l'escalier et le halo autour des silhouettes (personnage devant les faisceaux).
                    vec2 pos = vUv * uVolRes - 0.5;
                    vec2 base0 = floor(pos);
                    vec2 f = pos - base0;
                    float z0 = linZ(vUv);
                    vec3 acc = vec3(0.0);
                    float wSum = 0.0;
                    for (int i = 0; i < 4; i++) {
                        vec2 o = vec2(float(i & 1), float(i >> 1));
                        vec2 uv = (base0 + o + 0.5) / uVolRes;
                        float bw = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y);
                        float dz = abs(linZ(uv) - z0) / max(z0, 0.25);
                        float w = bw / (0.002 + dz);
                        acc += texture2D(tVolume, uv).rgb * w;
                        wSum += w;
                    }
                    beams = acc / max(wSum, 1e-6);
                } else {
                    beams = texture2D(tVolume, vUv).rgb;
                }
                gl_FragColor = vec4(base.rgb + beams, base.a);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Texture de projection des SpotLight réels (même image que le faisceau)
// ─────────────────────────────────────────────────────────────────────────────
export function createGateMapMaterial(paramsTexture, goboTexture) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uSpotParams: { value: paramsTexture },
            uGobos:      { value: goboTexture },
            uRow:        { value: 0 },
            uScale:      { value: 1 },      // tan(angle lumière) / tan(zoom/2)
            uBlur:       { value: 0 },
            uFacets:     { value: Array.from({ length: 9 }, () => new THREE.Vector3()) }, // centre.xy, poids (axe + 8 facettes pendant l'insertion)
            uFacetCount: { value: 1 },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            ${GATE_GLSL}
            uniform int uRow;
            uniform float uScale;
            uniform float uBlur;
            uniform vec3 uFacets[9];
            uniform int uFacetCount;
            varying vec2 vUv;
            void main() {
                vec2 g = (vUv * 2.0 - 1.0) * uScale;
                vec3 col = vec3(0.0);
                Gate G = loadGate(uRow);
                for (int i = 0; i < 9; i++) {
                    if (i >= uFacetCount) break;
                    col += gateImage(G, g - uFacets[i].xy, uBlur) * uFacets[i].z;
                }
                gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Éblouissement de lentille (billboard instancié, bloom lampes)
// ─────────────────────────────────────────────────────────────────────────────
export function createGlareMaterial(paramsTexture) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uSpotParams: { value: paramsTexture },
        },
        vertexShader: /* glsl */`
            uniform highp sampler2D uSpotParams;
            attribute vec4 iLens;   // lentille, ligne
            attribute vec4 iAxis;   // axe, poids
            varying vec2 vUv;
            flat varying vec3 vColor;
            flat varying float vAlign;
            void main() {
                int row = int(iLens.w + 0.5);
                vec4 T0 = texelFetch(uSpotParams, ivec2(0, row), 0);
                vec4 T2 = texelFetch(uSpotParams, ivec2(2, row), 0);
                vec4 T7 = texelFetch(uSpotParams, ivec2(7, row), 0);
                float tanEnv = texelFetch(uSpotParams, ivec2(9, row), 0).y; // cône enveloppe (facettes du prisme)
                vec3 toCam = cameraPosition - iLens.xyz;
                float dist = length(toCam);
                float a = dot(toCam / dist, iAxis.xyz);
                // Dans le cône : éblouissement total ; hors du cône : simple reflet de la lentille
                float cosCone = 1.0 / sqrt(1.0 + tanEnv * tanEnv);
                float inBeam = smoothstep(cosCone - 0.05, min(1.0, cosCone + 0.01), a);
                float side = smoothstep(-0.2, 0.6, a);
                vAlign = inBeam;
                // Luminance de lentille ∝ flux / surface apparente du faisceau (zoom serré = plus éblouissant)
                float lum = T0.w * iAxis.w * T7.y / (1.0 + 30.0 * T2.x);
                vColor = T0.rgb * lum * (inBeam * 0.06 + side * 0.004);
                float size = 0.45 + inBeam * (0.9 + dist * 0.035);
                // Petites sources (LED des barres) : halo proportionnel à la lentille (lyres : inchangé)
                float lensR = texelFetch(uSpotParams, ivec2(4, row), 0).w;
                if (lensR < 0.05) size *= max(0.1, lensR * 9.0);
                vec4 mv = viewMatrix * vec4(iLens.xyz + iAxis.xyz * 0.01, 1.0);
                mv.xy += (uv - 0.5) * size;
                vUv = uv;
                gl_Position = projectionMatrix * mv;
            }
        `,
        fragmentShader: /* glsl */`
            varying vec2 vUv;
            flat varying vec3 vColor;
            flat varying float vAlign;
            void main() {
                vec2 p = vUv * 2.0 - 1.0;
                float r = length(p);
                if (r > 1.0) discard;
                // Cœur et halo qui s'éteignent progressivement jusqu'au bord (pas de cercle visible sur le ciel)
                float core = exp(-r * r * 26.0);
                float edge = 1.0 - r;
                float halo = 0.35 * exp(-r * 4.5) * edge * edge;
                float k = core + halo;
                gl_FragColor = vec4(vColor * k, 1.0);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Atlas de l'image de fenêtre (une tuile par lyre, une instance par tuile, 1 draw call)
// ─────────────────────────────────────────────────────────────────────────────
export function createGateAtlasMaterial(paramsTexture, goboTexture) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uSpotParams: { value: paramsTexture },
            uGobos:      { value: goboTexture },
        },
        vertexShader: /* glsl */`
            attribute vec2 aInfo;           // tuile, ligne de paramètres
            varying vec2 vUv;
            flat varying int vRow;
            void main() {
                vUv = position.xy * 0.5 + 0.5;
                vec2 cell = vec2(mod(aInfo.x, ${GATE_ATLAS_SIDE.toFixed(1)}), floor(aInfo.x / ${GATE_ATLAS_SIDE.toFixed(1)}));
                vRow = int(aInfo.y + 0.5);
                gl_Position = vec4((cell + vUv) / ${GATE_ATLAS_SIDE.toFixed(1)} * 2.0 - 1.0, 0.0, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            ${GATE_GLSL}
            varying vec2 vUv;
            flat varying int vRow;
            void main() {
                Gate G = loadGate(vRow);
                vec2 g = (vUv * 2.0 - 1.0) * ${GATE_ATLAS_R.toFixed(2)};
                gl_FragColor = vec4(gateImage(G, g, G.T2.z * 0.42), 1.0);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}
