/**
 * SpotInspectorPanel.js
 * ─────────────────────────────────────────────────────────────
 * Panneau d'options d'une lyre Spot (même DA que les inspecteurs Laser et Strobe) :
 *   - construit automatiquement depuis SPOT_PARAMS_SCHEMA (1 dossier par famille)
 *   - bouton ↺ par paramètre + « Tout reset »
 *   - DMX : patch (univers / adresse / mode), plage de canaux, conflits,
 *     moniteur des valeurs DMX équivalentes aux réglages courants
 *   - Contrôle : routines de reset (Pan/Tilt, effets, complet)
 *   - Rendu global (toutes les lyres) : fumée, qualité, éclairage réel, ombres
 *   - chaque modification est synchronisée en multijoueur (spot_update / spot_action / spot_global)
 * ─────────────────────────────────────────────────────────────
 */

import GUI from 'lil-gui';
import { makeDraggable } from '../../ui/draggable.js';
import {
    SPOT_PARAMS_SCHEMA, SPOT_FOLDERS, SPOT_GLOBAL_SCHEMA, SPOT_LOCAL_GLOBALS
} from '../config/spotParams.js';
import { describeChannels, encode, getFootprint } from '../SpotProfile.js';

/** Réglages propres à chaque lyre : jamais recopiés sur la sélection (sinon toutes au même endroit / même adresse) */
const PER_FIXTURE_FOLDERS = new Set(['place', 'dmx']);

export class SpotInspectorPanel {
    /**
     * @param {object} o
     * @param {import('../SpotManager.js').SpotManager} o.spotManager
     * @param {import('../../ui/AmbiancePanel.js').AmbiancePanel} o.ambiancePanel
     */
    constructor({ spotManager, ambiancePanel }) {
        this.spotManager = spotManager;
        this.ambiancePanel = ambiancePanel;
        this.panelWrap = document.getElementById('spot-panel-wrap');
        this.panelContainer = document.getElementById('spot-panel');
        this.gui = null;
        this._spot = null;
        this.controllers = {};
        this._globalCtrls = {};
        this._gizmoMode = 'translate';
        this._timer = null;
        this._monitorEl = null;
        this._patchInfoEl = null;
        this._linkEnabled = true;   // réglages appliqués à toute la sélection de la console
        this._linkEl = null;
    }

    get isOpen() {
        return this._spot !== null && this.panelWrap && !this.panelWrap.classList.contains('hidden');
    }

    get currentSpotId() {
        return this._spot ? this._spot.id : null;
    }

    openForSpot(spot) {
        this._spot = spot;
        if (this.panelWrap) this.panelWrap.classList.remove('hidden');
        this._buildGui();
        clearInterval(this._timer);
        this._timer = setInterval(() => this._tick(), 200);
    }

    close() {
        clearInterval(this._timer);
        this._timer = null;
        if (this.gui) {
            this.gui.destroy();
            this.gui = null;
        }
        if (this.panelWrap) this.panelWrap.classList.add('hidden');
        this._spot = null;
        this.controllers = {};
        this._globalCtrls = {};
        this._monitorEl = null;
        this._patchInfoEl = null;
    }

    /** Rafraîchit tous les contrôles depuis l'état de la lyre (gizmo, réseau, DMX) */
    syncFromSpot() {
        if (!this.gui || !this._spot) return;
        for (const c of Object.values(this.controllers)) {
            try { c.updateDisplay(); } catch (_) {}
        }
        for (const c of Object.values(this._globalCtrls)) {
            try { c.updateDisplay(); } catch (_) {}
        }
        this._refreshVisibility();
        this._refreshPatchInfo();
    }

    _emit(payload) {
        if (this.ambiancePanel && typeof this.ambiancePanel._emitSync === 'function') {
            this.ambiancePanel._emitSync(payload);
        }
    }

    /**
     * Lyres liées : si la lyre ouverte fait partie de la sélection de la console (Lyres)
     * et que la sélection en compte plusieurs, les réglages s'appliquent à toutes.
     * @returns {import('../SpotFixture.js').SpotFixture[]|null}
     */
    _linkedSpots() {
        const P = this.spotManager.programmer;
        const spot = this._spot;
        if (!P || !spot || !P.selection.has(spot.id)) return null;
        const list = P.editable();
        if (list.length < 2) return null;
        if (!list.includes(spot)) list.push(spot);
        return list;
    }

