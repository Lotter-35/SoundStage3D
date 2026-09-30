/**
 * ildaLibrary.js
 * ─────────────────────────────────────────────────────────────
 * Bibliothèque de formes ILDA du serveur (nouveaux lasers) :
 *
 *   server/storage/ilda/
 *   ├── Faisceaux/        ← chaque sous-dossier = une BANQUE
 *   │   └── eventail.ild  ← chaque fichier .ild = une forme
 *   └── Graphiques/…
 *
 * - Le dossier est rescanné toutes les 2 s : un fichier ajouté, modifié ou supprimé apparaît
 *   automatiquement dans la configuration de chaque laser, chez tous les joueurs (message ILDA_INDEX).
 * - GET /api/ilda                → index { version, banks: [{ name, files: [{ name, path, size, mtime }] }] }
 * - GET /api/ilda/file?p=Banque/forme.ild → contenu du fichier (cache navigateur avec revalidation)
 * - Au premier démarrage, une banque « Exemples » est générée (formes de démonstration).
 * ─────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');

const SCAN_INTERVAL_MS = 2000;
const ROOT_BANK = 'Général';
const MAX_FILES = 2000;

let ILDA_DIR = null;
let index = { version: 0, banks: [] };
let signature = '';
let onChange = null;

/** Liste récursive des fichiers .ild (banque = chemin du dossier relatif) */
function scan() {
    const files = [];
    const walk = (dir, rel, depth) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of entries) {
            if (files.length >= MAX_FILES) return;
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) {
                if (depth < 4) walk(full, r, depth + 1);
            } else if (e.isFile() && /\.ild$/i.test(e.name)) {
                try {
                    const st = fs.statSync(full);
                    files.push({ bank: rel || ROOT_BANK, name: e.name.replace(/\.ild$/i, ''), path: r, size: st.size, mtime: Math.floor(st.mtimeMs) });
                } catch (_) { /* supprimé entre-temps */ }
            }
        }
    };
    walk(ILDA_DIR, '', 0);
    return files;
}

function rebuild() {
    const files = scan();
    const sig = files.map(f => `${f.path}:${f.size}:${f.mtime}`).sort().join('|');
    if (sig === signature) return false;
    signature = sig;
    const banks = new Map();
    for (const f of files) {
        if (!banks.has(f.bank)) banks.set(f.bank, []);
        banks.get(f.bank).push({ name: f.name, path: f.path, size: f.size, mtime: f.mtime });
    }
    const coll = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
    index = {
        version: index.version + 1,
        banks: [...banks.entries()]
            .sort((a, b) => coll.compare(a[0], b[0]))
            .map(([name, list]) => ({ name, files: list.sort((a, b) => coll.compare(a.name, b.name)) })),
    };
    return true;
}

/** Chemin disque d'un fichier demandé, ou null s'il sort du dossier ILDA */
function resolveFile(rel) {
    if (typeof rel !== 'string' || !/\.ild$/i.test(rel)) return null;
    const full = path.resolve(ILDA_DIR, rel);
    if (!full.startsWith(ILDA_DIR + path.sep)) return null;
    return full;
}

/**
 * @param {string} storageDir dossier de stockage du serveur
 * @param {(index: object) => void} changed appelé quand le contenu du dossier change
 */
function initIldaLibrary(storageDir, changed) {
    ILDA_DIR = path.join(storageDir, 'ilda');
    onChange = changed;
    const fresh = !fs.existsSync(ILDA_DIR);
    try { fs.mkdirSync(ILDA_DIR, { recursive: true }); } catch (e) { console.error('[ILDA] Dossier impossible à créer :', e.message); }
    if (fresh) {
        try { writeExamples(path.join(ILDA_DIR, 'Exemples')); } catch (e) { console.warn('[ILDA] Exemples non créés :', e.message); }
    }
    rebuild();
    console.log(`[ILDA] Bibliothèque : ${ILDA_DIR} (${index.banks.reduce((n, b) => n + b.files.length, 0)} formes, ${index.banks.length} banques)`);
    const timer = setInterval(() => {
        if (rebuild()) {
            console.log(`[ILDA] Bibliothèque mise à jour (${index.banks.reduce((n, b) => n + b.files.length, 0)} formes)`);
            if (onChange) onChange(index);
        }
    }, SCAN_INTERVAL_MS);
    if (timer.unref) timer.unref();
}

