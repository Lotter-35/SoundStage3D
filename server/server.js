/**
 * server.js — WebSocket server for SoundStage3D multiplayer.
 *
 * Architecture:
 *  - Port 8081 (WebSocket only)
 *  - Static files still served by Python HTTP server on port 8080
 *  - Rooms identified by a 6-character alphanumeric code
 *  - Server is the DSP source of truth: stores full DSP state per room
 *    and broadcasts to ALL clients (including master)
 *
 * Message protocol (JSON):
 *   CLIENT → SERVER:
 *     { type: 'CREATE_ROOM' }
 *     { type: 'JOIN_ROOM', roomId: 'ABC123' }
 *     { type: 'DSP_CHANGE', bus: 'sub', param: 'bus-volume', value: 80 }
 *     { type: 'PLAYER_POS', x, y, z, rotY }
 *     { type: 'PING' }
 *
 *   SERVER → CLIENT:
 *     { type: 'ROOM_CREATED', roomId, role: 'master', dspState }
 *     { type: 'ROOM_JOINED',  roomId, role: 'guest',  dspState, players }
 *     { type: 'ROOM_NOT_FOUND' }
 *     { type: 'DSP_UPDATE', bus, param, value }         ← broadcast to all
 *     { type: 'PLAYERS_UPDATE', players }               ← broadcast to all
 *     { type: 'PEER_JOINED', peerId }
 *     { type: 'PEER_LEFT',   peerId }
 *     { type: 'PONG' }
 *     { type: 'ERROR', message }
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8068;
const ROOT_DIR = path.resolve(__dirname, '..');

let publicIp = null;

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason);
});
https.get('https://api.ipify.org', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        publicIp = data.trim();
        console.log(`[SoundStage3D] Public IP detected: ${publicIp}`);
    });
}).on('error', () => {
    console.log('[SoundStage3D] Could not detect public IP via ipify');
});

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg':  'image/svg+xml',
    '.glb':  'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',
    '.ico':  'image/x-icon',
};

// ─── Server Persistent Storage (Playlists & Audio files) ───────────────────────
// SS3D_STORAGE_DIR : autre dossier de stockage (serveur de test, pour ne pas toucher aux vrais shows et playlists)
const STORAGE_DIR = process.env.SS3D_STORAGE_DIR ? path.resolve(process.env.SS3D_STORAGE_DIR) : path.resolve(__dirname, 'storage');
const AUDIO_STORAGE_DIR = path.join(STORAGE_DIR, 'audio');
const PLAYLISTS_DIR = path.join(STORAGE_DIR, 'playlists');
const SHOWS_DIR = path.join(STORAGE_DIR, 'shows'); // shows de la régie lumière (groupes, patterns…)
const WORLDS_DIR = path.join(STORAGE_DIR, 'worlds'); // mondes des salles permanentes (?room=NOM)

try {
    fs.mkdirSync(AUDIO_STORAGE_DIR, { recursive: true });
    fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });
    fs.mkdirSync(SHOWS_DIR, { recursive: true });
    fs.mkdirSync(WORLDS_DIR, { recursive: true });
} catch (e) {
    console.error('[Storage] Error initializing storage directories:', e);
}

// ─── Shows de la régie lumière (un fichier JSON par show) ─────────────────────
const SHOW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHOW_MAX_BYTES = 8 * 1024 * 1024;

function showPath(id) {
    return path.join(SHOWS_DIR, `${id}.json`);
}

function getShowsList() {
    const list = [];
    try {
        for (const f of fs.readdirSync(SHOWS_DIR)) {
            if (!f.endsWith('.json')) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(SHOWS_DIR, f), 'utf-8'));
                list.push({
                    id: data.id,
                    name: data.name || 'Show sans nom',
                    updatedAt: data.updatedAt || 0,
                    patterns: Array.isArray(data.patterns) ? data.patterns.length : 0,
                });
            } catch (_) { /* fichier illisible : ignoré */ }
        }
    } catch (e) {
        console.error('[Shows] Lecture du dossier impossible :', e.message);
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Écriture atomique (fichier temporaire puis renommage) : un show n'est jamais à moitié écrit */
function saveShowOnDisk(show) {
    const file = showPath(show.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(show, null, 1), 'utf-8');
    fs.renameSync(tmp, file);
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/** API des shows : GET /api/shows, GET|PUT|DELETE /api/shows/:id */
function handleShowsApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'shows', id?]
    const id = parts[2] ? decodeURIComponent(parts[2]) : null;
    if (!id) {
        if (req.method === 'GET') return sendJson(res, 200, getShowsList());
        return sendJson(res, 405, { error: 'Méthode non prise en charge' });
    }
    if (!SHOW_ID_RE.test(id)) return sendJson(res, 400, { error: 'Identifiant de show invalide' });
    if (req.method === 'GET') {
        try {
            return sendJson(res, 200, JSON.parse(fs.readFileSync(showPath(id), 'utf-8')));
        } catch (_) {
            return sendJson(res, 404, { error: 'Show introuvable' });
        }
    }
    if (req.method === 'DELETE') {
        try { fs.unlinkSync(showPath(id)); } catch (_) { /* déjà supprimé */ }
        console.log(`[Shows] Supprimé : ${id}`);
        return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'PUT') {
        const chunks = [];
        let size = 0;
        let aborted = false;
        req.on('data', (c) => {
            size += c.length;
            if (size > SHOW_MAX_BYTES) {
                aborted = true;
                sendJson(res, 413, { error: 'Show trop volumineux' });
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (aborted) return;
            let show;
            try { show = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch (_) { return sendJson(res, 400, { error: 'JSON invalide' }); }
            if (!show || typeof show !== 'object' || show.id !== id) return sendJson(res, 400, { error: 'Show invalide' });
            show.updatedAt = Date.now();
            try {
                saveShowOnDisk(show);
            } catch (e) {
                console.error('[Shows] Écriture impossible :', e.message);
                return sendJson(res, 500, { error: 'Écriture impossible' });
            }
            return sendJson(res, 200, { ok: true, updatedAt: show.updatedAt });
        });
        return;
    }
    return sendJson(res, 405, { error: 'Méthode non prise en charge' });
}

function getPlaylistsList() {
    try {
        if (!fs.existsSync(PLAYLISTS_DIR)) return [];
        const files = fs.readdirSync(PLAYLISTS_DIR).filter(f => f.endsWith('.json'));
        const list = [];
        for (const f of files) {
            try {
                const content = fs.readFileSync(path.join(PLAYLISTS_DIR, f), 'utf-8');
                const data = JSON.parse(content);
                list.push({
                    id: data.id,
                    name: data.name || 'Playlist sans nom',
                    trackCount: Array.isArray(data.tracks) ? data.tracks.length : 0,
                    tracks: (data.tracks || []).map(t => {
                        const binPath = path.join(AUDIO_STORAGE_DIR, `${t.id}.bin`);
                        const onServer = fs.existsSync(binPath);
                        return {
                            id: t.id,
                            name: t.name,
                            mime: t.mime || 'audio/mpeg',
                            url: t.url || `/audio/track/${t.id}`,
                            uploadedBy: t.uploadedBy || null,
                            onServer: onServer,
                        };
                    }),
                    createdAt: data.createdAt || 0,
                    updatedAt: data.updatedAt || 0,
                });
            } catch (err) {
                console.warn(`[Playlist] Error reading ${f}:`, err.message);
            }
        }
        return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch (e) {
        console.error('[Playlist] Error listing playlists:', e);
        return [];
    }
}

function getPlaylistById(id) {
    try {
        const filePath = path.join(PLAYLISTS_DIR, `${id}.json`);
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (e) {
        console.error(`[Playlist] Error reading playlist ${id}:`, e);
        return null;
    }
}

function savePlaylistOnDisk(playlist) {
    try {
        if (!playlist || !playlist.id) return false;
        const filePath = path.join(PLAYLISTS_DIR, `${playlist.id}.json`);
        fs.writeFileSync(filePath, JSON.stringify(playlist, null, 2), 'utf-8');
        return true;
    } catch (e) {
        console.error('[Playlist] Error saving playlist:', e);
        return false;
    }
}

function deletePlaylistOnDisk(id) {
    try {
        const filePath = path.join(PLAYLISTS_DIR, `${id}.json`);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
        return false;
    } catch (e) {
        console.error(`[Playlist] Error deleting playlist ${id}:`, e);
        return false;
    }
}

// ─── Room Storage ─────────────────────────────────────────────────────────────
// rooms: Map<roomId, { masterId, clients: Map<clientId, ws>, dspState, players }>
const rooms = new Map();

// Generate a random 6-char alphanumeric room ID
function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let id;
    do {
        id = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms.has(id));
    return id;
}

// ─── Salles permanentes (monde sauvegardé) ───────────────────────────────────
// ?room=NOM avec un nom choisi (ex. SPECTACLE) : la salle garde son monde (lumières, lasers, stroboscopes,
// lyres, barres LED, brouillard, ambiance, réglages son) dans storage/worlds/NOM.json, même quand elle se vide
// et après un redémarrage du serveur. Première visite : copie du monde par défaut.
// Les codes générés automatiquement (6 caractères sans I, O, 0, 1) restent des salles temporaires.
const WORLD_NAME_RE = /^[A-Z0-9_-]{2,32}$/;
const GENERATED_ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const WORLD_SAVE_DELAY_MS = 1000;

function isPermanentRoomName(id) {
    return WORLD_NAME_RE.test(id) && !GENERATED_ROOM_RE.test(id);
}

function worldPath(name) {
    return path.join(WORLDS_DIR, `${name}.json`);
}

function loadWorld(name) {
    try {
        const data = JSON.parse(fs.readFileSync(worldPath(name), 'utf-8'));
        return data && typeof data === 'object' ? data : null;
    } catch (_) {
        return null; // pas encore de sauvegarde (ou fichier illisible) : monde par défaut
    }
}

/** Écriture atomique du monde d'une salle permanente */
function saveWorldNow(room) {
    if (!room.persistent) return;
    if (room.worldSaveTimer) { clearTimeout(room.worldSaveTimer); room.worldSaveTimer = null; }
    try {
        const file = worldPath(room.persistent);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({
            name: room.persistent,
            savedAt: Date.now(),
            lightingVersion: room.lightingVersion || 1,
            lightingState: room.lightingState,
            dspState: room.dspState,
        }), 'utf-8');
        fs.renameSync(tmp, file);
    } catch (e) {
        console.error(`[Monde] Sauvegarde de ${room.persistent} impossible :`, e.message);
    }
}

/** Réglages son sauvegardés, complétés par les réglages ajoutés depuis (nouvelles clés par défaut) */
function mergeDspState(saved) {
    const out = defaultDspState();
    for (const [bus, params] of Object.entries(saved || {})) {
        if (params && typeof params === 'object') out[bus] = { ...(out[bus] || {}), ...params };
    }
    return out;
}

/** Sauvegarde groupée (au plus une écriture par seconde pendant les modifications) */
function scheduleWorldSave(room) {
    if (!room.persistent || room.worldSaveTimer) return;
    room.worldSaveTimer = setTimeout(() => saveWorldNow(room), WORLD_SAVE_DELAY_MS);
}

function flushAllWorlds() {
    for (const room of rooms.values()) if (room.worldSaveTimer) saveWorldNow(room);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { flushAllWorlds(); process.exit(0); });
}
process.on('exit', flushAllWorlds);

// Generate a unique client ID
let _clientCounter = 0;
function generateClientId() {
    return `client_${++_clientCounter}`;
}

// Default DSP state — mirrors DSP_DEFAULTS keys from the frontend
function defaultDspState() {
    return {
        input: {
            'auto-gain': true, 'target-lufs': -14, 'input-trim': 100,
            'eq-low': 0, 'eq-mid': 0, 'eq-high': 0,
            'comp-enabled': false, 'comp-threshold': -18, 'comp-knee': 12,
            'comp-ratio': 3, 'comp-attack': 10, 'comp-release': 150,
            'limiter-ceiling': -0.1, 'mic-volume': 100,
        },
        sub: {
            'xover-freq': 90, 'comp-threshold': -24, 'comp-knee': 30,
            'comp-ratio': 4, 'comp-attack': 3, 'comp-release': 250,
            'sat-drive': 100, 'sat-mix': 100, 'prox-far': 4.0, 'prox-near': 2.0,
            'prox-drive': 75, 'bus-volume': 100, 'dist-k': 8, 'refl-gain': 20,
            'refl-lpf': 1500, 'lim-threshold': -3, 'energy-limit': 7,
        },
        mid: {
            'xover-low': 90, 'xover-high': 2000, 'comp-threshold': -24,
            'comp-knee': 30, 'comp-ratio': 4, 'comp-attack': 3, 'comp-release': 250,
            'sat-drive': 50, 'sat-mix': 100, 'bus-volume': 100, 'dist-k': 60,
            'refl-gain': 20, 'refl-lpf': 1500, 'lim-threshold': -3,
        },
        top: {
            'xover-freq': 2000, 'comp-threshold': -24, 'comp-knee': 30,
            'comp-ratio': 4, 'comp-attack': 3, 'comp-release': 250,
            'sat-drive': 50, 'sat-mix': 100, 'bus-volume': 100, 'dist-k': 60,
            'refl-gain': 20, 'refl-lpf': 1500, 'lim-threshold': -3,
        },
        fill: {
            'merge-gain': 50, 'bus-volume': 20, 'dist-k': 60,
            'refl-gain': 20, 'refl-lpf': 1500, 'lim-threshold': -3,
        },
        master: {
            'eq-low': 0, 'eq-mid-low': 0, 'eq-mid-high': 0, 'eq-high': 0,
            'comp-enabled': false, 'comp-threshold': -12, 'comp-ratio': 2.0,
            'comp-attack': 30, 'comp-release': 100, 'comp-makeup': 0,
            'limiter-enabled': true, 'limiter-threshold': -0.1,
            'limiter-attack': 0.5, 'limiter-release': 50,
        },
        env: {
            'air-abs': 40, 'treble': 0, 'reverb-wet': 0, 'reverb-decay': 2.5,
            'reverb-damping': 6000, 'reverb-predelay': 10,
        },
    };
}

// ─── Default Lighting & Environment State ─────────────────────────────────────
function defaultLightingState() {
    return {
        env: {
            presetKey: 'day',
            stageBoost: 1.0,
            stars: true, // visibles automatiquement dans les ambiances de nuit (hasStars)
            starSize: 0.5,
            starCount: 12000,
            starBrightness: 3.0,
        },
        gi: {
            enabled: false,
            intensity: 0.95,
            stageBounceIntensity: 0.85,
            roofBounceIntensity: 0.65,
            subwooferBounceIntensity: 0.75,
            skyColor: '#7eb5e6',
            groundBounceColor: '#386622',
            stageBounceColor: '#506880',
            subwooferBounceColor: '#26381e',
        },
        laserPost: {
            enabled: true,
            bloomStrength: 0.15,
            bloomRadius: 0.5,
            bloomThreshold: 0.0,
            chroma: 0.25,
            fogEnabled: false,
            fogDensity: 0.005,
            fogColor: '#111122',
        },
        lights: {},
        // Doit correspondre aux lasers posés au spawn dans src/main.js (ids 0 et 1) : params vides
        // = les clients gardent les réglages de spawn, seules les modifications sont stockées ici.
        lasers: {
            0: {
                id: 0,
                position: { x: -12, y: 14, z: 0.19 },
                rotation: { angle: 0, tilt: 0, roll: 0 },
                params: {},
                pausedOffset: 0,
            },
            1: {
                id: 1,
                position: { x: 12, y: 14, z: 0.19 },
                rotation: { angle: 0, tilt: 0, roll: 0 },
                params: {},
                pausedOffset: 0,
            }
        },
        // Stroboscopes : l'id 0 est celui posé au spawn dans src/main.js (params vides = réglages du spawn)
        strobes: {
            0: { id: 0, params: {} },
        },
        // Lyres Spot : { id: { id, params } }. Les 9 lyres posées au spawn dans src/main.js (spot-stage-1…9)
        // y figurent d'office (params vides = réglages du spawn), comme les lasers et le stroboscope :
        // sinon l'état complet envoyé à la connexion, qui retire les lyres inconnues, les supprimerait.
        // + les 4 lyres posées sur le toit de la tour régie FOH (spot-foh-1…4)
        spots: Object.fromEntries([
            ...Array.from({ length: 9 }, (_, i) => `spot-stage-${i + 1}`),
            ...Array.from({ length: 4 }, (_, i) => `spot-foh-${i + 1}`),
        ].map(id => [id, { id, params: {} }])),
        spotGlobals: {},  // réglages communs des lyres (fumée, qualité, éclairage réel)
        spotFx: {},       // effets de la console en cours : { id: définition }
        // Barres LED : { id: { id, params } }. Les 4 barres posées au spawn dans src/main.js (ledbar-stage-1…4)
        ledBars: Object.fromEntries(Array.from({ length: 4 }, (_, i) => {
            const id = `ledbar-stage-${i + 1}`;
            return [id, { id, params: {} }];
        })),
        // Nouveaux lasers (moteur de points) : { id: { id, params } }. Les 2 lasers posés au spawn
        // dans src/main.js (laser2-stage-1…2)
        laser2s: Object.fromEntries(Array.from({ length: 2 }, (_, i) => {
            const id = `laser2-stage-${i + 1}`;
            return [id, { id, params: {} }];
        })),
    };
}

function applyLightingChange(state, msg) {
    if (!state) return;
    const { category, data, id } = msg;
    if (category === 'env') {
        if (!state.env) state.env = {};
        if (data) Object.assign(state.env, data);
    } else if (category === 'gi') {
        if (!state.gi) state.gi = {};
        if (data) Object.assign(state.gi, data);
    } else if (category === 'laser_post') {
        if (!state.laserPost) state.laserPost = {};
        if (data) Object.assign(state.laserPost, data);
    } else if (category === 'light_update') {
        if (!state.lights) state.lights = {};
        if (!state.lights[id]) state.lights[id] = { id };
        if (data) Object.assign(state.lights[id], data);
    } else if (category === 'light_add') {
        if (!state.lights) state.lights = {};
        if (data && data.id) state.lights[data.id] = data;
    } else if (category === 'light_remove') {
        if (state.lights) delete state.lights[id];
    } else if (category === 'light_reset') {
        if (state.lights) delete state.lights[id];
    } else if (category === 'laser_transform') {
        if (!state.lasers) state.lasers = {};
        if (!state.lasers[id]) state.lasers[id] = { id, params: {} };
        if (data) {
            if (data.position) state.lasers[id].position = data.position;
            if (data.rotation) state.lasers[id].rotation = data.rotation;
        }
    } else if (category === 'laser_param') {
        if (!state.lasers) state.lasers = {};
        if (!state.lasers[id]) state.lasers[id] = { id, params: {} };
        if (!state.lasers[id].params) state.lasers[id].params = {};
        if (msg.param !== undefined) state.lasers[id].params[msg.param] = msg.value;
        if (msg.animTime !== undefined) state.lasers[id].animTime = msg.animTime;
        if (msg.pausedOffset !== undefined) state.lasers[id].pausedOffset = msg.pausedOffset;
    } else if (category === 'laser_add') {
        if (!state.lasers) state.lasers = {};
        if (data && data.id) state.lasers[data.id] = data;
    } else if (category === 'laser_remove') {
        if (state.lasers) delete state.lasers[id];
    } else if (category === 'laser_reset_all') {
        if (state.lasers && state.lasers[id]) state.lasers[id].params = {};
    } else if (category === 'haze') {
        // Brouillard de salle : réglages partagés { param: valeur }
        if (!state.haze) state.haze = {};
        if (data) Object.assign(state.haze, data);
    } else if (category === 'strobe_add') {
        if (!state.strobes) state.strobes = {};
        if (data && data.id !== undefined && data.id !== null) {
            state.strobes[data.id] = { id: data.id, params: { ...(data.params || {}) } };
        }
    } else if (category === 'strobe_update') {
        if (!state.strobes) state.strobes = {};
        if (id !== undefined && id !== null && data) {
            if (!state.strobes[id]) state.strobes[id] = { id, params: {} };
            Object.assign(state.strobes[id].params, data);
        }
    } else if (category === 'strobe_remove') {
        if (state.strobes) delete state.strobes[id];
    } else if (category === 'spot_add') {
        if (!state.spots) state.spots = {};
        if (data && data.id) state.spots[data.id] = { id: data.id, params: { ...(data.params || {}) } };
    } else if (category === 'spot_update') {
        if (!state.spots) state.spots = {};
        if (id && data) {
            if (!state.spots[id]) state.spots[id] = { id, params: {} };
            Object.assign(state.spots[id].params, data);
        }
    } else if (category === 'spot_remove') {
        if (state.spots) delete state.spots[id];
    } else if (category === 'spot_multi') {
        // Console des lyres : { id: { param: valeur } } en un seul message
        if (!state.spots) state.spots = {};
        for (const [spotId, changes] of Object.entries(data || {})) {
            if (!state.spots[spotId]) state.spots[spotId] = { id: spotId, params: {} };
            Object.assign(state.spots[spotId].params, changes);
        }
    } else if (category === 'spot_fx') {
        if (!state.spotFx) state.spotFx = {};
        if (msg.action === 'start' && msg.fx && msg.fx.id) state.spotFx[msg.fx.id] = msg.fx;
        else if (msg.action === 'stop') delete state.spotFx[msg.id];
        else if (msg.action === 'stopAll') state.spotFx = {};
    } else if (category === 'spot_global') {
        if (!state.spotGlobals) state.spotGlobals = {};
        if (data) Object.assign(state.spotGlobals, data);
    } else if (category === 'ledbar_add') {
        if (!state.ledBars) state.ledBars = {};
        if (data && data.id) state.ledBars[data.id] = { id: data.id, params: { ...(data.params || {}) } };
    } else if (category === 'ledbar_update') {
        if (!state.ledBars) state.ledBars = {};
        if (id && data) {
            if (!state.ledBars[id]) state.ledBars[id] = { id, params: {} };
            Object.assign(state.ledBars[id].params, data);
        }
    } else if (category === 'ledbar_remove') {
        if (state.ledBars) delete state.ledBars[id];
    } else if (category === 'laser2_add') {
        if (!state.laser2s) state.laser2s = {};
        if (data && data.id) state.laser2s[data.id] = { id: data.id, params: { ...(data.params || {}) } };
    } else if (category === 'laser2_update') {
        if (!state.laser2s) state.laser2s = {};
        if (id && data) {
            if (!state.laser2s[id]) state.laser2s[id] = { id, params: {} };
            Object.assign(state.laser2s[id].params, data);
        }
    } else if (category === 'laser2_remove') {
        if (state.laser2s) delete state.laser2s[id];
    } else if (category === 'reset_all') {
        const fresh = defaultLightingState();
        state.env = fresh.env;
        state.gi = fresh.gi;
        state.laserPost = fresh.laserPost;
        state.lights = {};
        // Le reset global revient à la scène du spawn (lasers et stroboscope de base conservés)
        state.lasers = fresh.lasers;
        state.strobes = fresh.strobes;
        state.spots = fresh.spots; // lyres du spawn conservées
        state.spotGlobals = {};
        state.spotFx = {};
        state.ledBars = fresh.ledBars; // barres LED du spawn conservées
        state.laser2s = fresh.laser2s; // nouveaux lasers du spawn conservés
        state.haze = {};
    }
}

/**
 * Crée une salle dont ce client est le premier joueur (maître).
 * @param {string|null} persistentName nom de la salle permanente (monde sauvegardé), null = salle temporaire
 */
function createRoom(ws, clientId, roomId, persistentName) {
    const world = persistentName ? loadWorld(persistentName) : null;
    const room = {
        masterId: clientId,
        clients: new Map([[clientId, ws]]),
        dspState: world ? mergeDspState(world.dspState) : defaultDspState(),
        lightingState: world ? { ...defaultLightingState(), ...(world.lightingState || {}) } : defaultLightingState(),
        playback: { currentTime: 0, isPlaying: false, timestamp: Date.now() },
        sine: { active: false, frequency: 440, volume: 50 },
        trackName: '',
        audioBuffer: null,
        audioMime: null,
        queue: [],
        currentQueueIndex: -1,
        currentTrack: null,
        manualQueue: [],
        contextQueue: [],
        isShuffle: false,
        queueVersion: 1,
        lightingVersion: (world && world.lightingVersion) || 1,
        persistent: persistentName,
        worldSaveTimer: null,
        loadedPlaylistId: null,
        loadedPlaylistName: null,
        lastAdvanceTime: 0,
        audioTracks: new Map(),
        players: {},
        readyClients: new Set(),
        createdAt: Date.now(),
        isPlayingTriggered: false,
        isAwaitingReady: false,
        readyTimeout: null,
    };
    rooms.set(roomId, room);
    ws.roomId = roomId;

    console.log(`[Room] Created: ${roomId} by ${clientId}${persistentName ? (world ? ' (salle permanente, monde sauvegardé)' : ' (salle permanente, nouveau monde)') : ''}`);
    if (persistentName && !world) saveWorldNow(room);
    send(ws, {
        type: 'ROOM_CREATED',
        roomId,
        clientId,
        isFirstInRoom: true,
        color: ws.color,
        publicIp: publicIp || null,
        webPort: 8067,
        audioPort: PORT,
        dspState: room.dspState,
        lightingState: room.lightingState,
        lightingVersion: room.lightingVersion || 1,
        playback: room.playback,
        sine: room.sine,
        trackName: room.trackName,
        audioUrl: room.audioBuffer ? `/audio/${roomId}` : null,
        queue: room.queue || [],
        currentQueueIndex: room.currentQueueIndex !== undefined ? room.currentQueueIndex : -1,
        currentTrack: room.currentTrack || null,
        manualQueue: room.manualQueue || [],
        contextQueue: room.contextQueue || [],
        isShuffle: Boolean(room.isShuffle),
        queueVersion: room.queueVersion || 1,
        loadedPlaylistId: room.loadedPlaylistId || null,
        loadedPlaylistName: room.loadedPlaylistName || null,
        playlists: getPlaylistsList(),
        players: getPlayersSnapshot(room),
        serverTime: Date.now(),
        sweepTime: 0,
        persistent: Boolean(persistentName),
    });
    return room;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(typeof data === 'string' ? data : JSON.stringify(data));
        } catch (err) {
            console.warn('[Sync] ws.send error:', err.message);
        }
    }
}

