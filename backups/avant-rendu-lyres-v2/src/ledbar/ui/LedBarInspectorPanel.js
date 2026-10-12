/**
 * LedBarInspectorPanel.js
 * ─────────────────────────────────────────────────────────────
 * Panneau d'options d'une barre LED (même DA que l'inspecteur des lyres) :
 *   - construit automatiquement depuis LEDBAR_PARAMS_SCHEMA (1 dossier par famille)
 *   - couleurs : sélecteur de couleur classique (stockées en RGB dans le code)
 *   - grille des pixels : 1 sélecteur de couleur par LED + remplissages rapides
 *   - bouton ↺ par paramètre + « Tout reset »
 *   - DMX : patch, plage de canaux, conflits, moniteur des valeurs équivalentes
 *   - Contrôle : reset des moteurs (tilt, zoom, complet)
 *   - chaque modification est synchronisée en multijoueur (ledbar_update / ledbar_action)
 * ─────────────────────────────────────────────────────────────
 */

import GUI from 'lil-gui';
import { makeDraggable } from '../../ui/draggable.js';
import { LEDBAR_PARAMS_SCHEMA, LEDBAR_FOLDERS, rgbToHex, hexToRgb } from '../config/ledBarParams.js';
import { describeChannels, encode, getFootprint } from '../LedBarProfile.js';

const PER_FIXTURE_FOLDERS = new Set(['place', 'dmx']);

export class LedBarInspectorPanel {
    /**
     * @param {object} o
     * @param {import('../LedBarManager.js').LedBarManager} o.ledBarManager
     * @param {import('../../ui/AmbiancePanel.js').AmbiancePanel} o.ambiancePanel
     */
    constructor({ ledBarManager, ambiancePanel }) {
        this.ledBarManager = ledBarManager;
        this.ambiancePanel = ambiancePanel;
        this.panelWrap = document.getElementById('ledbar-panel-wrap');
        this.panelContainer = document.getElementById('ledbar-panel');
        this.gui = null;
        this._bar = null;
        this.controllers = {};
        this._gizmoMode = 'translate';
        this._timer = null;
        this._pixelGrid = null;
        this._pixelInputs = [];
    }

    get isOpen() {
        return this._bar !== null && this.panelWrap && !this.panelWrap.classList.contains('hidden');
    }

    get currentBarId() {
        return this._bar ? this._bar.id : null;
    }

    openForBar(bar) {
        this._bar = bar;
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
        this._bar = null;
        this.controllers = {};
        this._pixelGrid = null;
        this._pixelInputs = [];
    }

    /** Rafraîchit tous les contrôles depuis l'état de la barre (gizmo, réseau, DMX) */
    syncFromBar() {
        if (!this.gui || !this._bar) return;
        for (const c of Object.values(this.controllers)) {
            try { c.updateDisplay(); } catch (_) {}
        }
        this._refreshPixelGrid();
        this._refreshVisibility();
        this._refreshPatchInfo();
    }

    _emit(payload) {
        if (this.ambiancePanel && typeof this.ambiancePanel._emitSync === 'function') {
            this.ambiancePanel._emitSync(payload);
        }
    }

    _setParam(key, value) {
        const bar = this._bar;
        if (!bar) return;
        bar.setParam(key, value);
        this._emit({ category: 'ledbar_update', id: bar.id, data: { [key]: value } });
        if (key.startsWith('dmx') || key === 'pixelCount') this._refreshPatchInfo();
        if (key === 'pixelCount') this._refreshPixelGrid();
        this._refreshVisibility();
    }

    _setPixels(pixels) {
        const bar = this._bar;
        if (!bar) return;
        bar.setParams({ pixels });
        this._emit({ category: 'ledbar_update', id: bar.id, data: { pixels: [...bar.params.pixels] } });
        this._refreshPixelGrid();
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
        const bar = this._bar;
        if (!bar) return;
        const data = {};
        for (const [k, s] of Object.entries(LEDBAR_PARAMS_SCHEMA)) {
            // La position, la taille et le patch DMX sont conservés (« tout reset » = réglages de la machine)
            if (PER_FIXTURE_FOLDERS.has(s.folder)) continue;
            data[k] = s.value;
        }
        data.pixels = new Array(32).fill('#ffffff');
        bar.setParams(data);
        this._emit({ category: 'ledbar_update', id: bar.id, data });
        this.syncFromBar();
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
        resetBtn.title = 'Réinitialiser les réglages de la barre (position, taille et patch conservés)';
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

        makeDraggable(this.panelWrap, titleEl, 'ledbar');
    }

