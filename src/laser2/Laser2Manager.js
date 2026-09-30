/**
 * Laser2Manager.js
 * ─────────────────────────────────────────────────────────────
 * Orchestrateur des nouveaux lasers (moteur de points + galvos) :
 *   - ajout / suppression / duplication / recherche (identifiants uniques réseau)
 *   - mise à jour sur l'horloge commune (même image chez tous les joueurs)
 *   - calcul (galvos, faisceaux, collisions) dans un Web Worker (core/) : le fil principal envoie
 *     les réglages quand ils changent et l'heure à chaque image, puis dessine la géométrie reçue
 *   - rendu batché : 3 draw calls (faisceaux, nappes, impacts), 3 pour tous les boîtiers
 *   - éblouissement réaliste : puissance reçue par l'œil (faisceau fixe = très fort, balayé = flash)
 *
 * Coexiste avec l'ancien système laser (src/laser/), voué à être supprimé.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Laser2Fixture } from './Laser2Fixture.js';
import { Laser2Batch, BEAM_STRIDE, SHEET_STRIDE } from './Laser2Batch.js';
import { getLaser2HousingInstancer } from './Laser2Housing.js';
import { Laser2Host } from './core/Laser2Host.js';
import { packPlayers } from './core/Collision.js';
import { buildLaser2ObstacleGroups } from './Laser2Obstacles.js';
import { ildaLibrary } from './ilda/IldaLibrary.js';

/** Rayon de capture autour de l'œil (m) : pupille + marge de tête (un faisceau de 1 cm reste « visé ») */
const EYE_R = 0.05;
/** Puissance reçue (unités affichées) donnant ~63 % d'éblouissement */
const DAZZLE_P0 = 0.08;

const _eye = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgb = [0, 0, 0];

