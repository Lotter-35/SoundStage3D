/**
 * LaserInspectorPanel.js
 * ─────────────────────────────────────────────────────────────
 * Panneau de contrôle d'un laser individuel avec lil-gui :
 * - Même DA (Direction Artistique) que le reste des menus (Ambiance, DSP)
 * - Structure identique au repo GitHub LaserSimulation :
 *     - "Style laser" (avec nouvelle option Pause Balayage)
 *     - "Tweeking visuel source"
 * - Outils de gizmo (Translation / Rotation) et actions (Dupliquer, Supprimer)
 * - Flottant à gauche de l'écran, déplaçable avec la souris sur le titre
 * ─────────────────────────────────────────────────────────────
 */

import GUI from 'lil-gui';
import { makeDraggable } from '../../ui/draggable.js';
import { LASER_PARAMS_SCHEMA } from '../config/laserParams.js';

export class LaserInspectorPanel {
    /**
     * @param {object} options
     * @param {import('../LaserManager.js').LaserManager} options.laserManager
     * @param {import('../../ui/AmbiancePanel.js').AmbiancePanel} [options.ambiancePanel]
     */
    constructor({ laserManager, ambiancePanel }) {
        this.laserManager = laserManager;
        this.ambiancePanel = ambiancePanel;

        this.panelWrap = document.getElementById('laser-panel-wrap');
        this.panelContainer = document.getElementById('laser-panel');

        this.gui = null;
        this._currentLaser = null;
        this._currentLaserId = null;
        this.controllers = {};
    }

    /**
     * Ouvre et construit l'interface lil-gui pour un laser donné.
     * @param {number} id
     * @param {import('../LaserShow.js').LaserShow} laserShow
     */
    openForLaser(id, laserShow) {
        this._currentLaser = laserShow;
        this._currentLaserId = id;

        if (this.panelWrap) {
            this.panelWrap.classList.remove('hidden');
        }

        this._buildGui();
    }

    /**
     * Ferme l'interface et masque le conteneur.
     */
    close() {
        if (this.gui) {
            this.gui.destroy();
            this.gui = null;
        }
        if (this.panelWrap) {
            this.panelWrap.classList.add('hidden');
        }
        this._currentLaser = null;
        this._currentLaserId = null;
        this.controllers = {};
    }

    get isOpen() {
        return this._currentLaser !== null && this.panelWrap && !this.panelWrap.classList.contains('hidden');
    }

    /**
     * Met à jour l'affichage des contrôleurs si le gizmo ou la scène a modifié le laser.
     */
    syncFromLaser() {
        if (!this.gui || !this._currentLaser) return;
        if (this._posState) {
            const housing = this._currentLaser.getHousingGroup();
            const p = housing ? housing.position : this._currentLaser.getPosition();
            this._posState.x = Math.round(p.x * 100) / 100;
            this._posState.y = Math.round(p.y * 100) / 100;
            this._posState.z = Math.round(p.z * 100) / 100;
        }
        if (this._rotState) {
            const p = this._currentLaser.params;
            this._rotState.angle = Math.round((p.angle || 0) * 10) / 10;
            this._rotState.tilt = Math.round((p.tilt || 0) * 10) / 10;
            this._rotState.roll = Math.round((p.roll || 0) * 10) / 10;
        }
        for (const ctrl of Object.values(this.controllers)) {
            if (ctrl && typeof ctrl.updateDisplay === 'function') {
                try { ctrl.updateDisplay(); } catch (_) {}
            }
        }
    }

    onSync(cb) {
        if (!this._syncCallbacks) this._syncCallbacks = [];
        this._syncCallbacks.push(cb);
    }

    _emitSync(payload) {
        if (this._isRemoteUpdate) return;
        if (this._syncCallbacks) {
            for (const cb of this._syncCallbacks) {
                try { cb(payload); } catch (e) { console.error('[LaserInspectorSync] emit error:', e); }
            }
        }
    }

