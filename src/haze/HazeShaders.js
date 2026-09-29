/**
 * HazeShaders.js
 * ─────────────────────────────────────────────────────────────
 * Brouillard de salle : diffusion ANALYTIQUE de la lumière dans une boîte de fumée.
 *
 * Pour chaque pixel :
 *   1. intersection exacte rayon de vue ↔ boîte, coupée par la profondeur de la scène
 *   2. le segment est découpé en quelques tranches (densité, bords doux, hauteur, variations)
 *   3. pour chaque lumière, la lumière diffusée sur une tranche est calculée par la formule
 *      EXACTE de l'intégrale d'une source ponctuelle en 1/d² le long d'une droite :
 *          ∫ dt / (h² + (t − tc)²) = [atan((t − tc)/h)] / h
 *      → aucune boucle de pas (raymarching), coût constant quelle que soit la profondeur
 *   4. diffusion multiple : même intégrale avec un « cœur » élargi (portée de diffusion) →
 *      la couleur de chaque lumière déborde et envahit la salle autour d'elle, localement
 *      (une lyre bleue à gauche et une rouge à droite teintent chacune leur côté)
 *   5. phase de Mie (Henyey-Greenstein) : plus lumineux en regardant vers la source
 *   6. atténuation (loi de Beer-Lambert) : le décor s'efface dans la fumée
 *   7. ombres de la structure de la scène (mêmes obstacles que les lasers et les lyres)
 *
 * Sortie : rgb = lumière diffusée, a = transmittance ; la composition fait scène × a + rgb.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { SMOKE_NOISE_UVW_SCALE } from '../laser/LaserSmokeNoise.js';

export const HAZE_MAX_LIGHTS = 8;
export const HAZE_MAX_OCCLUDERS = 16;

export function createHazeMaterial(noiseTexture, occMins, occMaxs) {
    const v4 = () => Array.from({ length: HAZE_MAX_LIGHTS }, () => new THREE.Vector4());
    return new THREE.ShaderMaterial({
        uniforms: {
            uDepth:        { value: null },
            uInvProj:      { value: new THREE.Matrix4() },
            uCamWorld:     { value: new THREE.Matrix4() },
            uCamFwd:       { value: new THREE.Vector3(0, 0, -1) },
            uNear:         { value: 0.1 },
            uFar:          { value: 5000 },
            uBoxMin:       { value: new THREE.Vector3() },
            uBoxMax:       { value: new THREE.Vector3() },
            uEdge:         { value: 4 },
            uDensity:      { value: 0.02 },
            uTint:         { value: new THREE.Color(1, 1, 1) },
            uIntensity:    { value: 1 },
            uMS:           { value: 0.6 },
            uMSReach:      { value: 6 },
            uG:            { value: 0.55 },
            uAmbient:      { value: new THREE.Color(0, 0, 0) },
            uSunDir:       { value: new THREE.Vector3(0, 1, 0) },
            uSunCol:       { value: new THREE.Color(0, 0, 0) },
            uHeight:       { value: 0 },
            uNoise:        { value: 0 },
            uNoiseTex:     { value: noiseTexture },
            uWind:         { value: new THREE.Vector3() },
            uSegments:     { value: 4 },
            uLCount:       { value: 0 },
            uLPos:         { value: v4() },   // xyz, portée
            uLCol:         { value: v4() },   // rgb × puissance, cos du cône intérieur (pénombre)
            uLDir:         { value: v4() },   // direction, cos du cône (< −0.5 = omnidirectionnelle)
            uOcclusion:    { value: 1 },
            uOccCount:     { value: occMins.length },
            uOccMin:       { value: occMins },
            uOccMax:       { value: occMaxs },
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
            uniform highp sampler2D uDepth;
            uniform highp sampler3D uNoiseTex;
            uniform mat4 uInvProj;
            uniform mat4 uCamWorld;
            uniform vec3 uCamFwd;
            uniform float uNear;
            uniform float uFar;
            uniform vec3 uBoxMin;
            uniform vec3 uBoxMax;
            uniform float uEdge;
            uniform float uDensity;
            uniform vec3 uTint;
            uniform float uIntensity;
            uniform float uMS;
            uniform float uMSReach;
            uniform float uG;
            uniform vec3 uAmbient;
            uniform vec3 uSunDir;
            uniform vec3 uSunCol;
            uniform float uHeight;
            uniform float uNoise;
            uniform vec3 uWind;
            uniform int uSegments;
            uniform int uLCount;
            uniform vec4 uLPos[${HAZE_MAX_LIGHTS}];
            uniform vec4 uLCol[${HAZE_MAX_LIGHTS}];
            uniform vec4 uLDir[${HAZE_MAX_LIGHTS}];
            uniform int uOcclusion;
            uniform int uOccCount;
            uniform vec3 uOccMin[${HAZE_MAX_OCCLUDERS}];
            uniform vec3 uOccMax[${HAZE_MAX_OCCLUDERS}];
            varying vec2 vUv;

            const float NOISE_UVW = ${SMOKE_NOISE_UVW_SCALE.toFixed(8)};

            // Phase de Henyey-Greenstein normalisée (isotrope = 1)
            float phaseHG(float cosT) {
                float g = uG;
                return (1.0 - g * g) / pow(max(1e-4, 1.0 + g * g - 2.0 * g * cosT), 1.5);
            }

            // Densité sans variations : bords doux (côtés + dessus) × nappe au sol
            // Dissipation sur les bords (côtés + dessus, jamais au sol) : la fumée s'effiloche.
            // Bord irrégulier (déformé par le bruit et le vent), coins arrondis (produit par axe),
            // profil de concentration en s (comme une diffusion) plutôt qu'une coupure.
            float edgeFade(vec3 p) {
                vec3 dmin = p - uBoxMin;
                vec3 dmax = uBoxMax - p;
                if (uEdge <= 0.0) return step(0.0, min(min(min(dmin.x, dmax.x), dmax.y), min(dmin.z, dmax.z)));
                float wisp = texture(uNoiseTex, (p * 0.03 + uWind * 0.2) * NOISE_UVW).r;
                float off = wisp * uEdge * 0.7; // volutes : le bord avance/recule
                float fx = smoothstep(0.0, uEdge, dmin.x + off) * smoothstep(0.0, uEdge, dmax.x + off);
                float fz = smoothstep(0.0, uEdge, dmin.z + off) * smoothstep(0.0, uEdge, dmax.z + off);
                float fy = smoothstep(0.0, uEdge, dmax.y + off);
                float f = fx * fz * fy;
                return f * f * (3.0 - 2.0 * f);
            }

            float densityShape(vec3 p) {
                vec3 dmin = p - uBoxMin;
                float d = uDensity * edgeFade(p);
                // Nappe au sol : densité maximale au sol, décroissance exponentielle avec la hauteur
                if (uHeight > 0.0) d *= exp(-max(0.0, dmin.y) / uHeight);
                return d;
            }

            // Moyenne EXACTE de la nappe exponentielle entre deux hauteurs (évite les lignes de niveau)
            float layerAverage(float ya, float yb) {
                if (uHeight <= 0.0) return 1.0;
                float a = max(0.0, ya - uBoxMin.y), b = max(0.0, yb - uBoxMin.y);
                if (abs(b - a) < 1e-3) return exp(-0.5 * (a + b) / uHeight);
                return uHeight * (exp(-a / uHeight) - exp(-b / uHeight)) / (b - a);
            }

            float noiseAt(vec3 p) {
                if (uNoise <= 0.0) return 1.0;
                float n = texture(uNoiseTex, (p * 0.05 + uWind * 0.3) * NOISE_UVW).r;
                return max(0.0, 1.0 + uNoise * 1.2 * n);
            }

            // Le segment a → b est-il bloqué par un obstacle de la scène ?
            bool blocked(vec3 a, vec3 b) {
                vec3 dir = b - a;
                vec3 dd = mix(vec3(1e-7), dir, step(1e-7, abs(dir)));
                vec3 inv = 1.0 / dd;
                for (int i = 0; i < ${HAZE_MAX_OCCLUDERS}; i++) {
                    if (i >= uOccCount) break;
                    vec3 t0 = (uOccMin[i] - a) * inv;
                    vec3 t1 = (uOccMax[i] - a) * inv;
                    vec3 tl = min(t0, t1);
                    vec3 th = max(t0, t1);
                    float tn = max(max(tl.x, tl.y), tl.z);
                    float tf = min(min(th.x, th.y), th.z);
                    if (tn <= tf && tf > 0.0 && tn < 0.985) return true;
                }
                return false;
            }

            void main() {
                // Rayon de vue reconstruit depuis la profondeur
                vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
                vec3 rd = normalize((uCamWorld * vec4(normalize(vp.xyz / vp.w), 0.0)).xyz);
                vec3 ro = uCamWorld[3].xyz; // position de la VRAIE caméra (cameraPosition = caméra ortho de la passe plein écran)
                float depth = texture(uDepth, vUv).r;
                float tScene = depth >= 1.0 ? 1e9 : -perspectiveDepthToViewZ(depth, uNear, uFar) / max(1e-4, dot(rd, uCamFwd));

                // Boîte de fumée
                vec3 rdd = mix(vec3(1e-7), rd, step(1e-7, abs(rd)));
                vec3 inv = 1.0 / rdd;
                vec3 b0 = (uBoxMin - ro) * inv;
                vec3 b1 = (uBoxMax - ro) * inv;
                vec3 bl = min(b0, b1), bh = max(b0, b1);
                float tIn = max(max(max(bl.x, bl.y), bl.z), 0.0);
                float tOut = min(min(min(bh.x, bh.y), bh.z), tScene);
                if (tOut <= tIn) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

                // Tranches : densité moyenne exacte (nappe) × bords × variations, transmittance vers la caméra
                const int MAXS = 8;
                int N = uSegments;
                float segLen = (tOut - tIn) / float(N);
                float dens[MAXS];
                float nmul[MAXS];
                float tcam[MAXS];
                float od = 0.0;
                for (int s = 0; s < MAXS; s++) {
                    if (s >= N) break;
                    float a = tIn + float(s) * segLen;
                    float tm = a + 0.5 * segLen;
                    vec3 pm = ro + rd * tm;
                    // Dissipation des bords moyennée sur la tranche (début, milieu, fin) : fondu progressif même avec peu de tranches
                    float shapeNoLayer = uDensity * (edgeFade(ro + rd * a) + 2.0 * edgeFade(pm) + edgeFade(ro + rd * (a + segLen))) * 0.25;
                    float nm = noiseAt(pm);
                    float d = shapeNoLayer * layerAverage(ro.y + rd.y * a, ro.y + rd.y * (a + segLen)) * nm;
                    dens[s] = d;
                    nmul[s] = nm;
                    tcam[s] = exp(-(od + d * segLen * 0.5));
                    od += d * segLen;
                }
                float transmittance = exp(-od);

                vec3 L = vec3(0.0);

                // Soleil / lune (directionnel) + lumière ambiante : proportionnels à la longueur traversée
                float sunPhase = phaseHG(dot(uSunDir, rd));
                vec3 dirTerm = uSunCol * sunPhase + uAmbient;
                for (int s = 0; s < MAXS; s++) {
                    if (s >= N) break;
                    L += dirTerm * dens[s] * tcam[s] * segLen;
                }

                // Lumières ponctuelles / projecteurs
                for (int i = 0; i < ${HAZE_MAX_LIGHTS}; i++) {
                    if (i >= uLCount) break;
                    vec3 Lp = uLPos[i].xyz;
                    float range = uLPos[i].w;
                    vec3 v = Lp - ro;
                    float tc = dot(v, rd);
                    // Sources omni : uLCol.w = rayon d'étalement (pas de point lumineux net dans la fumée)
                    float blur = uLDir[i].w > -0.5 ? 0.0 : uLCol[i].w;
                    float h2 = max(dot(v, v) - tc * tc, 0.09) + blur * blur;
                    float h = sqrt(h2);
                    float hs = sqrt(h2 + uMSReach * uMSReach);
                    vec3 col = uLCol[i].rgb;

                    // Ombre de la structure : projecteurs directionnels (strobes) seulement, testée tranche par tranche
                    // (lumière directe seulement : la lumière diffusée contourne les obstacles)
                    bool occl = uOcclusion == 1 && uLDir[i].w > -0.5;

                    for (int s = 0; s < MAXS; s++) {
                        if (s >= N) break;
                        float a = tIn + float(s) * segLen;
                        float b = a + segLen;
                        // Point de la tranche le plus proche de la lumière : là où se concentre sa contribution
                        vec3 Ps = ro + rd * clamp(tc, a, b);
                        vec3 toP = Ps - Lp;
                        float dl = max(length(toP), 1e-3);
                        vec3 ldir = toP / dl;
                        float ph = phaseHG(dot(ldir, -rd));
                        float cone = 1.0;
                        if (uLDir[i].w > -0.5) cone = smoothstep(uLDir[i].w, max(uLCol[i].w, uLDir[i].w + 0.01), dot(ldir, uLDir[i].xyz)); // pénombre du projecteur (comme three.js)
                        float coneSoft = mix(0.3, 1.0, cone);
                        // Portée : fondu très progressif (jamais de bord net visible dans la fumée)
                        float win = range > 0.0 ? 1.0 - smoothstep(range * 0.6, range * 1.6, dl) : 1.0;
                        float ds = densityShape(Ps) * nmul[s];
                        float direct = (atan((b - tc) / h) - atan((a - tc) / h)) / h;
                        float soft = (atan((b - tc) / hs) - atan((a - tc) / hs)) / hs;
                        float ext = exp(-ds * dl);
                        float vis = (occl && cone > 0.0 && blocked(Lp, Ps)) ? 0.0 : 1.0;
                        L += col * win * (direct * ph * cone * vis + uMS * soft * coneSoft) * ds * tcam[s] * ext;
                    }
                }

                gl_FragColor = vec4(L * uTint * uIntensity, transmittance);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}

/**
 * Composition : scène × transmittance + lumière diffusée.
 * Sur-échantillonnage BILATÉRAL : parmi les 4 texels basse résolution voisins, seuls ceux à la même
 * profondeur que le pixel comptent → pas de halo/escalier du brouillard sur les bords des objets.
 */
