/**
 * web-server.js
 * ─────────────────────────────────────────────────────────────
 * Serveur web du jeu (fichiers du dépôt) sur le port 8067. Le jeu ouvert sur ce port se connecte tout seul au
 * serveur multijoueur / audio du port 8068 (server/server.js). Remplace « python -m http.server 8067 ».
 *
 *   - aucune dépendance (Node seul) ;
 *   - pas de cache : un fichier modifié est servi tel quel au rechargement (Ctrl+F5 inutile) ;
 *   - écoute sur toutes les interfaces (les autres joueurs du réseau peuvent se connecter).
 *
 * Lancement : node tools/web-server.js  (port : variable WEB_PORT, 8067 par défaut)
 * ─────────────────────────────────────────────────────────────
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.WEB_PORT) || 8067;
const ROOT = path.resolve(__dirname, '..');

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.fbx': 'application/octet-stream',
    '.bin': 'application/octet-stream',
    '.hdr': 'application/octet-stream',
    '.ktx2': 'image/ktx2',
    '.wasm': 'application/wasm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.ild': 'application/octet-stream',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((req, res) => {
    let rel;
    try {
        rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
        res.writeHead(400).end();
        return;
    }
    let file = path.join(ROOT, rel);
    // Pas de sortie du dossier du jeu
    if (!file.startsWith(ROOT)) {
        res.writeHead(403).end();
        return;
    }
    fs.stat(file, (err, st) => {
        if (!err && st.isDirectory()) {
            file = path.join(file, 'index.html');
            st = fs.existsSync(file) ? fs.statSync(file) : null;
        }
        if (err || !st) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Introuvable');
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Content-Length': st.size,
            'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).pipe(res);
    });
});

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`[web] Le port ${PORT} est déjà utilisé (un autre serveur web tourne-t-il encore ?)`);
    else console.error('[web]', e);
    process.exit(1);
});

server.listen(PORT, () => {
    console.log(`[web] Jeu servi sur http://localhost:${PORT} (dossier ${ROOT})`);
});
