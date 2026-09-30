/**
 * DmxOutput.js
 * ─────────────────────────────────────────────────────────────
 * Sortie DMX de la régie.
 *
 * `universes` est l'état DMX de la salle tel que la régie le voit : ses propres réglages
 * plus ce qu'envoient les autres régies (le dernier qui parle l'emporte, canal par canal).
 * À chaque tick (30 par seconde), seules les plages modifiées depuis le dernier envoi partent,
 * datées « maintenant + avance » sur l'horloge du serveur : les jeux les appliquent à cette heure.
 *
 * Le tick vient d'un Worker : les minuteries d'un onglet caché sont ralenties à 1 par seconde,
 * pas celles d'un Worker (la régie continue d'émettre quand on passe sur l'onglet du jeu).
 * ─────────────────────────────────────────────────────────────
 */

import { encodeDmxPacket, diffUniverse, DMX_UNIVERSE_SIZE, DMX_MAX_UNIVERSE } from '../dmx/DmxProtocol.js';

export const OUTPUT_RATE = 30;

function makeTicker(hz, cb) {
    const src = 'let t=null;onmessage=e=>{clearInterval(t);t=e.data>0?setInterval(()=>postMessage(0),e.data):null};';
    try {
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        const worker = new Worker(url);
        URL.revokeObjectURL(url);
        worker.onmessage = cb;
        worker.postMessage(1000 / hz);
        return { stop: () => worker.terminate() };
    } catch (_) {
        const t = setInterval(cb, 1000 / hz);
        return { stop: () => clearInterval(t) };
    }
}

export class DmxOutput {
    /**
     * @param {object} o
     * @param {(bytes: Uint8Array) => boolean} o.send  envoie un paquet (false si impossible pour l'instant)
     * @param {() => number} o.now                      heure du serveur estimée (ms)
     */
    constructor({ send, now }) {
        this._send = send;
        this._now = now;
        /** @type {Map<number, Uint8Array>} */
        this.universes = new Map();
        /** @type {Map<number, Uint8Array>} dernier état envoyé ou reçu, par univers */
        this._sent = new Map();
        this.lookahead = 100;   // avance des trames sur l'heure d'affichage (ms)
        this.version = 0;       // incrémenté à chaque changement (rafraîchissement de l'interface)
        this._ticker = null;
        this._win = { t: performance.now(), outBytes: 0, outPackets: 0, inBytes: 0 };
        this.stats = { outBytesPerSec: 0, outPacketsPerSec: 0, inBytesPerSec: 0 };
    }

    start() {
        if (!this._ticker) this._ticker = makeTicker(OUTPUT_RATE, () => this.tick());
    }

    stop() {
        if (this._ticker) this._ticker.stop();
        this._ticker = null;
    }

    /** Oublie tout l'état (changement de salle) */
    reset() {
        this.universes.clear();
        this._sent.clear();
        this.version++;
    }

    universe(n) {
        let u = this.universes.get(n);
        if (!u) {
            u = new Uint8Array(DMX_UNIVERSE_SIZE);
            this.universes.set(n, u);
        }
        return u;
    }

    _sentCopy(n) {
        let u = this._sent.get(n);
        if (!u) {
            u = new Uint8Array(DMX_UNIVERSE_SIZE);
            this._sent.set(n, u);
        }
        return u;
    }

    get(universe, address) {
        const u = this.universes.get(universe);
        return u ? u[address - 1] : 0;
    }

    /** Réglage d'un canal par cette régie (envoyé au prochain tick) */
    set(universe, address, value) {
        if (universe < 1 || universe > DMX_MAX_UNIVERSE || address < 1 || address > DMX_UNIVERSE_SIZE) return;
        const v = value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
        const u = this.universe(universe);
        if (u[address - 1] === v) return;
        u[address - 1] = v;
        this.version++;
    }

    /** Paquet reçu du serveur (état d'arrivée ou autre régie) : ce n'est pas à renvoyer */
    receive(packet) {
        if (packet.full) {
            this.universes.clear();
            this._sent.clear();
        }
        for (const b of packet.blocks) {
            this.universe(b.universe).set(b.data, b.start - 1);
            this._sentCopy(b.universe).set(b.data, b.start - 1);
            this._win.inBytes += b.data.length;
        }
        this.version++;
    }

    tick() {
        this._updateStats();
        const blocks = [];
        for (const [n, u] of this.universes) {
            const prev = this._sentCopy(n);
            for (const b of diffUniverse(n, prev, u)) blocks.push(b);
        }
        if (blocks.length === 0) return;
        const bytes = encodeDmxPacket(blocks, this._now() + this.lookahead);
        if (!this._send(bytes)) return; // pas envoyé : les changements repartiront au prochain tick
        for (const b of blocks) this._sentCopy(b.universe).set(b.data, b.start - 1);
        this._win.outBytes += bytes.length;
        this._win.outPackets++;
    }

    _updateStats() {
        const w = this._win;
        const now = performance.now();
        const dt = now - w.t;
        if (dt < 1000) return;
        this.stats.outBytesPerSec = w.outBytes * 1000 / dt;
        this.stats.outPacketsPerSec = w.outPackets * 1000 / dt;
        this.stats.inBytesPerSec = w.inBytes * 1000 / dt;
        w.t = now;
        w.outBytes = 0;
        w.outPackets = 0;
        w.inBytes = 0;
    }
}
