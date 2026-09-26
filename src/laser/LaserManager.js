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
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LaserShow } from './LaserShow.js?v=5';
import { DazzleEffect } from './effects/DazzleEffect.js';

// Layer réservé au bloom et à l'aberration chromatique sélective (lasers et lumières)
export const BLOOM_SCENE_LAYER = 1;

/**
 * Active le bloom et l'aberration chromatique sélective sur un objet 3D ou une hiérarchie
 * @param {THREE.Object3D} obj
 */
export function enableBloom(obj) {
    if (!obj) return;
    if (obj.layers) obj.layers.enable(BLOOM_SCENE_LAYER);
    if (obj.traverse) {
        obj.traverse(child => {
            if (child.layers) child.layers.enable(BLOOM_SCENE_LAYER);
        });
    }
}

/**
 * Désactive le bloom et l'aberration chromatique sur un objet 3D ou une hiérarchie
 * @param {THREE.Object3D} obj
 */
export function disableBloom(obj) {
    if (!obj) return;
    if (obj.layers) obj.layers.disable(BLOOM_SCENE_LAYER);
    if (obj.traverse) {
        obj.traverse(child => {
            if (child.layers) child.layers.disable(BLOOM_SCENE_LAYER);
        });
    }
}

// Paramètres globaux post-traitement (partagés entre tous les lasers et lumières)
// Valeurs calées sur le projet de référence LaserSimulation
export const globalLaserPostParams = {
    bloomStrength:  0.15,   // Intensité bloom pour lasers & lumières (ref: 0.1 - 0.15)
    bloomRadius:    0.5,    // Rayon de diffusion
    bloomThreshold: 0.0,    // Seuil 0 = émission pure isolée
    chroma:         0.25,   // Aberration chromatique (ref: 0.25)
    antialiasing:   'Aucun', // Pas d'AA supplémentaire par défaut
    fogEnabled:     false,
    fogDensity:     0.005,
    fogColor:       '#111122',
    enabled:        true,
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

        // EffectComposers pour le post-processing sélectif
        this._bloomComposer = null;
        this._finalComposer = null;
        this._composer      = null; // alias vers _finalComposer
        this._bloomPass     = null;
        this._chromaPass    = null;
        this._mixPass       = null;
        this._fxaaPass      = null;
        this._outputPass    = null;
        this._useComposer   = false;

        this._initPostProcessing();
        this._useComposer = !!(this._finalComposer && this._bloomComposer);

        // Préalloué pour éviter new THREE.Color() à chaque frame dans render()
        this._origClearColor = new THREE.Color();

        // Fog (fumée scénique)
        this._originalFog = scene.fog;
        this._laserFog = null;

        // Éblouissement physiologique (Dazzle) — activé dès l'init
        // Passe `this` comme postProcessing : le DazzleEffect accède à _bloomPass et _chromaPass
        this._dazzle = new DazzleEffect(camera, this, globalLaserPostParams);
    }

    /** Crée et configure le pipeline de post-processing sélectif (Bloom + Chroma uniquement sur le layer 1) */
    _initPostProcessing() {
        try {
            // Layer 1 réservé au bloom et à l'aberration chromatique sélective
            this._bloomLayer = new THREE.Layers();
            this._bloomLayer.set(BLOOM_SCENE_LAYER);

            this._darkMaterial = new THREE.MeshBasicMaterial({
                color: 0x000000,
                depthWrite: true,
                depthTest: true,
                side: THREE.DoubleSide
            });
            this._materialsMap = new Map();
            this._visibilityMap = new Map();

            // Fonctions de traversée haute performance pour masquer le décor non-lumineux (0 allocation GC)
            this._darkenNonBloomed = (obj) => {
                if (this._bloomLayer.test(obj.layers) === false) {
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

            const renderScene = new RenderPass(this.scene, this.camera);

            // ── 1. Bloom Composer (Rendu isolé des lasers et lumières pour calcul du glow + chroma) ──
            this._bloomRenderPass = renderScene;
            this._bloomComposer = new EffectComposer(this.renderer);
            this._bloomComposer.renderToScreen = false;
            this._bloomComposer.addPass(renderScene);

            // Bloom
            this._bloomPass = new UnrealBloomPass(
                new THREE.Vector2(window.innerWidth, window.innerHeight),
                globalLaserPostParams.bloomStrength,
                globalLaserPostParams.bloomRadius,
                globalLaserPostParams.bloomThreshold
            );
            this._bloomPass.enabled = globalLaserPostParams.enabled;
            this._bloomComposer.addPass(this._bloomPass);

            // Aberration chromatique (appliquée spécifiquement sur le halo lumineux)
            const chromaShader = {
                uniforms: {
                    tDiffuse: { value: null },
                    uChroma:  { value: globalLaserPostParams.chroma },
                    uEnabled: { value: 1.0 }
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
            this._chromaPass = new ShaderPass(chromaShader);
            this._chromaPass.enabled = true;
            this._bloomComposer.addPass(this._chromaPass);

            // ── 2. Final Composer (Scène complète normale nette + mélange additif du calque bloom/chroma) ──
            const renderFinalScene = new RenderPass(this.scene, this.camera);
            this._finalComposer = new EffectComposer(this.renderer);
            this._finalComposer.addPass(renderFinalScene);

            // Pass de mixage additif
            const mixShader = {
                uniforms: {
                    baseTexture:  { value: null },
                    bloomTexture: { value: null }
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
                    uniform sampler2D bloomTexture;
                    varying vec2 vUv;
                    void main() {
                        vec4 base = texture2D(baseTexture, vUv);
                        vec4 bloom = texture2D(bloomTexture, vUv);
                        gl_FragColor = vec4(base.rgb + bloom.rgb, base.a);
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

            // FXAA Antialiasing (optionnel sur le composite)
            const pixelRatio = this.renderer.getPixelRatio();
            this._fxaaPass = new ShaderPass(FXAAShader);
            this._fxaaPass.material.uniforms['resolution'].value.x = 1 / (window.innerWidth * pixelRatio);
            this._fxaaPass.material.uniforms['resolution'].value.y = 1 / (window.innerHeight * pixelRatio);
            this._fxaaPass.enabled = (globalLaserPostParams.antialiasing === 'FXAA');
            this._finalComposer.addPass(this._fxaaPass);

            // OutputPass (Tone mapping & Color space de Three.js)
            this._outputPass = new OutputPass();
            this._finalComposer.addPass(this._outputPass);

            this._composer = this._finalComposer;

        } catch (e) {
            console.warn('[LaserManager] EffectComposer init failed:', e);
            this._bloomComposer = null;
            this._finalComposer = null;
            this._composer = null;
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
        if (!this._bloomPass) return;
        const isEnabled = Boolean(globalLaserPostParams.enabled);
        this._bloomPass.enabled = isEnabled;
        this._useComposer = !!(this._finalComposer && this._bloomComposer);
        console.log(`[LaserManager] Bloom sélectif ${isEnabled ? 'ON' : 'OFF'}, composer: ${this._useComposer}`);
    }

    /** Mise à jour de tous les lasers — appeler dans la boucle d'animation */
    updateAll(delta, animTime) {
        // 1. Mettre à jour chaque laser (calcule hitPts + effectivePowers)
        const camPos = this.camera ? this.camera.position : null;
        for (const laser of this._lasers.values()) {
            laser.update(delta, animTime, camPos);
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
     * Rendu sélectif :
     * - Bloom et aberration chromatique appliqués UNIQUEMENT sur les objets du layer BLOOM_SCENE_LAYER (lasers et lumières).
     * - Les obstacles du décor (scène, sol, piliers) masquent les lasers de manière naturelle via le depth buffer sans artefacts.
     * - Les deux faces du plan laser (fanMesh) sont rendues de façon parfaitement identique et symétrique.
     */
    render() {
        if (this._useComposer && this._finalComposer && this._bloomComposer) {
            // 1. Sauvegarder fond, fog et clear color
            const origBg  = this.scene.background;
            const origFog = this.scene.fog;
            this.scene.background = null;
            this.scene.fog = null;

            this.renderer.getClearColor(this._origClearColor);
            const origClearAlpha = this.renderer.getClearAlpha();
            this.renderer.setClearColor(0x000000, 0);

            // 2. Assombrir les objets hors layer bloom pour masquer le décor tout en gardant l'occlusion de profondeur
            this.scene.traverse(this._darkenNonBloomed);

            // 3. Calculer le bloom et l'aberration chromatique uniquement sur les lasers & lumières visibles
            this._bloomComposer.render();

            // 4. Restaurer les matériaux d'origine
            this.scene.traverse(this._restoreMaterial);

            // 5. Restaurer le fond, le fog et le clear color
            this.scene.background = origBg;
            this.scene.fog = origFog;
            this.renderer.setClearColor(this._origClearColor, origClearAlpha);

            // 6. Connecter la texture bloom calculée au pass de mixage
            this._mixPass.material.uniforms.bloomTexture.value = this._bloomComposer.readBuffer.texture;

            // 7. Rendu final de la scène normale + bloom additif + tone mapping
            this._finalComposer.render();
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }

    /** Applique les réglages globaux post-processing */
    setPostProcessingParam(key, value) {
        globalLaserPostParams[key] = value;

        switch (key) {
            case 'bloomStrength':
                if (this._bloomPass) this._bloomPass.strength = value;
                break;
            case 'bloomRadius':
                if (this._bloomPass) this._bloomPass.radius = value;
                break;
            case 'bloomThreshold':
                if (this._bloomPass) this._bloomPass.threshold = value;
                break;
            case 'chroma':
                if (this._chromaPass) this._chromaPass.uniforms.uChroma.value = value;
                break;
            case 'chromaEnabled':
                if (this._chromaPass) this._chromaPass.uniforms.uEnabled.value = value ? 1.0 : 0.0;
                break;
            case 'antialiasing':
                if (this._fxaaPass) this._fxaaPass.enabled = (value === 'FXAA');
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
            case 'enabled':
                this._updateBloomState();
                break;
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
        if (this._bloomComposer) this._bloomComposer.setSize(width, height);
        if (this._finalComposer) this._finalComposer.setSize(width, height);
        if (this._bloomPass) this._bloomPass.setSize(width, height);
        if (this._fxaaPass) {
            const pixelRatio = this.renderer.getPixelRatio();
            this._fxaaPass.material.uniforms['resolution'].value.x = 1 / (width * pixelRatio);
            this._fxaaPass.material.uniforms['resolution'].value.y = 1 / (height * pixelRatio);
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
