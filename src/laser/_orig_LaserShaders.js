/**
 * LaserShaders.js
 * ─────────────────────────────────────────────────────────────
 * Matériaux GLSL personnalisés Three.js (ShaderMaterial) pour le laser :
 * 1. laserShaderMaterial     — faisceau cylindrique avec divergence physique
 * 2. fanShaderMaterial       — plan PAN volumétrique (dégradé fluide)
 * 3. podGlowMaterial         — éclat sphérique dispersif à la source
 * 4. impactShaderMaterial    — halo circulaire au point d'impact de chaque trait
 * 5. panImpactShaderMaterial — ligne lumineuse continue d'impact du plan
 * ─────────────────────────────────────────────────────────────
 */

import { BEAM_DIVERGENCE } from '../config/constants.js';
import { params } from '../config/params.js';

// ── 1. Faisceaux Laser (Cylindres caméra-alignés avec divergence) ───
export const laserShaderMaterial = new THREE.ShaderMaterial({
    uniforms: {
        uColor:            { value: new THREE.Color(params.color) },
        uBeamWidth:        { value: params.beamWidth },
        uBeamDivergence:   { value: BEAM_DIVERGENCE },
        uBeamPower:        { value: params.beamPower },
        uSourceGlowPower:  { value: 1.0 },
        uGlowIntensity:    { value: params.glowIntensity },
        uGlowScattering:   { value: params.glowScattering },
        uGlowFalloff:      { value: params.glowFalloff },
        uFogDensity:       { value: params.fogDensity },
        uFogGlowCoupling:  { value: params.fogGlowCoupling }
    },
    vertexShader: `
        attribute vec3 aHitPoint;
        attribute vec3 aOrigin;
        attribute float aSide;

        uniform float uBeamWidth;
        uniform float uBeamDivergence;
        varying vec2 vUv;

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
            float divergenceFactor = 1.0 + (currentDist * 0.008) * uBeamDivergence;
            float baseWidth = (0.012 + 0.016 * uBeamWidth);
            float width = baseWidth * divergenceFactor;
            vec3 finalViewPos = vPos + vSide * aSide * width;

            gl_Position = projectionMatrix * vec4(finalViewPos, 1.0);
        }
    `,
    fragmentShader: `
        uniform vec3 uColor;
        uniform float uBeamPower;
        uniform float uBeamWidth;
        uniform float uSourceGlowPower;
        uniform float uGlowIntensity;
        uniform float uGlowScattering;
        uniform float uGlowFalloff;
        uniform float uFogDensity;
        uniform float uFogGlowCoupling;
        varying vec2 vUv;

        void main() {
            if (uBeamPower <= 0.001 || uBeamWidth <= 0.001) discard;

            float distFromCenter = abs(vUv.x - 0.5) * 2.0;
            float baseAlpha = (1.0 - distFromCenter);

            float fogScatter = uFogDensity * 45.0 * uFogGlowCoupling * uGlowScattering;
            float halo = pow(1.0 - distFromCenter, max(0.2, uGlowFalloff)) * (uGlowIntensity * 0.4 + fogScatter);

            float originGlow = exp(-vUv.y * 4.2) * uSourceGlowPower * 1.35;

            vec3 col = mix(uColor, vec3(1.0, 1.0, 1.0), clamp(originGlow * 0.95 + halo * 0.15, 0.0, 1.0));
            float alpha = clamp((baseAlpha + halo * 0.85 + originGlow * 0.75), 0.0, 1.0) * uBeamPower;

            gl_FragColor = vec4(col, alpha);
        }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
});

// ── 2. Plan Laser PAN (Volumétrique en nappe) ───────────────────────
export const fanShaderMaterial = new THREE.ShaderMaterial({
    uniforms: {
        uColor:            { value: new THREE.Color(params.color) },
        uPanPower:         { value: params.panPower },
        uBeamPower:        { value: params.beamPower },
        uBeamWidth:        { value: params.beamWidth },
        uSourceGlowPower:  { value: 1.0 },
        uGlowIntensity:    { value: params.glowIntensity },
        uFogDensity:       { value: params.fogDensity },
        uFogGlowCoupling:  { value: params.fogGlowCoupling }
    },
    vertexShader: `
        attribute float aDistRatio;
        attribute float aLateral;

        varying float vDistRatio;
        varying float vLateral;

        void main() {
            vDistRatio = aDistRatio;
            vLateral = aLateral;
            gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform vec3 uColor;
        uniform float uPanPower;
        uniform float uBeamPower;
        uniform float uBeamWidth;
        uniform float uSourceGlowPower;
        uniform float uGlowIntensity;
        uniform float uFogDensity;
        uniform float uFogGlowCoupling;

        varying float vDistRatio;
        varying float vLateral;

        void main() {
            if (uPanPower <= 0.001) discard;

            // Dégradé longitudinal fluide et progressif de la source jusqu'aux murs d'impact
            float distanceFalloff = mix(1.0, 0.22, smoothstep(0.0, 1.0, clamp(vDistRatio, 0.0, 1.0)));
            float originGlow = exp(-vDistRatio * 10.0) * uSourceGlowPower;

            // Les traits physiques sont déjà dessinés par beamGeo : on évite un hotspot excessif
            float effectiveBeamEdge = uBeamPower * clamp(uBeamWidth, 0.0, 1.0);
            float dEdge = min(vLateral, 1.0 - vLateral) * 2.0;
            float edgeHotspot = exp(-dEdge * 10.0) * 0.25 * effectiveBeamEdge;

            float fogPanScatter = uFogDensity * 30.0 * uFogGlowCoupling * uGlowIntensity;
            float lateralProfile = 1.0 + edgeHotspot + fogPanScatter * (1.0 - dEdge * 0.35);

            float sheetAlpha = 0.32 * distanceFalloff * lateralProfile;
            
            float whiteCore = clamp(edgeHotspot * 0.2, 0.0, 1.0);
            vec3 col = mix(uColor, vec3(1.0, 1.0, 1.0), clamp(originGlow * 0.75 + whiteCore, 0.0, 1.0));

            float alpha = clamp(sheetAlpha + originGlow * 0.4, 0.0, 1.0) * uPanPower;

            gl_FragColor = vec4(col, alpha);
        }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide
});

// ── 3. Éclat Sphérique à la Source (Pod) ────────────────────────────
export const podGlowMaterial = new THREE.ShaderMaterial({
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

export const podGlowGeo = new THREE.PlaneGeometry(1.8, 1.8);

// ── 4. Halo d'Impact Ponctuel (Faisceau individuel) ─────────────────
export const impactShaderMaterial = new THREE.ShaderMaterial({
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

// ── 5. Halo d'Impact de Ligne Continue (Plan PAN) ───────────────────
export const panImpactShaderMaterial = new THREE.ShaderMaterial({
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

/** Met à jour la couleur uniforme de tous les shaders laser */
export function setShadersColor(colorHex) {
    const c = new THREE.Color(colorHex);
    laserShaderMaterial.uniforms.uColor.value.copy(c);
    fanShaderMaterial.uniforms.uColor.value.copy(c);
    podGlowMaterial.uniforms.uColor.value.copy(c);
    impactShaderMaterial.uniforms.uColor.value.copy(c);
    panImpactShaderMaterial.uniforms.uColor.value.copy(c);
}
