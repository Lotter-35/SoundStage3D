/**
 * ShowView.js — vue « Show » : la timeline du morceau en cours, calée sur la musique.
 *
 *   en-tête   : morceau, lecture / pause / début (pour toute la salle), position (mesure · temps),
 *               BPM et premier temps (détectés, réglables), grille, zoom, suivi de la lecture,
 *               timeline armée (elle pilote la lumière) ;
 *   timeline  : règle des mesures, forme d'onde (clic = aller à ce moment), repères, pistes de clips
 *               (un clip = un pattern en boucle), tête de lecture ;
 *   à droite  : réglages du clip ou du repère choisi, patterns à glisser sur les pistes.
 *
 * Souris : molette = défiler, Ctrl + molette = zoom, double-clic dans les repères = nouveau repère,
 * glisser un clip = le déplacer (bord droit = longueur), Maj = sans grille, Suppr = supprimer.
 */

import { h, ICONS, fmtClock } from './dom.js';
import { analyzeTrack } from '../AudioAnalysis.js';
import { BEATS_PER_BAR } from '../TimelinePlayer.js';
import { newId } from '../ShowStore.js';

const RULER_H = 24;
const WAVE_H = 64;
const MARK_H = 22;
const LANE_H = 44;
const TOP_H = RULER_H + WAVE_H + MARK_H;
const EDGE = 6;          // poignée de longueur d'un clip (px)
const SEEK_EVERY = 120;  // envoi des déplacements pendant un glisser dans la forme d'onde (ms)

const mod = (a, n) => ((a % n) + n) % n;

function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

export class ShowView {
    /**
     * @param {object} o
     * @param {import('../ShowStore.js').ShowStore} o.shows
     * @param {import('../RegieClient.js').RegieClient} o.client
     * @param {import('../TimelinePlayer.js').TimelinePlayer} o.timeline
     * @param {object} o.prefs
     * @param {() => void} o.savePrefs
     */
    constructor({ shows, client, timeline, prefs, savePrefs }) {
        this.shows = shows;
        this.client = client;
        this.player = timeline;
        this.prefs = prefs;
        this._savePrefs = savePrefs;
        this.pps = prefs.showZoom || 24;   // pixels par seconde
        this.scrollX = 0;                  // secondes au bord gauche
        this.follow = true;
        this.sel = null;                   // { type: 'clip', lane, clip } | { type: 'marker', marker }
        this.analysis = null;
        this._analysisUrl = null;
        this._analysisState = 'idle';      // idle | busy | done | error
        this._key = '';
        this._drag = null;
        this._lastSeek = 0;
        this._pal = {
            bg: '#0f0f0f', ruler: '#151515', wave: cssVar('--value-hi', '#8a8a8a'), beat: '#191919', bar: '#2a2a2a',
            text: cssVar('--text-2', '#999'), faint: cssVar('--text-3', '#626262'), accent: cssVar('--accent', '#4d9cff'),
            danger: cssVar('--danger', '#e5534b'), clip: '#262626', clipLine: '#3a3a3a', warn: cssVar('--warn', '#e3a33b'),
        };

        this.$head = h('div', { class: 'panel-head showv-head' });
        this.$heads = h('div', { class: 'showv-heads' });
        this.canvas = h('canvas', { class: 'showv-canvas', tabindex: '0' });
        this.ctx = this.canvas.getContext('2d');
        this.$canvasWrap = h('div', { class: 'showv-canvas-wrap' }, [this.canvas]);
        this.$scroll = h('div', { class: 'showv-scroll' }, [this.$heads, this.$canvasWrap]);
        this.$side = h('div', { class: 'panel inspector showv-side' });
        this.$empty = h('div', { class: 'showv-empty' });
        this.$main = h('div', { class: 'showv-main' }, [this.$scroll]);
        this.el = h('div', { class: 'showv' }, [this.$head, h('div', { class: 'showv-body' }, [this.$main, this.$side])]);

        this._bindCanvas();
        this._ro = new ResizeObserver(() => this._resize());
        this._ro.observe(this.$canvasWrap);
    }

    get tl() {
        return this.player.current();
    }

    // ── Temps ↔ écran ─────────────────────────────────────────────────────
    _x(time) { return (time - this.scrollX) * this.pps; }
    _time(x) { return this.scrollX + x / this.pps; }

    _snapBeat(beat, free) {
        if (free) return Math.round(beat * 4) / 4;
        const g = this.prefs.showGrid === 1 ? 1 : BEATS_PER_BAR;
        return Math.round(beat / g) * g;
    }

