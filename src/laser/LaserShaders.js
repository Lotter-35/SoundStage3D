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

// ── Bruit Simplex 3D Volumétrique Ashima Arts (Isotrope Espace Monde 3D) ──
// Échantillonné directement en coordonnées 3D réelles mondes (X, Y, Z) :
// 0 étirement, 0 distorsion lors des balayages horizontaux et des courbures sinusoïdales
const _NOISE_3D_GLSL = `
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
`;

// ── Hyper-Saturation & Vibrance Chromatique Laser (Couleurs intenses hardcodées) ──
const _COLOR_SATURATION_GLSL = `
vec3 boostLaserSaturation(vec3 c, float sat) {
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    // Amplification de la saturation par rapport à la luminance
    vec3 saturated = mix(vec3(luma), c, sat);
    // Renforcement chromatique des composantes dominantes (effet laser diode pur néon/fluo)
    vec3 pure = pow(max(vec3(0.0), saturated), vec3(0.86));
    return max(vec3(0.0), mix(saturated, pure, 0.45));
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
            ${_COLOR_SATURATION_GLSL}

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

                // Éclat blanc puissant à l'émission (sortie du laser éclatante et diffusive)
                float sourceWhite = exp(-vMeterDist / 25.0) * clamp(uSourceGlowPower, 0.0, 1.5);

                // Atténuation physique atmosphérique le long du faisceau
                float beamDistFalloff = 1.0 / (1.0 + pow(max(0.0, vMeterDist) / 65.0, 1.35));

                // Cœur blanc éclatant et diffusion dans les traits de laser
                float beamCoreWhite = pow(baseAlpha, 4.0) * 0.85 * scatter;
                float haloWhite     = halo * 0.20 * scatter;

                float totalWhite = clamp(sourceWhite + beamCoreWhite + haloWhite, 0.0, 1.0);

                // Couleurs hyper-saturées traversées par le blanc éclatant au cœur et à la sortie
                vec3 satColor = boostLaserSaturation(uColor, 1.35);
                vec3 col = mix(satColor, vec3(1.0, 1.0, 1.0), totalWhite);

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
            uSmokeSpeed:       { value: params.panSmokeSpeed !== undefined ? params.panSmokeSpeed : 0.30 },
            uSmokeScale:       { value: params.panSmokeScale !== undefined ? params.panSmokeScale : 0.35 },
            uSmokeContrast:    { value: params.panSmokeContrast !== undefined ? params.panSmokeContrast : 0.50 },
            uSmokeBrightness:  { value: params.panSmokeBrightness !== undefined ? params.panSmokeBrightness : 2.0 },
            uSmokeWindChange:  { value: params.panSmokeWindChange !== undefined ? params.panSmokeWindChange : 1.0 },
            uPanPower:         { value: params.panPower },
            uBeamPower:        { value: params.beamPower },
            uBeamWidth:        { value: params.beamWidth },
            uLaserForward:     { value: new THREE.Vector3(0, 0, 1) },
            uLaserRight:       { value: new THREE.Vector3(1, 0, 0) },
            uLaserUp:          { value: new THREE.Vector3(0, 1, 0) },
            uSmokePatchDensity:   { value: params.panSmokePatchDensity !== undefined ? params.panSmokePatchDensity : 0.50 },
            uSmokePatchScale:     { value: params.panSmokePatchScale !== undefined ? params.panSmokePatchScale : 0.04 },
            uSmokePatchContrast:  { value: params.panSmokePatchContrast !== undefined ? params.panSmokePatchContrast : 0.40 },
            uSmokePatchSpeed:     { value: params.panSmokePatchSpeed !== undefined ? params.panSmokePatchSpeed : 0.04 },
            uPanNormal:           { value: new THREE.Vector3(0, 1, 0) },
            uSmokePerpSpeed:      { value: params.panSmokePerpSpeed !== undefined ? params.panSmokePerpSpeed : 0.15 },
            uLaserCount:          { value: 1.0 },
            uSourceGlowPower:  { value: 1.0 },
            uGlowIntensity:    { value: params.glowIntensity },
            uFogDensity:       { value: params.fogDensity },
            uFogGlowCoupling:  { value: params.fogGlowCoupling }
        },
        vertexShader: `
            attribute float aDistRatio;
            attribute float aLateral;
            uniform vec3  uOrigin;

            varying float vDistRatio;
            varying float vLateral;
            varying float vMeterDist;
            varying vec3  vWorldPos3D;

            void main() {
                vDistRatio   = aDistRatio;
                vLateral     = aLateral;
                vMeterDist   = length(position - uOrigin);

                // Position absolue en coordonnées réelles du monde (espace scène 3D unifié)
                vWorldPos3D  = position;

                gl_Position  = projectionMatrix * viewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            ${_NOISE_3D_GLSL}
            ${_COLOR_SATURATION_GLSL}

            uniform vec3  uColor;
            uniform vec3  uOrigin;
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
            uniform vec3  uPanNormal;
            uniform float uSmokePerpSpeed;
            uniform float uLaserCount;
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
            varying vec3  vWorldPos3D;

            void main() {
                if (uPanPower <= 0.001) discard;

                // ── Atténuation physique en mètres réels ──
                float meterDist    = max(0.0, vMeterDist);
                float meterFalloff = 1.0 / (1.0 + pow(meterDist / 38.0, 1.75));

                // Atténuation métrique continue identique vers le sol (30m) ou vers le ciel (500m)
                float distanceFalloff = meterFalloff;

                // Rejet précoce : fragments quasi-invisibles au fond du ciel (>120m) sans démarcation visible
                if (distanceFalloff < 0.005) discard;

                // Éclat d'émission blanc lumineux puissant (très localisé à la buse)
                float originGlow = exp(-vMeterDist / 12.0) * uSourceGlowPower;

                float lateralBase = 1.0;
                float fogPanScatter = uFogDensity * 30.0 * uFogGlowCoupling * uGlowIntensity;
                float lateralProfile = lateralBase + fogPanScatter;

                // ── Fumée 3D Volumétrique Espace Monde (Isotrope) ──
                float smokeMod    = 1.0;
                float smokeScatter = 0.0;

                if (uSmokeEnabled > 0.5) {
                    // Décomposition spatiale : déplacement dans le plan laser vs perpendiculaire au plan
                    vec3 relPos = vWorldPos3D - uOrigin;
                    vec3 nrm = length(uPanNormal) > 0.5 ? normalize(uPanNormal) : vec3(0.0, 1.0, 0.0);
                    float perpDist = dot(relPos, nrm);
                    vec3 inPlanePos = relPos - nrm * perpDist;

                    vec3 effectiveWorldPos = uOrigin + inPlanePos + nrm * (perpDist * clamp(uSmokePerpSpeed, 0.005, 1.0));
                    vec3 sampleCoord = effectiveWorldPos * uSmokeScale + uWind;

                    // Léger tourbillon fluide 3D (swirl domain-warp très léger et rapide)
                    float swirl = snoise(sampleCoord * 1.3 + vec3(1.2, 3.4, 5.6)) * 0.22;
                    vec3 warpedCoord = sampleCoord + vec3(swirl, swirl * 0.5, -swirl * 0.7);

                    // 2 octaves 3D complètes et continues (sans aucune démarcation ni saut de LOD)
                    float rawNoise = snoise(warpedCoord) * 0.65 + snoise(warpedCoord * 2.08 + vec3(2.3, 1.1, 4.7)) * 0.35;
                    float smokeShape = smoothstep(0.18, 0.82, clamp(rawNoise * 0.5 + 0.5, 0.0, 1.0));

                    smokeMod     = mix(1.0 - uSmokeContrast * 0.70, 1.0 + uSmokeContrast * 0.85, smokeShape);
                    smokeScatter = pow(smokeShape, 2.2) * 0.45 * uSmokeContrast * uSmokeBrightness;

                    // ── Surcouche Poches / Amas Hétérogènes de Fumée (Macro-Densité 3D Monde continue) ──
                    if (uSmokePatchContrast > 0.001) {
                        vec3 patchWind = uWind * (uSmokePatchSpeed * 2.5) + vec3(uTime * 0.035 * uSmokePatchSpeed, uTime * 0.015 * uSmokePatchSpeed, -uTime * 0.025 * uSmokePatchSpeed);
                        vec3 patchCoord = effectiveWorldPos * uSmokePatchScale + patchWind;

                        // 2 octaves 3D continues pour des amas volumineux avec contours vaporeux naturels
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
                }

                float sheetAlpha = 0.38 * distanceFalloff * lateralProfile * smokeMod;
                float whiteCore  = clamp(smokeScatter * 0.35, 0.0, 0.85);
                float originWhite = exp(-vMeterDist / 25.0) * clamp(uSourceGlowPower * 0.70, 0.0, 1.0);

                // Hyper-saturation hardcodée de la nappe et des volutes de fumée avec diffusion blanche à la sortie
                vec3 satColor = boostLaserSaturation(uColor, 1.35);
                vec3 col      = mix(satColor, vec3(1.0), clamp(originWhite + whiteCore, 0.0, 0.85));
                float alpha   = clamp(sheetAlpha + originGlow * 0.40, 0.0, 1.0) * uPanPower;

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
            ${_COLOR_SATURATION_GLSL}

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

                float whiteFactor = clamp(core * 0.90, 0.0, 1.0);
                vec3 satColor = boostLaserSaturation(uColor, 1.45);
                vec3 col = mix(satColor, vec3(1.0, 1.0, 1.0), whiteFactor);

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
            ${_COLOR_SATURATION_GLSL}

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

                float whiteFactor = pow(clamp(uImpactPower * 0.15, 0.0, 1.0), 2.5) * exp(-dist * dist * 6.0) * 0.40;
                vec3 satColor = boostLaserSaturation(uColor, 1.45);
                vec3 finalColor = mix(satColor, vec3(1.0, 1.0, 1.0), whiteFactor);

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
            ${_COLOR_SATURATION_GLSL}

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

                float whiteFactor = pow(clamp(uLinePower * 0.15, 0.0, 1.0), 2.5) * exp(-dist * dist * 8.0) * 0.40;
                vec3 satColor = boostLaserSaturation(uColor, 1.45);
                vec3 finalCol = mix(satColor, vec3(1.0, 1.0, 1.0), whiteFactor);

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