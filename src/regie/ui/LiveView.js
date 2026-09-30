/**
 * LiveView.js — mode Live : grille de pads, une rangée par couche, une colonne par scène.
 *
 * Jeu :
 *   - clic sur un pad = le lancer (tout de suite, au prochain temps ou à la prochaine mesure,
 *     avec le fondu choisi) ; un seul pad joue par rangée ; nouveau clic = l'arrêter ;
 *   - pad « flash » : joue tant qu'il est enfoncé, par-dessus la rangée ;
 *   - ▶ de colonne (ou touches 1 à 8) = lancer la scène (les rangées dont le pad est vide s'arrêtent) ;
 *   - ■ de rangée = arrêter la rangée ; niveau de rangée = intensité de ses projecteurs.
 * Édition : glisser un pattern de la liste sur un pad, ou clic sur un pad puis réglages à droite.
 */

import { h, ICONS } from './dom.js';
import { newId } from '../ShowStore.js';

const QUANT = [[0, 'Immédiat'], [1, 'Temps'], [4, 'Mesure']];
const FADES = [[0, '0 s'], [0.5, '0,5 s'], [1, '1 s'], [2, '2 s'], [4, '4 s']];
const SPEEDS = [[0.5, '×½'], [1, '×1'], [2, '×2']];

function seg(options, value, onchange) {
    const wrap = h('span', { class: 'seg' });
    const btns = options.map(([v, label]) => {
        const b = h('button', { text: label, onclick: () => onchange(v) });
        wrap.appendChild(b);
        return [v, b];
    });
    wrap.setValue = (val) => { for (const [v, b] of btns) b.classList.toggle('on', v === val); };
    wrap.setValue(value);
    return wrap;
}

export class LiveView {
    /**
     * @param {object} o
     * @param {import('../ShowStore.js').ShowStore} o.shows
     * @param {import('../PatternEngine.js').PatternEngine} o.engine
     * @param {import('../TempoClock.js').TempoClock} o.tempo
     * @param {() => number} o.now        heure serveur (ms) : état affiché
     * @param {() => number} o.playTime   heure des trames envoyées (lancements)
     */
    constructor({ shows, engine, tempo, now, playTime }) {
        this.shows = shows;
        this.engine = engine;
        this.tempo = tempo;
        this._now = now;
        this._playTime = playTime;
        this.editing = false;
        this.sel = null;          // pad sélectionné en édition : { rowId, col }
        this._key = '';
        this._pads = [];          // { el, prog, row, col, key }

        this.$quant = seg(QUANT, 4, (v) => { this.live.quantize = v; this.$quant.setValue(v); this.shows.touch(); });
        this.$fade = h('select', { class: 'field', title: 'Fondu entre les pads d’une rangée' }, FADES.map(([v, l]) => h('option', { value: String(v), text: l })));
        this.$fade.addEventListener('change', () => { this.live.fade = Number(this.$fade.value); this.shows.touch(); });
        this.$speed = seg(SPEEDS, 1, (v) => {
            this.live.speed = v;
            this.engine.setSpeed(v, this._playTime());
            this.$speed.setValue(v);
            this.shows.touch();
        });
        this.$edit = h('button', { class: 'btn', text: 'Édition', title: 'Placer les patterns sur les pads', onclick: () => { this.editing = !this.editing; this.sel = null; this._key = ''; } });
        this.$body = h('div', { class: 'live-body' });
        this.el = h('div', { class: 'live' }, [
            h('div', { class: 'panel-head' }, [
                h('span', { class: 'dim', text: 'Lancement' }), this.$quant,
                h('span', { class: 'dim', text: 'Fondu' }), this.$fade,
                h('span', { class: 'dim', text: 'Vitesse' }), this.$speed,
                h('span', { class: 'grow' }),
                this.$edit,
                h('button', { class: 'btn', text: 'Tout arrêter', onclick: () => this.engine.stopAll() }),
            ]),
            this.$body,
        ]);
    }

    get live() {
        return this.shows.show ? this.shows.show.live : null;
    }

    _pattern(id) {
        const show = this.shows.show;
        return show && id ? show.patterns.find((p) => p.id === id) || null : null;
    }

