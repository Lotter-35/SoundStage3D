/**
 * GUI.js
 * ─────────────────────────────────────────────────────────────
 * Construction et gestion du panneau de contrôle dat.GUI :
 * - Lit les définitions (min, max, step, label) depuis PARAMS_SCHEMA
 * - Organise les contrôles selon les 5 dossiers thématiques configurés
 * - Gestion automatique de l'ouverture (Dossiers 1 & 2 ouverts, 3 à 5 repliés)
 * - Met à jour les états actifs/estompés/désactivés (setDimmed, setDisabled)
 * - Déclenche les rappels sur les modules (LaserShow, Room, PostProcessing, GI)
 * ─────────────────────────────────────────────────────────────
 */

import { PARAMS_SCHEMA, params } from '../config/params.js';

export class LaserGUI {
    /**
     * @param {object} app Contexte d'application { laserShow, room, postProcessing, sceneSetup, globalIllumination }
     */
    constructor(app) {
        this.app = app;
        this.gui = new dat.GUI({ width: 280 });

        this.gui.domElement.style.position = 'fixed';
        this.gui.domElement.style.top = '14px';
        this.gui.domElement.style.right = '14px';

        this.controllers = {};
        this._build();
    }

    _build() {
        const { laserShow, room, postProcessing, sceneSetup, globalIllumination } = this.app;

        // ── Dossier : Style laser (Toujours ouvert en haut) ───────────────────
        const fLaserStyle = this.gui.addFolder('Style laser');

        this.controllers.count = fLaserStyle.add(
            params, 'count',
            PARAMS_SCHEMA.count.min, PARAMS_SCHEMA.count.max, PARAMS_SCHEMA.count.step
        ).name(PARAMS_SCHEMA.count.label).onChange(() => {
            this.updateControlStates();
        });

        fLaserStyle.add(
            params, 'beamWidth',
            PARAMS_SCHEMA.beamWidth.min, PARAMS_SCHEMA.beamWidth.max, PARAMS_SCHEMA.beamWidth.step
        ).name(PARAMS_SCHEMA.beamWidth.label);

        this.controllers.spread = fLaserStyle.add(
            params, 'spread',
            PARAMS_SCHEMA.spread.min, PARAMS_SCHEMA.spread.max, PARAMS_SCHEMA.spread.step
        ).name(PARAMS_SCHEMA.spread.label).onChange(() => {
            this.updateControlStates();
        });

        fLaserStyle.addColor(params, 'color').name(PARAMS_SCHEMA.color.label).onChange(v => {
            laserShow.setColor(v);
            globalIllumination.setColor(v);
        });

        this.controllers.laserPan = fLaserStyle.add(
            params, 'laserPan'
        ).name(PARAMS_SCHEMA.laserPan.label);

        fLaserStyle.add(
            params, 'masterPower',
            PARAMS_SCHEMA.masterPower.min, PARAMS_SCHEMA.masterPower.max, PARAMS_SCHEMA.masterPower.step
        ).name(PARAMS_SCHEMA.masterPower.label);

        fLaserStyle.add(
            params, 'beamPower',
            PARAMS_SCHEMA.beamPower.min, PARAMS_SCHEMA.beamPower.max, PARAMS_SCHEMA.beamPower.step
        ).name(PARAMS_SCHEMA.beamPower.label);

        fLaserStyle.add(
            params, 'panPower',
            PARAMS_SCHEMA.panPower.min, PARAMS_SCHEMA.panPower.max, PARAMS_SCHEMA.panPower.step
        ).name(PARAMS_SCHEMA.panPower.label);

        // ── Clignotement / Stroboscope ─────────────────────────────────────────
        this.controllers.strobe = fLaserStyle.add(
            params, 'strobe'
        ).name(PARAMS_SCHEMA.strobe.label).onChange(() => {
            this.updateStrobeControlStates();
            if (this.onStrobeChange) this.onStrobeChange();
        });

        this.controllers.strobeSpeed = fLaserStyle.add(
            params, 'strobeSpeed',
            PARAMS_SCHEMA.strobeSpeed.min, PARAMS_SCHEMA.strobeSpeed.max, PARAMS_SCHEMA.strobeSpeed.step
        ).name(PARAMS_SCHEMA.strobeSpeed.label).onChange(() => {
            if (this.onStrobeChange) this.onStrobeChange();
        });

        // ── Courbe de tracé ────────────────────────────────────────────────────
        this.controllers.patternShape = fLaserStyle.add(
            params, 'patternShape',
            PARAMS_SCHEMA.patternShape.options
        ).name(PARAMS_SCHEMA.patternShape.label).onChange(() => {
            this.updateCurveControlStates();
        });

        this.controllers.curveAmplitude = fLaserStyle.add(
            params, 'curveAmplitude',
            PARAMS_SCHEMA.curveAmplitude.min, PARAMS_SCHEMA.curveAmplitude.max, PARAMS_SCHEMA.curveAmplitude.step
        ).name(PARAMS_SCHEMA.curveAmplitude.label);

        this.controllers.curveFrequency = fLaserStyle.add(
            params, 'curveFrequency',
            PARAMS_SCHEMA.curveFrequency.min, PARAMS_SCHEMA.curveFrequency.max, PARAMS_SCHEMA.curveFrequency.step
        ).name(PARAMS_SCHEMA.curveFrequency.label);

        fLaserStyle.open();

        // ── Dossier : Rigging (Toujours ouvert en haut) ─────────────────────────
        const fRigging = this.gui.addFolder('Rigging');

        this.controllers.numPods = fRigging.add(
            params, 'numPods',
            PARAMS_SCHEMA.numPods.min, PARAMS_SCHEMA.numPods.max, PARAMS_SCHEMA.numPods.step
        ).name(PARAMS_SCHEMA.numPods.label).onChange(() => {
            laserShow.updatePodPositions();
            this.updateControlStates();
        });

        fRigging.add(
            params, 'angle',
            PARAMS_SCHEMA.angle.min, PARAMS_SCHEMA.angle.max, PARAMS_SCHEMA.angle.step
        ).name(PARAMS_SCHEMA.angle.label);

        this.controllers.podSpacing2 = fRigging.add(
            params, 'podSpacing2',
            PARAMS_SCHEMA.podSpacing2.min, PARAMS_SCHEMA.podSpacing2.max, PARAMS_SCHEMA.podSpacing2.step
        ).name(PARAMS_SCHEMA.podSpacing2.label).onChange(() => {
            laserShow.updatePodPositions();
        });

        fRigging.add(
            params, 'podHeightAboveUser',
            PARAMS_SCHEMA.podHeightAboveUser.min, PARAMS_SCHEMA.podHeightAboveUser.max, PARAMS_SCHEMA.podHeightAboveUser.step
        ).name(PARAMS_SCHEMA.podHeightAboveUser.label).onChange(() => {
            laserShow.updatePodPositions();
        });

        fRigging.add(
            params, 'sourceDistanceOffset',
            PARAMS_SCHEMA.sourceDistanceOffset.min, PARAMS_SCHEMA.sourceDistanceOffset.max, PARAMS_SCHEMA.sourceDistanceOffset.step
        ).name(PARAMS_SCHEMA.sourceDistanceOffset.label);

        fRigging.open();

        // ── Dossier : Tweeking visuel source (Replié par défaut) ────────────────
        const fSourceVisual = this.gui.addFolder('Tweeking visuel source');

        fSourceVisual.add(
            params, 'sourceEmissionPower',
            PARAMS_SCHEMA.sourceEmissionPower.min, PARAMS_SCHEMA.sourceEmissionPower.max, PARAMS_SCHEMA.sourceEmissionPower.step
        ).name(PARAMS_SCHEMA.sourceEmissionPower.label);

        fSourceVisual.add(
            params, 'sourceGlowRadius',
            PARAMS_SCHEMA.sourceGlowRadius.min, PARAMS_SCHEMA.sourceGlowRadius.max, PARAMS_SCHEMA.sourceGlowRadius.step
        ).name(PARAMS_SCHEMA.sourceGlowRadius.label);

        fSourceVisual.add(
            params, 'giIntensity',
            PARAMS_SCHEMA.giIntensity.min, PARAMS_SCHEMA.giIntensity.max, PARAMS_SCHEMA.giIntensity.step
        ).name(PARAMS_SCHEMA.giIntensity.label);

        fSourceVisual.add(
            params, 'giDistance',
            PARAMS_SCHEMA.giDistance.min, PARAMS_SCHEMA.giDistance.max, PARAMS_SCHEMA.giDistance.step
        ).name(PARAMS_SCHEMA.giDistance.label);

        fSourceVisual.add(
            params, 'giWallOffset',
            PARAMS_SCHEMA.giWallOffset.min, PARAMS_SCHEMA.giWallOffset.max, PARAMS_SCHEMA.giWallOffset.step
        ).name(PARAMS_SCHEMA.giWallOffset.label);

        this.controllers.enableImpactLights = fSourceVisual.add(
            params, 'enableImpactLights'
        ).name(PARAMS_SCHEMA.enableImpactLights.label).onChange(v => {
            if (!v) {
                globalIllumination.turnOffAll();
            }
            this.updateImpactLightControlStates();
        });

        this.controllers.giImpactIntensity = fSourceVisual.add(
            params, 'giImpactIntensity',
            PARAMS_SCHEMA.giImpactIntensity.min, PARAMS_SCHEMA.giImpactIntensity.max, PARAMS_SCHEMA.giImpactIntensity.step
        ).name(PARAMS_SCHEMA.giImpactIntensity.label);

        this.controllers.giImpactDistance = fSourceVisual.add(
            params, 'giImpactDistance',
            PARAMS_SCHEMA.giImpactDistance.min, PARAMS_SCHEMA.giImpactDistance.max, PARAMS_SCHEMA.giImpactDistance.step
        ).name(PARAMS_SCHEMA.giImpactDistance.label);

        fSourceVisual.close();

        // ── Dossier : Post-Traitement & Ambiance (Replié par défaut) ────────────
        const fPost = this.gui.addFolder('Post-Traitement & Ambiance');

        fPost.add(
            params, 'fogDensity',
            PARAMS_SCHEMA.fogDensity.min, PARAMS_SCHEMA.fogDensity.max, PARAMS_SCHEMA.fogDensity.step
        ).name(PARAMS_SCHEMA.fogDensity.label).onChange(v => {
            sceneSetup.fog.density = v;
        });

        fPost.add(
            params, 'floorRoughness',
            PARAMS_SCHEMA.floorRoughness.min, PARAMS_SCHEMA.floorRoughness.max, PARAMS_SCHEMA.floorRoughness.step
        ).name(PARAMS_SCHEMA.floorRoughness.label).onChange(v => {
            room.setFloorRoughness(v);
        });

        fPost.add(
            params, 'bloomIntensity',
            PARAMS_SCHEMA.bloomIntensity.min, PARAMS_SCHEMA.bloomIntensity.max, PARAMS_SCHEMA.bloomIntensity.step
        ).name(PARAMS_SCHEMA.bloomIntensity.label).onChange(v => {
            postProcessing.bloomPass.strength = v;
        });

        fPost.add(
            params, 'bloomRadius',
            PARAMS_SCHEMA.bloomRadius.min, PARAMS_SCHEMA.bloomRadius.max, PARAMS_SCHEMA.bloomRadius.step
        ).name(PARAMS_SCHEMA.bloomRadius.label).onChange(v => {
            postProcessing.bloomPass.radius = v;
        });

        fPost.add(
            params, 'chroma',
            PARAMS_SCHEMA.chroma.min, PARAMS_SCHEMA.chroma.max, PARAMS_SCHEMA.chroma.step
        ).name(PARAMS_SCHEMA.chroma.label).onChange(v => {
            postProcessing.chromaPass.uniforms.uChroma.value = v;
        });

        fPost.add(
            params, 'antialiasing',
            PARAMS_SCHEMA.antialiasing.options
        ).name(PARAMS_SCHEMA.antialiasing.label).onChange(mode => {
            postProcessing.updateAntialiasing(mode);
        });

        fPost.add(
            params, 'enableDazzle'
        ).name(PARAMS_SCHEMA.enableDazzle.label);

        fPost.close();

        // ── Dossier : Contrôle du Glow & Fumée (Replié par défaut) ─────────────
        const fGlow = this.gui.addFolder('Contrôle du Glow & Fumée');

        fGlow.add(
            params, 'glowIntensity',
            PARAMS_SCHEMA.glowIntensity.min, PARAMS_SCHEMA.glowIntensity.max, PARAMS_SCHEMA.glowIntensity.step
        ).name(PARAMS_SCHEMA.glowIntensity.label);

        fGlow.add(
            params, 'glowScattering',
            PARAMS_SCHEMA.glowScattering.min, PARAMS_SCHEMA.glowScattering.max, PARAMS_SCHEMA.glowScattering.step
        ).name(PARAMS_SCHEMA.glowScattering.label);

        fGlow.add(
            params, 'glowFalloff',
            PARAMS_SCHEMA.glowFalloff.min, PARAMS_SCHEMA.glowFalloff.max, PARAMS_SCHEMA.glowFalloff.step
        ).name(PARAMS_SCHEMA.glowFalloff.label);

        fGlow.add(
            params, 'fogGlowCoupling',
            PARAMS_SCHEMA.fogGlowCoupling.min, PARAMS_SCHEMA.fogGlowCoupling.max, PARAMS_SCHEMA.fogGlowCoupling.step
        ).name(PARAMS_SCHEMA.fogGlowCoupling.label);

        fGlow.add(
            params, 'impactGlowIntensity',
            PARAMS_SCHEMA.impactGlowIntensity.min, PARAMS_SCHEMA.impactGlowIntensity.max, PARAMS_SCHEMA.impactGlowIntensity.step
        ).name(PARAMS_SCHEMA.impactGlowIntensity.label);

        fGlow.add(
            params, 'impactGlowRadius',
            PARAMS_SCHEMA.impactGlowRadius.min, PARAMS_SCHEMA.impactGlowRadius.max, PARAMS_SCHEMA.impactGlowRadius.step
        ).name(PARAMS_SCHEMA.impactGlowRadius.label);

        fGlow.close();

        this.updateControlStates();
    }

