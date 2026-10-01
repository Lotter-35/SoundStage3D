/**
 * ildaLive.js
 * ─────────────────────────────────────────────────────────────
 * ILDA LIVE : un logiciel laser pilote les nouveaux lasers du jeu en direct.
 *
 * Canaux live 1…16 : chaque canal garde sa dernière IMAGE (suite de points). Les lasers du jeu réglés
 * sur « ILDA live » + canal N la projettent (avec la physique des galvos simulée localement).
 * Vers les joueurs, on envoie des IMAGES et non le flux brut de points :
 *   - une image identique à la précédente n'est pas renvoyée (les logiciels répètent la même image)
 *   - au plus 30 images/s par canal
 *   - paquet binaire 0x03 : [0x03, canal, 0, 0, série u32, nb points u32, puis x i16, y i16, r, g, b]
 *
 * Entrées :
 *   1. IDN (ILDA Digital Network, UDP 7255) — standard réseau de l'ILDA : découverte (scan / service map)
 *      et flux temps réel (images « frame » ou échantillons continus). EXPÉRIMENTAL : à valider avec
 *      le logiciel choisi.
 *   2. POST /api/ilda/live?ch=N avec un fichier .ild en corps : n'importe quel outil peut pousser une image.
 * ─────────────────────────────────────────────────────────────
 */

const dgram = require('dgram');
const crypto = require('crypto');

const ILDA_LIVE_PACKET = 0x03;
const MAX_CHANNELS = 16;
const MIN_INTERVAL_MS = 33;
const MAX_POINTS = 20000;

const channels = new Map();   // canal → { packet, hash, serial, time, pending, timer }
let broadcast = null;

// ── Images → paquets ──────────────────────────────────────────────────────────

/**
 * Nouvelle image d'un canal.
 * @param {number} ch canal 1…16
 * @param {{x:number,y:number,r:number,g:number,b:number}[]|{n:number,x:Int16Array,y:Int16Array,r:Uint8Array,g:Uint8Array,b:Uint8Array}} pts
 *        x, y en -32768…32767 ; r, g, b en 0…255
 */
function setLiveFrame(ch, pts) {
    if (!(ch >= 1 && ch <= MAX_CHANNELS)) return;
    const n = Math.min(MAX_POINTS, Array.isArray(pts) ? pts.length : pts.n);
    const buf = Buffer.alloc(12 + n * 7);
    buf[0] = ILDA_LIVE_PACKET;
    buf[1] = ch;
    buf.writeUInt32LE(n, 8);
    let o = 12;
    for (let i = 0; i < n; i++) {
        let x, y, r, g, b;
        if (Array.isArray(pts)) ({ x, y, r, g, b } = pts[i]);
        else { x = pts.x[i]; y = pts.y[i]; r = pts.r[i]; g = pts.g[i]; b = pts.b[i]; }
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, x | 0)), o);
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, y | 0)), o + 2);
        buf[o + 4] = r; buf[o + 5] = g; buf[o + 6] = b;
        o += 7;
    }
    const hash = crypto.createHash('sha1').update(buf.subarray(12)).digest('hex');
    let c = channels.get(ch);
    if (!c) { c = { packet: null, hash: '', serial: 0, time: 0, pending: null, timer: null }; channels.set(ch, c); }
    if (hash === c.hash && !c.pending) return;          // même image : rien à envoyer
    c.pending = { buf, hash };
    const wait = MIN_INTERVAL_MS - (Date.now() - c.time);
    if (wait <= 0) flush(ch);
    else if (!c.timer) c.timer = setTimeout(() => flush(ch), wait);
}

function flush(ch) {
    const c = channels.get(ch);
    if (!c) return;
    c.timer = null;
    if (!c.pending) return;
    const { buf, hash } = c.pending;
    c.pending = null;
    if (hash === c.hash) return;
    c.serial = (c.serial + 1) >>> 0;
    buf.writeUInt32LE(c.serial, 4);
    c.packet = buf;
    c.hash = hash;
    c.time = Date.now();
    if (broadcast) broadcast(buf);
}

/** Dernières images de tous les canaux (joueur qui arrive) */
function liveState() {
    const out = [];
    for (const c of channels.values()) if (c.packet) out.push(c.packet);
    return out;
}

// ── Lecture ILDA minimale (POST /api/ilda/live) ─────────────────────────────