    padKey(row, col) {
        return `pad:${row.id}:${col}`;
    }

    // ── Jeu ───────────────────────────────────────────────────────────────
    _opts(row) {
        const live = this.live;
        return {
            quantize: live.quantize,
            fade: (live.fade * this.tempo.effectiveBpm()) / 60,
            row: row.id,
            level: () => row.level,
        };
    }

    toggle(row, col) {
        const pad = row.pads[col];
        if (!pad || !this._pattern(pad.pattern)) return;
        const key = this.padKey(row, col);
        const t = this._playTime();
        const st = this.engine.state(key, t);
        const o = this._opts(row);
        if (st === 'playing' || st === 'pending') this.engine.stop(key, t, { quantize: o.quantize, fade: o.fade });
        else this.engine.play(key, t, { pattern: pad.pattern, ...o });
    }

    _flash(row, col, on) {
        const pad = row.pads[col];
        if (!pad || !this._pattern(pad.pattern)) return;
        const key = this.padKey(row, col);
        if (on) this.engine.play(key, this._playTime(), { pattern: pad.pattern, quantize: 0, fade: 0, level: () => row.level });
        else this.engine.stop(key);
    }

    launchScene(col) {
        const live = this.live;
        const t = this._playTime();
        for (const row of live.rows) {
            const pad = row.pads[col];
            const o = this._opts(row);
            if (pad && this._pattern(pad.pattern) && pad.mode !== 'flash') {
                const key = this.padKey(row, col);
                if (!this.engine.isPlaying(key)) this.engine.play(key, t, { pattern: pad.pattern, ...o });
            } else {
                this.engine.stopRow(row.id, t, { quantize: o.quantize, fade: o.fade });
            }
        }
    }

    stopRow(row) {
        const o = this._opts(row);
        this.engine.stopRow(row.id, this._playTime(), { quantize: o.quantize, fade: o.fade });
    }

    // ── Édition ───────────────────────────────────────────────────────────
    _assign(row, col, patternId) {
        row.pads[col] = patternId ? { pattern: patternId, mode: (row.pads[col] && row.pads[col].mode) || 'toggle' } : null;
        this.engine.stop(this.padKey(row, col));
        this.shows.touch();
        this._key = '';
    }

    _addRow() {
        const live = this.live;
        live.rows.push({ id: newId('r'), name: `Rangée ${live.rows.length + 1}`, level: 1, pads: new Array(live.cols).fill(null) });
        this.shows.touch();
        this._key = '';
    }

    _deleteRow(row) {
        const live = this.live;
        this.engine.stopRow(row.id);
        live.rows.splice(live.rows.indexOf(row), 1);
        if (this.sel && this.sel.rowId === row.id) this.sel = null;
        this.shows.touch();
        this._key = '';
    }

    // ── Construction ──────────────────────────────────────────────────────
    _structureKey() {
        const show = this.shows.show;
        const live = this.live;
        if (!show || !live) return 'none';
        const pats = show.patterns.map((p) => `${p.id}=${p.name}/${p.length}`).join(',');
        const rows = live.rows.map((r) => `${r.id}:${r.name}:${r.pads.map((p) => (p ? `${p.pattern}/${p.mode}` : '-')).join('.')}`).join('|');
        return `${show.id}|${live.cols}|${this.editing}|${this.sel ? `${this.sel.rowId}:${this.sel.col}` : ''}|${pats}|${rows}`;
    }

