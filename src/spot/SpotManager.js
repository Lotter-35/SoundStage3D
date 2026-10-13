/**
 * SpotManager.js
 * ─────────────────────────────────────────────────────────────
 * Orchestrateur des lyres Spot :
 *   - ajout / suppression / duplication / recherche (identifiants uniques réseau)
 *   - boucle de mise à jour : DMX → mécanique → batch GPU → ombres statiques → cônes (faisceaux SS, taches)
 *   - réglages globaux (fumée, qualité, taches de lumière, reflets, lumière indirecte)
 *   - point d'entrée DMX : applyDmxFrame(univers, octets)
 *
 * Coût GPU : 1 draw call de faisceaux + 1 d'éblouissements + ~10 de boîtiers quel que soit le nombre de
 * lyres ; aucune lumière three.js : l'éclairage du décor est une passe à l'écran (LightPoolPass, toutes
 * les lyres, ombres statiques cuites par SpotShadowAtlas) ; lumière indirecte (GI) et reflets des faisceaux :
 * SpotLightingFX.
 *
 * Rendu des faisceaux choisi PAR LYRE (paramètre « Rendu du faisceau » : Global / Classique / SS Depth ;
 * Global = réglage synchronisé « Rendu des faisceaux (défaut) ») : les lyres classiques passent par
 * SpotBatch / SpotVolumePass, les lyres SS Depth par SSDepthLights / SSDepthPass ; les deux coexistent.
 * ─────────────────────────────────────────────────────────────
 */

import { SpotBatch, SpotVolumePass } from './SpotBatch.js?v=5';
import { SpotFixture, SPOT_BEAM_RANGE } from './SpotFixture.js?v=3';
import { SSDepthLights } from './ssdepth/SSDepthLights.js';
import { SSDepthPass } from './ssdepth/SSDepthPass.js';
import { LENS_RADIUS } from './SpotHousing.js?v=2';
import { SpotShadowAtlas } from './lighting/SpotShadowAtlas.js';
import { LightPoolPass } from './lighting/LightPoolPass.js';
import { SpotLightingFX } from './SpotLightingFX.js';
import { getSpotHousingInstancer } from './SpotHousing.js?v=2';
import { DmxPatch } from '../dmx/DmxPatch.js';
import { defaultSpotGlobals, SPOT_GLOBAL_SCHEMA } from './config/spotParams.js';
import { SpotEffects } from './console/SpotEffects.js';
import { RES_QUALITY } from '../ui/ClientOptions.js';
import { nextBusyState, BUSY_RES_FACTOR } from '../render/resolutionScale.js';

/** Résolution des faisceaux quand la caméra est dans l'un d'eux (× la qualité choisie) */
const INSIDE_RES_FACTOR = 0.5;
/** Image trop lente (temps GPU > budget des FPS visés) : la résolution des faisceaux seuls baisse par paliers */
const LOAD_MIN = 0.5, LOAD_STEP_DOWN = 0.1, LOAD_STEP_UP = 0.05, LOAD_PERIOD_MS = 500;
/** Taches de lumière : lumière émise → éclairement (même échelle que les anciennes SpotLight three.js) */
const POOL_GAIN = 60;

