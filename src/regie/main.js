/**
 * main.js — page régie lumière (/regie)
 *
 * Pilote en DMX les projecteurs d'une salle du jeu : la régie calcule les univers,
 * les envoie au serveur, qui les relaie aux joueurs (WebSocket).
 * Projecteurs de la salle (liste envoyée par le jeu), plan, patch, groupes, faders
 * de la sélection ou de canaux bruts, prise de main, grand master et blackout,
 * patterns (moteur d'effets en temps musicaux) et shows sauvegardés sur le serveur.
 */

import { RegieClient } from './RegieClient.js';
import { DmxOutput } from './DmxOutput.js';
import { RoomsView, OUTDATED_TEXT } from './ui/RoomsView.js';
import { DeskView } from './ui/DeskView.js';
import { FixtureStore, takeLegacyGroups } from './FixtureStore.js';
import { channelsOf } from './fixtureTypes.js';
import { ShowStore } from './ShowStore.js';
import { TempoClock } from './TempoClock.js';
import { PatternEngine } from './PatternEngine.js';

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

const store = new FixtureStore();
client.on('patch', (fixtures) => store.setFixtures(fixtures));

// Show courant (sauvegardé sur le serveur), tempo et patterns joués par-dessus les réglages manuels
const shows = new ShowStore();
const tempo = new TempoClock(() => client.clock.now());
const engine = new PatternEngine({ store, tempo, getShow: () => shows.show });
out.setLayer((frameOf, t) => engine.apply(frameOf, t));

let _showId = null;
shows.onChange(() => {
    const show = shows.show;
    if (!show || show.id === _showId) return;
    _showId = show.id;
    engine.stopAll();
    tempo.setBpm(show.bpm);
    engine.setSpeed(show.live ? show.live.speed : 1, client.clock.now());
    // Groupes de l'étape 2 (gardés sur ce poste) : repris une fois dans le show
    const legacy = takeLegacyGroups();
    if (legacy.length && show.groups.length === 0) {
        show.groups.push(...legacy);
        shows.touch();
    }
    store.bindGroups(show.groups, () => shows.touch());
});
shows.openLast();

// Canaux d'intensité de tous les projecteurs patchés : ceux que le master et le blackout touchent
let _patchSignature = '';
store.onChange(() => {
    const sig = store.fixtures.map((f) => `${f.kind}${f.id}@${f.universe}.${f.address}/${f.mode}/${f.pixelCount || 0}`).join('|');
    if (sig === _patchSignature) return;
    _patchSignature = sig;
    const map = new Map();
    for (const f of store.fixtures) {
        for (const c of channelsOf(f)) {
            if (!c.intensity || c.fine) continue;
            if (!map.has(f.universe)) map.set(f.universe, []);
            map.get(f.universe).push({ address: c.address, fineAddress: c.fineAddress });
        }
    }
    out.setIntensityChannels(map);
});

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
    store.setFixtures([]);
    setRoomInUrl(roomId);
    client.join(roomId);
    out.start();
    setView(new DeskView({ client, out, store, shows, tempo, engine, prefs, savePrefs, onLeave: () => showRooms() }));
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
    shows.flushOnExit();
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

// Accès de débogage depuis la console du navigateur
window.__regie = { client, out, store, shows, tempo, engine, get view() { return view; } };
