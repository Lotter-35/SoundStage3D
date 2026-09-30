/**
 * ShowStore.js — show courant de la régie (BPM, groupes, patterns), sauvegardé sur le serveur.
 *
 * Toute modification marque le show « modifié » et part au serveur après une courte pause
 * (sauvegarde automatique) : server/storage/shows/<id>.json, via /api/shows.
 * Le dernier show ouvert est rouvert au chargement de la page.
 */

import { serverBase } from './RegieClient.js';

const SAVE_DELAY = 800;
const LAST_SHOW_KEY = 'soundstage3d:regie:show';

export function newId(prefix) {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const LIVE_COLS = 8;

/** Page Live par défaut : 4 rangées de 8 pads vides, lancement à la mesure */
function emptyLive() {
    return {
        cols: LIVE_COLS, quantize: 4, fade: 0, speed: 1,
        rows: [1, 2, 3, 4].map((i) => ({ id: newId('r'), name: `Rangée ${i}`, level: 1, pads: new Array(LIVE_COLS).fill(null) })),
    };
}

function emptyShow(name) {
    return { id: newId('s'), name, version: 1, createdAt: Date.now(), updatedAt: 0, bpm: 120, groups: [], patterns: [], live: emptyLive() };
}

/** Complète un show lu sur le serveur (champs manquants, points triés) */
function normalize(show) {
    const s = show && typeof show === 'object' ? show : emptyShow('Show');
    if (!Array.isArray(s.groups)) s.groups = [];
    if (!Array.isArray(s.patterns)) s.patterns = [];
    if (!(s.bpm > 0)) s.bpm = 120;
    if (!s.live || typeof s.live !== 'object' || !Array.isArray(s.live.rows)) s.live = emptyLive();
    const live = s.live;
    if (!(live.cols > 0)) live.cols = LIVE_COLS;
    if (!(live.speed > 0)) live.speed = 1;
    for (const r of live.rows) {
        if (!Array.isArray(r.pads)) r.pads = [];
        while (r.pads.length < live.cols) r.pads.push(null);
        if (!(r.level >= 0)) r.level = 1;
    }
    for (const p of s.patterns) {
        if (!Array.isArray(p.tracks)) p.tracks = [];
        if (!(p.length > 0)) p.length = 16;
        for (const t of p.tracks) {
            if (!Array.isArray(t.points)) t.points = [];
            t.points.sort((a, b) => a.t - b.t);
        }
    }
    return s;
}

export class ShowStore {
    constructor() {
        this._base = serverBase().http;
        /** @type {object|null} */
        this.show = null;
        this.status = 'idle';   // idle | loading | saved | dirty | saving | error
        this.error = '';
        this.list = [];
        this.version = 0;       // show modifié ou changé (rafraîchissement des vues)
        this._timer = null;
        this._listeners = [];
    }

    onChange(cb) {
        this._listeners.push(cb);
    }

    _changed() {
        this.version++;
        for (const cb of this._listeners) {
            try { cb(); } catch (e) { console.error('[Régie] show', e); }
        }
    }

    _setStatus(s, error = '') {
        this.status = s;
        this.error = error;
        this.version++;
    }

    async refreshList() {
        try {
            const res = await fetch(`${this._base}/api/shows`, { cache: 'no-store' });
            if (res.ok) this.list = await res.json();
        } catch (_) { /* serveur injoignable : liste inchangée */ }
        this.version++;
        return this.list;
    }

    async open(id) {
        await this.flush();
        this._setStatus('loading');
        try {
            const res = await fetch(`${this._base}/api/shows/${encodeURIComponent(id)}`, { cache: 'no-store' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.show = normalize(await res.json());
            this._remember();
            this._setStatus('saved');
        } catch (e) {
            this._setStatus('error', 'Show introuvable sur le serveur');
            return false;
        }
        this._changed();
        return true;
    }

    /** Rouvre le dernier show, sinon le plus récent, sinon en crée un */
    async openLast() {
        const list = await this.refreshList();
        let last = null;
        try { last = localStorage.getItem(LAST_SHOW_KEY); } catch (_) { /* stockage indisponible */ }
        const target = list.find((s) => s.id === last) || list[0];
        if (target && await this.open(target.id)) return;
        await this.create('Show 1');
    }

    async create(name) {
        await this.flush();
        this.show = emptyShow(name || `Show ${this.list.length + 1}`);
        this._remember();
        this._changed();
        await this.saveNow();
        await this.refreshList();
    }

    async duplicate() {
        if (!this.show) return;
        await this.flush();
        const copy = JSON.parse(JSON.stringify(this.show));
        copy.id = newId('s');
        copy.name = `${this.show.name} (copie)`;
        copy.createdAt = Date.now();
        this.show = normalize(copy);
        this._remember();
        this._changed();
        await this.saveNow();
        await this.refreshList();
    }

    async remove(id) {
        try { await fetch(`${this._base}/api/shows/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch (_) { /* hors ligne */ }
        if (this.show && this.show.id === id) {
            clearTimeout(this._timer);
            this.show = null;
            await this.openLast();
        } else {
            await this.refreshList();
        }
    }

    rename(name) {
        if (!this.show || !name) return;
        this.show.name = name;
        this.touch();
    }

    /** À appeler après toute modification du show : sauvegarde automatique après une pause */
    touch() {
        if (!this.show) return;
        this._setStatus('dirty');
        this._changed();
        clearTimeout(this._timer);
        this._timer = setTimeout(() => { this.saveNow(); }, SAVE_DELAY);
    }

    /** Sauvegarde en attente envoyée tout de suite */
    async flush() {
        if (this.status === 'dirty') {
            clearTimeout(this._timer);
            await this.saveNow();
        }
    }

    async saveNow() {
        const show = this.show;
        if (!show) return;
        clearTimeout(this._timer);
        this._setStatus('saving');
        try {
            const res = await fetch(`${this._base}/api/shows/${encodeURIComponent(show.id)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(show),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const r = await res.json();
            show.updatedAt = r.updatedAt || Date.now();
            // Modifié pendant l'envoi : une autre sauvegarde suit
            if (this.status === 'saving') this._setStatus('saved');
        } catch (e) {
            this._setStatus('error', 'Sauvegarde impossible : le serveur ne répond pas');
            clearTimeout(this._timer);
            this._timer = setTimeout(() => { this.saveNow(); }, 4000);
        }
    }

    /** Envoi de dernière chance quand la page se ferme (sauvegarde en attente) */
    flushOnExit() {
        if (!this.show || this.status !== 'dirty') return;
        try {
            fetch(`${this._base}/api/shows/${encodeURIComponent(this.show.id)}`, {
                method: 'PUT', keepalive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.show),
            });
        } catch (_) { /* rien de plus à faire */ }
    }

    _remember() {
        try { localStorage.setItem(LAST_SHOW_KEY, this.show.id); } catch (_) { /* stockage indisponible */ }
    }
}
