/**
 * PatternsView.js — vue « Patterns » de la régie : liste des patterns du show (lecture / arrêt),
 * éditeur du pattern choisi (règle des temps, pistes, tête de lecture) et réglages de la piste.
 *
 * Un pattern est une boucle de N temps ; ses pistes pilotent des attributs de groupes de
 * projecteurs (voir PatternEngine.js). Toute modification est sauvegardée dans le show.
 */

import { h, ICONS } from './dom.js';
import { PatternLane } from './PatternLane.js';
import { TrackInspector } from './TrackInspector.js';
import { attributesFor, attributeLabel, attributeType } from '../attributes.js';
import { newId } from '../ShowStore.js';
import { fixtureKey } from '../fixtureTypes.js';
import { kindTargetOptions, kindTargetKeys, targetName } from '../targets.js';
import { PATTERN_LIBRARY, LIBRARY_CATEGORIES, addToShow } from '../PatternLibrary.js';

const HEAD_W = 180; // largeur des en-têtes de piste (px)
const GRIDS = [['1', '1 temps'], ['0.5', '1/2 temps'], ['0.25', '1/4 temps'], ['0.125', '1/8 temps'], ['0', 'Libre']];

function defaultTrack(target, attr) {
    const tr = { id: newId('t'), target, attr, mode: 'wave', shape: 'sine', cycles: 1, low: 0, high: 1, width: 0.5, spread: 0, order: 'ltr', interp: 'linear', points: [], mute: false };
    if (attr === 'pan' || attr === 'tilt') { tr.low = 0.35; tr.high = 0.65; }
    if (attributeType(attr) === 'color') { tr.colorA = '#ff1a1a'; tr.colorB = '#1a3cff'; }
    if (attr === 'strobe') { tr.mode = 'points'; tr.points = [{ t: 0, v: 0 }]; }
    return tr;
}

export class PatternsView {
    /**
     * @param {object} o
     * @param {import('../FixtureStore.js').FixtureStore} o.store
     * @param {import('../ShowStore.js').ShowStore} o.shows
     * @param {import('../PatternEngine.js').PatternEngine} o.engine
     * @param {() => number} o.now        heure serveur (ms) : tête de lecture
     * @param {() => number} o.playTime   heure des trames envoyées (lancement calé sur le temps)
     * @param {object} o.prefs
     * @param {() => void} o.savePrefs
     */
    constructor({ store, shows, engine, now, playTime, prefs, savePrefs }) {
        this.store = store;
        this.shows = shows;
        this.engine = engine;
        this._now = now;
        this._playTime = playTime;
        this.prefs = prefs;
        this._savePrefs = savePrefs;
        this.patternId = prefs.patternId || null;
        this.trackId = null;
        this.lanes = [];
        this._listKey = '';
        this._editorKey = '';
        this._confirmDelete = { id: null, at: 0 };

        this.inspector = new TrackInspector({
            store, engine,
            onChange: (final) => { this._redrawLanes(); if (final) this.shows.touch(); },
            onDelete: (tr) => this._deleteTrack(tr),
        });

        this.$list = h('div', { class: 'pat-list' });
        const listPanel = h('div', { class: 'panel pat-list-panel' }, [
            h('div', { class: 'panel-head' }, [
                h('span', { class: 'title', text: 'Patterns' }),
                h('span', { class: 'grow' }),
                h('button', { class: 'btn', text: 'Bibliothèque', title: 'Patterns pré-programmés (valables dans toutes les salles)', onclick: (e) => { e.stopPropagation(); this._toggleLibrary(e.currentTarget); } }),
                h('button', { class: 'btn', text: 'Nouveau', title: 'Nouveau pattern (avec une piste d’intensité sur la sélection, s’il y en a une)', onclick: () => this._newPattern() }),
            ]),
            this.$list,
            h('div', { class: 'pat-list-foot' }, [
                h('button', { class: 'btn', text: 'Tout arrêter', onclick: () => this.engine.stopAll() }),
            ]),
        ]);

        this.$editor = h('div', { class: 'panel pat-editor' });
        this.el = h('div', { class: 'patterns' }, [listPanel, this.$editor, this.inspector.el]);

        this._ro = new ResizeObserver(() => this._resizeLanes());
    }

