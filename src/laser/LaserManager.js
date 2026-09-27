/**
 * LaserManager.js
 * ─────────────────────────────────────────────────────────────
 * Orchestrateur principal du système laser SoundStage3D.
 *
 * - Maintient la liste de tous les lasers posés (Map<id, LaserShow>)
 * - Gère le post-processing (EffectComposer avec Bloom + Aberration)
 * - Route les updates vers tous les lasers actifs
 * - Expose addLaser(), removeLaser(), getLaser(), updateAll()
 * - Gère les réglages globaux (bloom, aberration, fumée/fog)
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LaserShow } from './LaserShow.js?v=28';
import { DazzleEffect } from './effects/DazzleEffect.js';
import { registerPlayerCollider } from './LaserSceneIntersector.js?v=9';

// Layer 1 : Lasers uniquement (Bloom Laser + Aberration Chromatique Laser)
export const BLOOM_LASER_LAYER = 1;

// Layer 2 : Lampes et lumières de scène (Bloom Lampes SANS aberration chromatique)
export const BLOOM_LIGHTS_LAYER = 2;

/**
 * Active le bloom laser et l'aberration chromatique sur un objet laser
 * @param {THREE.Object3D} obj
 */
export function enableLaserBloom(obj) {
    if (!obj) return;
    if (obj.layers) obj.layers.enable(BLOOM_LASER_LAYER);
    if (obj.traverse) {
        obj.traverse(child => {
            if (child.layers) child.layers.enable(BLOOM_LASER_LAYER);
        });
    }
}

export function disableLaserBloom(obj) {
    if (!obj) return;
    if (obj.layers) obj.layers.disable(BLOOM_LASER_LAYER);
    if (obj.traverse) {
        obj.traverse(child => {
            if (child.layers) child.layers.disable(BLOOM_LASER_LAYER);
        });
    }
}

/**
 * Active le bloom sur les lampes et projecteurs de scène (SANS aberration chromatique)
 * @param {THREE.Object3D} obj
 */
export function enableLightsBloom(obj) {
    if (!obj) return;
    if (obj.layers) obj.layers.enable(BLOOM_LIGHTS_LAYER);
    if (obj.traverse) {
        obj.traverse(child => {
            if (child.layers) child.layers.enable(BLOOM_LIGHTS_LAYER);
        });
    }
}

export function disableLightsBloom(obj) {
    if (!obj) return;
    if (obj.layers) obj.layers.disable(BLOOM_LIGHTS_LAYER);
    if (obj.traverse) {
        obj.traverse(child => {
            if (child.layers) child.layers.disable(BLOOM_LIGHTS_LAYER);
        });
    }
}

// Alias de compatibilité pour stage.js et AmbiancePanel.js (qui ciblent les lampes de scène)
export const enableBloom = enableLightsBloom;
export const disableBloom = disableLightsBloom;
export const BLOOM_SCENE_LAYER = BLOOM_LIGHTS_LAYER;

// Paramètres globaux post-traitement avec 2 blooms 100% indépendants
export const globalLaserPostParams = {
    // ── Bloom Laser (Layer 1) ──
    laserBloomEnabled:   true,
    laserBloomStrength:  0.15,
    laserBloomRadius:    0.5,
    laserBloomThreshold: 0.0,
    chroma:              0.25,   // Aberration chromatique : UNIQUEMENT SUR LE LASER
    chromaEnabled:       true,

    // ── Bloom Lampes & Scène (Layer 2 - SANS aberration chromatique) ──
    lightsBloomEnabled:   true,
    lightsBloomStrength:  0.25,
    lightsBloomRadius:    0.4,
    lightsBloomThreshold: 0.05,

    // ── Alias de compatibilité pour DazzleEffect et code existant ──
    get enabled() { return this.laserBloomEnabled; },
    set enabled(v) { this.laserBloomEnabled = Boolean(v); },
    get bloomStrength() { return this.laserBloomStrength; },
    set bloomStrength(v) { this.laserBloomStrength = v; },
    get bloomRadius() { return this.laserBloomRadius; },
    set bloomRadius(v) { this.laserBloomRadius = v; },
    get bloomThreshold() { return this.laserBloomThreshold; },
    set bloomThreshold(v) { this.laserBloomThreshold = v; },

    // ── Général ──
    antialiasing:           'MSAA 4x (Matériel - Recommandé)',
    fogEnabled:             false,
    fogDensity:             0.005,
    fogColor:               '#111122',
    playerCollisionEnabled: true, // Interception laser par le corps 3D des joueurs (désactivable)
};

