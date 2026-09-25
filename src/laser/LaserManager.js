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
import { LaserShow } from './LaserShow.js';
import { DazzleEffect } from './effects/DazzleEffect.js';

// Paramètres globaux post-traitement (partagés entre tous les lasers)
// Valeurs calées sur le projet de référence LaserSimulation
export const globalLaserPostParams = {
    bloomStrength:  0.1,    // bloomIntensity dans LaserSimulation (ref: 0.1)
    bloomRadius:    0.5,    // identique au projet de référence
    bloomThreshold: 0.0,    // seuil 0 = tout brille (ref: 0.0)
    chroma:         0.25,   // aberration chromatique (ref: 0.25)
    antialiasing:   'Aucun', // pas d'AA supplémentaire par défaut (ref: 'Aucun')
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

        // EffectComposer pour le post-processing laser
        this._composer = null;
        this._bloomPass = null;
        this._chromaPass = null;
        this._fxaaPass = null;
        this._useComposer = false; // sera mis à true dès que le composer est prêt

        this._initPostProcessing();
        // Le composer est toujours actif dès l'init (tone mapping, aberration chromatique, OutputPass)
        this._useComposer = !!this._composer;

        // Fog (fumée scénique)
        this._originalFog = scene.fog;
        this._laserFog = null;

        // Éblouissement physiologique (Dazzle) — activé dès l'init
        // Passe `this` comme postProcessing : le DazzleEffect accède à _bloomPass et _chromaPass
        this._dazzle = new DazzleEffect(camera, this, globalLaserPostParams);
    }

    /** Crée et configure l'EffectComposer */
    _initPostProcessing() {
        try {
            this._composer = new EffectComposer(this.renderer);
            this._composer.addPass(new RenderPass(this.scene, this.camera));

            // Bloom
            this._bloomPass = new UnrealBloomPass(
                new THREE.Vector2(window.innerWidth, window.innerHeight),
                globalLaserPostParams.bloomStrength,
                globalLaserPostParams.bloomRadius,
                globalLaserPostParams.bloomThreshold
            );
            this._bloomPass.enabled = false; // désactivé par défaut
            this._composer.addPass(this._bloomPass);

            // Aberration chromatique
            const chromaShader = {
                uniforms: {
                    tDiffuse: { value: null },
                    uChroma:  { value: globalLaserPostParams.chroma },
                    uEnabled: { value: 1.0 }  // activée par défaut (comme le projet de référence)
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
                        gl_FragColor = vec4(r, g, b, 1.0);
                    }
                `
            };
            this._chromaPass = new ShaderPass(chromaShader);
            this._chromaPass.enabled = true;
            this._composer.addPass(this._chromaPass);

            // FXAA
            const pixelRatio = this.renderer.getPixelRatio();
            this._fxaaPass = new ShaderPass(FXAAShader);
            this._fxaaPass.material.uniforms['resolution'].value.x = 1 / (window.innerWidth * pixelRatio);
            this._fxaaPass.material.uniforms['resolution'].value.y = 1 / (window.innerHeight * pixelRatio);
            this._fxaaPass.enabled = (globalLaserPostParams.antialiasing === 'FXAA');
            this._composer.addPass(this._fxaaPass);

            // Output (tone mapping + color space)
            this._composer.addPass(new OutputPass());

        } catch (e) {
            console.warn('[LaserManager] EffectComposer init failed:', e);
            this._composer = null;
        }
    }

    /** Ajoute un nouveau laser dans la scène */
    addLaser(position = new THREE.Vector3(0, 5, 0), paramOverrides = {}) {
        const id = this._nextId++;
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
        return this._lasers.get(id);
    }

    /** Retourne tous les lasers */
    getAllLasers() {
        return Array.from(this._lasers.values());
    }

    /** Retourne le nombre de lasers actifs */
    get count() {
        return this._lasers.size;
    }

    /** Active/désactive le bloom selon la présence de lasers */
    _updateBloomState() {
        if (!this._bloomPass) return;
        const hasLasers = this._lasers.size > 0 && globalLaserPostParams.enabled;
        this._bloomPass.enabled = hasLasers;
        // Le composer est toujours utilisé (comme dans le projet de référence LaserSimulation)
        // — seul le bloom pass est toggle. Cela garantit que l'aberration chromatique
        // et l'OutputPass (tone mapping) s'appliquent en permanence.
        this._useComposer = !!this._composer;
        console.log(`[LaserManager] Bloom ${hasLasers ? 'ON' : 'OFF'}, composer: ${this._useComposer}`);
    }

    /** Mise à jour de tous les lasers — appeler dans la boucle d'animation */
    updateAll(delta, animTime) {
        // 1. Mettre à jour chaque laser (calcule hitPts + effectivePowers)
        for (const laser of this._lasers.values()) {
            laser.update(delta, animTime);
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

    /** Render — utilise toujours l'EffectComposer pour le tone mapping et les passes post-processing */
    render() {
        if (this._useComposer && this._composer) {
            this._composer.render();
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
        if (this._composer) {
            this._composer.setSize(width, height);
            const pixelRatio = this.renderer.getPixelRatio();
            if (this._fxaaPass) {
                this._fxaaPass.material.uniforms['resolution'].value.x = 1 / (width * pixelRatio);
                this._fxaaPass.material.uniforms['resolution'].value.y = 1 / (height * pixelRatio);
            }
            if (this._bloomPass) {
                this._bloomPass.resolution.set(width, height);
            }
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
