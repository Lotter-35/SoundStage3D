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
            this._posState.x = p.x;
            this._posState.y = p.y;
            this._posState.z = p.z;
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
                this._emitSync({
                    category: 'laser_param',
                    id: this._currentLaserId,
                    param: key,
                    value: v,
                });
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
            width: 300,
        });

        // Boutons dans le titre du lil-gui : Reset Tout (↺) et Fermer (✕)
        const titleEl = this.gui.domElement.querySelector('.title');
        if (titleEl) {
            const resetAllBtn = document.createElement('button');
            resetAllBtn.className = 'lil-panel-reset-btn';
            resetAllBtn.title = 'Réinitialiser tous les paramètres du laser (↺)';
            resetAllBtn.innerHTML = '↺ Tout reset';
            resetAllBtn.style.marginRight = '6px';
            resetAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.resetAllLaserParams();
            });
            titleEl.appendChild(resetAllBtn);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'lil-panel-reset-btn';
            closeBtn.title = 'Fermer l\'inspecteur laser (Échap)';
            closeBtn.innerHTML = '✕';
            closeBtn.style.marginRight = '4px';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.ambiancePanel) {
                    this.ambiancePanel.deselectLaser();
                } else {
                    this.close();
                }
            });
            titleEl.appendChild(closeBtn);

            // Rendre le panneau déplaçable avec la souris sur le titre
            makeDraggable(this.panelWrap, titleEl, 'laser');
        }

        // ══════════════════════════════════════════════════════════════════
        // 1. Style laser (Toujours ouvert en haut — fidèle au GitHub Laser)
        // ══════════════════════════════════════════════════════════════════
        const fStyle = this.gui.addFolder('Style laser');
        fStyle.open();

        this.controllers.count = this._setupController(
            fStyle.add(p, 'count', 1, 32, 1).name('Nombre Trait').onChange(v => laser.setParam('count', v)),
            'count'
        );

        this.controllers.beamWidth = this._setupController(
            fStyle.add(p, 'beamWidth', 0, 5, 0.05).name('Taille Trait').onChange(v => laser.setParam('beamWidth', v)),
            'beamWidth'
        );

        this.controllers.spread = this._setupController(
            fStyle.add(p, 'spread', 0, 110, 0.1).name('Écart laser').onChange(v => laser.setParam('spread', v)),
            'spread'
        );

        this.controllers.color = this._setupController(
            fStyle.addColor(p, 'color').name('Couleur').onChange(v => laser.setParam('color', v)),
            'color'
        );

        this.controllers.laserPan = this._setupController(
            fStyle.add(p, 'laserPan').name('Laser PAN').onChange(v => laser.setParam('laserPan', v)),
            'laserPan'
        );

        this.controllers.masterPower = this._setupController(
            fStyle.add(p, 'masterPower', 0, 1.5, 0.05).name('Puissance Générale').onChange(v => laser.setParam('masterPower', v)),
            'masterPower'
        );

        this.controllers.beamPower = this._setupController(
            fStyle.add(p, 'beamPower', 0, 1.5, 0.05).name('Puissance Traits').onChange(v => laser.setParam('beamPower', v)),
            'beamPower'
        );

        this.controllers.panPower = this._setupController(
            fStyle.add(p, 'panPower', 0, 1.5, 0.05).name('Puissance PAN').onChange(v => laser.setParam('panPower', v)),
            'panPower'
        );

        this.controllers.glowScattering = this._setupController(
            fStyle.add(p, 'glowScattering', 0, 3, 0.05).name('Diffusion Faisceau').onChange(v => laser.setParam('glowScattering', v)),
            'glowScattering'
        );

        this.controllers.strobe = this._setupController(
            fStyle.add(p, 'strobe').name('Clignotement').onChange(v => laser.setParam('strobe', v)),
            'strobe'
        );

        this.controllers.strobeSpeed = this._setupController(
            fStyle.add(p, 'strobeSpeed', 0.5, 30, 0.5).name('Vitesse Cligno (Hz)').onChange(v => laser.setParam('strobeSpeed', v)),
            'strobeSpeed'
        );

        this.controllers.patternShape = this._setupController(
            fStyle.add(p, 'patternShape', ['Horizontal', 'Sinusoïde', 'Parabolique', 'Zigzag', 'Vague Double']).name('Forme Tracé').onChange(v => laser.setParam('patternShape', v)),
            'patternShape'
        );

        this.controllers.curveAmplitude = this._setupController(
            fStyle.add(p, 'curveAmplitude', 0, 1.5, 0.01).name('Amplitude Courbe').onChange(v => laser.setParam('curveAmplitude', v)),
            'curveAmplitude'
        );

        this.controllers.curveFrequency = this._setupController(
            fStyle.add(p, 'curveFrequency', 0.25, 6, 0.25).name('Fréquence Courbe').onChange(v => laser.setParam('curveFrequency', v)),
            'curveFrequency'
        );

        this.controllers.pauseMotion = this._setupController(
            fStyle.add(p, 'pauseMotion').name('⏸️ Pause Balayage').onChange(v => laser.setParam('pauseMotion', v)),
            'pauseMotion'
        );

        // ══════════════════════════════════════════════════════════════════
        // 2. Fumée Laser PAN (SimonDev Shader - Nouvelle catégorie)
        // ══════════════════════════════════════════════════════════════════
        const fSmoke = this.gui.addFolder('💨 Fumée Laser PAN');
        fSmoke.open();

        this.controllers.panSmokeEnabled = this._setupController(
            fSmoke.add(p, 'panSmokeEnabled').name('Activer Fumée').onChange(v => laser.setParam('panSmokeEnabled', v)),
            'panSmokeEnabled'
        );

        this.controllers.panSmokeSpeed = this._setupController(
            fSmoke.add(p, 'panSmokeSpeed', 0.05, 3.0, 0.05).name('Vitesse Fumée').onChange(v => laser.setParam('panSmokeSpeed', v)),
            'panSmokeSpeed'
        );

        this.controllers.panSmokeScale = this._setupController(
            fSmoke.add(p, 'panSmokeScale', 0.10, 1.0, 0.01).name('Échelle Volutes').onChange(v => laser.setParam('panSmokeScale', v)),
            'panSmokeScale'
        );

        this.controllers.panSmokeContrast = this._setupController(
            fSmoke.add(p, 'panSmokeContrast', 0.0, 1.0, 0.05).name('Contraste Turbulence').onChange(v => laser.setParam('panSmokeContrast', v)),
            'panSmokeContrast'
        );

        this.controllers.panSmokeBrightness = this._setupController(
            fSmoke.add(p, 'panSmokeBrightness', 0.0, 2.0, 0.05).name('Brillance Fumée').onChange(v => laser.setParam('panSmokeBrightness', v)),
            'panSmokeBrightness'
        );

        this.controllers.panSmokeWindChange = this._setupController(
            fSmoke.add(p, 'panSmokeWindChange', 0.0, 3.0, 0.05).name('Variation Vent').onChange(v => laser.setParam('panSmokeWindChange', v)),
            'panSmokeWindChange'
        );

        this.controllers.panSmokeSpeedVariation = this._setupController(
            fSmoke.add(p, 'panSmokeSpeedVariation', 0.0, 2.0, 0.05).name('Accélération Rafales').onChange(v => laser.setParam('panSmokeSpeedVariation', v)),
            'panSmokeSpeedVariation'
        );

        // ── Surcouche Poches / Amas Hétérogènes ──
        const fPatches = fSmoke.addFolder('☁️ Poches & Amas (Surcouche)');
        fPatches.open();

        this.controllers.panSmokePatchContrast = this._setupController(
            fPatches.add(p, 'panSmokePatchContrast', 0.0, 1.5, 0.05).name('Contraste Poches').onChange(v => laser.setParam('panSmokePatchContrast', v)),
            'panSmokePatchContrast'
        );

        this.controllers.panSmokePatchScale = this._setupController(
            fPatches.add(p, 'panSmokePatchScale', 0.01, 0.30, 0.01).name('Taille Poches').onChange(v => laser.setParam('panSmokePatchScale', v)),
            'panSmokePatchScale'
        );

        this.controllers.panSmokePatchDensity = this._setupController(
            fPatches.add(p, 'panSmokePatchDensity', 0.0, 1.0, 0.05).name('Densité Poches').onChange(v => laser.setParam('panSmokePatchDensity', v)),
            'panSmokePatchDensity'
        );

        this.controllers.panSmokePatchSpeed = this._setupController(
            fPatches.add(p, 'panSmokePatchSpeed', 0.0, 1.0, 0.02).name('Vitesse Dérive Poches').onChange(v => laser.setParam('panSmokePatchSpeed', v)),
            'panSmokePatchSpeed'
        );

        // ══════════════════════════════════════════════════════════════════
        // 4. Tweeking visuel source (Fidèle au GitHub Laser)
        // ══════════════════════════════════════════════════════════════════
        const fVisual = this.gui.addFolder('Tweeking visuel source');
        fVisual.open();

        this.controllers.sourceEmissionPower = this._setupController(
            fVisual.add(p, 'sourceEmissionPower', 0, 4, 0.05).name('Puissance Buse').onChange(v => laser.setParam('sourceEmissionPower', v)),
            'sourceEmissionPower'
        );

        this.controllers.sourceGlowRadius = this._setupController(
            fVisual.add(p, 'sourceGlowRadius', 0.2, 3, 0.1).name('Rayon Halo Buse').onChange(v => laser.setParam('sourceGlowRadius', v)),
            'sourceGlowRadius'
        );

        this.controllers.giIntensity = this._setupController(
            fVisual.add(p, 'giIntensity', 0, 10, 0.1).name('Intensité Éclairage').onChange(v => laser.setParam('giIntensity', v)),
            'giIntensity'
        );

        this.controllers.giDistance = this._setupController(
            fVisual.add(p, 'giDistance', 2, 60, 0.5).name('Portée Éclairage').onChange(v => laser.setParam('giDistance', v)),
            'giDistance'
        );

        this.controllers.giWallOffset = this._setupController(
            fVisual.add(p, 'giWallOffset', -5, 10, 0.1).name('Recul Lumière Mur').onChange(v => laser.setParam('giWallOffset', v)),
            'giWallOffset'
        );

        this.controllers.enableImpactLights = this._setupController(
            fVisual.add(p, 'enableImpactLights').name('Lumières Impacts').onChange(v => laser.setParam('enableImpactLights', v)),
            'enableImpactLights'
        );

        this.controllers.giImpactIntensity = this._setupController(
            fVisual.add(p, 'giImpactIntensity', 0, 10, 0.1).name('Intensité Lumière').onChange(v => laser.setParam('giImpactIntensity', v)),
            'giImpactIntensity'
        );

        this.controllers.giImpactDistance = this._setupController(
            fVisual.add(p, 'giImpactDistance', 2, 40, 0.5).name('Portée Lumière').onChange(v => laser.setParam('giImpactDistance', v)),
            'giImpactDistance'
        );
    }
}