    _setParam(key, value) {
        const spot = this._spot;
        if (!spot) return;
        const schema = SPOT_PARAMS_SCHEMA[key];
        const linked = this._linkEnabled && schema && !PER_FIXTURE_FOLDERS.has(schema.folder) ? this._linkedSpots() : null;
        if (linked) {
            // Toute la sélection en un seul message réseau (limité en fréquence pendant un glissé)
            this.spotManager.programmer.apply({ [key]: value }, { spots: linked, continuous: typeof value === 'number' });
        } else {
            spot.setParam(key, value);
            this._emit({ category: 'spot_update', id: spot.id, data: { [key]: value } });
        }
        if (key.startsWith('dmx')) this._refreshPatchInfo();
        this._refreshVisibility();
    }

    /** Bandeau « réglages appliqués à N lyres » (visible seulement si la lyre est dans une sélection multiple) */
    _refreshLinkBanner() {
        if (!this._linkEl) return;
        const P = this.spotManager.programmer;
        const inSel = Boolean(P && this._spot && P.selection.has(this._spot.id));
        const n = inSel ? P.editable().length : 0;
        const show = inSel && n >= 2;
        this._linkEl.style.display = show ? 'flex' : 'none';
        if (show) {
            this._linkText.textContent = `Appliquer à la sélection de la console (${n} lyres)`;
            this._linkBox.checked = this._linkEnabled;
            this._linkEl.style.background = this._linkEnabled ? 'rgba(56,189,248,0.16)' : 'rgba(255,255,255,0.04)';
        }
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
        const spot = this._spot;
        if (!spot) return;
        const data = {};
        for (const [k, s] of Object.entries(SPOT_PARAMS_SCHEMA)) {
            // La position et le patch DMX sont conservés (« tout reset » = réglages de la machine)
            if (PER_FIXTURE_FOLDERS.has(s.folder)) continue;
            data[k] = s.value;
        }
        const linked = this._linkEnabled ? this._linkedSpots() : null;
        if (linked) {
            this.spotManager.programmer.apply({ ...data }, { spots: linked });
        } else {
            spot.setParams(data);
            this._emit({ category: 'spot_update', id: spot.id, data });
        }
        this.syncFromSpot();
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
        resetBtn.title = 'Réinitialiser les réglages de la lyre (position et patch conservés)';
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

        makeDraggable(this.panelWrap, titleEl, 'spot');
    }