    setDimmed(ctrl, enabled) {
        if (!ctrl) return;
        const li = ctrl.domElement.closest('li');
        if (li) li.style.opacity = enabled ? '1' : '0.4';
    }

    setDisabled(ctrl, enabled) {
        if (!ctrl) return;
        const li = ctrl.domElement.closest('li');
        if (li) {
            li.style.opacity = enabled ? '1' : '0.4';
            li.style.pointerEvents = enabled ? '' : 'none';
        }
    }

    updateImpactLightControlStates() {
        this.setDimmed(this.controllers.giImpactIntensity, params.enableImpactLights);
        this.setDimmed(this.controllers.giImpactDistance, params.enableImpactLights);
    }

    updateCurveControlStates() {
        const hasCurve = params.patternShape !== 'Horizontal';
        this.setDimmed(this.controllers.curveAmplitude, hasCurve);
        const hasFreq = hasCurve && ['Sinusoïde', 'Zigzag', 'Vague Double'].includes(params.patternShape);
        this.setDimmed(this.controllers.curveFrequency, hasFreq);
    }

    updateStrobeControlStates() {
        // Le curseur de vitesse reste toujours actif et accessible
        this.setDimmed(this.controllers.strobeSpeed, true);
    }

    updateStrobeDisplay() {
        if (this.controllers.strobe) {
            this.controllers.strobe.updateDisplay();
        }
        if (this.controllers.strobeSpeed) {
            this.controllers.strobeSpeed.updateDisplay();
        }
        this.updateStrobeControlStates();
    }

    updateControlStates() {
        this.setDimmed(this.controllers.spread, params.count > 1);
        this.setDisabled(this.controllers.count, params.spread > 0);
        const eligible = params.count > 1 && params.spread > 0;
        this.setDisabled(this.controllers.laserPan, eligible);
        this.setDimmed(this.controllers.podSpacing2, params.numPods === 2);
        this.updateImpactLightControlStates();
        this.updateCurveControlStates();
        this.updateStrobeControlStates();
    }
}