function broadcastRoom(room, data, excludeId = null) {
    for (const [id, client] of room.clients) {
        if (id !== excludeId) {
            send(client, data);
        }
    }
    // Les régies suivent l'horloge musicale et le nombre de joueurs
    if (room.regies && room.regies.size > 0 && data && REGIE_PLAYBACK_EVENTS.has(data.type)) {
        sendRegies(room, regiePlaybackMessage(room));
    }
}

// ─── Régie lumière & DMX ──────────────────────────────────────────────────────
// La page régie (/regie) est un client à part : pas d'avatar, pas comptée parmi les joueurs
// (room.regies, jamais room.clients), donc elle ne bloque pas l'attente « prêt » des morceaux.
// Elle envoie des paquets DMX binaires (0x02, format décrit dans src/dmx/DmxProtocol.js) :
// le serveur tient l'état complet des univers de la salle et relaie chaque paquet aux joueurs
// et aux autres régies. Un joueur ou une régie qui arrive reçoit l'état complet.
const DMX_PACKET = 0x02;
const DMX_FLAG_FULL = 0x01;
const DMX_UNIVERSE_SIZE = 512;
const DMX_MAX_UNIVERSE = 64;
const DMX_MAX_PACKET = 64 * 1024;
// (pas PLAYERS_UPDATE : il part à chaque mouvement de joueur ; PEER_JOINED / PEER_LEFT suffisent pour le compte)
const REGIE_PLAYBACK_EVENTS = new Set(['SYNC_ACTION', 'START_PLAYBACK_SYNC', 'AUDIO_TRACK_CHANGED', 'PEER_JOINED', 'PEER_LEFT']);