    _resize() {
        const r = this.$canvasWrap.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const tl = this.tl;
        this.w = Math.max(1, Math.round(r.width));
        this.h = TOP_H + (tl ? tl.lanes.length : 0) * LANE_H + 1;
        this.canvas.style.height = `${this.h}px`;
        this.canvas.width = this.w * dpr;
        this.canvas.height = this.h * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ── Analyse du morceau ────────────────────────────────────────────────
    _ensureAnalysis() {
        const url = this.client.trackUrl();
        if (!url || url === this._analysisUrl) return;
        this._analysisUrl = url;
        this.analysis = null;
        this._analysisState = 'busy';
        this._key = '';
        analyzeTrack(url).then((a) => {
            if (this._analysisUrl !== url) return;
            this.analysis = a;
            this._analysisState = 'done';
            const tl = this.tl;
            if (tl && !(tl.duration > 0)) { tl.duration = a.duration; this.shows.touch(); }
            this._key = '';
        }).catch((e) => {
            if (this._analysisUrl !== url) return;
            console.warn('[Régie] analyse du morceau', e);
            this._analysisState = 'error';
            this._key = '';
        });
    }

    _createTimeline() {
        const tl = this.player.create(this.analysis);
        if (!tl) return;
        this.scrollX = 0;
        this._key = '';
    }

    /** Tempo doublé ou divisé par deux (erreur d'octave de la détection) ; le premier temps reste en place */
    _scaleBpm(k) {
        const tl = this.tl;
        if (!tl) return;
        const v = Math.round(tl.bpm * k * 100) / 100;
        if (v < 40 || v > 250) return;
        tl.bpm = v;
        this.shows.touch();
        this._key = '';
    }

    _detect() {
        const tl = this.tl;
        const a = this.analysis;
        if (!tl || !a) return;
        tl.bpm = a.bpm;
        tl.offset = a.offset;
        this.shows.touch();
        this._key = '';
    }

    // ── Lecture (pour toute la salle) ─────────────────────────────────────
    _playing() {
        return Boolean(this.client.playback && this.client.playback.isPlaying);
    }

    _togglePlay() {
        this.client.sendAction('play_pause', { isPlaying: !this._playing(), currentTime: this.client.musicTime() });
    }

    _seek(time) {
        const t = Math.max(0, Math.min(this._duration(), time));
        this.client.sendAction('seek', { currentTime: t });
    }

    _duration() {
        const tl = this.tl;
        return (this.analysis && this.analysis.duration) || (tl && tl.duration) || 240;
    }

    // ── Édition ───────────────────────────────────────────────────────────
    _pattern(id) {
        const show = this.shows.show;
        return show ? show.patterns.find((p) => p.id === id) || null : null;
    }

    _select(sel) {
        this.sel = sel;
        this._key = '';
    }

    _deleteSelection() {
        const tl = this.tl;
        const s = this.sel;
        if (!tl || !s) return;
        if (s.type === 'clip') s.lane.clips.splice(s.lane.clips.indexOf(s.clip), 1);
        if (s.type === 'marker') tl.markers.splice(tl.markers.indexOf(s.marker), 1);
        this.sel = null;
        this.shows.touch();
        this._key = '';
    }

    _addLane() {
        const tl = this.tl;
        tl.lanes.push({ id: newId('l'), name: `Piste ${tl.lanes.length + 1}`, mute: false, clips: [] });
        this.shows.touch();
        this._key = '';
        this._resize();
    }

    _hitClip(x, y) {
        const tl = this.tl;
        if (!tl || y < TOP_H) return null;
        const li = Math.floor((y - TOP_H) / LANE_H);
        const lane = tl.lanes[li];
        if (!lane) return null;
        const beat = this.player.beatOfTime(tl, this._time(x));
        let found = null;
        for (const c of lane.clips) if (beat >= c.start && beat < c.start + c.length && (!found || c.start >= found.start)) found = c;
        if (!found) return { lane, clip: null, li };
        const xEnd = this._x(this.player.timeOfBeat(tl, found.start + found.length));
        return { lane, clip: found, li, edge: xEnd - x <= EDGE };
    }

    _hitMarker(x) {
        const tl = this.tl;
        if (!tl) return null;
        let best = null;
        let bestD = 7;
        for (const m of tl.markers) {
            const d = Math.abs(this._x(this.player.timeOfBeat(tl, m.beat)) - x);
            if (d <= bestD) { bestD = d; best = m; }
        }
        return best;
    }

    _local(e) {
        const r = this.canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    _bindCanvas() {
        const c = this.canvas;
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            const [x] = this._local(e);
            if (e.ctrlKey || e.metaKey) {
                const t = this._time(x);
                this.pps = Math.max(2, Math.min(400, this.pps * Math.exp(-e.deltaY * 0.0015)));
                this.scrollX = Math.max(0, t - x / this.pps);
                this.prefs.showZoom = Math.round(this.pps * 10) / 10;
                this._savePrefs();
            } else {
                this.scrollX = Math.max(0, this.scrollX + (e.deltaY + e.deltaX) / this.pps);
                this.follow = false;
                this._key = '';
            }
        }, { passive: false });

        c.addEventListener('pointerdown', (e) => {
            const tl = this.tl;
            if (!tl || e.button !== 0) return;
            const [x, y] = this._local(e);
            c.focus();
            try { c.setPointerCapture(e.pointerId); } catch (_) { /* événement synthétique */ }
            if (y < RULER_H + WAVE_H) {
                this._seek(this._time(x));
                this._drag = { type: 'seek' };
                return;
            }
            if (y < TOP_H) {
                const m = this._hitMarker(x);
                if (m) {
                    this._select({ type: 'marker', marker: m });
                    this._drag = { type: 'marker', marker: m };
                } else {
                    this._select(null);
                }
                return;
            }
            const hit = this._hitClip(x, y);
            if (!hit || !hit.clip) { this._select(null); return; }
            this._select({ type: 'clip', lane: hit.lane, clip: hit.clip });
            const beat = this.player.beatOfTime(tl, this._time(x));
            this._drag = hit.edge
                ? { type: 'resize', clip: hit.clip }
                : { type: 'move', clip: hit.clip, lane: hit.lane, grab: beat - hit.clip.start };
        });
        c.addEventListener('pointermove', (e) => {
            const d = this._drag;
            const tl = this.tl;
            const [x, y] = this._local(e);
            if (!d || !tl) {
                // curseur : poignée de longueur des clips
                const hit = tl && y >= TOP_H ? this._hitClip(x, y) : null;
                c.style.cursor = hit && hit.clip ? (hit.edge ? 'ew-resize' : 'grab') : (y < RULER_H + WAVE_H ? 'text' : 'default');
                return;
            }
            const beat = this.player.beatOfTime(tl, this._time(x));
            if (d.type === 'seek') {
                const now = performance.now();
                if (now - this._lastSeek > SEEK_EVERY) { this._lastSeek = now; this._seek(this._time(x)); }
            } else if (d.type === 'marker') {
                d.marker.beat = Math.max(0, this._snapBeat(beat, e.shiftKey));
            } else if (d.type === 'move') {
                d.clip.start = Math.max(0, this._snapBeat(beat - d.grab, e.shiftKey));
                // Changement de piste en glissant verticalement
                const li = Math.floor((y - TOP_H) / LANE_H);
                const lane = tl.lanes[li];
                if (lane && lane !== d.lane && y >= TOP_H) {
                    d.lane.clips.splice(d.lane.clips.indexOf(d.clip), 1);
                    lane.clips.push(d.clip);
                    d.lane = lane;
                    this.sel = { type: 'clip', lane, clip: d.clip };
                }
            } else if (d.type === 'resize') {
                const g = e.shiftKey ? 0.25 : (this.prefs.showGrid === 1 ? 1 : BEATS_PER_BAR);
                d.clip.length = Math.max(g, this._snapBeat(beat, e.shiftKey) - d.clip.start);
            }
            d.moved = true;
        });
        const end = (e) => {
            const d = this._drag;
            this._drag = null;
            if (!d) return;
            if (d.type === 'seek') {
                const [x] = this._local(e);
                this._seek(this._time(x));
            } else if (d.moved) {
                this.shows.touch();
                this._key = '';
            }
        };
        c.addEventListener('pointerup', end);
        c.addEventListener('pointercancel', () => { this._drag = null; });
        c.addEventListener('dblclick', (e) => {
            const tl = this.tl;
            if (!tl) return;
            const [x, y] = this._local(e);
            if (y >= RULER_H + WAVE_H && y < TOP_H && !this._hitMarker(x)) {
                const m = { id: newId('m'), beat: Math.max(0, this._snapBeat(this.player.beatOfTime(tl, this._time(x)), e.shiftKey)), name: `Repère ${tl.markers.length + 1}` };
                tl.markers.push(m);
                this.shows.touch();
                this._select({ type: 'marker', marker: m });
            }
        });
        c.addEventListener('keydown', (e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) {
                e.preventDefault();
                e.stopPropagation();
                this._deleteSelection();
            }
        });
        // Patterns glissés depuis la liste de droite
        c.addEventListener('dragover', (e) => { if (this.tl) e.preventDefault(); });
        c.addEventListener('drop', (e) => {
            const tl = this.tl;
            const id = e.dataTransfer.getData('text/x-pattern');
            if (!tl || !id) return;
            e.preventDefault();
            const [x, y] = this._local(e);
            if (y < TOP_H) return;
            const lane = tl.lanes[Math.floor((y - TOP_H) / LANE_H)];
            const pat = this._pattern(id);
            if (!lane || !pat) return;
            const start = Math.max(0, this._snapBeat(this.player.beatOfTime(tl, this._time(x)), e.shiftKey));
            const length = Math.max(1, Math.ceil(pat.length / BEATS_PER_BAR) * BEATS_PER_BAR);
            const clip = { id: newId('c'), pattern: id, start, length };
            lane.clips.push(clip);
            this.shows.touch();
            this._select({ type: 'clip', lane, clip });
        });
    }

    // ── Construction (en-tête, pistes, panneau de droite) ─────────────────
    _structureKey() {
        const tl = this.tl;
        const show = this.shows.show;
        const s = this.sel;
        const lanes = tl ? tl.lanes.map((l) => `${l.id}:${l.name}:${l.mute}`).join('|') : '';
        const pats = show ? show.patterns.map((p) => `${p.id}=${p.name}`).join(',') : '';
        const selKey = s ? (s.type === 'clip' ? `c${s.clip.id}:${s.clip.pattern}:${s.clip.start}:${s.clip.length}` : `m${s.marker.id}:${s.marker.name}:${s.marker.beat}`) : '';
        return [show ? show.id : '', this.player.trackKey(), this._analysisState, tl ? `${tl.bpm}|${tl.offset}|${tl.armed}` : 'none',
            lanes, pats, selKey, this.follow, this.prefs.showGrid].join('#');
    }

    _render() {
        const tl = this.tl;
        const trackKey = this.player.trackKey();
        this._renderHead(tl, trackKey);
        if (!tl) {
            let msg = 'Lance un morceau dans le jeu : sa timeline se crée ici.';
            let btn = null;
            if (trackKey) {
                msg = this._analysisState === 'busy' ? `Analyse de « ${trackKey} » (tempo, premier temps, forme d'onde)…`
                    : this._analysisState === 'error' ? `Analyse de « ${trackKey} » impossible. La timeline peut quand même être créée (120 BPM).`
                        : `« ${trackKey} » n'a pas encore de timeline dans ce show.`;
                if (this._analysisState !== 'busy') btn = h('button', { class: 'btn', text: 'Créer la timeline de ce morceau', onclick: () => this._createTimeline() });
            }
            this.$empty.replaceChildren(h('div', { class: 'dim', text: msg }), btn);
            this.$main.replaceChildren(this.$empty);
            this.$side.replaceChildren(this._shelf());
            return;
        }
        if (!this.$scroll.isConnected) this.$main.replaceChildren(this.$scroll);
        // En-têtes des lignes et des pistes
        const heads = [
            h('div', { class: 'showv-rowhead dim', style: `height:${RULER_H}px`, text: 'Mesures' }),
            h('div', { class: 'showv-rowhead dim', style: `height:${WAVE_H}px`, text: 'Audio' }),
            h('div', { class: 'showv-rowhead dim', style: `height:${MARK_H}px`, text: 'Repères', title: 'Double-clic dans la ligne : nouveau repère' }),
        ];
        for (const lane of tl.lanes) {
            const name = h('span', { class: 'name', text: lane.name, title: 'Double-clic : renommer' });
            name.addEventListener('dblclick', () => this._renameLane(lane, name));
            heads.push(h('div', { class: `showv-lanehead${lane.mute ? ' muted' : ''}`, style: `height:${LANE_H}px` }, [
                name,
                h('button', { class: `btn icon ${lane.mute ? 'on' : 'ghost'}`, text: 'M', title: lane.mute ? 'Réactiver la piste' : 'Rendre la piste muette',
                    onclick: () => { lane.mute = !lane.mute; this.shows.touch(); this._key = ''; } }),
                h('button', { class: 'btn icon ghost', html: ICONS.close, title: 'Supprimer la piste', 'aria-label': 'Supprimer la piste',
                    onclick: () => { tl.lanes.splice(tl.lanes.indexOf(lane), 1); if (this.sel && this.sel.lane === lane) this.sel = null; this.shows.touch(); this._key = ''; this._resize(); } }),
            ]));
        }
        heads.push(h('div', { class: 'showv-addlane' }, [h('button', { class: 'btn', text: 'Ajouter une piste', onclick: () => this._addLane() })]));
        this.$heads.replaceChildren(...heads);
        this._resize();
        this.$side.replaceChildren(...this._inspector(tl), this._shelf());
    }

    _renameLane(lane, nameEl) {
        const input = h('input', { class: 'field', value: lane.name, maxlength: '30', spellcheck: 'false' });
        const done = (save) => {
            if (save && input.value.trim()) { lane.name = input.value.trim(); this.shows.touch(); }
            this._key = '';
        };
        input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
        input.addEventListener('blur', () => done(true));
        nameEl.replaceWith(input);
        input.focus();
        input.select();
    }

    _renderHead(tl, trackKey) {
        const els = [];
        els.push(h('span', { class: 'track-name', text: trackKey || 'Aucun morceau', title: trackKey || '' }));
        if (tl) {
            this.$playBtn = h('button', { class: 'btn icon', title: 'Lecture / pause pour toute la salle (Espace)', 'aria-label': 'Lecture / pause', onclick: () => this._togglePlay() });
            this._btnPlaying = undefined; // nouvel élément : icône posée à la prochaine image
            els.push(
                h('button', { class: 'btn icon', html: ICONS.left, title: 'Revenir au début', 'aria-label': 'Revenir au début', onclick: () => this._seek(0) }),
                this.$playBtn,
            );
            this.$pos = h('span', { class: 'mono pos' });
            els.push(this.$pos, h('span', { class: 'sep' }));
            const bpm = h('input', { class: 'field num', type: 'number', min: '40', max: '250', step: '0.1', value: String(tl.bpm), title: 'Tempo du morceau' });
            bpm.addEventListener('change', () => { const v = Number(bpm.value); if (v >= 40 && v <= 250) { tl.bpm = Math.round(v * 100) / 100; this.shows.touch(); } });
            bpm.addEventListener('keydown', (e) => e.stopPropagation());
            const off = h('input', { class: 'field num', type: 'number', step: '0.001', value: String(tl.offset), title: 'Position du premier temps (secondes)' });
            off.addEventListener('change', () => { const v = Number(off.value); if (Number.isFinite(v)) { tl.offset = Math.round(v * 1000) / 1000; this.shows.touch(); } });
            off.addEventListener('keydown', (e) => e.stopPropagation());
            els.push(
                h('span', { class: 'dim', text: 'BPM' }), bpm,
                h('button', { class: 'btn icon', text: '÷2', title: 'Tempo divisé par deux', onclick: () => this._scaleBpm(0.5) }),
                h('button', { class: 'btn icon', text: '×2', title: 'Tempo doublé (détection à la moitié du vrai tempo)', onclick: () => this._scaleBpm(2) }),
                h('button', { class: 'btn', text: 'Détecter', title: this.analysis ? `Tempo détecté : ${this.analysis.bpm} BPM, premier temps à ${this.analysis.offset.toFixed(3)} s` : 'Analyse du morceau en cours…',
                    disabled: !this.analysis, onclick: () => this._detect() }),
                h('span', { class: 'dim', text: '1er temps' }), off, h('span', { class: 'dim', text: 's' }),
                h('button', { class: 'btn', text: 'Mesure ici', title: 'La position de lecture devient le début d’une mesure',
                    onclick: () => {
                        const bar = (60 / tl.bpm) * BEATS_PER_BAR;
                        tl.offset = Math.round(mod(this.client.musicTime(), bar) * 1000) / 1000;
                        this.shows.touch();
                        this._key = '';
                    } }),
                h('span', { class: 'sep' }),
            );
            const grid = h('span', { class: 'seg' }, [
                h('button', { class: this.prefs.showGrid === 1 ? 'on' : '', text: 'Temps', onclick: () => { this.prefs.showGrid = 1; this._savePrefs(); this._key = ''; } }),
                h('button', { class: this.prefs.showGrid === 1 ? '' : 'on', text: 'Mesure', onclick: () => { this.prefs.showGrid = 4; this._savePrefs(); this._key = ''; } }),
            ]);
            els.push(h('span', { class: 'dim', text: 'Grille' }), grid,
                h('button', { class: 'btn icon', text: '−', title: 'Dézoomer (Ctrl + molette)', onclick: () => this._zoom(1 / 1.5) }),
                h('button', { class: 'btn icon', text: '+', title: 'Zoomer (Ctrl + molette)', onclick: () => this._zoom(1.5) }),
                h('button', { class: `btn${this.follow ? ' on' : ''}`, text: 'Suivre', title: 'La timeline défile avec la lecture', onclick: () => { this.follow = !this.follow; this._key = ''; } }),
                h('span', { class: 'grow' }),
                h('button', { class: `btn${tl.armed !== false ? ' on armed' : ''}`, text: tl.armed !== false ? 'Show actif' : 'Show inactif',
                    title: 'Actif : la timeline pilote la lumière et le tempo suit le morceau', onclick: () => { tl.armed = tl.armed === false; this.shows.touch(); this._key = ''; } }),
            );
        } else {
            els.push(h('span', { class: 'grow' }));
        }
        this.$head.replaceChildren(...els);
    }

    _zoom(k) {
        const center = this._time((this.w || 800) / 2);
        this.pps = Math.max(2, Math.min(400, this.pps * k));
        this.scrollX = Math.max(0, center - (this.w || 800) / 2 / this.pps);
        this.prefs.showZoom = Math.round(this.pps * 10) / 10;
        this._savePrefs();
    }

    _inspector(tl) {
        const s = this.sel;
        const show = this.shows.show;
        const row = (label, control) => h('div', { class: 'insp-row' }, [h('span', { class: 'insp-label', text: label }), control]);
        const num = (value, step, onchange) => {
            const el = h('input', { class: 'field num', type: 'number', step: String(step), value: String(value) });
            el.addEventListener('change', () => { const v = Number(el.value); if (Number.isFinite(v)) onchange(v); });
            el.addEventListener('keydown', (e) => e.stopPropagation());
            return el;
        };
        const els = [h('div', { class: 'panel-head' }, [h('span', { class: 'title', text: s ? (s.type === 'clip' ? 'Clip' : 'Repère') : 'Timeline' })])];
        const body = [];
        if (s && s.type === 'clip') {
            const c = s.clip;
            const sel = h('select', { class: 'field' }, show.patterns.map((p) => h('option', { value: p.id, text: p.name })));
            sel.value = c.pattern;
            sel.addEventListener('change', () => { c.pattern = sel.value; this.shows.touch(); this._key = ''; });
            body.push(row('Pattern', sel));
            body.push(row('Début', h('span', { class: 'group' }, [num(Math.floor(c.start / BEATS_PER_BAR) + 1, 1, (v) => { c.start = Math.max(0, (v - 1) * BEATS_PER_BAR + mod(c.start, BEATS_PER_BAR)); this.shows.touch(); this._key = ''; }), h('span', { class: 'dim', text: 'mesure' })])));
            body.push(row('Longueur', h('span', { class: 'group' }, [num(c.length, 1, (v) => { c.length = Math.max(0.25, v); this.shows.touch(); this._key = ''; }), h('span', { class: 'dim', text: 'temps' })])));
            body.push(row('', h('button', { class: 'btn danger', text: 'Supprimer le clip', onclick: () => this._deleteSelection() })));
        } else if (s && s.type === 'marker') {
            const m = s.marker;
            const name = h('input', { class: 'field', value: m.name, maxlength: '40', spellcheck: 'false' });
            name.addEventListener('change', () => { m.name = name.value.trim() || m.name; this.shows.touch(); this._key = ''; });
            name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
            body.push(row('Nom', name));
            body.push(row('Mesure', num(Math.floor(m.beat / BEATS_PER_BAR) + 1, 1, (v) => { m.beat = Math.max(0, (v - 1) * BEATS_PER_BAR); this.shows.touch(); this._key = ''; })));
            body.push(row('', h('button', { class: 'btn', text: 'Aller au repère', onclick: () => this._seek(this.player.timeOfBeat(tl, m.beat)) })));
            body.push(row('', h('button', { class: 'btn danger', text: 'Supprimer le repère', onclick: () => this._deleteSelection() })));
        } else {
            const a = this.analysis;
            body.push(h('div', { class: 'insp-help dim', text: a
                ? `Analyse : ${a.bpm} BPM, premier temps à ${a.offset.toFixed(3)} s, durée ${fmtClock(a.duration)}.`
                : (this._analysisState === 'busy' ? 'Analyse du morceau en cours…' : 'Forme d’onde indisponible.') }));
            body.push(h('div', { class: 'insp-help dim', text: 'Glisse un pattern sur une piste pour créer un clip. Clic dans la forme d’onde : aller à ce moment (toute la salle). Double-clic dans les repères : nouveau repère.' }));
        }
        els.push(h('div', { class: 'insp-body showv-insp' }, body));
        return els;
    }

    _shelf() {
        const show = this.shows.show;
        const pats = show ? show.patterns : [];
        return h('div', { class: 'showv-shelf' }, [
            h('div', { class: 'panel-head' }, [h('span', { class: 'title', text: 'Patterns' })]),
            h('div', { class: 'live-shelf-list' }, pats.length
                ? pats.map((p) => {
                    const item = h('div', { class: 'shelf-item', draggable: 'true', title: 'Glisser sur une piste' }, [
                        h('span', { class: 'name', text: p.name }),
                        h('span', { class: 'count mono', text: `${p.length} t` }),
                    ]);
                    item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-pattern', p.id); e.dataTransfer.effectAllowed = 'copy'; });
                    return item;
                })
                : [h('div', { class: 'group-empty dim', text: 'Crée d’abord des patterns (onglet Patterns).' })]),
        ]);
    }

    // ── Dessin ────────────────────────────────────────────────────────────
    frame() {
        this._ensureAnalysis();
        const key = this._structureKey();
        if (key !== this._key) {
            this._key = key;
            this._render();
        }
        const tl = this.tl;
        if (!tl) return;
        if (!this.w) this._resize();
        const now = this.client.clock.now();
        const time = this.client.musicTime(now);
        // Suivi : la tête de lecture reste visible
        if (this.follow && this._playing() && !this._drag) {
            const x = this._x(time);
            if (x < this.w * 0.1 || x > this.w * 0.85) this.scrollX = Math.max(0, time - (this.w * 0.2) / this.pps);
        }
        if (this.$playBtn) {
            const playing = this._playing();
            if (this._btnPlaying !== playing) {
                this._btnPlaying = playing;
                this.$playBtn.innerHTML = playing ? ICONS.pause : ICONS.play;
                this.$playBtn.classList.toggle('on', playing);
            }
        }
        if (this.$pos) {
            const beat = this.player.beatOfTime(tl, time);
            const bar = Math.floor(beat / BEATS_PER_BAR) + 1;
            const bt = Math.floor(mod(beat, BEATS_PER_BAR)) + 1;
            this.$pos.textContent = `${fmtClock(time)} · ${bar < 1 ? '—' : `${bar}.${bt}`}`;
        }
        this._draw(tl, time);
    }

    _draw(tl, time) {
        const g = this.ctx;
        const P = this._pal;
        const { w, h } = this;
        const pps = this.pps;
        const t0 = this.scrollX;
        const t1 = t0 + w / pps;
        g.fillStyle = P.bg;
        g.fillRect(0, 0, w, h);
        g.fillStyle = P.ruler;
        g.fillRect(0, 0, w, RULER_H);

        // Grille des temps et des mesures
        const beatPx = (60 / tl.bpm) * pps;
        const b0 = Math.floor(this.player.beatOfTime(tl, t0));
        const b1 = Math.ceil(this.player.beatOfTime(tl, t1));
        const barStep = beatPx * BEATS_PER_BAR < 36 ? Math.ceil(36 / (beatPx * BEATS_PER_BAR)) : 1; // numéros de mesure lisibles
        g.font = '10px "Cascadia Mono", Consolas, monospace';
        g.textBaseline = 'middle';
        for (let b = Math.max(0, b0); b <= b1; b++) {
            const x = Math.round(this._x(this.player.timeOfBeat(tl, b))) + 0.5;
            const isBar = b % BEATS_PER_BAR === 0;
            if (!isBar && beatPx < 6) continue;
            g.strokeStyle = isBar ? P.bar : P.beat;
            g.beginPath(); g.moveTo(x, RULER_H); g.lineTo(x, h); g.stroke();
            if (isBar) {
                const bar = b / BEATS_PER_BAR;
                if (bar % barStep === 0) {
                    g.strokeStyle = '#3a3a3a';
                    g.beginPath(); g.moveTo(x, 8); g.lineTo(x, RULER_H); g.stroke();
                    g.fillStyle = P.text;
                    g.fillText(String(bar + 1), x + 3, RULER_H / 2);
                }
            }
        }

        // Forme d'onde
        const a = this.analysis;
        const wy = RULER_H + WAVE_H / 2;
        if (a && a.peaks) {
            const n = a.peaks.length / 2;
            const perSec = n / a.duration;
            g.fillStyle = P.wave;
            for (let x = 0; x < w; x++) {
                const ta = t0 + x / pps;
                const tb = ta + 1 / pps;
                if (tb < 0 || ta > a.duration) continue;
                let ia = Math.max(0, Math.floor(ta * perSec));
                const ib = Math.min(n - 1, Math.max(ia, Math.floor(tb * perSec)));
                let lo = 0;
                let hi = 0;
                for (; ia <= ib; ia++) {
                    if (a.peaks[ia * 2] < lo) lo = a.peaks[ia * 2];
                    if (a.peaks[ia * 2 + 1] > hi) hi = a.peaks[ia * 2 + 1];
                }
                const y0 = wy - hi * (WAVE_H / 2 - 3);
                const y1 = wy - lo * (WAVE_H / 2 - 3);
                g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
            }
        } else {
            g.fillStyle = P.faint;
            g.font = '11px "Segoe UI", system-ui, sans-serif';
            g.fillText(this._analysisState === 'busy' ? 'Analyse du morceau…' : 'Forme d’onde indisponible', 10, wy);
        }
        // Fin du morceau
        const xEnd = this._x(this._duration());
        if (xEnd < w) {
            g.fillStyle = 'rgba(0, 0, 0, 0.45)';
            g.fillRect(Math.max(0, xEnd), RULER_H, w - Math.max(0, xEnd), h - RULER_H);
        }
        g.strokeStyle = '#262626';
        g.beginPath(); g.moveTo(0, RULER_H + WAVE_H + 0.5); g.lineTo(w, RULER_H + WAVE_H + 0.5); g.stroke();

        // Repères
        const my = RULER_H + WAVE_H;
        g.font = '11px "Segoe UI", system-ui, sans-serif';
        for (const m of tl.markers) {
            const x = Math.round(this._x(this.player.timeOfBeat(tl, m.beat)));
            if (x < -200 || x > w + 10) continue;
            const sel = this.sel && this.sel.marker === m;
            g.fillStyle = sel ? P.accent : P.warn;
            g.fillRect(x, my + 3, 2, MARK_H - 6);
            g.fillStyle = sel ? P.accent : P.text;
            g.fillText(m.name, x + 6, my + MARK_H / 2);
        }

        // Pistes et clips
        const show = this.shows.show;
        g.font = '11px "Segoe UI", system-ui, sans-serif';
        tl.lanes.forEach((lane, li) => {
            const y = TOP_H + li * LANE_H;
            g.strokeStyle = '#1f1f1f';
            g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); g.stroke();
            if (lane.mute) g.globalAlpha = 0.35;
            for (const c of lane.clips) {
                const xa = this._x(this.player.timeOfBeat(tl, c.start));
                const xb = this._x(this.player.timeOfBeat(tl, c.start + c.length));
                if (xb < 0 || xa > w) continue;
                const pat = show.patterns.find((p) => p.id === c.pattern);
                const sel = this.sel && this.sel.clip === c;
                g.fillStyle = P.clip;
                g.fillRect(xa + 1, y + 4, Math.max(2, xb - xa - 2), LANE_H - 8);
                // Boucles du pattern dans le clip
                if (pat && pat.length > 0) {
                    g.strokeStyle = P.clipLine;
                    for (let b = c.start + pat.length; b < c.start + c.length - 1e-6; b += pat.length) {
                        const x = Math.round(this._x(this.player.timeOfBeat(tl, b))) + 0.5;
                        g.beginPath(); g.moveTo(x, y + 8); g.lineTo(x, y + LANE_H - 8); g.stroke();
                    }
                }
                g.lineWidth = sel ? 2 : 1;
                g.strokeStyle = sel ? P.accent : '#4a4a4a';
                g.strokeRect(Math.round(xa) + 1.5, y + 4.5, Math.max(1, Math.round(xb - xa) - 3), LANE_H - 9);
                g.lineWidth = 1;
                g.save();
                g.beginPath();
                g.rect(xa + 2, y + 4, Math.max(0, xb - xa - 4), LANE_H - 8);
                g.clip();
                g.fillStyle = pat ? '#d4d4d4' : P.danger;
                g.fillText(pat ? pat.name : 'Pattern supprimé', Math.max(xa, 0) + 7, y + LANE_H / 2);
                g.restore();
            }
            g.globalAlpha = 1;
        });

        // Tête de lecture
        const xp = Math.round(this._x(time)) + 0.5;
        if (xp >= 0 && xp <= w) {
            g.strokeStyle = P.danger;
            g.beginPath(); g.moveTo(xp, 0); g.lineTo(xp, h); g.stroke();
        }
    }

    dispose() {
        this._ro.disconnect();
    }
}
