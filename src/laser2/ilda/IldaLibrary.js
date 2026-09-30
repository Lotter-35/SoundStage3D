/**
 * IldaLibrary.js
 * ─────────────────────────────────────────────────────────────
 * Bibliothèque ILDA côté jeu (une seule pour tous les lasers) :
 *   - index des banques / formes du serveur (GET /api/ilda), mis à jour en direct par le message
 *     ILDA_INDEX quand un fichier est ajouté, modifié ou supprimé dans server/storage/ilda
 *   - téléchargement à la demande + lecture (IldaParser), cache par chemin et date de modification :
 *     plusieurs lasers qui jouent la même forme partagent les mêmes images
 * Sans serveur Node (serveur de fichiers simple), la bibliothèque est simplement vide.
 * ─────────────────────────────────────────────────────────────
 */

import { parseIlda } from './IldaParser.js';

class IldaLibrary {
    constructor() {
        this.index = { version: 0, banks: [] };
        this._byPath = new Map();     // chemin → { name, path, size, mtime, bank }
        this._cache = new Map();      // chemin → { mtime, doc, loading }
        this._listeners = new Set();
        this._requested = false;
    }

    /** Charge l'index depuis le serveur (une fois ; ensuite il est poussé par le serveur) */
    refresh() {
        this._requested = true;
        return fetch('/api/ilda', { cache: 'no-cache' })
            .then(r => (r.ok ? r.json() : null))
            .then(idx => { if (idx && Array.isArray(idx.banks)) this.setIndex(idx); })
            .catch(() => { /* pas de serveur Node : bibliothèque vide */ });
    }

    ensureLoaded() {
        if (!this._requested) this.refresh();
    }

    /** Nouvel index (serveur) : les formes modifiées seront rechargées */
    setIndex(idx) {
        if (!idx || !Array.isArray(idx.banks)) return;
        this.index = idx;
        this._byPath.clear();
        for (const b of idx.banks) for (const f of b.files) this._byPath.set(f.path, { ...f, bank: b.name });
        for (const [p, c] of this._cache) {
            const e = this._byPath.get(p);
            if (!e || e.mtime !== c.mtime) this._cache.delete(p);
        }
        for (const cb of this._listeners) { try { cb(this.index); } catch (_) {} }
    }

    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    get bankNames() {
        return this.index.banks.map(b => b.name);
    }

    filesOf(bank) {
        const b = this.index.banks.find(x => x.name === bank);
        return b ? b.files : [];
    }

    entry(path) {
        return this._byPath.get(path) || null;
    }

    /**
     * Forme prête à projeter, ou null (téléchargement lancé en arrière-plan).
     * @returns {{ frames: import('../Laser2Patterns.js').LaserFrame[], name: string, path: string } | null}
     */
    get(path) {
        if (!path) return null;
        const e = this._byPath.get(path);
        if (!e) return null;
        let c = this._cache.get(path);
        if (c && c.mtime === e.mtime) return c.doc;
        if (c && c.loading) return null;
        c = { mtime: e.mtime, doc: null, loading: true };
        this._cache.set(path, c);
        fetch(`/api/ilda/file?p=${encodeURIComponent(path)}`)
            .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then(buf => {
                const parsed = parseIlda(buf);
                c.doc = parsed.frames.length ? { frames: parsed.frames, name: e.name, path } : null;
                c.loading = false;
                if (!c.doc) console.warn(`[ILDA] ${path} : aucune image lisible`);
            })
            .catch(err => {
                c.loading = false;
                console.warn(`[ILDA] ${path} : chargement impossible (${err.message})`);
            });
        return null;
    }
}

/** Bibliothèque partagée par tous les lasers */
export const ildaLibrary = new IldaLibrary();
