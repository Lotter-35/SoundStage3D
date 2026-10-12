/**
 * SpotConsolePanel.js
 * ─────────────────────────────────────────────────────────────
 * Console des lyres (« programmeur » simplifié, façon pupitre lumière) :
 *   1. SÉLECTION  : grille de tuiles (clic, Ctrl+clic, Maj+clic, rectangle),
 *                   Tout / Aucun / Inverser / Pairs / Impairs / Sol / Suspendues, groupes G1…G8
 *   2. INTENSITÉ  : fader, 0 / 50 / 100 %, Flash (maintenu), Strobe
 *   3. COULEUR    : palette, sélecteur libre, dégradé A → B
 *   4. POSITION   : point de visée (clic dans la 3D), suivre mon joueur, pad XY relatif,
 *                   éventail, positions toutes faites
 *   5. FAISCEAU   : gobos, prisme, zoom, frost
 *   6. EFFETS     : balayages, cercle, vague dimmer, chenillard, avec décalage entre lyres
 *
 * Ouverture : bouton « 🎛️ Lyres » ou touche L.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { makeDraggable } from '../../ui/draggable.js';
import { SpotProgrammer, GROUP_COUNT } from './SpotProgrammer.js?v=2';
import { SpotAimTarget } from './SpotAimTarget.js';
import { SpotSelectionHighlight } from './SpotSelectionHighlight.js';
import { FX_TYPES, FX_ORDERS } from './SpotEffects.js';
import {
    COLOR_WHEEL, GOBO_FIXED_WHEEL, GOBO_ROT_WHEEL, PRISMS, PAN_RANGE, TILT_RANGE
} from '../config/spotParams.js';

const SWATCHES = ['#ffffff', '#ff1a1a', '#ff6a00', '#ffd000', '#9dff00', '#00ff4c',
    '#00ffd5', '#00b3ff', '#1a3cff', '#8c1aff', '#ff1ad9', '#ff6fae'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const HALF_PAN = PAN_RANGE / 2;
const HALF_TILT = TILT_RANGE / 2;

function loadCss() {
    if (document.getElementById('spot-console-css')) return;
    const link = document.createElement('link');
    link.id = 'spot-console-css';
    link.rel = 'stylesheet';
    link.href = new URL('./spotConsole.css', import.meta.url).href;
    document.head.appendChild(link);
}

function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
}

/** Couleur affichée d'une lyre (CMY × filtre de la roue) */
function displayColor(p) {
    const n = parseInt(String(p.color).replace('#', ''), 16) || 0;
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const w = COLOR_WHEEL.find(c => c.name === p.colorWheel);
    if (w && w.name !== COLOR_WHEEL[0].name) {
        r *= w.rgb[0]; g *= w.rgb[1]; b *= w.rgb[2];
    }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export class SpotConsolePanel {
    /**
     * @param {object} o
     * @param {import('../SpotManager.js').SpotManager} o.spotManager
     * @param {import('../../ui/AmbiancePanel.js').AmbiancePanel} o.ambiancePanel
     * @param {THREE.Scene} o.scene
     * @param {THREE.Camera} o.camera
     * @param {THREE.WebGLRenderer} o.renderer
     * @param {object} [o.listener] joueur local (position, verrouillage souris)
     */
    constructor({ spotManager, ambiancePanel, scene, camera, renderer, listener }) {
        this.spotManager = spotManager;
        this.ambiancePanel = ambiancePanel;
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.listener = listener;
        this.isOpen = false;

        this.programmer = new SpotProgrammer({ spotManager, ambiancePanel, camera });
        // Le panneau de réglages d'une lyre applique ses changements à toute cette sélection
        spotManager.programmer = this.programmer;
        this.aimTarget = new SpotAimTarget(scene);
        this.highlight = new SpotSelectionHighlight(scene);
        this.effects = spotManager.effects;

        this._aiming = false;
        this._follow = null;      // { spots, timer }
        this._fxType = 'panSweep';
        this._fxAmp = {};
        for (const [k, t] of Object.entries(FX_TYPES)) this._fxAmp[k] = t.amp.value;
        this._fxSpeed = 0.5;
        this._fxOffset = 0.1;
        this._fxOrder = FX_ORDERS[0];
        this._fxSpread = false;
        this._flashSnap = null;
        this._tileCount = -1;
        this._tiles = new Map();

        loadCss();
        this._build();
        this._bindGlobal();

        this.programmer.onChange(() => this._refreshTiles(true));
        this.effects.onChange(() => this._refreshFxList());
        spotManager.addUpdateHook(dt => this._update(dt));
        this._timer = setInterval(() => { if (this.isOpen) this._refreshTiles(false); }, 200);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Construction de l'interface
    // ═════════════════════════════════════════════════════════════════════
    _section(title, content, collapsed = false) {
        const sec = h('div', { class: 'sc-section' + (collapsed ? ' collapsed' : '') }, [
            h('h4', { text: title, onclick: () => sec.classList.toggle('collapsed') }),
            h('div', { class: 'sc-content' }, content),
        ]);
        return sec;
    }

    _slider(label, min, max, step, value, fmt, onInput, extra = {}) {
        const val = h('span', { class: 'sc-value', text: fmt(value) });
        const input = h('input', { type: 'range', class: 'sc-range', min, max, step, value });
        input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            val.textContent = fmt(v);
            onInput(v, input);
        });
        if (extra.onpointerdown) input.addEventListener('pointerdown', extra.onpointerdown);
        if (extra.onchange) input.addEventListener('change', extra.onchange);
        const lab = h('span', { class: 'sc-label', text: label });
        const row = h('div', { class: 'sc-row sc-nowrap' }, [lab, input, val]);
        row._input = input;
        row._val = val;
        row._label = lab;
        return row;
    }

    _build() {
        const P = this.programmer;
        this.root = h('div', { id: 'spot-console', class: 'hidden' });
        this.countEl = h('span', { class: 'sc-count', text: '0 / 0' });
        const header = h('div', { class: 'sc-header' }, [
            h('span', { class: 'sc-title', text: '🎛️ Console Lyres' }),
            this.countEl,
            h('button', { class: 'sc-close', title: 'Fermer (L)', text: '✕', onclick: () => this.toggle(false) }),
        ]);
        const body = h('div', { class: 'sc-body' });
        this.root.append(header, body);
        document.body.appendChild(this.root);
        makeDraggable(this.root, header, 'spot-console');
        // La console ne transmet pas ses clics au jeu
        for (const ev of ['pointerdown', 'mousedown', 'click', 'wheel']) this.root.addEventListener(ev, e => e.stopPropagation());

        // ── 1. Sélection ──
        this.grid = h('div', { class: 'sc-grid' });
        this.band = h('div', { class: 'sc-band' });
        this.band.style.display = 'none';
        this._bindGrid();
        const quick = h('div', { class: 'sc-row' }, [
            h('button', { class: 'sc-btn', text: 'Tout', onclick: () => P.selectAll() }),
            h('button', { class: 'sc-btn', text: 'Aucun', onclick: () => P.clear() }),
            h('button', { class: 'sc-btn', text: 'Inverser', onclick: () => P.invert() }),
            h('button', { class: 'sc-btn', text: 'Pairs', onclick: () => P.selectParity(false) }),
            h('button', { class: 'sc-btn', text: 'Impairs', onclick: () => P.selectParity(true) }),
            h('button', { class: 'sc-btn', text: 'Sol', onclick: () => P.selectMount(false) }),
            h('button', { class: 'sc-btn', text: 'Suspendues', onclick: () => P.selectMount(true) }),
            h('button', { class: 'sc-btn primary', text: '＋ Lyre', title: 'Poser une nouvelle lyre devant moi',
                onclick: () => this._addSpot() }),
        ]);
        this.groupRow = h('div', { class: 'sc-row' });
        for (let i = 0; i < GROUP_COUNT; i++) {
            const b = h('button', { class: 'sc-btn sc-group', text: 'G' + (i + 1),
                title: 'Clic : rappeler le groupe (ou l\'enregistrer s\'il est vide)\nClic droit / Maj+clic : enregistrer la sélection' });
            b.addEventListener('click', (e) => {
                if (e.shiftKey || !P.recallGroup(i)) P.storeGroup(i);
                this._refreshGroups();
            });
            b.addEventListener('contextmenu', (e) => { e.preventDefault(); P.storeGroup(i); this._refreshGroups(); });
            this.groupRow.appendChild(b);
        }
        body.appendChild(this._section('Sélection', [
            quick,
            this.grid,
            h('div', { class: 'sc-hint', text: 'Clic · Ctrl+clic ajoute/retire · Maj+clic plage · glisser = rectangle · clic sur une lyre dans la 3D' }),
            this.groupRow,
        ]));

        // ── 2. Intensité ──
        this.dimRow = this._slider('Dimmer', 0, 100, 1, 100, v => v.toFixed(0) + ' %',
            v => P.apply({ dimmer: v }, { continuous: true }));
        const flash = h('button', { class: 'sc-btn big grow', text: '⚡ Flash (maintenir)' });
        flash.addEventListener('pointerdown', (e) => { e.preventDefault(); this._flash(true); });
        for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) flash.addEventListener(ev, () => this._flash(false));
        this.strobeBtn = h('button', { class: 'sc-btn big grow', text: '💥 Strobe', onclick: () => this._toggleStrobe() });
        body.appendChild(this._section('Intensité', [
            this.dimRow,
            h('div', { class: 'sc-row' }, [
                ...[0, 25, 50, 75, 100].map(v => h('button', { class: 'sc-btn grow', text: v + ' %',
                    onclick: () => { P.apply({ dimmer: v, shutter: 'Ouvert' }); this._syncDimmer(v); } })),
            ]),
            h('div', { class: 'sc-row' }, [flash, this.strobeBtn]),
        ]));

        // ── 3. Couleur ──
        const sw = h('div', { class: 'sc-swatches' }, SWATCHES.map(c => {
            const s = h('div', { class: 'sc-swatch', title: c });
            s.style.background = c;
            s.style.color = c;
            s.addEventListener('click', () => P.apply({ color: c, colorWheel: COLOR_WHEEL[0].name, rainbow: 0 }));
            return s;
        }));
        const free = h('input', { type: 'color', class: 'sc-color', value: '#ff3300', title: 'Couleur libre' });
        free.addEventListener('input', () => P.apply({ color: free.value, colorWheel: COLOR_WHEEL[0].name, rainbow: 0 }, { continuous: true }));
        const gA = h('input', { type: 'color', class: 'sc-color', value: '#ff0040' });
        const gB = h('input', { type: 'color', class: 'sc-color', value: '#0060ff' });
        body.appendChild(this._section('Couleur', [
            sw,
            h('div', { class: 'sc-row' }, [
                h('span', { class: 'sc-label', text: 'Couleur libre' }), free,
                h('span', { class: 'sc-label', text: 'Dégradé', style: 'min-width:auto;margin-left:10px' }), gA, h('span', { text: '→' }), gB,
                h('button', { class: 'sc-btn primary', text: 'Appliquer', title: 'Répartit A → B de gauche à droite',
                    onclick: () => P.gradient(gA.value, gB.value) }),
            ]),
        ]));

        // ── 4. Position ──
        this.aimBtn = h('button', { class: 'sc-btn big grow', text: '🎯 Viser un point', title: 'Puis cliquer sur le sol ou la scène',
            onclick: () => this._setAiming(!this._aiming) });
        this.followBtn = h('button', { class: 'sc-btn big grow', text: '👤 Suivre mon joueur', onclick: () => this._toggleFollow() });
        const reAim = h('button', { class: 'sc-btn', text: '↻', title: 'Viser à nouveau le dernier point (pour une nouvelle sélection)',
            onclick: () => { if (this.aimTarget.hasTarget) P.aimAt(this.aimTarget.position); } });
        this.pad = h('div', { class: 'sc-pad', title: 'Glisser : déplace le pan / tilt de la sélection' }, [
            h('div', { class: 'sc-pad-dot' }), h('div', { class: 'sc-pad-hint', text: '↔ pan · ↕ tilt' }),
        ]);
        this._bindPad();
        this.fanRow = this._slider('Éventail', -90, 90, 1, 0, v => (v > 0 ? '+' : '') + v.toFixed(0) + '°',
            v => this._fan(v), { onpointerdown: () => this._fanStart(), onchange: () => this._fanEnd() });
        const presets = h('div', { class: 'sc-row' }, [
            ['⌂ Home', () => P.apply({ pan: 0, tilt: 0 })],
            ['☁ Ciel', () => P.aimAt(s => s.lensPos.clone().add(new THREE.Vector3(0, 100, -25)))],
            ['👥 Public', () => P.aimAt(s => new THREE.Vector3(s.group.position.x * 0.5, 1.2, 26))],
            ['🎤 Scène', () => P.aimAt(s => new THREE.Vector3(s.group.position.x * 0.4, 2, -7))],
            ['✖ Croisé', () => P.aimAt(s => new THREE.Vector3(-s.group.position.x * 0.7, s.group.position.y + 9, s.group.position.z + 18))],
        ].map(([t, fn]) => h('button', { class: 'sc-btn grow', text: t, onclick: fn })));
        body.appendChild(this._section('Position', [
            h('div', { class: 'sc-row sc-nowrap' }, [this.aimBtn, reAim, this.followBtn]),
            h('div', { class: 'sc-row sc-nowrap' }, [this.pad, h('div', { class: 'sc-poscol' }, [
                this.fanRow,
                h('div', { class: 'sc-hint', text: 'Éventail : écarte les faisceaux en V (gauche ↔ droite). Relâcher fige la position.' }),
            ])]),
            presets,
        ]));

        // ── 5. Faisceau ──
        const mkSelect = (label, options, key) => {
            const sel = h('select', { class: 'sc-select' }, [h('option', { value: '', text: '— ' + label + ' —' }),
                ...options.map(o => h('option', { value: o, text: o }))]);
            sel.addEventListener('change', () => {
                if (!sel.value) return;
                P.apply({ [key]: sel.value });
                sel.value = '';
            });
            return sel;
        };
        body.appendChild(this._section('Faisceau', [
            h('div', { class: 'sc-row sc-nowrap' }, [
                mkSelect('Gobo fixe', GOBO_FIXED_WHEEL, 'goboFixed'),
                mkSelect('Gobo rotatif', GOBO_ROT_WHEEL, 'goboRot'),
                mkSelect('Prisme', PRISMS, 'prism'),
            ]),
            this._slider('Zoom', 2, 48, 0.5, 14, v => v.toFixed(1) + '°', v => P.apply({ zoom: v }, { continuous: true })),
            this._slider('Frost', 0, 100, 1, 0, v => v.toFixed(0) + ' %', v => P.apply({ frost: v }, { continuous: true })),
        ], true));

        // ── 6. Effets ──
        this.fxTypeRow = h('div', { class: 'sc-row' });
        for (const [k, t] of Object.entries(FX_TYPES)) {
            const b = h('button', { class: 'sc-btn', text: t.label, onclick: () => { this._fxType = k; this._refreshFxControls(); } });
            b.dataset.fx = k;
            this.fxTypeRow.appendChild(b);
        }
        this.fxAmpRow = this._slider('Amplitude', 0, 1, 1, 0, v => String(v), v => { this._fxAmp[this._fxType] = v; });
        this.fxSpeedRow = this._slider('Vitesse', 0.05, 2, 0.05, this._fxSpeed, v => v.toFixed(2) + ' Hz', v => { this._fxSpeed = v; });
        this.fxOffsetRow = this._slider('Décalage', 0, 1, 0.01, this._fxOffset, v => v.toFixed(2) + ' s', v => { this._fxOffset = v; });
        const order = h('select', { class: 'sc-select' }, FX_ORDERS.map(o => h('option', { value: o, text: o })));
        order.addEventListener('change', () => { this._fxOrder = order.value; });
        const spread = h('input', { type: 'checkbox' });
        spread.addEventListener('change', () => { this._fxSpread = spread.checked; this._refreshFxControls(); });
        this.fxList = h('div', { class: 'sc-fxlist' });
        body.appendChild(this._section('Effets', [
            this.fxTypeRow,
            this.fxAmpRow,
            this.fxSpeedRow,
            this.fxOffsetRow,
            h('div', { class: 'sc-row sc-nowrap' }, [h('span', { class: 'sc-label', text: 'Ordre' }), order]),
            h('label', { class: 'sc-row', style: 'cursor:pointer' }, [spread,
                h('span', { class: 'sc-hint', text: 'Répartir le décalage sur un cycle complet (vague continue)' })]),
            h('div', { class: 'sc-row' }, [
                h('button', { class: 'sc-btn primary big grow', text: '▶ Lancer sur la sélection', onclick: () => this._startFx() }),
                h('button', { class: 'sc-btn danger big', text: '■ Tout arrêter', onclick: () => this._stopAllFx() }),
            ]),
            this.fxList,
        ]));

        this._refreshFxControls();
        this._refreshGroups();
        this._refreshFxList();
    }

    // ═════════════════════════════════════════════════════════════════════
    // Ouverture / raccourcis / clics 3D
    // ═════════════════════════════════════════════════════════════════════
    _bindGlobal() {
        this.hudBtn = document.getElementById('spot-console-btn');
        if (this.hudBtn) this.hudBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });

        window.addEventListener('keydown', (e) => {
            if (e.code !== 'KeyL' || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
            this.toggle();
        });

        const canvas = this.renderer.domElement;
        let down = null;
        canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });

        // Sélection rectangulaire dans la 3D (menu ouvert) : glisser dans la scène sélectionne les lyres du
        // rectangle ; Ctrl / Maj : ajoute à la sélection
        const rectEl = document.createElement('div');
        rectEl.style.cssText = 'position:fixed;display:none;z-index:9000;pointer-events:none;'
            + 'border:1px solid rgba(255,255,255,0.7);background:rgba(255,255,255,0.06);';
        document.body.appendChild(rectEl);
        let band = null;
        canvas.addEventListener('pointerdown', (e) => {
            if (!this.isOpen || e.button !== 0 || this._aiming) return;
            if (this.listener && this.listener.controls && this.listener.controls.isLocked) return;
            const tc = this.ambiancePanel && this.ambiancePanel.transformControls;
            if (tc && (tc.axis !== null || tc.dragging)) return;   // manipulation du gizmo
            band = { x: e.clientX, y: e.clientY, add: e.ctrlKey || e.metaKey || e.shiftKey, active: false };
        });
        window.addEventListener('pointermove', (e) => {
            if (!band) return;
            if (!band.active && Math.hypot(e.clientX - band.x, e.clientY - band.y) < 6) return;
            band.active = true;
            Object.assign(rectEl.style, {
                display: 'block',
                left: Math.min(band.x, e.clientX) + 'px', top: Math.min(band.y, e.clientY) + 'px',
                width: Math.abs(e.clientX - band.x) + 'px', height: Math.abs(e.clientY - band.y) + 'px',
            });
        });
        window.addEventListener('pointerup', (e) => {
            const b = band;
            band = null;
            rectEl.style.display = 'none';
            if (!b || !b.active) return;
            const r = canvas.getBoundingClientRect();
            const x0 = Math.min(b.x, e.clientX), x1 = Math.max(b.x, e.clientX);
            const y0 = Math.min(b.y, e.clientY), y1 = Math.max(b.y, e.clientY);
            const v = new THREE.Vector3();
            this.camera.updateMatrixWorld();
            const ids = [];
            for (const s of this.spotManager.getAllSpots()) {
                s.group.getWorldPosition(v).project(this.camera);
                if (v.z < -1 || v.z > 1) continue;                    // derrière la caméra
                const sx = r.left + (v.x + 1) / 2 * r.width, sy = r.top + (1 - v.y) / 2 * r.height;
                if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(s.id);
            }
            if (ids.length || !b.add) this.programmer.select(ids, b.add ? 'add' : 'set');
        });
        canvas.addEventListener('click', (e) => {
            if (!this.isOpen || !down) return;
            if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // glisser ≠ clic
            if (this.listener && this.listener.controls && this.listener.controls.isLocked) return;
            if (this.ambiancePanel && this.ambiancePanel.isDraggingGizmo) return;
            if (this._aiming) {
                const p = this.aimTarget.pick(e.clientX, e.clientY, canvas, this.camera);
                if (p) {
                    this.aimTarget.set(p);
                    this.aimTarget.setVisible(true);
                    this.programmer.aimAt(p);
                }
                this._setAiming(false);
                return;
            }
            // Sélection d'une lyre dans la 3D
            const r = canvas.getBoundingClientRect();
            const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
            const ray = new THREE.Raycaster();
            ray.setFromCamera(ndc, this.camera);
            const hits = ray.intersectObjects(this.spotManager.getSpotObjects(), false);
            if (!hits.length) return;
            const spot = this.spotManager.getSpotFromObject(hits[0].object);
            if (!spot) return;
            if (e.shiftKey) this.programmer.selectRange(spot.id);
            else this.programmer.select([spot.id], e.ctrlKey || e.metaKey ? 'toggle' : 'set');
        });
    }

    toggle(force) {
        this.isOpen = force !== undefined ? Boolean(force) : !this.isOpen;
        this.root.classList.toggle('hidden', !this.isOpen);
        if (this.hudBtn) this.hudBtn.classList.toggle('active', this.isOpen);
        if (this.isOpen) {
            if (this.listener && this.listener.controls && this.listener.controls.isLocked) this.listener.unlock();
            this._refreshTiles(true);
            this._refreshFxList();
        } else {
            this._setAiming(false);
            if (this._follow) this._toggleFollow();
        }
        this.aimTarget.setVisible(this.isOpen);
        return this.isOpen;
    }

    _addSpot() {
        if (!this.ambiancePanel) return;
        this.ambiancePanel.addNewLight('🎯 Lyre Spot');
        const s = this.ambiancePanel.selectedSpot;
        if (s) this.programmer.select([s.id], 'add');
    }

    // ═════════════════════════════════════════════════════════════════════
    // Grille de sélection
    // ═════════════════════════════════════════════════════════════════════
    _bindGrid() {
        let start = null;
        let banding = false;
        const tileAt = (el) => el && el.closest ? el.closest('.sc-tile') : null;

        this.grid.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const gr = this.grid.getBoundingClientRect();
            start = { x: e.clientX, y: e.clientY, gx: gr.left, gy: gr.top, tile: tileAt(e.target), ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
            banding = false;
            this.grid.setPointerCapture(e.pointerId);
        });
        this.grid.addEventListener('pointermove', (e) => {
            if (!start) return;
            if (!banding && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) return;
            banding = true;
            const x0 = Math.min(start.x, e.clientX), x1 = Math.max(start.x, e.clientX);
            const y0 = Math.min(start.y, e.clientY), y1 = Math.max(start.y, e.clientY);
            Object.assign(this.band.style, {
                display: 'block',
                left: (x0 - start.gx + this.grid.scrollLeft) + 'px',
                top: (y0 - start.gy + this.grid.scrollTop) + 'px',
                width: (x1 - x0) + 'px',
                height: (y1 - y0) + 'px',
            });
            for (const [, el] of this._tiles) {
                const r = el.getBoundingClientRect();
                el.classList.toggle('banded', r.right > x0 && r.left < x1 && r.bottom > y0 && r.top < y1);
            }
        });
        const end = (e) => {
            if (!start) return;
            const s = start;
            start = null;
            this.band.style.display = 'none';
            if (banding) {
                const ids = [];
                for (const [id, el] of this._tiles) {
                    if (el.classList.contains('banded')) ids.push(id);
                    el.classList.remove('banded');
                }
                this.programmer.select(ids, s.ctrl || s.shift ? 'add' : 'set');
            } else if (s.tile) {
                const id = s.tile.dataset.id;
                if (s.shift) this.programmer.selectRange(id);
                else this.programmer.select([id], s.ctrl ? 'toggle' : 'set');
            } else if (e && e.type === 'pointerup') {
                this.programmer.clear();
            }
        };
        this.grid.addEventListener('pointerup', end);
        this.grid.addEventListener('pointercancel', () => { start = null; this.band.style.display = 'none'; });
    }

    _refreshTiles(full) {
        const P = this.programmer;
        const spots = P.allSpots();
        if (full || spots.length !== this._tileCount || spots.some(s => !this._tiles.has(s.id))) {
            this._tileCount = spots.length;
            this._tiles.clear();
            this.grid.textContent = '';
            if (!spots.length) {
                this.grid.appendChild(h('div', { class: 'sc-empty', text: 'Aucune lyre dans la scène. Clique « ＋ Lyre » pour en poser une devant toi.' }));
            }
            for (const s of spots) {
                const tile = h('div', { class: 'sc-tile' }, [
                    h('span', { class: 'sc-tile-num', text: String(s.number) }),
                    h('span', { class: 'sc-tile-dot' }),
                    h('span', { class: 'sc-tile-fx' }),
                    h('div', { class: 'sc-tile-bar' }, [h('i')]),
                ]);
                tile.dataset.id = s.id;
                this._tiles.set(s.id, tile);
                this.grid.appendChild(tile);
            }
            this.grid.appendChild(this.band);
        }
        let fxIds = null;
        for (const fx of this.effects.list()) {
            fxIds = fxIds || new Set();
            for (const id of fx.ids) fxIds.add(id);
        }
        for (const s of spots) {
            const el = this._tiles.get(s.id);
            if (!el) continue;
            const p = s.params;
            el.classList.toggle('selected', P.selection.has(s.id));
            el.classList.toggle('dmx', s.dmxControlled);
            el.title = `Lyre #${s.number} — univers ${p.dmxUniverse}, adresse ${p.dmxAddress}${s.dmxControlled ? ' (pilotée par le DMX)' : ''}`;
            const dot = el.children[1];
            const col = displayColor(p);
            dot.style.background = col;
            dot.style.color = col;
            el.children[2].textContent = fxIds && fxIds.has(s.id) ? 'FX' : '';
            el.children[3].firstChild.style.width = clamp(p.dimmer, 0, 100) + '%';
        }
        const nSel = P.selected().length;
        this.countEl.textContent = `${nSel} / ${spots.length}`;
        if (full) this._syncFromSelection();
    }

    _refreshGroups() {
        const P = this.programmer;
        [...this.groupRow.children].forEach((b, i) => {
            const n = P.groupSize(i);
            b.classList.toggle('filled', n > 0);
            b.textContent = 'G' + (i + 1);
            if (n > 0) b.appendChild(h('small', { text: String(n) }));
        });
    }

    /** Reporte les valeurs de la première lyre sélectionnée dans les faders */
    _syncFromSelection() {
        const first = this.programmer.selected()[0];
        if (first) this._syncDimmer(first.params.dimmer);
        this.strobeBtn.classList.toggle('active', Boolean(first && first.params.shutter === 'Strobe'));
    }

    _syncDimmer(v) {
        this.dimRow._input.value = v;
        this.dimRow._val.textContent = Math.round(v) + ' %';
    }

    // ═════════════════════════════════════════════════════════════════════
    // Intensité
    // ═════════════════════════════════════════════════════════════════════
    _flash(on) {
        const P = this.programmer;
        if (on) {
            const spots = P.editable();
            if (!spots.length) return;
            this._flashSnap = spots.map(s => ({ s, dimmer: s.params.dimmer, shutter: s.params.shutter }));
            P.apply({ dimmer: 100, shutter: 'Ouvert' }, { spots });
        } else if (this._flashSnap) {
            const snap = this._flashSnap;
            this._flashSnap = null;
            P.apply(s => {
                const e = snap.find(x => x.s === s);
                return e ? { dimmer: e.dimmer, shutter: e.shutter } : null;
            }, { spots: snap.map(e => e.s) });
        }
    }

    _toggleStrobe() {
        const spots = this.programmer.editable();
        if (!spots.length) return;
        const on = !spots.some(s => s.params.shutter === 'Strobe');
        this.programmer.apply(on ? { shutter: 'Strobe', shutterSpeed: Math.max(40, spots[0].params.shutterSpeed) } : { shutter: 'Ouvert' });
        this.strobeBtn.classList.toggle('active', on);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Position
    // ═════════════════════════════════════════════════════════════════════
    _setAiming(on) {
        this._aiming = Boolean(on);
        this.aimBtn.classList.toggle('active', this._aiming);
        this.aimBtn.textContent = this._aiming ? '🎯 Clique dans la scène…' : '🎯 Viser un point';
        document.body.classList.toggle('sc-aiming', this._aiming);
        if (this._aiming && this.listener && this.listener.controls && this.listener.controls.isLocked) this.listener.unlock();
    }

    _toggleFollow() {
        if (this._follow) {
            this._follow = null;
        } else {
            const spots = this.programmer.editable();
            if (!spots.length || !this.listener) return;
            this._follow = { spots, t: 0 };
        }
        this.followBtn.classList.toggle('active', Boolean(this._follow));
    }

    _bindPad() {
        const dot = this.pad.querySelector('.sc-pad-dot');
        let drag = null;
        this.pad.addEventListener('pointerdown', (e) => {
            const spots = this.programmer.editable();
            if (!spots.length) return;
            drag = { x: e.clientX, y: e.clientY, base: spots.map(s => ({ s, pan: s.params.pan, tilt: s.params.tilt })) };
            this.pad.setPointerCapture(e.pointerId);
        });
        this.pad.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            const r = this.pad.getBoundingClientRect();
            dot.style.left = clamp(50 + (dx / r.width) * 100, 0, 100) + '%';
            dot.style.top = clamp(50 + (dy / r.height) * 100, 0, 100) + '%';
            const base = drag.base;
            this.programmer.apply(s => {
                const b = base.find(x => x.s === s);
                return b ? {
                    pan: Math.round(clamp(b.pan + dx * 1.2, -HALF_PAN, HALF_PAN) * 10) / 10,
                    tilt: Math.round(clamp(b.tilt - dy * 0.8, -HALF_TILT, HALF_TILT) * 10) / 10,
                } : null;
            }, { continuous: true, spots: base.map(b => b.s) });
        });
        const end = () => {
            drag = null;
            dot.style.left = '50%';
            dot.style.top = '50%';
        };
        this.pad.addEventListener('pointerup', end);
        this.pad.addEventListener('pointercancel', end);
    }

    _fanStart() {
        const spots = this.programmer.ordered(this.programmer.editable(), 'Gauche → droite');
        this._fanBase = spots.map(s => ({ s, pan: s.params.pan }));
    }

    _fan(v) {
        if (!this._fanBase) this._fanStart();
        const base = this._fanBase;
        const n = base.length;
        this.programmer.apply((s) => {
            const i = base.findIndex(b => b.s === s);
            if (i < 0) return null;
            const k = n > 1 ? (i / (n - 1)) * 2 - 1 : 0;
            return { pan: Math.round(clamp(base[i].pan + v * k, -HALF_PAN, HALF_PAN) * 10) / 10 };
        }, { continuous: true, spots: base.map(b => b.s) });
    }

    _fanEnd() {
        this._fanBase = null;
        this.fanRow._input.value = 0;
        this.fanRow._val.textContent = '0°';
    }

    // ═════════════════════════════════════════════════════════════════════
    // Effets
    // ═════════════════════════════════════════════════════════════════════
    _refreshFxControls() {
        const t = FX_TYPES[this._fxType];
        for (const b of this.fxTypeRow.children) b.classList.toggle('active', b.dataset.fx === this._fxType);
        const inp = this.fxAmpRow._input;
        inp.min = t.amp.min;
        inp.max = t.amp.max;
        inp.step = t.amp.step;
        inp.value = this._fxAmp[this._fxType];
        this.fxAmpRow._label.textContent = t.ampLabel;
        this.fxAmpRow._val.textContent = String(this._fxAmp[this._fxType]);
        this.fxOffsetRow.style.opacity = this._fxSpread ? 0.4 : 1;
        this.fxOffsetRow._input.disabled = this._fxSpread;
    }

    _startFx() {
        const P = this.programmer;
        const spots = P.ordered(P.editable(), this._fxOrder);
        if (!spots.length) return;
        const def = {
            id: 'fx-' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
            type: this._fxType,
            ids: spots.map(s => s.id),
            amp: this._fxAmp[this._fxType],
            speed: this._fxSpeed,
            offset: this._fxOffset,
            spread: this._fxSpread,
            start: this.spotManager.clock(),
        };
        this.effects.start(def);
        P._emit({ category: 'spot_fx', action: 'start', fx: def, immediate: true });
    }

    _stopFx(id) {
        this.effects.stop(id);
        this.programmer._emit({ category: 'spot_fx', action: 'stop', id, immediate: true });
    }

    _stopAllFx() {
        this.effects.stopAll();
        this.programmer._emit({ category: 'spot_fx', action: 'stopAll', immediate: true });
    }

    _refreshFxList() {
        if (!this.fxList) return;
        this.fxList.textContent = '';
        const list = this.effects.list();
        if (!list.length) {
            this.fxList.appendChild(h('div', { class: 'sc-hint', text: 'Aucun effet en cours.' }));
            return;
        }
        for (const fx of list) {
            const t = FX_TYPES[fx.type];
            const unit = fx.type === 'dimmerWave' || fx.type === 'colorChase' ? ' %' : '°';
            const delay = fx.spread ? 'réparti' : fx.offset.toFixed(2) + ' s';
            this.fxList.appendChild(h('div', { class: 'sc-fxitem' }, [
                h('span', { text: `${t.label} · ${fx.ids.length} lyres · ${fx.amp}${unit} · ${fx.speed.toFixed(2)} Hz · décalage ${delay}` }),
                h('button', { class: 'sc-btn danger', text: '■', title: 'Arrêter cet effet', onclick: () => this._stopFx(fx.id) }),
            ]));
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Boucle
    // ═════════════════════════════════════════════════════════════════════
    _update(dt) {
        // Suivi du joueur : nouvelle visée 10 fois par seconde (les moteurs lissent le mouvement)
        if (this._follow && this.listener) {
            this._follow.t += dt;
            if (this._follow.t >= 0.1) {
                this._follow.t = 0;
                const pos = this.listener.position.clone();
                pos.y += 1.0;
                const spots = this._follow.spots.filter(s => this.spotManager.getSpot(s.id));
                if (spots.length) this.programmer.aimAt(pos, { continuous: true, spots });
            }
        }
        this.highlight.update(this.isOpen ? this.programmer.selected() : [], this.isOpen);
    }
}