    _render() {
        const show = this.shows.show;
        const live = this.live;
        this._pads = [];
        if (!show || !live) {
            this.$body.replaceChildren(h('div', { class: 'pat-empty dim', text: 'Chargement du show…' }));
            return;
        }
        this.$quant.setValue(live.quantize);
        this.$fade.value = String(live.fade);
        this.$speed.setValue(live.speed);
        this.$edit.classList.toggle('on', this.editing);

        const cols = live.cols;
        const grid = h('div', { class: 'live-grid', style: `grid-template-columns: 170px repeat(${cols}, minmax(86px, 1fr))` });
        // Colonnes : lancement des scènes
        grid.appendChild(h('div', { class: 'live-corner dim', text: 'Scènes' }));
        for (let c = 0; c < cols; c++) {
            grid.appendChild(h('button', { class: 'btn scene', title: `Lancer la scène ${c + 1} (touche ${c + 1}) : les rangées dont le pad est vide s’arrêtent`, onclick: () => this.launchScene(c) }, [
                h('span', { class: 'scene-icon', html: ICONS.play }), h('span', { text: String(c + 1) }),
            ]));
        }
        for (const row of live.rows) {
            grid.appendChild(this._rowHead(row));
            for (let c = 0; c < cols; c++) grid.appendChild(this._pad(row, c));
        }
        const parts = [];
        if (this.editing) parts.push(this._patternShelf(show));
        parts.push(h('div', { class: 'live-grid-wrap' }, [
            grid,
            this.editing ? h('button', { class: 'btn live-add', text: 'Ajouter une rangée', onclick: () => this._addRow() }) : null,
        ]));
        if (this.editing) parts.push(this._padInspector(show, live));
        this.$body.className = `live-body${this.editing ? ' editing' : ''}`;
        this.$body.replaceChildren(...parts);
    }

