/**
 * IldaLive.js — images ILDA LIVE reçues du serveur (IDN ou POST /api/ilda/live).
 * Paquet binaire 0x03 : [0x03, canal, 0, 0, série u32, nb points u32, puis x i16, y i16, r, g, b].
 * Chaque canal garde sa dernière image ; les lasers réglés sur « ILDA live » + canal la projettent.
 */

import { LaserFrame } from '../Laser2Patterns.js';

export const ILDA_LIVE_PACKET = 0x03;

class IldaLive {
    constructor() {
        this.channels = new Map();   // canal → { serial, frame, time }
    }

    /** @param {Uint8Array} bytes paquet reçu */
    receive(bytes) {
        if (bytes.length < 12 || bytes[0] !== ILDA_LIVE_PACKET) return;
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const ch = bytes[1];
        const serial = v.getUint32(4, true);
        const n = Math.min(v.getUint32(8, true), Math.floor((bytes.length - 12) / 7));
        const f = new LaserFrame(Math.max(1, n));
        for (let i = 0, o = 12; i < n; i++, o += 7) {
            f.push(v.getInt16(o, true) / 32768, v.getInt16(o + 2, true) / 32768, bytes[o + 4] / 255, bytes[o + 5] / 255, bytes[o + 6] / 255);
        }
        if (f.n === 0) f.push(0, 0, 0, 0, 0);
        this.channels.set(ch, { serial, frame: f, time: performance.now() });
    }

    /** Dernière image d'un canal (null si rien reçu) */
    get(ch) {
        return this.channels.get(ch) || null;
    }
}

export const ildaLive = new IldaLive();