function getIldaIndex() {
    return index;
}

/** Routes /api/ilda ; renvoie true si la requête est traitée */
function handleIldaRequest(req, res, url) {
    if (req.method !== 'GET' || !url.pathname.startsWith('/api/ilda')) return false;
    if (url.pathname === '/api/ilda') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify(index));
        return true;
    }
    if (url.pathname === '/api/ilda/file') {
        const file = resolveFile(url.searchParams.get('p'));
        let st = null;
        try { st = file && fs.statSync(file); } catch (_) { st = null; }
        if (!st || !st.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Forme ILDA introuvable');
            return true;
        }
        const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
        const headers = { 'Cache-Control': 'no-cache', 'ETag': etag };
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, headers);
            res.end();
            return true;
        }
        res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
        fs.createReadStream(file).pipe(res);
        return true;
    }
    return false;
}

// ─── Écriture ILDA (formes d'exemple) ─────────────────────────────────────────

/** @param {{format: number, points: {x:number,y:number,r?:number,g?:number,b?:number,c?:number,blank?:boolean}[]}[]} frames */
function encodeIlda(frames, name) {
    const chunks = [];
    const header = (format, count, num, total) => {
        const h = Buffer.alloc(32);
        h.write('ILDA', 0, 'ascii');
        h.writeUInt8(format, 7);
        h.write(name.slice(0, 8).padEnd(8, ' '), 8, 'ascii');
        h.write('SS3D'.padEnd(8, ' '), 16, 'ascii');
        h.writeUInt16BE(count, 24);
        h.writeUInt16BE(num, 26);
        h.writeUInt16BE(total, 28);
        return h;
    };
    const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
    frames.forEach((f, i) => {
        const pts = f.points;
        chunks.push(header(f.format, pts.length, i, frames.length));
        const size = f.format === 5 ? 8 : 6;
        const buf = Buffer.alloc(pts.length * size);
        pts.forEach((p, k) => {
            const o = k * size;
            buf.writeInt16BE(q(p.x), o);
            buf.writeInt16BE(q(p.y), o + 2);
            const status = (p.blank ? 0x40 : 0) | (k === pts.length - 1 ? 0x80 : 0);
            buf.writeUInt8(status, o + 4);
            if (f.format === 5) {
                buf.writeUInt8(p.blank ? 0 : p.b, o + 5);
                buf.writeUInt8(p.blank ? 0 : p.g, o + 6);
                buf.writeUInt8(p.blank ? 0 : p.r, o + 7);
            } else {
                buf.writeUInt8(p.c || 0, o + 5);
            }
        });
        chunks.push(buf);
    });
    chunks.push(header(frames[0] ? frames[0].format : 5, 0, frames.length, frames.length));
    return Buffer.concat(chunks);
}

function hsv(h) {
    const i = Math.floor(h * 6), f = h * 6 - i, q = 1 - f;
    const m = [[1, f, 0], [q, 1, 0], [0, 1, f], [0, q, 1], [f, 0, 1], [1, 0, q]][((i % 6) + 6) % 6];
    return { r: Math.round(m[0] * 255), g: Math.round(m[1] * 255), b: Math.round(m[2] * 255) };
}

/** Trait fermé avec points d'angle et masquage d'entrée (image prête à projeter) */
function closedPath(pts, color, step = 0.02, corner = 4) {
    const out = [];
    const first = pts[0];
    for (let i = 0; i < 6; i++) out.push({ x: first[0], y: first[1], blank: true });
    for (let s = 0; s < pts.length; s++) {
        const a = pts[s], b = pts[(s + 1) % pts.length];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
        const c = typeof color === 'function' ? color(s / pts.length) : color;
        for (let k = 0; k < corner; k++) out.push({ x: a[0], y: a[1], ...c });
        for (let k = 1; k <= n; k++) out.push({ x: a[0] + (b[0] - a[0]) * k / n, y: a[1] + (b[1] - a[1]) * k / n, ...c });
    }
    return out;
}

