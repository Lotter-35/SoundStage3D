/**
 * Laser2InspectorPanel.js
 * ─────────────────────────────────────────────────────────────
 * Panneau d'options d'un nouveau laser (même DA que les lyres et barres LED) :
 *   - construit depuis LASER2_PARAMS_SCHEMA (1 dossier par famille)
 *   - couleur : sélecteur de couleur classique (stockée en RGB dans le code)
 *   - modèle de boîtier : applique sa fiche technique ; modifier une valeur → « Personnalisé »
 *   - aperçu 2D du tracé (comme la fenêtre de prévisualisation d'un logiciel laser) :
 *     consigne envoyée aux galvos (gris) et trajectoire réelle des miroirs (couleur émise)
 *   - informations : points par image, images/s (scintillement), primitives
 *   - chaque modification est synchronisée en multijoueur (laser2_update)
 * ─────────────────────────────────────────────────────────────
 */

import GUI from 'lil-gui';
import { makeDraggable } from '../../ui/draggable.js';
import { LASER2_PARAMS_SCHEMA, LASER2_FOLDERS, HARDWARE_PRESETS } from '../config/laser2Params.js';
import { RING } from '../Laser2Scanner.js';

const PER_FIXTURE_FOLDERS = new Set(['place']);
const HARDWARE_KEYS = new Set(['powerR', 'powerG', 'powerB', 'scanner', 'divergence', 'aperture']);
const PREVIEW = 232;

export class Laser2InspectorPanel {
    /**
     * @param {object} o
     * @param {import('../Laser2Manager.js').Laser2Manager} o.laser2Manager
     * @param {import('../../ui/AmbiancePanel.js').AmbiancePanel} o.ambiancePanel
     */
    constructor({ laser2Manager, ambiancePanel }) {
        this.laser2Manager = laser2Manager;
        this.ambiancePanel = ambiancePanel;
        this.panelWrap = document.getElementById('laser2-panel-wrap');
        this.panelContainer = document.getElementById('laser2-panel');
        this.gui = null;
        this._laser = null;
        this.controllers = {};
        this._gizmoMode = 'translate';
        this._timer = null;
    }

    get isOpen() {
        return this._laser !== null && this.panelWrap && !this.panelWrap.classList.contains('hidden');
    }

    get currentLaserId() {
        return this._laser ? this._laser.id : null;
    }

    openForLaser(laser) {
        this._laser = laser;
        if (this.panelWrap) this.panelWrap.classList.remove('hidden');
        this._buildGui();
        clearInterval(this._timer);
        this._timer = setInterval(() => this._tick(), 100);
    }

    close() {
        clearInterval(this._timer);
        this._timer = null;
        if (this.gui) {
            this.gui.destroy();
            this.gui = null;
        }
        if (this.panelWrap) this.panelWrap.classList.add('hidden');
        this._laser = null;
        this.controllers = {};
    }

    /** Rafraîchit tous les contrôles depuis l'état du laser (gizmo, réseau) */
    syncFromLaser() {
        if (!this.gui || !this._laser) return;
        for (const c of Object.values(this.controllers)) {
            try { c.updateDisplay(); } catch (_) {}
        }
        this._refreshVisibility();
    }

    _emit(payload) {
        if (this.ambiancePanel && typeof this.ambiancePanel._emitSync === 'function') {
            this.ambiancePanel._emitSync(payload);
        }
    }

    _setParam(key, value) {
        const laser = this._laser;
        if (!laser) return;
        const data = { [key]: value };
        // Une valeur de fiche technique modifiée à la main : le modèle devient « Personnalisé »
        if (HARDWARE_KEYS.has(key) && laser.params.preset !== 'Personnalisé') data.preset = 'Personnalisé';
        if (key === 'preset' && HARDWARE_PRESETS[value]) Object.assign(data, HARDWARE_PRESETS[value]);
        laser.setParams(data);
        this._emit({ category: 'laser2_update', id: laser.id, data });
        if (Object.keys(data).length > 1) this.syncFromLaser();
        this._refreshVisibility();
    }