function sendRegies(room, data) {
    if (!room.regies) return;
    for (const ws of room.regies.values()) send(ws, data);
}

/** Horloge musicale et état de la salle pour les régies (avec le morceau en cours : timeline du show) */
function regiePlaybackMessage(room) {
    const pb = room.playback || { currentTime: 0, isPlaying: false, timestamp: Date.now() };
    let roomId = null;
    for (const [id, r] of rooms) if (r === room) { roomId = id; break; }
    let track = null;
    if (room.currentTrack) track = { id: room.currentTrack.id, name: room.currentTrack.name, url: room.currentTrack.url || `/audio/track/${room.currentTrack.id}` };
    else if (room.audioBuffer && roomId) track = { id: null, name: room.trackName || '', url: `/audio/${roomId}` };
    return {
        type: 'REGIE_PLAYBACK',
        serverTime: Date.now(),
        playback: { currentTime: pb.currentTime || 0, isPlaying: Boolean(pb.isPlaying), timestamp: pb.timestamp || Date.now() },
        trackName: room.trackName || '',
        track,
        playerCount: room.clients.size,
    };
}

/** Vérifie puis applique un paquet DMX à l'état de la salle ; false si le paquet est invalide */
function applyDmxPacket(room, buf) {
    if (buf.length < 12 || buf.length > DMX_MAX_PACKET) return false;
    const count = buf.readUInt16LE(10);
    let o = 12;
    for (let i = 0; i < count; i++) {
        if (o + 6 > buf.length) return false;
        o += 6 + buf.readUInt16LE(o + 4);
        if (o > buf.length) return false;
    }
    if (!room.dmx) room.dmx = new Map();
    o = 12;
    for (let i = 0; i < count; i++) {
        const universe = buf.readUInt16LE(o);
        const start = buf.readUInt16LE(o + 2);
        const len = buf.readUInt16LE(o + 4);
        o += 6;
        if (universe >= 1 && universe <= DMX_MAX_UNIVERSE && start >= 1 && start + len - 1 <= DMX_UNIVERSE_SIZE) {
            let u = room.dmx.get(universe);
            if (!u) {
                u = Buffer.alloc(DMX_UNIVERSE_SIZE);
                room.dmx.set(universe, u);
            }
            buf.copy(u, start - 1, o, o + len);
        }
        o += len;
    }
    return true;
}

/** Paquet binaire à envoyer tel quel (voix, DMX) */
function sendBinary(ws, buf) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(buf, { binary: true }); } catch (_) {}
    }
}

/** Paquet DMX reçu d'une régie : état de la salle mis à jour, puis relais aux joueurs et aux autres régies */
function relayDmxPacket(ws, buf) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room || !applyDmxPacket(room, buf)) return;
    for (const peer of room.clients.values()) if (peer !== ws) sendBinary(peer, buf);
    if (room.regies) for (const peer of room.regies.values()) if (peer !== ws) sendBinary(peer, buf);
}

/** Envoie l'état DMX complet de la salle (arrivée d'un joueur ou d'une régie) */
function sendDmxState(ws, room) {
    if (!room.dmx || room.dmx.size === 0) return;
    const universes = [...room.dmx.entries()];
    const buf = Buffer.alloc(12 + universes.length * (6 + DMX_UNIVERSE_SIZE));
    buf[0] = DMX_PACKET;
    buf[1] = DMX_FLAG_FULL;
    buf.writeDoubleLE(0, 2); // 0 = appliquer tout de suite
    buf.writeUInt16LE(universes.length, 10);
    let o = 12;
    for (const [number, data] of universes) {
        buf.writeUInt16LE(number, o);
        buf.writeUInt16LE(1, o + 2);
        buf.writeUInt16LE(DMX_UNIVERSE_SIZE, o + 4);
        data.copy(buf, o + 6);
        o += 6 + DMX_UNIVERSE_SIZE;
    }
    sendBinary(ws, buf);
}

