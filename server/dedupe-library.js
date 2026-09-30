#!/usr/bin/env node
/**
 * dedupe-library.js — supprime du disque les morceaux en doublon (contenu strictement identique).
 *
 *   node server/dedupe-library.js            → simulation : rien n'est modifié
 *   node server/dedupe-library.js --apply    → supprime les doublons et met à jour les playlists
 *
 * Pour chaque groupe de fichiers identiques (même SHA-1 + même taille), on garde un seul morceau
 * (de préférence celui déjà présent dans des playlists, sinon le plus ancien). Les playlists qui
 * pointaient sur un doublon sont redirigées vers le morceau conservé.
 * À lancer serveur arrêté. SS3D_STORAGE_DIR : autre dossier de stockage.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const storage = process.env.SS3D_STORAGE_DIR ? path.resolve(process.env.SS3D_STORAGE_DIR) : path.resolve(__dirname, 'storage');
const audioDir = path.join(storage, 'audio');
const plDir = path.join(storage, 'playlists');
const apply = process.argv.includes('--apply');

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch (_) { return null; } };

// 1. Empreintes
const ids = fs.readdirSync(audioDir).filter(f => f.endsWith('.bin')).map(f => f.slice(0, -4));
const items = ids.map(id => {
    const bin = path.join(audioDir, `${id}.bin`);
    const st = fs.statSync(bin);
    const meta = readJson(path.join(audioDir, `${id}.json`)) || {};
    return { id, size: st.size, created: meta.createdAt || st.mtimeMs, name: meta.name || id, hash: null };
});
const bySize = new Map();
for (const it of items) { if (!bySize.has(it.size)) bySize.set(it.size, []); bySize.get(it.size).push(it); }
for (const group of bySize.values()) {
    if (group.length < 2) continue;                       // taille unique : pas de doublon possible, pas de lecture
    for (const it of group) it.hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(audioDir, `${it.id}.bin`))).digest('hex');
}

// 2. Playlists
const playlists = [];
for (const f of fs.existsSync(plDir) ? fs.readdirSync(plDir) : []) {
    if (!f.endsWith('.json')) continue;
    const data = readJson(path.join(plDir, f));
    if (data) playlists.push({ file: path.join(plDir, f), data });
}
const refCount = new Map();
for (const p of playlists) for (const t of (p.data.tracks || [])) if (t && t.id) refCount.set(t.id, (refCount.get(t.id) || 0) + 1);

// 3. Groupes identiques
const groups = new Map();
for (const it of items) {
    if (!it.hash) continue;
    const k = `${it.size}:${it.hash}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
}
const remap = new Map();    // id supprimé → id conservé
const toDelete = [];
let savedBytes = 0;
for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => ((refCount.get(b.id) || 0) - (refCount.get(a.id) || 0)) || (a.created - b.created));
    const keep = g[0];
    for (const d of g.slice(1)) { remap.set(d.id, keep.id); toDelete.push(d); savedBytes += d.size; }
}

// Même nom mais contenu différent : signalé seulement (peut être une autre version du morceau)
const byName = new Map();
for (const it of items) {
    const k = it.name.toLowerCase().replace(/\.(mp3|wav|ogg|flac|m4a|aac)$/i, '').trim();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(it);
}
const sameNameDiff = [...byName.values()].filter(g => g.length > 1 && new Set(g.map(x => x.hash || x.id)).size > 1);

console.log(`${items.length} morceaux sur le disque, ${groups.size ? [...groups.values()].filter(g => g.length > 1).length : 0} groupes de doublons exacts.`);
console.log(`${toDelete.length} fichiers en trop = ${(savedBytes / 1048576).toFixed(0)} Mo à libérer.`);
for (const d of toDelete.slice(0, 25)) console.log(`  - ${d.name}  (${(d.size / 1048576).toFixed(1)} Mo)  → remplacé par ${remap.get(d.id)}`);
if (toDelete.length > 25) console.log(`  … et ${toDelete.length - 25} autres`);
if (sameNameDiff.length) console.log(`\n${sameNameDiff.length} noms identiques mais contenus différents (conservés, à vérifier à la main) :\n` + sameNameDiff.slice(0, 15).map(g => `  · ${g[0].name} ×${g.length}`).join('\n'));

if (!apply) { console.log('\nSimulation uniquement. Relancez avec --apply pour supprimer.'); process.exit(0); }

// 4. Playlists d'abord (pas de référence cassée), puis fichiers
let plChanged = 0;
for (const p of playlists) {
    let changed = false;
    const seen = new Set();
    const tracks = [];
    for (const t of (p.data.tracks || [])) {
        const nid = t && remap.get(t.id);
        const tt = nid ? { ...t, id: nid, url: `/audio/track/${nid}` } : t;
        if (nid) changed = true;
        if (tt && tt.id && seen.has(tt.id)) { changed = true; continue; }   // même morceau deux fois dans la playlist après fusion
        if (tt && tt.id) seen.add(tt.id);
        tracks.push(tt);
    }
    if (changed) { p.data.tracks = tracks; fs.writeFileSync(p.file, JSON.stringify(p.data, null, 2)); plChanged++; }
}
// Files d'attente mémorisées des salles permanentes : redirigées vers le morceau conservé
const worldsDir = path.join(storage, 'worlds');
for (const f of fs.existsSync(worldsDir) ? fs.readdirSync(worldsDir) : []) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(worldsDir, f), w = readJson(file);
    if (!w || !w.queue) continue;
    let ch = false;
    const fix = (t) => { const n = t && remap.get(t.id); if (n) { ch = true; return { ...t, id: n, url: `/audio/track/${n}` }; } return t; };
    w.queue.currentTrack = fix(w.queue.currentTrack);
    w.queue.manualQueue = (w.queue.manualQueue || []).map(fix);
    w.queue.contextQueue = (w.queue.contextQueue || []).map(fix);
    if (ch) fs.writeFileSync(file, JSON.stringify(w));
}
let removed = 0;
for (const d of toDelete) {
    for (const ext of ['bin', 'json']) { try { fs.unlinkSync(path.join(audioDir, `${d.id}.${ext}`)); } catch (_) {} }
    removed++;
}
console.log(`\n${removed} fichiers supprimés, ${plChanged} playlists mises à jour, ${(savedBytes / 1048576).toFixed(0)} Mo libérés.`);
