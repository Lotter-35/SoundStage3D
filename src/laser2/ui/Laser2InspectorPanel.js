/**
 * Laser2InspectorPanel.js
 * ─────────────────────────────────────────────────────────────
 * Panneau d'options d'un nouveau laser (même DA que les lyres et barres LED) :
 *   - construit depuis LASER2_PARAMS_SCHEMA (1 dossier par famille)
 *   - couleur : sélecteur de couleur classique (stockée en RGB dans le code)
 *   - modèle de boîtier : applique sa fiche technique ; modifier une valeur → « Personnalisé »
 *   - aperçu 2D du tracé (comme la fenêtre de prévisualisation d'un logiciel laser) :
 *     consigne envoyée aux galvos (gris) et trajectoire réelle des miroirs (couleur émise)
 *   - source « Fichier ILDA » : banque puis forme de la bibliothèque du serveur (listes mises à jour
 *     en direct quand un fichier est ajouté dans server/storage/ilda)
 *   - informations : points par image, images/s (scintillement), primitives
 *   - chaque modification est synchronisée en multijoueur (laser2_update)
 * ─────────────────────────────────────────────────────────────
 */

import GUI from 'lil-gui';
import { makeDraggable } from '../../ui/draggable.js';
import { LASER2_PARAMS_SCHEMA, LASER2_FOLDERS, HARDWARE_PRESETS } from '../config/laser2Params.js';
import { ildaLibrary } from '../ilda/IldaLibrary.js';
import { describeChannels, encode, getFootprint } from '../Laser2Profile.js';
import { isAnimatedPattern } from '../Laser2Patterns.js';