    get pattern() {
        const show = this.shows.show;
        if (!show) return null;
        return show.patterns.find((p) => p.id === this.patternId) || null;
    }

    // ── Liste ─────────────────────────────────────────────────────────────
    _renderList() {
        const show = this.shows.show;
        const pats = show ? show.patterns : [];
        const key = `${this.shows.version}|${this.engine.version}|${this.patternId}`;
        if (key === this._listKey) return;
        this._listKey = key;
        if (pats.length === 0) {
            this.$list.replaceChildren(h('div', { class: 'group-empty dim', text: 'Aucun pattern. « Nouveau » pour en créer un.' }));
            return;
        }
        this.$list.replaceChildren(...pats.map((p) => {
            const playing = this.engine.isPlaying(p.id);
            return h('div', { class: `pat-row${p.id === this.patternId ? ' sel' : ''}${playing ? ' playing' : ''}`, onclick: () => this.selectPattern(p.id) }, [
                h('button', {
                    class: `btn icon ${playing ? 'on' : 'ghost'}`, html: playing ? ICONS.stop : ICONS.play,
                    title: playing ? 'Arrêter' : 'Lancer', 'aria-label': playing ? 'Arrêter' : 'Lancer',
                    onclick: (e) => { e.stopPropagation(); this.engine.toggle(p.id, this._playTime()); },
                }),
                h('span', { class: 'name', text: p.name }),
                h('span', { class: 'count mono', text: `${p.length} t` }),
                h('button', { class: 'btn icon ghost hover', html: ICONS.copy, title: 'Dupliquer', 'aria-label': 'Dupliquer',
                    onclick: (e) => { e.stopPropagation(); this._duplicatePattern(p); } }),
                h('button', { class: 'btn icon ghost hover', html: ICONS.close, title: 'Supprimer (cliquer deux fois)', 'aria-label': 'Supprimer',
                    onclick: (e) => {
                        e.stopPropagation();
                        const now = performance.now();
                        if (this._confirmDelete.id === p.id && now - this._confirmDelete.at < 3000) {
                            this._deletePattern(p);
                            return;
                        }
                        this._confirmDelete = { id: p.id, at: now };
                        e.currentTarget.classList.add('confirm');
                        e.currentTarget.title = 'Cliquer encore pour supprimer';
                    } }),
            ]);
        }));
    }

    selectPattern(id) {
        this.patternId = id;
        this.prefs.patternId = id;
        this._savePrefs();
        this.trackId = null;
        this.inspector.setTrack(null);
        this._editorKey = '';
    }

    _newPattern() {
        const show = this.shows.show;
        if (!show) return;
        const p = { id: newId('p'), name: `Pattern ${show.patterns.length + 1}`, length: 16, tracks: [] };
        const sel = this.store.selected();
        if (sel.length) p.tracks.push(defaultTrack({ keys: sel.map(fixtureKey) }, 'dimmer'));
        show.patterns.push(p);
        this.shows.touch();
        this.selectPattern(p.id);
        if (p.tracks.length) this._selectTrack(p.tracks[0].id);
    }

