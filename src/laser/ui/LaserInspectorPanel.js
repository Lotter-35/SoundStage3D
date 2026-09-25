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
        for (const ctrl of Object.values(this.controllers)) {
            if (ctrl && typeof ctrl.updateDisplay === 'function') {
                try { ctrl.updateDisplay(); } catch (_) {}
            }
        }
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

        // Bouton de fermeture (✕) dans le titre du lil-gui
        const titleEl = this.gui.domElement.querySelector('.title');
        if (titleEl) {
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

        this.controllers.count = fStyle.add(p, 'count', 1, 32, 1)
            .name('Nombre Trait')
            .onChange(v => laser.setParam('count', v));

        this.controllers.beamWidth = fStyle.add(p, 'beamWidth', 0, 3, 0.05)
            .name('Taille Trait')
            .onChange(v => laser.setParam('beamWidth', v));

        this.controllers.spread = fStyle.add(p, 'spread', 0, 110, 0.1)
            .name('Écart laser')
            .onChange(v => laser.setParam('spread', v));

        this.controllers.color = fStyle.addColor(p, 'color')
            .name('Couleur')
            .onChange(v => laser.setParam('color', v));

        this.controllers.laserPan = fStyle.add(p, 'laserPan')
            .name('Laser PAN')
            .onChange(v => laser.setParam('laserPan', v));

        this.controllers.masterPower = fStyle.add(p, 'masterPower', 0, 1.5, 0.05)
            .name('Puissance Générale')
            .onChange(v => laser.setParam('masterPower', v));

        this.controllers.beamPower = fStyle.add(p, 'beamPower', 0, 1.5, 0.05)
            .name('Puissance Traits')
            .onChange(v => laser.setParam('beamPower', v));

        this.controllers.panPower = fStyle.add(p, 'panPower', 0, 1.5, 0.05)
            .name('Puissance PAN')
            .onChange(v => laser.setParam('panPower', v));

        this.controllers.strobe = fStyle.add(p, 'strobe')
            .name('Clignotement')
            .onChange(v => laser.setParam('strobe', v));

        this.controllers.strobeSpeed = fStyle.add(p, 'strobeSpeed', 0.5, 30, 0.5)
            .name('Vitesse Cligno (Hz)')
            .onChange(v => laser.setParam('strobeSpeed', v));

        this.controllers.patternShape = fStyle.add(p, 'patternShape', ['Horizontal', 'Sinusoïde', 'Parabolique', 'Zigzag', 'Vague Double'])
            .name('Forme Tracé')
            .onChange(v => laser.setParam('patternShape', v));

        this.controllers.curveAmplitude = fStyle.add(p, 'curveAmplitude', 0, 1.5, 0.01)
            .name('Amplitude Courbe')
            .onChange(v => laser.setParam('curveAmplitude', v));

        this.controllers.curveFrequency = fStyle.add(p, 'curveFrequency', 0.25, 6, 0.25)
            .name('Fréquence Courbe')
            .onChange(v => laser.setParam('curveFrequency', v));

        // Option demandée par l'utilisateur : Pause sur le déplacement / balayage
        this.controllers.pauseMotion = fStyle.add(p, 'pauseMotion')
            .name('⏸️ Pause Balayage')
            .onChange(v => laser.setParam('pauseMotion', v));

        // ══════════════════════════════════════════════════════════════════
        // 2. Tweeking visuel source (Fidèle au GitHub Laser)
        // ══════════════════════════════════════════════════════════════════
        const fVisual = this.gui.addFolder('Tweeking visuel source');
        fVisual.open();

        this.controllers.sourceEmissionPower = fVisual.add(p, 'sourceEmissionPower', 0, 4, 0.05)
            .name('Puissance Buse')
            .onChange(v => laser.setParam('sourceEmissionPower', v));

        this.controllers.sourceGlowRadius = fVisual.add(p, 'sourceGlowRadius', 0.2, 3, 0.1)
            .name('Rayon Halo Buse')
            .onChange(v => laser.setParam('sourceGlowRadius', v));

        this.controllers.giIntensity = fVisual.add(p, 'giIntensity', 0, 10, 0.1)
            .name('Intensité Éclairage')
            .onChange(v => laser.setParam('giIntensity', v));

        this.controllers.giDistance = fVisual.add(p, 'giDistance', 2, 60, 0.5)
            .name('Portée Éclairage')
            .onChange(v => laser.setParam('giDistance', v));

        this.controllers.giWallOffset = fVisual.add(p, 'giWallOffset', -5, 10, 0.1)
            .name('Recul Lumière Mur')
            .onChange(v => laser.setParam('giWallOffset', v));

        this.controllers.enableImpactLights = fVisual.add(p, 'enableImpactLights')
            .name('Lumières Impacts')
            .onChange(v => laser.setParam('enableImpactLights', v));

        this.controllers.giImpactIntensity = fVisual.add(p, 'giImpactIntensity', 0, 10, 0.1)
            .name('Intensité Lumière')
            .onChange(v => laser.setParam('giImpactIntensity', v));

        this.controllers.giImpactDistance = fVisual.add(p, 'giImpactDistance', 2, 40, 0.5)
            .name('Portée Lumière')
            .onChange(v => laser.setParam('giImpactDistance', v));

        // ══════════════════════════════════════════════════════════════════
        // 3. Actions & Gizmo (Positionnement 3D & gestion)
        // ══════════════════════════════════════════════════════════════════
        const fActions = this.gui.addFolder('🕹️ Gizmo & Actions');
        fActions.open();

        const currentMode = (this.ambiancePanel && this.ambiancePanel.transformControls)
            ? this.ambiancePanel.transformControls.getMode()
            : 'translate';

        const actionsState = {
            gizmoMode: currentMode,
            duplicate: () => {
                const pos = laser.getPosition().clone();
                pos.x += 1.5;
                const res = this.laserManager.addLaser(pos, { ...laser.params });
                if (this.ambiancePanel) {
                    this.ambiancePanel.selectLaser(res.laserShow);
                } else {
                    this.openForLaser(res.id, res.laserShow);
                }
            },
            deleteLaser: () => {
                const id = this._currentLaserId;
                if (this.ambiancePanel) {
                    this.ambiancePanel.deselectLaser();
                } else {
                    this.close();
                }
                this.laserManager.removeLaser(id);
            }
        };

        this.controllers.gizmoMode = fActions.add(actionsState, 'gizmoMode', ['translate', 'rotate'])
            .name('Mode Gizmo')
            .onChange(m => {
                if (this.ambiancePanel) {
                    this.ambiancePanel.setGizmoMode(m);
                }
            });

        fActions.add(actionsState, 'duplicate').name('📋 Dupliquer le laser');
        fActions.add(actionsState, 'deleteLaser').name('🗑️ Supprimer ce laser');
    }
}