function makeId() {
    return 'spot-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

export class SpotManager {
    /**
     * @param {object} o
     * @param {THREE.Scene} o.scene
     * @param {THREE.Camera} o.camera
     * @param {THREE.WebGLRenderer} o.renderer
     * @param {import('../laser/LaserManager.js').LaserManager} [o.laserManager]
     */
    constructor({ scene, camera, renderer, laserManager }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.laserManager = laserManager;

        this._spots = new Map();
        this._nextNumber = 1;
        this.globals = defaultSpotGlobals();

        // Ombres statiques (cubemaps de distances cuites une fois) : uniformes partagés par tous les shaders
        this.shadows = new SpotShadowAtlas(renderer, scene);
        this.batch = new SpotBatch(scene, this.shadows.uniforms);
        this.patch = new DmxPatch();
        getSpotHousingInstancer(scene);

        // Faisceaux : passe insérée juste après le rendu de la scène (lit sa profondeur)
        this.volumePass = new SpotVolumePass(this.batch, camera);
        this.volumePass.enabled = false;
        this._hasPass = Boolean(laserManager && typeof laserManager.addScenePass === 'function' && laserManager.addScenePass(this.volumePass));
        // Profondeur de la SCÈNE (et non celle de l'image précédente : une passe placée avant peut échanger les cibles)
        if (this._hasPass) this.volumePass.sceneDepth = laserManager.sceneDepth;
        if (!this._hasPass) console.warn('[SpotManager] Pas de chaîne de post-traitement : faisceaux volumétriques désactivés.');

        // Cônes des lyres (faisceaux SS Depth et taches de lumière), triés par tuile d'écran
        this.ssLights = new SSDepthLights(this.batch);
        // Lumière indirecte (grille de GI, passe insérée avant les taches qui la lisent) et reflets des faisceaux
        this.fx = new SpotLightingFX({
            lights: this.ssLights, batch: this.batch, camera, shadowUniforms: this.shadows.uniforms,
            laserManager: this._hasPass ? laserManager : null,
        });
        // Taches de lumière de toutes les lyres : passe insérée avant les faisceaux SS Depth (le halo les lit)
        this.poolPass = new LightPoolPass(this.ssLights, this.batch, camera, this.shadows.uniforms, this.fx.giUniforms);
        this.poolPass.enabled = false;
        this._hasPoolPass = this._hasPass && laserManager.addScenePass(this.poolPass);
        if (this._hasPoolPass) this.poolPass.sceneDepth = laserManager.sceneDepth;
        this._grassLookup = 0;
        // Faisceaux SS Depth (+ halo atmosphérique) : passe insérée après celle des faisceaux classiques
        this.ssPass = new SSDepthPass(this.ssLights, this.batch, camera, this.shadows.uniforms);
        this.ssPass.enabled = false;
        this.ssPass.classicPass = this.volumePass;
        this.ssPass.poolPass = this.poolPass;
        this._hasSSPass = this._hasPass && laserManager.addScenePass(this.ssPass);
        if (this._hasSSPass) this.ssPass.sceneDepth = laserManager.sceneDepth;
        this.fx.addReflectPass();

        this._compiled = false;
        this._time = 0;
        this._applyGlobals();

        // Effets de la console (calculés sur l'horloge commune à tous les joueurs)
        this.effects = new SpotEffects();
        this._clock = () => this._time;
        this._updateHooks = [];
        // Autres projecteurs rendus par le même batch (barres LED) : { count, update(dt), pushInstances(batch) }
        this._sources = [];
        // Caméra dans un faisceau : faisceaux calculés en résolution réduite (on est ébloui, le détail
        // ne se voit pas) — le faisceau couvre tout l'écran, c'est le cas qui coûte le plus
        this._insideScale = 1;
        this._busy = false;
        this._insideHold = 0;
        this._load = 1;          // facteur de résolution selon le coût réel (setFrameLoad)
        this._loadTime = 0;
    }

    /** Vrai si la caméra est dans le cône d'une lyre allumée ou dans les faisceaux d'une barre LED */
    _cameraInsideBeam() {
        const c = this.camera.position;
        for (const s of this._spots.values()) {
            if (s.flux <= 1e-4 || s.ssDepth) continue;   // faisceau SS Depth : coût indépendant de la passe classique
            const dx = c.x - s.lensPos.x, dy = c.y - s.lensPos.y, dz = c.z - s.lensPos.z;
            const z = dx * s.axis.x + dy * s.axis.y + dz * s.axis.z;
            if (z <= 0 || z > SPOT_BEAM_RANGE) continue;
            const r = LENS_RADIUS + z * s.tanLight;
            if (dx * dx + dy * dy + dz * dz - z * z <= r * r) return true;
        }
        for (const src of this._sources) if (src.cameraInsideBeam) return true;
        return false;
    }

    /** Branche une autre famille de projecteurs sur le batch des faisceaux (barres LED…) */
    addSource(source) {
        this._sources.push(source);
    }

    _sourcesActive() {
        for (const s of this._sources) if (s.count > 0) return true;
        return false;
    }

    /** Horloge partagée (même valeur chez tous les joueurs) utilisée par les effets */
    setClock(fn) {
        if (typeof fn === 'function') this._clock = fn;
    }

    clock() {
        return this._clock();
    }

    /** Fonction appelée à chaque frame avant la mise à jour des lyres (console, suivi…) */
    addUpdateHook(fn) {
        this._updateHooks.push(fn);
    }

    // ── Gestion des lyres ─────────────────────────────────────────────────

    /**
     * @param {import('three').Vector3|null} position
     * @param {object} [params]
     * @param {string|null} [id] identifiant imposé (réseau)
     */
    addSpot(position = null, params = {}, id = null) {
        const spotId = id || makeId();
        if (this._spots.has(spotId)) return { id: spotId, spot: this._spots.get(spotId) };
        const p = { ...params };
        if (position) {
            p.posX = Math.round(position.x * 100) / 100;
            p.posY = Math.round(position.y * 100) / 100;
            p.posZ = Math.round(position.z * 100) / 100;
        }
        const spot = new SpotFixture({
            id: spotId,
            number: this._nextNumber++,
            scene: this.scene,
            batch: this.batch,
            patch: this.patch,
            params: p,
        });
        // Adresse DMX libre automatique pour une lyre posée localement
        if (!id && params.dmxAddress === undefined) this._autoPatch(spot);
        this._spots.set(spotId, spot);

        if (!this._compiled && this.renderer && this.camera) {
            this.batch.compile(this.renderer, this.camera);
            this._compiled = true;
        }
        return { id: spotId, spot };
    }

    removeSpot(id) {
        const spot = this._spots.get(id);
        if (!spot) return false;
        this.shadows.release(spot);
        spot.dispose();
        this._spots.delete(id);
        return true;
    }

    duplicateSpot(id) {
        const src = this._spots.get(id);
        if (!src) return null;
        const params = { ...src.params };
        params.posX += 0.8;
        delete params.dmxAddress;
        return this.addSpot(null, params);
    }

    /** Première adresse libre, en passant à l'univers suivant quand le courant est plein */
    _autoPatch(spot) {
        for (let u = spot.dmxUniverse; u <= 64; u++) {
            const addr = this.patch.findFreeAddress(u, spot.dmxFootprint, spot);
            if (addr > 0) {
                spot.params.dmxUniverse = u;
                spot.params.dmxAddress = addr;
                this.patch.invalidate(spot);
                return;
            }
        }
    }

    getSpot(id) {
        return this._spots.get(id) || null;
    }

    getAllSpots() {
        return Array.from(this._spots.values());
    }

    get count() {
        return this._spots.size;
    }

    getSpotObjects() {
        const out = [];
        for (const s of this._spots.values()) out.push(s.pickMesh);
        return out;
    }

    getSpotFromObject(obj) {
        let cur = obj;
        while (cur) {
            if (cur.userData && cur.userData.spotInstance) return cur.userData.spotInstance;
            cur = cur.parent;
        }
        return null;
    }

    // ── Réglages globaux ──────────────────────────────────────────────────

    setGlobal(key, value) {
        if (!(key in SPOT_GLOBAL_SCHEMA)) return;
        this.globals[key] = value;
        this._applyGlobals();
    }

    /**
     * Densité de fumée imposée par le brouillard de salle (option « Liée au brouillard ») ;
     * null = densité propre aux lyres (réglage « Densité de la fumée »)
     */
    setHazeOverride(density) {
        this._hazeOverride = (density === null || density === undefined) ? null : density;
        this._applyGlobals();
    }

    _beamSetting() {
        return RES_QUALITY[this.globals.beamQuality] || 0.5;
    }

    /** Résolution des faisceaux : qualité choisie × caméra dans un faisceau × beaucoup de faisceaux (mode auto) */
    /**
     * Temps GPU de l'image (résolution dynamique) comparé au budget des FPS visés : faisceaux en résolution plus
     * basse tant que l'image est trop lente et que des faisceaux sont affichés, retour progressif sinon
     */
    setFrameLoad(gpuMs, budgetMs, now) {
        if (!(gpuMs > 0) || !(budgetMs > 0) || now - this._loadTime < LOAD_PERIOD_MS) return;
        this._loadTime = now;
        let f = this._load;
        if (gpuMs > budgetMs * 1.05 && this.volumePass.enabled) f = Math.max(LOAD_MIN, f - LOAD_STEP_DOWN);
        else if (gpuMs < budgetMs * 0.8 || !this.volumePass.enabled) f = Math.min(1, f + LOAD_STEP_UP);
        if (f !== this._load) {
            this._load = f;
            this._applyVolumeResolution();
        }
    }

    _applyVolumeResolution() {
        this.volumePass.setResolutionScale(this._beamSetting(), this._insideScale * (this._busy ? BUSY_RES_FACTOR : 1) * this._load);
    }

    _applyGlobals() {
        const g = this.globals;
        const u = this.batch.volumeMaterial.uniforms;
        u.uHaze.value = (this._hazeOverride !== null && this._hazeOverride !== undefined) ? this._hazeOverride : g.hazeDensity;
        u.uHazeContrast.value = g.hazeContrast;
        u.uHazeScale.value = g.hazeScale;
        u.uPhaseG.value = g.scattering;
        // Faisceaux SS Depth : même fumée (sans volutes) et même diffusion ; halo atmosphérique
        this.ssPass.haze = u.uHaze.value;
        this.ssPass.phaseG = g.scattering;
        this.ssPass.haloIntensity = g.haloIntensity;
        this.ssPass.haloRadius = g.haloRadius;
        // Calcul des faisceaux : rapide (moins d'échantillons, même énergie) ou précis (ancien rendu)
        const fast = g.beamRender !== 'Précis';
        u.uFast.value = fast ? 1 : 0;
        // Lissage temporel désactivé : il floute les gobos animés (moyenne de plusieurs images)
        this.volumePass.temporal = false;
        this._applyVolumeResolution();
        // Taches de lumière (passe à l'écran) ; désactivées : tache simple calculée par les faisceaux
        const pools = this._poolsOn();
        this.batch.splashOn = !pools;
        this.ssPass.splash = !pools;
        const pu = this.poolPass.material.uniforms;
        pu.uGain.value = POOL_GAIN * g.lightPoolIntensity;
        pu.uSpecOn.value = g.specular ? 1 : 0;
        this.fx.applyGlobals(g, { haze: u.uHaze.value, phaseG: g.scattering, poolGain: pu.uGain.value });
    }

    _poolsOn() {
        return Boolean(this._hasPoolPass && this.globals.lightPools);
    }

    /** Ombres statiques des lyres : taille des faces de la cubemap (0 = désactivées, 128, 256) — option locale */
    setShadowResolution(size) {
        this.shadows.setSize(size);
    }

    /** Ombres statiques aussi dans les faisceaux classiques — option locale */
    setClassicBeamShadows(on) {
        this.batch.volumeMaterial.uniforms.uClassicShadow.value = on ? 1 : 0;
    }

    /** Résolution des taches de lumière : 'auto', 1 (pleine) ou 2 (½) — option locale */
    setPoolResolution(res) {
        this.poolPass.setResolution(res);
    }

    /** Albédo du sol : texture de la pelouse (cherchée tant que le sol n'est pas dans la scène) */
    _findGrass() {
        if (this._grassFound || (this._grassLookup++ % 60) !== 0) return;
        const ground = this.scene.getObjectByName('ground');
        const map = ground && ground.material && ground.material.map;
        if (map) {
            this.poolPass.setGrassTexture(map);
            this.fx.setGrassTexture(map);
            this._grassFound = true;
        }
    }

    /** Résolution de la passe SS Depth : diviseur de l'image (2 = ½, 3 = ⅓, 4 = ¼) — option locale */
    setSSResolution(div) {
        this.ssPass.setDivisor(div);
    }

    /** Netteté de la remontée bilatérale des faisceaux SS Depth — option locale */
    setSSSharpness(v) {
        this.ssPass.sharpness = v;
    }

    /** Vrai si la lyre est rendue en SS Depth (réglage de la lyre, sinon réglage global) */
    _isSSDepth(spot) {
        if (!this._hasSSPass) return false;
        const m = spot.params.beamRenderMode;
        if (m === 'SS Depth') return true;
        if (m === 'Classique') return false;
        return this.globals.beamRenderDefault === 'SS Depth';
    }

    _haloOn() {
        return this._hasSSPass && this.globals.haloIntensity > 0.005;
    }

    // ── DMX ───────────────────────────────────────────────────────────────

    /** Trame DMX reçue (future source Art-Net / sACN via le serveur) */
    applyDmxFrame(universe, bytes, startAddress = 1) {
        this.patch.setUniverseFrame(universe, bytes, startAddress);
    }

    // ── Boucle ────────────────────────────────────────────────────────────

    update(dt) {
        if (this._spots.size === 0 && !this._sourcesActive()) {
            this.volumePass.enabled = false;
            this.ssLights.collect(this._spots.values());
            this.ssPass.enabled = this._haloOn();
            this.poolPass.enabled = false;
            this.fx.update(this.poolPass);
            this.batch.glareMesh.visible = false;
            return;
        }
        this._time += dt;
        for (const hook of this._updateHooks) hook(dt);
        this.patch.update();
        this.effects.apply(this._spots, this.clock());
        for (const s of this._spots.values()) {
            s.update(dt);
            s.ssDepth = this._isSSDepth(s);
        }
        for (const src of this._sources) src.update(dt);
        this.batch.assemble(this._spots.values(), this._sources, this.camera);
        getSpotHousingInstancer(this.scene).flush();
        // Image de fenêtre des lyres à gobo : une fois par image, lue ensuite par les faisceaux
        this.batch.renderGateAtlas(this.renderer);

        // Fumée : même vent que les nappes laser
        const u = this.batch.volumeMaterial.uniforms;
        const smoke = this.laserManager && this.laserManager._globalSmokeState;
        if (smoke && smoke.wind) u.uWind.value.copy(smoke.wind);
        else u.uWind.value.set(this._time * 0.18, this._time * 0.04, this._time * 0.13);
        u.uTime.value = this._time;

        this.volumePass.enabled = this._hasPass && this.batch.volumeCount > 0;
        // Ombres statiques : emplacements, invalidations (lyre déplacée, décor modifié), quelques cuissons
        this.shadows.update(this._spots.values());
        // Cônes : faisceaux des lyres SS Depth + taches de toutes les lyres (triés par tuile au rendu)
        // (taches décrites aussi pour la GI : sa grille est éclairée par les taches)
        const pools = this._poolsOn();
        const gi = this.fx.giWanted();
        this.ssLights.collect(this._spots.values(), pools || gi);
        this.ssPass.enabled = this._hasSSPass && (this.ssLights.beamCones > 0 || this._haloOn());
        this.poolPass.pools = pools;
        this.fx.update(this.poolPass);
        this.poolPass.enabled = this._hasPoolPass && ((pools && this.ssLights.poolCones > 0) || this.poolPass.giGain > 0);
        if (pools || gi) this._findGrass();

        // Résolution réduite tant que la caméra est dans un faisceau (maintenue 0,5 s : pas de va-et-vient)
        if (this.volumePass.enabled && this._cameraInsideBeam()) this._insideHold = 0.5;
        else this._insideHold = Math.max(0, this._insideHold - dt);
        const want = this._insideHold > 0 ? INSIDE_RES_FACTOR : 1;
        // Beaucoup de faisceaux à l'écran (mode auto) : un cran de résolution en moins
        const busy = nextBusyState(this._busy, this.volumePass.enabled ? (this.batch.volumeSources || 0) : 0, this._beamSetting());
        if (want !== this._insideScale || busy !== this._busy) {
            this._insideScale = want;
            this._busy = busy;
            this._applyVolumeResolution();
        }
    }

    dispose() {
        for (const s of this._spots.values()) s.dispose();
        this._spots.clear();
        this.shadows.dispose();
        this.poolPass.dispose();
        this.fx.dispose();
        this.volumePass.dispose();
        this.ssPass.dispose();
        this.ssLights.dispose();
    }
}
