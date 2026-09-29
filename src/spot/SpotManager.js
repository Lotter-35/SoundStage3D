/**
 * SpotManager.js
 * ─────────────────────────────────────────────────────────────
 * Orchestrateur des lyres Spot :
 *   - ajout / suppression / duplication / recherche (identifiants uniques réseau)
 *   - boucle de mise à jour : DMX → mécanique → batch GPU → pool de lumières réelles
 *   - réglages globaux (fumée, qualité, éclairage réel, ombres)
 *   - point d'entrée DMX : applyDmxFrame(univers, octets)
 *
 * Coût GPU : 1 draw call de faisceaux + 1 d'éblouissements + ~10 de boîtiers
 * quel que soit le nombre de lyres ; 8 lumières réelles au maximum.
 * ─────────────────────────────────────────────────────────────
 */

import { SpotBatch, SpotVolumePass } from './SpotBatch.js?v=2';
import { SpotFixture } from './SpotFixture.js?v=2';
import { SpotLightPool } from './SpotLightPool.js?v=2';
import { getSpotHousingInstancer } from './SpotHousing.js?v=2';
import { DmxPatch } from '../dmx/DmxPatch.js';
import { defaultSpotGlobals, SPOT_GLOBAL_SCHEMA } from './config/spotParams.js';
import { SpotEffects } from './console/SpotEffects.js';

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

        this.batch = new SpotBatch(scene);
        this.patch = new DmxPatch();
        this.pool = new SpotLightPool(scene, renderer, this.batch);
        getSpotHousingInstancer(scene);

        // Faisceaux : passe insérée juste après le rendu de la scène (lit sa profondeur)
        this.volumePass = new SpotVolumePass(this.batch, camera);
        this.volumePass.enabled = false;
        this._hasPass = Boolean(laserManager && typeof laserManager.addScenePass === 'function' && laserManager.addScenePass(this.volumePass));
        // Profondeur de la SCÈNE (et non celle de l'image précédente : une passe placée avant peut échanger les cibles)
        if (this._hasPass) this.volumePass.sceneDepth = laserManager.sceneDepth;
        if (!this._hasPass) console.warn('[SpotManager] Pas de chaîne de post-traitement : faisceaux volumétriques désactivés.');

        this._compiled = false;
        this._time = 0;
        this._applyGlobals();

        // Effets de la console (calculés sur l'horloge commune à tous les joueurs)
        this.effects = new SpotEffects();
        this._clock = () => this._time;
        this._updateHooks = [];
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
        this.pool.release(spot);
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

    _applyGlobals() {
        const g = this.globals;
        const u = this.batch.volumeMaterial.uniforms;
        u.uHaze.value = (this._hazeOverride !== null && this._hazeOverride !== undefined) ? this._hazeOverride : g.hazeDensity;
        u.uHazeContrast.value = g.hazeContrast;
        u.uHazeScale.value = g.hazeScale;
        u.uPhaseG.value = g.scattering;
        this.volumePass.setResolutionScale(g.beamQuality === 'Pleine résolution' ? 1.0 : 0.5);
        this.pool.setShadows(g.lightShadows);
    }

    // ── DMX ───────────────────────────────────────────────────────────────

    /** Trame DMX reçue (future source Art-Net / sACN via le serveur) */
    applyDmxFrame(universe, bytes, startAddress = 1) {
        this.patch.setUniverseFrame(universe, bytes, startAddress);
    }

    // ── Boucle ────────────────────────────────────────────────────────────

    update(dt) {
        if (this._spots.size === 0) {
            this.volumePass.enabled = false;
            this.batch.glareMesh.visible = false;
            this.pool.update(this._spots.values(), this.camera, false, dt);
            return;
        }
        this._time += dt;
        for (const hook of this._updateHooks) hook(dt);
        this.patch.update();
        this.effects.apply(this._spots, this.clock());
        for (const s of this._spots.values()) s.update(dt);
        this.batch.assemble(this._spots.values());
        getSpotHousingInstancer(this.scene).flush();

        // Fumée : même vent que les nappes laser
        const u = this.batch.volumeMaterial.uniforms;
        const smoke = this.laserManager && this.laserManager._globalSmokeState;
        if (smoke && smoke.wind) u.uWind.value.copy(smoke.wind);
        else u.uWind.value.set(this._time * 0.18, this._time * 0.04, this._time * 0.13);
        u.uTime.value = this._time;

        this.volumePass.enabled = this._hasPass && this.batch.volumes.count > 0;
        this.pool.update(this._spots.values(), this.camera, this.globals.realLights, dt);
    }

    dispose() {
        for (const s of this._spots.values()) s.dispose();
        this._spots.clear();
        this.pool.dispose();
        this.volumePass.dispose();
    }
}