const AVATAR_COLORS = [
    '#00d2ff', // Cyan électrique
    '#ff3d00', // Rouge / Orange vif
    '#a855f7', // Violet néon
    '#22c55e', // Vert émeraude
    '#eab308', // Jaune doré
    '#ec4899', // Rose vif
    '#3b82f6', // Bleu roi
    '#f97316', // Orange mandarine
    '#06b6d4', // Turquoise
    '#10b981', // Menthe
    '#d946ef', // Magenta
    '#84cc16', // Lime
];

function getRandomAvatarColor() {
    return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

function broadcastRoomAll(room, data) {
    broadcastRoom(room, data, null);
}

function broadcastAll(data) {
    for (const [_, room] of rooms) {
        broadcastRoomAll(room, data);
    }
}

function getPlayersSnapshot(room) {
    const players = [];
    for (const [id, client] of room.clients) {
        players.push({
            id,
            role: id === room.masterId ? 'master' : 'guest',
            position: client.position || { x: 0, y: 1.7, z: 50 },
            rotY: client.rotY || 0,
            anim: client.anim || 'idle',
            onGround: client.onGround !== undefined ? client.onGround : true,
            isFlying: client.isFlying || false,
            color: client.color || '#00d2ff',
        });
    }
    return players;
}

// ─── HTTP & WebSocket Server ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
    // CORS headers for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Room-Id, X-Client-Id, X-File-Name, X-Track-Id, *');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const hostHeader = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url, `http://${hostHeader}`);

    // Endpoint: POST /upload?room=XXXXXX&name=...&clientId=...&trackId=...&addToQueue=true|false
    if (req.method === 'POST' && url.pathname === '/upload') {
        const roomId = url.searchParams.get('room') || req.headers['x-room-id'];
        const fileName = decodeURIComponent(url.searchParams.get('name') || req.headers['x-file-name'] || 'track.mp3');
        const uploaderId = url.searchParams.get('clientId') || req.headers['x-client-id'] || null;
        const trackId = url.searchParams.get('trackId') || req.headers['x-track-id'] || `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const addToQueue = url.searchParams.get('addToQueue') !== 'false' && req.headers['x-add-to-queue'] !== 'false';
        const room = roomId ? rooms.get(roomId) : null;

        if (addToQueue && !room) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Room not found' }));
            return;
        }

        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const mime = req.headers['content-type'] || 'audio/mpeg';

            // Persist audio track to disk storage
            try {
                fs.writeFileSync(path.join(AUDIO_STORAGE_DIR, `${trackId}.bin`), buffer);
                fs.writeFileSync(path.join(AUDIO_STORAGE_DIR, `${trackId}.json`), JSON.stringify({
                    id: trackId,
                    name: fileName,
                    mime: mime,
                    uploadedBy: uploaderId,
                    size: buffer.length,
                    createdAt: Date.now()
                }));
            } catch (err) {
                console.warn(`[Audio] Failed to persist track ${trackId} to disk:`, err);
            }

            const trackEntry = {
                id: trackId,
                name: fileName,
                buffer: buffer,
                mime: mime,
                uploadedBy: uploaderId,
            };

            if (room) {
                if (!room.audioTracks) room.audioTracks = new Map();
                room.audioTracks.set(trackId, trackEntry);
            }

            // Si addToQueue est faux (ex: ajout direct dans une playlist sans modifier la file d'attente)
            if (!addToQueue) {
                console.log(`[Audio] Stored track "${fileName}" (${trackId}, ${buffer.length} bytes) for playlist without modifying queue.`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, trackId, size: buffer.length, addedToQueue: false }));
                return;
            }

            if (!room.queue) room.queue = [];
            if (!room.manualQueue) room.manualQueue = [];
            if (!room.contextQueue) room.contextQueue = [];
            const queueItem = {
                id: trackId,
                name: fileName,
                mime: mime,
                url: `/audio/${roomId}/${trackId}`,
                uploadedBy: uploaderId,
            };
            room.queue.push(queueItem);

            console.log(`[Audio] Received ${buffer.length} bytes for room ${roomId}: "${fileName}" (${trackId}) from ${uploaderId || 'unknown'}. Queue length: ${room.queue.length}`);

            // Ne démarrer automatiquement que si aucune musique n'est active dans le salon
            const shouldAutoStart = (!room.currentTrack && !room.audioBuffer);

            if (shouldAutoStart) {
                room.currentQueueIndex = 0;
                room.currentTrack = queueItem;
                room.audioBuffer = buffer;
                room.audioMime = mime;
                room.trackName = fileName;
                room.playback = { currentTime: 0, isPlaying: false, timestamp: Date.now() };
                room.readyClients = new Set();
                room.isPlayingTriggered = false;
                room.isAwaitingReady = true;
                if (room.readyTimeout) clearTimeout(room.readyTimeout);

                room.queueVersion = (room.queueVersion || 0) + 1;

                broadcastRoomAll(room, getQueueStateSnapshot(room));

                broadcastRoomAll(room, {
                    type: 'QUEUE_SYNC',
                    queue: room.queue,
                    currentIndex: room.currentQueueIndex,
                });

                broadcastRoomAll(room, {
                    type: 'AUDIO_TRACK_CHANGED',
                    trackId: trackId,
                    name: fileName,
                    url: `/audio/${roomId}/${trackId}`,
                    uploadedBy: uploaderId,
                    timestamp: Date.now(),
                });

                room.readyTimeout = setTimeout(() => {
                    console.warn(`[Sync] Safety timeout reached (60s) for room ${roomId}. Triggering playback.`);
                    triggerSimultaneousPlay(room);
                }, 60000);
            } else {
                // Musique déjà en cours : ajoutée dans la file manuelle prioritaire sans interrompre la lecture
                room.manualQueue.push(queueItem);
                room.queueVersion = (room.queueVersion || 0) + 1;

                broadcastRoomAll(room, getQueueStateSnapshot(room));

                broadcastRoomAll(room, {
                    type: 'QUEUE_SYNC',
                    queue: room.queue,
                    currentIndex: room.currentQueueIndex,
                    addedTrack: queueItem,
                });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, trackId, size: buffer.length, addedToQueue: true }));
        });
        return;
    }

    // Endpoint: /api/shows — shows de la régie lumière
    if (url.pathname === '/api/shows' || url.pathname.startsWith('/api/shows/')) {
        handleShowsApi(req, res, url);
        return;
    }

    // Endpoint: GET /api/rooms — salles ouvertes (écran d'accueil de la régie)
    if (req.method === 'GET' && url.pathname === '/api/rooms') {
        const list = [...rooms.entries()].map(([id, room]) => ({
            id,
            players: room.clients.size,
            regies: room.regies ? room.regies.size : 0,
            trackName: room.trackName || '',
            createdAt: room.createdAt || 0,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
    }

    // Endpoint: GET /api/playlists
    if (req.method === 'GET' && url.pathname === '/api/playlists') {
        const list = getPlaylistsList();
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify(list));
        return;
    }

    // Endpoint: GET /audio/:roomId or /audio/:roomId/:trackId or /audio/track/:trackId
    if (req.method === 'GET' && url.pathname.startsWith('/audio/')) {
        const parts = url.pathname.slice(7).split('/');
        const roomId = parts[0];
        const trackId = parts[1];
        const room = rooms.get(roomId);

        let buffer = null;
        let mime = 'audio/mpeg';
        let trackName = 'track.mp3';

        // 1. Try to get from active room memory
        if (room) {
            if (trackId && room.audioTracks && room.audioTracks.has(trackId)) {
                const t = room.audioTracks.get(trackId);
                buffer = t.buffer;
                mime = t.mime || 'audio/mpeg';
                trackName = t.name || 'track.mp3';
            } else if (room.audioBuffer) {
                buffer = room.audioBuffer;
                mime = room.audioMime || 'audio/mpeg';
                trackName = room.trackName || 'track.mp3';
            }
        }

        // 2. Fallback to persistent disk storage (e.g. for /audio/track/:trackId or cross-session playlists)
        if (!buffer) {
            const targetTrackId = trackId || (roomId !== 'track' ? roomId : null);
            if (targetTrackId) {
                const binPath = path.join(AUDIO_STORAGE_DIR, `${targetTrackId}.bin`);
                const metaPath = path.join(AUDIO_STORAGE_DIR, `${targetTrackId}.json`);
                if (fs.existsSync(binPath)) {
                    try {
                        buffer = fs.readFileSync(binPath);
                        if (fs.existsSync(metaPath)) {
                            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                            mime = meta.mime || mime;
                            trackName = meta.name || trackName;
                        }
                    } catch (err) {
                        console.warn(`[Audio] Error reading track ${targetTrackId} from disk:`, err.message);
                    }
                }
            }
        }

        if (!buffer) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Audio track not found');
            return;
        }

        res.writeHead(200, {
            'Content-Type': mime,
            'Content-Length': buffer.length,
            'Content-Disposition': `inline; filename="${encodeURIComponent(trackName)}"`,
        });
        res.end(buffer);
        return;
    }

    // Serve static frontend files
    if (req.method === 'GET') {
        let reqPath = decodeURIComponent(url.pathname);
        if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
        if (reqPath === '/regie' || reqPath === '/regie/') reqPath = '/regie.html';
        const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
        const filePath = path.join(ROOT_DIR, safePath);

        if (fs.existsSync(filePath)) {
            try {
                const stat = fs.statSync(filePath);
                if (stat.isFile()) {
                    const ext = path.extname(filePath).toLowerCase();
                    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
                    // Cache navigateur avec revalidation : le fichier est gardé en cache et, à chaque
                    // chargement, le navigateur demande juste s'il a changé (réponse 304 vide sinon).
                    // Un fichier modifié (taille ou date) est donc toujours repris aussitôt.
                    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
                    const cacheHeaders = {
                        'Cache-Control': 'no-cache',
                        'ETag': etag,
                        'Last-Modified': stat.mtime.toUTCString(),
                    };
                    if (req.headers['if-none-match'] === etag) {
                        res.writeHead(304, cacheHeaders);
                        res.end();
                        return;
                    }
                    res.writeHead(200, {
                        'Content-Type': contentType,
                        'Content-Length': stat.size,
                        ...cacheHeaders,
                    });
                    fs.createReadStream(filePath).pipe(res);
                    return;
                }
            } catch (err) {
                console.warn('[HTTP] Error reading file:', filePath, err);
            }
        }
    }

    res.writeHead(404);
    res.end('Not found');
});

function triggerSimultaneousPlay(room) {
    if (!room) return;
    room.isAwaitingReady = false;
    room.isPlayingTriggered = true;
    if (room.readyTimeout) {
        clearTimeout(room.readyTimeout);
        room.readyTimeout = null;
    }

    // Schedule simultaneous playback (0ms for solo player, 250ms for group sync)
    const delay = room.clients.size > 1 ? 250 : 0;
    const startTime = Date.now() + delay;
    room.playback = { currentTime: 0, isPlaying: true, timestamp: startTime };

    console.log(`[Sync] Triggering simultaneous playback from 0:00 for room with ${room.clients.size} clients at timestamp ${startTime}`);
    broadcastRoomAll(room, {
        type: 'START_PLAYBACK_SYNC',
        startTime,
        startOffset: 0,
        trackName: room.trackName,
    });
}

function shuffleArray(arr) {
    const res = [...arr];
    for (let i = res.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [res[i], res[j]] = [res[j], res[i]];
    }
    return res;
}

function getQueueStateSnapshot(room) {
    return {
        type: 'QUEUE_STATE_SYNC',
        currentTrack: room.currentTrack || null,
        manualQueue: room.manualQueue || [],
        contextQueue: room.contextQueue || [],
        loadedPlaylistId: room.loadedPlaylistId || null,
        loadedPlaylistName: room.loadedPlaylistName || null,
        isShuffle: Boolean(room.isShuffle),
        queueVersion: room.queueVersion || 1,
        queue: room.queue || [],
        currentIndex: room.currentQueueIndex !== undefined ? room.currentQueueIndex : -1,
    };
}

function playTrackInRoom(room, track, roomId) {
    if (!room || !track) return;
    room.currentTrack = {
        id: track.id,
        name: track.name,
        mime: track.mime || 'audio/mpeg',
        url: track.url || `/audio/track/${track.id}`,
        uploadedBy: track.uploadedBy || 'server',
    };
    room.trackName = track.name;

    // Pre-cache audio track in memory if exists on disk
    if (!room.audioTracks) room.audioTracks = new Map();
    let trackEntry = room.audioTracks.get(track.id);
    if (!trackEntry) {
        const binPath = path.join(AUDIO_STORAGE_DIR, `${track.id}.bin`);
        if (fs.existsSync(binPath)) {
            try {
                const buf = fs.readFileSync(binPath);
                trackEntry = {
                    id: track.id,
                    name: track.name,
                    buffer: buf,
                    mime: track.mime || 'audio/mpeg',
                    uploadedBy: track.uploadedBy || 'server'
                };
                room.audioTracks.set(track.id, trackEntry);
            } catch (err) {
                console.warn(`[Sync] Error reading audio for track ${track.id}:`, err);
            }
        }
    }

    if (trackEntry && trackEntry.buffer) {
        room.audioBuffer = trackEntry.buffer;
        room.audioMime = trackEntry.mime;
    }

    room.playback = { currentTime: 0, isPlaying: false, timestamp: Date.now() };
    room.readyClients = new Set();
    room.isPlayingTriggered = false;
    room.isAwaitingReady = true;
    if (room.readyTimeout) clearTimeout(room.readyTimeout);

    room.queueVersion = (room.queueVersion || 0) + 1;

    // Broadcast full queue state snapshot immediately to ALL clients
    broadcastRoomAll(room, getQueueStateSnapshot(room));

    // Broadcast audio track changed event to trigger download and decode
    broadcastRoomAll(room, {
        type: 'AUDIO_TRACK_CHANGED',
        trackId: track.id,
        name: track.name,
        url: track.url || `/audio/track/${track.id}`,
        uploadedBy: track.uploadedBy,
        timestamp: Date.now(),
    });

    room.readyTimeout = setTimeout(() => {
        console.warn(`[Sync] Safety timeout reached (7s) for room ${roomId}. Triggering playback.`);
        triggerSimultaneousPlay(room);
    }, 7000);
}

const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
    console.log(`[SoundStage3D] HTTP & WebSocket server listening on port ${PORT}`);
});

wss.on('connection', (ws) => {
    const clientId = generateClientId();
    ws.clientId = clientId;
    ws.roomId = null;
    ws.position = { x: 0, y: 1.7, z: 50 };
    ws.rotY = 0;
    ws.color = getRandomAvatarColor();

    console.log(`[+] Client connected: ${clientId} (color: ${ws.color})`);

    ws.on('message', (raw, isBinary) => {
        // Paquets DMX de la régie
        if (isBinary && Buffer.isBuffer(raw) && raw.length > 0 && raw[0] === DMX_PACKET) {
            relayDmxPacket(ws, raw);
            return;
        }

        // Fast path : relais immédiat des paquets vocaux binaires (Micro)
        if (isBinary || (Buffer.isBuffer(raw) && raw.length > 0 && raw[0] === 0x01)) {
            if (!ws.roomId) return;
            const room = rooms.get(ws.roomId);
            if (!room) return;

            for (const [peerId, peerWs] of room.clients) {
                if (peerId !== clientId && peerWs.readyState === WebSocket.OPEN) {
                    try {
                        peerWs.send(raw, { binary: true });
                    } catch (_) {}
                }
            }
            return;
        }

        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            send(ws, { type: 'ERROR', message: 'Invalid JSON' });
            return;
        }

        switch (msg.type) {

            // ─── CREATE_ROOM ──────────────────────────────────────────────
            case 'CREATE_ROOM': {
                createRoom(ws, clientId, generateRoomId(), null);
                break;
            }

            // ─── JOIN_ROOM ────────────────────────────────────────────────
            case 'JOIN_ROOM': {
                const roomId = String(msg.roomId || '').toUpperCase();
                const room = rooms.get(roomId);
                if (!room) {
                    // Salle permanente : (re)créée depuis son monde sauvegardé (ou le monde par défaut)
                    if (isPermanentRoomName(roomId)) createRoom(ws, clientId, roomId, roomId);
                    else send(ws, { type: 'ROOM_NOT_FOUND', roomId });
                    return;
                }

                room.clients.set(clientId, ws);
                ws.roomId = roomId;

                console.log(`[Room] ${clientId} joined ${roomId}`);

                // Send full state to new peer
                send(ws, {
                    type: 'ROOM_JOINED',
                    roomId,
                    clientId,
                    isFirstInRoom: false,
                    color: ws.color,
                    publicIp: publicIp || null,
                    webPort: 8067,
                    audioPort: PORT,
                    dspState: room.dspState,
                    lightingState: room.lightingState || defaultLightingState(),
                    lightingVersion: room.lightingVersion || 1,
                    playback: room.playback,
                    sine: room.sine,
                    trackName: room.trackName,
                    audioUrl: room.audioBuffer ? `/audio/${roomId}` : null,
                    queue: room.queue || [],
                    currentQueueIndex: room.currentQueueIndex !== undefined ? room.currentQueueIndex : -1,
                    currentTrack: room.currentTrack || null,
                    manualQueue: room.manualQueue || [],
                    contextQueue: room.contextQueue || [],
                    isShuffle: Boolean(room.isShuffle),
                    queueVersion: room.queueVersion || 1,
                    loadedPlaylistId: room.loadedPlaylistId || null,
                    loadedPlaylistName: room.loadedPlaylistName || null,
                    playlists: getPlaylistsList(),
                    players: getPlayersSnapshot(room),
                    serverTime: Date.now(),
                    sweepTime: Math.max(0, (Date.now() - (room.createdAt || Date.now())) / 1000),
                    persistent: Boolean(room.persistent),
                });

                sendDmxState(ws, room);

                // Notify existing clients
                broadcastRoom(room, { type: 'PEER_JOINED', peerId: clientId }, clientId);

                // Broadcast updated player list to everyone
                broadcastRoomAll(room, {
                    type: 'PLAYERS_UPDATE',
                    players: getPlayersSnapshot(room),
                });
                break;
            }

            // ─── REGIE_JOIN (page régie lumière : client à part, sans avatar) ──
            case 'REGIE_JOIN': {
                const roomId = String(msg.roomId || '').toUpperCase();
                const room = rooms.get(roomId);
                if (!room) {
                    send(ws, { type: 'ROOM_NOT_FOUND', roomId });
                    return;
                }
                if (!room.regies) room.regies = new Map();
                room.regies.set(clientId, ws);
                ws.roomId = roomId;
                ws.isRegie = true;
                console.log(`[Régie] ${clientId} ouvre la régie de ${roomId} (${room.regies.size} régie(s))`);
                send(ws, { ...regiePlaybackMessage(room), type: 'REGIE_JOINED', roomId, clientId });
                if (room.patchFixtures) send(ws, { type: 'PATCH', fixtures: room.patchFixtures });
                sendDmxState(ws, room);
                break;
            }

            // ─── FIXTURE_STATE_REQUEST (régie) → un joueur → FIXTURE_STATE (régie) ──
            // Valeurs DMX équivalentes aux réglages actuels des projecteurs : la régie les reprend
            // avant de prendre la main, pour que la lumière ne change pas à la prise de contrôle.
            case 'FIXTURE_STATE_REQUEST': {
                if (!ws.roomId || !ws.isRegie) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                const target = room.clients.get(room.masterId) || room.clients.values().next().value;
                send(target, { type: 'FIXTURE_STATE_REQUEST', regieId: clientId, requestId: msg.requestId, keys: Array.isArray(msg.keys) ? msg.keys.slice(0, 2000) : [] });
                break;
            }

            case 'FIXTURE_STATE': {
                if (!ws.roomId || ws.isRegie) return;
                const room = rooms.get(ws.roomId);
                const regie = room && room.regies ? room.regies.get(msg.regieId) : null;
                if (regie) send(regie, { type: 'FIXTURE_STATE', requestId: msg.requestId, states: msg.states || {} });
                break;
            }

            // ─── PATCH_REPORT (liste des projecteurs du jeu, pour les régies) ──
            // Chaque joueur l'envoie quand elle change (src/dmx/PatchReporter.js) ; identique chez tous.
            case 'PATCH_REPORT': {
                if (!ws.roomId || ws.isRegie) return;
                const room = rooms.get(ws.roomId);
                if (!room || !Array.isArray(msg.fixtures) || msg.fixtures.length > 2000) return;
                const json = JSON.stringify(msg.fixtures);
                if (json.length > 512 * 1024 || json === room.patchJson) return;
                room.patchJson = json;
                room.patchFixtures = msg.fixtures;
                sendRegies(room, { type: 'PATCH', fixtures: msg.fixtures });
                break;
            }

            // ─── DSP_CHANGE ───────────────────────────────────────────────
            case 'DSP_CHANGE': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;

                const { bus, param, value } = msg;

                // Update server-side DSP state (source of truth)
                if (room.dspState[bus]) {
                    room.dspState[bus][param] = value;
                    scheduleWorldSave(room);
                }

                // Broadcast to everyone EXCEPT the sender (sender already applied locally)
                broadcastRoom(room, { type: 'DSP_UPDATE', bus, param, value }, clientId);
                break;
            }

            // ─── LIGHTING_CHANGE ──────────────────────────────────────────
            case 'LIGHTING_CHANGE': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;

                if (!room.lightingState) {
                    room.lightingState = defaultLightingState();
                }

                room.lightingVersion = (room.lightingVersion || 1) + 1;
                console.log(`[Lighting] Change from ${clientId} in ${ws.roomId} (v${room.lightingVersion}): cat=${msg.category}, id=${msg.id}`);
                applyLightingChange(room.lightingState, msg);
                scheduleWorldSave(room);

                // Broadcast to everyone EXCEPT the sender (sender already applied locally)
                broadcastRoom(room, {
                    ...msg,
                    type: 'LIGHTING_UPDATE',
                    version: room.lightingVersion,
                }, clientId);
                break;
            }

            // ─── GET_LIGHTING_STATE ────────────────────────────────────────
            case 'GET_LIGHTING_STATE': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                send(ws, {
                    type: 'LIGHTING_FULL_SYNC',
                    lightingState: room.lightingState || defaultLightingState(),
                    version: room.lightingVersion || 1,
                });
                break;
            }

            // ─── PLAYER_POS ───────────────────────────────────────────────
            case 'PLAYER_POS': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;

                ws.position = { x: msg.x, y: msg.y, z: msg.z };
                ws.rotY = msg.rotY || 0;
                ws.anim = msg.anim || 'idle';
                ws.onGround = msg.onGround !== undefined ? msg.onGround : true;
                ws.isFlying = msg.isFlying || false;

                // Broadcast updated player positions to OTHERS only (not back to sender)
                broadcastRoom(room, {
                    type: 'PLAYERS_UPDATE',
                    players: getPlayersSnapshot(room),
                }, clientId);
                break;
            }

            // ─── TRACK_BUFFER_READY ───────────────────────────────────────
            case 'TRACK_BUFFER_READY': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;

                if (!room.readyClients) room.readyClients = new Set();
                room.readyClients.add(clientId);
                console.log(`[Sync] Client ${clientId} ready for playback (${room.readyClients.size}/${room.clients.size}) in ${ws.roomId}`);

                // If room is transitioning to a new track, wait for all clients (or timeout) to start from 0:00
                if (room.isAwaitingReady) {
                    if (room.readyClients.size >= room.clients.size) {
                        triggerSimultaneousPlay(room);
                    }
                    break;
                }

                if (room.playback && room.playback.isPlaying) {
                    room.isPlayingTriggered = true;
                    // Les autres joueurs sont déjà en train d'écouter ce morceau !
                    const elapsed = Math.max(0, (Date.now() - (room.playback.timestamp || Date.now())) / 1000);
                    const currentOffset = (room.playback?.currentTime || 0) + elapsed;
                    send(ws, {
                        type: 'START_PLAYBACK_SYNC',
                        startTime: Date.now(),
                        startOffset: currentOffset,
                        trackName: room.trackName,
                    });
                }
                break;
            }

            // ─── SYNC_ACTION ─────────────────────────────────────────────
            // Generic relay for one-shot events: play/pause, seek, sine, etc.
            case 'SYNC_ACTION': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;

                // While waiting for clients to download and decode the new track, reject playback actions
                if (room.readyClients && !room.isPlayingTriggered && room.readyClients.size < room.clients.size) {
                    if (['play_pause', 'seek', 'skip', 'prev', 'next'].includes(msg.action)) {
                        console.log(`[Sync] Ignored action '${msg.action}' while room ${ws.roomId} is loading new track (${room.readyClients.size}/${room.clients.size} ready).`);
                        return;
                    }
                }

                // Keep server state up to date
                if (msg.action === 'play_pause') {
                    if (room.playback) {
                        room.playback.isPlaying = msg.data.isPlaying !== undefined ? msg.data.isPlaying : !room.playback.isPlaying;
                        if (msg.data.currentTime !== undefined) room.playback.currentTime = msg.data.currentTime;
                        room.playback.timestamp = Date.now();
                        if (room.playback.isPlaying) {
                            room.isPlayingTriggered = true;
                        }
                    }
                } else if (msg.action === 'seek') {
                    if (room.playback) {
                        room.playback.currentTime = msg.data.currentTime;
                        room.playback.timestamp = Date.now();
                    }
                } else if (msg.action === 'skip' || msg.action === 'next' || msg.action === 'prev') {
                    if (room.playback) {
                        room.playback.currentTime = 0;
                        room.playback.timestamp = Date.now();
                        room.isPlayingTriggered = false;
                    }
                } else if (msg.action === 'sine_toggle') {
                    if (room.sine) {
                        room.sine.active = msg.data.active;
                        if (msg.data.frequency) room.sine.frequency = msg.data.frequency;
                        if (msg.data.volume !== undefined) room.sine.volume = msg.data.volume;
                    }
                } else if (msg.action === 'sine_freq') {
                    if (room.sine) room.sine.frequency = msg.data.value;
                } else if (msg.action === 'sine_vol') {
                    if (room.sine) room.sine.volume = msg.data.value;
                } else if (msg.action === 'track_name') {
                    room.trackName = msg.data.name;
                } else if (msg.action === 'stop_playback') {
                    room.currentTrack = null;
                    room.audioBuffer = null;
                    room.trackName = '';
                    room.playback = { currentTime: 0, isPlaying: false, timestamp: Date.now() };
                    room.queue = [];
                    room.currentQueueIndex = -1;
                    room.manualQueue = [];
                    room.contextQueue = [];
                    room.queueVersion = (room.queueVersion || 0) + 1;
                    broadcastRoomAll(room, getQueueStateSnapshot(room));
                }

                // Relay to everyone else — sender already applied locally
                broadcastRoom(room, {
                    type: 'SYNC_ACTION',
                    action: msg.action,
                    data: msg.data ?? {},
                }, clientId);
                break;
            }

            // NOTE: PLAYBACK_SYNC (master → server → guests) est supprimé.
            // Le serveur est la source de vérité du temps musical via room.playback,
            // mis à jour par les actions play_pause / seek / skip. Le heartbeat
            // HEARTBEAT_SYNC (toutes les 2s) diffuse musicTime calculé par le serveur
            // à tous les clients. Cela évite la boucle drift : master envoie son temps
            // → serveur le reçoit avec latence → heartbeat le renvoie → master se corrige
            // sur lui-même avec un décalage → drift en boucle.
            case 'PLAYBACK_SYNC': {
                // Ignoré — le master ne doit plus envoyer sa position audio périodiquement
                // Le serveur calcule musicTime lui-même dans le heartbeat
                break;
            }

            // ─── QUEUE_MANUAL_ADD (Add track to priority manual queue) ────
            case 'QUEUE_MANUAL_ADD': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                const { track } = msg;
                if (!track || !track.id) return;
                if (!room.manualQueue) room.manualQueue = [];

                // Pre-cache audio if available on disk
                const binPath = path.join(AUDIO_STORAGE_DIR, `${track.id}.bin`);
                if (fs.existsSync(binPath) && (!room.audioTracks || !room.audioTracks.has(track.id))) {
                    try {
                        const buf = fs.readFileSync(binPath);
                        if (!room.audioTracks) room.audioTracks = new Map();
                        room.audioTracks.set(track.id, {
                            id: track.id,
                            name: track.name,
                            buffer: buf,
                            mime: track.mime || 'audio/mpeg',
                            uploadedBy: track.uploadedBy || 'server'
                        });
                    } catch (_) {}
                }

                const item = {
                    id: track.id,
                    name: track.name,
                    url: track.url || `/audio/track/${track.id}`,
                    mime: track.mime || 'audio/mpeg',
                    uploadedBy: track.uploadedBy || clientId,
                };

                if (!room.currentTrack && !room.audioBuffer) {
                    playTrackInRoom(room, item, ws.roomId);
                } else {
                    room.manualQueue.push(item);
                    room.queueVersion = (room.queueVersion || 0) + 1;
                    broadcastRoomAll(room, getQueueStateSnapshot(room));
                }
                console.log(`[Queue] Manual track added "${item.name}" by ${clientId} in ${ws.roomId} (v${room.queueVersion})`);
                break;
            }

            // ─── QUEUE_MANUAL_ADD_BATCH (Add multiple tracks to priority queue) ─
            case 'QUEUE_MANUAL_ADD_BATCH': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
                if (tracks.length === 0) return;
                if (!room.manualQueue) room.manualQueue = [];

                const items = tracks.map(t => ({
                    id: t.id,
                    name: t.name,
                    url: t.url || `/audio/track/${t.id}`,
                    mime: t.mime || 'audio/mpeg',
                    uploadedBy: t.uploadedBy || clientId,
                }));

                if (!room.currentTrack && !room.audioBuffer) {
                    const first = items.shift();
                    room.manualQueue.push(...items);
                    playTrackInRoom(room, first, ws.roomId);
                } else {
                    room.manualQueue.push(...items);
                    room.queueVersion = (room.queueVersion || 0) + 1;
                    broadcastRoomAll(room, getQueueStateSnapshot(room));
                }
                console.log(`[Queue] Manual batch added ${tracks.length} tracks by ${clientId} in ${ws.roomId} (v${room.queueVersion})`);
                break;
            }

            // ─── QUEUE_MANUAL_REMOVE (Remove track from priority queue) ───
            case 'QUEUE_MANUAL_REMOVE': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room || !room.manualQueue) return;
                const { index } = msg;
                if (index < 0 || index >= room.manualQueue.length) return;
                const [removed] = room.manualQueue.splice(index, 1);
                room.queueVersion = (room.queueVersion || 0) + 1;
                broadcastRoomAll(room, getQueueStateSnapshot(room));
                console.log(`[Queue] Manual removed "${removed?.name}" at index ${index} by ${clientId} (v${room.queueVersion})`);
                break;
            }

            // ─── QUEUE_MANUAL_REORDER (Reorder priority queue) ───────────
            case 'QUEUE_MANUAL_REORDER': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room || !room.manualQueue) return;
                const { fromIdx, toIdx } = msg;
                if (fromIdx < 0 || fromIdx >= room.manualQueue.length || toIdx < 0 || toIdx >= room.manualQueue.length) return;
                const [moved] = room.manualQueue.splice(fromIdx, 1);
                room.manualQueue.splice(toIdx, 0, moved);
                room.queueVersion = (room.queueVersion || 0) + 1;
                broadcastRoomAll(room, getQueueStateSnapshot(room));
                console.log(`[Queue] Manual reordered ${fromIdx} -> ${toIdx} by ${clientId} (v${room.queueVersion})`);
                break;
            }

            // ─── QUEUE_MANUAL_CLEAR (Clear priority queue) ────────────────
            case 'QUEUE_MANUAL_CLEAR': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                room.manualQueue = [];
                room.queueVersion = (room.queueVersion || 0) + 1;
                broadcastRoomAll(room, getQueueStateSnapshot(room));
                console.log(`[Queue] Manual queue cleared by ${clientId} (v${room.queueVersion})`);
                break;
            }

            // ─── QUEUE_CONTEXT_REMOVE (Remove track from context queue) ───
            case 'QUEUE_CONTEXT_REMOVE': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room || !room.contextQueue) return;
                const { index } = msg;
                if (index < 0 || index >= room.contextQueue.length) return;
                const [removed] = room.contextQueue.splice(index, 1);
                room.queueVersion = (room.queueVersion || 0) + 1;
                broadcastRoomAll(room, getQueueStateSnapshot(room));
                console.log(`[Queue] Context removed "${removed?.name}" at index ${index} by ${clientId} (v${room.queueVersion})`);
                break;
            }

            // ─── QUEUE_CONTEXT_REORDER (Reorder context queue) ───────────
            case 'QUEUE_CONTEXT_REORDER': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room || !room.contextQueue) return;
                const { fromIdx, toIdx } = msg;
                if (fromIdx < 0 || fromIdx >= room.contextQueue.length || toIdx < 0 || toIdx >= room.contextQueue.length) return;
                const [moved] = room.contextQueue.splice(fromIdx, 1);
                room.contextQueue.splice(toIdx, 0, moved);
                room.queueVersion = (room.queueVersion || 0) + 1;
                broadcastRoomAll(room, getQueueStateSnapshot(room));
                console.log(`[Queue] Context reordered ${fromIdx} -> ${toIdx} by ${clientId} (v${room.queueVersion})`);
                break;
            }

            // ─── QUEUE_CONTEXT_SELECT (Play a specific track from context queue) ─
            case 'QUEUE_CONTEXT_SELECT': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room || !room.contextQueue) return;
                const { index } = msg;
                if (index < 0 || index >= room.contextQueue.length) return;
                const selected = room.contextQueue[index];
                room.contextQueue = room.contextQueue.slice(index + 1);
                playTrackInRoom(room, selected, ws.roomId);
                console.log(`[Queue] Context track selected "${selected.name}" by ${clientId} (v${room.queueVersion})`);
                break;
            }

            // ─── QUEUE_SHUFFLE_TOGGLE (Toggle shuffle and sync context queue) ─
            case 'QUEUE_SHUFFLE_TOGGLE': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                const { isShuffle, contextQueue } = msg;
                room.isShuffle = Boolean(isShuffle);
                if (Array.isArray(contextQueue)) {
                    room.contextQueue = contextQueue;
                } else if (room.loadedPlaylistId) {
                    const pl = getPlaylistById(room.loadedPlaylistId);
                    if (pl && Array.isArray(pl.tracks)) {
                        const curId = room.currentTrack?.id;
                        const others = pl.tracks.filter(t => t.id !== curId);
                        room.contextQueue = room.isShuffle ? shuffleArray(others) : others;
                    }
                }
                room.queueVersion = (room.queueVersion || 0) + 1;
                broadcastRoomAll(room, getQueueStateSnapshot(room));
                console.log(`[Queue] Shuffle toggled to ${room.isShuffle} by ${clientId} (v${room.queueVersion})`);
                break;
            }

            // ─── QUEUE_NEXT (Skip / Advance to next track) ────────────────
            case 'QUEUE_NEXT': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                if (Date.now() - (room.lastAdvanceTime || 0) < 300) return;
                room.lastAdvanceTime = Date.now();

                let nextTrack = null;
                if (room.manualQueue && room.manualQueue.length > 0) {
                    nextTrack = room.manualQueue.shift();
                } else if (room.contextQueue && room.contextQueue.length > 0) {
                    nextTrack = room.contextQueue.shift();
                } else if (room.loadedPlaylistId) {
                    const pl = getPlaylistById(room.loadedPlaylistId);
                    if (pl && Array.isArray(pl.tracks) && pl.tracks.length > 0) {
                        let upcoming = pl.tracks.map(t => ({
                            id: t.id,
                            name: t.name,
                            mime: t.mime || 'audio/mpeg',
                            url: t.url || `/audio/track/${t.id}`,
                            uploadedBy: t.uploadedBy || 'server'
                        }));
                        if (room.isShuffle) upcoming = shuffleArray(upcoming);
                        nextTrack = upcoming.shift();
                        room.contextQueue = upcoming;
                    }
                }

                if (nextTrack) {
                    playTrackInRoom(room, nextTrack, ws.roomId);
                    console.log(`[Queue] Next track "${nextTrack.name}" triggered by ${clientId} (v${room.queueVersion})`);
                } else {
                    room.currentTrack = null;
                    room.audioBuffer = null;
                    room.trackName = '';
                    room.playback = { currentTime: 0, isPlaying: false, timestamp: Date.now() };
                    room.queue = [];
                    room.currentQueueIndex = -1;
                    room.manualQueue = [];
                    room.contextQueue = [];
                    room.queueVersion = (room.queueVersion || 0) + 1;
                    broadcastRoomAll(room, getQueueStateSnapshot(room));
                    broadcastRoomAll(room, {
                        type: 'SYNC_ACTION',
                        action: 'stop_playback',
                        data: {},
                    });
                    console.log(`[Queue] Queue ended, playback stopped by ${clientId} (v${room.queueVersion})`);
                }
                break;
            }

            // ─── QUEUE_PREV (Previous track or restart) ───────────────────
            case 'QUEUE_PREV': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                if (Date.now() - (room.lastAdvanceTime || 0) < 300) return;
                room.lastAdvanceTime = Date.now();

                if (room.loadedPlaylistId && room.currentTrack) {
                    const pl = getPlaylistById(room.loadedPlaylistId);
                    if (pl && Array.isArray(pl.tracks)) {
                        const curIdx = pl.tracks.findIndex(t => t.id === room.currentTrack.id || t.name === room.currentTrack.name);
                        if (curIdx > 0) {
                            const prevTrack = pl.tracks[curIdx - 1];
                            if (!room.contextQueue) room.contextQueue = [];
                            room.contextQueue.unshift({ ...room.currentTrack });
                            playTrackInRoom(room, prevTrack, ws.roomId);
                            console.log(`[Queue] Prev track "${prevTrack.name}" triggered by ${clientId} (v${room.queueVersion})`);
                            return;
                        }
                    }
                }

                if (room.playback) {
                    room.playback.currentTime = 0;
                    room.playback.timestamp = Date.now();
                }
                broadcastRoomAll(room, { type: 'SYNC_ACTION', action: 'seek', data: { currentTime: 0 } });
                break;
            }

            // ─── QUEUE_CHECK_SYNC (Lightweight client periodic heartbeat) ─
            case 'QUEUE_CHECK_SYNC': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                if (msg.version !== room.queueVersion) {
                    console.log(`[Queue] Periodic check: Desync detected for ${clientId} (client v${msg.version} vs server v${room.queueVersion}). Resyncing.`);
                    send(ws, getQueueStateSnapshot(room));
                }
                break;
            }

            // ─── QUEUE_STATE_GET (Explicit request for full snapshot) ──────
            case 'QUEUE_STATE_GET': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                send(ws, getQueueStateSnapshot(room));
                break;
            }

            // ─── QUEUE_REORDER (Legacy support) ──────────────────────────
            case 'QUEUE_REORDER': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room || !room.queue) return;
                const { fromIdx, toIdx } = msg;
                if (fromIdx < 0 || fromIdx >= room.queue.length || toIdx < 0 || toIdx >= room.queue.length) return;

                const [moved] = room.queue.splice(fromIdx, 1);
                room.queue.splice(toIdx, 0, moved);

                if (room.currentQueueIndex === fromIdx) {
                    room.currentQueueIndex = toIdx;
                } else if (fromIdx < room.currentQueueIndex && toIdx >= room.currentQueueIndex) {
                    room.currentQueueIndex--;
                } else if (fromIdx > room.currentQueueIndex && toIdx <= room.currentQueueIndex) {
                    room.currentQueueIndex++;
                }

                room.queueVersion = (room.queueVersion || 0) + 1;
                broadcastRoomAll(room, getQueueStateSnapshot(room));
                broadcastRoomAll(room, {
                    type: 'QUEUE_SYNC',
                    queue: room.queue,
                    currentIndex: room.currentQueueIndex,
                });
                break;
            }

            // ─── QUEUE_ADD_TRACK (Legacy support) ─────────────────────────
            case 'QUEUE_ADD_TRACK': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                const { track } = msg;
                if (!track || !track.id) return;
                if (!room.queue) room.queue = [];
                if (!room.audioTracks) room.audioTracks = new Map();

                const binPath = path.join(AUDIO_STORAGE_DIR, `${track.id}.bin`);
                if (fs.existsSync(binPath) && !room.audioTracks.has(track.id)) {
                    try {
                        const buf = fs.readFileSync(binPath);
                        room.audioTracks.set(track.id, {
                            id: track.id,
                            name: track.name,
                            buffer: buf,
                            mime: track.mime || 'audio/mpeg',
                            uploadedBy: track.uploadedBy || 'server'
                        });
                    } catch (err) {
                        console.warn(`[Queue] Error reading audio for track ${track.id}:`, err);
                    }
                }

                const wasEmpty = room.queue.length === 0;
                const newTrack = {
                    id: track.id,
                    name: track.name,
                    url: `/audio/track/${track.id}`,
                    mime: track.mime || 'audio/mpeg',
                    uploadedBy: track.uploadedBy || ws.nickname || 'user'
                };
                room.queue.push(newTrack);

                if (wasEmpty) {
                    playTrackInRoom(room, newTrack, ws.roomId);
                } else {
                    if (!room.manualQueue) room.manualQueue = [];
                    room.manualQueue.push(newTrack);
                    room.queueVersion = (room.queueVersion || 0) + 1;
                    broadcastRoomAll(room, getQueueStateSnapshot(room));
                }

                broadcastRoomAll(room, {
                    type: 'QUEUE_SYNC',
                    queue: room.queue,
                    currentIndex: room.currentQueueIndex
                });
                break;
            }

            // ─── QUEUE_ADD_TRACKS (Batch add tracks from playlist - Legacy) ─
            case 'QUEUE_ADD_TRACKS': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
                if (tracks.length === 0) return;
                if (!room.queue) room.queue = [];
                if (!room.manualQueue) room.manualQueue = [];

                for (const track of tracks) {
                    if (!track || !track.id) continue;
                    const newTrack = {
                        id: track.id,
                        name: track.name,
                        url: `/audio/track/${track.id}`,
                        mime: track.mime || 'audio/mpeg',
                        uploadedBy: track.uploadedBy || ws.nickname || 'user'
                    };
                    room.queue.push(newTrack);
                    room.manualQueue.push(newTrack);
                }

                room.queueVersion = (room.queueVersion || 0) + 1;
                broadcastRoomAll(room, getQueueStateSnapshot(room));
                broadcastRoomAll(room, {
                    type: 'QUEUE_SYNC',
                    queue: room.queue,
                    currentIndex: room.currentQueueIndex
                });
                break;
            }

            // ─── QUEUE_REMOVE (Legacy support) ───────────────────────────
            case 'QUEUE_REMOVE': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room || !room.queue) return;
                const { index } = msg;
                if (index < 0 || index >= room.queue.length) return;

                const removed = room.queue.splice(index, 1)[0];
                room.queueVersion = (room.queueVersion || 0) + 1;
                broadcastRoomAll(room, getQueueStateSnapshot(room));
                broadcastRoomAll(room, {
                    type: 'QUEUE_SYNC',
                    queue: room.queue,
                    currentIndex: room.currentQueueIndex,
                });
                break;
            }

            // ─── QUEUE_PLAY_INDEX (Legacy support) ───────────────────────
            case 'QUEUE_PLAY_INDEX': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room || !room.queue) return;
                const { index } = msg;
                if (index < 0 || index >= room.queue.length) return;

                room.currentQueueIndex = index;
                const item = room.queue[index];
                playTrackInRoom(room, item, ws.roomId);
                break;
            }

            // ─── PLAYLISTS_GET ───────────────────────────────────────────
            case 'PLAYLISTS_GET': {
                send(ws, {
                    type: 'PLAYLISTS_SYNC',
                    playlists: getPlaylistsList(),
                });
                break;
            }

            // ─── PLAYLIST_SAVE ───────────────────────────────────────────
            case 'PLAYLIST_SAVE': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                const { name, playlistId, tracks: inputTracks } = msg;

                const sourceTracks = Array.isArray(inputTracks) ? inputTracks : [];

                const existing = playlistId ? getPlaylistById(playlistId) : null;
                const targetId = existing ? existing.id : (playlistId || `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
                const targetName = (name && name.trim()) || (existing ? existing.name : 'Nouvelle Playlist');

                const tracks = [];
                for (const item of sourceTracks) {
                    let mime = item.mime || 'audio/mpeg';
                    const trackEntry = room && room.audioTracks ? room.audioTracks.get(item.id) : null;
                    if (trackEntry && trackEntry.buffer) {
                        mime = trackEntry.mime || mime;
                        const binPath = path.join(AUDIO_STORAGE_DIR, `${item.id}.bin`);
                        if (!fs.existsSync(binPath)) {
                            try { fs.writeFileSync(binPath, trackEntry.buffer); } catch (_) {}
                        }
                    }
                    const binPath = path.join(AUDIO_STORAGE_DIR, `${item.id}.bin`);
                    const onServer = fs.existsSync(binPath);
                    tracks.push({
                        id: item.id,
                        name: item.name,
                        mime: mime,
                        url: item.url || `/audio/track/${item.id}`,
                        uploadedBy: item.uploadedBy || clientId,
                        onServer: onServer,
                    });
                }

                const playlistData = {
                    id: targetId,
                    name: targetName,
                    createdAt: existing ? existing.createdAt : Date.now(),
                    updatedAt: Date.now(),
                    tracks: tracks,
                };

                savePlaylistOnDisk(playlistData);
                console.log(`[Playlist] Saved "${targetName}" (${targetId}) with ${tracks.length} tracks by ${clientId}`);

                broadcastAll({
                    type: 'PLAYLISTS_SYNC',
                    playlists: getPlaylistsList(),
                    savedPlaylistId: targetId,
                    savedPlaylistName: targetName,
                    authorId: clientId,
                });
                break;
            }

            // ─── PLAYLIST_LOAD ───────────────────────────────────────────
            case 'PLAYLIST_LOAD': {
                if (!ws.roomId) return;
                const room = rooms.get(ws.roomId);
                if (!room) return;
                const { playlistId, startIndex, shuffle = false } = msg;
                const pl = getPlaylistById(playlistId);
                if (!pl || !Array.isArray(pl.tracks) || pl.tracks.length === 0) {
                    send(ws, { type: 'ERROR', message: 'Playlist introuvable ou vide.' });
                    return;
                }

                if (!room.audioTracks) room.audioTracks = new Map();
                for (const t of pl.tracks) {
                    const binPath = path.join(AUDIO_STORAGE_DIR, `${t.id}.bin`);
                    if (fs.existsSync(binPath)) {
                        try {
                            const buf = fs.readFileSync(binPath);
                            room.audioTracks.set(t.id, {
                                id: t.id,
                                name: t.name,
                                buffer: buf,
                                mime: t.mime || 'audio/mpeg',
                                uploadedBy: t.uploadedBy || 'server'
                            });
                        } catch (err) {
                            console.warn(`[Playlist] Error reading audio for track ${t.id}:`, err);
                        }
                    }
                }

                const formattedTracks = pl.tracks.map(t => ({
                    id: t.id,
                    name: t.name,
                    url: t.url || `/audio/track/${t.id}`,
                    mime: t.mime || 'audio/mpeg',
                    uploadedBy: t.uploadedBy || 'server'
                }));

                room.queue = formattedTracks;
                room.loadedPlaylistId = pl.id;
                room.loadedPlaylistName = pl.name;
                room.isShuffle = Boolean(shuffle);

                let validIndex = 0;
                if (typeof startIndex === 'number' && startIndex >= 0 && startIndex < formattedTracks.length) {
                    validIndex = startIndex;
                } else if (room.isShuffle && formattedTracks.length > 1) {
                    validIndex = Math.floor(Math.random() * formattedTracks.length);
                }
                room.currentQueueIndex = validIndex;
                const curTrack = formattedTracks[validIndex];

                if (room.isShuffle) {
                    const others = formattedTracks.filter((_, idx) => idx !== validIndex);
                    room.contextQueue = shuffleArray(others);
                } else {
                    room.contextQueue = formattedTracks.slice(validIndex + 1);
                }

                if (!room.manualQueue) room.manualQueue = [];

                console.log(`[Playlist] Loaded "${pl.name}" (${pl.id}) at index ${validIndex} (shuffle: ${room.isShuffle}) into room ${ws.roomId} (${formattedTracks.length} tracks)`);

                playTrackInRoom(room, curTrack, ws.roomId);
                break;
            }

            // ─── PLAYLIST_RENAME ─────────────────────────────────────────
            case 'PLAYLIST_RENAME': {
                const { playlistId, newName } = msg;
                if (playlistId && newName && newName.trim()) {
                    const pl = getPlaylistById(playlistId);
                    if (pl) {
                        pl.name = newName.trim();
                        pl.updatedAt = Date.now();
                        savePlaylistOnDisk(pl);
                        console.log(`[Playlist] Renamed ${playlistId} to "${pl.name}" by ${clientId}`);
                        broadcastAll({
                            type: 'PLAYLISTS_SYNC',
                            playlists: getPlaylistsList(),
                            authorId: clientId,
                        });
                    }
                }
                break;
            }

            // ─── PLAYLIST_DELETE ─────────────────────────────────────────
            case 'PLAYLIST_DELETE': {
                const { playlistId } = msg;
                if (playlistId) {
                    deletePlaylistOnDisk(playlistId);
                    console.log(`[Playlist] Deleted ${playlistId} by ${clientId}`);
                    broadcastAll({
                        type: 'PLAYLISTS_SYNC',
                        playlists: getPlaylistsList(),
                        authorId: clientId,
                    });
                }
                break;
            }

            // ─── PING ─────────────────────────────────────────────────────
            case 'PING': {
                // t : heure d'envoi du client (renvoyée) ; serverTime : estimation de l'horloge serveur (ServerClock.js)
                send(ws, { type: 'PONG', t: msg.t, serverTime: Date.now() });
                break;
            }

            default:
                send(ws, { type: 'ERROR', message: `Unknown message type: ${msg.type}` });
        }
    });

    ws.on('close', () => {
        console.log(`[-] Client disconnected: ${clientId}`);
        if (!ws.roomId) return;

        const room = rooms.get(ws.roomId);
        if (!room) return;

        if (ws.isRegie) {
            if (room.regies) room.regies.delete(clientId);
            console.log(`[Régie] ${clientId} ferme la régie de ${ws.roomId}`);
            return;
        }

        room.clients.delete(clientId);
        if (room.readyClients) {
            room.readyClients.delete(clientId);
        }

        if (room.clients.size === 0) {
            // Destroy empty room only when everyone has left
            if (room.readyTimeout) clearTimeout(room.readyTimeout);
            sendRegies(room, { type: 'ROOM_CLOSED' });
            saveWorldNow(room); // salle permanente : monde écrit sur le disque avant de libérer la mémoire
            rooms.delete(ws.roomId);
            console.log(`[Room] Destroyed: ${ws.roomId} (empty)`);
        } else {
            // Reassign master if master left
            if (clientId === room.masterId && room.clients.size > 0) {
                room.masterId = room.clients.keys().next().value;
                console.log(`[Room] Master transferred to ${room.masterId} in ${ws.roomId}`);
            }

            // Someone left — notify remaining peers and update player list
            broadcastRoom(room, { type: 'PEER_LEFT', peerId: clientId });
            broadcastRoomAll(room, {
                type: 'PLAYERS_UPDATE',
                players: getPlayersSnapshot(room),
            });
            console.log(`[Room] ${clientId} left ${ws.roomId} (${room.clients.size} remaining)`);

            // If the room was waiting for ready clients and all remaining clients are ready, trigger play!
            if (room.isAwaitingReady && room.readyClients && room.readyClients.size >= room.clients.size && room.clients.size > 0) {
                triggerSimultaneousPlay(room);
            }
        }
    });

    ws.on('error', (err) => {
        console.error(`[!] Error on ${clientId}:`, err.message);
    });
});

wss.on('error', (err) => {
    console.error('[!] WebSocket server error:', err.message);
});

// ─── 2-Second Periodic Room Heartbeat Sync (Playback & Laser/Light Sweep) ────
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of rooms) {
        if (!room || !room.clients || room.clients.size === 0) continue;

        let musicTime = 0;
        let isPlaying = false;
        if (room.playback) {
            isPlaying = Boolean(room.playback.isPlaying);
            const elapsed = isPlaying ? Math.max(0, (now - (room.playback.timestamp || now)) / 1000) : 0;
            musicTime = (room.playback.currentTime || 0) + elapsed;
        }

        const roomStart = room.createdAt || now;
        // Le sweepTime est continu et 100% indépendant de la musique (déplacement/seek/pause du son n'affecte pas le balayage)
        const sweepTime = Math.max(0, (now - roomStart) / 1000);

        broadcastRoomAll(room, {
            type: 'HEARTBEAT_SYNC',
            serverTime: now,
            musicTime,
            isPlaying,
            sweepTime,
            lightingVersion: room.lightingVersion || 1,
            lightingState: room.lightingState || defaultLightingState(),
        });
        if (room.regies && room.regies.size > 0) sendRegies(room, regiePlaybackMessage(room));
    }
}, 2000);