const PER_FIXTURE_FOLDERS = new Set(['place', 'dmx']);
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
        this.laser2Manager.previewId = laser.id;
        if (this.panelWrap) this.panelWrap.classList.remove('hidden');
        this._buildGui();
        clearInterval(this._timer);
        this._timer = setInterval(() => this._tick(), 100);
    }

    close() {
        clearInterval(this._timer);
        this._timer = null;
        if (this._unsubIlda) { this._unsubIlda(); this._unsubIlda = null; }
        if (this.gui) {
            this.gui.destroy();
            this.gui = null;
        }
        if (this.panelWrap) this.panelWrap.classList.add('hidden');
        this._laser = null;
        if (this.laser2Manager) this.laser2Manager.previewId = null;
        this.controllers = {};
    }

    /** Rafraîchit tous les contrôles depuis l'état du laser (gizmo, réseau) */
    syncFromLaser() {
        if (!this.gui || !this._laser) return;
        for (const c of Object.values(this.controllers)) {
            try { c.updateDisplay(); } catch (_) {}
        }
        if (this._ildaState && this._laser.params.ildaFile !== this._ildaState.file) this._rebuildIldaPicker();
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
        if (key.startsWith('dmx')) this._refreshPatchInfo();
        this._refreshVisibility();
    }

    _refreshPatchInfo() {
        const l = this._laser;
        if (!l || !this._patchInfoEl) return;
        const fp = getFootprint(l.params.dmxMode);
        const a0 = l.params.dmxAddress, a1 = a0 + fp - 1;
        const patch = this.laser2Manager.patch;
        let html = `Univers <b>${l.params.dmxUniverse}</b> · canaux <b>${a0} → ${a1}</b> (${fp} canaux)`;
        if (patch) {
            const conflicts = patch.conflictsOf(l);
            if (patch.overflows(l)) html += `<br><span style="color:#ff8a65">⚠ La plage dépasse l'adresse 512</span>`;
            if (conflicts.length) html += `<br><span style="color:#ff8a65">⚠ Chevauche : ${conflicts.map(c => c.displayName || ('Lyre #' + c.number)).join(', ')}</span>`;
            else if (!patch.overflows(l)) html += `<br><span style="color:#7ee2a8">✓ Aucun conflit d'adresse</span>`;
        }
        html += `<br><span style="opacity:.75">${l.params.dmxControl ? 'Piloté par le DMX : les réglages suivent la console.' : 'Piloté par ce panneau (DMX ignoré).'}</span>`;
        this._patchInfoEl.innerHTML = html;
    }

    _refreshMonitor() {
        const l = this._laser;
        if (!l || !this._monitorEl || this._monitorEl.style.display === 'none') return;
        const channels = describeChannels(l.params.dmxMode, l.params.dmxAddress);
        const values = encode(l.params, l.params.dmxMode);
        this._monitorEl.innerHTML = channels.map((c, i) =>
            `<div style="display:flex;justify-content:space-between;gap:8px"><span style="opacity:.7">${String(c.address).padStart(3, '0')}</span><span style="flex:1">${c.name}</span><b>${values[i]}</b></div>`
        ).join('');
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
            if (f.id === 'place' || f.id === 'dmx' || f.id === 'effects' || f.id === 'smoke' || f.id === 'hardware' || f.id === 'render') folder.close();
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
            if (key === 'ildaFile') { this._buildIldaPicker(folder); continue; }
            let ctrl;
            if (s.options) ctrl = folder.add(p, key, s.options);
            else if (s.color) ctrl = folder.addColor(p, key);
            else if (typeof s.value === 'boolean') ctrl = folder.add(p, key);
            else ctrl = folder.add(p, key, s.min, s.max, s.step);
            ctrl.name(s.label).onChange(v => this._setParam(key, v));
            this._addResetButton(ctrl, () => ctrl.setValue(s.value));
            this.controllers[key] = ctrl;
        }

        // DMX : plage de canaux, conflits, moniteur
        this._patchInfoEl = document.createElement('div');
        this._patchInfoEl.style.cssText = 'padding:6px 8px;font-size:11px;line-height:1.5;color:#b8c2d6;';
        folders.dmx.$children.appendChild(this._patchInfoEl);
        const monitor = { open: false };
        folders.dmx.add({ toggle: () => {
            monitor.open = !monitor.open;
            this._monitorEl.style.display = monitor.open ? 'block' : 'none';
            this._refreshMonitor();
        } }, 'toggle').name('📟 Moniteur des canaux DMX');
        this._monitorEl = document.createElement('div');
        this._monitorEl.style.cssText = 'display:none;max-height:240px;overflow:auto;padding:4px 8px 8px;font:11px/1.45 ui-monospace,Consolas,monospace;color:#cfd8ea;';
        folders.dmx.$children.appendChild(this._monitorEl);
        this._refreshPatchInfo();

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
        const s = laser.preview;          // aperçu calculé par le cœur (worker) pour ce laser
        const W = PREVIEW;
        c.fillStyle = '#05060a';
        c.fillRect(0, 0, W, W);
        // Cadre de l'angle de balayage maximal
        c.strokeStyle = 'rgba(255,255,255,0.08)';
        c.lineWidth = 1;
        c.strokeRect(6.5, 6.5, W - 13, W - 13);
        const st = laser.stats;
        if (laser.params.source === 'ILDA live' && !laser.docReady) {
            this._info.innerHTML = `Canal live ${Math.round(laser.params.liveChannel)} : en attente d'images<br><span style="opacity:.7">IDN (UDP 7255, canal ${Math.round(laser.params.liveChannel) - 1}) ou POST /api/ilda/live?ch=${Math.round(laser.params.liveChannel)}</span>`;
            return;
        }
        if (laser.params.source === 'Fichier ILDA' && !laser.docReady) {
            this._info.textContent = laser.params.ildaFile ? 'Chargement de la forme ILDA…' : 'Choisis une forme ILDA';
            return;
        }
        if (s && s.n > 1) {
            const n = s.n;
            const sc = (W / 2 - 7) / Math.max(1e-3, s.maxAngle);
            const cx = W / 2, cy = W / 2;
            c.strokeStyle = 'rgba(150,160,180,0.35)';
            c.beginPath();
            for (let i = 0; i < n; i++) {
                const X = cx + s.ux[i] * sc, Y = cy - s.uy[i] * sc;
                if (i === 0) c.moveTo(X, Y); else c.lineTo(X, Y);
            }
            c.stroke();
            c.lineWidth = 1.6;
            c.lineCap = 'round';
            for (let i = 1; i < n; i++) {
                const r = s.pr[i], g = s.pg[i], b = s.pb[i];
                const m = Math.max(r, g, b);
                if (m <= 1e-6) continue;
                c.strokeStyle = `rgb(${Math.round(80 + 175 * (r + g * 0.05 + b * 0.12) / m)},${Math.round(80 + 175 * (g + r * 0.03 + b * 0.02) / m)},${Math.round(80 + 175 * (b + g * 0.15) / m)})`;
                c.beginPath();
                c.moveTo(cx + s.ax[i - 1] * sc, cy - s.ay[i - 1] * sc);
                c.lineTo(cx + s.ax[i] * sc, cy - s.ay[i] * sc);
                c.stroke();
            }
        }
        const hz = st.frameHz;
        const flicker = hz < 20 ? ' <span style="color:#ff8a65">⚠ scintille</span>' : '';
        const anim = st.frames > 1 ? ` · animation ${st.frames} images` : '';
        this._info.innerHTML = `${st.points} points · <b>${hz.toFixed(0)} images/s</b>${flicker}${anim}<br>`
            + `${st.beams} faisceaux · ${st.sheets} nappes · calcul ${(this.laser2Manager.coreMs || 0).toFixed(2)} ms (${this.laser2Manager.computeMode === 'worker' ? 'worker' : 'direct'})`;
    }

    // ── Choix de la forme ILDA (banque → forme) ─────────────────────────
    _buildIldaPicker(folder) {
        this._ildaFolder = folder;
        this._ildaState = { bank: '', file: '' };
        this._ildaInfo = document.createElement('div');
        this._ildaInfo.style.cssText = 'padding:4px 8px 6px;font-size:10.5px;line-height:1.4;color:#9aa6bd;';
        folder.$children.appendChild(this._ildaInfo);
        this._ildaBankCtrl = null;
        this._ildaFileCtrl = null;
        this._rebuildIldaPicker();
        if (this._unsubIlda) this._unsubIlda();
        this._unsubIlda = ildaLibrary.onChange(() => this._rebuildIldaPicker());
        ildaLibrary.ensureLoaded();
    }

    _rebuildIldaPicker() {
        const laser = this._laser;
        const folder = this._ildaFolder;
        if (!laser || !folder || !this.gui) return;
        const banks = ildaLibrary.bankNames;
        const cur = laser.params.ildaFile;
        const entry = ildaLibrary.entry(cur);
        const st = this._ildaState;
        st.bank = entry ? entry.bank : (banks.includes(st.bank) ? st.bank : (banks[0] || ''));
        const files = ildaLibrary.filesOf(st.bank);
        const fileOptions = {};
        for (const f of files) fileOptions[f.name] = f.path;
        st.file = entry ? cur : '';
        if (!entry) fileOptions['— choisir —'] = '';

        if (this._ildaBankCtrl) this._ildaBankCtrl.destroy();
        if (this._ildaFileCtrl) this._ildaFileCtrl.destroy();
        this._ildaBankCtrl = folder.add(st, 'bank', banks.length ? banks : ['(vide)']).name('Banque ILDA')
            .onChange(() => { st.file = ''; this._rebuildIldaPicker(); });
        this._ildaFileCtrl = folder.add(st, 'file', fileOptions).name('Forme ILDA')
            .onChange((path) => { if (path) this._setParam('ildaFile', path); });
        // Placés juste après « Source »
        const anchor = this.controllers.source && this.controllers.source.domElement;
        if (anchor && anchor.parentElement) {
            anchor.after(this._ildaBankCtrl.domElement);
            this._ildaBankCtrl.domElement.after(this._ildaFileCtrl.domElement);
            this._ildaFileCtrl.domElement.after(this._ildaInfo);
        }
        const total = ildaLibrary.index.banks.reduce((n, b) => n + b.files.length, 0);
        this._ildaInfo.textContent = total
            ? (cur && !entry ? `Forme « ${cur} » introuvable sur le serveur.` : `${total} formes dans ${banks.length} banque(s) · dossier server/storage/ilda`)
            : 'Aucune forme : dépose des fichiers .ild dans server/storage/ilda (un sous-dossier = une banque).';
        this._refreshVisibility();
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
        const live = p.source === 'ILDA live';
        const ilda = p.source === 'Fichier ILDA';
        this._show('liveChannel', live);
        const beams = !ilda && !live && (p.pattern === 'Faisceaux (éventail)' || p.pattern === 'Nappe + faisceaux');
        this._show('pattern', !ilda && !live);
        this._show('beamCount', beams);
        this._show('beamDwell', beams || (!ilda && p.pattern === 'Point fixe'));
        for (const k of ['density', 'cornerPoints', 'blankPoints']) this._show(k, !ilda && !live);
        const fixed = p.playMode === 'Image fixe';
        const anim = ilda || (!live && isAnimatedPattern(p.pattern));
        this._show('playMode', anim);
        this._show('ildaFps', anim && !fixed);
        this._show('ildaFrame', anim && fixed);
        const fanLike = !ilda && !live && /Faisceaux|éventail/i.test(p.pattern);
        this._show('fanSpread', !ilda && !live && (fanLike || /^Nappe/.test(p.pattern)));
        this._show('fanBlend', fanLike);
        this._show('zoomFxSpeed', p.zoomFx !== 'Aucun');
        this._show('sweepSpeed', p.sweepX > 0 || p.sweepY > 0);
        this._show('sweepShape', p.sweepX > 0 || p.sweepY > 0);
        this._show('waveSpeed', p.waveAmp > 0);
        this._show('colorSpeed', p.colorMode !== 'Fixe');
        for (const k of ['smokeAmount', 'smokeScale', 'smokeSpeed', 'smokeContrast', 'smokeBeams']) this._show(k, p.smokeOn);
        this._show('ildaColor', ilda || live);
        for (const c of [this._ildaBankCtrl, this._ildaFileCtrl]) if (c) { if (ilda) c.show(); else c.hide(); }
        if (this._ildaInfo) this._ildaInfo.style.display = ilda ? '' : 'none';
        this._show('strobeRate', p.shutter === 'Strobe');
        this._show('threshold', p.modulation === 'Analogique');
    }

    _tick() {
        if (!this._laser) return;
        if (!this.laser2Manager.getLaser(this._laser.id)) { this.close(); return; }
        if (this._laser.dmxDirty) {
            this._laser.dmxDirty = false;
            this.syncFromLaser();
        }
        if ((this._tickN = (this._tickN || 0) + 1) % 3 === 0) this._refreshMonitor();
        this._drawPreview();
    }
}