const PALETTE = [];
{
    // Palette ILDA par défaut (64 couleurs)
    const add = (r, g, b) => PALETTE.push([r, g, b]);
    for (let i = 0; i < 16; i++) add(255, i * 16, 0);
    for (let i = 0; i < 8; i++) add(255 - i * 32, 255, 0);
    for (let i = 0; i < 8; i++) add(0, 255, Math.round(i * 36.43));
    for (let i = 0; i < 8; i++) add(0, Math.round(255 - i * 28.4), 255);
    for (let i = 0; i < 8; i++) add(i * 32, 0, 255);
    for (let i = 0; i < 8; i++) add(255, i * 32, 255);
    for (let i = 0; i < 8; i++) add(255, 255 - i * 32, 255 - i * 32);
}

/** Première image d'un fichier .ild → points */
function firstIldaFrame(buf) {
    let o = 0;
    while (o + 32 <= buf.length && buf.toString('ascii', o, o + 4) === 'ILDA') {
        const format = buf[o + 7];
        const count = buf.readUInt16BE(o + 24);
        o += 32;
        const size = { 0: 8, 1: 6, 2: 3, 4: 10, 5: 8 }[format];
        if (!size || count === 0) break;
        if (format === 2) { o += count * 3; continue; }
        const pts = [];
        const is3D = format === 0 || format === 4;
        for (let i = 0; i < count && o + i * size + size <= buf.length; i++) {
            const p = o + i * size;
            const sp = p + (is3D ? 6 : 4);
            const blank = buf[sp] & 0x40;
            let r = 0, g = 0, b = 0;
            if (!blank) {
                if (format >= 4) { b = buf[sp + 1]; g = buf[sp + 2]; r = buf[sp + 3]; }
                else { const c = PALETTE[buf[sp + 1]] || [255, 255, 255]; [r, g, b] = c; }
            }
            pts.push({ x: buf.readInt16BE(p), y: buf.readInt16BE(p + 2), r, g, b });
        }
        return pts;
    }
    return null;
}

/** POST /api/ilda/live?ch=N (corps = fichier .ild) ; renvoie true si la requête est traitée */
function handleIldaLiveRequest(req, res, url) {
    if (url.pathname !== '/api/ilda/live') return false;
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('POST attendu');
        return true;
    }
    const ch = parseInt(url.searchParams.get('ch') || '1', 10);
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
        size += d.length;
        if (size > 4 * 1024 * 1024) { req.destroy(); return; }
        chunks.push(d);
    });
    req.on('end', () => {
        const pts = firstIldaFrame(Buffer.concat(chunks));
        if (!pts || !(ch >= 1 && ch <= MAX_CHANNELS)) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Image ILDA ou canal invalide');
            return;
        }
        setLiveFrame(ch, pts);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, channel: ch, points: pts.length }));
    });
    return true;
}

// ── IDN (ILDA Digital Network) ────────────────────────────────────────────────
const IDN_PORT = 7255;
const CMD_PING_REQUEST = 0x08, CMD_PING_RESPONSE = 0x09;
const CMD_SCAN_REQUEST = 0x10, CMD_SCAN_RESPONSE = 0x11;
const CMD_SERVICEMAP_REQUEST = 0x12, CMD_SERVICEMAP_RESPONSE = 0x13;
const CMD_RT_CNLMSG = 0x40, CMD_RT_CNLMSG_ACKREQ = 0x41, CMD_RT_CNLMSG_CLOSE = 0x44, CMD_RT_CNLMSG_CLOSE_ACKREQ = 0x45;
const CMD_RT_ACKNOWLEDGE = 0x47;
const SERVICE_TYPE_LASER = 0x80;
const CHUNK_WAVE = 0x01, CHUNK_FRAME = 0x02, CHUNK_FRAME_FIRST = 0x03, CHUNK_FRAME_SEQUEL = 0xC0;

const idnChannels = new Map();   // canal IDN → { layout, parts, wave, waveTime }

function idnHeader(cmd, seq, payloadLen) {
    const b = Buffer.alloc(4 + payloadLen);
    b[0] = cmd; b[1] = 0; b.writeUInt16BE(seq, 2);
    return b;
}

/**
 * Disposition d'un échantillon d'après les étiquettes de configuration du service laser :
 * X / Y (8 ou 16 bits), couleurs par longueur d'onde, autres canaux ignorés.
 */
function parseLayout(tags) {
    const fields = [];
    for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t === 0x0000) continue;                          // vide
        if (t === 0x4010) {                                  // précision : le champ précédent passe en 16 bits
            if (fields.length) fields[fields.length - 1].bytes = 2;
            continue;
        }
        const cat = t >> 12;
        let kind = 'skip';
        if ((t & 0xfff0) === 0x4200) kind = 'x';
        else if ((t & 0xfff0) === 0x4210) kind = 'y';
        else if (cat === 5 && (t & 0x0c00) !== 0x0c00) {
            const nm = t & 0x03ff;
            kind = nm >= 600 ? 'r' : nm >= 500 ? 'g' : 'b';
        } else if (cat === 5) kind = 'i';
        fields.push({ kind, bytes: 1 });
    }
    const size = fields.reduce((n, f) => n + f.bytes, 0);
    return size > 0 ? { fields, size } : null;
}

