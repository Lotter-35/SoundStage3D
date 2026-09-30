/**
 * Laser2Host.js — côté jeu : envoie les réglages et l'heure au cœur de calcul des lasers et reçoit
 * la géométrie à dessiner.
 *   - mode WORKER (par défaut) : le calcul tourne dans un Web Worker, en parallèle du rendu.
 *     Une image est calculée pendant que la précédente s'affiche (une image de décalage, identique
 *     chez tous les joueurs puisque tout suit l'horloge commune). Si le worker est encore occupé,
 *     l'image suivante n'est pas demandée : pas de file d'attente, pas de retard qui s'accumule.
 *   - mode DIRECT (repli si les workers de modules sont indisponibles ou plantent) : même code,
 *     sur le fil principal.
 */

import { CoreSystem } from './Laser2Core.js';
import { setObstacleGroups, setPlayerCapsules } from './Collision.js';
import { viewsOf } from './pack.js';

export class Laser2Host {
    /**
     * @param {(result: object) => void} onResult géométrie reçue
     * @param {() => void} onReset le worker a planté : tout l'état doit être renvoyé (mode direct)
     */
    constructor(onResult, onReset) {
        this.onResult = onResult;
        this.onReset = onReset;
        this.worker = null;
        this.sys = null;
        this.busy = false;
        this._inUse = null;       // tampon dont les vues sont affichées
        this._spare = null;       // tampon à rendre au worker
        this._groups = null;
        this.mode = 'direct';
        let useWorker = typeof Worker !== 'undefined';
        try { if (new URLSearchParams(location.search).get('laser2worker') === '0') useWorker = false; } catch (_) {}
        if (useWorker) {
            try {
                this.worker = new Worker(new URL('./laser2Worker.js', import.meta.url), { type: 'module' });
                this.worker.onmessage = (e) => this._onMessage(e.data);
                this.worker.onerror = (e) => this._fallback(e);
                this.mode = 'worker';
            } catch (e) {
                this._fallback(e);
            }
        } else {
            this._fallback(null);
        }
    }

    _fallback(err) {
        if (err) console.warn('[Laser2] Web Worker indisponible, calcul sur le fil principal :', err.message || err);
        if (this.worker) { try { this.worker.terminate(); } catch (_) {} }
        this.worker = null;
        this.busy = false;
        this.mode = 'direct';
        this.sys = new CoreSystem();
        if (this._groups) setObstacleGroups(this._groups);
        if (err && this.onReset) this.onReset();
    }

    _post(msg, transfer) {
        if (this.worker) this.worker.postMessage(msg, transfer || []);
    }

    init(groups) {
        this._groups = groups;
        if (this.worker) this._post({ type: 'init', groups });
        else setObstacleGroups(groups);
    }

    set(id, msg) {
        if (this.worker) this._post({ type: 'set', id, ...msg });
        else this.sys.set(id, msg);
    }

    remove(id) {
        if (this.worker) this._post({ type: 'remove', id });
        else this.sys.remove(id);
    }

    doc(key, frames) {
        if (this.worker) this._post({ type: 'doc', key, frames });
        else this.sys.setDoc(key, frames);
    }

    /**
     * Demande l'image de l'instant t (horloge commune).
     * @param {Float32Array} players capsules des joueurs (format compact)
     * @param {string|null} previewId laser dont l'aperçu du tracé est demandé
     */
    frame(t, players, previewId) {
        if (this.worker) {
            if (this.busy) return;
            this.busy = true;
            const transfer = [];
            const msg = { type: 'frame', t, players, preview: previewId || null };
            if (this._spare) { msg.buffer = this._spare; transfer.push(this._spare); this._spare = null; }
            this._post(msg, transfer);
            return;
        }
        // Mode direct : calcul immédiat, vues sur les tableaux du cœur
        setPlayerCapsules(players);
        const t0 = performance.now();
        this.sys.update(t);
        const items = [];
        for (const c of this.sys.cores.values()) {
            const s = c.scanner ? c.scanner.stats : null;
            items.push({
                id: c.id, lens: c.lens, stats: s,
                beamData: c.beamData, beamN: c.beamN, sheetData: c.sheetData, sheetN: c.sheetN, impactData: c.impactData, impactN: c.impactN,
            });
        }
        this.onResult({
            items, preview: previewId ? this.sys.preview(previewId) : null, previewId,
            ms: performance.now() - t0, prims: this.sys.totalPrims, shared: this.sys.shared, tolScale: this.sys.tolScale,
        });
    }

    _onMessage(m) {
        if (m.type !== 'result') return;
        this.busy = false;
        // Le tampon affiché jusqu'ici peut repartir au worker à la prochaine demande
        if (this._inUse) this._spare = this._inUse;
        this._inUse = m.buffer;
        const items = m.header.map(h => ({ id: h.id, lens: h.lens, stats: h.stats, beamN: h.bn, sheetN: h.sn, impactN: h.in, ...viewsOf(m.buffer, h) }));
        this.onResult({ items, preview: m.preview, previewId: m.previewId, ms: m.ms, prims: m.prims, shared: m.shared, tolScale: m.tolScale });
    }

    dispose() {
        if (this.worker) this.worker.terminate();
        this.worker = null;
    }
}
