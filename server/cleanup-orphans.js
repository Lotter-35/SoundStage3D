#!/usr/bin/env node
/**
 * cleanup-orphans.js — supprime du serveur les morceaux qui ne sont dans AUCUNE playlist.
 *
 *   node server/cleanup-orphans.js            → simulation : liste ce qui serait supprimé (rien n'est effacé)
 *   node server/cleanup-orphans.js --apply    → supprime réellement (définitif)
 *
 * À lancer serveur arrêté (ou sans salle en cours) : un morceau en cours de lecture dans une salle
 * mais absent des playlists serait supprimé.
 * SS3D_STORAGE_DIR : autre dossier de stockage.
 */
const path = require('path');
const { createTrackLibrary } = require('./trackLibrary');

const storage = process.env.SS3D_STORAGE_DIR ? path.resolve(process.env.SS3D_STORAGE_DIR) : path.resolve(__dirname, 'storage');
const apply = process.argv.includes('--apply');

const library = createTrackLibrary({
    audioDir: path.join(storage, 'audio'),
    playlistsDir: path.join(storage, 'playlists'),
    log: () => {},
});

const report = library.orphanReport();
console.log(`${report.total} morceaux sur le serveur, ${report.orphans} dans aucune playlist (${(report.orphanBytes / 1048576).toFixed(0)} Mo).`);

const orphans = library.allMeta().filter(m => {
    const fs = require('fs');
    let referenced = false;
    try {
        for (const f of fs.readdirSync(path.join(storage, 'playlists'))) {
            if (!f.endsWith('.json')) continue;
            const pl = JSON.parse(fs.readFileSync(path.join(storage, 'playlists', f), 'utf-8'));
            if ((pl.tracks || []).some(t => t.id === m.id)) { referenced = true; break; }
        }
    } catch (_) {}
    // Files d'attente mémorisées des salles permanentes (storage/worlds)
    if (!referenced) {
        try {
            for (const f of fs.readdirSync(path.join(storage, 'worlds'))) {
                if (!f.endsWith('.json')) continue;
                const q = (JSON.parse(fs.readFileSync(path.join(storage, 'worlds', f), 'utf-8')).queue) || {};
                if ([q.currentTrack, ...(q.manualQueue || []), ...(q.contextQueue || [])].some(t => t && t.id === m.id)) { referenced = true; break; }
            }
        } catch (_) {}
    }
    return !referenced;
});

if (!apply) {
    for (const m of orphans.slice(0, 40)) console.log(`  - ${m.name}  (${((m.size || 0) / 1048576).toFixed(1)} Mo)`);
    if (orphans.length > 40) console.log(`  … et ${orphans.length - 40} autres`);
    console.log('\nSimulation uniquement. Relancez avec --apply pour les supprimer définitivement.');
} else {
    const removed = library.collectGarbage(orphans.map(m => m.id), { minAgeMs: 0 });
    console.log(`${removed.length} morceau(x) supprimé(s).`);
}
