/**
 * SpotProgrammer.js
 * ─────────────────────────────────────────────────────────────
 * « Programmeur » de la console des lyres (logique pure, sans interface) :
 *   - sélection (simple, ajout, bascule, plage, tout / aucun / inverser / pairs / impairs…)
 *   - groupes G1…G8 mémorisés localement (propres à chaque joueur)
 *   - application d'un réglage à toute la sélection, EN UN SEUL message réseau
 *   - visée : calcul du pan / tilt de chaque lyre pour pointer un point 3D
 *     (tient compte de la position, de l'orientation, du montage et des inversions,
 *     et choisit la solution la plus proche de la position actuelle)
 *   - ordres spatiaux (gauche → droite vu du joueur, centre → extérieur…)
 *   - dégradé de couleurs, éventail
 * Les lyres « pilotées par le DMX » sont ignorées (la console DMX a la priorité).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { TILT_PIVOT_Y } from '../SpotHousing.js';
import { PAN_RANGE, TILT_RANGE } from '../config/spotParams.js';

const GROUPS_KEY = 'soundstage3d:spot-groups';
export const GROUP_COUNT = 8;
const DEG = 180 / Math.PI;

const _inv = new THREE.Matrix4();
const _local = new THREE.Vector3();
const _right = new THREE.Vector3();
const _center = new THREE.Vector3();

export class SpotProgrammer {
    /**
     * @param {object} o
     * @param {import('../SpotManager.js').SpotManager} o.spotManager
     * @param {import('../../ui/AmbiancePanel.js').AmbiancePanel} o.ambiancePanel
     * @param {THREE.Camera} o.camera
     */
    constructor({ spotManager, ambiancePanel, camera }) {
        this.spotManager = spotManager;
        this.ambiancePanel = ambiancePanel;
        this.camera = camera;
        this.selection = new Set();
        this._order = [];        // ordre de sélection
        this._anchor = null;     // dernière lyre cliquée (sélection de plage)
        this._listeners = [];
        this.groups = this._loadGroups();
    }

    // ── Écouteurs ─────────────────────────────────────────────────────────
    onChange(cb) {
        this._listeners.push(cb);
    }

    _changed() {
        for (const cb of this._listeners) {
            try { cb(); } catch (e) { console.error('[SpotProgrammer]', e); }
        }
    }

    // ── Lyres ─────────────────────────────────────────────────────────────
    /** Toutes les lyres, triées par numéro */
    allSpots() {
        return this.spotManager.getAllSpots().sort((a, b) => a.number - b.number);
    }

    /** Lyres sélectionnées (triées par numéro), en retirant celles qui ont disparu */
    selected() {
        const out = [];
        for (const id of this.selection) {
            const s = this.spotManager.getSpot(id);
            if (s) out.push(s);
        }
        if (out.length !== this.selection.size) {
            this.selection = new Set(out.map(s => s.id));
            this._order = this._order.filter(id => this.selection.has(id));
        }
        return out.sort((a, b) => a.number - b.number);
    }

    /** Lyres de la sélection réellement modifiables (hors pilotage DMX) */
    editable() {
        return this.selected().filter(s => !s.dmxControlled);
    }

    // ── Sélection ─────────────────────────────────────────────────────────
    /**
     * @param {string[]} ids
     * @param {'set'|'add'|'toggle'|'remove'} mode
     */
    select(ids, mode = 'set') {
        if (mode === 'set') {
            this.selection.clear();
            this._order = [];
        }
        for (const id of ids) {
            const has = this.selection.has(id);
            if (mode === 'remove' || (mode === 'toggle' && has)) {
                this.selection.delete(id);
                this._order = this._order.filter(x => x !== id);
            } else if (!has) {
                this.selection.add(id);
                this._order.push(id);
            }
        }
        if (ids.length) this._anchor = ids[ids.length - 1];
        this._changed();
    }

    /** Sélection de plage (Maj + clic) depuis la dernière lyre cliquée */
    selectRange(id) {
        const all = this.allSpots().map(s => s.id);
        const a = all.indexOf(this._anchor);
        const b = all.indexOf(id);
        if (a < 0 || b < 0) return this.select([id], 'set');
        const [lo, hi] = a < b ? [a, b] : [b, a];
        this.select(all.slice(lo, hi + 1), 'add');
    }

    selectAll() { this.select(this.allSpots().map(s => s.id), 'set'); }
    clear() { this.select([], 'set'); }

    invert() {
        this.select(this.allSpots().filter(s => !this.selection.has(s.id)).map(s => s.id), 'set');
    }

    /** Pairs / impairs selon le numéro d'affichage */
    selectParity(odd) {
        this.select(this.allSpots().filter(s => (s.number % 2 === 1) === odd).map(s => s.id), 'set');
    }

    selectMount(hung) {
        this.select(this.allSpots().filter(s => (s.params.mount === 'Suspendu') === hung).map(s => s.id), 'set');
    }

    // ── Groupes (locaux) ──────────────────────────────────────────────────
    _loadGroups() {
        try {
            const raw = JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]');
            return Array.from({ length: GROUP_COUNT }, (_, i) => (Array.isArray(raw[i]) ? raw[i] : null));
        } catch (_) {
            return Array.from({ length: GROUP_COUNT }, () => null);
        }
    }

    _saveGroups() {
        try { localStorage.setItem(GROUPS_KEY, JSON.stringify(this.groups)); } catch (_) {}
    }

    storeGroup(i) {
        this.groups[i] = this._order.length ? this._order.slice() : null;
        this._saveGroups();
        this._changed();
    }

    recallGroup(i) {
        const g = this.groups[i];
        if (!g) return false;
        this.select(g.filter(id => this.spotManager.getSpot(id)), 'set');
        return true;
    }

    groupSize(i) {
        const g = this.groups[i];
        return g ? g.filter(id => this.spotManager.getSpot(id)).length : 0;
    }

    // ── Application des réglages ──────────────────────────────────────────
    /**
     * Applique des changements à toutes les lyres modifiables de la sélection.
     * @param {object|((spot, index, count) => object|null)} changes
     * @param {object} [opts] { continuous: true → envoi réseau limité en fréquence ; spots: liste imposée }
     */
    apply(changes, opts = {}) {
        const spots = opts.spots || this.editable();
        if (!spots.length) return;
        const data = {};
        spots.forEach((s, i) => {
            const c = typeof changes === 'function' ? changes(s, i, spots.length) : changes;
            if (!c) return;
            s.setParams(c);
            data[s.id] = c;
        });
        const ids = Object.keys(data);
        if (!ids.length) return;
        const first = data[ids[0]];
        this._emit({
            category: 'spot_multi',
            data,
            // Clé de limitation réseau : même action continue = même clé
            throttleKey: 'spot_multi_' + Object.keys(first).sort().join('_') + '_' + ids.length,
            immediate: !opts.continuous,
        });
        const insp = this.ambiancePanel && this.ambiancePanel._spotInspectorPanel;
        if (insp && insp.isOpen && data[insp.currentSpotId]) insp.syncFromSpot();
    }

    _emit(payload) {
        if (this.ambiancePanel && typeof this.ambiancePanel._emitSync === 'function') {
            this.ambiancePanel._emitSync(payload);
        }
    }

    // ── Ordres spatiaux ───────────────────────────────────────────────────
    /**
     * Ordonne des lyres pour un effet / dégradé / éventail.
     * « Gauche / droite » est évalué du point de vue du joueur local au moment de l'action,
     * puis la liste obtenue est figée (identique pour tous les joueurs).
     */
    ordered(spots, order) {
        const list = spots.slice();
        this.camera.updateMatrixWorld();
        _right.setFromMatrixColumn(this.camera.matrixWorld, 0);
        const side = s => s.group.position.dot(_right);
        _center.set(0, 0, 0);
        for (const s of list) _center.add(s.group.position);
        if (list.length) _center.multiplyScalar(1 / list.length);
        const fromCenter = s => Math.abs(s.group.position.dot(_right) - _center.dot(_right));
        switch (order) {
            case 'Droite → gauche': return list.sort((a, b) => side(b) - side(a));
            case 'Centre → extérieur': return list.sort((a, b) => fromCenter(a) - fromCenter(b));
            case 'Extérieur → centre': return list.sort((a, b) => fromCenter(b) - fromCenter(a));
            case 'Ordre de sélection': {
                const rank = new Map(this._order.map((id, i) => [id, i]));
                return list.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
            }
            case 'Aléatoire': {
                for (let i = list.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [list[i], list[j]] = [list[j], list[i]];
                }
                return list;
            }
            default: return list.sort((a, b) => side(a) - side(b));
        }
    }

    // ── Visée ─────────────────────────────────────────────────────────────
    /**
     * Pan / tilt (valeurs de paramètres) pour que la lyre pointe vers `target`.
     * @returns {{ pan: number, tilt: number }}
     */
    solveAim(spot, target) {
        spot.group.updateMatrixWorld(true);
        _inv.copy(spot.mountNode.matrixWorld).invert();
        _local.copy(target).applyMatrix4(_inv);
        _local.y -= TILT_PIVOT_Y;
        const len = _local.length();
        if (len < 1e-4) return { pan: spot.params.pan, tilt: spot.params.tilt };
        _local.multiplyScalar(1 / len);

        // axe = (sin t · sin p, cos t, sin t · cos p)  →  t = acos(y), p = atan2(x, z)
        const t = Math.acos(Math.max(-1, Math.min(1, _local.y))) * DEG;
        const nearAxis = Math.hypot(_local.x, _local.z) < 1e-3;
        const sp = spot.params.invertPan ? -1 : 1;
        const st = spot.params.invertTilt ? -1 : 1;
        const curPan = sp * spot.params.pan;
        const curTilt = st * spot.params.tilt;
        const p = nearAxis ? curPan : Math.atan2(_local.x, _local.z) * DEG;

        // Solutions équivalentes : (p, t) et (p + 180°, −t), à ±360° près sur le pan
        let best = null;
        const halfPan = PAN_RANGE / 2, halfTilt = TILT_RANGE / 2;
        for (const [bp, bt] of [[p, t], [p + 180, -t]]) {
            for (const k of [-720, -360, 0, 360, 720]) {
                const pan = bp + k;
                if (pan < -halfPan || pan > halfPan) continue;
                const tilt = Math.max(-halfTilt, Math.min(halfTilt, bt));
                const cost = Math.abs(pan - curPan) + 1.5 * Math.abs(tilt - curTilt) + 400 * Math.abs(tilt - bt);
                if (!best || cost < best.cost) best = { pan, tilt, cost };
            }
        }
        if (!best) return { pan: spot.params.pan, tilt: spot.params.tilt };
        return { pan: Math.round(sp * best.pan * 10) / 10, tilt: Math.round(st * best.tilt * 10) / 10 };
    }

    /** Toute la sélection vise un point (ou un point par lyre si `target` est une fonction) */
    aimAt(target, opts = {}) {
        this.apply(s => this.solveAim(s, typeof target === 'function' ? target(s) : target), opts);
    }

    // ── Couleurs ──────────────────────────────────────────────────────────
    gradient(hexA, hexB, order = 'Gauche → droite') {
        const spots = this.ordered(this.editable(), order);
        const a = new THREE.Color(hexA), b = new THREE.Color(hexB), c = new THREE.Color();
        this.apply((s, i, n) => {
            c.copy(a).lerp(b, n > 1 ? i / (n - 1) : 0);
            return { color: '#' + c.getHexString(), colorWheel: 'Ouvert (blanc)', rainbow: 0 };
        }, { spots });
    }
}
