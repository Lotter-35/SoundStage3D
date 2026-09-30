/**
 * trackLibrary.js — bibliothèque des morceaux stockés sur le serveur (dossier audio).
 *
 * - Index en mémoire des métadonnées (un <id>.json + un <id>.bin par morceau) : plus de lecture disque à chaque liste
 * - Durée de chaque morceau (lue dans l'en-tête MP3 / WAV, sans décoder), mémorisée dans le .json
 * - Suppression sûre : un fichier n'est supprimé que s'il n'est référencé par aucune playlist ni aucune salle en cours
 * - Identifiants validés (aucun chemin relatif accepté)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRACK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const HEADER_BYTES = 128 * 1024;

function safeId(id) {
    return (typeof id === 'string' && TRACK_ID_RE.test(id)) ? id : null;
}

// ─── Durée ────────────────────────────────────────────────────────────────────

const MP3_BITRATES = {
    // [version][layer] → kbit/s selon l'index de débit (1..14)
    v1l1: [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    v1l2: [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    v1l3: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    v2l1: [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    v2l23: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Durée (secondes) d'un MP3 à partir de son début et de sa taille totale, ou null */
function mp3Duration(buf, totalSize) {
    let pos = 0;
    if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
        const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
        pos = 10 + size + ((buf[5] & 0x10) ? 10 : 0);
    }
    for (let i = pos; i < buf.length - 4; i++) {
        if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
        const ver = (buf[i + 1] >> 3) & 3;   // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
        const layer = (buf[i + 1] >> 1) & 3; // 1 = III, 2 = II, 3 = I
        const bitIdx = (buf[i + 2] >> 4) & 15;
        const rateIdx = (buf[i + 2] >> 2) & 3;
        if (ver === 1 || layer === 0 || bitIdx === 0 || bitIdx === 15 || rateIdx === 3) continue;

        const rate = MP3_RATES[ver][rateIdx];
        const table = ver === 3
            ? (layer === 3 ? MP3_BITRATES.v1l1 : layer === 2 ? MP3_BITRATES.v1l2 : MP3_BITRATES.v1l3)
            : (layer === 3 ? MP3_BITRATES.v2l1 : MP3_BITRATES.v2l23);
        const bitrate = table[bitIdx - 1] * 1000;
        const samplesPerFrame = layer === 3 ? 384 : (layer === 2 ? 1152 : (ver === 3 ? 1152 : 576));
        const mono = ((buf[i + 3] >> 6) & 3) === 3;

        // Trame Xing / Info (VBR) : nombre de trames dans l'en-tête
        const side = ver === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
        const xingAt = i + 4 + ((buf[i + 1] & 1) === 0 ? 2 : 0) + side;
        const tag = buf.toString('latin1', xingAt, xingAt + 4);
        if ((tag === 'Xing' || tag === 'Info') && xingAt + 12 <= buf.length && (buf[xingAt + 7] & 1)) {
            const frames = buf.readUInt32BE(xingAt + 8);
            if (frames > 0) return frames * samplesPerFrame / rate;
        }
        const vbriAt = i + 4 + 32;
        if (buf.toString('latin1', vbriAt, vbriAt + 4) === 'VBRI' && vbriAt + 18 <= buf.length) {
            const frames = buf.readUInt32BE(vbriAt + 14);
            if (frames > 0) return frames * samplesPerFrame / rate;
        }
        // Débit constant : taille des données audio / débit
        const audioBytes = Math.max(0, totalSize - i);
        return audioBytes * 8 / bitrate;
    }
    return null;
}

