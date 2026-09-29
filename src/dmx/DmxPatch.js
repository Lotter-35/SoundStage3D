/**
 * DmxPatch.js
 * ─────────────────────────────────────────────────────────────
 * Patch DMX de la scène : quels projecteurs écoutent quelles adresses.
 *
 * Chaque projecteur patché fournit :
 *   - dmxUniverse, dmxAddress (1…512), dmxFootprint (nombre de canaux)
 *   - applyDmx(universe)  → décode ses canaux vers ses attributs
 *
 * Point d'entrée des futures sources DMX (logiciel de lumière → Art-Net / sACN) :
 * le navigateur ne peut pas recevoir d'UDP, la réception se fera côté serveur
 * (pont UDP → WebSocket) qui appellera setUniverseFrame() sur chaque client.
 * ─────────────────────────────────────────────────────────────
 */

import { DmxUniverse, DMX_CHANNELS } from './DmxUniverse.js';

export class DmxPatch {
    constructor() {
        /** @type {Map<number, DmxUniverse>} */
        this.universes = new Map();
        /** @type {Set<object>} */
        this.fixtures = new Set();
        this._lastVersions = new WeakMap();
    }

    getUniverse(number) {
        let u = this.universes.get(number);
        if (!u) {
            u = new DmxUniverse(number);
            this.universes.set(number, u);
        }
        return u;
    }

    register(fixture) {
        this.fixtures.add(fixture);
    }

    unregister(fixture) {
        this.fixtures.delete(fixture);
    }

    /** Reçoit une trame complète (ou partielle) pour un univers */
    setUniverseFrame(number, bytes, startAddress = 1) {
        this.getUniverse(number).setFrame(bytes, startAddress);
    }

    /**
     * Liste des projecteurs dont la plage de canaux chevauche celle de `fixture`
     * @returns {object[]}
     */
    conflictsOf(fixture) {
        const out = [];
        const a0 = fixture.dmxAddress;
        const a1 = a0 + fixture.dmxFootprint - 1;
        for (const other of this.fixtures) {
            if (other === fixture || other.dmxUniverse !== fixture.dmxUniverse) continue;
            const b0 = other.dmxAddress;
            const b1 = b0 + other.dmxFootprint - 1;
            if (a0 <= b1 && b0 <= a1) out.push(other);
        }
        return out;
    }

    /** true si la plage de canaux dépasse l'adresse 512 */
    overflows(fixture) {
        return fixture.dmxAddress + fixture.dmxFootprint - 1 > DMX_CHANNELS;
    }

    /** Première adresse libre d'un univers pouvant accueillir `footprint` canaux (ou -1) */
    findFreeAddress(universe, footprint, exclude = null) {
        const used = new Uint8Array(DMX_CHANNELS + 1);
        for (const f of this.fixtures) {
            if (f === exclude || f.dmxUniverse !== universe) continue;
            for (let a = f.dmxAddress; a < f.dmxAddress + f.dmxFootprint && a <= DMX_CHANNELS; a++) used[a] = 1;
        }
        for (let start = 1; start + footprint - 1 <= DMX_CHANNELS; start++) {
            let free = true;
            for (let a = start; a < start + footprint; a++) {
                if (used[a]) { free = false; start = a; break; }
            }
            if (free) return start;
        }
        return -1;
    }

    /**
     * Applique les univers modifiés aux projecteurs en mode « piloté par DMX ».
     * À appeler une fois par frame, avant la mise à jour des projecteurs.
     */
    update() {
        for (const fixture of this.fixtures) {
            if (!fixture.dmxControlled) continue;
            const u = this.universes.get(fixture.dmxUniverse);
            if (!u) continue;
            if (this._lastVersions.get(fixture) === u.version) continue;
            this._lastVersions.set(fixture, u.version);
            fixture.applyDmx(u);
        }
    }

    /** Force le re-décodage d'un projecteur (changement d'adresse ou de mode) */
    invalidate(fixture) {
        this._lastVersions.delete(fixture);
    }
}