    _buildGui() {
        if (this.gui) this.gui.destroy();
        this.controllers = {};
        const bar = this._bar;
        if (!bar) return;
        const p = bar.params;

        const title = `💡 Barre LED #${bar.number}`;
        this.gui = new GUI({ container: this.panelContainer, title, autoPlace: false, width: 340 });
        this._buildTitle(title);

        const folders = {};
        for (const f of LEDBAR_FOLDERS) {
            const folder = this.gui.addFolder(f.title);
            if (f.power && folder.domElement) folder.domElement.classList.add('power-folder');
            if (f.id === 'render' || f.id === 'dmx' || f.id === 'place' || f.id === 'pixels') folder.close();
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

        for (const [key, s] of Object.entries(LEDBAR_PARAMS_SCHEMA)) {
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

        this._buildPixelGrid(folders.pixels);

        // DMX : plage de canaux, conflits, moniteur
        this._patchInfoEl = document.createElement('div');
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

        // Contrôle : reset des moteurs
        const fCtrl = this.gui.addFolder('🛠️ Contrôle (Reset)');
        fCtrl.close();
        const resets = {
            tilt: () => this._reset('tilt'),
            zoom: () => this._reset('zoom'),
            all: () => this._reset('all'),
        };
        fCtrl.add(resets, 'tilt').name('↻ Reset moteur Tilt');
        fCtrl.add(resets, 'zoom').name('↻ Reset moteurs Zoom');
        fCtrl.add(resets, 'all').name('↻ Reset complet de la barre');

        const fActions = this.gui.addFolder('⚙️ Actions');
        const actions = {
            duplicate: () => this.ambiancePanel && this.ambiancePanel.duplicateSelectedSpot(bar),
            remove: () => this.ambiancePanel && this.ambiancePanel.deleteSelectedSpot(bar),
        };
        fActions.add(actions, 'duplicate').name('📋 Dupliquer');
        fActions.add(actions, 'remove').name('🗑️ Supprimer');

        this._refreshVisibility();
        this._refreshPatchInfo();
    }

    // ── Grille des pixels ────────────────────────────────────────────────
    _buildPixelGrid(folder) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'padding:6px 8px 8px;';
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:10.5px;color:#9aa6bd;margin-bottom:6px;line-height:1.4;';
        hint.textContent = 'Clique sur une LED pour choisir sa couleur (actif avec « Couleur par LED », sans motif d\'effet).';
        this._pixelGrid = document.createElement('div');
        this._pixelGrid.style.cssText = 'display:grid;grid-template-columns:repeat(8, 1fr);gap:4px;';
        wrap.append(hint, this._pixelGrid);
        folder.$children.appendChild(wrap);

        const tools = {
            fillMaster: () => this._setPixels(new Array(32).fill(this._bar.params.color)),
            gradient: () => {
                const p = this._bar.params;
                const a = hexToRgb(p.fxFg), b = hexToRgb(p.fxBg);
                const n = this._bar.pixelCount;
                const px = [...p.pixels];
                for (let i = 0; i < n; i++) {
                    const t = n > 1 ? i / (n - 1) : 0;
                    px[i] = rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
                }
                this._setPixels(px);
            },
            rainbow: () => {
                const n = this._bar.pixelCount;
                const px = [...this._bar.params.pixels];
                for (let i = 0; i < n; i++) {
                    const h = i / n, k = (x) => Math.max(0, Math.min(1, Math.abs(((h * 6 + x) % 6) - 3) - 1));
                    px[i] = rgbToHex(k(0), k(4), k(2));
                }
                this._setPixels(px);
            },
            alternate: () => {
                const p = this._bar.params;
                this._setPixels(p.pixels.map((_, i) => (i % 2 ? p.fxBg : p.fxFg)));
            },
        };
        folder.add(tools, 'fillMaster').name('🎨 Remplir avec la couleur master');
        folder.add(tools, 'gradient').name('🌈 Dégradé premier plan → fond');
        folder.add(tools, 'rainbow').name('🌈 Arc-en-ciel');
        folder.add(tools, 'alternate').name('◐ Alterner premier plan / fond');
        this._refreshPixelGrid();
    }

    _refreshPixelGrid() {
        const bar = this._bar;
        if (!bar || !this._pixelGrid) return;
        const n = bar.pixelCount;
        if (this._pixelInputs.length !== n) {
            this._pixelGrid.textContent = '';
            this._pixelInputs = [];
            for (let i = 0; i < n; i++) {
                const input = document.createElement('input');
                input.type = 'color';
                input.title = `LED ${i + 1}`;
                input.style.cssText = 'width:100%;height:22px;padding:0;border:1px solid rgba(255,255,255,0.18);border-radius:4px;background:none;cursor:pointer;';
                input.addEventListener('input', () => {
                    if (!this._bar) return;
                    const px = [...this._bar.params.pixels];
                    px[i] = input.value;
                    if (!this._bar.params.pixelMode) this._setParam('pixelMode', true);
                    this._setPixels(px);
                });
                this._pixelGrid.appendChild(input);
                this._pixelInputs.push(input);
            }
        }
        for (let i = 0; i < n; i++) {
            const v = bar.params.pixels[i];
            if (this._pixelInputs[i].value !== v) this._pixelInputs[i].value = v;
        }
        if (this.controllers.pixelMode) this.controllers.pixelMode.updateDisplay();
    }

    _reset(mode) {
        if (!this._bar) return;
        this._bar.reset(mode);
        this._emit({ category: 'ledbar_action', id: this._bar.id, action: 'reset', mode, immediate: true });
    }

    _show(key, visible) {
        const c = this.controllers[key];
        if (!c) return;
        if (visible) c.show(); else c.hide();
    }

    /** Masque les réglages sans effet dans la configuration courante */
    _refreshVisibility() {
        const p = this._bar && this._bar.params;
        if (!p) return;
        this._show('strobeRate', p.shutter !== 'Ouvert' && p.shutter !== 'Fermé');
        this._show('zoomRight', p.zoomSplit);
        this._show('halfColor', p.halfMode !== 'Aucune');
        this._show('halfPos', p.halfMode !== 'Aucune');
        const macro = p.moveFx !== 'Aucun';
        this._show('moveFxAmp', macro && p.moveFx !== 'Hélice');
        this._show('moveFxSpeed', macro);
        const fx = p.fxPattern !== 'Aucun';
        for (const k of ['fxSpeed', 'fxDirection', 'fxFade', 'fxSize', 'fxFg', 'fxBg']) this._show(k, fx);
    }

    _refreshPatchInfo() {
        const bar = this._bar;
        if (!bar || !this._patchInfoEl) return;
        const fp = getFootprint(bar.params.dmxMode, bar.pixelCount);
        const a0 = bar.params.dmxAddress;
        const a1 = a0 + fp - 1;
        const conflicts = this.ledBarManager.patch.conflictsOf(bar);
        const overflow = this.ledBarManager.patch.overflows(bar);
        let html = `Univers <b>${bar.params.dmxUniverse}</b> · canaux <b>${a0} → ${a1}</b> (${fp} canaux)`;
        if (overflow) html += `<br><span style="color:#ff8a65">⚠ La plage dépasse l'adresse 512</span>`;
        if (conflicts.length) {
            html += `<br><span style="color:#ff8a65">⚠ Chevauche : ${conflicts.map(c => c.displayName || ('Lyre #' + c.number)).join(', ')}</span>`;
        } else if (!overflow) {
            html += `<br><span style="color:#7ee2a8">✓ Aucun conflit d'adresse</span>`;
        }
        html += `<br><span style="opacity:.75">${bar.params.dmxControl ? 'Pilotée par le DMX : les réglages suivent la console.' : 'Pilotée par ce panneau (DMX ignoré).'}</span>`;
        this._patchInfoEl.innerHTML = html;
    }

    _refreshMonitor() {
        const bar = this._bar;
        if (!bar || !this._monitorEl || this._monitorEl.style.display === 'none') return;
        const channels = describeChannels(bar.params.dmxMode, bar.params.dmxAddress, bar.pixelCount);
        const values = encode(bar.params, bar.params.dmxMode, bar.pixelCount);
        this._monitorEl.innerHTML = channels.map((c, i) =>
            `<div style="display:flex;justify-content:space-between;gap:8px"><span style="opacity:.7">${String(c.address).padStart(3, '0')}</span><span style="flex:1">${c.name}</span><b>${values[i]}</b></div>`
        ).join('');
    }

    _tick() {
        const bar = this._bar;
        if (!bar) return;
        if (bar.dmxDirty) {
            bar.dmxDirty = false;
            this.syncFromBar();
        }
        this._refreshMonitor();
    }
}