    /**
     * Injecte le bouton de reset individuel (↺) à droite de chaque option lil-gui du laser
     */
    _setupController(ctrl, key) {
        if (!ctrl || !ctrl.domElement) return ctrl;

        const origOnChange = ctrl._onChange;
        ctrl.onChange((v) => {
            if (origOnChange) origOnChange.call(ctrl, v);
            if (this._currentLaser) {
                const payload = {
                    category: 'laser_param',
                    id: this._currentLaserId,
                    param: key,
                    value: v,
                };
                if (key === 'pauseMotion') {
                    if (v === true) {
                        this._currentLaser.isPaused = true;
                        this._currentLaser._frozenAnimTime = this._currentLaser._animTime;
                        payload.animTime = this._currentLaser._frozenAnimTime;
                    } else {
                        this._currentLaser.isPaused = false;
                        if (this._currentLaser._frozenAnimTime !== null && this._currentLaser._lastSharedTime !== undefined) {
                            this._currentLaser._pausedOffset = this._currentLaser._lastSharedTime - this._currentLaser._frozenAnimTime;
                            this._currentLaser._frozenAnimTime = null;
                        }
                        payload.pausedOffset = this._currentLaser._pausedOffset || 0;
                        payload.animTime = this._currentLaser._animTime;
                    }
                }
                this._emitSync(payload);
            }
        });

        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'lil-reset-btn';
        resetBtn.title = 'Réinitialiser ce paramètre (↺)';
        resetBtn.innerHTML = '↺';

        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const schema = LASER_PARAMS_SCHEMA[key];
            if (!schema) return;
            const defVal = schema.value;
            if (this._currentLaser) {
                this._currentLaser.setParam(key, defVal);
                const payload = {
                    category: 'laser_param',
                    id: this._currentLaserId,
                    param: key,
                    value: defVal,
                };
                if (key === 'pauseMotion') {
                    if (defVal === true) {
                        this._currentLaser.isPaused = true;
                        this._currentLaser._frozenAnimTime = this._currentLaser._animTime;
                        payload.animTime = this._currentLaser._frozenAnimTime;
                    } else {
                        this._currentLaser.isPaused = false;
                        if (this._currentLaser._frozenAnimTime !== null && this._currentLaser._lastSharedTime !== undefined) {
                            this._currentLaser._pausedOffset = this._currentLaser._lastSharedTime - this._currentLaser._frozenAnimTime;
                            this._currentLaser._frozenAnimTime = null;
                        }
                        payload.pausedOffset = this._currentLaser._pausedOffset || 0;
                        payload.animTime = this._currentLaser._animTime;
                    }
                }
                this._emitSync(payload);
            }
            ctrl.setValue(defVal);
        });

        const widgetEl = ctrl.domElement.querySelector('.widget');
        if (widgetEl) {
            widgetEl.appendChild(resetBtn);
        } else {
            ctrl.domElement.appendChild(resetBtn);
        }
        return ctrl;
    }

    /**
     * Réinitialise tous les paramètres du laser sélectionné à leurs valeurs par défaut
     */
    resetAllLaserParams() {
        if (!this._currentLaser) return;
        for (const [key, schema] of Object.entries(LASER_PARAMS_SCHEMA)) {
            this._currentLaser.setParam(key, schema.value);
            if (this.controllers[key] && typeof this.controllers[key].setValue === 'function') {
                try { this.controllers[key].setValue(schema.value); } catch (_) {}
            }
        }
        this._emitSync({
            category: 'laser_reset_all',
            id: this._currentLaserId,
        });
        this.syncFromLaser();
    }

    _buildGui() {
        if (this.gui) {
            this.gui.destroy();
            this.gui = null;
        }
        this.controllers = {};

        const laser = this._currentLaser;
        if (!laser) return;
        const p = laser.params;

        this.gui = new GUI({
            container: this.panelContainer,
            title: `🔴 Laser #${this._currentLaserId}`,
            autoPlace: false,
            width: 340,
        });

        // Boutons dans le titre du lil-gui : Reset Tout (↺) et Fermer (✕)
        const titleEl = this.gui.domElement.querySelector('.title');
        if (titleEl) {
            const rawTitle = `🔴 Laser #${this._currentLaserId}`;
            titleEl.textContent = ''; // Vider le texte brut injecté par lil-gui pour éviter les retours à la ligne flex

            const textSpan = document.createElement('span');
            textSpan.className = 'lil-panel-title-text';
            textSpan.textContent = rawTitle;
            titleEl.appendChild(textSpan);

            const resetAllBtn = document.createElement('span');
            resetAllBtn.setAttribute('role', 'button');
            resetAllBtn.setAttribute('tabindex', '0');
            resetAllBtn.className = 'lil-panel-reset-btn';
            resetAllBtn.title = 'Réinitialiser tous les paramètres du laser (↺)';
            resetAllBtn.textContent = '↺ Tout reset';
            const triggerReset = (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.resetAllLaserParams();
            };
            resetAllBtn.addEventListener('click', triggerReset);
            resetAllBtn.addEventListener('mousedown', (e) => e.stopPropagation());
            resetAllBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
            resetAllBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') triggerReset(e);
            });
            titleEl.appendChild(resetAllBtn);

            const closeBtn = document.createElement('span');
            closeBtn.setAttribute('role', 'button');
            closeBtn.setAttribute('tabindex', '0');
            closeBtn.className = 'lil-panel-close-btn';
            closeBtn.title = 'Fermer l\'inspecteur laser (Échap)';
            closeBtn.textContent = '✕';
            const triggerClose = (e) => {
                if (e) {
                    e.stopPropagation();
                    e.preventDefault();
                }
                this.close();
                if (this.ambiancePanel) {
                    this.ambiancePanel.deselectLaser();
                }
            };
            closeBtn.addEventListener('click', triggerClose);
            closeBtn.addEventListener('mousedown', (e) => e.stopPropagation());
            closeBtn.addEventListener('mouseup', (e) => e.stopPropagation());
            closeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
            closeBtn.addEventListener('pointerup', (e) => e.stopPropagation());
            closeBtn.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') triggerClose(e);
            });
            titleEl.appendChild(closeBtn);

            // Rendre le panneau déplaçable avec la souris sur le titre
            makeDraggable(this.panelWrap, titleEl, 'laser');
        }

        // ══════════════════════════════════════════════════════════════════
        // 1. Style
        // ══════════════════════════════════════════════════════════════════
        const fStyle = this.gui.addFolder('Style');
        fStyle.open();

        this.controllers.color = this._setupController(
            fStyle.addColor(p, 'color').name('Couleur').onChange(v => laser.setParam('color', v)),
            'color'
        );

        this.controllers.laserPan = this._setupController(
            fStyle.add(p, 'laserPan').name('Laser PAN').onChange(v => laser.setParam('laserPan', v)),
            'laserPan'
        );

        this.controllers.count = this._setupController(
            fStyle.add(p, 'count', 1, 32, 1).name('Nombre faisceaux').onChange(v => laser.setParam('count', v)),
            'count'
        );

        this.controllers.beamWidth = this._setupController(
            fStyle.add(p, 'beamWidth', 0, 5, 0.05).name('Taille faisceaux').onChange(v => laser.setParam('beamWidth', v)),
            'beamWidth'
        );

        this.controllers.spread = this._setupController(
            fStyle.add(p, 'spread', 0, 110, 0.1).name('Écart faisceaux').onChange(v => laser.setParam('spread', v)),
            'spread'
        );

        // ══════════════════════════════════════════════════════════════════
        // 2. Puissance
        // ══════════════════════════════════════════════════════════════════
        const fPower = this.gui.addFolder('⚡ Puissance');
        fPower.open();
        if (fPower.domElement) fPower.domElement.classList.add('power-folder');

        this.controllers.masterPower = this._setupController(
            fPower.add(p, 'masterPower', 0, 1.5, 0.05).name('Puissance Générale').onChange(v => laser.setParam('masterPower', v)),
            'masterPower'
        );

        this.controllers.beamPower = this._setupController(
            fPower.add(p, 'beamPower', 0, 1.5, 0.05).name('Puissance Traits').onChange(v => laser.setParam('beamPower', v)),
            'beamPower'
        );

        this.controllers.panPower = this._setupController(
            fPower.add(p, 'panPower', 0, 1.5, 0.05).name('Puissance PAN').onChange(v => laser.setParam('panPower', v)),
            'panPower'
        );

        // ══════════════════════════════════════════════════════════════════
        // 3. Diffusion
        // ══════════════════════════════════════════════════════════════════
        const fDiffusion = this.gui.addFolder('✨ Diffusion');
        fDiffusion.open();

        this.controllers.glowScattering = this._setupController(
            fDiffusion.add(p, 'glowScattering', 0, 3, 0.05).name('Faisceaux').onChange(v => laser.setParam('glowScattering', v)),
            'glowScattering'
        );

        this.controllers.sourceWhitePower = this._setupController(
            fDiffusion.add(p, 'sourceWhitePower', 0, 2.0, 0.05).name('Blanc sortie').onChange(v => laser.setParam('sourceWhitePower', v)),
            'sourceWhitePower'
        );

        // ══════════════════════════════════════════════════════════════════
        // 4. Balayage Automatique (3 axes buse fixe)
        // ══════════════════════════════════════════════════════════════════
        const fMotion = this.gui.addFolder('🌊 Balayage Automatique');
        fMotion.open();

        this.controllers.pauseMotion = this._setupController(
            fMotion.add(p, 'pauseMotion').name('Pause balayage').onChange(v => laser.setParam('pauseMotion', v)),
            'pauseMotion'
        );

        // Sous-catégorie 1 : Axe Haut / Bas (Pitch)
        const subPitch = fMotion.addFolder('↕️ Axe Haut / Bas (Pitch)');
        subPitch.open();

        this.controllers.pitchSweepAmp = this._setupController(
            subPitch.add(p, 'pitchSweepAmp', 0, 60, 0.5).name('Amplitude (°)').onChange(v => {
                laser.setParam('pitchSweepAmp', v);
                if (v > 0) {
                    if (laser.params.pitchSweepSpeed === 0) {
                        laser.setParam('pitchSweepSpeed', 1.0);
                        if (this.controllers.pitchSweepSpeed) this.controllers.pitchSweepSpeed.setValue(1.0);
                    }
                    if (laser.params.pauseMotion) {
                        laser.setParam('pauseMotion', false);
                        if (this.controllers.pauseMotion) this.controllers.pauseMotion.setValue(false);
                    }
                }
            }),
            'pitchSweepAmp'
        );

        this.controllers.pitchSweepSpeed = this._setupController(
            subPitch.add(p, 'pitchSweepSpeed', 0.0, 30.0, 0.1).name('Vitesse').onChange(v => laser.setParam('pitchSweepSpeed', v)),
            'pitchSweepSpeed'
        );

        // Sous-catégorie 2 : Axe Gauche / Droite (Yaw)
        const subYaw = fMotion.addFolder('↔️ Axe Gauche / Droite (Yaw)');
        subYaw.open();

        this.controllers.yawSweepAmp = this._setupController(
            subYaw.add(p, 'yawSweepAmp', 0, 60, 0.5).name('Amplitude (°)').onChange(v => {
                laser.setParam('yawSweepAmp', v);
                if (v > 0) {
                    if (laser.params.yawSweepSpeed === 0) {
                        laser.setParam('yawSweepSpeed', 1.0);
                        if (this.controllers.yawSweepSpeed) this.controllers.yawSweepSpeed.setValue(1.0);
                    }
                    if (laser.params.pauseMotion) {
                        laser.setParam('pauseMotion', false);
                        if (this.controllers.pauseMotion) this.controllers.pauseMotion.setValue(false);
                    }
                }
            }),
            'yawSweepAmp'
        );

        this.controllers.yawSweepSpeed = this._setupController(
            subYaw.add(p, 'yawSweepSpeed', 0.0, 30.0, 0.1).name('Vitesse').onChange(v => laser.setParam('yawSweepSpeed', v)),
            'yawSweepSpeed'
        );

        // Sous-catégorie 3 : Axe Rotation (Roll)
        const subRoll = fMotion.addFolder('🔄 Axe Rotation (Roll)');
        subRoll.open();

        this.controllers.rollContinuous = this._setupController(
            subRoll.add(p, 'rollContinuous').name('Rotation continue (360°)').onChange(v => {
                laser.setParam('rollContinuous', v);
                if (v) {
                    if (laser.params.rollSweepSpeed === 0) {
                        laser.setParam('rollSweepSpeed', 1.0);
                        if (this.controllers.rollSweepSpeed) this.controllers.rollSweepSpeed.setValue(1.0);
                    }
                    if (laser.params.pauseMotion) {
                        laser.setParam('pauseMotion', false);
                        if (this.controllers.pauseMotion) this.controllers.pauseMotion.setValue(false);
                    }
                }
            }),
            'rollContinuous'
        );

        this.controllers.rollSweepAmp = this._setupController(
            subRoll.add(p, 'rollSweepAmp', 0, 360, 1).name('Amplitude (°)').onChange(v => {
                laser.setParam('rollSweepAmp', v);
                if (v > 0) {
                    if (laser.params.rollSweepSpeed === 0) {
                        laser.setParam('rollSweepSpeed', 1.0);
                        if (this.controllers.rollSweepSpeed) this.controllers.rollSweepSpeed.setValue(1.0);
                    }
                    if (laser.params.pauseMotion) {
                        laser.setParam('pauseMotion', false);
                        if (this.controllers.pauseMotion) this.controllers.pauseMotion.setValue(false);
                    }
                }
            }),
            'rollSweepAmp'
        );

        this.controllers.rollSweepSpeed = this._setupController(
            subRoll.add(p, 'rollSweepSpeed', 0.0, 10.0, 0.1).name('Vitesse').onChange(v => laser.setParam('rollSweepSpeed', v)),
            'rollSweepSpeed'
        );

        // ══════════════════════════════════════════════════════════════════
        // 5. Forme du laser
        // ══════════════════════════════════════════════════════════════════
        const fShape = this.gui.addFolder('📐 Forme du laser');
        fShape.open();

        this.controllers.patternShape = this._setupController(
            fShape.add(p, 'patternShape', ['Horizontal', 'Sinusoïde', 'Parabolique', 'Zigzag', 'Vague Double']).name('Forme tracé').onChange(v => laser.setParam('patternShape', v)),
            'patternShape'
        );

        this.controllers.curveAmplitude = this._setupController(
            fShape.add(p, 'curveAmplitude', 0, 1.5, 0.01).name('Amplitude').onChange(v => laser.setParam('curveAmplitude', v)),
            'curveAmplitude'
        );

        this.controllers.curveFrequency = this._setupController(
            fShape.add(p, 'curveFrequency', 0.25, 6, 0.25).name('Fréquence').onChange(v => laser.setParam('curveFrequency', v)),
            'curveFrequency'
        );

        // ══════════════════════════════════════════════════════════════════
        // 6. Déviation Faisceau (Buse fixe — le boîtier reste statique)
        // ══════════════════════════════════════════════════════════════════
        const fBeamAim = this.gui.addFolder('🎯 Déviation Faisceau (Buse fixe)');
        fBeamAim.open();

        this.controllers.beamPitchOffset = this._setupController(
            fBeamAim.add(p, 'beamPitchOffset', -60, 60, 1).name('Haut / Bas (°)').onChange(v => laser.setParam('beamPitchOffset', v)),
            'beamPitchOffset'
        );

        this.controllers.beamYawOffset = this._setupController(
            fBeamAim.add(p, 'beamYawOffset', -60, 60, 1).name('Gauche / Droite (°)').onChange(v => laser.setParam('beamYawOffset', v)),
            'beamYawOffset'
        );

        this.controllers.beamRollOffset = this._setupController(
            fBeamAim.add(p, 'beamRollOffset', 0, 360, 1).name('Rotation Faisceau (°)').onChange(v => laser.setParam('beamRollOffset', v)),
            'beamRollOffset'
        );

        // ══════════════════════════════════════════════════════════════════
        // 7. Clignotement (Stroboscope)
        // ══════════════════════════════════════════════════════════════════
        const fStrobe = this.gui.addFolder('⚡ Clignotement (Stroboscope)');
        fStrobe.close();

        this.controllers.strobe = this._setupController(
            fStrobe.add(p, 'strobe').name('Clignotement').onChange(v => laser.setParam('strobe', v)),
            'strobe'
        );

        this.controllers.strobeSpeed = this._setupController(
            fStrobe.add(p, 'strobeSpeed', 0.5, 30, 0.5).name('Vitesse clignotement').onChange(v => laser.setParam('strobeSpeed', v)),
            'strobeSpeed'
        );

        // ══════════════════════════════════════════════════════════════════
        // 8. Fumée Laser PAN (fermée par défaut)
        // ══════════════════════════════════════════════════════════════════
        const fSmoke = this.gui.addFolder('💨 Fumée Laser PAN');
        fSmoke.close();

        this.controllers.panSmokeEnabled = this._setupController(
            fSmoke.add(p, 'panSmokeEnabled').name('Activer fumée').onChange(v => laser.setParam('panSmokeEnabled', v)),
            'panSmokeEnabled'
        );

        this.controllers.panSmokeSpeed = this._setupController(
            fSmoke.add(p, 'panSmokeSpeed', 0.05, 3.0, 0.05).name('Vitesse fumée').onChange(v => laser.setParam('panSmokeSpeed', v)),
            'panSmokeSpeed'
        );

        this.controllers.panSmokeScale = this._setupController(
            fSmoke.add(p, 'panSmokeScale', 0.10, 1.0, 0.01).name('Échelle volutes').onChange(v => laser.setParam('panSmokeScale', v)),
            'panSmokeScale'
        );

        this.controllers.panSmokeContrast = this._setupController(
            fSmoke.add(p, 'panSmokeContrast', 0.0, 1.0, 0.05).name('Contraste').onChange(v => laser.setParam('panSmokeContrast', v)),
            'panSmokeContrast'
        );

        this.controllers.panSmokeBrightness = this._setupController(
            fSmoke.add(p, 'panSmokeBrightness', 0.0, 3.0, 0.05).name('Brillance').onChange(v => laser.setParam('panSmokeBrightness', v)),
            'panSmokeBrightness'
        );

        this.controllers.panSmokeWindChange = this._setupController(
            fSmoke.add(p, 'panSmokeWindChange', 0.0, 3.0, 0.05).name('Variation vent').onChange(v => laser.setParam('panSmokeWindChange', v)),
            'panSmokeWindChange'
        );

        this.controllers.panSmokeSpeedVariation = this._setupController(
            fSmoke.add(p, 'panSmokeSpeedVariation', 0.0, 2.0, 0.05).name('Rafales').onChange(v => laser.setParam('panSmokeSpeedVariation', v)),
            'panSmokeSpeedVariation'
        );

        this.controllers.panSmokePerpSpeed = this._setupController(
            fSmoke.add(p, 'panSmokePerpSpeed', 0.01, 1.0, 0.01).name('Vitesse perp.').onChange(v => laser.setParam('panSmokePerpSpeed', v)),
            'panSmokePerpSpeed'
        );

        // ── Surcouche Poches / Amas Hétérogènes ──
        const fPatches = fSmoke.addFolder('☁️ Poches & Amas');
        fPatches.close();

        this.controllers.panSmokePatchContrast = this._setupController(
            fPatches.add(p, 'panSmokePatchContrast', 0.0, 1.5, 0.05).name('Contraste').onChange(v => laser.setParam('panSmokePatchContrast', v)),
            'panSmokePatchContrast'
        );

        this.controllers.panSmokePatchScale = this._setupController(
            fPatches.add(p, 'panSmokePatchScale', 0.01, 0.30, 0.01).name('Taille').onChange(v => laser.setParam('panSmokePatchScale', v)),
            'panSmokePatchScale'
        );

        this.controllers.panSmokePatchDensity = this._setupController(
            fPatches.add(p, 'panSmokePatchDensity', 0.0, 1.0, 0.05).name('Densité').onChange(v => laser.setParam('panSmokePatchDensity', v)),
            'panSmokePatchDensity'
        );

        this.controllers.panSmokePatchSpeed = this._setupController(
            fPatches.add(p, 'panSmokePatchSpeed', 0.0, 1.0, 0.02).name('Dérive').onChange(v => laser.setParam('panSmokePatchSpeed', v)),
            'panSmokePatchSpeed'
        );

        // ══════════════════════════════════════════════════════════════════
        // 7. Visuel source (fermée par défaut)
        // ══════════════════════════════════════════════════════════════════
        const fVisual = this.gui.addFolder('Visuel source');
        fVisual.close();

        this.controllers.sourceEmissionPower = this._setupController(
            fVisual.add(p, 'sourceEmissionPower', 0, 4, 0.05).name('Puissance buse').onChange(v => laser.setParam('sourceEmissionPower', v)),
            'sourceEmissionPower'
        );

        this.controllers.sourceGlowRadius = this._setupController(
            fVisual.add(p, 'sourceGlowRadius', 0.2, 3, 0.1).name('Rayon buse').onChange(v => laser.setParam('sourceGlowRadius', v)),
            'sourceGlowRadius'
        );

        this.controllers.giIntensity = this._setupController(
            fVisual.add(p, 'giIntensity', 0, 10, 0.1).name('Intensité GI').onChange(v => laser.setParam('giIntensity', v)),
            'giIntensity'
        );

        this.controllers.giDistance = this._setupController(
            fVisual.add(p, 'giDistance', 2, 60, 0.5).name('Portée GI').onChange(v => laser.setParam('giDistance', v)),
            'giDistance'
        );

        this.controllers.giWallOffset = this._setupController(
            fVisual.add(p, 'giWallOffset', -5, 10, 0.1).name('Recul mur').onChange(v => laser.setParam('giWallOffset', v)),
            'giWallOffset'
        );

        this.controllers.enableImpactLights = this._setupController(
            fVisual.add(p, 'enableImpactLights').name('Lumières impacts').onChange(v => laser.setParam('enableImpactLights', v)),
            'enableImpactLights'
        );

        this.controllers.giImpactIntensity = this._setupController(
            fVisual.add(p, 'giImpactIntensity', 0, 10, 0.1).name('Intensité impact').onChange(v => laser.setParam('giImpactIntensity', v)),
            'giImpactIntensity'
        );

        this.controllers.giImpactDistance = this._setupController(
            fVisual.add(p, 'giImpactDistance', 2, 40, 0.5).name('Portée impact').onChange(v => laser.setParam('giImpactDistance', v)),
            'giImpactDistance'
        );

        // ══════════════════════════════════════════════════════════════════
        // 9. Position & Orientation 3D (Déplace TOUT : Boîtier + Faisceau)
        // ══════════════════════════════════════════════════════════════════
        const fTransform = this.gui.addFolder('🧭 Position & Orientation');
        fTransform.open();

        // Mode Gizmo
        const currentGizmoMode = (this.ambiancePanel && this.ambiancePanel.transformControls)
            ? (this.ambiancePanel.transformControls.getMode() || 'translate')
            : (this._gizmoMode || 'translate');
        const gizmoModes = { mode: currentGizmoMode === 'rotate' ? 'Rotation' : 'Translation' };

        fTransform.add(gizmoModes, 'mode', ['Translation', 'Rotation']).name('Mode Gizmo').onChange((mode) => {
            this._gizmoMode = mode === 'Rotation' ? 'rotate' : 'translate';
            if (this.ambiancePanel) {
                this.ambiancePanel.setGizmoMode(this._gizmoMode);
            }
        });

        const housing = laser.getHousingGroup();
        const curPos = housing ? housing.position : laser.getPosition();
        this._posState = {
            x: Math.round(curPos.x * 100) / 100,
            y: Math.round(curPos.y * 100) / 100,
            z: Math.round(curPos.z * 100) / 100,
        };

        const onPosChange = () => {
            laser.setPosition(this._posState.x, this._posState.y, this._posState.z);
            if (housing) housing.position.set(this._posState.x, this._posState.y, this._posState.z);
            if (this.ambiancePanel && this.ambiancePanel.transformControls && this.ambiancePanel.transformControls.object === housing) {
                this.ambiancePanel.transformControls.updateMatrixWorld();
            }
            if (this.ambiancePanel && this.ambiancePanel._emitSync) {
                this.ambiancePanel._emitSync({
                    category: 'laser_transform',
                    id: laser.laserId,
                    data: { position: { x: this._posState.x, y: this._posState.y, z: this._posState.z } }
                });
            }
        };

        this.controllers.posX = this._setupController(
            fTransform.add(this._posState, 'x', -100, 100, 0.1).name('Position X').onChange(onPosChange),
            'posX'
        );

        this.controllers.posY = this._setupController(
            fTransform.add(this._posState, 'y', 0, 50, 0.1).name('Position Y').onChange(onPosChange),
            'posY'
        );

        this.controllers.posZ = this._setupController(
            fTransform.add(this._posState, 'z', -100, 100, 0.1).name('Position Z').onChange(onPosChange),
            'posZ'
        );

        this._rotState = {
            angle: Math.round((p.angle || 0) * 10) / 10,
            tilt:  Math.round((p.tilt || 0) * 10) / 10,
            roll:  Math.round((p.roll || 0) * 10) / 10,
        };

        const onRotChange = () => {
            laser.setParam('angle', this._rotState.angle);
            laser.setParam('tilt', this._rotState.tilt);
            laser.setParam('roll', this._rotState.roll);
            if (housing) {
                housing.rotation.set(
                    -this._rotState.tilt * (Math.PI / 180),
                    this._rotState.angle * (Math.PI / 180),
                    this._rotState.roll * (Math.PI / 180),
                    'YXZ'
                );
                housing.updateMatrixWorld();
            }
            if (this.ambiancePanel && this.ambiancePanel.transformControls && this.ambiancePanel.transformControls.object === housing) {
                this.ambiancePanel.transformControls.updateMatrixWorld();
            }
            if (this.ambiancePanel && this.ambiancePanel._emitSync) {
                this.ambiancePanel._emitSync({
                    category: 'laser_transform',
                    id: laser.laserId,
                    data: { rotation: { angle: this._rotState.angle, tilt: this._rotState.tilt, roll: this._rotState.roll } }
                });
            }
        };

        this.controllers.angle = this._setupController(
            fTransform.add(this._rotState, 'angle', -180, 180, 1).name('Angle Horiz. (Yaw)').onChange(onRotChange),
            'angle'
        );

        this.controllers.tilt = this._setupController(
            fTransform.add(this._rotState, 'tilt', -90, 90, 1).name('Inclinaison (Pitch)').onChange(onRotChange),
            'tilt'
        );

        this.controllers.roll = this._setupController(
            fTransform.add(this._rotState, 'roll', -180, 180, 1).name('Rotation (Roll)').onChange(onRotChange),
            'roll'
        );

        // ══════════════════════════════════════════════════════════════════
        // 10. Actions (Harmonisé : Exporter, Dupliquer, Supprimer)
        // ══════════════════════════════════════════════════════════════════
        const fActions = this.gui.addFolder('⚙️ Actions');
        fActions.open();

        const panelActions = {
            exportLaser: () => {
                if (this.ambiancePanel) {
                    this.ambiancePanel.exportSelectedLaser(laser);
                }
            },
            duplicate: () => {
                if (this.ambiancePanel) {
                    this.ambiancePanel.duplicateSelectedLaser(laser);
                }
            },
            deleteLaser: () => {
                if (this.ambiancePanel) {
                    const id = laser.laserId;
                    this.close();
                    if (this.ambiancePanel.laserManager) {
                        this.ambiancePanel.laserManager.removeLaser(id);
                    }
                    this.ambiancePanel.deselectLaser();
                    this.ambiancePanel._buildGui();
                    this.ambiancePanel._emitSync({ category: 'laser_remove', id });
                }
            }
        };

        fActions.add(panelActions, 'exportLaser').name('💾 Exporter');
        fActions.add(panelActions, 'duplicate').name('📋 Dupliquer');
        fActions.add(panelActions, 'deleteLaser').name('🗑️ Supprimer');
    }
}

