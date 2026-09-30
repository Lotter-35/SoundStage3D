/**
 * main.js — page régie lumière (/regie)
 *
 * Pilote en DMX les projecteurs d'une salle du jeu : la régie calcule les univers,
 * les envoie au serveur, qui les relaie aux joueurs (WebSocket).
 * Étape 1 : sortie DMX brute (moniteur + faders de canaux).
 */

import { RegieClient } from './RegieClient.js';
import { DmxOutput } from './DmxOutput.js';
import { RoomsView, OUTDATED_TEXT } from './ui/RoomsView.js';
import { DeskView } from './ui/DeskView.js';

const PREFS_KEY = 'soundstage3d:regie';

function loadPrefs() {
    try {
        const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
        if (p && typeof p === 'object') return p;
    } catch (_) { /* stockage indisponible */ }
    return {};
}

const prefs = { lookahead: 100, percent: false, universe: 1, bankStart: 1, ...loadPrefs() };
function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) { /* stockage indisponible */ }
}

const client = new RegieClient();
const out = new DmxOutput({ send: (bytes) => client.sendBinary(bytes), now: () => client.clock.now() });
out.lookahead = Number.isFinite(prefs.lookahead) ? prefs.lookahead : 100;
client.on('dmx', (packet) => out.receive(packet));

const app = document.getElementById('app');
let view = null;

function setView(v) {
    if (view) view.unmount();
    view = v;
    view.mount(app);
}

function setRoomInUrl(roomId) {
    const url = new URL(window.location.href);
    if (roomId) url.searchParams.set('room', roomId);
    else url.searchParams.delete('room');
    history.replaceState(null, '', url);
    document.title = roomId ? `Régie ${roomId} — SoundStage3D` : 'Régie — SoundStage3D';
}

function openRoom(roomId) {
    out.reset();
    setRoomInUrl(roomId);
    client.join(roomId);
    out.start();
    setView(new DeskView({ client, out, prefs, savePrefs, onLeave: () => showRooms() }));
}

function showRooms(error = '') {
    client.leave();
    out.stop();
    setRoomInUrl(null);
    setView(new RoomsView({ client, onOpen: openRoom, error }));
}

client.on('notfound', (id) => showRooms(`La salle ${id} n'existe pas ou n'existe plus.`));
client.on('roomclosed', () => showRooms('La salle a été fermée : plus aucun joueur connecté.'));
client.on('outdated', () => showRooms(OUTDATED_TEXT));

// Page quittée ou mise en cache par le navigateur : on ferme la connexion (sinon la régie resterait
// ouverte côté serveur) ; retour sur la page depuis le cache : on rouvre la salle
window.addEventListener('pagehide', () => {
    client.leave();
    out.stop();
});
window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    const room = new URLSearchParams(window.location.search).get('room');
    if (room) openRoom(room.toUpperCase());
    else showRooms();
});

const initial = new URLSearchParams(window.location.search).get('room');
if (initial) openRoom(initial.toUpperCase());
else showRooms();

window.__regie = { client, out };
