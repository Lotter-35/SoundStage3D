/**
 * SpotLightingFX.js
 * ─────────────────────────────────────────────────────────────
 * Effets d'éclairage « comme en vrai concert » des lyres (phase C du rendu des lyres v2), branchés par
 * SpotManager :
 *   - LUMIÈRE INDIRECTE (GI, plan R5) : grille 3D de la salle éclairée par la lumière des lyres renvoyée par
 *     le décor (gi/GIGridPass.js) ; lue par la passe des taches de lumière (rebond sur le décor) et par le
 *     brouillard de salle (brume éclairée par la GI) ;
 *   - REFLETS DES FAISCEAUX (plan R6) sur le dessus brillant du plateau (reflect/BeamReflectPass.js).
 *
 * Réglages globaux synchronisés (spotParams.js) : « Lumière indirecte (GI) » + intensité, « Brume éclairée
 * par la GI », « Reflets des faisceaux » + intensité. Options locales (⚙️ Options › Lyres) : « Qualité GI »
 * (Désactivée / Basse / Haute), « Résolution des reflets » (¼ / ⅛).
 * ─────────────────────────────────────────────────────────────
 */

import { GIGridPass } from './gi/GIGridPass.js';
import { BeamReflectPass } from './reflect/BeamReflectPass.js';

/** Intensité 1 = rendu de concert lisible : ≈ 12 × la valeur physique (plateau et mur en lino noir,
 *  albédo ≈ 0,07 : le vrai rebond y est presque invisible ; réglage 0,08 ≈ physique) */
const GI_ARTISTIC = 12;
/** Rebond sur le décor : éclairement de la grille → éclairement d'une surface (cosinus moyen ≈ ½) */
const GI_DECOR_GAIN = 0.5 * GI_ARTISTIC;
/** Brume : éclairement de la grille → lumière diffusée par la fumée (phase isotrope 1 / 4π, × 6 : la fumée
 *  de la salle est plus dense que celle des faisceaux) ; gain artistique plus faible que sur le décor (au-delà,
 *  voile gris sur toute la salle avec beaucoup de faisceaux) */
const GI_HAZE_GAIN = 6 / (4 * Math.PI) * 4;

export class SpotLightingFX {
    /**
     * @param {object} o
     * @param {import('./ssdepth/SSDepthLights.js').SSDepthLights} o.lights
     * @param {import('./SpotBatch.js').SpotBatch} o.batch
     * @param {THREE.PerspectiveCamera} o.camera
     * @param {object} o.shadowUniforms
     * @param {object|null} o.laserManager chaîne de post-traitement (addScenePass), null sans passes
     */
    constructor({ lights, batch, camera, shadowUniforms, laserManager }) {
        this.lights = lights;
        this.batch = batch;
        this.camera = camera;
        this.shadowUniforms = shadowUniforms;
        this.laserManager = laserManager;
        // GI : passe insérée AVANT les taches de lumière (qui lisent la grille)
        this.gi = new GIGridPass(lights, batch, shadowUniforms);
        this._hasGI = Boolean(laserManager && laserManager.addScenePass(this.gi));
        this.gi.setQuality('low');
        this.reflect = null;
        this._hasReflect = false;
        this.giOn = true;
        this.giIntensity = 1;
        this.giHaze = true;
        this.reflectOn = true;
        this.reflectIntensity = 1;
        /** Gain de la GI dans le brouillard de salle (0 = rien) ; lu par HazePass */
        this.hazeGain = 0;
        this._poolGain = 60;
    }

    /** Reflets : passe insérée après les faisceaux SS Depth (appelé par SpotManager après leur ajout) */
    addReflectPass() {
        this.reflect = new BeamReflectPass(this.lights, this.batch, this.camera, this.shadowUniforms);
        this._hasReflect = Boolean(this.laserManager && this.laserManager.addScenePass(this.reflect));
        if (this._hasReflect) this.reflect.sceneDepth = this.laserManager.sceneDepth;
    }

    /** Uniformes partagés de lecture de la grille (matériau des taches de lumière) */
    get giUniforms() {
        return this.gi.uniforms;
    }

    /** Réglages globaux synchronisés */
    applyGlobals(g, { haze, phaseG, poolGain }) {
        const wasOn = this.giOn;
        this.giOn = Boolean(g.gi);
        this.giIntensity = g.giIntensity;
        this.giHaze = Boolean(g.giHaze);
        this.reflectOn = Boolean(g.beamReflections);
        this.reflectIntensity = g.beamReflectionIntensity;
        this._poolGain = poolGain;
        this.gi.gain = poolGain;
        this.gi.hazeK = haze * 0.035;
        if (this.giOn && !wasOn) this.gi.reset();
        if (this.reflect) {
            this.reflect.gain = g.beamReflectionIntensity;
            this.reflect.haze = haze;
            this.reflect.phaseG = phaseG;
        }
    }

    /** GI voulue (réglage global + qualité locale) : les cônes des taches doivent être décrits */
    giWanted() {
        return this._hasGI && this.giOn && this.giIntensity > 0 && Boolean(this.gi.quality);
    }

    /** @param {'Désactivée'|'Basse'|'Haute'|string} q option locale « Qualité GI » */
    setGIQuality(q) {
        this.gi.setQuality(q === 'Haute' ? 'high' : q === 'Basse' ? 'low' : 'off');
    }

    /** @param {number} div option locale « Résolution des reflets » (4 = ¼, 8 = ⅛) */
    setReflectDivisor(div) {
        if (this.reflect) this.reflect.setDivisor(div);
    }

    setGrassTexture(tex) {
        this.gi.setGrassTexture(tex);
    }

    /**
     * Après SSDepthLights.collect : passes actives, gains lus par les taches de lumière et le brouillard
     * @param {import('./lighting/LightPoolPass.js').LightPoolPass} poolPass
     */
    update(poolPass) {
        const gi = this.giWanted();
        this.gi.enabled = gi;
        if (!gi) this.gi.reset();
        const giLive = gi && this.gi.active;
        poolPass.giGain = giLive ? GI_DECOR_GAIN * this.giIntensity : 0;
        this.hazeGain = giLive && this.giHaze ? GI_HAZE_GAIN * this.giIntensity : 0;
        if (this.reflect) {
            this.reflect.enabled = this._hasReflect && this.reflectOn && this.reflectIntensity > 0
                && this.lights.beamCones > 0;
        }
    }

    dispose() {
        this.gi.dispose();
        if (this.reflect) this.reflect.dispose();
    }
}