function writeExamples(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const TAU = Math.PI * 2;

    // 1. Cercle arc-en-ciel (couleurs par point, format 5)
    {
        const pts = [];
        const n = 220;
        for (let i = 0; i <= n; i++) {
            const a = (i / n) * TAU;
            pts.push({ x: Math.cos(a) * 0.8, y: Math.sin(a) * 0.8, ...hsv(i / n) });
        }
        fs.writeFileSync(path.join(dir, 'Cercle arc-en-ciel.ild'), encodeIlda([{ format: 5, points: pts }], 'CERCLE'));
    }
    // 2. Tunnel animé (cercle qui s'ouvre, 40 images)
    {
        const frames = [];
        for (let f = 0; f < 40; f++) {
            const r = 0.1 + 0.85 * (f / 40);
            const pts = [];
            const n = 60 + Math.round(160 * r);
            for (let i = 0; i <= n; i++) {
                const a = (i / n) * TAU;
                pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, r: 0, g: 140, b: 255 });
            }
            frames.push({ format: 5, points: pts });
        }
        fs.writeFileSync(path.join(dir, 'Tunnel animé.ild'), encodeIlda(frames, 'TUNNEL'));
    }
    // 3. Étoile tournante (palette ILDA par défaut, format 1)
    {
        const frames = [];
        for (let f = 0; f < 48; f++) {
            const rot = (f / 48) * TAU / 5;
            const star = [];
            for (let i = 0; i < 10; i++) {
                const a = -Math.PI / 2 + rot + (i / 10) * TAU;
                const r = i % 2 === 0 ? 0.85 : 0.35;
                star.push([Math.cos(a) * r, Math.sin(a) * r]);
            }
            const pts = closedPath(star, (t) => ({ c: t < 0.5 ? 16 : 48 }), 0.03).map(p => ({ ...p, c: p.blank ? 0 : p.c }));
            frames.push({ format: 1, points: pts });
        }
        fs.writeFileSync(path.join(dir, 'Étoile tournante.ild'), encodeIlda(frames, 'ETOILE'));
    }
    // 4. Éventail de faisceaux multicolores (points d'arrêt : faisceaux fixes)
    {
        const pts = [];
        const n = 12;
        for (let i = 0; i < n; i++) {
            const x = -0.9 + 1.8 * i / (n - 1);
            for (let k = 0; k < 6; k++) pts.push({ x, y: 0, blank: true });
            const c = hsv(i / n);
            for (let k = 0; k < 14; k++) pts.push({ x, y: 0, ...c });
            for (let k = 0; k < 3; k++) pts.push({ x, y: 0, blank: true });
        }
        fs.writeFileSync(path.join(dir, 'Éventail multicolore.ild'), encodeIlda([{ format: 5, points: pts }], 'EVENTAIL'));
    }
    // 5. Vague animée (nappe ondulante)
    {
        const frames = [];
        for (let f = 0; f < 36; f++) {
            const ph = (f / 36) * TAU;
            const pts = [];
            const n = 160;
            for (let i = 0; i <= n; i++) {
                const x = -0.9 + 1.8 * i / n;
                pts.push({ x, y: Math.sin(x * 4 + ph) * 0.25, r: 255, g: 30, b: 120 });
            }
            for (let i = n; i >= 0; i--) {
                const x = -0.9 + 1.8 * i / n;
                pts.push({ x, y: Math.sin(x * 4 + ph) * 0.25, r: 255, g: 30, b: 120 });
            }
            frames.push({ format: 5, points: pts });
        }
        fs.writeFileSync(path.join(dir, 'Vague animée.ild'), encodeIlda(frames, 'VAGUE'));
    }
    fs.writeFileSync(path.join(ILDA_DIR, 'LISEZ-MOI.txt'),
        'Bibliothèque ILDA de SoundStage3D\n\n'
        + 'Déposez vos fichiers .ild ici. Chaque sous-dossier est une banque d\'images.\n'
        + 'Les formes apparaissent automatiquement dans la configuration des lasers (en 2 s environ),\n'
        + 'chez tous les joueurs connectés.\n', 'utf-8');
}

module.exports = { initIldaLibrary, getIldaIndex, handleIldaRequest, encodeIlda };