    _buildGui() {
        if (this.gui) this.gui.destroy();
        this.controllers = {};
        this._globalCtrls = {};
        const spot = this._spot;
        if (!spot) return;
        const p = spot.params;

        const title = `🎯 Lyre Spot #${spot.number}`;
        this.gui = new GUI({ container: this.panelContainer, title, autoPlace: false, width: 340 });
        this._buildTitle(title);

        // Bandeau de liaison avec la sélection de la console des lyres
        this._linkEl = document.createElement('label');
        this._linkEl.style.cssText = 'display:none;align-items:center;gap:8px;margin:6px 8px;padding:6px 8px;border-radius:6px;border:1px solid rgba(56,189,248,0.45);font-size:11px;color:#e0f2fe;cursor:pointer;';
        this._linkBox = document.createElement('input');
        this._linkBox.type = 'checkbox';
        this._linkBox.checked = this._linkEnabled;
        this._linkBox.addEventListener('change', () => {
            this._linkEnabled = this._linkBox.checked;
            this._refreshLinkBanner();
        });
        this._linkText = document.createElement('span');
        this._linkEl.append('🔗', this._linkBox, this._linkText);
        this.gui.$children.prepend(this._linkEl);
        this._refreshLinkBanner();

        // Dossiers
        const folders = {};
        for (const f of SPOT_FOLDERS) {
            const parent = f.parent ? folders[f.parent] : this.gui;
            const folder = parent.addFolder(f.title);
            if (f.power && folder.domElement) folder.domElement.classList.add('power-folder');
            if (f.parent || f.id === 'render' || f.id === 'dmx' || f.id === 'place') folder.close();
            folders[f.id] = folder;
        }

        // Placement : mode du gizmo
        const gizmo = { mode: this._gizmoMode === 'rotate' ? 'Rotation' : 'Translation' };
        folders.place.add(gizmo, 'mode', ['Translation', 'Rotation']).name('Mode Gizmo').onChange((mode) => {
            this._gizmoMode = mode === 'Rotation' ? 'rotate' : 'translate';
            if (this.ambiancePanel && this.ambiancePanel.transformControls) {
                this.ambiancePanel.transformControls.setMode(this._gizmoMode);
            }
        });

        // Paramètres du schéma
        for (const [key, s] of Object.entries(SPOT_PARAMS_SCHEMA)) {
            const folder = folders[s.folder];
            if (!folder) continue;
            let ctrl;
            if (s.options) ctrl = folder.add(p, key, s.options);
            else if (s.color) ctrl = folder.addColor(p, key);
            else if (typeof s.value === 'boolean') ctrl = folder.add(p, key);
            else ctrl = folder.add(p, key, s.min, s.max, s.step);
            ctrl.name(s.label).onChange(v => this._setParam(key, v));
            this._addResetButton(ctrl, () => {
                ctrl.setValue(s.value);
            });
            this.controllers[key] = ctrl;
        }

        // DMX : plage de canaux, conflits, moniteur
        this._patchInfoEl = document.createElement('div');
        this._patchInfoEl.className = 'spot-dmx-info';
        this._patchInfoEl.style.cssText = 'padding:6px 8px;font-size:11px;line-height:1.5;color:#b8c2d6;';
        folders.dmx.$children.appendChild(this._patchInfoEl);
        const monitorState = { open: false };
        folders.dmx.add({ toggle: () => {
            monitorState.open = !monitorState.open;
            this._monitorEl.style.display = monitorState.open ? 'block' : 'none';
            this._refreshMonitor();
        } }, 'toggle').name('📟 Moniteur des canaux DMX');
        this._monitorEl = document.createElement('div');
        this._monitorEl.style.cssText = 'display:none;max-height:220px;overflow:auto;padding:4px 8px 8px;font:11px/1.45 ui-monospace,Consolas,monospace;color:#cfd8ea;';
        folders.dmx.$children.appendChild(this._monitorEl);

        // Contrôle : routines de reset
        const fCtrl = this.gui.addFolder('🛠️ Contrôle (Reset)');
        fCtrl.close();
        const resets = {
            panTilt: () => this._reset('panTilt'),
            effects: () => this._reset('effects'),
            all: () => this._reset('all'),
        };
        fCtrl.add(resets, 'panTilt').name('↻ Reset moteurs Pan / Tilt');
        fCtrl.add(resets, 'effects').name('↻ Reset effets (roues, prisme, zoom)');
        fCtrl.add(resets, 'all').name('↻ Reset complet de la machine');

        // Rendu global (toutes les lyres)
        const fGlobal = this.gui.addFolder('🌫️ Rendu global (toutes les lyres)');
        fGlobal.close();
        const g = this.spotManager.globals;
        for (const [key, s] of Object.entries(SPOT_GLOBAL_SCHEMA)) {
            if (SPOT_LOCAL_GLOBALS.has(key)) continue; // qualité : menu ⚙️ Options
            let ctrl;
            if (s.options) ctrl = fGlobal.add(g, key, s.options);
            else if (typeof s.value === 'boolean') ctrl = fGlobal.add(g, key);
            else ctrl = fGlobal.add(g, key, s.min, s.max, s.step);
            ctrl.name(s.label).onChange(v => {
                this.spotManager.setGlobal(key, v);
                this._emit({ category: 'spot_global', data: { [key]: v } });
            });
            this._addResetButton(ctrl, () => ctrl.setValue(s.value));
            this._globalCtrls[key] = ctrl;
        }

        // Actions
        const fActions = this.gui.addFolder('⚙️ Actions');
        const actions = {
            export: () => this.ambiancePanel && this.ambiancePanel.exportSelectedSpot(spot),
            duplicate: () => this.ambiancePanel && this.ambiancePanel.duplicateSelectedSpot(spot),
            remove: () => this.ambiancePanel && this.ambiancePanel.deleteSelectedSpot(spot),
        };
        fActions.add(actions, 'export').name('💾 Exporter');
        fActions.add(actions, 'duplicate').name('📋 Dupliquer');
        fActions.add(actions, 'remove').name('🗑️ Supprimer');

        this._refreshVisibility();
        this._refreshPatchInfo();
    }