export class LaserManager {
    /**
     * @param {object} options
     * @param {THREE.Scene} options.scene
     * @param {THREE.WebGLRenderer} options.renderer
     * @param {THREE.Camera} options.camera
     */
    constructor({ scene, renderer, camera }) {
        this.scene    = scene;
        this.renderer = renderer;
        this.camera   = camera;

        this._lasers = new Map();   // Map<id (number), LaserShow>
        this._nextId = 1;

        // EffectComposers pour le post-processing sélectif à double bloom
        this._laserBloomComposer  = null;
        this._lightsBloomComposer = null;
        this._finalComposer       = null;
        this._composer            = null; // alias vers _finalComposer

        // Passes de bloom et effets
        this._laserBloomPass  = null;
        this._laserChromaPass = null;
        this._lightsBloomPass = null;
        this._mixPass         = null;
        this._fxaaPass        = null;
        this._smaaPass        = null;
        this._outputPass      = null;

        // Alias de compatibilité (pour DazzleEffect)
        this._bloomComposer = null;
        this._bloomPass     = null;
        this._chromaPass    = null;

        this._msaaSamples   = 4;
        this._useComposer   = false;
        this._playerCollider = null;

        this._initPostProcessing();
        this._useComposer = !!(this._finalComposer && (this._laserBloomComposer || this._lightsBloomComposer));

        // Préalloué pour éviter new THREE.Color() à chaque frame dans render()
        this._origClearColor = new THREE.Color();

        // Fog (fumée scénique)
        this._originalFog = scene.fog;
        this._laserFog = null;

        // Simulation atmosphérique globale de la fumée (Vent, turbulence, dérive) calculée 1 SEULE FOIS pour tous les lasers
        this._globalSmokeTime  = 0.0;
        this._globalSmokeWind  = new THREE.Vector3();
        this._globalSmokeState = {
            time: 0.0,
            wind: this._globalSmokeWind
        };

        // Éblouissement physiologique (Dazzle) — activé dès l'init
        // Passe `this` comme postProcessing : le DazzleEffect accède à _bloomPass et _chromaPass
        this._dazzle = new DazzleEffect(camera, this, globalLaserPostParams);
    }

