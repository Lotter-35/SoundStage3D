/**
 * LaserManager.js
 * ─────────────────────────────────────────────────────────────
 * Orchestrateur principal du système laser SoundStage3D.
 *
 * - Maintient la liste de tous les lasers posés (Map<id, LaserShow>)
 * - Rendu BATCHÉ de tous les lasers (LaserBatch : 5 draw calls au total,
 *   boîtiers instanciés, pool fixe de lumières agrégées)
 * - Gère le post-processing (EffectComposer avec Bloom + Aberration)
 * - Route les updates vers tous les lasers actifs
 * - Expose addLaser(), removeLaser(), getLaser(), updateAll()
 * - Gère les réglages globaux (bloom, aberration, fumée/fog)
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { LaserShow } from './LaserShow.js?v=29';
import { LaserBatch } from './LaserBatch.js';
import { LaserFanPass } from './LaserFanPass.js';
import { FinalCompositePass } from './FinalCompositePass.js';
import { flushHousings } from './LaserPodHousing.js?v=3';
import { DazzleEffect } from './effects/DazzleEffect.js';
import { registerPlayerCollider } from './LaserSceneIntersector.js?v=9';
import { setLaserDisplayRange } from './LaserShaders.js';

// Layer 1 : Lasers uniquement (Bloom Laser + Aberration Chromatique Laser)
export const BLOOM_LASER_LAYER = 1;

// Layer 2 : Lampes et lumières de scène (Bloom Lampes SANS aberration chromatique)
export const BLOOM_LIGHTS_LAYER = 2;

// Registre des objets émissifs par layer de bloom. Stocké sur globalThis : ce module est
// importé avec plusieurs suffixes ?v= (donc évalué plusieurs fois) et le registre doit être unique.
// Il permet aux passes de bloom de masquer ces objets pendant le rendu des occulteurs
// sans parcourir toute la scène à chaque frame.
const _bloomRegistry = globalThis.__ss3dBloomRegistry || (globalThis.__ss3dBloomRegistry = {
    [BLOOM_LASER_LAYER]: new Set(),
    [BLOOM_LIGHTS_LAYER]: new Set()
});

function setBloomLayer(obj, layer, enabled) {
    if (!obj) return;
    const apply = (o) => {
        if (!o.layers) return;
        if (enabled) {
            o.layers.enable(layer);
            _bloomRegistry[layer].add(o);
        } else {
            o.layers.disable(layer);
            _bloomRegistry[layer].delete(o);
        }
    };
    if (obj.traverse) obj.traverse(apply);
    else apply(obj);
}

/** true si au moins un objet enregistré sur ce layer de bloom est visible (hiérarchie comprise) */
function layerHasVisibleObject(layer) {
    for (const obj of _bloomRegistry[layer]) {
        if (!obj.layers.isEnabled(layer)) continue;
        // Mesh instancié sans aucune instance (ex. boîtiers de lyres quand il n'y a plus de lyre) :
        // rien n'est dessiné, il ne doit pas déclencher toute la passe de bloom
        if (obj.isInstancedMesh && obj.count === 0) continue;
        if (obj.geometry && obj.geometry.isInstancedBufferGeometry && obj.geometry.instanceCount === 0) continue;
        let o = obj;
        while (o && o.visible) {
            if (o.parent === null) {
                if (o.isScene) return true;
                break;
            }
            o = o.parent;
        }
    }
    return false;
}

/**
 * Active le bloom laser et l'aberration chromatique sur un objet laser
 * @param {THREE.Object3D} obj
 */
export function enableLaserBloom(obj) {
    setBloomLayer(obj, BLOOM_LASER_LAYER, true);
}

export function disableLaserBloom(obj) {
    setBloomLayer(obj, BLOOM_LASER_LAYER, false);
}

/**
 * Active le bloom sur les lampes et projecteurs de scène (SANS aberration chromatique)
 * @param {THREE.Object3D} obj
 */
export function enableLightsBloom(obj) {
    setBloomLayer(obj, BLOOM_LIGHTS_LAYER, true);
}