    _addResetButton(ctrl, onReset) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lil-reset-btn';
        btn.title = 'Réinitialiser ce paramètre (↺)';
        btn.innerHTML = '↺';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            onReset();
        });
        const widget = ctrl.domElement.querySelector('.widget');
        (widget || ctrl.domElement).appendChild(btn);
    }

    resetAll() {
        const laser = this._laser;
        if (!laser) return;
        const data = {};
        for (const [k, s] of Object.entries(LASER2_PARAMS_SCHEMA)) {
            if (PER_FIXTURE_FOLDERS.has(s.folder)) continue;   // position conservée
            data[k] = s.value;
        }
        laser.setParams(data);
        this._emit({ category: 'laser2_update', id: laser.id, data });
        this.syncFromLaser();
    }

    _buildTitle(title) {
        const titleEl = this.gui.domElement.querySelector('.title');
        if (!titleEl) return;
        titleEl.textContent = '';
        const text = document.createElement('span');
        text.className = 'lil-panel-title-text';
        text.textContent = title;
        titleEl.appendChild(text);

        const stop = (el) => ['mousedown', 'mouseup', 'pointerdown', 'pointerup'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));

        const resetBtn = document.createElement('span');
        resetBtn.setAttribute('role', 'button');
        resetBtn.className = 'lil-panel-reset-btn';
        resetBtn.title = 'Réinitialiser les réglages du laser (position conservée)';
        resetBtn.textContent = '↺ Tout reset';
        resetBtn.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); this.resetAll(); });
        stop(resetBtn);
        titleEl.appendChild(resetBtn);

        const closeBtn = document.createElement('span');
        closeBtn.setAttribute('role', 'button');
        closeBtn.className = 'lil-panel-close-btn';
        closeBtn.title = 'Fermer l\'inspecteur (Échap)';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.close();
            if (this.ambiancePanel) this.ambiancePanel.deselectSpot();
        });
        stop(closeBtn);
        titleEl.appendChild(closeBtn);

        makeDraggable(this.panelWrap, titleEl, 'laser2');
    }

    _buildGui() {
        if (this.gui) this.gui.destroy();
        this.controllers = {};
        const laser = this._laser;
        if (!laser) return;
        const p = laser.params;

        const title = `🔦 Laser #${laser.number}`;
        this.gui = new GUI({ container: this.panelContainer, title, autoPlace: false, width: 340 });
        this._buildTitle(title);

        this._buildPreview();

        const folders = {};
        for (const f of LASER2_FOLDERS) {
            const folder = this.gui.addFolder(f.title);
            if (f.power && folder.domElement) folder.domElement.classList.add('power-folder');
            if (f.id === 'place' || f.id === 'hardware' || f.id === 'render') folder.close();
            folders[f.id] = folder;
        }

        const gizmo = { mode: this._gizmoMode === 'rotate' ? 'Rotation' : 'Translation' };
        folders.place.add(gizmo, 'mode', ['Translation', 'Rotation']).name('Mode Gizmo').onChange((mode) => {
            this._gizmoMode = mode === 'Rotation' ? 'rotate' : 'translate';
            if (this.ambiancePanel && this.ambiancePanel.transformControls) {
                this.ambiancePanel.transformControls.setMode(this._gizmoMode);
            }
        });

        for (const [key, s] of Object.entries(LASER2_PARAMS_SCHEMA)) {
            const folder = folders[s.folder];
            if (!folder) continue;
            let ctrl;
            if (s.options) ctrl = folder.add(p, key, s.options);
            else if (s.color) ctrl = folder.addColor(p, key);
            else if (typeof s.value === 'boolean') ctrl = folder.add(p, key);
            else ctrl = folder.add(p, key, s.min, s.max, s.step);
            ctrl.name(s.label).onChange(v => this._setParam(key, v));
            this._addResetButton(ctrl, () => ctrl.setValue(s.value));
            this.controllers[key] = ctrl;
        }

        const fActions = this.gui.addFolder('⚙️ Actions');
        const actions = {
            duplicate: () => this.ambiancePanel && this.ambiancePanel.duplicateSelectedSpot(laser),
            remove: () => this.ambiancePanel && this.ambiancePanel.deleteSelectedSpot(laser),
        };
        fActions.add(actions, 'duplicate').name('📋 Dupliquer');
        fActions.add(actions, 'remove').name('🗑️ Supprimer');

        this._refreshVisibility();
    }

    // ── Aperçu 2D ────────────────────────────────────────────────────────
    _buildPreview() {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'padding:8px 8px 4px;display:flex;flex-direction:column;align-items:center;gap:4px;';
        const cv = document.createElement('canvas');
        cv.width = PREVIEW; cv.height = PREVIEW;
        cv.style.cssText = `width:${PREVIEW}px;height:${PREVIEW}px;background:#05060a;border:1px solid rgba(255,255,255,0.12);border-radius:6px;`;
        cv.title = 'Gris : consigne envoyée aux galvos · Couleur : trajectoire réelle des miroirs (laser allumé)';
        const info = document.createElement('div');
        info.style.cssText = 'font:11px/1.45 ui-monospace,Consolas,monospace;color:#b8c2d6;text-align:center;';
        wrap.appendChild(cv);
        wrap.appendChild(info);
        const children = this.gui.domElement.querySelector('.children');
        (children || this.gui.domElement).prepend(wrap);
        this._cv = cv;
        this._ctx = cv.getContext('2d');
        this._info = info;
    }

    _drawPreview() {
        const laser = this._laser;
        const c = this._ctx;
        if (!laser || !c) return;
        const s = laser.scanner;
        const W = PREVIEW;
        c.fillStyle = '#05060a';
        c.fillRect(0, 0, W, W);
        // Cadre de l'angle de balayage maximal
        c.strokeStyle = 'rgba(255,255,255,0.08)';
        c.lineWidth = 1;
        c.strokeRect(6.5, 6.5, W - 13, W - 13);
        if (!Number.isFinite(s.k)) return;
        const win = Math.min(s.frame.n * 2, Math.round(s.pps / 25), RING - 64);
        const k1 = s.k, k0 = k1 - win + 1;
        const sc = (W / 2 - 7) / Math.max(1e-3, s.maxAngle);
        const cx = W / 2, cy = W / 2;
        const M = RING - 1;
        c.strokeStyle = 'rgba(150,160,180,0.35)';
        c.beginPath();
        for (let k = k0; k <= k1; k++) {
            const o = k & M;
            const X = cx + s.ux[o] * sc, Y = cy - s.uy[o] * sc;
            if (k === k0) c.moveTo(X, Y); else c.lineTo(X, Y);
        }
        c.stroke();
        c.lineWidth = 1.6;
        c.lineCap = 'round';
        for (let k = k0 + 1; k <= k1; k++) {
            const o = k & M, q = (k - 1) & M;
            const r = s.pr[o], g = s.pg[o], b = s.pb[o];
            const m = Math.max(r, g, b);
            if (m <= 1e-6) continue;
            c.strokeStyle = `rgb(${Math.round(80 + 175 * (r + g * 0.05 + b * 0.12) / m)},${Math.round(80 + 175 * (g + r * 0.03 + b * 0.02) / m)},${Math.round(80 + 175 * (b + g * 0.15) / m)})`;
            c.beginPath();
            c.moveTo(cx + s.ax[q] * sc, cy - s.ay[q] * sc);
            c.lineTo(cx + s.ax[o] * sc, cy - s.ay[o] * sc);
            c.stroke();
        }
        const st = s.stats;
        const hz = st.frameHz;
        const flicker = hz < 20 ? ' <span style="color:#ff8a65">⚠ scintille</span>' : '';
        this._info.innerHTML = `${st.points} points · <b>${hz.toFixed(0)} images/s</b>${flicker}<br>`
            + `${st.beams} faisceaux · ${st.sheets} nappes · ${(this.laser2Manager.cpuMs || 0).toFixed(2)} ms`;
    }

    _show(key, visible) {
        const c = this.controllers[key];
        if (!c) return;
        if (visible) c.show(); else c.hide();
    }

    /** Masque les réglages sans effet dans la configuration courante */
    _refreshVisibility() {
        const p = this._laser && this._laser.params;
        if (!p) return;
        const beams = p.pattern === 'Faisceaux (éventail)' || p.pattern === 'Nappe + faisceaux';
        this._show('beamCount', beams);
        this._show('beamDwell', beams || p.pattern === 'Point fixe');
        this._show('strobeRate', p.shutter === 'Strobe');
        this._show('threshold', p.modulation === 'Analogique');
    }

    _tick() {
        if (!this._laser) return;
        if (!this.laser2Manager.getLaser(this._laser.id)) { this.close(); return; }
        this._drawPreview();
    }
}
