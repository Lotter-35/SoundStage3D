/**
 * RegieClient.js
 * ─────────────────────────────────────────────────────────────
 * Connexion de la page régie au serveur (WebSocket) :
 *   - rejoint une salle en tant que régie (REGIE_JOIN : pas d'avatar, pas un joueur)
 *   - horloge commune avec le serveur (ServerClock) pour dater les trames DMX
 *   - horloge musicale de la salle (REGIE_PLAYBACK)
 *   - envoi / réception des paquets DMX binaires
 *   - liste des projecteurs de la salle (PATCH), prise de main (LIGHTING_CHANGE),
 *     capture de l'état actuel des projecteurs (FIXTURE_STATE)
 *   - reconnexion automatique à la même salle
 * ─────────────────────────────────────────────────────────────
 */

import { ServerClock } from '../multiplayer/ServerClock.js';
import { DMX_PACKET, decodeDmxPacket } from '../dmx/DmxProtocol.js';

const RECONNECT_DELAY = 2000;      // première tentative de reconnexion (ms)
const RECONNECT_MAX_DELAY = 10000; // puis tentatives de plus en plus espacées
/** Au-delà de ce volume en attente d'envoi, la régie saute des envois (les changements sont repris au suivant) */
const MAX_BUFFERED = 256 * 1024;

/** Adresse du serveur : même logique que le jeu (port web 8067 / 8080 → port audio et WebSocket 8068) */
export function serverBase() {
    const host = window.location.hostname || 'localhost';
    const port = (window.location.port === '8067' || window.location.port === '8080') ? '8068' : (window.location.port || '8068');
    const secure = window.location.protocol === 'https:';
    return { http: `${secure ? 'https' : 'http'}://${host}:${port}`, ws: `${secure ? 'wss' : 'ws'}://${host}:${port}` };
}

export class RegieClient {
    constructor() {
        this._base = serverBase();
        this._ws = null;
        this._listeners = new Map();
        this._roomId = null;
        this._wantOpen = false;
        this._retry = null;
        this._attempts = 0;
        this.clock = new ServerClock((m) => this._sendJson(m));
        this.status = 'idle';        // idle | connecting | open | joined | lost
        this.roomId = null;
        this.playback = { currentTime: 0, isPlaying: false, timestamp: 0 };
        this.trackName = '';
        this.playerCount = 0;
        this._requests = new Map();  // demandes FIXTURE_STATE en attente
        this._requestId = 0;
    }

    on(name, cb) {
        if (!this._listeners.has(name)) this._listeners.set(name, []);
        this._listeners.get(name).push(cb);
    }

    _emit(name, ...args) {
        for (const cb of this._listeners.get(name) || []) {
            try { cb(...args); } catch (e) { console.error('[Régie]', name, e); }
        }
    }

    _setStatus(s) {
        this.status = s;
        this._emit('status', s);
    }