/** Durée (secondes) d'un WAV PCM à partir de son début, ou null */
function wavDuration(buf, totalSize) {
    if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
    let pos = 12;
    let byteRate = 0;
    while (pos + 8 <= buf.length) {
        const id = buf.toString('latin1', pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        if (id === 'fmt ' && pos + 20 <= buf.length) byteRate = buf.readUInt32LE(pos + 16);
        if (id === 'data') {
            const dataSize = Math.min(size, Math.max(0, totalSize - pos - 8));
            return byteRate > 0 ? dataSize / byteRate : null;
        }
        pos += 8 + size + (size % 2);
    }
    return null;
}

function computeDuration(buf, totalSize, mime, name) {
    try {
        const lower = String(name || '').toLowerCase();
        let d = null;
        if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF') d = wavDuration(buf, totalSize);
        else if (/mpeg|mp3/.test(String(mime || '')) || /\.mp3$/.test(lower) || buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) d = mp3Duration(buf, totalSize);
        return (d && isFinite(d) && d > 0.2 && d < 6 * 3600) ? Math.round(d * 100) / 100 : null;
    } catch (_) {
        return null;
    }
}

/** Durée d'un fichier en ne lisant que son début (saute la pochette ID3 des MP3, qui peut dépasser 1 Mo) */
function durationFromFile(file, mime, name) {
    const fd = fs.openSync(file, 'r');
    try {
        const total = fs.fstatSync(fd).size;
        const id3 = Buffer.alloc(10);
        fs.readSync(fd, id3, 0, 10, 0);
        let skip = 0;
        if (id3.toString('latin1', 0, 3) === 'ID3') {
            skip = 10 + (((id3[6] & 0x7f) << 21) | ((id3[7] & 0x7f) << 14) | ((id3[8] & 0x7f) << 7) | (id3[9] & 0x7f)) + ((id3[5] & 0x10) ? 10 : 0);
        }
        const head = Buffer.alloc(HEADER_BYTES);
        const n = fs.readSync(fd, head, 0, HEADER_BYTES, skip);
        return computeDuration(head.subarray(0, n), total - skip, mime, name);
    } finally {
        fs.closeSync(fd);
    }
}

// ─── Bibliothèque ─────────────────────────────────────────────────────────────

function createTrackLibrary({ audioDir, playlistsDir, getLiveTrackIds = () => new Set(), log = console.log }) {
    const metas = new Map();   // id → { id, name, mime, uploadedBy, size, createdAt, duration? }
    const bins = new Set();    // ids dont le fichier .bin existe

    const binPath = (id) => path.join(audioDir, `${id}.bin`);
    const metaPath = (id) => path.join(audioDir, `${id}.json`);

    function scan() {
        metas.clear();
        bins.clear();
        let files = [];
        try { files = fs.readdirSync(audioDir); } catch (_) { return; }
        for (const f of files) {
            if (f.endsWith('.bin')) {
                const id = f.slice(0, -4);
                if (safeId(id)) bins.add(id);
            }
        }
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            const id = f.slice(0, -5);
            if (!safeId(id) || !bins.has(id)) continue;
            try {
                const m = JSON.parse(fs.readFileSync(path.join(audioDir, f), 'utf-8'));
                metas.set(id, {
                    id,
                    name: m.name || id,
                    mime: m.mime || 'audio/mpeg',
                    uploadedBy: m.uploadedBy || null,
                    size: m.size || 0,
                    createdAt: m.createdAt || 0,
                    duration: typeof m.duration === 'number' ? m.duration : null,
                    hash: typeof m.hash === 'string' ? m.hash : null,
                });
            } catch (_) { /* méta illisible : le morceau reste jouable, sans métadonnées */ }
        }
        // .bin sans .json : métadonnées minimales (le morceau reste visible dans « Toutes les musiques »)
        for (const id of bins) {
            if (!metas.has(id)) {
                let size = 0;
                try { size = fs.statSync(binPath(id)).size; } catch (_) {}
                metas.set(id, { id, name: id, mime: 'audio/mpeg', uploadedBy: null, size, createdAt: 0, duration: null });
            }
        }
    }

    function persistMeta(m) {
        try {
            fs.writeFileSync(metaPath(m.id), JSON.stringify({
                id: m.id, name: m.name, mime: m.mime, uploadedBy: m.uploadedBy, size: m.size, createdAt: m.createdAt,
                ...(m.duration ? { duration: m.duration } : {}),
                ...(m.hash ? { hash: m.hash } : {}),
            }));
        } catch (err) {
            log(`[Library] Écriture des métadonnées impossible (${m.id}) : ${err.message}`);
        }
    }

    const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

    /** Un autre morceau au contenu identique (même empreinte, fichier présent) ? */
    function findByHash(hash, exceptId) {
        if (!hash) return null;
        for (const m of metas.values()) {
            if (m.id !== exceptId && m.hash === hash && bins.has(m.id)) return m;
        }
        return null;
    }

    /** Rend `id.bin` identique à `srcId.bin` sans occuper d'espace (lien physique ; copie si impossible) */
    function linkBin(srcId, id) {
        try { fs.unlinkSync(binPath(id)); } catch (_) {}
        try { fs.linkSync(binPath(srcId), binPath(id)); return 'lien'; }
        catch (_) { fs.copyFileSync(binPath(srcId), binPath(id)); return 'copie'; }
    }

    /**
     * Écrit un morceau reçu : si un fichier identique existe déjà (même empreinte SHA-1), le nouvel
     * identifiant pointe sur le même contenu au lieu d'occuper de nouveau l'espace disque.
     * Chaque identifiant garde son propre fichier/lien : la suppression de l'un n'affecte pas l'autre.
     */
    function store(id, info, buffer) {
        const hash = sha1(buffer);
        const twin = findByHash(hash, id);
        let how = 'écrit';
        if (twin) { how = linkBin(twin.id, id); }
        else fs.writeFileSync(binPath(id), buffer);
        const meta = register(id, info, buffer, hash);
        if (twin) { log(`[Library] "${info.name}" identique à "${twin.name}" (${twin.id}) : ${how}, ${(buffer.length / 1048576).toFixed(1)} Mo économisés`); meta.deduped = true; }
        return meta;
    }

    /** Enregistre un morceau déjà écrit sur disque (upload) */
    function register(id, info, buffer, hash = null) {
        const m = {
            id,
            name: info.name,
            mime: info.mime || 'audio/mpeg',
            uploadedBy: info.uploadedBy || null,
            size: buffer.length,
            createdAt: Date.now(),
            duration: computeDuration(buffer, buffer.length, info.mime, info.name),
            hash: hash || sha1(buffer),
        };
        bins.add(id);
        metas.set(id, m);
        persistMeta(m);
        return m;
    }

    /**
     * Anciens morceaux sans empreinte : calculée par petits paquets en arrière-plan.
     * Si `link` est vrai, un doublon exact est remplacé par un lien vers le fichier déjà présent.
     */
    function fillMissingHashes({ link = false, onDone = () => {} } = {}) {
        const pending = [...metas.values()].filter(m => !m.hash && bins.has(m.id)).map(m => m.id);
        const stats = { hashed: 0, linked: 0, savedBytes: 0 };
        const step = () => {
            const batch = pending.splice(0, 3);
            for (const id of batch) {
                const m = metas.get(id);
                if (!m) continue;
                try {
                    m.hash = sha1(fs.readFileSync(binPath(id)));
                    stats.hashed++;
                    if (link) {
                        const twin = findByHash(m.hash, id);
                        if (twin && !sameFile(twin.id, id)) { linkBin(twin.id, id); stats.linked++; stats.savedBytes += m.size || 0; }
                    }
                    persistMeta(m);
                } catch (_) {}
            }
            if (pending.length) setTimeout(step, 50); else onDone(stats);
        };
        if (pending.length) setTimeout(step, 2000); else onDone(stats);
    }

    function sameFile(a, b) {
        try { const x = fs.statSync(binPath(a)), y = fs.statSync(binPath(b)); return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev; } catch (_) { return false; }
    }

    /** Durées manquantes (morceaux anciens) : lues par petits paquets en arrière-plan, sans bloquer le serveur */
    function fillMissingDurations() {
        const todo = [...metas.values()].filter(m => !m.duration && bins.has(m.id));
        if (todo.length === 0) return;
        let done = 0;
        let idx = 0;
        const step = () => {
            const t0 = Date.now();
            while (idx < todo.length && Date.now() - t0 < 15) {
                const m = todo[idx++];
                try {
                    const d = durationFromFile(binPath(m.id), m.mime, m.name);
                    if (d) { m.duration = d; persistMeta(m); done++; }
                } catch (_) {}
            }
            if (idx < todo.length) setTimeout(step, 5);
            else log(`[Library] Durées calculées pour ${done}/${todo.length} morceaux`);
        };
        setTimeout(step, 500);
    }

    /** Renseigne la durée d'un morceau mesurée par un client (formats non lisibles côté serveur) */
    function setDuration(id, seconds) {
        const m = metas.get(id);
        if (!m || m.duration || !(seconds > 0.2 && seconds < 6 * 3600)) return false;
        m.duration = Math.round(seconds * 100) / 100;
        persistMeta(m);
        return true;
    }

    function readPlaylists() {
        const list = [];
        try {
            for (const f of fs.readdirSync(playlistsDir)) {
                if (!f.endsWith('.json')) continue;
                try { list.push(JSON.parse(fs.readFileSync(path.join(playlistsDir, f), 'utf-8'))); } catch (_) {}
            }
        } catch (_) {}
        return list;
    }

    function referencedIds() {
        const ids = new Set(getLiveTrackIds());
        for (const pl of readPlaylists()) for (const t of (pl.tracks || [])) if (t && t.id) ids.add(t.id);
        return ids;
    }

    function removeFiles(id) {
        try { fs.unlinkSync(binPath(id)); } catch (_) {}
        try { fs.unlinkSync(metaPath(id)); } catch (_) {}
        bins.delete(id);
        metas.delete(id);
    }

    /**
     * Supprime, parmi `candidates`, les morceaux qui ne sont plus référencés (aucune playlist, aucune salle).
     * Les morceaux très récents sont épargnés : leur playlist est peut-être sur le point d'être sauvegardée.
     */
    function collectGarbage(candidates, { minAgeMs = 10 * 60 * 1000 } = {}) {
        const refs = referencedIds();
        const removed = [];
        const now = Date.now();
        for (const raw of candidates) {
            const id = safeId(raw);
            if (!id || !bins.has(id) || refs.has(id)) continue;
            const m = metas.get(id);
            if (m && m.createdAt && now - m.createdAt < minAgeMs) continue;
            removeFiles(id);
            removed.push(id);
        }
        if (removed.length) log(`[Library] ${removed.length} morceau(x) orphelin(s) supprimé(s) du serveur`);
        return removed;
    }

    /** Suppression demandée explicitement : retiré de toutes les playlists puis effacé du disque */
    function deleteTracks(ids) {
        const targets = new Set(ids.map(safeId).filter(Boolean));
        if (targets.size === 0) return { deleted: [], playlistsChanged: [] };
        const changed = [];
        for (const pl of readPlaylists()) {
            const before = (pl.tracks || []).length;
            const kept = (pl.tracks || []).filter(t => !targets.has(t.id));
            if (kept.length !== before) {
                pl.tracks = kept;
                pl.updatedAt = Date.now();
                try { fs.writeFileSync(path.join(playlistsDir, `${pl.id}.json`), JSON.stringify(pl, null, 2), 'utf-8'); changed.push(pl.id); } catch (_) {}
            }
        }
        const deleted = [];
        for (const id of targets) {
            if (bins.has(id) || metas.has(id)) { removeFiles(id); deleted.push(id); }
        }
        if (deleted.length) log(`[Library] ${deleted.length} morceau(x) supprimé(s) du serveur à la demande d'un joueur`);
        return { deleted, playlistsChanged: changed };
    }

    /** Statistiques pour le journal de démarrage : morceaux qui ne sont dans aucune playlist */
    function orphanReport() {
        const refs = new Set();
        for (const pl of readPlaylists()) for (const t of (pl.tracks || [])) if (t && t.id) refs.add(t.id);
        let count = 0, bytes = 0;
        for (const m of metas.values()) if (!refs.has(m.id)) { count++; bytes += m.size || 0; }
        return { total: metas.size, orphans: count, orphanBytes: bytes };
    }

    scan();

    return {
        safeId,
        hasFile: (id) => bins.has(id),
        getMeta: (id) => metas.get(id) || null,
        allMeta: () => [...metas.values()],
        register,
        store,
        fillMissingHashes,
        setDuration,
        fillMissingDurations,
        collectGarbage,
        deleteTracks,
        orphanReport,
        rescan: scan,
        computeDuration,
    };
}

module.exports = { createTrackLibrary, safeId, computeDuration, durationFromFile };
