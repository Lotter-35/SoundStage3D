/**
 * DmxProtocol.js
 * ─────────────────────────────────────────────────────────────
 * Paquets DMX binaires échangés entre la régie, le serveur et les jeux (WebSocket).
 *
 * Format (petit-boutiste) :
 *   0   u8   0x02                  type « DMX » (0x01 = voix)
 *   1   u8   drapeaux              bit 0 : univers complets (état d'arrivée, remplace tout)
 *   2   f64  heure d'affichage     horloge du serveur, en ms ; 0 = appliquer tout de suite
 *   10  u16  nombre de blocs
 *   puis pour chaque bloc :
 *       u16  univers (1…)
 *       u16  adresse de départ (1…512)
 *       u16  longueur n
 *       n    octets (valeurs des canaux)
 *
 * La régie n'envoie que les plages de canaux modifiées ; le serveur garde l'état
 * complet de chaque salle (copie du décodage dans server/server.js).
 * ─────────────────────────────────────────────────────────────
 */

export const DMX_PACKET = 0x02;
export const DMX_FLAG_FULL = 0x01;
export const DMX_UNIVERSE_SIZE = 512;
/** Univers utilisables (le patch automatique des projecteurs va jusqu'à 64) */
export const DMX_MAX_UNIVERSE = 64;

const HEADER = 12;
const BLOCK_HEADER = 6;
/** Deux plages modifiées séparées par au plus ce nombre de canaux inchangés sont envoyées en un seul bloc */
const MERGE_GAP = BLOCK_HEADER;

/**
 * @param {{universe: number, start: number, data: Uint8Array}[]} blocks
 * @param {number} time  heure d'affichage (horloge serveur, ms), 0 = tout de suite
 * @param {boolean} [full]
 * @returns {Uint8Array}
 */
export function encodeDmxPacket(blocks, time, full = false) {
    let size = HEADER;
    for (const b of blocks) size += BLOCK_HEADER + b.data.length;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    out[0] = DMX_PACKET;
    out[1] = full ? DMX_FLAG_FULL : 0;
    view.setFloat64(2, time, true);
    view.setUint16(10, blocks.length, true);
    let o = HEADER;
    for (const b of blocks) {
        view.setUint16(o, b.universe, true);
        view.setUint16(o + 2, b.start, true);
        view.setUint16(o + 4, b.data.length, true);
        out.set(b.data, o + BLOCK_HEADER);
        o += BLOCK_HEADER + b.data.length;
    }
    return out;
}

/**
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {{time: number, full: boolean, blocks: {universe: number, start: number, data: Uint8Array}[]} | null}
 */
export function decodeDmxPacket(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (bytes.length < HEADER || bytes[0] !== DMX_PACKET) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const time = view.getFloat64(2, true);
    const count = view.getUint16(10, true);
    const blocks = [];
    let o = HEADER;
    for (let i = 0; i < count; i++) {
        if (o + BLOCK_HEADER > bytes.length) return null;
        const universe = view.getUint16(o, true);
        const start = view.getUint16(o + 2, true);
        const len = view.getUint16(o + 4, true);
        o += BLOCK_HEADER;
        if (o + len > bytes.length) return null;
        if (universe >= 1 && universe <= DMX_MAX_UNIVERSE && start >= 1 && start + len - 1 <= DMX_UNIVERSE_SIZE) {
            blocks.push({ universe, start, data: bytes.subarray(o, o + len) });
        }
        o += len;
    }
    return { time: Number.isFinite(time) ? time : 0, full: (bytes[1] & DMX_FLAG_FULL) !== 0, blocks };
}

/**
 * Plages de canaux qui diffèrent entre `prev` et `next` (même univers), en blocs prêts à envoyer.
 * @param {number} universe
 * @param {Uint8Array} prev
 * @param {Uint8Array} next
 */
export function diffUniverse(universe, prev, next) {
    const blocks = [];
    let i = 0;
    const n = DMX_UNIVERSE_SIZE;
    while (i < n) {
        if (prev[i] === next[i]) { i++; continue; }
        const start = i;
        let end = i;          // dernier canal modifié de la plage
        let j = i + 1;
        while (j < n) {
            if (prev[j] !== next[j]) { end = j; j++; continue; }
            if (j - end > MERGE_GAP) break;
            j++;
        }
        blocks.push({ universe, start: start + 1, data: next.slice(start, end + 1) });
        i = end + 1;
    }
    return blocks;
}