    /** Salles ouvertes sur le serveur */
    async listRooms() {
        const res = await fetch(`${this._base.http}/api/rooms`, { cache: 'no-store' });
        if (res.status === 404) throw new Error('outdated');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    join(roomId) {
        this._roomId = String(roomId || '').trim().toUpperCase();
        this._wantOpen = true;
        this._open();
    }

    leave() {
        this._wantOpen = false;
        clearTimeout(this._retry);
        this.roomId = null;
        if (this._ws) this._ws.close();
        this._ws = null;
        this.clock.stop();
        this._setStatus('idle');
    }

    _open() {
        clearTimeout(this._retry);
        if (this._ws) {
            this._ws.onclose = null;
            this._ws.close();
        }
        this._setStatus('connecting');
        const ws = new WebSocket(this._base.ws);
        ws.binaryType = 'arraybuffer';
        this._ws = ws;
        ws.onopen = () => {
            this._setStatus('open');
            this._attempts = 0;
            this.clock.start();
            this._sendJson({ type: 'REGIE_JOIN', roomId: this._roomId });
        };
        ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                const bytes = new Uint8Array(event.data);
                if (bytes.length > 0 && bytes[0] === DMX_PACKET) {
                    const packet = decodeDmxPacket(bytes);
                    if (packet) this._emit('dmx', packet);
                }
                return;
            }
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            this._handle(msg);
        };
        ws.onclose = () => {
            this.clock.stop();
            if (this._ws !== ws) return;
            this._ws = null;
            if (!this._wantOpen) return;
            this._setStatus('lost');
            this._attempts++;
            this._retry = setTimeout(() => this._open(), Math.min(RECONNECT_MAX_DELAY, RECONNECT_DELAY * this._attempts));
        };
    }

    _handle(msg) {
        switch (msg.type) {
            case 'REGIE_JOINED':
                this.roomId = msg.roomId;
                this._applyPlayback(msg);
                this._setStatus('joined');
                this._emit('joined', msg.roomId);
                break;
            case 'REGIE_PLAYBACK':
                this._applyPlayback(msg);
                break;
            case 'ROOM_NOT_FOUND':
                this._wantOpen = false;
                this._emit('notfound', msg.roomId);
                this.leave();
                break;
            case 'ROOM_CLOSED':
                this._wantOpen = false;
                this._emit('roomclosed', this.roomId);
                this.leave();
                break;
            case 'PONG':
                this.clock.onPong(msg);
                break;
            case 'PATCH':
                this._emit('patch', Array.isArray(msg.fixtures) ? msg.fixtures : []);
                break;
            case 'FIXTURE_STATE': {
                const done = this._requests.get(msg.requestId);
                if (done) done(msg.states || {});
                break;
            }
            case 'ERROR':
                // Serveur lancé avant l'arrivée de la régie : il ne connaît pas REGIE_JOIN
                if (String(msg.message || '').includes('REGIE_JOIN')) {
                    this._wantOpen = false;
                    this._emit('outdated');
                    this.leave();
                }
                break;
            default:
                break;
        }
    }

    _applyPlayback(msg) {
        if (msg.playback) this.playback = msg.playback;
        if (msg.trackName !== undefined) this.trackName = msg.trackName;
        if (msg.playerCount !== undefined) this.playerCount = msg.playerCount;
        this._emit('playback');
    }

    /** Temps musical de la salle (s), extrapolé sur l'horloge du serveur */
    musicTime() {
        const pb = this.playback;
        if (!pb) return 0;
        const elapsed = pb.isPlaying ? Math.max(0, this.clock.now() - (pb.timestamp || 0)) / 1000 : 0;
        return (pb.currentTime || 0) + elapsed;
    }

    /** true si un paquet peut partir tout de suite (connecté, file d'envoi raisonnable) */
    canSend() {
        return this.status === 'joined' && this._ws && this._ws.readyState === WebSocket.OPEN && this._ws.bufferedAmount < MAX_BUFFERED;
    }

    sendBinary(bytes) {
        if (!this.canSend()) return false;
        this._ws.send(bytes);
        return true;
    }

    /** Modification de réglages de projecteurs, comme depuis le jeu (appliquée par tous les joueurs) */
    sendLighting(change) {
        this._sendJson({ ...change, type: 'LIGHTING_CHANGE' });
    }

    /**
     * Valeurs DMX équivalentes aux réglages actuels de projecteurs, calculées par un joueur
     * @param {string[]} keys clés « type:id »
     * @returns {Promise<Object<string, {universe: number, address: number, values: number[]}>|null>} null si pas de réponse
     */
    requestFixtureState(keys, timeout = 1500) {
        const requestId = ++this._requestId;
        return new Promise((resolve) => {
            const timer = setTimeout(() => { this._requests.delete(requestId); resolve(null); }, timeout);
            this._requests.set(requestId, (states) => {
                clearTimeout(timer);
                this._requests.delete(requestId);
                resolve(states);
            });
            this._sendJson({ type: 'FIXTURE_STATE_REQUEST', requestId, keys });
        });
    }

    _sendJson(m) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send(JSON.stringify(m));
    }
}