function makeId() {
    return 'laser2-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

export class Laser2Manager {
    /**
     * @param {object} o
     * @param {THREE.Scene} o.scene
     * @param {THREE.PerspectiveCamera} o.camera
     * @param {THREE.WebGLRenderer} o.renderer
     * @param {() => number} o.clock horloge commune (s)
     */
    constructor({ scene, camera, renderer, clock }) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.clock = clock;
        this._lasers = new Map();
        this._nextNumber = 1;
        this.batch = new Laser2Batch(scene);
        this._instancer = getLaser2HousingInstancer(scene);
        this.cpuMs = 0;           // coût sur le fil principal (ms / image, lissé)
        this.coreMs = 0;          // coût du calcul (worker ou direct)
        this.prims = 0;
        this.shared = 0;
        this.dazzle = null;
        this.patch = null;
        this.playerCollider = null;
        this._players = null;
        this._sentDocs = new Set();
        this.previewId = null;    // laser dont le panneau affiche l'aperçu du tracé
        this.host = new Laser2Host((r) => this._onResult(r), () => this._resendAll());
        this.host.init(buildLaser2ObstacleGroups());
    }

    /** Mode de calcul : 'worker' ou 'direct' */
    get computeMode() {
        return this.host.mode;
    }

    /** Le worker a planté : tout l'état est renvoyé au calcul direct */
    _resendAll() {
        this._sentDocs.clear();
        for (const l of this._lasers.values()) { l._dirtyParams = true; l._dirtyTransform = true; l._sentDocKey = null; }
    }

    /** Patch DMX commun (lyres, barres LED, strobes, lasers) : pilotage par la régie */
    setPatch(patch) {
        this.patch = patch;
        for (const l of this._lasers.values()) l.attachPatch(patch);
    }

    /** Première adresse libre à partir de l'univers du laser (univers suivant quand il est plein) */
    _autoPatch(laser) {
        if (!this.patch) return;
        for (let u = laser.dmxUniverse; u <= 64; u++) {
            const addr = this.patch.findFreeAddress(u, laser.dmxFootprint, laser);
            if (addr > 0) {
                laser.params.dmxUniverse = u;
                laser.params.dmxAddress = addr;
                this.patch.invalidate(laser);
                return;
            }
        }
    }

    /** Collider des joueurs (les faisceaux s'arrêtent sur les corps et y laissent leur trace) */
    setPlayerCollider(collider) {
        this.playerCollider = collider;
    }

    /** Éblouissement partagé avec l'ancien système (DazzleEffect) */
    setDazzle(dazzle) {
        this.dazzle = dazzle;
    }

    addLaser(position = null, params = {}, id = null) {
        const laserId = id || makeId();
        if (this._lasers.has(laserId)) return { id: laserId, laser: this._lasers.get(laserId) };
        const p = { ...params };
        if (position) {
            p.posX = Math.round(position.x * 100) / 100;
            p.posY = Math.round(position.y * 100) / 100;
            p.posZ = Math.round(position.z * 100) / 100;
        }
        const laser = new Laser2Fixture({
            id: laserId,
            number: this._nextNumber++,
            scene: this.scene,
            params: p,
        });
        this._lasers.set(laserId, laser);
        if (this.patch) {
            laser.attachPatch(this.patch);
            if (!id && params.dmxAddress === undefined) this._autoPatch(laser);
        }
        return { id: laserId, laser };
    }

    removeLaser(id) {
        const l = this._lasers.get(id);
        if (!l) return false;
        l.dispose();
        this._lasers.delete(id);
        this.host.remove(id);
        return true;
    }

    duplicateLaser(id) {
        const src = this._lasers.get(id);
        if (!src) return null;
        const params = { ...src.params };
        params.posX += 0.6;
        delete params.dmxAddress;
        return this.addLaser(null, params);
    }

    getLaser(id) {
        return this._lasers.get(id) || null;
    }

    getAllLasers() {
        return Array.from(this._lasers.values());
    }

    get count() {
        return this._lasers.size;
    }

    getLaserObjects() {
        const out = [];
        for (const l of this._lasers.values()) out.push(l.pickMesh);
        return out;
    }

    getLaserFromObject(obj) {
        let cur = obj;
        while (cur) {
            if (cur.userData && cur.userData.laser2Instance) return cur.userData.laser2Instance;
            cur = cur.parent;
        }
        return null;
    }

    update() {
        const t0 = performance.now();
        for (const l of this._lasers.values()) {
            if (l.isBeingDragged) l.syncFromGizmo();
            // Forme ILDA : prise dans la bibliothèque partagée, envoyée une fois au cœur de calcul
            let docKey = '';
            if (l.params.source === 'Fichier ILDA') {
                ildaLibrary.ensureLoaded();
                const doc = ildaLibrary.get(l.params.ildaFile);
                const e = doc && ildaLibrary.entry(l.params.ildaFile);
                if (doc && e) {
                    docKey = `${l.params.ildaFile}@${e.mtime}`;
                    if (!this._sentDocs.has(docKey)) {
                        this.host.doc(docKey, doc.frames.map(f => ({
                            n: f.n, x: f.x.slice(0, f.n), y: f.y.slice(0, f.n), r: f.r.slice(0, f.n), g: f.g.slice(0, f.n), b: f.b.slice(0, f.n),
                        })));
                        this._sentDocs.add(docKey);
                    }
                }
                l.docReady = Boolean(docKey);
            }
            const msg = {};
            let send = false;
            if (l._dirtyParams) { msg.params = { ...l.params }; l._dirtyParams = false; send = true; }
            if (l._dirtyTransform) { msg.transform = l.transformArray(); l._dirtyTransform = false; send = true; }
            if (docKey !== l._sentDocKey) { msg.docKey = docKey; l._sentDocKey = docKey; send = true; }
            if (send) this.host.set(l.id, msg);
        }
        this._players = packPlayers(this.playerCollider, this._players);
        // Mode worker : envoie une copie (le tableau est réutilisé d'une image à l'autre)
        const players = this.host.mode === 'worker' ? this._players.slice(0, this._playersLen()) : this._players;
        this.host.frame(this.clock(), players, this.previewId);
        this._instancer.flush();
        if (this.dazzle && this.camera) this._updateDazzle();
        this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.05;
    }

    _playersLen() {
        const P = this._players;
        let o = 1;
        for (let p = 0, n = P[0] | 0; p < n; p++) o += 7 + (P[o + 6] | 0) * 7;
        return o;
    }

    /** Géométrie reçue du cœur de calcul */
    _onResult(r) {
        const t0 = performance.now();
        for (const it of r.items) {
            const l = this._lasers.get(it.id);
            if (l) l.applyResult(it);
        }
        if (r.preview && r.previewId) {
            const l = this._lasers.get(r.previewId);
            if (l) l.preview = r.preview;
        }
        this.batch.assemble(this._lasers.values(), this.camera, this.renderer);
        this._instancer.flush();
        this.coreMs += (r.ms - this.coreMs) * 0.05;
        this.prims = r.prims;
        this.shared = r.shared;
        this.tolScale = r.tolScale;
        this.cpuMs += (performance.now() - t0) * 0.05;
    }

    /**
     * Puissance reçue par l'œil de la caméra :
     *   - faisceau : l'œil est dans le faisceau → sa puissance (moyenne) entière
     *   - nappe    : l'œil est dans le plan balayé → fraction du temps où le faisceau passe sur l'œil
     *                (largeur de capture / arc balayé à cette distance)
     * × regard vers la source. Converti en force 0…1 pour le DazzleEffect (flash, persistance).
     */
    _updateDazzle() {
        const cam = this.camera;
        _eye.setFromMatrixPosition(cam.matrixWorld);
        cam.getWorldDirection(_fwd);
        let best = 0, bestLaser = null;
        const col = _rgb;
        for (const l of this._lasers.values()) {
            const O = l.origin;
            const ex = _eye.x - O.x, ey = _eye.y - O.y, ez = _eye.z - O.z;
            const r = Math.sqrt(ex * ex + ey * ey + ez * ez);
            if (r < 0.05) continue;
            // L'œil doit être devant le laser
            if (ex * l.fwd.x + ey * l.fwd.y + ez * l.fwd.z <= 0) continue;
            const look = Math.max(0.1, Math.min(1, -(ex * _fwd.x + ey * _fwd.y + ez * _fwd.z) / r * 0.7 + 0.3));
            const div = l.params.divergence * 1e-3, ap = l.params.aperture * 1e-3;
            const R = Math.max(0.5 * (ap + r * div), 0.005) + EYE_R;
            let P = 0, cr = 0, cg = 0, cb = 0;

            const B = l.beamData;
            for (let i = 0; i < l.beamN; i++) {
                const o = i * BEAM_STRIDE;
                const dx = B[o + 4] - O.x, dy = B[o + 5] - O.y, dz = B[o + 6] - O.z;
                const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
                // L'œil est avant l'impact (marge : le corps du joueur arrête le faisceau juste devant l'œil)
                const along = (ex * dx + ey * dy + ez * dz) / len;
                if (along <= 0 || along > len + 0.6) continue;
                const px = ex - dx / len * along, py = ey - dy / len * along, pz = ez - dz / len * along;
                const dist = Math.sqrt(px * px + py * py + pz * pz);
                if (dist >= R) continue;
                const k = (1 - dist / R);
                const p = B[o + 11] * k * k;
                P += p; cr += B[o + 8] * p; cg += B[o + 9] * p; cb += B[o + 10] * p;
            }

            const S = l.sheetData;
            for (let i = 0; i < l.sheetN; i++) {
                const o = i * SHEET_STRIDE;
                const ax = S[o + 4] - O.x, ay = S[o + 5] - O.y, az = S[o + 6] - O.z;
                const bx = S[o + 8] - O.x, by = S[o + 9] - O.y, bz = S[o + 10] - O.z;
                let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
                const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (nl < 1e-9) continue;
                nx /= nl; ny /= nl; nz /= nl;
                const dp = Math.abs(ex * nx + ey * ny + ez * nz);
                if (dp >= R) continue;
                // Dans le secteur A → B (même côté des deux bords), avant les impacts
                const s1 = (ay * ez - az * ey) * nx + (az * ex - ax * ez) * ny + (ax * ey - ay * ex) * nz;
                const s2 = (ey * bz - ez * by) * nx + (ez * bx - ex * bz) * ny + (ex * by - ey * bx) * nz;
                const la = Math.sqrt(ax * ax + ay * ay + az * az), lb = Math.sqrt(bx * bx + by * by + bz * bz);
                // Tolérance angulaire R / r (s1 = |A|·r·sin(angle A → œil))
                if (s1 < -R * la || s2 < -R * lb) continue;
                if (r > Math.max(la, lb) + 0.6) continue;
                const arc = r * S[o + 11];
                const frac = Math.min(1, (2 * R) / Math.max(arc, 1e-4));
                const k = 1 - dp / R;
                const p = S[o + 15] * frac * k * k;
                P += p; cr += S[o + 12] * p; cg += S[o + 13] * p; cb += S[o + 14] * p;
            }

            const s = 1 - Math.exp(-(P * look) / DAZZLE_P0);
            if (s > best) {
                best = s;
                bestLaser = l;
                col[0] = cr / P; col[1] = cg / P; col[2] = cb / P;
            }
        }
        if (bestLaser && best > 0.005) {
            const m = Math.max(col[0], col[1], col[2], 1e-6);
            const hex = '#' + col.map(v => Math.round(255 * v / m).toString(16).padStart(2, '0')).join('');
            this.dazzle.setExternal(best, bestLaser.origin, hex);
        }
    }

    dispose() {
        this.host.dispose();
        for (const l of this._lasers.values()) l.dispose();
        this._lasers.clear();
        this.batch.dispose();
    }
}