function decodeSamples(buf, o, end, layout, out) {
    const { fields, size } = layout;
    for (; o + size <= end; o += size) {
        let q = o;
        let x = 0, y = 0, r = 0, g = 0, b = 0, inten = 255;
        for (const f of fields) {
            const v = f.bytes === 2 ? buf.readUInt16BE(q) : buf[q];
            q += f.bytes;
            switch (f.kind) {
                case 'x': x = f.bytes === 2 ? (v << 16 >> 16) : ((v << 24 >> 24) << 8); break;
                case 'y': y = f.bytes === 2 ? (v << 16 >> 16) : ((v << 24 >> 24) << 8); break;
                case 'r': r = Math.max(r, f.bytes === 2 ? v >> 8 : v); break;
                case 'g': g = Math.max(g, f.bytes === 2 ? v >> 8 : v); break;
                case 'b': b = Math.max(b, f.bytes === 2 ? v >> 8 : v); break;
                case 'i': inten = f.bytes === 2 ? v >> 8 : v; break;
                default:
            }
        }
        if (inten < 255) { r = r * inten / 255; g = g * inten / 255; b = b * inten / 255; }
        out.push({ x, y, r: r | 0, g: g | 0, b: b | 0 });
        if (out.length >= MAX_POINTS) break;
    }
}

/** Journal d'un canal IDN : configuration reçue, puis bilan toutes les 10 s tant que des images arrivent */
function logIdn(c, cnl, text) {
    console.log(`[IDN] canal ${cnl} → live ${c.live} : ${text}`);
}

function describeLayout(layout) {
    return layout ? layout.fields.map(f => f.kind + (f.bytes === 2 ? '16' : '')).join(' ') + ` (${layout.size} octets/point)` : 'aucune';
}

function handleChannelMessage(msg, o) {
    if (o + 8 > msg.length) return;
    const total = msg.readUInt16BE(o);
    const content = msg.readUInt16BE(o + 2);
    const end = Math.min(msg.length, o + total);
    if (!(content & 0x8000)) return;                         // pas un message de canal
    const cnl = (content >> 8) & 0x3f;
    const chunkType = content & 0xff;
    // Bit 14 : configuration présente (message ordinaire) ou DERNIER fragment (fragment suivant, 0xC0)
    const sequel = chunkType === CHUNK_FRAME_SEQUEL;
    const cclf = !sequel && Boolean(content & 0x4000);
    const lastFragment = sequel && Boolean(content & 0x4000);
    let p = o + 8;                                           // après taille, contenu, horodatage
    let c = idnChannels.get(cnl);
    if (!c) {
        c = { layout: null, frag: null, wave: [], waveTime: 0, live: Math.min(MAX_CHANNELS, cnl + 1), key: '', frames: 0, points: 0, logTime: 0 };
        idnChannels.set(cnl, c);
    }
    if (cclf) {
        if (p + 4 > end) return;
        const scwc = msg[p];
        const flags = msg[p + 1];
        const serviceId = msg[p + 2];
        const serviceMode = msg[p + 3];
        p += 4;
        const tags = [];
        for (let i = 0; i < scwc * 2 && p + 2 <= end; i++, p += 2) tags.push(msg.readUInt16BE(p));
        // Service choisi dans le logiciel (« Laser live N ») : canal live N ; sinon canal IDN + 1
        if ((flags & 0x01) && serviceId >= 1 && serviceId <= MAX_CHANNELS) c.live = serviceId;
        if (serviceMode) c.layout = parseLayout(tags);
        const key = `${serviceMode}|${c.live}|${tags.join(',')}`;
        if (key !== c.key) {
            c.key = key;
            logIdn(c, cnl, `mode ${serviceMode === 1 ? 'continu' : serviceMode === 2 ? 'images' : serviceMode}, `
                + `étiquettes ${tags.map(t => t.toString(16).padStart(4, '0')).join(' ')} → ${describeLayout(c.layout)}`);
        }
    }
    if (!c.layout) return;
    const ch = c.live;
    const emit = (pts) => {
        if (!pts.length) return;
        setLiveFrame(ch, pts);
        c.frames++;
        c.points += pts.length;
        const now = Date.now();
        if (now - c.logTime > 10000) {
            logIdn(c, cnl, `${c.frames} image(s) reçue(s), ${Math.round(c.points / c.frames)} points en moyenne`);
            c.logTime = now;
            c.frames = 0;
            c.points = 0;
        }
    };
    if (sequel) {
        // Fragment suivant : données seules (pas d'en-tête de bloc), un point peut être coupé entre deux fragments
        if (!c.frag) return;
        c.frag.push(msg.subarray(p, end));
        if (lastFragment) {
            const data = Buffer.concat(c.frag);
            c.frag = null;
            const pts = [];
            decodeSamples(data, 0, data.length, c.layout, pts);
            emit(pts);
        }
        return;
    }
    if (p + 4 > end) return;
    p += 4;                                                  // en-tête du bloc : drapeaux + durée
    if (chunkType === CHUNK_FRAME) {
        const pts = [];
        decodeSamples(msg, p, end, c.layout, pts);
        emit(pts);
    } else if (chunkType === CHUNK_FRAME_FIRST) {
        c.frag = [Buffer.from(msg.subarray(p, end))];
    } else if (chunkType === CHUNK_WAVE) {
        // Flux continu : points regroupés en images d'environ 1/30 s
        decodeSamples(msg, p, end, c.layout, c.wave);
        const now = Date.now();
        if (now - c.waveTime >= MIN_INTERVAL_MS || c.wave.length >= MAX_POINTS) {
            emit(c.wave);
            c.wave = [];
            c.waveTime = now;
        }
    }
}