    // ── Éditeur ───────────────────────────────────────────────────────────
    _renderEditor() {
        const p = this.pattern;
        const key = `${p ? p.id : ''}|${p ? p.tracks.map((t) => t.id).join(',') : ''}|${this.store.groups.length}|${this.store.selection.size}|${this.shows.show ? this.shows.show.id : ''}`;
        if (key === this._editorKey) return;
        this._editorKey = key;
        this._ro.disconnect();
        this.lanes = [];
        if (!p) {
            this.$editor.replaceChildren(h('div', { class: 'pat-empty dim', text: this.shows.show ? 'Choisis un pattern dans la liste, ou crée-en un.' : 'Chargement du show…' }));
            return;
        }

        const name = h('input', { class: 'field pat-name', value: p.name, maxlength: '60', spellcheck: 'false' });
        name.addEventListener('change', () => { p.name = name.value.trim() || p.name; this.shows.touch(); this._listKey = ''; });
        name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); e.stopPropagation(); });
        const len = h('input', { class: 'field num', type: 'number', min: '1', max: '256', step: '1', value: String(p.length), title: 'Longueur de la boucle, en temps' });
        len.addEventListener('change', () => {
            const v = Math.max(1, Math.min(256, Math.round(Number(len.value) || p.length)));
            len.value = String(v);
            p.length = v;
            this.shows.touch();
            this._listKey = '';
            this._drawRuler();
            this._redrawLanes();
        });
        const grid = h('select', { class: 'field', title: 'Grille des points' }, GRIDS.map(([v, l]) => h('option', { value: v, text: l })));
        grid.value = String(this.prefs.grid ?? 0.25);
        grid.addEventListener('change', () => { this.prefs.grid = Number(grid.value); this._savePrefs(); this._redrawLanes(); });
        this.$play = h('button', { class: 'btn', text: 'Lancer', title: 'Lancer / arrêter (Espace)', onclick: () => this.engine.toggle(p.id, this._playTime()) });

        this.$ruler = h('canvas', { class: 'ruler-canvas' });
        this.$playhead = h('div', { class: 'playhead' });
        this.$lanes = h('div', { class: 'lanes' });
        const lanesWrap = h('div', { class: 'lanes-wrap' }, [
            h('div', { class: 'lane-row ruler' }, [h('div', { class: 'lane-head dim', text: 'Temps' }), this.$ruler]),
            this.$lanes,
            this.$playhead,
        ]);

        for (const tr of p.tracks) this._addLaneRow(p, tr);
        if (p.tracks.length === 0) {
            this.$lanes.appendChild(h('div', { class: 'pat-empty dim', text: 'Ajoute une piste : choisis une cible et un attribut ci-dessous.' }));
        }

        this.$editor.replaceChildren(
            h('div', { class: 'panel-head' }, [
                name,
                h('span', { class: 'dim', text: 'Longueur' }), len, h('span', { class: 'dim', text: 'temps' }),
                h('span', { class: 'dim', text: 'Grille' }), grid,
                h('span', { class: 'grow' }),
                this.$play,
            ]),
            lanesWrap,
            this._buildAddBar(p),
        );
        this._ro.observe(lanesWrap);
        requestAnimationFrame(() => this._resizeLanes());
    }

    _addLaneRow(p, tr) {
        const lane = new PatternLane({
            pattern: () => p,
            track: tr,
            snap: () => Number(this.prefs.grid ?? 0.25),
            pointColor: () => this.inspector.newPointColor,
            onSelectPoint: (pt) => {
                if (this.trackId !== tr.id) this._selectTrack(tr.id);
                this.inspector.setPoint(pt);
            },
            onEdit: () => this.shows.touch(),
        });
        const fixtures = this.engine.targetsOf(tr);
        const tName = targetName(this.store, tr.target, fixtures.length);
        const head = h('div', { class: 'lane-head', onclick: () => this._selectTrack(tr.id) }, [
            h('div', { class: 'lane-title', text: attributeLabel(tr.attr) }),
            h('div', { class: 'lane-sub dim', text: `${tName} · ${tr.mode === 'wave' ? 'générateur' : 'points'}${tr.mute ? ' · muette' : ''}` }),
        ]);
        const rowEl = h('div', { class: `lane-row${tr.id === this.trackId ? ' sel' : ''}`, 'data-id': tr.id }, [head, lane.canvas]);
        lane.canvas.addEventListener('pointerdown', () => { if (this.trackId !== tr.id) this._selectTrack(tr.id); });
        lane.row = rowEl;
        lane.head = head;
        this.lanes.push(lane);
        this.$lanes.appendChild(rowEl);
    }

    _buildAddBar(p) {
        const store = this.store;
        const targetSel = h('select', { class: 'field', title: 'Cible de la nouvelle piste' });
        const attrSel = h('select', { class: 'field', title: 'Attribut piloté' });
        const fillTargets = () => {
            const opts = [...store.groups.map((g) => [`g:${g.id}`, `${g.name} (${store.groupKeys(g).length})`]), ...kindTargetOptions(store)];
            if (store.selection.size) opts.unshift(['sel', `Sélection actuelle (${store.selection.size})`]);
            targetSel.replaceChildren(...opts.map(([v, l]) => h('option', { value: v, text: l })));
            fillAttrs();
        };
        const targetFixtures = () => {
            const v = targetSel.value;
            if (v === 'sel') return store.selected();
            if (v.startsWith('k:')) return kindTargetKeys(store, v.slice(2)).map((k) => store.get(k)).filter(Boolean);
            const g = store.groups.find((x) => `g:${x.id}` === v);
            return g ? store.groupKeys(g).map((k) => store.get(k)).filter(Boolean) : [];
        };
        const fillAttrs = () => {
            const attrs = attributesFor(targetFixtures());
            attrSel.replaceChildren(...attrs.map((a) => h('option', { value: a.id, text: a.label })));
        };
        targetSel.addEventListener('change', fillAttrs);
        fillTargets();
        const add = h('button', { class: 'btn', text: 'Ajouter la piste', onclick: () => {
            const v = targetSel.value;
            if (!v || !attrSel.value) return;
            const target = v === 'sel' ? { keys: store.selected().map(fixtureKey) } : v.startsWith('k:') ? { kind: v.slice(2) } : { group: v.slice(2) };
            const tr = defaultTrack(target, attrSel.value);
            p.tracks.push(tr);
            this.shows.touch();
            this.trackId = tr.id;
            this._editorKey = '';
            this.inspector.setTrack(tr);
        } });
        return h('div', { class: 'pat-add' }, [h('span', { class: 'dim', text: 'Nouvelle piste' }), targetSel, attrSel, add]);
    }

    _selectTrack(id) {
        this.trackId = id;
        const p = this.pattern;
        const tr = p ? p.tracks.find((t) => t.id === id) : null;
        for (const lane of this.lanes) {
            lane.row.classList.toggle('sel', lane.track.id === id);
            if (lane.track.id !== id && lane.selectedPoint) { lane.selectedPoint = null; lane.draw(); }
        }
        this.inspector.setTrack(tr || null);
    }

    _deleteTrack(tr) {
        const p = this.pattern;
        if (!p) return;
        const i = p.tracks.indexOf(tr);
        if (i >= 0) p.tracks.splice(i, 1);
        this.trackId = null;
        this.inspector.setTrack(null);
        this.shows.touch();
        this._editorKey = '';
    }

    _deletePattern(p) {
        const show = this.shows.show;
        this.engine.stop(p.id);
        const i = show.patterns.indexOf(p);
        if (i >= 0) show.patterns.splice(i, 1);
        this.shows.touch();
        this.selectPattern(show.patterns[Math.max(0, i - 1)]?.id || null);
    }

    _duplicatePattern(p) {
        const show = this.shows.show;
        const copy = JSON.parse(JSON.stringify(p));
        copy.id = newId('p');
        copy.name = `${p.name} (copie)`;
        for (const t of copy.tracks) t.id = newId('t');
        show.patterns.splice(show.patterns.indexOf(p) + 1, 0, copy);
        this.shows.touch();
        this.selectPattern(copy.id);
    }

    // ── Dessin ────────────────────────────────────────────────────────────
    _resizeLanes() {
        if (!this.$ruler || !this.$ruler.isConnected) return;
        this._drawRuler();
        for (const lane of this.lanes) lane.resize();
    }

    _redrawLanes() {
        for (const lane of this.lanes) lane.draw();
        // En-têtes (mode, muette) et inspecteur suivent
        const p = this.pattern;
        if (!p) return;
        for (const lane of this.lanes) {
            const sub = lane.head.querySelector('.lane-sub');
            const tr = lane.track;
            const fixtures = this.engine.targetsOf(tr);
            const tName = targetName(this.store, tr.target, fixtures.length);
            lane.head.querySelector('.lane-title').textContent = attributeLabel(tr.attr);
            sub.textContent = `${tName} · ${tr.mode === 'wave' ? 'générateur' : 'points'}${tr.mute ? ' · muette' : ''}`;
        }
    }

    _drawRuler() {
        const c = this.$ruler;
        const p = this.pattern;
        if (!c || !p) return;
        const r = c.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(r.width));
        const hgt = Math.max(1, Math.round(r.height));
        c.width = w * dpr;
        c.height = hgt * dpr;
        const g = c.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.fillStyle = '#151515';
        g.fillRect(0, 0, w, hgt);
        const L = p.length;
        const step = w / L < 18 ? (w / L < 6 ? 4 : 2) : 1; // numéros espacés si la boucle est longue
        g.font = '10px "Cascadia Mono", Consolas, monospace';
        g.textBaseline = 'middle';
        for (let b = 0; b < L; b++) {
            const x = Math.round((b / L) * w) + 0.5;
            const bar = b % 4 === 0;
            g.strokeStyle = bar ? '#3a3a3a' : '#262626';
            g.beginPath(); g.moveTo(x, bar ? 0 : hgt / 2); g.lineTo(x, hgt); g.stroke();
            if (b % step === 0) {
                g.fillStyle = bar ? '#b0b0b0' : '#6a6a6a';
                g.fillText(String(b + 1), x + 3, hgt / 2);
            }
        }
    }

    frame() {
        this._renderList();
        this._renderEditor();
        const p = this.pattern;
        if (!p || !this.$playhead) return;
        const playing = this.engine.isPlaying(p.id);
        if (this.$play) {
            this.$play.textContent = playing ? 'Arrêter' : 'Lancer';
            this.$play.classList.toggle('on', playing);
        }
        const b = playing ? this.engine.localBeat(p, this._now()) : null;
        if (b === null || !this.$ruler.isConnected) {
            this.$playhead.style.display = 'none';
            return;
        }
        const w = this.$ruler.getBoundingClientRect().width;
        this.$playhead.style.display = '';
        this.$playhead.style.left = `${HEAD_W + (b / p.length) * w}px`;
    }

    // ── Bibliothèque de patterns pré-programmés ───────────────────────────
    _toggleLibrary(anchor) {
        if (this.$lib) { this._closeLibrary(); return; }
        const show = this.shows.show;
        if (!show) return;
        const menu = h('div', { class: 'menu lib-menu', onclick: (e) => e.stopPropagation() });
        const r = anchor.getBoundingClientRect();
        menu.style.left = `${Math.round(r.left)}px`;
        menu.style.top = `${Math.round(r.bottom + 4)}px`;
        document.body.appendChild(menu);
        this.$lib = menu;
        this._onLibDoc = () => this._closeLibrary();
        setTimeout(() => document.addEventListener('click', this._onLibDoc), 0);
        this._renderLibrary();
    }

    _closeLibrary() {
        if (!this.$lib) return;
        this.$lib.remove();
        this.$lib = null;
        document.removeEventListener('click', this._onLibDoc);
    }

    _renderLibrary() {
        const show = this.shows.show;
        if (!this.$lib || !show) return;
        const inShow = new Set(show.patterns.map((p) => p.lib).filter(Boolean));
        const add = (def) => {
            const p = addToShow(show, def);
            this.shows.touch();
            this.selectPattern(p.id);
            this._renderLibrary();
        };
        const sections = [];
        for (const [cat, label] of LIBRARY_CATEGORIES) {
            const defs = PATTERN_LIBRARY.filter((d) => d.category === cat);
            sections.push(h('div', { class: 'lib-cat dim', text: label }));
            for (const def of defs) {
                const has = inShow.has(def.id);
                sections.push(h('div', { class: `menu-row${has ? ' sel' : ''}`, title: has ? 'Déjà dans le show : cliquer pour l’ouvrir' : 'Ajouter au show', onclick: () => add(def) }, [
                    h('span', { class: 'name', text: def.name }),
                    h('span', { class: 'count mono', text: has ? 'ajouté' : `${def.length} t` }),
                ]));
            }
        }
        const missing = PATTERN_LIBRARY.filter((d) => !inShow.has(d.id));
        this.$lib.replaceChildren(
            h('div', { class: 'menu-title dim', text: `Bibliothèque · ${PATTERN_LIBRARY.length} patterns (toutes les salles)` }),
            h('div', { class: 'menu-list lib-list' }, sections),
            h('div', { class: 'menu-actions' }, [
                h('button', { class: 'btn', text: missing.length ? `Tout ajouter (${missing.length})` : 'Tout est ajouté', disabled: !missing.length, onclick: () => {
                    for (const def of missing) addToShow(show, def);
                    this.shows.touch();
                    this._renderLibrary();
                } }),
            ]),
        );
    }

    dispose() {
        this._ro.disconnect();
        this._closeLibrary();
    }
}
