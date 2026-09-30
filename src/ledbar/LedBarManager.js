/**
 * LedBarManager.js
 * ─────────────────────────────────────────────────────────────
 * Orchestrateur des barres LED motorisées :
 *   - ajout / suppression / duplication / recherche (identifiants uniques réseau)
 *   - branché sur le SpotManager : mêmes faisceaux batchés (1 draw call pour lyres + LED),
 *     même patch DMX, même horloge commune (effets identiques chez tous les joueurs)
 *   - point d'entrée DMX : celui des lyres (spotManager.applyDmxFrame)
 *
 * Coût : aucune lumière Three.js, aucun nouveau shader ; ~5 draw calls de boîtiers
 * pour toutes les barres. Une LED éteinte ne dessine pas de faisceau.
 * ─────────────────────────────────────────────────────────────
 */

import { LedBarFixture } from './LedBarFixture.js';
import { getLedBarHousingInstancer } from './LedBarHousing.js';

function makeId() {
    return 'ledbar-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

export class LedBarManager {
    /**
     * @param {object} o
     * @param {THREE.Scene} o.scene
     * @param {import('../spot/SpotManager.js').SpotManager} o.spotManager
     */
    constructor({ scene, spotManager }) {
        this.scene = scene;
        this.spotManager = spotManager;
        this.batch = spotManager.batch;
        this.patch = spotManager.patch;
        this._bars = new Map();
        this._nextNumber = 1;
        this._instancer = getLedBarHousingInstancer(scene);
        spotManager.addSource(this);
    }

    addBar(position = null, params = {}, id = null) {
        const barId = id || makeId();
        if (this._bars.has(barId)) return { id: barId, bar: this._bars.get(barId) };
        const p = { ...params };
        if (position) {
            p.posX = Math.round(position.x * 100) / 100;
            p.posY = Math.round(position.y * 100) / 100;
            p.posZ = Math.round(position.z * 100) / 100;
        }
        const bar = new LedBarFixture({
            id: barId,
            number: this._nextNumber++,
            scene: this.scene,
            batch: this.batch,
            patch: this.patch,
            clock: () => this.spotManager.clock(),
            params: p,
        });
        if (!id && params.dmxAddress === undefined) this._autoPatch(bar);
        this._bars.set(barId, bar);
        return { id: barId, bar };
    }

    removeBar(id) {
        const bar = this._bars.get(id);
        if (!bar) return false;
        bar.dispose();
        this._bars.delete(id);
        return true;
    }

    duplicateBar(id) {
        const src = this._bars.get(id);
        if (!src) return null;
        const params = { ...src.params, pixels: [...src.params.pixels] };
        params.posY += 0.5;
        delete params.dmxAddress;
        return this.addBar(null, params);
    }

    /** Première adresse libre, en passant à l'univers suivant quand le courant est plein */
    _autoPatch(bar) {
        for (let u = bar.dmxUniverse; u <= 64; u++) {
            const addr = this.patch.findFreeAddress(u, bar.dmxFootprint, bar);
            if (addr > 0) {
                bar.params.dmxUniverse = u;
                bar.params.dmxAddress = addr;
                this.patch.invalidate(bar);
                return;
            }
        }
    }

    getBar(id) {
        return this._bars.get(id) || null;
    }

    getAllBars() {
        return Array.from(this._bars.values());
    }

    get count() {
        return this._bars.size;
    }

    getBarObjects() {
        const out = [];
        for (const b of this._bars.values()) out.push(b.pickMesh);
        return out;
    }

    getBarFromObject(obj) {
        let cur = obj;
        while (cur) {
            if (cur.userData && cur.userData.ledBarInstance) return cur.userData.ledBarInstance;
            cur = cur.parent;
        }
        return null;
    }

    // ── Appelés par SpotManager.update (après le DMX, avant l'assemblage du batch) ──
    update(dt) {
        for (const b of this._bars.values()) b.update(dt);
        this._instancer.flush();
    }

    pushInstances(batch) {
        for (const b of this._bars.values()) b.pushInstances(batch);
    }

    dispose() {
        for (const b of this._bars.values()) b.dispose();
        this._bars.clear();
    }
}
