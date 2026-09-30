// Banc d'essai de la synchro musicale : serveur isolé (port 18068, stockage temporaire)
// Lancer :  node server/tests/sync.test.js   (ou : cd server && npm test)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const SERVER_DIR = path.resolve(__dirname, '..');
const WebSocket = require(path.join(SERVER_DIR, 'node_modules', 'ws'));

const PORT = 18068;
const STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'ss3d-test-'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const note = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'OK   ' : 'BUG  ') + name + (detail ? ' -> ' + detail : '')); };

class Client {
    constructor(label) { this.label = label; this.msgs = []; this.waiters = []; }
    async connect() {
        this.ws = new WebSocket(`ws://localhost:${PORT}`);
        this.ws.on('message', (raw) => {
            let m; try { m = JSON.parse(raw); } catch { return; }
            m.__t = Date.now();
            this.msgs.push(m);
            this.waiters = this.waiters.filter(w => { if (w.pred(m)) { w.res(m); return false; } return true; });
        });
        await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    }
    send(o) { this.ws.send(JSON.stringify(o)); }
    waitFor(pred, ms = 3000) {
        const found = this.msgs.find(pred);
        if (found) return Promise.resolve(found);
        return new Promise((res) => {
            const w = { pred, res };
            this.waiters.push(w);
            setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); res(null); }, ms);
        });
    }
    since(t, type) { return this.msgs.filter(m => m.__t >= t && (!type || m.type === type)); }
    close() { try { this.ws.close(); } catch {} }
}

function post(pathq, buf, headers = {}) {
    return new Promise((res, rej) => {
        const req = http.request({ host: 'localhost', port: PORT, path: pathq, method: 'POST', headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, ...headers } }, (r) => {
            let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
        });
        req.on('error', rej); req.write(buf); req.end();
    });
}
function get(pathq) {
    return new Promise((res, rej) => {
        http.get({ host: 'localhost', port: PORT, path: pathq }, (r) => {
            const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(chunks) }));
        }).on('error', rej);
    });
}

async function newRoom(n = 2) {
    const a = new Client('A'); await a.connect(); a.send({ type: 'CREATE_ROOM' });
    const created = await a.waitFor(m => m.type === 'ROOM_CREATED');
    const others = [];
    for (let i = 1; i < n; i++) {
        const c = new Client('C' + i); await c.connect(); c.send({ type: 'JOIN_ROOM', roomId: created.roomId });
        await c.waitFor(m => m.type === 'ROOM_JOINED'); others.push(c);
    }
    return { roomId: created.roomId, a, others };
}
const audio = (id, kb = 20) => Buffer.alloc(kb * 1024, id.charCodeAt(id.length - 1));
// MP3 factice à débit constant 128 kbit/s : 160 Ko ≈ 10 s
const mp3 = (kb = 160) => { const b = Buffer.alloc(kb * 1024, 0); for (let i = 0; i + 4 < b.length; i += 417) { b[i] = 0xff; b[i + 1] = 0xfb; b[i + 2] = 0x90; b[i + 3] = 0x64; } return b; };

