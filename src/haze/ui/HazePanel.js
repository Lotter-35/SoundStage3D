/**
 * HazePanel.js
 * ─────────────────────────────────────────────────────────────
 * Panneau « 🌫️ Brouillard de salle » (ouvert depuis le menu Ambiance) :
 *   - réglages de la fumée, des sources, de la boîte et de la qualité (schéma hazeParams.js)
 *   - affichage de la boîte, déplacement au gizmo, recalage sur l'espace public
 *   - synchronisation multijoueur (sauf réglages de qualité, propres à chaque machine)
 * ─────────────────────────────────────────────────────────────
 */

import GUI from 'lil-gui';
import { makeDraggable } from '../../ui/draggable.js';
import { HAZE_PARAMS_SCHEMA, HAZE_FOLDERS, HAZE_LOCAL_KEYS } from '../hazeParams.js';

const BOX_KEYS = ['boxX', 'boxY', 'boxZ', 'sizeX', 'sizeY', 'sizeZ', 'edge'];

export class HazePanel {
    /**
     * @param {object} o
     * @param {import('../HazeVolume.js').HazeVolume} o.haze
     * @param {import('../../ui/AmbiancePanel.js').AmbiancePanel} o.ambiancePanel
     */
    constructor({ haze, ambiancePanel }) {
        this.haze = haze;
        this.ambiancePanel = ambiancePanel;
        this.wrap = document.createElement('div');
        this.wrap.id = 'haze-panel-wrap';
        this.wrap.className = 'hidden';
        this.container = document.createElement('div');
        this.container.id = 'haze-panel';
        this.wrap.appendChild(this.container);
        document.body.appendChild(this.wrap);
        for (const ev of ['pointerdown', 'mousedown', 'click', 'wheel']) this.wrap.addEventListener(ev, e => e.stopPropagation());

        this.gui = null;
        this.controllers = {};
        this._ui = { showBox: false, gizmo: false };

        // Gizmo : déplacement de la boîte par sa poignée centrale
        const tc = ambiancePanel && ambiancePanel.transformControls;
        if (tc) {
            tc.addEventListener('objectChange', () => {
                if (tc.object !== this.haze.handle) return;
                this.haze.syncFromHandle();
                this.syncFromVolume();
                const p = this.haze.params;
                this._emit({ boxX: p.boxX, boxY: p.boxY, boxZ: p.boxZ });
            });
        }
    }

    get isOpen() {
        return !this.wrap.classList.contains('hidden');
    }

    toggle(force) {
        const open = force !== undefined ? Boolean(force) : !this.isOpen;
        this.wrap.classList.toggle('hidden', !open);
        if (open) {
            this._build();
        } else {
            this._setGizmo(false);
            this.haze.setBoxVisible(false);
            this._ui.showBox = false;
            if (this.gui) { this.gui.destroy(); this.gui = null; }
        }
        return open;
    }

    _emit(data) {
        const shared = {};
        for (const [k, v] of Object.entries(data)) if (!HAZE_LOCAL_KEYS.has(k)) shared[k] = v;
        if (!Object.keys(shared).length) return;
        if (this.ambiancePanel && typeof this.ambiancePanel._emitSync === 'function') {
            this.ambiancePanel._emitSync({ category: 'haze', data: shared });
        }
    }

    _set(key, value) {
        this.haze.setParam(key, value);
        this._emit({ [key]: value });
    }

    /** Rafraîchit les contrôles (réseau, gizmo) */
    syncFromVolume() {
        if (!this.gui) return;
        for (const c of Object.values(this.controllers)) {
            try { c.updateDisplay(); } catch (_) {}
        }
    }

    _setGizmo(on) {
        const tc = this.ambiancePanel && this.ambiancePanel.transformControls;
        this._ui.gizmo = Boolean(on);
        if (!tc) return;
        if (on) {
            if (this.ambiancePanel.deselectLight) this.ambiancePanel.deselectLight();
            tc.detach();
            tc.setMode('translate');
            tc.attach(this.haze.handle);
            tc.visible = true;
            tc.enabled = true;
            this.haze.setBoxVisible(true);
            this._ui.showBox = true;
        } else if (tc.object === this.haze.handle) {
            tc.detach();
            tc.visible = false;
            tc.enabled = false;
        }
        if (this.controllers._showBox) this.controllers._showBox.updateDisplay();
        if (this.controllers._gizmo) this.controllers._gizmo.updateDisplay();
    }

    _resetKeys(keys) {
        const data = {};
        for (const k of keys) data[k] = HAZE_PARAMS_SCHEMA[k].value;
        this.haze.setParams(data);
        this._emit(data);
        this.syncFromVolume();
    }

    _build() {
        if (this.gui) this.gui.destroy();
        this.controllers = {};
        const p = this.haze.params;
        const title = '🌫️ Brouillard de salle';
        this.gui = new GUI({ container: this.container, title, autoPlace: false, width: 340 });

        // Titre : reset + fermeture (même DA que les autres panneaux)
        const titleEl = this.gui.domElement.querySelector('.title');
        if (titleEl) {
            titleEl.textContent = '';
            const text = document.createElement('span');
            text.className = 'lil-panel-title-text';
            text.textContent = title;
            const reset = document.createElement('span');
            reset.className = 'lil-panel-reset-btn';
            reset.textContent = '↺ Tout reset';
            reset.title = 'Réinitialiser tous les réglages du brouillard';
            reset.addEventListener('click', (e) => { e.stopPropagation(); this._resetKeys(Object.keys(HAZE_PARAMS_SCHEMA)); });
            const close = document.createElement('span');
            close.className = 'lil-panel-close-btn';
            close.textContent = '✕';
            close.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(false); });
            for (const el of [reset, close]) ['mousedown', 'pointerdown'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
            titleEl.append(text, reset, close);
            makeDraggable(this.wrap, titleEl, 'haze');
        }

        const folders = {};
        for (const f of HAZE_FOLDERS) {
            folders[f.id] = this.gui.addFolder(f.title);
            if (f.id !== 'main') folders[f.id].close();
        }

        for (const [key, s] of Object.entries(HAZE_PARAMS_SCHEMA)) {
            const folder = folders[s.folder];
            let ctrl;
            if (s.options) ctrl = folder.add(p, key, s.options);
            else if (s.color) ctrl = folder.addColor(p, key);
            else if (typeof s.value === 'boolean') ctrl = folder.add(p, key);
            else ctrl = folder.add(p, key, s.min, s.max, s.step);
            ctrl.name(s.label).onChange(v => this._set(key, v));
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lil-reset-btn';
            btn.textContent = '↺';
            btn.title = 'Réinitialiser ce paramètre';
            btn.addEventListener('click', (e) => { e.stopPropagation(); ctrl.setValue(s.value); });
            (ctrl.domElement.querySelector('.widget') || ctrl.domElement).appendChild(btn);
            this.controllers[key] = ctrl;
        }

        // Outils de la boîte (locaux)
        const fBox = folders.box;
        this.controllers._showBox = fBox.add(this._ui, 'showBox').name('Afficher la boîte').onChange(v => this.haze.setBoxVisible(v));
        this.controllers._gizmo = fBox.add(this._ui, 'gizmo').name('Déplacer au gizmo').onChange(v => this._setGizmo(v));
        fBox.add({ fit: () => this._resetKeys(BOX_KEYS) }, 'fit').name('↺ Recaler sur l\'espace public');
    }
}
