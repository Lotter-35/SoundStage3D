/**
 * LaserShaders.js
 * ─────────────────────────────────────────────────────────────
 * Matériaux GLSL BATCHÉS (1 draw call par type pour TOUS les lasers de la scène) :
 * 1. createBeamMaterial       — faisceaux cylindriques caméra-alignés (instanciés)
 * 2. createFanMaterial        — plan PAN volumétrique + fumée 3D (triangles instanciés)
 * 3. createPodGlowMaterial    — éclat sphérique à la source (instancié)
 * 4. createImpactMaterial     — halo circulaire au point d'impact de chaque trait (instancié)
 * 5. createPanImpactMaterial  — ligne lumineuse continue d'impact du plan (instanciée)
 *
 * Chaque instance porte l'index (ligne) de son laser : le vertex shader lit les
 * paramètres individuels du laser dans une DataTexture (uLaserParams) et les
 * transmet au fragment shader via des varyings "flat". Chaque laser reste
 * donc 100% configurable indépendamment, sans un draw call par laser.
 *
 * La saturation de couleur (constante par laser) est pré-calculée côté CPU et
 * la fumée lit une texture 3D de bruit pré-calculée (LaserSmokeNoise).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { BEAM_DIVERGENCE, BEAM_START_SCALE, BEAM_NARROW_DIST, BEAM_GROWTH, BEAM_GROWTH_MAX_DIST, LASER_MAX_RANGE, LASER_FADE_START } from './config/laserConstants.js';
import { SMOKE_NOISE_UVW_SCALE } from './LaserSmokeNoise.js';

// Intensité relative minimale de la nappe PAN au loin (atteinte vers 270 m ; de près rien ne change)
const PAN_FAR_FLOOR = 0.035;

// Fondu de fin de portée (rayons partant dans le ciel) : pas d'arrêt net
const _RANGE_FADE = `(1.0 - smoothstep(${LASER_FADE_START.toFixed(1)}, ${LASER_MAX_RANGE.toFixed(1)}, `;

// ── Disposition de la texture de paramètres (1 ligne = 1 laser, texels RGBA float) ──
// T0  : satColor(1.35).rgb, beamPower (atténuation PAN incluse)
// T1  : satColor(1.45).rgb, impactPower
// T2  : sourceGlowPower, glowIntensity, glowScattering, glowFalloff
// T3  : fogDensity, fogGlowCoupling, panPower, beamWidth
// T4  : origin.xyz, smokeEnabled
// T5  : panNormal.xyz (normalisée), smokePerpSpeed
// T6  : smokeScale, smokeContrast, smokeBrightness, smokePatchContrast
// T7  : smokePatchScale, smokePatchDensity, smokePatchSpeed, impactGlowIntensity
// T8  : impactGlowRadius, sourceEmissionPower, sourceGlowRadius, borne max de modulation fumée
// ── Couches supplémentaires (lues dans le fragment shader, uniquement si activées) ──
// T9  : turbulence     — actif, force, échelle, vitesse
// T10 : rayons radiaux — actif, intensité, nombre de stries, vitesse
// T11 : poches géantes — actif, contraste, taille, densité
// T12 : poches géantes vitesse, intensité visuelle de la fumée, -, -
export const PARAM_TEXELS = 13;

const _PARAMS_GLSL = `
uniform highp sampler2D uLaserParams;
vec4 laserParam(float row, int texel) {
    return texelFetch(uLaserParams, ivec2(texel, int(row + 0.5)), 0);
}
`;

function baseMaterialOptions() {
    return {
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
    };
}

// ── 1. Faisceaux Laser (quad instancié caméra-aligné avec divergence physique) ───
export function createBeamMaterial(paramsTexture) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uLaserParams:    { value: paramsTexture },
            uBeamDivergence: { value: BEAM_DIVERGENCE },
            uViewportH:      { value: 1080.0 }   // hauteur du rendu en pixels (mise à jour par LaserBatch)
        },
        vertexShader: `
            ${_PARAMS_GLSL}
            attribute float aSide;
            attribute vec4  aBeamA;   // origine.xyz, ligne laser
            attribute vec3  aBeamB;   // point d'impact

            uniform float uBeamDivergence;
            uniform float uViewportH;
            varying float vWiden;     // largeur affichée / largeur physique (≥ 1)
            varying float vHalfPx;    // demi-largeur affichée en pixels

            varying vec2  vUv;
            varying float vMeterDist;
            flat varying vec4 vColorPower;  // satColor.rgb, beamPower
            flat varying vec4 vGlowA;       // beamWidth, sourceGlow, glowIntensity, glowScattering
            flat varying vec4 vGlowB;       // glowFalloff, fogDensity, fogGlowCoupling, -

            void main() {
                vUv = uv;
                float row = aBeamA.w;
                vec4 t0 = laserParam(row, 0);
                vec4 t2 = laserParam(row, 2);
                vec4 t3 = laserParam(row, 3);
                float beamWidth = t3.w;
                vColorPower = t0;
                vGlowA = vec4(beamWidth, t2.x, t2.y, t2.z);
                vGlowB = vec4(t2.w, t3.x, t3.y, 0.0);

                vec4 vOrig4 = modelViewMatrix * vec4(aBeamA.xyz, 1.0);
                vec4 vHit4  = modelViewMatrix * vec4(aBeamB, 1.0);
                vec3 vOrig  = vOrig4.xyz;
                vec3 vHit   = vHit4.xyz;

                vec3 vRay = vHit - vOrig;
                float rayDist = length(vRay);
                vec3 vPos = mix(vOrig, vHit, uv.y);

                vec3 vDir = normalize(vRay);
                vec3 vCamToPos = normalize(vPos);
                vec3 vSide = cross(vDir, vCamToPos);

                if (length(vSide) < 0.001) {
                    vSide = vec3(1.0, 0.0, 0.0);
                } else {
                    vSide = normalize(vSide);
                }

                // Élargissement physique réaliste du faisceau avec la distance (divergence laser)
                float currentDist = uv.y * rayDist;
                vMeterDist = currentDist;
                float divergenceFactor = mix(${BEAM_START_SCALE.toFixed(3)}, 1.0, smoothstep(0.0, ${BEAM_NARROW_DIST.toFixed(1)}, currentDist))
                                       * (1.0 + min(currentDist, ${BEAM_GROWTH_MAX_DIST.toFixed(1)}) * ${BEAM_GROWTH.toFixed(4)} * uBeamDivergence);
                float baseWidth = (0.012 + 0.016 * beamWidth);
                float width = baseWidth * divergenceFactor;

                // Largeur minimale à l'écran : au loin le faisceau devient plus fin qu'un pixel
                // et son halo (dessiné dans la même bande) disparaissait. On garde une bande
                // d'au moins MIN_HALO_PX pixels ; le cœur reste à sa taille physique (≥ 1 px).
                float pxWorld = 2.0 * max(-vPos.z, 0.01) / (projectionMatrix[1][1] * uViewportH);
                float drawWidth = max(width, 3.0 * pxWorld);
                vWiden  = drawWidth / width;
                vHalfPx = drawWidth / pxWorld;
                vec3 finalViewPos = vPos + vSide * aSide * drawWidth;

                gl_Position = projectionMatrix * vec4(finalViewPos, 1.0);
            }
        `,
        fragmentShader: `
            varying vec2  vUv;
            varying float vMeterDist;
            flat varying vec4 vColorPower;
            flat varying vec4 vGlowA;
            flat varying vec4 vGlowB;
            varying float vWiden;
            varying float vHalfPx;

            void main() {
                float uBeamPower       = vColorPower.w;
                float uBeamWidth       = vGlowA.x;
                float uSourceGlowPower = vGlowA.y;
                float uGlowIntensity   = vGlowA.z;
                float uGlowScattering  = vGlowA.w;
                float uGlowFalloff     = vGlowB.x;
                float uFogDensity      = vGlowB.y;
                float uFogGlowCoupling = vGlowB.z;

                if (uBeamPower <= 0.001 || uBeamWidth <= 0.001) discard;

                float distFromCenter = abs(vUv.x - 0.5) * 2.0;
                // Cœur : taille physique, mais jamais sous ~1 px de demi-largeur
                float coreScale = min(vWiden, max(1.0, vHalfPx));
                float baseAlpha = clamp(1.0 - distFromCenter * coreScale, 0.0, 1.0);

                float scatter = clamp(uGlowScattering, 0.0, 3.0);

                // Halo de diffusion atmosphérique
                float fogScatter = uFogDensity * 45.0 * uFogGlowCoupling * scatter;
                float halo = pow(1.0 - distFromCenter, max(0.2, uGlowFalloff)) * (uGlowIntensity * 0.4 + fogScatter);

                // Éclat blanc puissant à l'émission (sortie du laser éclatante et diffusive)
                float sourceWhite = exp(-vMeterDist / 25.0) * clamp(uSourceGlowPower, 0.0, 1.5);

                // Atténuation physique atmosphérique le long du faisceau
                float beamDistFalloff = 1.0 / (1.0 + pow(max(0.0, vMeterDist) / 65.0, 1.35));
                // Le halo s'atténue plus lentement que le cœur : il reste visible au loin
                float haloDistFalloff = 1.0 / (1.0 + pow(max(0.0, vMeterDist) / 160.0, 1.35));

                // Cœur blanc éclatant et diffusion dans les traits de laser
                float beamCoreWhite = pow(baseAlpha, 4.0) * 0.85 * scatter;
                float haloWhite     = halo * 0.20 * scatter;

                float totalWhite = clamp(sourceWhite * baseAlpha + beamCoreWhite + haloWhite, 0.0, 1.0);

                // Couleur hyper-saturée (pré-calculée CPU) traversée par le blanc éclatant
                vec3 col = mix(vColorPower.rgb, vec3(1.0, 1.0, 1.0), totalWhite);

                // Fondu en bout de portée (rayons partant dans le ciel) : pas d'arrêt net
                float skyFade = ${_RANGE_FADE}vMeterDist));

                float alpha = clamp(baseAlpha * beamDistFalloff
                                  + halo * (0.35 + 0.50 * scatter) * haloDistFalloff
                                  + sourceWhite * 0.8 * baseAlpha * beamDistFalloff, 0.0, 1.0) * uBeamPower * skyFade;

                gl_FragColor = vec4(col, alpha);
            }
        `,
        ...baseMaterialOptions()
    });
}

// ── 2. Plan Laser PAN (nappe volumétrique + fumée 3D espace monde) ───────
export function createFanMaterial(paramsTexture, noiseTexture) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uLaserParams: { value: paramsTexture },
            uSmokeNoise:  { value: noiseTexture },
            uTime:        { value: 0.0 },
            uWind:        { value: new THREE.Vector3() }
        },
        vertexShader: `
            ${_PARAMS_GLSL}
            attribute float aCorner;  // 0 = origine, 1 = h0, 2 = h1
            attribute vec4  aTriA;    // h0.xyz, ligne laser
            attribute vec3  aTriB;    // h1

            varying float vMeterDist;
            varying vec3  vWorldPos3D;
            flat varying vec4 vColorPan;   // satColor.rgb, panPower
            flat varying vec4 vGlow;       // sourceGlow, glowIntensity, fogDensity, fogGlowCoupling
            flat varying vec4 vOriginSmk;  // origin.xyz, smokeEnabled
            flat varying vec4 vNormalPerp; // panNormal.xyz, smokePerpSpeed
            flat varying vec4 vSmoke;      // scale, contrast, brightness, patchContrast
            flat varying vec4 vPatch;      // patchScale, patchDensity, patchSpeed, ligne laser

            void main() {
                float row = aTriA.w;
                vec4 t0 = laserParam(row, 0);
                vec4 t2 = laserParam(row, 2);
                vec4 t3 = laserParam(row, 3);
                vec4 t4 = laserParam(row, 4);
                vec4 t7 = laserParam(row, 7);
                vColorPan   = vec4(t0.rgb, t3.z);
                vGlow       = vec4(t2.x, t2.y, t3.x, t3.y);
                vOriginSmk  = t4;
                vNormalPerp = laserParam(row, 5);
                vSmoke      = laserParam(row, 6);
                vPatch      = vec4(t7.x, t7.y, t7.z, row);

                vec3 origin = t4.xyz;
                vec3 position3 = aCorner < 0.5 ? origin : (aCorner < 1.5 ? aTriA.xyz : aTriB);

                vMeterDist  = length(position3 - origin);
                vWorldPos3D = position3;

                gl_Position = projectionMatrix * viewMatrix * vec4(position3, 1.0);
            }
        `,
        fragmentShader: `
            uniform highp sampler3D uSmokeNoise;
            uniform highp sampler2D uLaserParams;
            uniform float uTime;
            uniform vec3  uWind;

            varying float vMeterDist;
            varying vec3  vWorldPos3D;
            flat varying vec4 vColorPan;
            flat varying vec4 vGlow;
            flat varying vec4 vOriginSmk;
            flat varying vec4 vNormalPerp;
            flat varying vec4 vSmoke;
            flat varying vec4 vPatch;

            // Bruit 3D volumétrique : lecture de la texture pré-calculée (calibrée simplex)
            float snoise(vec3 p) {
                return texture(uSmokeNoise, p * ${SMOKE_NOISE_UVW_SCALE.toFixed(6)}).r;
            }

            vec4 layerParam(int texel) {
                return texelFetch(uLaserParams, ivec2(texel, int(vPatch.w + 0.5)), 0);
            }

            // Applique une couche de fumée : m = masque [0,1], k = intensité
            void applyLayer(float m, float k, float dark, float boost, float white, float bright,
                            inout float smokeMod, inout float smokeScatter) {
                smokeMod *= max(0.02, mix(1.0 - k * dark, 1.0 + k * boost, m));
                smokeScatter += m * m * k * white * bright;
            }

            void main() {
                float uPanPower = vColorPan.w;
                if (uPanPower <= 0.001) discard;

                float uSourceGlowPower   = vGlow.x;
                float uGlowIntensity     = vGlow.y;
                float uFogDensity        = vGlow.z;
                float uFogGlowCoupling   = vGlow.w;
                vec3  uOrigin            = vOriginSmk.xyz;
                float uSmokeEnabled      = vOriginSmk.w;
                vec3  nrm                = vNormalPerp.xyz;
                float uSmokePerpSpeed    = vNormalPerp.w;
                float uSmokeScale        = vSmoke.x;
                float uSmokeContrast     = vSmoke.y;
                float uSmokeBrightness   = vSmoke.z;
                float uSmokePatchContrast= vSmoke.w;
                float uSmokePatchScale   = vPatch.x;
                float uSmokePatchDensity = vPatch.y;
                float uSmokePatchSpeed   = vPatch.z;

                // ── Atténuation physique en mètres réels ──
                // De près identique à l'original ; au-delà de ~270 m elle se stabilise sur un
                // plancher lointain pour que la nappe porte jusqu'au bout de la portée, puis fondu final.
                float meterDist    = max(0.0, vMeterDist);
                float distanceFalloff = max(1.0 / (1.0 + pow(meterDist / 38.0, 1.75)), ${PAN_FAR_FLOOR.toFixed(3)}) * ${_RANGE_FADE}meterDist));

                if (distanceFalloff < 0.0005) discard;

                // Éclat d'émission blanc lumineux puissant (très localisé à la buse)
                float originGlow = exp(-vMeterDist / 12.0) * uSourceGlowPower;

                float fogPanScatter = uFogDensity * 30.0 * uFogGlowCoupling * uGlowIntensity;
                float lateralProfile = 1.0 + fogPanScatter;

                // Rejet précoce avant la fumée : même au maximum de densité des volutes et des poches
                // (borne calculée côté CPU, couches supplémentaires comprises), la contribution
                // de ce fragment resterait sous le seuil de quantification.
                float maxSmokeMod = layerParam(8).w;
                if ((0.38 * distanceFalloff * lateralProfile * maxSmokeMod + originGlow * 0.40) * uPanPower < 0.0005) discard;

                // ── Fumée 3D Volumétrique Espace Monde (Isotrope) ──
                float smokeMod    = 1.0;
                float smokeScatter = 0.0;

                if (uSmokeEnabled > 0.5) {
                    // Décomposition spatiale : déplacement dans le plan laser vs perpendiculaire au plan
                    vec3 relPos = vWorldPos3D - uOrigin;
                    float perpDist = dot(relPos, nrm);
                    vec3 inPlanePos = relPos - nrm * perpDist;

                    vec3 effectiveWorldPos = uOrigin + inPlanePos + nrm * (perpDist * clamp(uSmokePerpSpeed, 0.005, 1.0));
                    vec3 sampleCoord = effectiveWorldPos * uSmokeScale + uWind;
                    float bright = uSmokeBrightness;

                    // ── Couche : Turbulence (torsion supplémentaire des volutes, avant leur calcul) ──
                    vec4 Lt = layerParam(9);
                    if (Lt.x > 0.5) {
                        vec3 tc = sampleCoord * Lt.z + vec3(uTime * Lt.w * 0.3, uTime * Lt.w * 0.2, -uTime * Lt.w * 0.25);
                        float ta = snoise(tc + vec3(7.1, 2.3, 5.9));
                        float tb = snoise(tc * 1.17 + vec3(3.3, 8.1, 1.7));
                        sampleCoord += vec3(ta, tb, ta - tb) * Lt.y;
                    }

                    // Léger tourbillon fluide 3D (swirl domain-warp très léger et rapide)
                    float swirl = snoise(sampleCoord * 1.3 + vec3(1.2, 3.4, 5.6)) * 0.22;
                    vec3 warpedCoord = sampleCoord + vec3(swirl, swirl * 0.5, -swirl * 0.7);

                    // 2 octaves 3D complètes et continues
                    float rawNoise = snoise(warpedCoord) * 0.65 + snoise(warpedCoord * 2.08 + vec3(2.3, 1.1, 4.7)) * 0.35;
                    float smokeShape = smoothstep(0.18, 0.82, clamp(rawNoise * 0.5 + 0.5, 0.0, 1.0));

                    smokeMod     = mix(1.0 - uSmokeContrast * 0.70, 1.0 + uSmokeContrast * 0.85, smokeShape);
                    smokeScatter = pow(smokeShape, 2.2) * 0.45 * uSmokeContrast * uSmokeBrightness;

                    // ── Surcouche Poches / Amas Hétérogènes de Fumée (Macro-Densité 3D Monde continue) ──
                    if (uSmokePatchContrast > 0.001) {
                        vec3 patchWind = uWind * (uSmokePatchSpeed * 2.5) + vec3(uTime * 0.035 * uSmokePatchSpeed, uTime * 0.015 * uSmokePatchSpeed, -uTime * 0.025 * uSmokePatchSpeed);
                        vec3 patchCoord = effectiveWorldPos * uSmokePatchScale + patchWind;

                        float rawPatch = snoise(patchCoord) * 0.70 + snoise(patchCoord * 2.15 + vec3(4.1, 1.7, 5.3)) * 0.30;
                        rawPatch = clamp(rawPatch * 0.5 + 0.5, 0.0, 1.0);

                        float edgeLow  = max(0.0, (1.0 - uSmokePatchDensity) * 0.75 - 0.15);
                        float edgeHigh = min(1.0, edgeLow + 0.45);
                        float patchMask = smoothstep(edgeLow, edgeHigh, rawPatch);

                        float patchMultiplier = mix(1.0 - uSmokePatchContrast * 0.85, 1.0 + uSmokePatchContrast * 1.25, patchMask);
                        patchMultiplier = max(0.02, patchMultiplier);

                        smokeMod *= patchMultiplier;
                        smokeScatter = smokeScatter * patchMultiplier + pow(patchMask, 2.0) * 0.40 * uSmokePatchContrast * uSmokeBrightness;
                    }

                    // ── Couche : Poches & amas géants (macro-densité à très grande échelle) ──
                    vec4 Lg = layerParam(11);
                    vec4 L12 = layerParam(12);
                    if (Lg.x > 0.5) {
                        float gs = L12.x;
                        vec3 gWind = uWind * (gs * 2.5) + vec3(uTime * 0.035 * gs, uTime * 0.015 * gs, -uTime * 0.025 * gs);
                        vec3 gc = effectiveWorldPos * Lg.z + gWind + vec3(11.3, 5.7, 2.1);
                        float rawG = snoise(gc) * 0.70 + snoise(gc * 2.15 + vec3(6.1, 2.9, 8.3)) * 0.30;
                        rawG = clamp(rawG * 0.5 + 0.5, 0.0, 1.0);
                        float gLow  = max(0.0, (1.0 - Lg.w) * 0.75 - 0.15);
                        float gMask = smoothstep(gLow, min(1.0, gLow + 0.45), rawG);
                        float gMult = max(0.02, mix(1.0 - Lg.y * 0.85, 1.0 + Lg.y * 1.25, gMask));
                        smokeMod *= gMult;
                        smokeScatter = smokeScatter * gMult + gMask * gMask * 0.40 * Lg.y * bright;
                    }

                    // ── Couche : Rayons radiaux (stries qui partent de la source) ──
                    vec4 Lr = layerParam(10);
                    if (Lr.x > 0.5) {
                        float dl = length(inPlanePos);
                        vec3 dn = inPlanePos / max(dl, 0.001);
                        float n = snoise(dn * Lr.z + vec3(0.0, 0.0, uTime * Lr.w * 0.3) + vec3(dl * 0.004));
                        float m = smoothstep(0.5, 0.85, n * 0.5 + 0.5);
                        applyLayer(m, Lr.y, 0.6, 1.2, 0.3, bright, smokeMod, smokeScatter);
                    }

                    // ── Intensité visuelle de la fumée × atténuation avec la distance ──
                    // La fumée s'estompe progressivement : ~8 % de son effet vers 300 m (jamais 0).
                    float smokeK = L12.y * mix(1.0, 0.08, smoothstep(40.0, 300.0, meterDist));
                    smokeMod     = max(0.02, mix(1.0, smokeMod, smokeK));
                    smokeScatter *= smokeK;
                }

                float sheetAlpha = 0.38 * distanceFalloff * lateralProfile * smokeMod;
                float whiteCore  = clamp(smokeScatter * 0.35, 0.0, 0.85);
                float originWhite = exp(-vMeterDist / 25.0) * clamp(uSourceGlowPower * 0.70, 0.0, 1.0);

                vec3 col      = mix(vColorPan.rgb, vec3(1.0), clamp(originWhite + whiteCore, 0.0, 0.85));
                float alpha   = clamp(sheetAlpha + originGlow * 0.40, 0.0, 1.0) * uPanPower;

                gl_FragColor = vec4(col, alpha);
            }
        `,
        ...baseMaterialOptions()
    });
}

// ── 3. Éclat Sphérique à la Source (instancié, billboard caméra) ────────────
export function createPodGlowMaterial(paramsTexture) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uLaserParams: { value: paramsTexture }
        },
        vertexShader: `
            ${_PARAMS_GLSL}
            attribute float aRow;
            varying vec2 vUv;
            flat varying vec4 vColorGlow; // satColor.rgb, sourceGlowPower
            flat varying vec4 vGlow;      // emissionPower, glowRadius, fogDensity, fogGlowCoupling

            void main() {
                vUv = uv;
                vec4 t1 = laserParam(aRow, 1);
                vec4 t2 = laserParam(aRow, 2);
                vec4 t3 = laserParam(aRow, 3);
                vec4 t4 = laserParam(aRow, 4);
                vec4 t8 = laserParam(aRow, 8);
                vColorGlow = vec4(t1.rgb, t2.x);
                vGlow = vec4(t8.y, t8.z, t3.x, t3.y);

                vec4 mvPosition = modelViewMatrix * vec4(t4.xyz, 1.0);
                mvPosition.xy += position.xy;
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            varying vec2 vUv;
            flat varying vec4 vColorGlow;
            flat varying vec4 vGlow;

            void main() {
                float uSourceGlowPower     = vColorGlow.w;
                float uSourceEmissionPower = vGlow.x;
                float uSourceGlowRadius    = vGlow.y;
                float uFogDensity          = vGlow.z;
                float uFogGlowCoupling     = vGlow.w;

                if (uSourceGlowPower < 0.01) discard;

                float dist = length(vUv - vec2(0.5)) * 2.0;
                if (dist > 1.0) discard;

                float scaledDist = dist / max(0.1, uSourceGlowRadius);

                float core = exp(-scaledDist * scaledDist * 12.0) * uSourceGlowPower * uSourceEmissionPower;
                float fogDispersion = uFogDensity * 25.0 * uFogGlowCoupling;
                float aura = exp(-scaledDist * 3.2) * (0.8 + fogDispersion) * uSourceEmissionPower * uSourceGlowPower;

                float whiteFactor = clamp(core * 0.90, 0.0, 1.0);
                vec3 col = mix(vColorGlow.rgb, vec3(1.0, 1.0, 1.0), whiteFactor);

                float alpha = clamp((core * 0.9 + aura * 0.6), 0.0, 1.0);

                gl_FragColor = vec4(col, alpha);
            }
        `,
        ...baseMaterialOptions()
    });
}

// ── 4. Halo d'Impact Ponctuel (instancié) ─────────────────
export function createImpactMaterial(paramsTexture) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uLaserParams: { value: paramsTexture }
        },
        vertexShader: `
            ${_PARAMS_GLSL}
            attribute vec4 aImpA; // centre.xyz, ligne laser
            attribute vec4 aImpB; // normale.xyz, rayon
            varying vec2 vUv;
            flat varying vec4 vColorPower; // satColor.rgb, impactPower
            flat varying vec4 vGlow;       // fogDensity, impactGlowIntensity, impactGlowRadius, fogGlowCoupling

            void main() {
                vUv = uv;
                float row = aImpA.w;
                vec4 t3 = laserParam(row, 3);
                vec4 t7 = laserParam(row, 7);
                vec4 t8 = laserParam(row, 8);
                vColorPower = laserParam(row, 1);
                vGlow = vec4(t3.x, t7.w, t8.x, t3.y);

                // Repère tangent aligné sur les axes (identique au calcul CPU d'origine)
                vec3 n = aImpB.xyz;
                vec3 u, v;
                if (abs(n.x) > 0.5) {
                    u = vec3(0.0, 0.0, 1.0); v = vec3(0.0, 1.0, 0.0);
                } else if (abs(n.y) > 0.5) {
                    u = vec3(1.0, 0.0, 0.0); v = vec3(0.0, 0.0, 1.0);
                } else {
                    u = vec3(1.0, 0.0, 0.0); v = vec3(0.0, 1.0, 0.0);
                }
                float r = aImpB.w;
                vec3 pos = aImpA.xyz + (uv.x * 2.0 - 1.0) * r * u + (uv.y * 2.0 - 1.0) * r * v;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            }
        `,
        fragmentShader: `
            varying vec2 vUv;
            flat varying vec4 vColorPower;
            flat varying vec4 vGlow;

            void main() {
                float uImpactPower         = vColorPower.w;
                float uFogDensity          = vGlow.x;
                float uImpactGlowIntensity = vGlow.y;
                float uImpactGlowRadius    = vGlow.z;
                float uFogGlowCoupling     = vGlow.w;

                if (uImpactPower <= 0.001) discard;

                float dist = length(vUv - vec2(0.5)) * 2.0;
                if (dist > 1.0) discard;

                float alphaShape = smoothstep(1.0, 0.0, dist);
                float core = exp(-dist * dist * 5.0) * uImpactPower;

                float fogImpactAura = uFogDensity * 30.0 * uFogGlowCoupling * uImpactGlowIntensity;
                float fogHalo = exp(-dist * dist * (3.5 / max(0.1, uImpactGlowRadius))) * fogImpactAura;

                float whiteFactor = pow(clamp(uImpactPower * 0.15, 0.0, 1.0), 2.5) * exp(-dist * dist * 6.0) * 0.40;
                vec3 finalColor = mix(vColorPower.rgb, vec3(1.0, 1.0, 1.0), whiteFactor);

                float alpha = alphaShape * (0.3 + 0.7 * core + fogHalo) * uImpactPower;

                gl_FragColor = vec4(finalColor, alpha);
            }
        `,
        ...baseMaterialOptions()
    });
}

// ── 5. Halo d'Impact de Ligne Continue (Plan PAN, instancié) ───────────────────
export function createPanImpactMaterial(paramsTexture) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uLaserParams: { value: paramsTexture }
        },
        vertexShader: `
            ${_PARAMS_GLSL}
            attribute vec4 aSegA; // c1.xyz, ligne laser
            attribute vec3 aSegB; // c2
            attribute vec3 aSegS; // demi-largeur transverse (vecteur)
            varying vec2 vUv;
            flat varying vec4 vColorPower; // satColor.rgb, linePower
            flat varying vec4 vGlow;       // fogDensity, impactGlowIntensity, impactGlowRadius, fogGlowCoupling

            void main() {
                vUv = uv;
                float row = aSegA.w;
                vec4 t1 = laserParam(row, 1);
                vec4 t3 = laserParam(row, 3);
                vec4 t7 = laserParam(row, 7);
                vec4 t8 = laserParam(row, 8);
                vColorPower = vec4(t1.rgb, t3.z);
                vGlow = vec4(t3.x, t7.w, t8.x, t3.y);

                vec3 pos = mix(aSegA.xyz, aSegB, uv.y) + (uv.x * 2.0 - 1.0) * aSegS;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
            }
        `,
        fragmentShader: `
            varying vec2 vUv;
            flat varying vec4 vColorPower;
            flat varying vec4 vGlow;

            void main() {
                float uLinePower           = vColorPower.w;
                float uFogDensity          = vGlow.x;
                float uImpactGlowIntensity = vGlow.y;
                float uImpactGlowRadius    = vGlow.z;
                float uFogGlowCoupling     = vGlow.w;

                if (uLinePower <= 0.001) discard;

                float dist = abs(vUv.x - 0.5) * 2.0;
                if (dist > 1.0) discard;

                float alphaShape = smoothstep(1.0, 0.0, dist);
                float core = exp(-dist * dist * 8.0) * uLinePower;

                float fogImpactAura = uFogDensity * 20.0 * uFogGlowCoupling * uImpactGlowIntensity;
                float fogHalo = exp(-dist * dist * (4.0 / max(0.1, uImpactGlowRadius))) * fogImpactAura;

                float whiteFactor = pow(clamp(uLinePower * 0.15, 0.0, 1.0), 2.5) * exp(-dist * dist * 8.0) * 0.40;
                vec3 finalCol = mix(vColorPower.rgb, vec3(1.0, 1.0, 1.0), whiteFactor);

                float alpha = alphaShape * (0.35 + 0.65 * core + fogHalo) * uLinePower;

                gl_FragColor = vec4(finalCol, alpha);
            }
        `,
        ...baseMaterialOptions()
    });
}

/**
 * Saturation chromatique laser (identique au GLSL d'origine boostLaserSaturation),
 * calculée une fois par laser côté CPU au lieu d'une fois par pixel.
 */
export function boostLaserSaturation(color, sat, out) {
    const luma = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
    const sr = luma + (color.r - luma) * sat;
    const sg = luma + (color.g - luma) * sat;
    const sb = luma + (color.b - luma) * sat;
    const pr = Math.pow(Math.max(0, sr), 0.86);
    const pg = Math.pow(Math.max(0, sg), 0.86);
    const pb = Math.pow(Math.max(0, sb), 0.86);
    out[0] = Math.max(0, sr + (pr - sr) * 0.45);
    out[1] = Math.max(0, sg + (pg - sg) * 0.45);
    out[2] = Math.max(0, sb + (pb - sb) * 0.45);
    return out;
}
