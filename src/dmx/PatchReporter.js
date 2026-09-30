/**
 * PatchReporter.js
 * ─────────────────────────────────────────────────────────────
 * Liste des projecteurs de la scène (type, patch DMX, pilotage, position) envoyée au serveur
 * pour la régie lumière. Vérifiée chaque seconde, envoyée seulement quand elle change
 * (projecteur ajouté ou supprimé, adresse modifiée, prise de main, déplacement…).
 * Chaque joueur l'envoie : le serveur ne garde que la dernière, identique chez tous.
 * ─────────────────────────────────────────────────────────────
 */

import { encode as encodeSpot } from '../spot/SpotProfile.js';
import { encode as encodeLedBar } from '../ledbar/LedBarProfile.js';
import { encode as encodeStrobe } from '../strobe/StrobeProfile.js';
import { encode as encodeLaser } from '../laser/LaserProfile.js';
import { encode as encodeLaser2 } from '../laser2/Laser2Profile.js';

const INTERVAL = 1000;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Projecteurs de la scène, au format lu par la régie
 * @returns {object[]}
 */
export function collectPatch({ spotManager, ledBarManager, strobeManager, laserManager, laser2Manager }) {
    const out = [];
    const base = (f) => ({ universe: f.dmxUniverse, address: f.dmxAddress, footprint: f.dmxFootprint, control: f.dmxControlled });
    if (spotManager) {
        for (const s of spotManager.getAllSpots()) {
            const p = s.params;
            out.push({ id: s.id, kind: 'spot', number: s.number, mode: p.dmxMode, ...base(s), x: r2(p.posX), y: r2(p.posY), z: r2(p.posZ), yaw: r2(p.yaw) });
        }
    }
    if (ledBarManager) {
        for (const b of ledBarManager.getAllBars()) {
            const p = b.params;
            out.push({ id: b.id, kind: 'ledbar', number: b.number, mode: p.dmxMode, pixelCount: b.pixelCount, ...base(b), x: r2(p.posX), y: r2(p.posY), z: r2(p.posZ), yaw: r2(p.yaw) });
        }
    }
    if (strobeManager) {
        for (const st of strobeManager.getAllStrobes()) {
            const p = st.params;
            out.push({ id: st.id, kind: 'strobe', number: st.number, mode: p.dmxMode, ...base(st), x: r2(p.posX), y: r2(p.posY), z: r2(p.posZ), yaw: r2(p.angle) });
        }
    }
    if (laserManager) {
        for (const l of laserManager.getAllLasers()) {
            const pos = l.getPosition();
            out.push({ id: l.laserId, kind: 'laser', number: l.laserId + 1, mode: l.params.dmxMode, ...base(l), x: r2(pos.x), y: r2(pos.y), z: r2(pos.z), yaw: r2(l.params.angle) });
        }
    }
    if (laser2Manager) {
        for (const l of laser2Manager.getAllLasers()) {
            const p = l.params;
            out.push({ id: l.id, kind: 'laser2', number: l.number, mode: p.dmxMode, ...base(l), x: r2(p.posX), y: r2(p.posY), z: r2(p.posZ), yaw: r2(p.yaw) });
        }
    }
    return out;
}

/**
 * Valeurs DMX équivalentes aux réglages actuels de projecteurs (clés « type:id »),
 * pour que la régie reprenne la lumière telle qu'elle est avant de prendre la main
 * @returns {Object<string, {universe: number, address: number, values: number[]}>}
 */
export function encodeFixtureStates({ spotManager, ledBarManager, strobeManager, laserManager, laser2Manager }, keys) {
    const out = {};
    for (const key of keys) {
        const i = String(key).indexOf(':');
        if (i < 0) continue;
        const kind = key.slice(0, i);
        const id = key.slice(i + 1);
        let f = null;
        let bytes = null;
        if (kind === 'spot' && spotManager) {
            f = spotManager.getSpot(id);
            if (f) bytes = encodeSpot(f.params, f.params.dmxMode);
        } else if (kind === 'ledbar' && ledBarManager) {
            f = ledBarManager.getBar(id);
            if (f) bytes = encodeLedBar(f.params, f.params.dmxMode, f.pixelCount);
        } else if (kind === 'strobe' && strobeManager) {
            f = strobeManager.getStrobe(Number(id));
            if (f) bytes = encodeStrobe(f.params);
        } else if (kind === 'laser' && laserManager) {
            f = laserManager.getLaser(Number(id));
            if (f) bytes = encodeLaser(f.params);
        } else if (kind === 'laser2' && laser2Manager) {
            f = laser2Manager.getLaser(id);
            if (f) bytes = encodeLaser2(f.params, f.params.dmxMode);
        }
        if (f && bytes) out[key] = { universe: f.dmxUniverse, address: f.dmxAddress, values: Array.from(bytes) };
    }
    return out;
}

export class PatchReporter {
    /**
     * @param {object} o
     * @param {() => object[]} o.collect
     * @param {(fixtures: object[]) => void} o.send
     * @param {() => string|null} o.room  salle courante (null = pas connecté)
     */
    constructor({ collect, send, room }) {
        this._collect = collect;
        this._send = send;
        this._room = room;
        this._last = null;
        this._timer = null;
    }

    start() {
        if (!this._timer) this._timer = setInterval(() => this.tick(), INTERVAL);
    }

    tick() {
        const room = this._room();
        if (!room) {
            this._last = null;
            return;
        }
        let list;
        try { list = this._collect(); } catch (e) { console.warn('[PatchReporter]', e); return; }
        const key = room + '|' + JSON.stringify(list);
        if (key === this._last) return;
        this._last = key;
        this._send(list);
    }
}
