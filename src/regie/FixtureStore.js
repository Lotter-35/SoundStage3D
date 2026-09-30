/**
 * FixtureStore.js — projecteurs de la salle, sélection et groupes de la régie.
 *
 * La liste des projecteurs vient du jeu (message PATCH : type, patch DMX, pilotage, position).
 * La sélection est partagée par toutes les vues (plan, liste, faders).
 * Les groupes appartiennent au show courant (sauvegardé sur le serveur, voir ShowStore) :
 * bindGroups() les branche, chaque modification appelle le rappel de sauvegarde.
 */

import { fixtureKey, KIND_ORDER } from './fixtureTypes.js';

/** Ancienne clé des groupes (étape 2, gardés sur le poste) : repris une fois dans le show */
const LEGACY_GROUPS_KEY = 'soundstage3d:regie:groups';

export function takeLegacyGroups() {
    try {
        const g = JSON.parse(localStorage.getItem(LEGACY_GROUPS_KEY) || '[]');
        localStorage.removeItem(LEGACY_GROUPS_KEY);
        if (Array.isArray(g)) return g.filter((x) => x && typeof x.name === 'string' && Array.isArray(x.keys));
    } catch (_) { /* stockage indisponible */ }
    return [];
}

export class FixtureStore {
    constructor() {
        /** @type {object[]} triés par univers puis adresse */
        this.fixtures = [];
        /** @type {Map<string, object>} */
        this.byKey = new Map();
        /** @type {Set<string>} */
        this.selection = new Set();
        this.groups = [];
        this._saveGroupsCb = null;
        this.version = 0;          // liste ou sélection modifiée (rafraîchissement des vues)
        this._listeners = [];
    }

    onChange(cb) {
        this._listeners.push(cb);
    }

    _changed() {
        this.version++;
        for (const cb of this._listeners) {
            try { cb(); } catch (e) { console.error('[Régie] projecteurs', e); }
        }
    }

    setFixtures(list) {
        const fixtures = (Array.isArray(list) ? list : []).filter(f => f && f.kind && f.id !== undefined);
        fixtures.sort((a, b) => (a.universe - b.universe) || (a.address - b.address)
            || (KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)) || (a.number - b.number));
        this.fixtures = fixtures;
        this.byKey = new Map(fixtures.map(f => [fixtureKey(f), f]));
        for (const k of [...this.selection]) if (!this.byKey.has(k)) this.selection.delete(k);
        this._changed();
    }

    get(key) {
        return this.byKey.get(key) || null;
    }

    /** Projecteurs sélectionnés, dans l'ordre du patch */
    selected() {
        return this.fixtures.filter(f => this.selection.has(fixtureKey(f)));
    }

    /**
     * @param {string[]} keys
     * @param {'set'|'add'|'toggle'|'remove'} mode
     */
    select(keys, mode = 'set') {
        if (mode === 'set') this.selection.clear();
        for (const k of keys) {
            if (!this.byKey.has(k)) continue;
            if (mode === 'remove' || (mode === 'toggle' && this.selection.has(k))) this.selection.delete(k);
            else this.selection.add(k);
        }
        this._changed();
    }

    selectKind(kind, additive = false) {
        this.select(this.fixtures.filter(f => !kind || f.kind === kind).map(fixtureKey), additive ? 'add' : 'set');
    }

    clearSelection() {
        if (this.selection.size === 0) return;
        this.selection.clear();
        this._changed();
    }

    // ── Groupes ───────────────────────────────────────────────────────────
    /**
     * Branche les groupes du show courant (tableau modifié sur place)
     * @param {object[]} groups
     * @param {() => void} save appelé après chaque modification
     */
    bindGroups(groups, save) {
        this.groups = groups;
        this._saveGroupsCb = save;
        this._changed();
    }

    _saveGroups() {
        if (this._saveGroupsCb) this._saveGroupsCb();
    }

    /** Nouveau groupe à partir de la sélection (null si rien n'est sélectionné) */
    createGroup(name) {
        const keys = this.selected().map(fixtureKey);
        if (keys.length === 0) return null;
        const g = { id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name: name || `Groupe ${this.groups.length + 1}`, keys };
        this.groups.push(g);
        this._saveGroups();
        this._changed();
        return g;
    }

    /** Remplace le contenu d'un groupe par la sélection */
    updateGroup(id) {
        const g = this.groups.find(x => x.id === id);
        const keys = this.selected().map(fixtureKey);
        if (!g || keys.length === 0) return;
        g.keys = keys;
        this._saveGroups();
        this._changed();
    }

    renameGroup(id, name) {
        const g = this.groups.find(x => x.id === id);
        if (!g || !name) return;
        g.name = name;
        this._saveGroups();
        this._changed();
    }

    deleteGroup(id) {
        const i = this.groups.findIndex((x) => x.id === id);
        if (i >= 0) this.groups.splice(i, 1);
        this._saveGroups();
        this._changed();
    }

    /** Projecteurs d'un groupe encore présents dans la salle */
    groupKeys(g) {
        return g.keys.filter(k => this.byKey.has(k));
    }

    recallGroup(id, mode = 'set') {
        const g = this.groups.find(x => x.id === id);
        if (g) this.select(this.groupKeys(g), mode);
    }
}
