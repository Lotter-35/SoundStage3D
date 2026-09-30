/**
 * Laser2Manager.js
 * ─────────────────────────────────────────────────────────────
 * Orchestrateur des nouveaux lasers (moteur de points + galvos) :
 *   - ajout / suppression / duplication / recherche (identifiants uniques réseau)
 *   - mise à jour sur l'horloge commune (même image chez tous les joueurs)
 *   - rendu batché : 2 draw calls pour tous les faisceaux et nappes, 3 pour tous les boîtiers
 *
 * Coexiste avec l'ancien système laser (src/laser/), voué à être supprimé.
 * ─────────────────────────────────────────────────────────────
 */

import { Laser2Fixture } from './Laser2Fixture.js';
import { Laser2Batch } from './Laser2Batch.js';
import { getLaser2HousingInstancer } from './Laser2Housing.js';

function makeId() {
    return 'laser2-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

export class Laser2Manager {
    /**
     * @param {object} o
     * @param {THREE.Scene} o.scene
     * @param {THREE.PerspectiveCamera} o.camera
     * @param {THREE.WebGLRenderer} o.renderer
     * @param {() => number} o.clock horloge commune (s)
     */
    constructor({ scene, camera, renderer, clock }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.clock = clock;
        this._lasers = new Map();
        this._nextNumber = 1;
        this.batch = new Laser2Batch(scene);
        this._instancer = getLaser2HousingInstancer(scene);
        this.cpuMs = 0;
    }

    addLaser(position = null, params = {}, id = null) {
        const laserId = id || makeId();
        if (this._lasers.has(laserId)) return { id: laserId, laser: this._lasers.get(laserId) };
        const p = { ...params };
        if (position) {
            p.posX = Math.round(position.x * 100) / 100;
            p.posY = Math.round(position.y * 100) / 100;
            p.posZ = Math.round(position.z * 100) / 100;
        }
        const laser = new Laser2Fixture({
            id: laserId,
            number: this._nextNumber++,
            scene: this.scene,
            clock: () => this.clock(),
            params: p,
        });
        this._lasers.set(laserId, laser);
        return { id: laserId, laser };
    }

    removeLaser(id) {
        const l = this._lasers.get(id);
        if (!l) return false;
        l.dispose();
        this._lasers.delete(id);
        return true;
    }

    duplicateLaser(id) {
        const src = this._lasers.get(id);
        if (!src) return null;
        const params = { ...src.params };
        params.posX += 0.6;
        return this.addLaser(null, params);
    }

    getLaser(id) {
        return this._lasers.get(id) || null;
    }

    getAllLasers() {
        return Array.from(this._lasers.values());
    }

    get count() {
        return this._lasers.size;
    }

    getLaserObjects() {
        const out = [];
        for (const l of this._lasers.values()) out.push(l.pickMesh);
        return out;
    }

    getLaserFromObject(obj) {
        let cur = obj;
        while (cur) {
            if (cur.userData && cur.userData.laser2Instance) return cur.userData.laser2Instance;
            cur = cur.parent;
        }
        return null;
    }

    update() {
        const t0 = performance.now();
        for (const l of this._lasers.values()) l.update();
        this.batch.assemble(this._lasers.values(), this.camera, this.renderer);
        this._instancer.flush();
        this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.05;
    }

    dispose() {
        for (const l of this._lasers.values()) l.dispose();
        this._lasers.clear();
        this.batch.dispose();
    }
}