function initIdn() {
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { return null; }
    sock.on('error', (e) => console.warn(`[IDN] Port UDP ${IDN_PORT} indisponible (${e.message}) : entrée ILDA live IDN désactivée`));
    sock.on('message', (msg, rinfo) => {
        if (msg.length < 4) return;
        const cmd = msg[0];
        const seq = msg.readUInt16BE(2);
        const reply = (b) => sock.send(b, rinfo.port, rinfo.address);
        if (cmd === CMD_PING_REQUEST) {
            const b = idnHeader(CMD_PING_RESPONSE, seq, msg.length - 4);
            msg.copy(b, 4, 4);
            reply(b);
        } else if (cmd === CMD_SCAN_REQUEST) {
            const b = idnHeader(CMD_SCAN_RESPONSE, seq, 40);
            b[4] = 40; b[5] = 0x10; b[6] = 0x01;             // taille, version 1.0, statut (temps réel)
            const uid = Buffer.from('SS3D-LASERS');
            b[8] = uid.length; uid.copy(b, 9, 0, 15);
            b.write('SoundStage3D', 24, 'ascii');
            reply(b);
        } else if (cmd === CMD_SERVICEMAP_REQUEST) {
            const n = MAX_CHANNELS;
            const b = idnHeader(CMD_SERVICEMAP_RESPONSE, seq, 4 + n * 24);
            b[4] = 4; b[5] = 24; b[6] = 0; b[7] = n;
            for (let i = 0; i < n; i++) {
                const o = 8 + i * 24;
                b[o] = i + 1; b[o + 1] = SERVICE_TYPE_LASER; b[o + 2] = 0; b[o + 3] = 0;
                b.write(`Laser live ${i + 1}`, o + 4, 'ascii');
            }
            reply(b);
        } else if (cmd === CMD_RT_CNLMSG || cmd === CMD_RT_CNLMSG_ACKREQ || cmd === CMD_RT_CNLMSG_CLOSE || cmd === CMD_RT_CNLMSG_CLOSE_ACKREQ) {
            try { handleChannelMessage(msg, 4); } catch (_) { /* paquet mal formé : ignoré */ }
            if (cmd === CMD_RT_CNLMSG_ACKREQ || cmd === CMD_RT_CNLMSG_CLOSE_ACKREQ) {
                const b = idnHeader(CMD_RT_ACKNOWLEDGE, seq, 4);
                b[4] = 4; b[5] = 0;
                reply(b);
            }
        }
    });
    sock.bind(IDN_PORT, () => console.log(`[IDN] Entrée ILDA live à l'écoute (UDP ${IDN_PORT}, expérimental) : canal IDN 0 = canal live 1`));
    return sock;
}

/**
 * @param {(buf: Buffer) => void} send envoi d'un paquet binaire à tous les joueurs
 */
function initIldaLive(send) {
    broadcast = send;
    if (process.env.SS3D_IDN !== '0') initIdn();
}

module.exports = { initIldaLive, setLiveFrame, liveState, handleIldaLiveRequest, ILDA_LIVE_PACKET, handleIdnMessage: handleChannelMessage };
