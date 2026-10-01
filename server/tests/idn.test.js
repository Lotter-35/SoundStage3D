// Décodage IDN (ILDA Digital Network) de l'entrée ILDA live : paquets construits selon IDN-Stream
// Lancer :  node server/tests/idn.test.js
process.env.SS3D_IDN = '0';   // pas de socket UDP : on appelle directement le décodeur
const { initIldaLive, handleIdnMessage, ILDA_LIVE_PACKET } = require('../ildaLive');

let ok = true;
const check = (name, cond, detail = '') => { console.log((cond ? 'OK   ' : 'BUG  ') + name + (detail ? ' -> ' + detail : '')); if (!cond) ok = false; };

// Images reçues par les joueurs (paquet 0x03)
const sent = [];
initIldaLive((buf) => sent.push(buf));
const decode = (buf) => {
    const n = buf.readUInt32LE(8);
    const pts = [];
    for (let i = 0; i < n; i++) {
        const o = 12 + i * 7;
        pts.push({ x: buf.readInt16LE(o), y: buf.readInt16LE(o + 2), r: buf[o + 4], g: buf[o + 5], b: buf[o + 6] });
    }
    return { ch: buf[1], pts };
};

// Configuration standard : X, Y en 16 bits, rouge 638 nm, vert 532 nm, bleu 460 nm (+ mot vide d'alignement)
const TAGS = [0x4200, 0x4010, 0x4210, 0x4010, 0x527E, 0x5214, 0x51CC, 0x0000];
const SAMPLE = 7;

function samples(pts) {
    const b = Buffer.alloc(pts.length * SAMPLE);
    pts.forEach((p, i) => {
        const o = i * SAMPLE;
        b.writeInt16BE(p.x, o); b.writeInt16BE(p.y, o + 2);
        b[o + 4] = p.r; b[o + 5] = p.g; b[o + 6] = p.b;
    });
    return b;
}

/** Message de canal : en-tête 8 octets + [configuration] + [en-tête de bloc] + données */
function channelMessage({ cnl = 0, chunk, config = null, last = false, chunkHeader = true, data }) {
    let content = 0x8000 | ((cnl & 0x3f) << 8) | chunk;
    const parts = [];
    if (config) {
        content |= 0x4000;
        const c = Buffer.alloc(4 + TAGS.length * 2);
        c[0] = TAGS.length / 2; c[1] = config.routing ? 0x01 : 0; c[2] = config.service || 0; c[3] = config.mode;
        TAGS.forEach((t, i) => c.writeUInt16BE(t, 4 + i * 2));
        parts.push(c);
    }
    if (last) content |= 0x4000;
    if (chunkHeader) parts.push(Buffer.from([0, 0, 0x82, 0x35]));   // drapeaux + durée
    parts.push(data);
    const body = Buffer.concat(parts);
    const h = Buffer.alloc(8);
    h.writeUInt16BE(8 + body.length, 0);
    h.writeUInt16BE(content, 2);
    h.writeUInt32BE(123456, 4);
    return Buffer.concat([Buffer.from([0x40, 0, 0, 1]), h, body]);   // en-tête IDN-Hello (commande 0x40)
}
const feed = (pkt) => handleIdnMessage(pkt, 4);

const shape = (n, seed) => Array.from({ length: n }, (_, i) => ({
    x: Math.round(Math.cos(i / n * 6.283 + seed) * 20000), y: Math.round(Math.sin(i / n * 6.283 + seed) * 20000),
    r: (i * 7 + seed) & 255, g: (i * 13) & 255, b: 200,
}));
const same = (a, b) => a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y && p.r === b[i].r && p.g === b[i].g && p.b === b[i].b);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    // 1. Image entière dans un seul message (0x02), configuration incluse
    const a = shape(120, 1);
    feed(channelMessage({ chunk: 0x02, config: { mode: 2 }, data: samples(a) }));
    let got = sent.length ? decode(sent[sent.length - 1]) : null;
    check('image entière (0x02)', got && got.ch === 1 && same(got.pts, a), got ? `${got.pts.length} points, canal ${got.ch}` : 'rien reçu');

    // 2. Image de 1000 points fragmentée (0x03 puis 0xC0), fragments coupés au milieu d'un point
    await wait(40);
    const b = shape(1000, 2);
    const raw = samples(b);
    const cut = [0, 1400, 2803, 4200, 5601, raw.length];     // coupures qui tombent au milieu d'un point
    feed(channelMessage({ chunk: 0x03, config: { mode: 2 }, data: raw.subarray(cut[0], cut[1]) }));
    for (let i = 1; i < cut.length - 1; i++) {
        feed(channelMessage({ chunk: 0xC0, chunkHeader: false, last: i === cut.length - 2, data: raw.subarray(cut[i], cut[i + 1]) }));
    }
    got = decode(sent[sent.length - 1]);
    check('image fragmentée (0x03 + 0xC0)', same(got.pts, b), `${got.pts.length} points`);

    // 3. Service choisi dans le logiciel (routage vers « Laser live 3 »)
    await wait(40);
    const c = shape(80, 3);
    feed(channelMessage({ cnl: 0, chunk: 0x02, config: { mode: 2, routing: true, service: 3 }, data: samples(c) }));
    got = decode(sent[sent.length - 1]);
    check('routage vers le service 3', got.ch === 3 && same(got.pts, c), `canal ${got.ch}`);

    // 4. Flux continu (0x01) : points regroupés en images
    await wait(40);
    const before = sent.length;
    const d = shape(300, 4);
    feed(channelMessage({ cnl: 1, chunk: 0x01, config: { mode: 1 }, data: samples(d.slice(0, 150)) }));
    await wait(40);
    feed(channelMessage({ cnl: 1, chunk: 0x01, data: samples(d.slice(150)) }));
    const liveFrames = sent.slice(before).map(decode);
    check('flux continu (0x01)', liveFrames.length > 0 && liveFrames.every(f => f.ch === 2), `${liveFrames.length} image(s) sur le canal ${liveFrames[0] && liveFrames[0].ch}`);

    check('paquets 0x03 vers les joueurs', sent.every(s => s[0] === ILDA_LIVE_PACKET));
    process.exit(ok ? 0 : 1);
})();
