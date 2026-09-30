/**
 * DmxOutput.js
 * ─────────────────────────────────────────────────────────────
 * Sortie DMX de la régie.
 *
 * `universes` sont les réglages manuels tels que la régie les voit : les siens plus ce
 * qu'envoient les autres régies (le dernier qui parle l'emporte, canal par canal).
 * À chaque tick (30 par seconde), la sortie est composée pour l'heure « maintenant + avance »
 * (horloge du serveur) : réglages manuels, puis la couche des patterns en lecture, puis le
 * grand master et le blackout (seuls canaux d'intensité, les faders restent intacts).
 * Seules les plages modifiées depuis le dernier envoi partent ; les jeux les appliquent à cette heure.
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
        this._master = 1;       // grand master (0…1)
        this._blackout = false;
        /** @type {Map<number, {address: number, fineAddress?: number}[]>} canaux d'intensité par univers */
        this._intensity = new Map();
        /** @type {Map<number, Uint8Array>} dernière sortie composée (réglages + patterns + master) */
        this._frames = new Map();
        this._scratch = new Map();
        /** @type {((frameOf: (universe: number) => Uint8Array, time: number) => void)|null} couche des patterns */
        this._layer = null;
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
        this._frames.clear();
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

    get master() { return this._master; }
    set master(v) {
        const k = Math.max(0, Math.min(1, Number(v) || 0));
        if (k === this._master) return;
        this._master = k;
        this.version++;
    }

    get blackout() { return this._blackout; }
    set blackout(on) {
        if (Boolean(on) === this._blackout) return;
        this._blackout = Boolean(on);
        this.version++;
    }

    /**
     * Canaux d'intensité soumis au master et au blackout
     * @param {Map<number, {address: number, fineAddress?: number}[]>} map
     */
    setIntensityChannels(map) {
        this._intensity = map;
        this.version++;
    }

    /**
     * Couche écrite par-dessus les réglages manuels à chaque trame (moteur des patterns)
     * @param {(frameOf: (universe: number) => Uint8Array, time: number) => void} fn
     */
    setLayer(fn) {
        this._layer = fn;
    }

    /** Univers tel qu'il part vers les jeux (réglages + patterns + master), à la dernière trame */
    output(n) {
        return this._frames.get(n) || this.universes.get(n);
    }

    /** Grand master / blackout sur les canaux d'intensité d'un univers composé */
    _applyMaster(n, f) {
        const k = this._blackout ? 0 : this._master;
        const list = this._intensity.get(n);
        if (k >= 1 || !list || list.length === 0) return;
        for (const c of list) {
            const i = c.address - 1;
            if (c.fineAddress) {
                const j = c.fineAddress - 1;
                const v16 = Math.round(((f[i] << 8) | f[j]) * k);
                f[i] = (v16 >> 8) & 255;
                f[j] = v16 & 255;
            } else {
                f[i] = Math.round(f[i] * k);
            }
        }
    }

    /** Compose la sortie de l'heure t ; version++ si elle a changé (rafraîchissement de l'interface) */
    _compose(t) {
        const used = new Set();
        const scratch = this._scratch;
        const frameOf = (n) => {
            let f = scratch.get(n);
            if (!f) {
                f = new Uint8Array(DMX_UNIVERSE_SIZE);
                scratch.set(n, f);
            }
            if (!used.has(n)) {
                used.add(n);
                const u = this.universes.get(n);
                if (u) f.set(u);
                else f.fill(0);
            }
            return f;
        };
        for (const n of this.universes.keys()) frameOf(n);
        // Univers écrits seulement par un pattern maintenant arrêté : ils reviennent aux réglages (zéro)
        for (const n of this._frames.keys()) frameOf(n);
        if (this._layer) {
            try { this._layer(frameOf, t); } catch (e) { console.error('[Régie] patterns', e); }
        }
        let changed = false;
        for (const n of used) {
            const s = scratch.get(n);
            this._applyMaster(n, s);
            let f = this._frames.get(n);
            if (!f) {
                f = new Uint8Array(DMX_UNIVERSE_SIZE);
                this._frames.set(n, f);
            }
            for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
                if (f[i] !== s[i]) {
                    f.set(s);
                    changed = true;
                    break;
                }
            }
        }
        if (changed) this.version++;
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
            this._frames.clear();
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
        const t = this._now() + this.lookahead;
        this._compose(t);
        const blocks = [];
        for (const [n, f] of this._frames) {
            for (const b of diffUniverse(n, this._sentCopy(n), f)) blocks.push(b);
        }
        if (blocks.length === 0) return;
        const bytes = encodeDmxPacket(blocks, t);
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
