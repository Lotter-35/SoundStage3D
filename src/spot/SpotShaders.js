/**
 * SpotShaders.js
 * ─────────────────────────────────────────────────────────────
 * Shaders des lyres Spot :
 *
 * 1. FAISCEAU VOLUMÉTRIQUE (createVolumeMaterial)
 *    Cône instancié (1 instance par facette de prisme, 1 draw call pour toutes les
 *    lyres) rendu en faces arrière. Pour chaque pixel :
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
export const SPOT_TEXELS = 9;
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
export function createVolumeMaterial(paramsTexture, goboTexture, noiseTexture) {
    const occ = occluderUniforms();
    return new THREE.ShaderMaterial({
        uniforms: {
            uBoxMin:     { value: occ.mins },
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
                vec4 T7 = texelFetch(uSpotParams, ivec2(7, row), 0);
                vec3 W = iAxis.xyz;
                vec3 R = iRight.xyz;
                // Repère DIRECT (R, W×R, W) : conserve le sens des triangles (faces arrière = intérieur du cône)
                vec3 U = cross(W, R);
                float L = iAxis.w;
                float z = position.z;              // 0 = lentille, 1 = fin de portée
                // rayon réel du cône à cette distance (+3 % : le polygone contient le cercle)
                float rad = (T4.w + z * L * T7.z) * 1.035;
                vec3 world = iLens.xyz + W * (z * L) + (R * position.x + U * position.y) * rad;
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

                vec4 T0 = spotParam(row, 0);
                vec4 T2 = spotParam(row, 2);
                vec4 T4 = spotParam(row, 4);
                vec4 T7 = spotParam(row, 7);
                vec4 T8 = spotParam(row, 8);
                bool hasOcc = T8.x >= 0.0;
                float flux = T0.w * weight;
                if (flux <= 0.0) discard;
                float tanHalf = T2.x;
                float tanCone = T7.z;
                float apexDist = T7.w;
                vec3 apex = vLens.xyz - W * apexDist;

                // ── Intersection analytique rayon ↔ cône ──
                float c2 = 1.0 / (1.0 + tanCone * tanCone);
                vec3 co = ro - apex;
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
                if (abs(dv) > 1e-6) {
                    float ta = (apexDist - cv) / dv;
                    float tb = (apexDist + L - cv) / dv;
                    tin = max(tin, min(ta, tb));
                    tout = min(tout, max(ta, tb));
                } else if (cv < apexDist || cv > apexDist + L) {
                    discard;
                }
                tin = max(tin, uNear);
                bool hitSurface = tScene < tout && tScene > tin;
                tout = min(tout, tScene);
                if (tout <= tin) discard;

                float focusDist = T2.w;
                float frostBlur = T2.z * 0.42;
                float logFocus = log(focusDist);
                float irr0 = flux / (PI * tanHalf * tanHalf);
                float invTanHalf = 1.0 / tanHalf;
                float fadeStart = L * 0.7;

                // Réglages optiques lus une seule fois pour tout le rayon
                Gate G = makeGate(T0, spotParam(row, 1), T2, spotParam(row, 3), T4, spotParam(row, 5), spotParam(row, 6), T7);

                // Faisceau ouvert (ni gobo, ni couteau, ni roue d'animation, ni demi-couleur) : à l'intérieur de
                // l'iris moins sa marge de flou maximale, l'image de la fenêtre vaut exactement couleur × (1 − 0,2 r²)
                bool plainGate = !G.hasFixed && !G.hasRot && !G.hasAnim && !G.anyBlade && !G.halfCol;
                float plainR = min(G.T2.y, 1.0) - (0.012 + frostBlur + 0.14);
                float plainR2 = plainR > 0.0 ? plainR * plainR : -1.0;

                // Caméra DANS le faisceau (on est visé) : cas le plus coûteux (faisceau plein écran)
                bool inside = cv > apexDist && cv < apexDist + L && cv * cv >= dot(co, co) * c2;

                // ── Intégration de la diffusion le long du rayon ──
                // Distance le long de l'axe aux deux bouts du trajet dans le faisceau
                float span = tout - tin;
                float zIn = max(cv + dv * tin, 1e-3);
                float zOut = max(cv + dv * tout, 1e-3);
                // Rayon qui remonte ou descend le faisceau : l'éclairement (1/z²) varie beaucoup → échantillons
                // répartis selon la lumière (serrés près de la lyre), moins nombreux pour une qualité équivalente.
                // Faisceau vu de côté : répartition régulière, inchangée.
                bool imp = abs(dv) > 0.05 && max(zIn, zOut) > 1.3 * min(zIn, zOut);
                float nS = weight < 0.99 ? clamp(ceil(span * 1.6), 4.0, imp ? 6.0 : 11.0)
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
                    if (plainGate && r2 < plainR2) {
                        // Cœur d'un faisceau ouvert (ni gobo, ni couteau, ni demi-couleur) : résultat exact sans calcul
                        gate = G.T0.rgb * (1.0 - 0.2 * r2);
                    } else {
                        float blur = frostBlur + min(0.14, abs(log(zl + 0.5) - logFocus) * 0.035);
                        gate = gateImage(G, g, blur);
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
                    if (!inside || !haveNoise || (i & 1) == 0) { lastNoise = hazeNoise(P, inside); haveNoise = true; }
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
                    col += gateImage(G, g, blur) * (E * ndl * splashW * 0.06 * (1.0 - smoothstep(fadeStart, L, zl)));
                }

                gl_FragColor = vec4(col, 1.0);
            }
        `,
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
            uFacets:     { value: Array.from({ length: 8 }, () => new THREE.Vector3()) }, // centre.xy, poids
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
            uniform vec3 uFacets[8];
            uniform int uFacetCount;
            varying vec2 vUv;
            void main() {
                vec2 g = (vUv * 2.0 - 1.0) * uScale;
                vec3 col = vec3(0.0);
                for (int i = 0; i < 8; i++) {
                    if (i >= uFacetCount) break;
                    col += spotGate(uRow, g - uFacets[i].xy, uBlur) * uFacets[i].z;
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
                vec3 toCam = cameraPosition - iLens.xyz;
                float dist = length(toCam);
                float a = dot(toCam / dist, iAxis.xyz);
                // Dans le cône : éblouissement total ; hors du cône : simple reflet de la lentille
                float cosCone = 1.0 / sqrt(1.0 + T7.z * T7.z);
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
                float core = exp(-r * r * 26.0);
                float halo = exp(-r * 4.5) * 0.35;
                // Aigrettes (diffraction des lamelles de l'iris), visibles dans l'axe seulement
                float ang = atan(p.y, p.x);
                float spikes = pow(abs(cos(ang * 3.0)), 60.0) * exp(-r * 3.0) * vAlign * 0.6;
                float k = (core + halo + spikes) * (1.0 - smoothstep(0.85, 1.0, r));
                gl_FragColor = vec4(vColor * k, 1.0);
            }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
    });
}
