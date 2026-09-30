/**
 * artnetInput.js
 * ─────────────────────────────────────────────────────────────
 * Entrée Art-Net du serveur : une console (ou régie) qui envoie de l'Art-Net sur le réseau local
 * pilote les projecteurs du jeu, comme la page /regie.
 *
 *   - UDP 6454 : paquets ArtDmx (OpCode 0x5000) → univers du jeu = Port-Address Art-Net + 1
 *     (Art-Net 0:0:0 = univers 1 du jeu, 0:0:3 = univers 4 = premiers lasers…)
 *   - ArtPoll (0x2000) → ArtPollReply : le serveur apparaît comme un nœud Art-Net (4 ports de sortie)
 *     dans les consoles qui font une découverte
 *   - les trames identiques à la précédente ne sont pas renvoyées (sauf rappel toutes les secondes)
 * ─────────────────────────────────────────────────────────────
 */

const dgram = require('dgram');
const os = require('os');

const ARTNET_PORT = 6454;
const OP_POLL = 0x2000;
const OP_POLL_REPLY = 0x2100;
const OP_DMX = 0x5000;
const REFRESH_MS = 1000;

function localIPv4() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return '127.0.0.1';
}

function pollReply() {
    const b = Buffer.alloc(239);
    b.write('Art-Net\0', 0, 'ascii');
    b.writeUInt16LE(OP_POLL_REPLY, 8);
    localIPv4().split('.').forEach((v, i) => { b[10 + i] = Number(v) & 255; });
    b.writeUInt16LE(ARTNET_PORT, 14);
    b.writeUInt16BE(1, 16);                  // version du micrologiciel
    b[18] = 0; b[19] = 0;                    // Net, Sub-Net
    b.writeUInt16BE(0x5353, 20);             // OEM (« SS »)
    b[23] = 0xd0;                            // Status1 : adresse programmée par le panneau
    b.write('SoundStage3D', 26, 'ascii');    // nom court (18)
    b.write('SoundStage3D - jeu (projecteurs, lasers)', 44, 'ascii'); // nom long (64)
    b.write('#0001 [0000] OK', 108, 'ascii'); // rapport (64)
    b.writeUInt16BE(4, 172);                 // 4 ports
    for (let i = 0; i < 4; i++) {
        b[174 + i] = 0x80;                   // port de sortie DMX512 (reçoit depuis le réseau)
        b[182 + i] = 0x80;                   // GoodOutput : données en cours
        b[190 + i] = i;                      // SwOut : univers 0…3
    }
    b[211] = 0x08;                           // Status2 : Art-Net 3 (adresses 15 bits)
    return b;
}

/**
 * @param {object} o
 * @param {(universe: number, data: Buffer) => void} o.onDmx trame reçue (univers du jeu, 1…)
 * @param {number} [o.maxUniverse]
 */
function initArtNet({ onDmx, maxUniverse = 64 }) {
    const last = new Map();   // univers → { data, time }
    let sock;
    try {
        sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (e) {
        console.warn('[Art-Net] Socket UDP impossible :', e.message);
        return null;
    }
    sock.on('error', (e) => console.warn(`[Art-Net] Port UDP ${ARTNET_PORT} indisponible (${e.message}) : entrée Art-Net désactivée`));
    sock.on('message', (msg, rinfo) => {
        if (msg.length < 10 || msg.toString('ascii', 0, 8) !== 'Art-Net\0') return;
        const op = msg.readUInt16LE(8);
        if (op === OP_DMX) {
            if (msg.length < 18) return;
            const portAddress = msg.readUInt16LE(14) & 0x7fff;   // SubUni (bas) + Net (haut)
            const len = Math.min(512, msg.readUInt16BE(16), msg.length - 18);
            const universe = portAddress + 1;
            if (universe > maxUniverse || len <= 0) return;
            const data = msg.subarray(18, 18 + len);
            const now = Date.now();
            const prev = last.get(universe);
            if (prev && prev.data.length === data.length && prev.data.equals(data) && now - prev.time < REFRESH_MS) return;
            last.set(universe, { data: Buffer.from(data), time: now });
            onDmx(universe, data);
        } else if (op === OP_POLL) {
            sock.send(pollReply(), ARTNET_PORT, rinfo.address);
        }
    });
    sock.bind(ARTNET_PORT, () => {
        try { sock.setBroadcast(true); } catch (_) {}
        console.log(`[Art-Net] Entrée Art-Net à l'écoute (UDP ${ARTNET_PORT}) : univers Art-Net 0 = univers 1 du jeu`);
    });
    return sock;
}

module.exports = { initArtNet };
