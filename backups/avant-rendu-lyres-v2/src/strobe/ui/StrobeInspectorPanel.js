/**
 * StrobeInspectorPanel.js
 * ─────────────────────────────────────────────────────────────
 * Panneau de contrôle dédié pour les projecteurs Stroboscopes :
 * - Flottant et déplaçable avec la souris sur le titre (makeDraggable).
 * - Identique à la DA de l'Inspecteur Laser et du panneau Ambiance (dark glassmorphism).
 * - Réinitialisation individuelle (↺) sur chaque paramètre et reset global (↺).
 * - Contrôles complets : Puissance normalisée, Couleur, Écran émissif,
 *   Dimensions 3D (Largeur, Hauteur, Épaisseur), Stroboscope (Hz, Duty Cycle, Éclairs),
 *   Ombres portées dynamiques, Position & Orientation (Yaw/Pitch/Roll, Gizmo).
 * ─────────────────────────────────────────────────────────────
 */

import GUI from 'lil-gui';
import { makeDraggable } from '../../ui/draggable.js';
import { describeChannels, encode as encodeDmx } from '../StrobeProfile.js';

export const STROBE_DEFAULTS = {
    power:           45.0,
    color:           '#ffffff',
    emissivePower:   3.5,
    castShadow:      true,
    shadowIntensity: 1.0,
    shadowSoftness:  0.5,
    distanceFactor:  10.0,
    width:           1.20,
    height:          0.38,
    depth:           0.24,
    showHousing:     true,
    strobeEnabled:   true,
    strobeSpeed:     12.0,
    pulseWidth:      50.0,
    strobeRandom:    false,
    posX:            0,
    posY:            8,
    posZ:            -5,
    angle:           0,
    tilt:            0,
    roll:            0,
};

export class StrobeInspectorPanel {
    /**
     * @param {object} options
     * @param {import('../StrobeManager.js').StrobeManager} options.strobeManager
     * @param {import('../../ui/AmbiancePanel.js').AmbiancePanel} [options.ambiancePanel]
     */
    constructor({ strobeManager, ambiancePanel }) {
        this.strobeManager = strobeManager;
        this.ambiancePanel = ambiancePanel;

        this.panelWrap = document.getElementById('strobe-panel-wrap');
        this.panelContainer = document.getElementById('strobe-panel');

        this.gui = null;
        this._currentStrobe = null;
        this._currentStrobeId = null;
        this.controllers = {};
        this._posState = null;
        this._rotState = null;
        this._gizmoMode = 'translate';
    }

    /**
     * Ouvre le panneau pour un stroboscope donné
     * @param {number} id
     * @param {import('../StrobeLight.js').StrobeLight} strobe
     */
    openForStrobe(id, strobe) {
        this._currentStrobe = strobe;
        this._currentStrobeId = id;

        if (this.panelWrap) {
            this.panelWrap.classList.remove('hidden');
        }

        this._buildGui();
    }

    /**
     * Ferme l'inspecteur
     */
    close() {
        if (this.gui) {
            this.gui.destroy();
            this.gui = null;
        }
        if (this.panelWrap) {
            this.panelWrap.classList.add('hidden');
        }
        this._currentStrobe = null;
        this._currentStrobeId = null;
        this.controllers = {};
    }

    get isOpen() {
        return this._currentStrobe !== null && this.panelWrap && !this.panelWrap.classList.contains('hidden');
    }

    /**
     * Synchronise les contrôleurs avec l'état 3D (ex: manipulation par Gizmo)
     */
    syncFromStrobe() {
        if (!this.gui || !this._currentStrobe) return;

        if (this._posState && this.controllers.posX && this.controllers.posY && this.controllers.posZ) {
            const p = this._currentStrobe.group.position;
            this._posState.x = Math.round(p.x * 100) / 100;
            this._posState.y = Math.round(p.y * 100) / 100;
            this._posState.z = Math.round(p.z * 100) / 100;
            try {
                this.controllers.posX.setValue(this._posState.x);
                this.controllers.posY.setValue(this._posState.y);
                this.controllers.posZ.setValue(this._posState.z);
            } catch (_) {}
        }

        if (this._rotState && this.controllers.angle && this.controllers.tilt && this.controllers.roll) {
            this._currentStrobe.syncRotationFromGizmo();
            this._rotState.angle = this._currentStrobe.params.angle;
            this._rotState.tilt  = this._currentStrobe.params.tilt;
            this._rotState.roll  = this._currentStrobe.params.roll;
            try {
                this.controllers.angle.setValue(this._rotState.angle);
                this.controllers.tilt.setValue(this._rotState.tilt);
                this.controllers.roll.setValue(this._rotState.roll);
            } catch (_) {}
        }
    }