(async () => {
    const srv = spawn('node', ['server.js'], { cwd: SERVER_DIR, env: { ...process.env, PORT: String(PORT), SS3D_STORAGE_DIR: STORAGE }, stdio: ['ignore', 'pipe', 'pipe'] });
    let srvLog = ''; srv.stdout.on('data', d => srvLog += d); srv.stderr.on('data', d => srvLog += d);
    for (let i = 0; i < 40; i++) { try { await get('/'); break; } catch { await sleep(250); } }

    try {
        // ── S1 : lecture synchronisée à 3 clients
        {
            const { roomId, a, others } = await newRoom(3);
            const all = [a, ...others];
            const t0 = Date.now();
            await post(`/upload?room=${roomId}&name=one.mp3&clientId=A&trackId=t_one`, audio('t_one'));
            for (const c of all) await c.waitFor(m => m.type === 'AUDIO_TRACK_CHANGED');
            all.forEach(c => c.send({ type: 'TRACK_BUFFER_READY' }));
            const starts = await Promise.all(all.map(c => c.waitFor(m => m.type === 'START_PLAYBACK_SYNC', 2000)));
            const okAll = starts.every(Boolean) && new Set(starts.map(s => s.startTime)).size === 1;
            note('S1 démarrage simultané (3 clients prêts)', okAll, okAll ? `start dans ${starts[0].startTime - t0} ms` : 'startTime différents ou absents');
            // ── S2 : arrivée tardive
            await sleep(1200);
            const late = new Client('late'); await late.connect(); late.send({ type: 'JOIN_ROOM', roomId });
            const joined = await late.waitFor(m => m.type === 'ROOM_JOINED');
            late.send({ type: 'TRACK_BUFFER_READY' });
            const ls = await late.waitFor(m => m.type === 'START_PLAYBACK_SYNC', 2000);
            note('S2 arrivée tardive : reçoit un offset', Boolean(ls) && ls.startOffset > 0.8 && ls.startOffset < 3, ls ? `offset ${ls.startOffset.toFixed(2)} s` : 'aucun START_PLAYBACK_SYNC');
            // ── S3 : play/pause pendant le chargement ignoré sans retour à l'émetteur
            all.forEach(c => c.msgs.length = 0);
            await post(`/upload?room=${roomId}&name=two.mp3&clientId=A&trackId=t_two`, audio('t_two'));
            await sleep(200);
            a.send({ type: 'QUEUE_NEXT' });
            await sleep(300);
            a.send({ type: 'SYNC_ACTION', action: 'play_pause', data: { isPlaying: false, currentTime: 5 } });
            await sleep(400);
            const relayed = others[0].msgs.some(m => m.type === 'SYNC_ACTION' && m.action === 'play_pause');
            const feedback = a.msgs.some(m => m.type === 'SYNC_ACTION' && m.action === 'play_pause') || a.msgs.some(m => m.type === 'ERROR');
            note('S3 pause pendant chargement : l\'émetteur est prévenu du refus', feedback, relayed ? 'relayé' : 'ignoré en silence (l\'UI de A croit avoir mis en pause)');
            // ── S4 : démarrage bloqué par un client qui n'est jamais prêt (upload)
            const tw = Date.now();
            others.forEach(c => c.send({ type: 'TRACK_BUFFER_READY' })); // A ne répond jamais
            const st = await others[0].waitFor(m => m.type === 'START_PLAYBACK_SYNC' && m.__t > tw, 9000);
            note('S4 un client absent ne bloque pas plus de 8 s', Boolean(st), st ? `démarré après ${Date.now() - tw} ms` : 'toujours en attente après 9 s');
            [a, ...others, late].forEach(c => c.close());
        }
        // ── S5 : QUEUE_NEXT en rafale + playlist bouclant implicitement + fichier manquant
        {
            const { roomId, a, others } = await newRoom(2);
            const b = others[0];
            for (const id of ['t_a', 't_b']) await post(`/upload?room=${roomId}&name=${id}.mp3&clientId=A&trackId=${id}&addToQueue=false`, audio(id));
            a.send({ type: 'PLAYLIST_SAVE', name: 'test', playlistId: 'pl_test', tracks: [{ id: 't_a', name: 't_a.mp3' }, { id: 't_b', name: 't_b.mp3' }] });
            await a.waitFor(m => m.type === 'PLAYLISTS_SYNC' && m.savedPlaylistId);
            a.send({ type: 'PLAYLIST_LOAD', playlistId: 'pl_test', startIndex: 0, shuffle: false });
            await a.waitFor(m => m.type === 'AUDIO_TRACK_CHANGED');
            const seq = [];
            for (let i = 0; i < 4; i++) {
                a.msgs.length = 0; a.send({ type: 'QUEUE_NEXT' });
                const m = await a.waitFor(x => x.type === 'AUDIO_TRACK_CHANGED', 1500);
                seq.push(m ? m.name : 'stop'); await sleep(350);
            }
            note('S5 répéter désactivé : la playlist s arrête à la fin', seq.includes('stop'), 'séquence après 4 NEXT : ' + seq.join(' → '));
            // double NEXT (deux clients en fin de morceau)
            a.msgs.length = 0; b.msgs.length = 0;
            a.send({ type: 'QUEUE_NEXT' }); b.send({ type: 'QUEUE_NEXT' });
            await sleep(700);
            const changes = a.msgs.filter(m => m.type === 'AUDIO_TRACK_CHANGED').length;
            note('S6 double QUEUE_NEXT simultané (2 clients en fin de piste) = 1 seul changement', changes === 1, `${changes} changement(s)`);
            // fichier manquant + /audio/<room>/<id> qui renvoie le mauvais fichier
            a.send({ type: 'QUEUE_MANUAL_ADD', track: { id: 't_ghost', name: 'fantome.mp3' } });
            await sleep(300);
            const r1 = await get(`/audio/track/t_ghost`);
            const r2 = await get(`/audio/${roomId}/t_ghost`);
            note('S7 morceau inexistant : /audio/<salle>/<id> répond 404', r2.status === 404, `/audio/track/ghost=${r1.status}, /audio/<salle>/ghost=${r2.status}` + (r2.status === 200 ? ' (renvoie le morceau précédent de la salle !)' : ''));
            // ── S12 : répéter tout / un
            a.send({ type: 'PLAYLIST_LOAD', playlistId: 'pl_test', startIndex: 0, shuffle: false });
            await a.waitFor(m => m.type === 'AUDIO_TRACK_CHANGED');
            a.send({ type: 'QUEUE_REPEAT_SET', mode: 'all' });
            const snap = await a.waitFor(m => m.type === 'QUEUE_STATE_SYNC' && m.repeatMode === 'all');
            note('S12a état répéter diffusé dans le snapshot', Boolean(snap));
            const seq2 = [];
            for (let i = 0; i < 3; i++) { a.msgs.length = 0; a.send({ type: 'QUEUE_NEXT', auto: true }); const m = await a.waitFor(x => x.type === 'AUDIO_TRACK_CHANGED', 1500); seq2.push(m ? m.name : 'stop'); await sleep(350); }
            note('S12b répéter tout : la playlist boucle', !seq2.includes('stop'), seq2.join(' → '));
            a.send({ type: 'QUEUE_REPEAT_SET', mode: 'one' });
            await sleep(200);
            a.msgs.length = 0; b.msgs.length = 0;
            a.send({ type: 'QUEUE_NEXT', auto: true });
            const rs = await b.waitFor(x => x.type === 'START_PLAYBACK_SYNC', 1500);
            const chg = b.msgs.some(x => x.type === 'AUDIO_TRACK_CHANGED');
            note('S12c répéter le morceau : relance à 0:00 sans recharger', Boolean(rs) && !chg && rs.startOffset === 0, rs ? `startOffset=${rs.startOffset}, rechargement=${chg}` : 'aucun redémarrage');
            await sleep(400);
            a.send({ type: 'QUEUE_NEXT' }); // suivant manuel avec répéter un : passe bien au morceau suivant
            const nx = await a.waitFor(x => x.type === 'AUDIO_TRACK_CHANGED', 1500);
            note('S12d « suivant » manuel avec répéter un passe au morceau suivant', Boolean(nx));
            a.send({ type: 'QUEUE_REPEAT_SET', mode: 'off' });
            // ── S13 : playlist « Toutes les musiques », durée, suppression
            const up = await post(`/upload?room=${roomId}&name=dix-secondes.mp3&clientId=A&trackId=t_dur&addToQueue=false`, mp3());
            const upj = JSON.parse(up.body);
            note('S13a la durée d un MP3 est lue à l envoi (~10 s)', Math.abs((upj.duration || 0) - 10.2) < 0.6, 'durée = ' + upj.duration);
            a.send({ type: 'PLAYLISTS_GET' });
            const pls = await a.waitFor(m => m.type === 'PLAYLISTS_SYNC' && m.playlists.some(p => p.id === '__all__' && p.tracks.some(t => t.id === 't_dur')), 3000);
            const all = pls && pls.playlists.find(p => p.id === '__all__');
            note('S13b « Toutes les musiques » liste tous les fichiers du serveur', Boolean(all) && all.virtual === true && all.tracks.length >= 4, all ? `${all.tracks.length} morceaux` : 'absente');
            a.send({ type: 'TRACK_DELETE', trackIds: ['t_dur'] });
            await sleep(500);
            note('S13c suppression explicite d un morceau efface le fichier', !fs.existsSync(path.join(STORAGE, 'audio', 't_dur.bin')) && !fs.existsSync(path.join(STORAGE, 'audio', 't_dur.json')));
            // ── S14 : identifiant malveillant
            const evil = await post(`/upload?room=${roomId}&name=x.mp3&clientId=A&trackId=..%2F..%2Fevil&addToQueue=false`, audio('t_evil'));
            const escaped = fs.existsSync(path.join(STORAGE, 'evil.bin')) || fs.existsSync(path.join(STORAGE, '..', 'evil.bin'));
            note('S14 identifiant de morceau avec « ../ » refusé', !escaped, escaped ? 'fichier écrit hors du dossier audio !' : 'identifiant régénéré');
            a.send({ type: 'SYNC_ACTION', action: 'stop_playback', data: {} }); await sleep(300);
            // ── S8 : suppression d'un morceau de playlist / d'une playlist : fichier disque ?
            a.send({ type: 'PLAYLIST_SAVE', name: 'test', playlistId: 'pl_test', tracks: [{ id: 't_a', name: 't_a.mp3' }] });
            await sleep(400);
            const binB = fs.existsSync(path.join(STORAGE, 'audio', 't_b.bin'));
            note('S8 retirer un morceau d\'une playlist supprime son fichier serveur', !binB, binB ? 't_b.bin toujours présent (aucune suppression de fichier dans le serveur)' : 'supprimé');
            a.send({ type: 'PLAYLIST_DELETE', playlistId: 'pl_test' });
            await sleep(400);
            const binA = fs.existsSync(path.join(STORAGE, 'audio', 't_a.bin'));
            note('S9 supprimer une playlist supprime ses fichiers orphelins', !binA, binA ? 't_a.bin toujours présent' : 'supprimé');
            // ── S10 : doublons : même fichier envoyé 2 fois
            const p1 = await post(`/upload?room=${roomId}&name=dup.mp3&clientId=A&trackId=t_d1&addToQueue=false`, audio('t_dup'));
            const p2 = await post(`/upload?room=${roomId}&name=dup.mp3&clientId=A&trackId=t_d2&addToQueue=false`, audio('t_dup'));
            const d1 = path.join(STORAGE, 'audio', 't_d1.bin'), d2 = path.join(STORAGE, 'audio', 't_d2.bin');
            const st1 = fs.statSync(d1), st2 = fs.statSync(d2);
            const shared = st1.ino !== 0 && st1.ino === st2.ino && st1.dev === st2.dev;
            note('S10 le même fichier envoyé deux fois occupe la place une seule fois (lien physique)', shared, shared ? 'même fichier physique' : '2 copies distinctes sur le disque');
            // ── S15 : reprise de téléchargement (Range)
            const full = await get('/audio/track/t_d1');
            const part = await new Promise((res, rej) => http.get({ host: 'localhost', port: PORT, path: '/audio/track/t_d1', headers: { Range: 'bytes=10-19' } }, (r) => {
                const cs = []; r.on('data', c => cs.push(c)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(cs), cr: r.headers['content-range'] }));
            }).on('error', rej));
            note('S15 requête Range : 206 + octets demandés', part.status === 206 && part.body.equals(full.body.subarray(10, 20)), `statut ${part.status}, ${part.body.length} octets, ${part.cr}`);
            // ── S16 : supprimer l'un des deux doublons n'abîme pas l'autre
            fs.unlinkSync(d1);
            const still = await get('/audio/track/t_d2');
            note('S16 supprimer un doublon ne casse pas le second', still.status === 200 && still.body.equals(full.body), `statut ${still.status}`);
            [a, b].forEach(c => c.close());
        }
        // ── S17 : délai de départ adaptatif (joueurs rapides → départ plus tôt que 250 ms)
        {
            const { roomId, a, others } = await newRoom(2);
            const all = [a, ...others];
            all.forEach(c => c.send({ type: 'PING', t: Date.now(), rtt: 20 }));
            await sleep(200);
            const t0 = Date.now();
            await post(`/upload?room=${roomId}&name=fast.mp3&clientId=A&trackId=t_fast`, audio('t_fast'));
            for (const c of all) await c.waitFor(m => m.type === 'AUDIO_TRACK_CHANGED');
            all.forEach(c => c.send({ type: 'TRACK_BUFFER_READY' }));
            const st = await a.waitFor(m => m.type === 'START_PLAYBACK_SYNC', 2000);
            const d = st ? st.startTime - Date.now() : null;
            note('S17 départ plus rapide quand tous les joueurs ont une bonne latence', Boolean(st) && st.startTime - t0 < 250, st ? `délai appliqué ≈ ${Math.round(st.startTime - t0)} ms depuis l envoi` : 'pas de départ');
            all.forEach(c => c.close());
        }
        // ── S18 : salle permanente : la file d'attente survit au départ de tout le monde, sans relancer la musique
        {
            const join = async () => { const c = new Client('P'); await c.connect(); c.send({ type: 'JOIN_ROOM', roomId: 'SPECTACLE2' }); const j = await c.waitFor(m => m.type === 'ROOM_CREATED' || m.type === 'ROOM_JOINED'); return { c, j }; };
            let { c, j } = await join();
            await post('/upload?room=SPECTACLE2&name=pa.mp3&clientId=P&trackId=t_pa', audio('t_pa'));
            await c.waitFor(m => m.type === 'AUDIO_TRACK_CHANGED');
            await post('/upload?room=SPECTACLE2&name=pb.mp3&clientId=P&trackId=t_pb', audio('t_pb'));
            await sleep(300);
            c.send({ type: 'SYNC_ACTION', action: 'pause', data: {} });
            c.close(); await sleep(2500);   // plus personne : la salle est libérée (GC des fichiers non rangés inclus)
            ({ c, j } = await join());
            const pbBin = fs.existsSync(path.join(STORAGE, 'audio', 't_pb.bin')), paBin = fs.existsSync(path.join(STORAGE, 'audio', 't_pa.bin'));
            const cur = j.currentTrack && j.currentTrack.id, man = (j.manualQueue || []).map(t => t.id).join(',');
            note('S18a la file est retrouvée au retour dans la salle', cur === 't_pa' && man === 't_pb' && pbBin && paBin, `courant=${cur}, file=${man}, fichiers conservés=${paBin && pbBin}`);
            const playing = j.playback && j.playback.isPlaying;
            note('S18b musique coupée au départ : rien ne se lance au retour', !playing, playing ? 'la lecture a redémarré' : 'en pause');
            c.close();
        }
        // ── S11 : durée disponible côté serveur ?
        {
            const { roomId, a } = await newRoom(1);
            a.send({ type: 'PLAYLISTS_GET' });
            const pl = await a.waitFor(m => m.type === 'PLAYLISTS_SYNC');
            const anyTrack = (pl.playlists.flatMap(p => p.tracks || [])[0]) || null;
            note('S11 les pistes exposent une durée', anyTrack ? 'duration' in anyTrack : false, anyTrack ? 'champs : ' + Object.keys(anyTrack).join(',') : 'aucune piste de test');
            a.close();
        }
    } catch (e) {
        console.log('ERREUR BANC D\'ESSAI', e);
    }
    srv.kill();
    await sleep(300);
    try { fs.rmSync(STORAGE, { recursive: true, force: true }); } catch {}
    console.log('\n=== ' + results.filter(r => !r.ok).length + ' problème(s) sur ' + results.length + ' scénarios ===');
    process.exit(0);
})();
