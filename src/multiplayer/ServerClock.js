/**
 * ServerClock.js
 * ─────────────────────────────────────────────────────────────
 * Estimation de l'horloge du serveur (façon NTP) à partir d'allers-retours PING / PONG :
 * décalage = heure serveur − (heure locale d'envoi + moitié de l'aller-retour),
 * en gardant la mesure au plus court aller-retour parmi les dernières (la plus fiable).
 *
 * Sert à dater les trames DMX : la régie et les jeux partagent la même horloge
 * même si les horloges des PC diffèrent.
 * ─────────────────────────────────────────────────────────────
 */

const SAMPLES = 8;
const BURST = 6;
const BURST_INTERVAL = 150;
const INTERVAL = 5000;

const localNow = () => performance.timeOrigin + performance.now();

export class ServerClock {
    /** @param {(msg: object) => void} send  envoie un message JSON au serveur */
    constructor(send) {
        this._send = send;
        this._samples = [];
        this._timer = null;
        this.offset = 0;       // heure serveur − heure locale (ms)
        this.rtt = null;       // aller-retour de la meilleure mesure récente (ms)
        this.synced = false;
    }

    start() {
        this.stop();
        let n = 0;
        const burst = () => {
            this.ping();
            if (++n < BURST) this._timer = setTimeout(burst, BURST_INTERVAL);
            else this._timer = setInterval(() => this.ping(), INTERVAL);
        };
        burst();
    }

    stop() {
        clearTimeout(this._timer);
        clearInterval(this._timer);
        this._timer = null;
    }

    ping() {
        this._send({ type: 'PING', t: localNow() });
    }

    /** À appeler à la réception d'un PONG { t, serverTime } */
    onPong(msg) {
        if (typeof msg.t !== 'number' || typeof msg.serverTime !== 'number') return;
        const now = localNow();
        const rtt = now - msg.t;
        if (!(rtt >= 0) || rtt > 10000) return;
        this._samples.push({ rtt, offset: msg.serverTime - (msg.t + rtt / 2) });
        if (this._samples.length > SAMPLES) this._samples.shift();
        let best = this._samples[0];
        for (const s of this._samples) if (s.rtt < best.rtt) best = s;
        this.offset = best.offset;
        this.rtt = best.rtt;
        this.synced = true;
    }

    /** Heure du serveur estimée (ms) */
    now() {
        return localNow() + this.offset;
    }
}