    /**
     * Rafraîchit tous les contrôles depuis les paramètres du stroboscope
     * (modification reçue d'un autre joueur)
     */
    syncAllFromStrobe() {
        if (!this.gui || !this._currentStrobe) return;
        const p = this._currentStrobe.params;
        if (this._posState) {
            this._posState.x = Math.round(p.posX * 100) / 100;
            this._posState.y = Math.round(p.posY * 100) / 100;
            this._posState.z = Math.round(p.posZ * 100) / 100;
        }
        if (this._rotState) {
            this._rotState.angle = p.angle;
            this._rotState.tilt = p.tilt;
            this._rotState.roll = p.roll;
        }
        for (const c of Object.values(this.controllers)) {
            try { c.updateDisplay(); } catch (_) {}
        }
        this._refreshDmxInfo();
    }

    /**
     * Injecte le bouton reset ↺ sur un contrôleur lil-gui
     */
    _setupController(ctrl, key, defaultVal) {
        this.controllers[key] = ctrl;
        if (!ctrl || !ctrl.domElement) return ctrl;

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'lil-reset-btn';
        resetBtn.title = 'Réinitialiser ce paramètre (↺)';
        resetBtn.innerHTML = '↺';

        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._currentStrobe) {
                this._currentStrobe.setParam(key, defaultVal);
            }
            ctrl.setValue(defaultVal);
        });

        const widgetEl = ctrl.domElement.querySelector('.widget');
        if (widgetEl) {
            widgetEl.appendChild(resetBtn);
        } else {
            ctrl.domElement.appendChild(resetBtn);
        }
        return ctrl;
    }

    /** Plage de canaux, conflits et valeurs DMX équivalentes aux réglages */
    _refreshDmxInfo() {
        const strobe = this._currentStrobe;
        if (!strobe || !this._dmxInfoEl) return;
        const p = strobe.params;
        const fp = strobe.dmxFootprint;
        const conflicts = strobe._patch ? strobe._patch.conflictsOf(strobe) : [];
        const values = encodeDmx(p);
        const lines = describeChannels(p.dmxMode, p.dmxAddress).map((c, i) => `${c.address} · ${c.name} : ${values[i]}`);
        let html = `Univers <b>${p.dmxUniverse}</b> · canaux <b>${p.dmxAddress} → ${p.dmxAddress + fp - 1}</b> (${fp} canaux)`;
        if (conflicts.length) html += `<br><span style="color:#ff8a65">Chevauche ${conflicts.length} autre(s) projecteur(s)</span>`;
        html += `<br><span style="opacity:.75">${p.dmxControl ? 'Piloté par le DMX : les réglages suivent la régie.' : 'Piloté par ce panneau (DMX ignoré).'}</span>`;
        html += `<div style="margin-top:4px;opacity:.7;font-family:monospace">${lines.join('<br>')}</div>`;
        this._dmxInfoEl.innerHTML = html;
    }

    /**
     * Réinitialise tous les paramètres du stroboscope sélectionné
     */
    resetAll() {
        if (!this._currentStrobe) return;
        for (const [k, defVal] of Object.entries(STROBE_DEFAULTS)) {
            this._currentStrobe.setParam(k, defVal);
            if (this.controllers[k] && typeof this.controllers[k].setValue === 'function') {
                try { this.controllers[k].setValue(defVal); } catch (_) {}
            }
        }
    }

    _buildGui() {
        if (this.gui) {
            this.gui.destroy();
            this.gui = null;
        }
        this.controllers = {};

        const strobe = this._currentStrobe;
        if (!strobe) return;
        const p = strobe.params;

        this.gui = new GUI({
            container: this.panelContainer,
            title: `⚡ Stroboscope #${strobe.number}`,
            autoPlace: false,
            width: 340,
        });

        // ── Titre personnalisé avec Reset Tout (↺) et Fermer (✕) ──
        const titleEl = this.gui.domElement.querySelector('.title');
        if (titleEl) {
            const rawTitle = `⚡ Stroboscope #${strobe.number}`;
            titleEl.textContent = '';

            const textSpan = document.createElement('span');
            textSpan.className = 'lil-panel-title-text';
            textSpan.textContent = rawTitle;
            titleEl.appendChild(textSpan);

            const resetAllBtn = document.createElement('span');
            resetAllBtn.setAttribute('role', 'button');
            resetAllBtn.setAttribute('tabindex', '0');
            resetAllBtn.className = 'lil-panel-reset-btn';
            resetAllBtn.title = 'Réinitialiser tous les paramètres du stroboscope (↺)';
            resetAllBtn.textContent = '↺ Tout reset';
            const triggerReset = (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.resetAll();
            };
            resetAllBtn.addEventListener('click', triggerReset);
            resetAllBtn.addEventListener('mousedown', (e) => e.stopPropagation());
            resetAllBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
            titleEl.appendChild(resetAllBtn);

            const closeBtn = document.createElement('span');
            closeBtn.setAttribute('role', 'button');
            closeBtn.setAttribute('tabindex', '0');
            closeBtn.className = 'lil-panel-close-btn';
            closeBtn.title = 'Fermer l\'inspecteur (Échap)';
            closeBtn.textContent = '✕';
            const triggerClose = (e) => {
                if (e) {
                    e.stopPropagation();
                    e.preventDefault();
                }
                this.close();
                if (this.ambiancePanel) {
                    this.ambiancePanel.deselectStrobe();
                }
            };
            closeBtn.addEventListener('click', triggerClose);
            closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
            closeBtn.addEventListener('mouseup', (e) => e.stopPropagation());
            closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
            closeBtn.addEventListener('pointerup', (e) => e.stopPropagation());
            titleEl.appendChild(closeBtn);

            makeDraggable(this.panelWrap, titleEl, 'strobe');
        }

        // ══════════════════════════════════════════════════════════════════
        // 1. Éclairage & Puissance
        // ══════════════════════════════════════════════════════════════════
        const fLight = this.gui.addFolder('💡 Éclairage & Puissance');
        fLight.open();
        if (fLight.domElement) fLight.domElement.classList.add('power-folder');

        this.controllers.power = this._setupController(
            fLight.add(p, 'power', 0, 100, 1).name('Puissance Lumineuse').onChange(v => strobe.setParam('power', v)),
            'power',
            STROBE_DEFAULTS.power
        );

        this.controllers.color = this._setupController(
            fLight.addColor(p, 'color').name('Couleur Lumière').onChange(v => strobe.setParam('color', v)),
            'color',
            STROBE_DEFAULTS.color
        );

        this.controllers.emissivePower = this._setupController(
            fLight.add(p, 'emissivePower', 0, 30, 0.5).name('Éclat Écran (Bloom)').onChange(v => strobe.setParam('emissivePower', v)),
            'emissivePower',
            STROBE_DEFAULTS.emissivePower
        );

        this.controllers.castShadow = this._setupController(
            fLight.add(p, 'castShadow').name('Afficher Ombres').onChange(v => strobe.setParam('castShadow', v)),
            'castShadow',
            STROBE_DEFAULTS.castShadow
        );

        this.controllers.shadowIntensity = this._setupController(
            fLight.add(p, 'shadowIntensity', 0.0, 1.0, 0.05).name('Intensité Ombres').onChange(v => strobe.setParam('shadowIntensity', v)),
            'shadowIntensity',
            STROBE_DEFAULTS.shadowIntensity
        );

        this.controllers.shadowSoftness = this._setupController(
            fLight.add(p, 'shadowSoftness', 0.0, 1.0, 0.05).name('Douceur Ombres').onChange(v => strobe.setParam('shadowSoftness', v)),
            'shadowSoftness',
            STROBE_DEFAULTS.shadowSoftness
        );

        if (p.distanceFactor === undefined) {
            p.distanceFactor = (p.lightDistance && p.lightDistance <= 10.0) ? p.lightDistance : 1.0;
        }

        this.controllers.distanceFactor = this._setupController(
            fLight.add(p, 'distanceFactor', 0.1, 10.0, 0.05).name('Portée Lumière (×)').onChange(v => strobe.setParam('distanceFactor', v)),
            'distanceFactor',
            STROBE_DEFAULTS.distanceFactor
        );

        // ══════════════════════════════════════════════════════════════════
        // 2. Dimensions du Boîtier 3D
        // ══════════════════════════════════════════════════════════════════
        const fSize = this.gui.addFolder('📐 Dimensions du Boîtier');
        fSize.open();

        this.controllers.showHousing = this._setupController(
            fSize.add(p, 'showHousing').name('Boîtier 3D (châssis)').onChange(v => strobe.setParam('showHousing', v)),
            'showHousing',
            STROBE_DEFAULTS.showHousing
        );

        this.controllers.width = this._setupController(
            fSize.add(p, 'width', 0.0, 50.0, 0.1).name('Largeur (m)').onChange(v => strobe.setParam('width', v)),
            'width',
            STROBE_DEFAULTS.width
        );

        this.controllers.height = this._setupController(
            fSize.add(p, 'height', 0.10, 50.0, 0.1).name('Hauteur (m)').onChange(v => strobe.setParam('height', v)),
            'height',
            STROBE_DEFAULTS.height
        );

        this.controllers.depth = this._setupController(
            fSize.add(p, 'depth', 0.10, 0.60, 0.02).name('Épaisseur (m)').onChange(v => strobe.setParam('depth', v)),
            'depth',
            STROBE_DEFAULTS.depth
        );

        // ══════════════════════════════════════════════════════════════════
        // 3. Effet Stroboscope
        // ══════════════════════════════════════════════════════════════════
        const fStrobe = this.gui.addFolder('⚡ Effet Stroboscope');
        fStrobe.open();

        this.controllers.strobeEnabled = this._setupController(
            fStrobe.add(p, 'strobeEnabled').name('Activer Flashs').onChange(v => strobe.setParam('strobeEnabled', v)),
            'strobeEnabled',
            STROBE_DEFAULTS.strobeEnabled
        );

        this.controllers.strobeSpeed = this._setupController(
            fStrobe.add(p, 'strobeSpeed', 0.5, 30.0, 0.5).name('Vitesse Flashs (Hz)').onChange(v => strobe.setParam('strobeSpeed', v)),
            'strobeSpeed',
            STROBE_DEFAULTS.strobeSpeed
        );

        this.controllers.pulseWidth = this._setupController(
            fStrobe.add(p, 'pulseWidth', 1, 100, 1).name('Durée Flash (%)').onChange(v => strobe.setParam('pulseWidth', v)),
            'pulseWidth',
            STROBE_DEFAULTS.pulseWidth
        );

        this.controllers.strobeRandom = this._setupController(
            fStrobe.add(p, 'strobeRandom').name('Mode Éclairs Aléatoires').onChange(v => strobe.setParam('strobeRandom', v)),
            'strobeRandom',
            STROBE_DEFAULTS.strobeRandom
        );

        // ══════════════════════════════════════════════════════════════════
        // 3b. DMX (patch, pilotage par la régie)
        // ══════════════════════════════════════════════════════════════════
        const fDmx = this.gui.addFolder('📡 DMX');
        fDmx.close();
        const onPatch = (key) => (v) => { strobe.setParam(key, v); this._refreshDmxInfo(); };
        this._setupController(
            fDmx.add(p, 'dmxControl').name('Piloté par le DMX').onChange(onPatch('dmxControl')),
            'dmxControl',
            false
        );
        this._setupController(
            fDmx.add(p, 'dimmer', 0, 100, 1).name('Dimmer (%)').onChange(v => strobe.setParam('dimmer', v)),
            'dimmer',
            100
        );
        this.controllers.dmxUniverse = fDmx.add(p, 'dmxUniverse', 1, 64, 1).name('Univers').onChange(onPatch('dmxUniverse'));
        this.controllers.dmxAddress = fDmx.add(p, 'dmxAddress', 1, 512, 1).name('Adresse').onChange(onPatch('dmxAddress'));
        this._dmxInfoEl = document.createElement('div');
        this._dmxInfoEl.style.cssText = 'padding:6px 8px;font-size:11px;line-height:1.5;opacity:.85';
        fDmx.$children.appendChild(this._dmxInfoEl);
        this._refreshDmxInfo();

        // ══════════════════════════════════════════════════════════════════
        // 4. Position & Orientation 3D
        // ══════════════════════════════════════════════════════════════════
        const fTransform = this.gui.addFolder('🧭 Position & Orientation');
        fTransform.open();

        // Mode Gizmo
        const gizmoModes = { mode: this._gizmoMode === 'rotate' ? 'Rotation' : 'Translation' };
        fTransform.add(gizmoModes, 'mode', ['Translation', 'Rotation']).name('Mode Gizmo').onChange((mode) => {
            this._gizmoMode = mode === 'Rotation' ? 'rotate' : 'translate';
            if (this.ambiancePanel && this.ambiancePanel.transformControls) {
                this.ambiancePanel.transformControls.setMode(this._gizmoMode);
            }
        });

        this._posState = {
            x: Math.round(p.posX * 100) / 100,
            y: Math.round(p.posY * 100) / 100,
            z: Math.round(p.posZ * 100) / 100,
        };

        const onPosChange = () => {
            strobe.setPosition(this._posState.x, this._posState.y, this._posState.z);
        };

        this.controllers.posX = this._setupController(
            fTransform.add(this._posState, 'x', -50, 50, 0.1).name('Position X').onChange(onPosChange),
            'posX',
            STROBE_DEFAULTS.posX
        );

        this.controllers.posY = this._setupController(
            fTransform.add(this._posState, 'y', 0, 30, 0.1).name('Position Y').onChange(onPosChange),
            'posY',
            STROBE_DEFAULTS.posY
        );

        this.controllers.posZ = this._setupController(
            fTransform.add(this._posState, 'z', -50, 50, 0.1).name('Position Z').onChange(onPosChange),
            'posZ',
            STROBE_DEFAULTS.posZ
        );

        this._rotState = {
            angle: Math.round(p.angle * 10) / 10,
            tilt:  Math.round(p.tilt * 10) / 10,
            roll:  Math.round(p.roll * 10) / 10,
        };

        const onRotChange = () => {
            strobe.setRotation(this._rotState.angle, this._rotState.tilt, this._rotState.roll);
        };

        this.controllers.angle = this._setupController(
            fTransform.add(this._rotState, 'angle', -180, 180, 1).name('Angle Horiz. (Yaw)').onChange(onRotChange),
            'angle',
            STROBE_DEFAULTS.angle
        );

        this.controllers.tilt = this._setupController(
            fTransform.add(this._rotState, 'tilt', -90, 90, 1).name('Inclinaison (Pitch)').onChange(onRotChange),
            'tilt',
            STROBE_DEFAULTS.tilt
        );

        this.controllers.roll = this._setupController(
            fTransform.add(this._rotState, 'roll', -180, 180, 1).name('Rotation (Roll)').onChange(onRotChange),
            'roll',
            STROBE_DEFAULTS.roll
        );

        // ══════════════════════════════════════════════════════════════════
        // 5. Actions (Harmonisé : Exporter, Dupliquer, Supprimer)
        // ══════════════════════════════════════════════════════════════════
        const fActions = this.gui.addFolder('⚙️ Actions');
        fActions.open();

        const actions = {
            export: () => {
                if (this.ambiancePanel) {
                    this.ambiancePanel.exportSelectedStrobe(strobe);
                }
            },
            duplicate: () => {
                if (!this.strobeManager) return;
                const res = this.strobeManager.duplicateStrobe(this._currentStrobeId);
                if (res && this.ambiancePanel) {
                    this.ambiancePanel.selectStrobe(res.strobe);
                }
            },
            delete: () => {
                if (!this.strobeManager) return;
                const idToDelete = this._currentStrobeId;
                if (this.ambiancePanel) {
                    this.ambiancePanel.deselectStrobe();
                } else {
                    this.close();
                }
                this.strobeManager.removeStrobe(idToDelete);
            }
        };

        fActions.add(actions, 'export').name('💾 Exporter');
        fActions.add(actions, 'duplicate').name('📋 Dupliquer');
        fActions.add(actions, 'delete').name('🗑️ Supprimer');
    }
}