    _reset(mode) {
        if (!this._spot) return;
        const targets = (this._linkEnabled && this._linkedSpots()) || [this._spot];
        for (const s of targets) {
            s.reset(mode);
            this._emit({ category: 'spot_action', id: s.id, action: 'reset', mode, immediate: true });
        }
    }

    _show(key, visible) {
        const c = this.controllers[key];
        if (!c) return;
        if (visible) c.show(); else c.hide();
    }

    /** Masque les réglages sans effet dans la configuration courante */
    _refreshVisibility() {
        const p = this._spot && this._spot.params;
        if (!p) return;
        this._show('shutterSpeed', p.shutter !== 'Ouvert' && p.shutter !== 'Fermé');
        this._show('goboShake', p.goboFixed !== 'Ouvert');
        this._show('goboIndex', p.goboRot !== 'Ouvert' && p.goboRotMode === 'Index');
        this._show('goboSpeed', p.goboRot !== 'Ouvert' && p.goboRotMode === 'Rotation');
        this._show('goboRotMode', p.goboRot !== 'Ouvert');
        this._show('animSpeed', p.animWheel !== 'Aucune');
        this._show('prismSpeed', p.prism !== 'Aucun');
        this._show('prismIndex', p.prism !== 'Aucun' && Math.abs(p.prismSpeed) < 1);
    }

    _refreshPatchInfo() {
        const spot = this._spot;
        if (!spot || !this._patchInfoEl) return;
        const fp = getFootprint(spot.params.dmxMode);
        const a0 = spot.params.dmxAddress;
        const a1 = a0 + fp - 1;
        const conflicts = this.spotManager.patch.conflictsOf(spot);
        const overflow = this.spotManager.patch.overflows(spot);
        let html = `Univers <b>${spot.params.dmxUniverse}</b> · canaux <b>${a0} → ${a1}</b> (${fp} canaux)`;
        if (overflow) html += `<br><span style="color:#ff8a65">⚠ La plage dépasse l'adresse 512</span>`;
        if (conflicts.length) {
            html += `<br><span style="color:#ff8a65">⚠ Chevauche : ${conflicts.map(c => 'Lyre #' + c.number).join(', ')}</span>`;
        } else if (!overflow) {
            html += `<br><span style="color:#7ee2a8">✓ Aucun conflit d'adresse</span>`;
        }
        html += `<br><span style="opacity:.75">${spot.params.dmxControl ? 'Pilotée par le DMX : les réglages suivent la console.' : 'Pilotée par ce panneau (DMX ignoré).'}</span>`;
        this._patchInfoEl.innerHTML = html;
    }

    _refreshMonitor() {
        const spot = this._spot;
        if (!spot || !this._monitorEl || this._monitorEl.style.display === 'none') return;
        const channels = describeChannels(spot.params.dmxMode, spot.params.dmxAddress);
        const values = encode(spot.params, spot.params.dmxMode);
        this._monitorEl.innerHTML = channels.map((c, i) =>
            `<div style="display:flex;justify-content:space-between;gap:8px"><span style="opacity:.7">${String(c.address).padStart(3, '0')}</span><span style="flex:1">${c.name}</span><b>${values[i]}</b></div>`
        ).join('');
    }

    _tick() {
        const spot = this._spot;
        if (!spot) return;
        if (spot.dmxDirty) {
            spot.dmxDirty = false;
            this.syncFromSpot();
        }
        this._refreshMonitor();
        this._refreshLinkBanner();
    }
}
