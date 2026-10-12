/**
 * DmxReceiver.js
 * ─────────────────────────────────────────────────────────────
 * Réception des trames DMX de la régie dans le jeu.
 *
 * Chaque trame porte son heure d'affichage (horloge du serveur) : la régie calcule
 * avec un peu d'avance, la trame attend ici son heure puis est appliquée aux univers
 * du patch. Tous les joueurs voient donc la même lumière au même moment, quel que soit
 * leur délai réseau. Une trame arrivée après son heure est appliquée tout de suite
 * (comptée « en retard »).
 * ─────────────────────────────────────────────────────────────
 */

/** Au-delà, les trames en attente les plus anciennes sont appliquées d'office (onglet caché, horloge faussée) */
const MAX_QUEUE = 240;

export class DmxReceiver {
    /**
     * @param {object} o
     * @param {(universe: number, bytes: Uint8Array, start: number) => void} o.apply
     * @param {() => number} o.now  heure du serveur estimée (ms)
     */
    constructor({ apply, now }) {
        this._apply = apply;
        this._now = now;
        this._queue = [];
        this.stats = {
            packets: 0,      // trames reçues
            bytes: 0,        // octets de canaux reçus
            late: 0,         // trames arrivées après leur heure d'affichage
            lastLead: 0,     // avance de la dernière trame à son arrivée (ms, négatif = en retard)
            queued: 0,       // trames en attente
        };
    }

    /** @param {{time: number, blocks: {universe: number, start: number, data: Uint8Array}[]}} packet */
    push(packet) {
        const st = this.stats;
        st.packets++;
        for (const b of packet.blocks) st.bytes += b.data.length;
        const lead = packet.time > 0 ? packet.time - this._now() : 0;
        st.lastLead = lead;
        if (lead <= 0) {
            if (packet.time > 0) st.late++;
            this._applyPacket(packet);
            return;
        }
        // Les trames d'une même régie arrivent dans l'ordre ; tri conservé si plusieurs régies se mélangent
        const q = this._queue;
        let i = q.length;
        while (i > 0 && q[i - 1].time > packet.time) i--;
        q.splice(i, 0, packet);
        while (q.length > MAX_QUEUE) this._applyPacket(q.shift());
        st.queued = q.length;
    }

    /** À appeler à chaque image, avant la mise à jour des projecteurs */
    update() {
        const q = this._queue;
        if (q.length === 0) return;
        const now = this._now();
        let n = 0;
        while (n < q.length && q[n].time <= now) this._applyPacket(q[n++]);
        if (n > 0) q.splice(0, n);
        this.stats.queued = q.length;
    }

    _applyPacket(packet) {
        for (const b of packet.blocks) this._apply(b.universe, b.data, b.start);
    }
}