export function disableLightsBloom(obj) {
    setBloomLayer(obj, BLOOM_LIGHTS_LAYER, false);
}

/**
 * Passe de rendu sélectif d'un layer de bloom (remplace RenderPass + traverse de la scène) :
 * 1. Occulteurs : toute la scène en noir via scene.overrideMaterial (profondeur correcte),
 *    en masquant uniquement les objets émissifs enregistrés (lasers, et le layer rendu)
 * 2. Objets du layer seuls (camera.layers), avec leurs propres matériaux
 * Les ombres ne sont pas recalculées dans ces passes (inutiles : matériaux non éclairés).
 */
class SelectiveLayerPass extends Pass {
    constructor(scene, camera, layer, hideLayers, darkMaterial) {
        super();
        this.scene = scene;
        this.camera = camera;
        this.layer = layer;
        this.hideLayers = hideLayers;
        this.darkMaterial = darkMaterial;
        this.needsSwap = false;
        this._hidden = [];
    }

    render(renderer, writeBuffer, readBuffer) {
        const scene = this.scene;
        const camera = this.camera;
        const oldAutoClear = renderer.autoClear;
        const shadowMap = renderer.shadowMap;
        const oldShadowAuto = shadowMap.autoUpdate;
        const oldShadowNeeds = shadowMap.needsUpdate;
        shadowMap.autoUpdate = false;
        shadowMap.needsUpdate = false;
        renderer.autoClear = false;

        renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
        renderer.clear(true, true, false);

        // 1. Occulteurs (sans les objets émissifs)
        const hidden = this._hidden;
        hidden.length = 0;
        for (const layer of this.hideLayers) {
            for (const obj of _bloomRegistry[layer]) {
                // Un objet dont le layer a été désactivé (ex. écran de stroboscope éteint) reste un occulteur
                if (obj.visible && obj.layers.isEnabled(layer)) {
                    obj.visible = false;
                    hidden.push(obj);
                }
            }
        }
        scene.overrideMaterial = this.darkMaterial;
        renderer.render(scene, camera);
        scene.overrideMaterial = null;
        for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
        hidden.length = 0;

        // 2. Objets émissifs du layer uniquement
        const oldMask = camera.layers.mask;
        camera.layers.set(this.layer);
        renderer.render(scene, camera);
        camera.layers.mask = oldMask;

        renderer.autoClear = oldAutoClear;
        shadowMap.autoUpdate = oldShadowAuto;
        shadowMap.needsUpdate = oldShadowNeeds;
    }
}

/**
 * Rendu de la scène dans SA cible multi-échantillonnée (MSAA), résolue une seule fois (couleur + profondeur).
 * Les passes d'effets qui suivent écrivent dans les cibles simples du composer : une passe plein écran
 * écrite dans une cible MSAA coûte ~6× plus cher (4 échantillons par pixel + résolution) pour une image identique.
 */
class SceneMSAAPass extends Pass {
    constructor(scene, camera, target) {
        super();
        this.scene = scene;
        this.camera = camera;
        this.target = target;
        this.needsSwap = false;
    }

    render(renderer) {
        const oldAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(this.target);
        renderer.clear(true, true, false);
        renderer.render(this.scene, this.camera);
        renderer.autoClear = oldAutoClear;
    }
}

const BLOOM_RESOLUTION_SCALE = 0.5;

// Nombre de lumières ponctuelles émises par les lasers : créées dès le départ (éteintes) et
// jamais retirées → le nombre de lumières de la scène ne change pas quand on pose un laser
// (pas de recompilation de tous les shaders éclairés).
const LASER_LIGHT_POOL_SIZE = 4;

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
    laserRange:             300,  // Distance d'affichage des faisceaux (m, depuis l'émetteur) — réglage local
};