    _rowHead(row) {
        if (this.editing) {
            const name = h('input', { class: 'field', value: row.name, maxlength: '30', spellcheck: 'false' });
            name.addEventListener('change', () => { row.name = name.value.trim() || row.name; this.shows.touch(); });
            name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
            return h('div', { class: 'live-row-head' }, [
                name,
                h('button', { class: 'btn icon ghost', html: ICONS.close, title: 'Supprimer la rangée', 'aria-label': 'Supprimer la rangée', onclick: () => this._deleteRow(row) }),
            ]);
        }
        const value = h('span', { class: 'mono range-value', text: `${Math.round(row.level * 100)} %` });
        const level = h('input', { class: 'range', type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(row.level * 100)), title: 'Niveau de la rangée (intensité)' });
        level.addEventListener('input', () => { row.level = Number(level.value) / 100; value.textContent = `${level.value} %`; });
        level.addEventListener('change', () => this.shows.touch());
        return h('div', { class: 'live-row-head' }, [
            h('div', { class: 'live-row-name' }, [
                h('span', { class: 'name', text: row.name }),
                h('button', { class: 'btn icon ghost', html: ICONS.stop, title: 'Arrêter la rangée', 'aria-label': 'Arrêter la rangée', onclick: () => this.stopRow(row) }),
            ]),
            h('div', { class: 'group' }, [level, value]),
        ]);
    }

    _pad(row, col) {
        const pad = row.pads[col];
        const pat = pad ? this._pattern(pad.pattern) : null;
        const key = this.padKey(row, col);
        const selected = this.sel && this.sel.rowId === row.id && this.sel.col === col;
        const prog = h('div', { class: 'pad-prog' });
        const el = h('div', {
            class: `pad${pat ? '' : ' empty'}${selected ? ' sel' : ''}${pad && pad.mode === 'flash' ? ' flash' : ''}`,
            title: pat ? `${pat.name} · ${pat.length} temps${pad.mode === 'flash' ? ' · flash (maintenir)' : ''}` : (this.editing ? 'Glisser un pattern ici' : ''),
        }, [
            h('span', { class: 'pad-name', text: pat ? pat.name : (pad ? 'Pattern supprimé' : '') }),
            h('span', { class: 'pad-meta mono', text: pat ? `${pat.length} t${pad.mode === 'flash' ? ' · flash' : ''}` : '' }),
            prog,
        ]);
        if (this.editing) {
            el.addEventListener('click', () => { this.sel = { rowId: row.id, col }; this._key = ''; });
            el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop'); });
            el.addEventListener('dragleave', () => el.classList.remove('drop'));
            el.addEventListener('drop', (e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData('text/x-pattern');
                if (id) { this._assign(row, col, id); this.sel = { rowId: row.id, col }; }
            });
        } else if (pad && pad.mode === 'flash') {
            const up = () => this._flash(row, col, false);
            el.addEventListener('pointerdown', (e) => { if (e.button === 0) { try { el.setPointerCapture(e.pointerId); } catch (_) { /* synthétique */ } this._flash(row, col, true); } });
            el.addEventListener('pointerup', up);
            el.addEventListener('pointercancel', up);
        } else {
            el.addEventListener('pointerdown', (e) => { if (e.button === 0) this.toggle(row, col); });
        }
        this._pads.push({ el, prog, row, col, key, pat });
        return el;
    }

    _patternShelf(show) {
        return h('div', { class: 'panel live-shelf' }, [
            h('div', { class: 'panel-head' }, [h('span', { class: 'title', text: 'Patterns' })]),
            h('div', { class: 'live-shelf-list' }, show.patterns.length
                ? show.patterns.map((p) => {
                    const item = h('div', { class: 'shelf-item', draggable: 'true', title: 'Glisser sur un pad' }, [
                        h('span', { class: 'name', text: p.name }),
                        h('span', { class: 'count mono', text: `${p.length} t` }),
                    ]);
                    item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-pattern', p.id); e.dataTransfer.effectAllowed = 'copy'; });
                    return item;
                })
                : [h('div', { class: 'group-empty dim', text: 'Crée d’abord des patterns (onglet Patterns).' })]),
        ]);
    }

    _padInspector(show, live) {
        const els = [];
        const row = this.sel ? live.rows.find((r) => r.id === this.sel.rowId) : null;
        if (!row) {
            els.push(h('div', { class: 'insp-empty dim', text: 'Clique sur un pad pour le régler, ou glisse un pattern dessus.' }));
        } else {
            const col = this.sel.col;
            const pad = row.pads[col];
            const select = h('select', { class: 'field' }, [
                h('option', { value: '', text: '— Aucun —' }),
                ...show.patterns.map((p) => h('option', { value: p.id, text: p.name })),
            ]);
            select.value = pad ? pad.pattern : '';
            select.addEventListener('change', () => this._assign(row, col, select.value || null));
            els.push(h('div', { class: 'insp-section', text: `${row.name} · pad ${col + 1}` }));
            els.push(h('div', { class: 'insp-row' }, [h('span', { class: 'insp-label', text: 'Pattern' }), select]));
            if (pad) {
                els.push(h('div', { class: 'insp-row' }, [h('span', { class: 'insp-label', text: 'Mode' }), seg([['toggle', 'Bascule'], ['flash', 'Flash']], pad.mode, (v) => {
                    pad.mode = v;
                    this.engine.stop(this.padKey(row, col));
                    this.shows.touch();
                    this._key = '';
                })]));
                els.push(h('div', { class: 'insp-help dim', text: pad.mode === 'flash' ? 'Flash : le pattern joue tant que le pad est enfoncé, par-dessus la rangée.' : 'Bascule : un clic lance le pattern (calé sur le lancement choisi), un autre l’arrête. Un seul pad joue par rangée.' }));
                els.push(h('div', { class: 'insp-row' }, [h('span', { class: 'insp-label', text: '' }), h('button', { class: 'btn danger', text: 'Vider le pad', onclick: () => this._assign(row, col, null) })]));
            }
        }
        return h('div', { class: 'panel inspector' }, [
            h('div', { class: 'panel-head' }, [h('span', { class: 'title', text: 'Pad' })]),
            h('div', { class: 'insp-body' }, els),
        ]);
    }

    // ── Affichage ─────────────────────────────────────────────────────────
    frame() {
        const key = this._structureKey();
        if (key !== this._key) {
            this._key = key;
            this._render();
        }
        const now = this._now();
        for (const p of this._pads) {
            const st = this.engine.state(p.key, now);
            p.el.classList.toggle('playing', st === 'playing');
            p.el.classList.toggle('pending', st === 'pending');
            p.el.classList.toggle('stopping', st === 'stopping');
            const b = p.pat && (st === 'playing' || st === 'stopping') ? this.engine.localBeatOf(p.key, p.pat, now) : null;
            p.prog.style.width = b === null ? '0' : `${(b / p.pat.length) * 100}%`;
        }
    }
}