export function createHazeCompositeMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            tDiffuse: { value: null },
            tHaze:    { value: null },
            uDepth:   { value: null },
            uNear:    { value: 0.1 },
            uFar:     { value: 1000 },
            uHazeSize: { value: new THREE.Vector2(1, 1) },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            uniform sampler2D tDiffuse;
            #include <packing>
            uniform sampler2D tHaze;
            uniform highp sampler2D uDepth;
            uniform float uNear, uFar;
            uniform vec2 uHazeSize;
            varying vec2 vUv;
            float linDepth(vec2 uv) {
                float d = texture2D(uDepth, uv).r;
                return d >= 1.0 ? uFar : -perspectiveDepthToViewZ(d, uNear, uFar);
            }
            void main() {
                vec4 base = texture2D(tDiffuse, vUv);
                float dc = linDepth(vUv);
                vec2 p = vUv * uHazeSize - 0.5;
                vec2 i0 = floor(p);
                vec2 f = p - i0;
                vec4 acc = vec4(0.0);
                float wsum = 0.0;
                vec4 nearest = vec4(0.0, 0.0, 0.0, 1.0);
                float bestDiff = 1e20;
                for (int j = 0; j < 2; j++) {
                    for (int i = 0; i < 2; i++) {
                        vec2 uv = (i0 + vec2(float(i), float(j)) + 0.5) / uHazeSize;
                        vec4 h = texture2D(tHaze, uv);
                        float diff = abs(linDepth(uv) - dc) / max(dc, 0.1);
                        float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
                        float w = wb * exp(-diff * 30.0) + 1e-5 * wb;
                        acc += h * w;
                        wsum += w;
                        if (diff < bestDiff) { bestDiff = diff; nearest = h; }
                    }
                }
                vec4 hz = bestDiff > 0.1 && wsum < 0.05 ? nearest : acc / max(wsum, 1e-6);
                gl_FragColor = vec4(base.rgb * hz.a + hz.rgb, base.a);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}