// Netteté : masque flou adaptatif (renforce les détails fins, limité pour éviter les halos)
const SHARPEN_SHADER = {
    uniforms: {
        tDiffuse: { value: null },
        uTexel:   { value: new THREE.Vector2(1, 1) },
        uAmount:  { value: 0 },
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
        uniform vec2 uTexel;
        uniform float uAmount;
        varying vec2 vUv;
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            vec3 n = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb;
            vec3 s = texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;
            vec3 e = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb;
            vec3 w = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb;
            vec3 mn = min(c.rgb, min(min(n, s), min(e, w)));
            vec3 mx = max(c.rgb, max(max(n, s), max(e, w)));
            vec3 blur = (n + s + e + w) * 0.25;
            vec3 sharp = c.rgb + (c.rgb - blur) * uAmount * 2.0;
            // Pas de dépassement au-delà du voisinage : pas de halo clair/sombre autour des contours
            gl_FragColor = vec4(clamp(sharp, mn, mx), c.a);
        }
    `,
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

        // Rendu batché partagé par tous les lasers (5 draw calls au total)
        this._batch = new LaserBatch(scene, enableLaserBloom);
        this._batchCompiled = false;

        // Pool fixe de lumières ponctuelles agrégées (au lieu d'1 PointLight par laser)
        // Toutes les lumières du pool sont créées dès le départ (éteintes) : le nombre de lumières
        // de la scène ne change jamais, donc poser un laser ne force plus la recompilation de
        // tous les shaders éclairés.
        this._laserLights = [];
        for (let i = 0; i < LASER_LIGHT_POOL_SIZE; i++) {
            const light = new THREE.PointLight(new THREE.Color('#0055ff'), 0, 15, 1.8);
            light.userData.isAmbianceInternal = true;
            light.name = 'laser-light-pool-' + i;
            scene.add(light);
            this._laserLights.push(light);
        }
        this._lightPods = [];
        this._lightSeeds = [];
        this._lightAcc = [];
        for (let i = 0; i < LASER_LIGHT_POOL_SIZE; i++) {
            this._lightAcc.push({ w: 0, x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, px: 0, py: 0, pz: 0, n: 0, dist: 0 });
        }
        this._dazzleData = [];

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

        this._hiddenGizmos  = [];
        this._msaaSamples   = 4;
        this._useComposer   = false;
        this._playerCollider = null;

        this._initPostProcessing();
        this._useComposer = !!(this._finalComposer && (this._laserBloomComposer || this._lightsBloomComposer));

        // Anticrénelage, distance des lasers, échelle de rendu, netteté : réglés par le menu ⚙️ Options
        setLaserDisplayRange(globalLaserPostParams.laserRange);

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
            // ── 1. Laser Bloom Composer (Rendu isolé des lasers avec Bloom + Aberration Chromatique) ──
            // Lasers seuls, occultés par le décor (les lampes font partie des occulteurs noirs)
            const renderLaserScene = new SelectiveLayerPass(this.scene, this.camera, BLOOM_LASER_LAYER, [BLOOM_LASER_LAYER], this._darkMaterial);
            // Les deux blooms sont floutés : ils sont calculés à demi-résolution (4× moins de pixels à remplir)
            const bloomSize = this.renderer.getSize(new THREE.Vector2());
            const bloomPR = this.renderer.getPixelRatio();
            const bloomW = Math.max(1, Math.round(bloomSize.x * bloomPR * BLOOM_RESOLUTION_SCALE));
            const bloomH = Math.max(1, Math.round(bloomSize.y * bloomPR * BLOOM_RESOLUTION_SCALE));
            const makeBloomTarget = () => new THREE.WebGLRenderTarget(bloomW, bloomH, { type: THREE.HalfFloatType });
            this._laserBloomComposer = new EffectComposer(this.renderer, makeBloomTarget());
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
            // Lampes seules : les lasers (transparents additifs) ne doivent pas les occulter
            const renderLightsScene = new SelectiveLayerPass(this.scene, this.camera, BLOOM_LIGHTS_LAYER, [BLOOM_LIGHTS_LAYER, BLOOM_LASER_LAYER], this._darkMaterial);
            this._lightsBloomComposer = new EffectComposer(this.renderer, makeBloomTarget());
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
            const size = this.renderer.getSize(new THREE.Vector2());
            const pixelRatio = this.renderer.getPixelRatio();
            const width = Math.max(1, Math.round(size.width * pixelRatio));
            const height = Math.max(1, Math.round(size.height * pixelRatio));
            const initialSamples = (this._msaaSamples !== undefined) ? this._msaaSamples : 4;

            // Scène : cible MSAA dédiée avec profondeur (lue par les nappes, les lyres et le brouillard).
            // Elle n'est jamais réécrite par les effets : pas de boucle de rétroaction, même sans MSAA.
            this._sceneRT = new THREE.WebGLRenderTarget(width, height, {
                type: THREE.HalfFloatType,
                samples: initialSamples
            });
            this._sceneRT.depthTexture = new THREE.DepthTexture(width, height);
            this._sceneRT.depthTexture.type = THREE.FloatType; // profondeur 32 bits (far = 5000 m)

            // Cibles du composer : SANS MSAA (les effets n'en ont pas besoin)
            const finalRT = new THREE.WebGLRenderTarget(width, height, {
                type: THREE.HalfFloatType,
                samples: 0
            });
            this._finalComposer = new EffectComposer(this.renderer, finalRT);
            this._scenePass = new SceneMSAAPass(this.scene, this.camera, this._sceneRT);
            this._finalComposer.addPass(this._scenePass);

            // Passe finale unique : nappes + faisceaux + brouillard + mélange des deux blooms + sortie écran
            // (les passes d'effets calculent leur image réduite, elle seule les recompose)
            this._mixPass = new FinalCompositePass(this.camera, null);
            this._mixPass.material.uniforms.uLaserBloomEnabled.value = globalLaserPostParams.laserBloomEnabled ? 1.0 : 0.0;
            this._mixPass.material.uniforms.uLightsBloomEnabled.value = globalLaserPostParams.lightsBloomEnabled ? 1.0 : 0.0;
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

            // Netteté (accentuation des contours, désactivée à 0)
            this._sharpenPass = new ShaderPass(SHARPEN_SHADER);
            this._sharpenPass.material.uniforms.uTexel.value.set(1 / width, 1 / height);
            this._sharpenPass.enabled = false;
            this._finalComposer.addPass(this._sharpenPass);

            // OutputPass (Tone mapping & Color space de Three.js) : seulement si FXAA, SMAA ou la netteté
            // suivent la passe finale (sinon la passe finale écrit elle-même à l'écran en sRGB)
            this._outputPass = new OutputPass();
            this._finalComposer.addPass(this._outputPass);

            this._composer = this._finalComposer;

            // Nappes PAN : rendu demi-résolution + fumée calculée une fois par pixel (LaserFanPass).
            // Première passe de scène (avant lyres et brouillard, comme lorsqu'elles étaient dans la scène).
            const fanPass = new LaserFanPass(this._batch, this.camera, null);
            if (this.addScenePass(fanPass)) {
                fanPass.sceneDepth = this.sceneDepth;
                this._fanPass = fanPass;
                // La nappe quitte le rendu principal (layer 0) ; elle reste sur le layer bloom laser
                this._batch.fanMesh.layers.disable(0);
            }

        } catch (e) {
            console.warn('[LaserManager] EffectComposer init failed:', e);
            this._laserBloomComposer  = null;
            this._lightsBloomComposer = null;
            this._bloomComposer       = null;
            this._finalComposer       = null;
            this._composer            = null;
        }
    }

    /**
     * Insère une passe juste après le rendu de la scène (avant les blooms). La passe lit la profondeur
     * de la scène (faisceaux volumétriques des lyres, brouillard…) dans `sceneDepth.texture` :
     * profondeur de la cible de la scène, résolue par three.js après le rendu MSAA.
     * @returns {boolean} false si la chaîne de post-traitement n'existe pas
     */
    addScenePass(pass) {
        const composer = this._finalComposer;
        if (!composer) return false;
        // Passe « témoin » juste après le rendu de la scène : publie la profondeur de la scène
        if (!this._sceneDepthTap) {
            this.sceneDepth = { texture: null };
            const shared = this.sceneDepth;
            const sceneRT = () => this._sceneRT;
            this._sceneDepthTap = new (class extends Pass {
                constructor() { super(); this.needsSwap = false; }
                render() { shared.texture = sceneRT().depthTexture || null; }
            })();
            composer.insertPass(this._sceneDepthTap, 1);
            this._scenePassCount = 0;
            if (this._mixPass) this._mixPass.sceneDepth = this.sceneDepth;
        }
        // Recomposition différée : l'image de la passe est recomposée par la passe finale unique
        if (this._mixPass && 'deferred' in pass) {
            pass.deferred = true;
            this._mixPass.producers.push(pass);
        }
        // Les passes de scène s'exécutent dans l'ordre d'enregistrement (faisceaux des lyres, puis brouillard…)
        composer.insertPass(pass, 2 + this._scenePassCount);
        this._scenePassCount++;
        return true;
    }

    /** Ajoute un nouveau laser dans la scène */
    addLaser(position = new THREE.Vector3(0, 12, -4), paramOverrides = {}, customId = null) {
        const id = (customId !== null && customId !== undefined) ? customId : this._nextId++;
        if (this._nextId <= id) this._nextId = id + 1;
        const laserShow = new LaserShow(this.scene, position.clone(), paramOverrides, this._batch);
        laserShow.laserId = id;
        this._lasers.set(id, laserShow);

        // Warm-up / Précompilation des shaders batchés (1 seule fois pour tous les lasers, 0 stutter)
        if (!this._batchCompiled && this.renderer && this.camera && typeof this.renderer.compile === 'function') {
            this._batch.compile(this.renderer, this.camera);
            this._batchCompiled = true;
        }

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

        // 2. Assemblage GPU de tous les lasers (5 draw calls) + boîtiers instanciés + éclairage
        this._batch.assemble(this._lasers.values(), this._globalSmokeState);
        flushHousings(this.scene);
        this._updateLaserLights();

        // 3. Éblouissement physiologique — collecte les données de chaque laser (objets réutilisés)
        if (this._dazzle) {
            const laserData = this._dazzleData;
            let i = 0;
            for (const laser of this._lasers.values()) {
                let d = laserData[i];
                if (!d) d = laserData[i] = {};
                d.pod                = laser.pod;
                d.hitPts             = laser._podHitPts;
                d.params             = laser.params;
                d.effectiveBeamPower = laser.visible ? (laser._effectiveBeamPower || 0) : 0;
                d.effectivePanPower  = laser.visible ? (laser._effectivePanPower  || 0) : 0;
                i++;
            }
            laserData.length = i;
            this._dazzle.update(delta, laserData);
        }
    }

    /**
     * Éclairage émis par les lasers : pool FIXE de PointLight.
     * - Jusqu'à LASER_LIGHT_POOL_SIZE lasers : 1 lumière par laser (rendu identique à l'original)
     * - Au-delà : les sources sont regroupées spatialement (graines choisies par éloignement,
     *   indépendantes de l'intensité → regroupement stable) ; chaque lumière reçoit la somme
     *   des intensités de son groupe, au barycentre pondéré, avec la couleur moyenne pondérée.
     * Le coût par pixel de l'éclairage de la scène ne dépend plus du nombre de lasers.
     */
    _updateLaserLights() {
        const pods = this._lightPods;
        pods.length = 0;
        for (const laser of this._lasers.values()) {
            if (laser.visible) pods.push(laser.pod);
        }

        const lights = this._laserLights;
        const K = lights.length;
        const acc = this._lightAcc;
        for (let k = 0; k < K; k++) {
            const a = acc[k];
            a.w = 0; a.x = 0; a.y = 0; a.z = 0; a.r = 0; a.g = 0; a.b = 0;
            a.px = 0; a.py = 0; a.pz = 0; a.n = 0; a.dist = 0;
        }

        if (pods.length <= K) {
            for (let i = 0; i < pods.length; i++) this._accumulateLight(acc[i], pods[i]);
        } else {
            // Graines : échantillonnage par point le plus éloigné (déterministe)
            const seeds = this._lightSeeds;
            seeds.length = 0;
            seeds.push(0);
            while (seeds.length < K) {
                let best = -1, bestD = -1;
                for (let i = 0; i < pods.length; i++) {
                    let dMin = Infinity;
                    for (let j = 0; j < seeds.length; j++) {
                        const d = pods[i].lightPosition.distanceToSquared(pods[seeds[j]].lightPosition);
                        if (d < dMin) dMin = d;
                    }
                    if (dMin > bestD) { bestD = dMin; best = i; }
                }
                seeds.push(best);
            }
            for (let i = 0; i < pods.length; i++) {
                let best = 0, bestD = Infinity;
                for (let j = 0; j < K; j++) {
                    const d = pods[i].lightPosition.distanceToSquared(pods[seeds[j]].lightPosition);
                    if (d < bestD) { bestD = d; best = j; }
                }
                this._accumulateLight(acc[best], pods[i]);
            }
        }

        for (let k = 0; k < K; k++) {
            const a = acc[k];
            const light = lights[k];
            if (a.n === 0) {
                light.intensity = 0;
                continue;
            }
            if (a.w > 1e-6) {
                light.position.set(a.x / a.w, a.y / a.w, a.z / a.w);
                light.color.setRGB(a.r / a.w, a.g / a.w, a.b / a.w);
            } else {
                light.position.set(a.px / a.n, a.py / a.n, a.pz / a.n);
            }
            light.intensity = a.w;
            light.distance = a.dist;
        }
        for (let k = K; k < lights.length; k++) lights[k].intensity = 0;
    }

    _accumulateLight(a, pod) {
        const w = pod.lightIntensity;
        const lp = pod.lightPosition;
        const c = pod.lightColor;
        a.w += w;
        a.x += lp.x * w; a.y += lp.y * w; a.z += lp.z * w;
        a.r += c.r * w; a.g += c.g * w; a.b += c.b * w;
        a.px += lp.x; a.py += lp.y; a.pz += lp.z;
        a.n++;
        if (pod.lightDistance > a.dist) a.dist = pod.lightDistance;
    }

    /**
     * Rendu sélectif à double bloom :
     * - Bloom Laser avec aberration chromatique (layer 1)
     * - Bloom Lampes & Scène SANS aberration chromatique (layer 2)
     * - Les obstacles du décor masquent naturellement les sources lumineuses via le depth buffer
     * - Mélange additif dans la scène nette finale avec MSAA matériel
     */
    /**
     * Rendu direct à l'écran possible ? Uniquement quand AUCUNE passe de post-traitement ne sert :
     * pas de bloom visible, aucune passe de scène active (faisceaux des lyres, brouillard…),
     * pas de FXAA / SMAA / netteté, et MSAA 4x (identique au MSAA matériel du canvas).
     * Évite la cible HDR MSAA 4x, la recopie de profondeur et 2 passes plein écran par image.
     */
    _canRenderDirect(renderLaser, renderLights) {
        if (renderLaser || renderLights) return false;
        if (this._msaaSamples !== 4) return false;
        const composer = this._finalComposer;
        for (const pass of composer.passes) {
            if (!pass.enabled) continue;
            if (pass === composer.passes[0] || pass === this._sceneDepthTap || pass === this._mixPass || pass === this._outputPass) continue;
            return false; // une passe d'effet est active (lyres, brouillard, FXAA, SMAA, netteté…)
        }
        return true;
    }

    /** Résolution des nappes PAN (0.5 = demi-résolution, 1 = pleine) — option locale du joueur */
    setFanQuality(scale) {
        if (this._fanPass) this._fanPass.setResolutionScale(scale);
    }

    /** Fumée des nappes calculée une fois par pixel (masque partagé) — option locale du joueur */
    setSharedSmoke(enabled) {
        this._sharedSmoke = Boolean(enabled);
        if (!this._sharedSmoke && this._batch) this._batch.fanMaterial.uniforms.uUseMask.value = 0;
    }

    /**
     * Précompile les shaders pour les DEUX modes de rendu (direct à l'écran et via le composer) :
     * basculer de l'un à l'autre (ex. premier laser posé) ne provoque pas de recompilation.
     */
    warmupShaders() {
        const r = this.renderer;
        if (!r || typeof r.compile !== 'function') return;
        const prev = r.getRenderTarget();
        try {
            r.setRenderTarget(null);
            r.compile(this.scene, this.camera);
            if (this._sceneRT) {
                r.setRenderTarget(this._sceneRT);
                r.compile(this.scene, this.camera);
            }
        } catch (_) {
        } finally {
            r.setRenderTarget(prev);
        }
    }

    /**
     * Comme warmupShaders, mais sans bloquer la page : la compilation se fait en parallèle
     * sur le GPU quand le navigateur le permet (KHR_parallel_shader_compile).
     */
    async warmupShadersAsync() {
        const r = this.renderer;
        if (!r || typeof r.compileAsync !== 'function') { this.warmupShaders(); return; }
        const prev = r.getRenderTarget();
        try {
            r.setRenderTarget(null);
            const direct = r.compileAsync(this.scene, this.camera);
            let composed = null;
            if (this._sceneRT) {
                r.setRenderTarget(this._sceneRT);
                composed = r.compileAsync(this.scene, this.camera);
            }
            r.setRenderTarget(prev);
            await Promise.all([direct, composed]);
        } catch (_) {
            r.setRenderTarget(prev);
        }
    }

    render() {
        if (this._useComposer && this._finalComposer) {
            // Un bloom sans aucun objet émissif visible ne produit que du noir : on saute toute la passe
            const renderLaser = Boolean(globalLaserPostParams.laserBloomEnabled && this._laserBloomComposer) && layerHasVisibleObject(BLOOM_LASER_LAYER);
            const renderLights = Boolean(globalLaserPostParams.lightsBloomEnabled && this._lightsBloomComposer) && layerHasVisibleObject(BLOOM_LIGHTS_LAYER);

            if (this._fanPass) this._fanPass.enabled = this._fanPass.hasFans;

            // Aucun effet actif : rendu direct à l'écran (même image, beaucoup moins de travail GPU)
            if (this._canRenderDirect(renderLaser, renderLights)) {
                this.renderer.setRenderTarget(null);
                this.renderer.render(this.scene, this.camera);
                return;
            }

            // Matrices monde calculées UNE fois pour les 5 rendus de la frame (bloom ×2 ×2 + final)
            this.scene.updateMatrixWorld();
            const oldMatrixAuto = this.scene.matrixWorldAutoUpdate;
            this.scene.matrixWorldAutoUpdate = false;

            // Fumée des nappes : masque partagé calculé une fois par pixel, AVANT le bloom (qui le relit)
            if (this._fanPass && this._fanPass.enabled) {
                if (this._sharedSmoke !== false) this._fanPass.renderMask(this.renderer);
                else this._batch.fanMaterial.uniforms.uUseMask.value = 0;
            }

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

                // Le gizmo d'édition (TransformControls) est posé sur le boîtier du laser : repeint en noir avec
                // profondeur dans les passes de bloom, il masquerait l'origine du rayon. On le cache pendant ces passes.
                for (const child of this.scene.children) {
                    if (child.isTransformControls && child.visible) {
                        this._hiddenGizmos.push(child);
                        child.visible = false;
                    }
                }
            }

            // 2. Bloom Laser (Layer 1) avec aberration chromatique
            if (renderLaser) {
                this._laserBloomComposer.render();
                this._mixPass.material.uniforms.laserBloomTexture.value = this._laserBloomComposer.readBuffer.texture;
                this._mixPass.material.uniforms.uLaserBloomEnabled.value = 1.0;
            } else {
                this._mixPass.material.uniforms.uLaserBloomEnabled.value = 0.0;
            }

            // 3. Bloom Lampes & Scène (Layer 2) pur, sans aberration chromatique
            if (renderLights) {
                this._lightsBloomComposer.render();
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
                for (const gizmo of this._hiddenGizmos) gizmo.visible = true;
                this._hiddenGizmos.length = 0;
            }

            // 5. Rendu final de la scène normale + mixage additif des deux blooms + OutputPass
            this._renderChain();
            this.scene.matrixWorldAutoUpdate = oldMatrixAuto;
        } else {
            this.renderer.render(this.scene, this.camera);
        }
    }

    /**
     * Exécute la chaîne du composer final (remplace EffectComposer.render) :
     * la scène est rendue dans sa cible MSAA, puis chaque effet lit l'image précédente et écrit
     * dans l'une des deux cibles simples du composer — jamais dans la cible MSAA de la scène.
     * La dernière passe active écrit à l'écran.
     */
    _renderChain() {
        const composer = this._finalComposer;
        const passes = composer.passes;
        const renderer = this.renderer;
        // La passe finale écrit directement à l'écran sauf si un anticrénelage ou la netteté la suit
        if (this._outputPass) {
            this._outputPass.enabled = Boolean((this._smaaPass && this._smaaPass.enabled) ||
                (this._fxaaPass && this._fxaaPass.enabled) || (this._sharpenPass && this._sharpenPass.enabled));
        }
        let last = -1;
        for (let i = 0; i < passes.length; i++) if (passes[i].enabled) last = i;

        const rtA = composer.renderTarget1;
        const rtB = composer.renderTarget2;
        let read = this._sceneRT;
        let write = rtA;
        for (let i = 0; i < passes.length; i++) {
            const pass = passes[i];
            if (!pass.enabled) continue;
            pass.renderToScreen = (i === last);
            pass.render(renderer, write, read, 0, false);
            if (pass === this._scenePass) {
                read = this._sceneRT;
            } else if (pass.needsSwap) {
                read = write;
                write = (write === rtA) ? rtB : rtA;
            }
        }
        renderer.setRenderTarget(null);
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
            case 'laserRange':
                setLaserDisplayRange(value);
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

        // Seule la cible de la scène est multi-échantillonnée (les effets écrivent dans des cibles simples)
        const rt = this._sceneRT;
        if (rt && rt.samples !== samples) {
            rt.samples = samples;
            rt.dispose();
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
        const bloomW = Math.max(1, Math.round(width * this.renderer.getPixelRatio() * BLOOM_RESOLUTION_SCALE));
        const bloomH = Math.max(1, Math.round(height * this.renderer.getPixelRatio() * BLOOM_RESOLUTION_SCALE));
        if (this._laserBloomComposer) this._laserBloomComposer.setSize(bloomW, bloomH);
        if (this._lightsBloomComposer) this._lightsBloomComposer.setSize(bloomW, bloomH);
        if (this._laserBloomPass) this._laserBloomPass.setSize(width, height);
        if (this._lightsBloomPass) this._lightsBloomPass.setSize(width, height);
        const pixelRatio = this.renderer.getPixelRatio();
        const renderW = Math.max(1, Math.round(width * pixelRatio));
        const renderH = Math.max(1, Math.round(height * pixelRatio));
        // Le composer final travaille en pixels réels (cible créée à la taille × pixelRatio, pixelRatio interne = 1)
        if (this._finalComposer) this._finalComposer.setSize(renderW, renderH);
        const rt = this._sceneRT;
        if (rt) {
            rt.setSize(renderW, renderH);
            // three.js r160 ne redimensionne pas la DepthTexture d'une cible (RenderTarget.setSize) :
            // profondeur et couleur de tailles différentes → « Attachments are not all the same size »
            const dt = rt.depthTexture;
            if (dt && (dt.image.width !== rt.width || dt.image.height !== rt.height)) {
                dt.image.width = rt.width;
                dt.image.height = rt.height;
                dt.dispose();
                rt.dispose();
            }
        }
        if (this._sharpenPass) this._sharpenPass.material.uniforms.uTexel.value.set(1 / renderW, 1 / renderH);
        if (this._fxaaPass) {
            this._fxaaPass.material.uniforms['resolution'].value.x = 1 / renderW;
            this._fxaaPass.material.uniforms['resolution'].value.y = 1 / renderH;
        }
        if (this._smaaPass) {
            this._smaaPass.setSize(renderW, renderH);
        }
    }

    /** Netteté en post-traitement (0 = désactivée, 1 = maximum) */
    setSharpness(amount) {
        const a = Math.max(0, Math.min(1, Number(amount) || 0));
        if (!this._sharpenPass) return;
        this._sharpenPass.enabled = a > 0.001;
        this._sharpenPass.material.uniforms.uAmount.value = a;
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