    /** Crée et configure le pipeline de post-processing sélectif à double bloom (Laser avec Chroma, Lampes sans Chroma) */
    _initPostProcessing() {
        try {
            // Layer 1 : Lasers uniquement
            this._laserLayer = new THREE.Layers();
            this._laserLayer.set(BLOOM_LASER_LAYER);

            // Layer 2 : Lampes & scène
            this._lightsLayer = new THREE.Layers();
            this._lightsLayer.set(BLOOM_LIGHTS_LAYER);

            this._darkMaterial = new THREE.MeshBasicMaterial({
                color: 0x000000,
                depthWrite: true,
                depthTest: true,
                side: THREE.DoubleSide
            });
            this._materialsMap = new Map();
            this._visibilityMap = new Map();

            // Fonctions de traversée haute performance pour masquer le décor non-lumineux (0 allocation GC)
            this._darkenNonLaser = (obj) => {
                if (this._laserLayer.test(obj.layers) === false) {
                    if (obj.isMesh) {
                        this._materialsMap.set(obj.uuid, obj.material);
                        obj.material = this._darkMaterial;
                    } else if (obj.isLine || obj.isPoints || obj.isSprite) {
                        this._visibilityMap.set(obj.uuid, obj.visible);
                        obj.visible = false;
                    }
                }
            };

            this._darkenNonLights = (obj) => {
                if (this._lightsLayer.test(obj.layers) === false) {
                    if (obj.isMesh) {
                        this._materialsMap.set(obj.uuid, obj.material);
                        obj.material = this._darkMaterial;
                    } else if (obj.isLine || obj.isPoints || obj.isSprite) {
                        this._visibilityMap.set(obj.uuid, obj.visible);
                        obj.visible = false;
                    }
                }
            };

            this._restoreMaterial = (obj) => {
                if (this._materialsMap.has(obj.uuid)) {
                    obj.material = this._materialsMap.get(obj.uuid);
                    this._materialsMap.delete(obj.uuid);
                }
                if (this._visibilityMap.has(obj.uuid)) {
                    obj.visible = this._visibilityMap.get(obj.uuid);
                    this._visibilityMap.delete(obj.uuid);
                }
            };

            // ── 1. Laser Bloom Composer (Rendu isolé des lasers avec Bloom + Aberration Chromatique) ──
            const renderLaserScene = new RenderPass(this.scene, this.camera);
            this._laserBloomComposer = new EffectComposer(this.renderer);
            this._laserBloomComposer.renderToScreen = false;
            this._laserBloomComposer.addPass(renderLaserScene);

            this._laserBloomPass = new UnrealBloomPass(
                new THREE.Vector2(window.innerWidth, window.innerHeight),
                globalLaserPostParams.laserBloomStrength,
                globalLaserPostParams.laserBloomRadius,
                globalLaserPostParams.laserBloomThreshold
            );
            this._laserBloomPass.enabled = globalLaserPostParams.laserBloomEnabled;
            this._laserBloomComposer.addPass(this._laserBloomPass);

            // Aberration chromatique : UNIQUEMENT SUR LE LASER
            const chromaShader = {
                uniforms: {
                    tDiffuse: { value: null },
                    uChroma:  { value: globalLaserPostParams.chroma },
                    uEnabled: { value: globalLaserPostParams.chromaEnabled ? 1.0 : 0.0 }
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform sampler2D tDiffuse;
                    uniform float uChroma;
                    uniform float uEnabled;
                    varying vec2 vUv;
                    void main() {
                        if (uEnabled < 0.5) {
                            gl_FragColor = texture2D(tDiffuse, vUv);
                            return;
                        }
                        vec2 dist = vUv - vec2(0.5);
                        vec2 offset = dist * uChroma * 0.015;
                        float r = texture2D(tDiffuse, vUv + offset).r;
                        float g = texture2D(tDiffuse, vUv).g;
                        float b = texture2D(tDiffuse, vUv - offset).b;
                        float a = texture2D(tDiffuse, vUv).a;
                        gl_FragColor = vec4(r, g, b, a);
                    }
                `
            };
            this._laserChromaPass = new ShaderPass(chromaShader);
            this._laserChromaPass.enabled = true;
            this._laserBloomComposer.addPass(this._laserChromaPass);

            // ── 2. Lights Bloom Composer (Rendu isolé des lampes de scène : Bloom PUR SANS aberration) ──
            const renderLightsScene = new RenderPass(this.scene, this.camera);
            this._lightsBloomComposer = new EffectComposer(this.renderer);
            this._lightsBloomComposer.renderToScreen = false;
            this._lightsBloomComposer.addPass(renderLightsScene);

            this._lightsBloomPass = new UnrealBloomPass(
                new THREE.Vector2(window.innerWidth, window.innerHeight),
                globalLaserPostParams.lightsBloomStrength,
                globalLaserPostParams.lightsBloomRadius,
                globalLaserPostParams.lightsBloomThreshold
            );
            this._lightsBloomPass.enabled = globalLaserPostParams.lightsBloomEnabled;
            this._lightsBloomComposer.addPass(this._lightsBloomPass);

            // Alias de compatibilité pour DazzleEffect
            this._bloomComposer = this._laserBloomComposer;
            this._bloomPass     = this._laserBloomPass;
            this._chromaPass    = this._laserChromaPass;

            // ── 3. Final Composer (Scène complète normale nette + mélange additif des deux blooms) ──
            const renderFinalScene = new RenderPass(this.scene, this.camera);
            const size = this.renderer.getSize(new THREE.Vector2());
            const pixelRatio = this.renderer.getPixelRatio();
            const width = Math.max(1, Math.round(size.width * pixelRatio));
            const height = Math.max(1, Math.round(size.height * pixelRatio));
            const initialSamples = (this._msaaSamples !== undefined) ? this._msaaSamples : 4;

            const finalRT = new THREE.WebGLRenderTarget(width, height, {
                type: THREE.HalfFloatType,
                samples: initialSamples
            });
            this._finalComposer = new EffectComposer(this.renderer, finalRT);
            this._finalComposer.addPass(renderFinalScene);

            // Texture factice noire pour initialiser les slots de sampler2D
            const dummyTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
            dummyTexture.needsUpdate = true;

            // Pass de mixage multi-bloom additif
            const mixShader = {
                uniforms: {
                    baseTexture:         { value: null },
                    laserBloomTexture:   { value: dummyTexture },
                    lightsBloomTexture:  { value: dummyTexture },
                    uLaserBloomEnabled:  { value: globalLaserPostParams.laserBloomEnabled ? 1.0 : 0.0 },
                    uLightsBloomEnabled: { value: globalLaserPostParams.lightsBloomEnabled ? 1.0 : 0.0 }
                },
                vertexShader: `
                    varying vec2 vUv;
                    void main() {
                        vUv = uv;
                        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    }
                `,
                fragmentShader: `
                    uniform sampler2D baseTexture;
                    uniform sampler2D laserBloomTexture;
                    uniform sampler2D lightsBloomTexture;
                    uniform float uLaserBloomEnabled;
                    uniform float uLightsBloomEnabled;
                    varying vec2 vUv;
                    void main() {
                        vec4 base = texture2D(baseTexture, vUv);
                        vec3 col = base.rgb;
                        if (uLaserBloomEnabled > 0.5) {
                            col += texture2D(laserBloomTexture, vUv).rgb;
                        }
                        if (uLightsBloomEnabled > 0.5) {
                            col += texture2D(lightsBloomTexture, vUv).rgb;
                        }
                        gl_FragColor = vec4(col, base.a);
                    }
                `
            };
            this._mixPass = new ShaderPass(
                new THREE.ShaderMaterial({
                    uniforms: mixShader.uniforms,
                    vertexShader: mixShader.vertexShader,
                    fragmentShader: mixShader.fragmentShader,
                    defines: {}
                }),
                'baseTexture'
            );
            this._mixPass.needsSwap = true;
            this._finalComposer.addPass(this._mixPass);

            // SMAA Antialiasing (optionnel sur le composite, subpixel net)
            this._smaaPass = new SMAAPass(width, height);
            this._smaaPass.enabled = false;
            this._finalComposer.addPass(this._smaaPass);

            // FXAA Antialiasing (optionnel sur le composite, rapide)
            this._fxaaPass = new ShaderPass(FXAAShader);
            this._fxaaPass.material.uniforms['resolution'].value.x = 1 / width;
            this._fxaaPass.material.uniforms['resolution'].value.y = 1 / height;
            this._fxaaPass.enabled = false;
            this._finalComposer.addPass(this._fxaaPass);

            // OutputPass (Tone mapping & Color space de Three.js)
            this._outputPass = new OutputPass();
            this._finalComposer.addPass(this._outputPass);

            this._composer = this._finalComposer;

        } catch (e) {
            console.warn('[LaserManager] EffectComposer init failed:', e);
            this._laserBloomComposer  = null;
            this._lightsBloomComposer = null;
            this._bloomComposer       = null;
            this._finalComposer       = null;
            this._composer            = null;
        }
    }

    /** Ajoute un nouveau laser dans la scène */
    addLaser(position = new THREE.Vector3(0, 12, -4), paramOverrides = {}, customId = null) {
        const id = (customId !== null && customId !== undefined) ? customId : this._nextId++;
        if (this._nextId <= id) this._nextId = id + 1;
        const laserShow = new LaserShow(this.scene, position.clone(), paramOverrides);
        laserShow.laserId = id;
        this._lasers.set(id, laserShow);

        // Activer le bloom dès qu'il y a au moins un laser
        this._updateBloomState();

        console.log(`[LaserManager] Laser #${id} ajouté à`, position);
        return { id, laserShow };
    }

    /** Supprime un laser de la scène */
    removeLaser(id) {
        const laser = this._lasers.get(id);
        if (!laser) return;
        laser.dispose();
        this._lasers.delete(id);
        this._updateBloomState();
        console.log(`[LaserManager] Laser #${id} supprimé`);
    }

    /** Retourne un laser par son id */
    getLaser(id) {
        const numId = typeof id === 'number' ? id : parseInt(id, 10);
        return this._lasers.get(numId) || this._lasers.get(id);
    }

    /** Retourne tous les lasers */
    getAllLasers() {
        return Array.from(this._lasers.values());
    }

    /** Retourne le nombre de lasers actifs */
    get count() {
        return this._lasers.size;
    }

    /** Active/désactive le bloom selon la configuration */
    _updateBloomState() {
        if (this._laserBloomPass) {
            this._laserBloomPass.enabled = Boolean(globalLaserPostParams.laserBloomEnabled);
        }
        if (this._lightsBloomPass) {
            this._lightsBloomPass.enabled = Boolean(globalLaserPostParams.lightsBloomEnabled);
        }
        if (this._mixPass) {
            this._mixPass.material.uniforms.uLaserBloomEnabled.value = globalLaserPostParams.laserBloomEnabled ? 1.0 : 0.0;
            this._mixPass.material.uniforms.uLightsBloomEnabled.value = globalLaserPostParams.lightsBloomEnabled ? 1.0 : 0.0;
        }
        this._useComposer = Boolean(this._finalComposer);
    }

    /**
     * Simulation physique du vent et des volutes de fumée atmosphérique.
     * Calculée UNE SEULE FOIS par frame au niveau global (optimisation CPU majeure) :
     * tous les plans de lasers découpent le même champ de fumée en mouvement.
     */
    _updateGlobalSmoke(delta) {
        let p = null;
        for (const laser of this._lasers.values()) {
            if (laser && laser.params) {
                p = laser.params;
                break;
            }
        }

        const smokeSpeed = p && p.panSmokeSpeed !== undefined ? p.panSmokeSpeed : 0.30;
        const windChange = p && p.panSmokeWindChange !== undefined ? p.panSmokeWindChange : 1.0;
        const speedVar   = p && p.panSmokeSpeedVariation !== undefined ? p.panSmokeSpeedVariation : 1.0;

        const dt = (delta > 0 && delta < 0.5) ? delta : 0.016;
        this._globalSmokeTime += dt;
        this._globalSmokeState.time = this._globalSmokeTime;
        this._globalSmokeState.laserCount = this._lasers.size;

        // Calcul physique unique des rafales et de la dérive du vent
        const gustPhase = this._globalSmokeTime * 0.25;
        const gustWave  = Math.sin(gustPhase) * 0.62 + Math.sin(gustPhase * 0.47 + 1.3) * 0.38;
        const effectiveTime = (this._globalSmokeTime + gustWave * (speedVar * 2.5)) * smokeSpeed;

        const windRate   = 0.06 * (1.0 + windChange * 0.45);
        const slowT      = effectiveTime * windRate;
        const meanderAmp = 1.0 + windChange * 1.8;

        const mx = (Math.sin(slowT * 0.72) * 4.2 + Math.sin(slowT * 0.26 + 0.8) * 2.8) * meanderAmp;
        const my = (Math.sin(slowT * 0.40 + 1.2) * 1.8 + Math.cos(slowT * 0.18) * 1.0) * meanderAmp;
        const mz = (Math.cos(slowT * 0.58) * 3.8 + Math.cos(slowT * 0.31 + 2.1) * 2.5) * meanderAmp;

        const lx = effectiveTime * 0.18;
        const ly = effectiveTime * 0.04;
        const lz = effectiveTime * 0.13;

        const meanderWeight = Math.min(1.0, Math.max(0.0, windChange / 1.2));
        const wx = mx * meanderWeight + lx * (1.0 - meanderWeight) + lx;
        const wy = my * meanderWeight + ly * (1.0 - meanderWeight) + ly;
        const wz = mz * meanderWeight + lz * (1.0 - meanderWeight) + lz;

        this._globalSmokeWind.set(wx, wy, wz);
    }

    /** Mise à jour de tous les lasers — appeler dans la boucle d'animation */
    updateAll(delta, animTime) {
        // 0. Calculer le vent et la turbulence globale 1 seule fois pour tout le monde (optimisation CPU)
        this._updateGlobalSmoke(delta);

        // 1. Mettre à jour chaque laser (partage du champ atmosphérique global)
        const camPos = this.camera ? this.camera.position : null;
        for (const laser of this._lasers.values()) {
            laser.update(delta, animTime, camPos, this._globalSmokeState);
        }

        // 2. Éblouissement physiologique — collecte les données de chaque laser
        if (this._dazzle) {
            const laserData = [];
            for (const laser of this._lasers.values()) {
                laserData.push({
                    pod:               laser.pod,
                    hitPts:            laser._podHitPts,
                    params:            laser.params,
                    effectiveBeamPower: laser._effectiveBeamPower || 0,
                    effectivePanPower:  laser._effectivePanPower  || 0,
                });
            }
            this._dazzle.update(delta, laserData);
        }
    }

    /**
     * Rendu sélectif à double bloom :
     * - Bloom Laser avec aberration chromatique (layer 1)
     * - Bloom Lampes & Scène SANS aberration chromatique (layer 2)
     * - Les obstacles du décor masquent naturellement les sources lumineuses via le depth buffer
     * - Mélange additif dans la scène nette finale avec MSAA matériel
     */
    render() {
        if (this._useComposer && this._finalComposer) {
            const renderLaser = Boolean(globalLaserPostParams.laserBloomEnabled && this._laserBloomComposer);
            const renderLights = Boolean(globalLaserPostParams.lightsBloomEnabled && this._lightsBloomComposer);

            let origBg = null;
            let origFog = null;
            let origClearAlpha = 1;

            if (renderLaser || renderLights) {
                // 1. Sauvegarder fond, fog et clear color
                origBg  = this.scene.background;
                origFog = this.scene.fog;
                this.scene.background = null;
                this.scene.fog = null;

                this.renderer.getClearColor(this._origClearColor);
                origClearAlpha = this.renderer.getClearAlpha();
                this.renderer.setClearColor(0x000000, 0);
            }

            // 2. Bloom Laser (Layer 1) avec aberration chromatique
            if (renderLaser) {
                this.scene.traverse(this._darkenNonLaser);
                this._laserBloomComposer.render();
                this.scene.traverse(this._restoreMaterial);
                this._mixPass.material.uniforms.laserBloomTexture.value = this._laserBloomComposer.readBuffer.texture;
                this._mixPass.material.uniforms.uLaserBloomEnabled.value = 1.0;
            } else {
                this._mixPass.material.uniforms.uLaserBloomEnabled.value = 0.0;
            }

            // 3. Bloom Lampes & Scène (Layer 2) pur, sans aberration chromatique
            if (renderLights) {
                this.scene.traverse(this._darkenNonLights);
                this._lightsBloomComposer.render();
                this.scene.traverse(this._restoreMaterial);
                this._mixPass.material.uniforms.lightsBloomTexture.value = this._lightsBloomComposer.readBuffer.texture;
                this._mixPass.material.uniforms.uLightsBloomEnabled.value = 1.0;
            } else {
                this._mixPass.material.uniforms.uLightsBloomEnabled.value = 0.0;
            }

            if (renderLaser || renderLights) {
                // 4. Restaurer le fond, le fog et le clear color pour le rendu de la scène normale
                this.scene.background = origBg;
                this.scene.fog = origFog;
                this.renderer.setClearColor(this._origClearColor, origClearAlpha);
            }

            // 5. Rendu final de la scène normale + mixage additif des deux blooms + OutputPass
            this._finalComposer.render();
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }

    /** Applique les réglages globaux post-processing */
    setPostProcessingParam(key, value) {
        globalLaserPostParams[key] = value;

        switch (key) {
            // ── Bloom Laser ──
            case 'laserBloomStrength':
            case 'bloomStrength':
                globalLaserPostParams.laserBloomStrength = value;
                if (this._laserBloomPass) this._laserBloomPass.strength = value;
                break;
            case 'laserBloomRadius':
            case 'bloomRadius':
                globalLaserPostParams.laserBloomRadius = value;
                if (this._laserBloomPass) this._laserBloomPass.radius = value;
                break;
            case 'laserBloomThreshold':
            case 'bloomThreshold':
                globalLaserPostParams.laserBloomThreshold = value;
                if (this._laserBloomPass) this._laserBloomPass.threshold = value;
                break;
            case 'laserBloomEnabled':
            case 'enabled':
                globalLaserPostParams.laserBloomEnabled = Boolean(value);
                this._updateBloomState();
                break;

            // ── Aberration chromatique (Laser uniquement) ──
            case 'chroma':
                if (this._laserChromaPass) this._laserChromaPass.uniforms.uChroma.value = value;
                break;
            case 'chromaEnabled':
                if (this._laserChromaPass) this._laserChromaPass.uniforms.uEnabled.value = value ? 1.0 : 0.0;
                break;

            // ── Bloom Lampes & Scène ──
            case 'lightsBloomStrength':
                if (this._lightsBloomPass) this._lightsBloomPass.strength = value;
                break;
            case 'lightsBloomRadius':
                if (this._lightsBloomPass) this._lightsBloomPass.radius = value;
                break;
            case 'lightsBloomThreshold':
                if (this._lightsBloomPass) this._lightsBloomPass.threshold = value;
                break;
            case 'lightsBloomEnabled':
                this._updateBloomState();
                break;

            // ── Général ──
            case 'antialiasing':
                this.setAntialiasing(value);
                break;
            case 'fogEnabled':
                this._applyFog(value, globalLaserPostParams.fogDensity, globalLaserPostParams.fogColor);
                break;
            case 'fogDensity':
                if (this._laserFog) this._laserFog.density = value;
                break;
            case 'fogColor':
                if (this._laserFog) this._laserFog.color.set(value);
                break;
            case 'playerCollisionEnabled':
                globalLaserPostParams.playerCollisionEnabled = Boolean(value);
                if (this._playerCollider) {
                    this._playerCollider.enabled = Boolean(value);
                }
                break;
        }
    }

    /**
     * Enregistre le collider des joueurs pour activer/désactiver les calculs de collision
     */
    setPlayerCollider(collider) {
        this._playerCollider = collider;
        registerPlayerCollider(collider);
        if (collider) {
            collider.enabled = globalLaserPostParams.playerCollisionEnabled !== false;
        }
    }

    /**
     * Règle le mode d'antialiasing :
     * - 'MSAA 4x (Matériel - Recommandé)'
     * - 'MSAA 8x (Matériel - Haute qualité)'
     * - 'SMAA (Post-process net)'
     * - 'FXAA (Post-process rapide)'
     * - 'MSAA 4x + FXAA (Double lissage)'
     * - 'Aucun (Désactivé)'
     */
    setAntialiasing(mode) {
        if (!mode) return;
        globalLaserPostParams.antialiasing = mode;

        let samples = 0;
        let enableFxaa = false;
        let enableSmaa = false;

        if (mode.includes('8x')) {
            samples = 8;
        } else if (mode.includes('MSAA 4x + FXAA')) {
            samples = 4;
            enableFxaa = true;
        } else if (mode.includes('MSAA')) {
            samples = 4;
        } else if (mode.includes('SMAA')) {
            enableSmaa = true;
        } else if (mode.includes('FXAA')) {
            enableFxaa = true;
        } else {
            samples = 0;
        }

        this._msaaSamples = samples;
        if (this._fxaaPass) this._fxaaPass.enabled = enableFxaa;
        if (this._smaaPass) this._smaaPass.enabled = enableSmaa;

        if (this._finalComposer && this._finalComposer.renderTarget1) {
            if (this._finalComposer.renderTarget1.samples !== samples) {
                this._finalComposer.renderTarget1.samples = samples;
                this._finalComposer.renderTarget2.samples = samples;
                this._finalComposer.renderTarget1.dispose();
                this._finalComposer.renderTarget2.dispose();
            }
        }
    }

    /** Applique/retire le fog scénique */
    _applyFog(enabled, density, color) {
        if (enabled) {
            if (!this._laserFog) {
                this._laserFog = new THREE.FogExp2(color, density);
            }
            this.scene.fog = this._laserFog;
        } else {
            this.scene.fog = this._originalFog;
        }
    }

    /** Redimensionnement de la fenêtre */
    resize(width, height) {
        if (this._laserBloomComposer) this._laserBloomComposer.setSize(width, height);
        if (this._lightsBloomComposer) this._lightsBloomComposer.setSize(width, height);
        if (this._finalComposer) this._finalComposer.setSize(width, height);
        if (this._laserBloomPass) this._laserBloomPass.setSize(width, height);
        if (this._lightsBloomPass) this._lightsBloomPass.setSize(width, height);
        const pixelRatio = this.renderer.getPixelRatio();
        const renderW = Math.max(1, Math.round(width * pixelRatio));
        const renderH = Math.max(1, Math.round(height * pixelRatio));
        if (this._fxaaPass) {
            this._fxaaPass.material.uniforms['resolution'].value.x = 1 / renderW;
            this._fxaaPass.material.uniforms['resolution'].value.y = 1 / renderH;
        }
        if (this._smaaPass) {
            this._smaaPass.setSize(renderW, renderH);
        }
    }

    /** Retourne tous les groupes 3D des lasers (pour le raycasting) */
    getLaserObjects() {
        const objects = [];
        for (const laser of this._lasers.values()) {
            const housing = laser.getHousingGroup();
            if (housing) objects.push(housing);
        }
        return objects;
    }

    /** Retrouve le LaserShow à partir d'un Object3D (pour le clic 3D) */
    getLaserFromObject(obj) {
        for (const laser of this._lasers.values()) {
            const housing = laser.getHousingGroup();
            if (housing && (obj === housing || obj.isDescendantOf?.(housing) || this._isChildOf(obj, housing))) {
                return laser;
            }
        }
        return null;
    }

    _isChildOf(obj, parent) {
        let cur = obj.parent;
        while (cur) {
            if (cur === parent) return true;
            cur = cur.parent;
        }
        return false;
    }
}
