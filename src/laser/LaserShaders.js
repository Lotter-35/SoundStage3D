/**
 * LaserShaders.js
 * ─────────────────────────────────────────────────────────────
 * Matériaux GLSL personnalisés Three.js (ShaderMaterial) pour le laser :
 * 1. laserShaderMaterial     — faisceau cylindrique avec divergence physique & fumée volumétrique SimonDev
 * 2. fanShaderMaterial       — plan PAN volumétrique (dégradé fluide)
 * 3. podGlowMaterial         — éclat sphérique dispersif à la source
 * 4. impactShaderMaterial    — halo circulaire au point d'impact de chaque trait
 * 5. panImpactShaderMaterial — ligne lumineuse continue d'impact du plan
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { BEAM_DIVERGENCE } from './config/laserConstants.js';

// ── Bruit Simplex 3D de Ashima Arts (SimonDev Volumetric Fog) ──
// Échantillonné en espace métrique 3D réel (X, Y, Z) : suppression totale de tout étirement de texture sur les vagues et sinusoïdes
const _NOISE_SIMONDEV_GLSL = `
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    // Premier coin
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    // Autres coins
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    // Permutations
    i = mod289(i);
    vec4 p = permute(permute(permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    // Gradients
    float n_ = 0.142857142857; // 1.0 / 7.0
    vec3  ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// FBM 3 octaves en 3D — volutes volumétriques isotropes
float FBM(vec3 p) {
    float v = 0.0, a = 0.5;
    v += a * snoise(p); p *= 2.04; a *= 0.5;
    v += a * snoise(p); p *= 2.04; a *= 0.5;
    v += a * snoise(p);
    return v;
}

// FBM2 2 octaves en 3D — déformation volumétrique (domain warping)
float FBM2(vec3 p) {
    float v = 0.0, a = 0.5;
    v += a * snoise(p); p *= 2.04; a *= 0.5;
    v += a * snoise(p);
    return v;
}
`;

// ── 1. Faisceaux Laser (Cylindres caméra-alignés avec divergence & fumée SimonDev) ───
export function createLaserShaderMaterial(params) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uColor:               { value: new THREE.Color(params.color) },
            uBeamWidth:           { value: params.beamWidth },
            uBeamDivergence:      { value: BEAM_DIVERGENCE },
            uBeamPower:           { value: params.beamPower },
            uSourceGlowPower:     { value: 1.0 },
            uGlowIntensity:       { value: params.glowIntensity },
            uGlowScattering:      { value: params.glowScattering },
            uGlowFalloff:         { value: params.glowFalloff },
            uFogDensity:          { value: params.fogDensity },
            uFogGlowCoupling:     { value: params.fogGlowCoupling }
        },
        vertexShader: `
            attribute vec3 aHitPoint;
            attribute vec3 aOrigin;
            attribute float aSide;

            uniform float uBeamWidth;
            uniform float uBeamDivergence;

            varying vec2  vUv;
            varying float vMeterDist;

            void main() {
                vUv = uv;

                vec4 vOrig4 = modelViewMatrix * vec4(aOrigin, 1.0);
                vec4 vHit4  = modelViewMatrix * vec4(aHitPoint, 1.0);
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
                float divergenceFactor = 1.0 + (currentDist * 0.008) * uBeamDivergence;
                float baseWidth = (0.012 + 0.016 * uBeamWidth);
                float width = baseWidth * divergenceFactor;
                vec3 finalViewPos = vPos + vSide * aSide * width;

                gl_Position = projectionMatrix * vec4(finalViewPos, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3  uColor;
            uniform float uBeamPower;
            uniform float uBeamWidth;
            uniform float uSourceGlowPower;
            uniform float uGlowIntensity;
            uniform float uGlowScattering;
            uniform float uGlowFalloff;
            uniform float uFogDensity;
            uniform float uFogGlowCoupling;

            varying vec2  vUv;
            varying float vMeterDist;

            void main() {
                if (uBeamPower <= 0.001 || uBeamWidth <= 0.001) discard;

                float distFromCenter = abs(vUv.x - 0.5) * 2.0;
                float baseAlpha = (1.0 - distFromCenter);

                float scatter = clamp(uGlowScattering, 0.0, 3.0);

                // Halo de diffusion atmosphérique
                float fogScatter = uFogDensity * 45.0 * uFogGlowCoupling * scatter;
                float halo = pow(1.0 - distFromCenter, max(0.2, uGlowFalloff)) * (uGlowIntensity * 0.4 + fogScatter);

                // Éclat blanc concentré à la source (buse physique du laser)
                float sourceWhite = exp(-min(vMeterDist * 3.5, vUv.y * 18.0)) * clamp(uSourceGlowPower, 0.0, 1.5);

                // Atténuation physique atmosphérique le long du faisceau
                float beamDistFalloff = 1.0 / (1.0 + pow(max(0.0, vMeterDist) / 65.0, 1.35));

                // Cœur blanc du faisceau : strictement conditionné par la diffusion du faisceau
                // Si scatter == 0.0 → beamWhite = 0.0 (le trait garde 100% sa couleur pure)
                // Si scatter == 1.0 → beamWhite = 0.85 (effet d'origine avec cœur blanc intense)
                float beamCoreWhite = pow(baseAlpha, 4.0) * 0.85 * scatter;
                float haloWhite     = halo * 0.25 * scatter;

                float totalWhite = clamp(sourceWhite + beamCoreWhite + haloWhite, 0.0, 1.0);
                vec3 col = mix(uColor, vec3(1.0, 1.0, 1.0), totalWhite);

                float alpha = clamp(baseAlpha + halo * (0.35 + 0.50 * scatter) + sourceWhite * 0.8, 0.0, 1.0) * uBeamPower * beamDistFalloff;

                gl_FragColor = vec4(col, alpha);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
    });
}

// ── 2. Plan Laser PAN (Volumétrique en nappe avec fumée animée — visuel original préservé) ───────
export function createFanShaderMaterial(params) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uColor:            { value: new THREE.Color(params.color) },
            uOrigin:           { value: new THREE.Vector3() },
            uTime:             { value: 0.0 },
            uWind:             { value: new THREE.Vector3() },
            uSmokeEnabled:     { value: params.panSmokeEnabled !== false ? 1.0 : 0.0 },
            uSmokeSpeed:       { value: params.panSmokeSpeed !== undefined ? params.panSmokeSpeed : 0.8 },
            uSmokeScale:       { value: params.panSmokeScale !== undefined ? params.panSmokeScale : 0.08 },
            uSmokeContrast:    { value: params.panSmokeContrast !== undefined ? params.panSmokeContrast : 0.65 },
            uSmokeBrightness:  { value: params.panSmokeBrightness !== undefined ? params.panSmokeBrightness : 0.75 },
            uSmokeWindChange:  { value: params.panSmokeWindChange !== undefined ? params.panSmokeWindChange : 0.8 },
            uPanPower:         { value: params.panPower },
            uBeamPower:        { value: params.beamPower },
            uBeamWidth:        { value: params.beamWidth },
            uLaserForward:     { value: new THREE.Vector3(0, 0, 1) },
            uLaserRight:       { value: new THREE.Vector3(1, 0, 0) },
            uLaserUp:          { value: new THREE.Vector3(0, 1, 0) },
            uSmokePatchDensity:   { value: params.panSmokePatchDensity !== undefined ? params.panSmokePatchDensity : 0.60 },
            uSmokePatchScale:     { value: params.panSmokePatchScale !== undefined ? params.panSmokePatchScale : 0.06 },
            uSmokePatchContrast:  { value: params.panSmokePatchContrast !== undefined ? params.panSmokePatchContrast : 0.70 },
            uSmokePatchSpeed:     { value: params.panSmokePatchSpeed !== undefined ? params.panSmokePatchSpeed : 0.02 },
            uSourceGlowPower:  { value: 1.0 },
            uGlowIntensity:    { value: params.glowIntensity },
            uFogDensity:       { value: params.fogDensity },
            uFogGlowCoupling:  { value: params.fogGlowCoupling }
        },
        vertexShader: `
            attribute float aDistRatio;
            attribute float aLateral;
            uniform vec3  uOrigin;
            uniform vec3  uLaserForward;
            uniform vec3  uLaserRight;
            uniform vec3  uLaserUp;

            varying float vDistRatio;
            varying float vLateral;
            varying float vMeterDist;
            varying vec3  vLocalPos3D;

            void main() {
                vDistRatio   = aDistRatio;
                vLateral     = aLateral;
                vMeterDist   = length(position - uOrigin);

                // ── Échantillonnage 3D métrique dans le repère orienté du laser (0 étirement quelle que soit la forme) ──
                vec3 rel = position - uOrigin;
                vLocalPos3D = vec3(
                    dot(rel, uLaserRight),
                    dot(rel, uLaserUp),
                    dot(rel, uLaserForward)
                );

                gl_Position  = projectionMatrix * viewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            ${_NOISE_SIMONDEV_GLSL}

            uniform vec3  uColor;
            uniform float uTime;
            uniform vec3  uWind;
            uniform float uSmokeEnabled;
            uniform float uSmokeContrast;
            uniform float uSmokeBrightness;
            uniform float uSmokeScale;
            uniform float uSmokePatchContrast;
            uniform float uSmokePatchScale;
            uniform float uSmokePatchDensity;
            uniform float uSmokePatchSpeed;
            uniform float uPanPower;
            uniform float uBeamPower;
            uniform float uBeamWidth;
            uniform float uSourceGlowPower;
            uniform float uGlowIntensity;
            uniform float uFogDensity;
            uniform float uFogGlowCoupling;

            varying float vDistRatio;
            varying float vLateral;
            varying float vMeterDist;
            varying vec3  vLocalPos3D;

            void main() {
                if (uPanPower <= 0.001) discard;

                // ── Atténuation physique en mètres réels ──
                float meterDist    = max(0.0, vMeterDist);
                float meterFalloff = 1.0 / (1.0 + pow(meterDist / 38.0, 1.75));

                float distanceFalloff = meterFalloff * mix(1.0, 0.40,
                    smoothstep(0.0, 1.0, clamp(vDistRatio, 0.0, 1.0)));

                // Rejet précoce : fragments transparents lointains (~40% du budget économisé)
                if (distanceFalloff < 0.006) discard;

                float originGlow = exp(-vDistRatio * 10.0) * uSourceGlowPower;

                float lateralBase = 1.0;
                float fogPanScatter = uFogDensity * 30.0 * uFogGlowCoupling * uGlowIntensity;
                float lateralProfile = lateralBase + fogPanScatter;

                // ── Domain Warping SimonDev 3D : f(p) = FBM( p + FBM2(p) ) ──
                // Échantillonné en coordonnées 3D : totalement indépendant de la déformation géométrique (sinus, vague, zigzag)
                float smokeMod    = 1.0;
                float smokeScatter = 0.0;

                if (uSmokeEnabled > 0.5) {
                    float t = uTime * 0.05;
                    vec3 sampleCoord = (vLocalPos3D * uSmokeScale) + uWind;

                    vec3 warp = vec3(
                        FBM2(sampleCoord + vec3(t * 0.7, 0.0, t * 0.2)),
                        FBM2(sampleCoord + vec3(4.3, 1.2 + t * 0.5, 0.0)),
                        FBM2(sampleCoord + vec3(0.0, 2.5, 3.8 + t * 0.4))
                    ) * 0.55;

                    vec3 warpedCoord = sampleCoord + warp;
                    float rawNoise   = FBM(warpedCoord) * 0.5 + 0.5;
                    float smokeShape = smoothstep(0.18, 0.82, clamp(rawNoise, 0.0, 1.0));

                    smokeMod     = mix(1.0 - uSmokeContrast * 0.70, 1.0 + uSmokeContrast * 0.85, smokeShape);
                    smokeScatter = pow(smokeShape, 2.2) * 0.45 * uSmokeContrast * uSmokeBrightness;

                    // ── Surcouche Poches / Amas Hétérogènes de Fumée 3D (Macro-Densité) ──
                    if (uSmokePatchContrast > 0.001) {
                        vec3 patchCoord = (vLocalPos3D * uSmokePatchScale) + (uWind * uSmokePatchSpeed) + vec3(uTime * 0.015, uTime * 0.010, uTime * 0.008);
                        float rawPatch = snoise(patchCoord) * 0.5 + 0.5;

                        float edgeLow  = max(0.0, (1.0 - uSmokePatchDensity) * 0.7 - 0.2);
                        float edgeHigh = min(1.0, edgeLow + 0.5);
                        float patchMask = smoothstep(edgeLow, edgeHigh, rawPatch);

                        float patchMultiplier = mix(1.0 - uSmokePatchContrast * 0.95, 1.0 + uSmokePatchContrast * 0.65, patchMask);
                        patchMultiplier = max(0.02, patchMultiplier);

                        smokeMod *= patchMultiplier;
                        smokeScatter *= patchMultiplier;
                    }
                }

                float sheetAlpha = 0.38 * distanceFalloff * lateralProfile * smokeMod;
                float whiteCore  = clamp(smokeScatter * 0.60, 0.0, 1.0);

                vec3  col        = mix(uColor, vec3(1.0), clamp(originGlow * 0.75 + whiteCore, 0.0, 1.0));
                float alpha      = clamp(sheetAlpha + originGlow * 0.4, 0.0, 1.0) * uPanPower;

                gl_FragColor = vec4(col, alpha);
            }
        `,
        transparent: true,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
        side:        THREE.DoubleSide
    });
}

// ── 3. Éclat Sphérique à la Source (Pod) ────────────────────────────
export function createPodGlowMaterial(params) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uColor:               { value: new THREE.Color(params.color) },
            uSourceGlowPower:     { value: 1.0 },
            uSourceEmissionPower: { value: params.sourceEmissionPower },
            uSourceGlowRadius:    { value: params.sourceGlowRadius },
            uFogDensity:          { value: params.fogDensity },
            uFogGlowCoupling:     { value: params.fogGlowCoupling }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                mvPosition.xy += position.xy;
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            uniform vec3 uColor;
            uniform float uSourceGlowPower;
            uniform float uSourceEmissionPower;
            uniform float uSourceGlowRadius;
            uniform float uFogDensity;
            uniform float uFogGlowCoupling;
            varying vec2 vUv;

            void main() {
                if (uSourceGlowPower < 0.01) discard;

                float dist = length(vUv - vec2(0.5)) * 2.0;
                if (dist > 1.0) discard;

                float scaledDist = dist / max(0.1, uSourceGlowRadius);

                float core = exp(-scaledDist * scaledDist * 12.0) * uSourceGlowPower * uSourceEmissionPower;
                float fogDispersion = uFogDensity * 25.0 * uFogGlowCoupling;
                float aura = exp(-scaledDist * 3.2) * (0.8 + fogDispersion) * uSourceEmissionPower * uSourceGlowPower;

                float whiteFactor = clamp(core * 0.95, 0.0, 1.0);
                vec3 col = mix(uColor, vec3(1.0, 1.0, 1.0), whiteFactor);

                float alpha = clamp((core * 0.9 + aura * 0.6), 0.0, 1.0);

                gl_FragColor = vec4(col, alpha);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
    });
}

export const podGlowGeo = new THREE.PlaneGeometry(1.8, 1.8);

// ── 4. Halo d'Impact Ponctuel (Faisceau individuel) ─────────────────
export function createImpactShaderMaterial(params) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uColor:               { value: new THREE.Color(params.color) },
            uImpactPower:         { value: params.beamPower },
            uFogDensity:          { value: params.fogDensity },
            uImpactGlowIntensity: { value: params.impactGlowIntensity },
            uImpactGlowRadius:    { value: params.impactGlowRadius },
            uFogGlowCoupling:     { value: params.fogGlowCoupling }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 uColor;
            uniform float uImpactPower;
            uniform float uFogDensity;
            uniform float uImpactGlowIntensity;
            uniform float uImpactGlowRadius;
            uniform float uFogGlowCoupling;
            varying vec2 vUv;

            void main() {
                if (uImpactPower <= 0.001) discard;

                float dist = length(vUv - vec2(0.5)) * 2.0;
                if (dist > 1.0) discard;

                float alphaShape = smoothstep(1.0, 0.0, dist);
                float core = exp(-dist * dist * 5.0) * uImpactPower;

                float fogImpactAura = uFogDensity * 30.0 * uFogGlowCoupling * uImpactGlowIntensity;
                float fogHalo = exp(-dist * dist * (3.5 / max(0.1, uImpactGlowRadius))) * fogImpactAura;

                float whiteFactor = pow(clamp(uImpactPower * 0.22, 0.0, 1.0), 2.2) * exp(-dist * dist * 5.0);
                vec3 finalColor = mix(uColor, vec3(1.0, 1.0, 1.0), whiteFactor);

                float alpha = alphaShape * (0.3 + 0.7 * core + fogHalo) * uImpactPower;

                gl_FragColor = vec4(finalColor, alpha);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
    });
}

// ── 5. Halo d'Impact de Ligne Continue (Plan PAN) ───────────────────
export function createPanImpactShaderMaterial(params) {
    return new THREE.ShaderMaterial({
        uniforms: {
            uColor:               { value: new THREE.Color(params.color) },
            uLinePower:           { value: params.panPower },
            uFogDensity:          { value: params.fogDensity },
            uImpactGlowIntensity: { value: params.impactGlowIntensity },
            uImpactGlowRadius:    { value: params.impactGlowRadius },
            uFogGlowCoupling:     { value: params.fogGlowCoupling }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 uColor;
            uniform float uLinePower;
            uniform float uFogDensity;
            uniform float uImpactGlowIntensity;
            uniform float uImpactGlowRadius;
            uniform float uFogGlowCoupling;
            varying vec2 vUv;

            void main() {
                if (uLinePower <= 0.001) discard;

                float dist = abs(vUv.x - 0.5) * 2.0;
                if (dist > 1.0) discard;

                float alphaShape = smoothstep(1.0, 0.0, dist);
                float core = exp(-dist * dist * 8.0) * uLinePower;

                float fogImpactAura = uFogDensity * 20.0 * uFogGlowCoupling * uImpactGlowIntensity;
                float fogHalo = exp(-dist * dist * (4.0 / max(0.1, uImpactGlowRadius))) * fogImpactAura;

                float whiteFactor = pow(clamp(uLinePower * 0.22, 0.0, 1.0), 2.2) * exp(-dist * dist * 8.0);
                vec3 finalCol = mix(uColor, vec3(1.0, 1.0, 1.0), whiteFactor);

                float alpha = alphaShape * (0.35 + 0.65 * core + fogHalo) * uLinePower;

                gl_FragColor = vec4(finalCol, alpha);
            }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
    });
}

/** Met à jour la couleur uniforme de tous les shaders laser */
export function setShadersColor(colorHex, materials) {
    const c = new THREE.Color(colorHex);
    materials.laserShaderMaterial.uniforms.uColor.value.copy(c);
    materials.fanShaderMaterial.uniforms.uColor.value.copy(c);
    materials.podGlowMaterial.uniforms.uColor.value.copy(c);
    materials.impactShaderMaterial.uniforms.uColor.value.copy(c);
    materials.panImpactShaderMaterial.uniforms.uColor.value.copy(c);
}
