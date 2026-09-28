/**
 * LaserShow.js (adapté pour SoundStage3D)
 * ─────────────────────────────────────────────────────────────
 * Représente UN projecteur laser positionnable dans la scène.
 * Chaque instance est un laser indépendant avec ses propres params,
 * son modèle 3D et son animation.
 *
 * Adapté depuis le projet LaserSimulation (GitHub: Lotter-35/LaserSimulation)
 * Changements majeurs :
 * - Un seul pod par instance (laser = 1 boîtier physique)
 * - Room.js remplacé par LaserSceneIntersector.js (festival en plein air)
 * - Params individuels par instance (createLaserParams())
 * - Rendu BATCHÉ : la géométrie de ce laser est écrite dans un LaserOutput
 *   que le LaserBatch partagé concatène avec celle de tous les autres lasers
 *   (5 draw calls au total), ses paramètres vont dans 1 ligne de la texture
 *   de paramètres (chaque laser reste configurable indépendamment).
 * ─────────────────────────────────────────────────────────────
 * OPTIMISÉ :
 * - 0 allocation GC par frame en régime établi
 * - Cache géométrique : si rien ne bouge (pas de balayage, params identiques,
 *   aucun joueur dans l'éventail), les rayons ne sont PAS recalculés
 * - Pré-filtrage des obstacles touchables par l'éventail (motif plan)
 * - Subdivision de la nappe au pas angulaire cible (pas de minimum par intervalle)
 */

import * as THREE from 'three';
import {
    ARC_SUBDIVISIONS,
    BEAM_DIVERGENCE,
    beamSpread,
    LASER_MAX_RANGE,
    clamp
} from './config/laserConstants.js?v=2';
import { createLaserParams } from './config/laserParams.js?v=27';
import { PARAM_TEXELS, boostLaserSaturation } from './LaserShaders.js';
import { LaserOutput } from './LaserBatch.js';
import { LaserPod } from './LaserPod.js?v=3';
import { PatternHorizontalSweep } from './patterns/PatternHorizontalSweep.js?v=25';
import {
    getSceneHit,
    isPlayerInWedge,
    hasActivePlayers,
    collectFanObstacles,
    setActiveObstacles,
    STAGE_OBSTACLE_COUNT
} from './LaserSceneIntersector.js?v=9';

// Nombre de valeurs de la signature géométrique (voir _geometrySignature)
const SIG_SIZE = 25;
const SIG_UNDEFINED = -987654.321;

function on(v) {
    return v ? 1.0 : 0.0;
}

function sigNum(v) {
    if (typeof v === 'number') return v === v ? v : SIG_UNDEFINED; // NaN → sentinelle
    if (v === undefined || v === null) return SIG_UNDEFINED;
    return v ? 1 : 0;
}

export class LaserShow {
    /**
     * @param {THREE.Scene} scene
     * @param {THREE.Vector3} position Position initiale du laser
     * @param {object} [paramOverrides] Surcharges de params optionnelles
     * @param {import('./LaserBatch.js').LaserBatch} batch Rendu batché partagé
     */
    constructor(scene, position = new THREE.Vector3(0, 5, 0), paramOverrides = {}, batch = null) {
        this.scene = scene;
        this.batch = batch;

        // Params individuels — chaque laser a les siens
        this.params = createLaserParams(paramOverrides);

        // Groupe racine pour le raycasting et le gizmo
        this.group = new THREE.Group();
        this.group.name = 'laser-show-group';
        this.group.position.copy(position);
        this.scene.add(this.group);

        // Ligne de paramètres GPU + tampon de géométrie de ce laser
        this.row = batch.allocRow();
        this.output = new LaserOutput();
        this.visible = true;
        this.renderable = false;

        // Motif géométrique actif
        this.pattern = new PatternHorizontalSweep();

        // Pod unique (1 laser = 1 boîtier physique)
        this.pod = new LaserPod(scene, 0);
        this.pod.setBasePosition(position.x, position.y, position.z);
        this.pod.setVisible(true);

        // Pause animation & temps local synchronisé
        this.isPaused = Boolean(this.params.pauseMotion);
        this._animTime = 0;
        this._smokeTime = 0;
        this._pausedOffset = 0;
        this._frozenAnimTime = null;
        this._lastSharedTime = 0;

        // Points d'impact des faisceaux (pool extensible, 0 GC en régime établi)
        this._beamHits    = [];
        this._beamNormals = [];
        this._beamReal    = new Uint8Array(64);

        // Liste des impacts des faisceaux (lue par le DazzleEffect)
        this._podHitPts  = [];

        // Échantillons de la nappe (roulement sur 2 emplacements) + bornes de dichotomie
        this._subHit  = [new THREE.Vector3(), new THREE.Vector3()];
        this._subNorm = [new THREE.Vector3(), new THREE.Vector3()];
        this._loHit  = new THREE.Vector3();
        this._loNorm = new THREE.Vector3();
        this._hiHit  = new THREE.Vector3();
        this._gapLo = new THREE.Vector3();
        this._gapHi = new THREE.Vector3();
        this._hiNorm = new THREE.Vector3();

        // Couleurs pré-allouées
        this._baseColor  = new THREE.Color(this.params.color);
        this._giColor    = new THREE.Color();
        this._whiteColor = new THREE.Color(1, 1, 1);
        this._lastColorKey = null;
        this._sat135 = new Float32Array(3);
        this._sat145 = new Float32Array(3);

        // Vecteur de direction pour les sub-rayons PAN
        this._subDir = new THREE.Vector3();
        // Vecteur normal du plan laser (perpendiculaire à l'éventail de nappe)
        this._panNormal = new THREE.Vector3(0, 1, 0);
        this._fanNormal = new THREE.Vector3();
        this._fanForward = new THREE.Vector3();

        // Pré-filtrage des obstacles
        this._obstacleList = new Int32Array(STAGE_OBSTACLE_COUNT);

        // Cache géométrique
        this._sig = new Float64Array(SIG_SIZE);
        this._sigShape = null;
        this._geomValid = false;
        this._playerWasInWedge = false;
        this._nBeams = 0;
        this._animTimes = { pitch: 0, yaw: 0, roll: 0 };

        // Drapeaux de rendu de la frame courante (lus par le LaserBatch)
        this._drawBeams = false;
        this._drawImpacts = false;
        this._drawFan = false;

        // Initialisation spatiale immédiate du boîtier 3D avec l'orientation des paramètres
        this.pod.updateSource(
            this.params.sourceDistanceOffset || 0,
            this.params.giWallOffset || 0,
            this._giColor,
            0,
            this.params.giDistance || 60,
            1.0,
            this.params.angle || 0,
            this.params.tilt || 0,
            this.params.roll || 0
        );
    }

    /** Retourne le THREE.Group racine (pour raycasting, gizmo, etc.) */
    getGroup() {
        return this.group;
    }

    /** Retourne le THREE.Group du boîtier 3D (pour la sélection au clic) */
    getHousingGroup() {
        return this.pod.housing ? this.pod.housing.group : this.group;
    }

    /** Déplace le laser dans la scène */
    setPosition(x, y, z) {
        this.group.position.set(x, y, z);
        this.pod.setBasePosition(x, y, z);
    }

    getPosition() {
        return this.group.position;
    }

    /**
     * Définit l'orientation du laser (angle, tilt, roll en degrés)
     * @param {number} angle
     * @param {number} tilt
     * @param {number} roll
     */
    setRotation(angle, tilt, roll) {
        if (angle !== undefined) this.setParam('angle', angle);
        if (tilt !== undefined) this.setParam('tilt', tilt);
        if (roll !== undefined) this.setParam('roll', roll);
        const housing = this.getHousingGroup();
        if (housing) {
            housing.rotation.set(
                -(this.params.tilt || 0) * (Math.PI / 180),
                (this.params.angle || 0) * (Math.PI / 180),
                (this.params.roll || 0) * (Math.PI / 180)
            );
            housing.updateMatrixWorld(true);
        }
    }

    /** Modifie un paramètre en live */
    setParam(key, value) {
        this.params[key] = value;
        this._onParamChanged(key, value);
    }

    _onParamChanged(key, value) {
        if (key === 'pauseMotion') {
            this.isPaused = Boolean(value);
        }
        // Couleur, géométrie et puissances sont relues à chaque frame (cache par signature)
    }

    /** Définit directement le temps d'animation accumulé (pour synchronisation réseau) */
    setAnimTime(t) {
        if (typeof t === 'number' && !isNaN(t)) {
            this._animTime = t;
        }
    }

    /** Définit l'offset de pause accumulé (synchronisation réseau sans téléportation) */
    setPausedOffset(offset) {
        if (typeof offset === 'number' && !isNaN(offset)) {
            this._pausedOffset = offset;
        }
    }

    /** Recalcule la saturation chromatique uniquement si la couleur a changé */
    _refreshColor() {
        const key = this.params.color;
        if (key === this._lastColorKey) return;
        this._lastColorKey = key;
        this._baseColor.set(key);
        boostLaserSaturation(this._baseColor, 1.35, this._sat135);
        boostLaserSaturation(this._baseColor, 1.45, this._sat145);
    }

    /**
     * Écrit la ligne de paramètres GPU de ce laser (lue par les shaders batchés).
     */
    _writeParamRow(effectiveBeamPower, effectivePanPower, nBeamsPerPod) {
        const p = this.params;
        const d = this.batch.paramsTexture.image.data;
        let o = this.row * PARAM_TEXELS * 4;

        const beamPanAttenuation = (p.laserPan && p.spread > 0 && nBeamsPerPod > 1) ? 0.70 : 1.0;
        const whiteMult = p.sourceWhitePower !== undefined ? p.sourceWhitePower : 1.0;
        const computedSourceGlow = (effectiveBeamPower * 0.35 + effectivePanPower * 0.75) * 1.10 * whiteMult;
        const origin = this.pod.origin;
        const n = this._panNormal;

        // T0
        d[o++] = this._sat135[0]; d[o++] = this._sat135[1]; d[o++] = this._sat135[2];
        d[o++] = effectiveBeamPower * beamPanAttenuation;
        // T1
        d[o++] = this._sat145[0]; d[o++] = this._sat145[1]; d[o++] = this._sat145[2];
        d[o++] = p.beamWidth > 0.001 ? effectiveBeamPower : 0.0;
        // T2
        d[o++] = computedSourceGlow; d[o++] = p.glowIntensity; d[o++] = p.glowScattering; d[o++] = p.glowFalloff;
        // T3
        d[o++] = p.fogDensity; d[o++] = p.fogGlowCoupling; d[o++] = effectivePanPower; d[o++] = p.beamWidth;
        // T4
        d[o++] = origin.x; d[o++] = origin.y; d[o++] = origin.z;
        d[o++] = (p.panSmokeEnabled !== false) ? 1.0 : 0.0;
        // T5
        d[o++] = n.x; d[o++] = n.y; d[o++] = n.z;
        d[o++] = p.panSmokePerpSpeed !== undefined ? p.panSmokePerpSpeed : 0.15;
        // T6
        const smokeC = p.panSmokeContrast !== undefined ? p.panSmokeContrast : 0.50;
        const patchC = p.panSmokePatchContrast !== undefined ? p.panSmokePatchContrast : 0.35;
        d[o++] = p.panSmokeScale !== undefined ? p.panSmokeScale : 0.35;
        d[o++] = smokeC;
        d[o++] = p.panSmokeBrightness !== undefined ? p.panSmokeBrightness : 2.0;
        d[o++] = patchC;
        // T7
        d[o++] = p.panSmokePatchScale !== undefined ? p.panSmokePatchScale : 0.09;
        d[o++] = p.panSmokePatchDensity !== undefined ? p.panSmokePatchDensity : 0.50;
        d[o++] = p.panSmokePatchSpeed !== undefined ? p.panSmokePatchSpeed : 0.04;
        d[o++] = p.impactGlowIntensity;
        // T8 (+ borne max de modulation de la fumée, pour le rejet précoce exact des pixels invisibles)
        const smokeI = p.panSmokeIntensity !== undefined ? p.panSmokeIntensity : 0.30;
        let maxMod = (1.0 + smokeC * 0.85) * (1.0 + Math.max(0, patchC) * 1.25);
        if (p.smkGiantEnabled) maxMod *= 1.0 + Math.max(0, p.smkGiantContrast) * 1.25;
        if (p.smkRayEnabled)   maxMod *= 1.0 + p.smkRayIntensity * 1.2;
        maxMod = 1.0 + (maxMod - 1.0) * Math.max(1.0, smokeI);
        d[o++] = p.impactGlowRadius; d[o++] = p.sourceEmissionPower; d[o++] = p.sourceGlowRadius; d[o++] = maxMod;

        // T9..T12 : couches de fumée supplémentaires
        d[o++] = on(p.smkTurbEnabled);     d[o++] = p.smkTurbStrength;     d[o++] = p.smkTurbScale;        d[o++] = p.smkTurbSpeed;
        d[o++] = on(p.smkRayEnabled);      d[o++] = p.smkRayIntensity;     d[o++] = p.smkRayScale;         d[o++] = p.smkRaySpeed;
        d[o++] = on(p.smkGiantEnabled);    d[o++] = p.smkGiantContrast;    d[o++] = p.smkGiantScale;       d[o++] = p.smkGiantDensity;
        d[o++] = p.smkGiantSpeed;          d[o++] = smokeI;                d[o++] = 0;                     d[o] = 0;

        // Drapeaux de rendu (les shaders d'origine rejetaient ces cas pixel par pixel)
        this._drawBeams   = effectiveBeamPower * beamPanAttenuation > 0.001 && p.beamWidth > 0.001;
        this._drawImpacts = p.beamWidth > 0.001 && effectiveBeamPower > 0.001;
        this._drawFan     = effectivePanPower > 0.001;
        this.output.glow  = computedSourceGlow >= 0.01;

        return computedSourceGlow;
    }

    /**
     * Remplit la signature des entrées qui déterminent la géométrie des rayons.
     * @returns {boolean} true si la signature a changé depuis le dernier calcul
     */
    _geometrySignature(animTimes, geomPanEnabled) {
        const p = this.params;
        const pos = this.group.position;
        let c = false;
        c = this._sigPut(0, pos.x) || c;
        c = this._sigPut(1, pos.y) || c;
        c = this._sigPut(2, pos.z) || c;
        c = this._sigPut(3, p.sourceDistanceOffset || 0) || c;
        c = this._sigPut(4, animTimes.pitch) || c;
        c = this._sigPut(5, animTimes.yaw) || c;
        c = this._sigPut(6, animTimes.roll) || c;
        c = this._sigPut(7, p.count) || c;
        c = this._sigPut(8, p.spread) || c;
        c = this._sigPut(9, p.angle) || c;
        c = this._sigPut(10, p.tilt) || c;
        c = this._sigPut(11, p.roll) || c;
        c = this._sigPut(12, p.curveAmplitude) || c;
        c = this._sigPut(13, p.curveFrequency) || c;
        c = this._sigPut(14, p.beamYawOffset) || c;
        c = this._sigPut(15, p.beamPitchOffset) || c;
        c = this._sigPut(16, p.beamRollOffset) || c;
        c = this._sigPut(17, p.pitchSweepAmp) || c;
        c = this._sigPut(18, p.yawSweepAmp) || c;
        c = this._sigPut(19, p.horizontalSweepAmp) || c;
        c = this._sigPut(20, p.rollSweepAmp) || c;
        c = this._sigPut(21, p.rollContinuous) || c;
        c = this._sigPut(22, p.beamWidth) || c;
        c = this._sigPut(23, geomPanEnabled) || c;
        c = this._sigPut(24, this.pod.phase) || c;
        if (p.patternShape !== this._sigShape) { this._sigShape = p.patternShape; c = true; }
        return c;
    }

    _sigPut(i, v) {
        const x = sigNum(v);
        if (this._sig[i] === x) return false;
        this._sig[i] = x;
        return true;
    }

    _ensureBeamPool(n) {
        while (this._beamHits.length < n) {
            this._beamHits.push(new THREE.Vector3());
            this._beamNormals.push(new THREE.Vector3());
        }
        if (this._beamReal.length < n) {
            const r = new Uint8Array(Math.max(n, this._beamReal.length * 2));
            r.set(this._beamReal);
            this._beamReal = r;
        }
    }

    /**
     * Boucle principale de mise à jour.
     * @param {number} delta Temps depuis dernière frame (secondes)
     * @param {number} animTime Temps global partagé (secondes)
     * @param {THREE.Vector3|null} cameraPos Position de la caméra
     * @param {object|null} globalSmokeState État partagé de fumée atmosphérique { wind, time }
     */
    update(delta, animTime, cameraPos = null, globalSmokeState = null) {
        const p = this.params;
        const nBeamsPerPod = p.spread > 0 ? Math.max(1, Math.round(p.count)) : 1;
        const isPaused = this.isPaused || Boolean(p.pauseMotion);

        const dt = (delta > 0 && delta < 0.5) ? delta : 0.016;

        // 1. Horloges de balayage par axe (n'avancent que si non en pause, vitesse angulaire physique constante)
        if (!isPaused) {
            const pitchSpeed = p.pitchSweepSpeed !== undefined ? p.pitchSweepSpeed : (p.sweepSpeed !== undefined ? p.sweepSpeed : 0.0);
            const yawSpeed   = p.yawSweepSpeed   !== undefined ? p.yawSweepSpeed   : 0.0;
            const rollSpeed  = p.rollSweepSpeed  !== undefined ? p.rollSweepSpeed  : 0.0;

            const pitchAmp = Math.max(1.0, p.pitchSweepAmp !== undefined ? p.pitchSweepAmp : 0.0);
            const yawAmp   = Math.max(1.0, p.yawSweepAmp !== undefined ? p.yawSweepAmp : 0.0);
            const rollAmp  = Math.max(1.0, p.rollSweepAmp !== undefined ? p.rollSweepAmp : 0.0);
            const isRollFull360 = (p.rollSweepAmp >= 359.5) || Boolean(p.rollContinuous);

            // Vitesse angulaire physique réelle : le temps de parcours d'aller-retour est proportionnel à l'amplitude
            const pitchOmega = pitchSpeed > 0 ? (pitchSpeed * 22.5) / pitchAmp : 0;
            const yawOmega   = yawSpeed > 0   ? (yawSpeed   * 22.5) / yawAmp   : 0;
            const rollOmega  = rollSpeed > 0  ? (isRollFull360 ? rollSpeed : ((rollSpeed * 135.0) / rollAmp)) : 0;

            if (pitchOmega > 0) this._pitchAnimTime = (this._pitchAnimTime || 0) + dt * pitchOmega;
            if (yawOmega > 0)   this._yawAnimTime   = (this._yawAnimTime   || 0) + dt * yawOmega;
            if (rollOmega > 0)  this._rollAnimTime  = (this._rollAnimTime  || 0) + dt * rollOmega;
        }

        const animTimes = this._animTimes;
        animTimes.pitch = this._pitchAnimTime || 0;
        animTimes.yaw   = this._yawAnimTime   || 0;
        animTimes.roll  = this._rollAnimTime  || 0;

        // La simulation de fumée et le stroboscope continuent TOUJOURS d'évoluer en temps réel
        this._smokeTime += dt;
        this._realTime = (this._realTime || 0) + dt;

        // Horloge temps réel continue pour le clignotement / stroboscope :
        const strobeTime = (typeof animTime === 'number' && !isNaN(animTime)) ? animTime : this._realTime;

        // Stroboscope
        let strobeFactor = 1.0;
        if (p.strobe) {
            const t = strobeTime * p.strobeSpeed;
            strobeFactor = (t - Math.floor(t)) < 0.5 ? 1.0 : 0.0;
        }

        const effectiveBeamPower = p.beamPower * p.masterPower * strobeFactor;
        const effectivePanPower  = p.panPower  * p.masterPower * strobeFactor;

        // Exposés pour le DazzleEffect (lus par LaserManager chaque frame)
        this._effectiveBeamPower = effectiveBeamPower;
        this._effectivePanPower  = effectivePanPower;

        this._refreshColor();

        // Couleur GI (riche en couleur pure sans délavage blanc)
        const whiteMult = p.sourceWhitePower !== undefined ? p.sourceWhitePower : 1.0;
        const baseSourceGlow = (effectiveBeamPower * 0.35 + effectivePanPower * 0.75) * 1.10;
        const computedSourceGlow = baseSourceGlow * whiteMult;
        const totalLightPower = baseSourceGlow * p.sourceEmissionPower * p.giIntensity;
        const whiteTransition = clamp(computedSourceGlow * 0.35, 0.0, 1.0);
        if (p.giBounceColor) {
            this._giColor.copy(this._baseColor).lerp(this._whiteColor, whiteTransition * 0.15);
        } else {
            this._giColor.set(1, 1, 1);
        }

        // Position du pod = position du groupe (le laser a été déplacé)
        const podPos = this.group.position;
        this.pod.setBasePosition(podPos.x, podPos.y, podPos.z);

        // Le boîtier physique reste 100% statique face aux balayages et déviations internes
        this.pod.updateSource(
            p.sourceDistanceOffset || 0,
            p.giWallOffset || 0,
            this._giColor,
            totalLightPower,
            p.giDistance,
            strobeFactor,
            p.angle || 0,
            p.tilt || 0,
            p.roll || 0
        );

        // ── Géométrie des rayons (avec cache) ─────────────────────────────
        const geomPanEnabled = Boolean(p.laserPan) && nBeamsPerPod > 1 && p.spread > 0 && (p.panPower * p.masterPower) > 0.001;
        const anyPower = effectiveBeamPower > 0.001 || effectivePanPower > 0.001;

        if (this.visible && anyPower) {
            const sigChanged = this._geometrySignature(animTimes, geomPanEnabled);
            const isCurved = p.patternShape !== 'Horizontal' && p.curveAmplitude > 0.001;

            // Un joueur dans l'éventail (ou qui vient d'en sortir) impose un recalcul
            let playerDirty = false;
            if (this._geomValid && !sigChanged && hasActivePlayers()) {
                if (isCurved) {
                    playerDirty = true;
                } else if (this._nBeams > 0) {
                    const beams = this.pattern._beamPool;
                    const inWedge = isPlayerInWedge(this.pod.origin, beams[0].dir, beams[this._nBeams - 1].dir, LASER_MAX_RANGE + 20);
                    playerDirty = inWedge || this._playerWasInWedge;
                    this._playerWasInWedge = inWedge;
                }
            } else if (this._playerWasInWedge && !hasActivePlayers()) {
                playerDirty = true;
                this._playerWasInWedge = false;
            }

            if (!this._geomValid || sigChanged || playerDirty) {
                this._computeGeometry(animTimes, nBeamsPerPod, geomPanEnabled, isCurved);
                this._geomValid = true;
            }
        }

        this._writeParamRow(effectiveBeamPower, effectivePanPower, nBeamsPerPod);
        this.renderable = this.visible && anyPower && this._geomValid;
    }

    /**
     * Lance les rayons vers l'environnement et écrit faisceaux, impacts, nappe PAN
     * et lignes d'impact dans le tampon de sortie de ce laser.
     */
    _computeGeometry(animTimes, nBeamsPerPod, geomPanEnabled, isCurved) {
        const p = this.params;
        const out = this.output;
        const row = this.row;
        const origin = this.pod.origin;
        const glow = out.glow;
        out.reset();
        out.glow = glow;

        // Obtenir les faisceaux du motif avec les horloges de balayage par axe (bridées au cône optique)
        const patternResult = this.pattern.getBeams(origin, animTimes, p, 0, this.pod.phase);
        const { beams, pitch, a1, a2 } = patternResult;
        const nBeams = patternResult.nBeams;
        this._nBeams = nBeams;
        this._ensureBeamPool(nBeams);

        // Calcul de la normale exacte du plan laser (perpendiculaire à l'éventail)
        if (nBeams >= 2) {
            this._panNormal.crossVectors(beams[0].dir, beams[nBeams - 1].dir).normalize();
            if (this._panNormal.lengthSq() < 0.1) {
                this._panNormal.set(0, 1, 0);
            } else if (this._panNormal.y < 0) {
                this._panNormal.negate();
            }
        } else {
            this._panNormal.set(0, 1, 0);
        }

        // Pré-filtrage des obstacles : pour un éventail plan, seuls les obstacles
        // traversés par le plan (et devant la source) peuvent être touchés.
        if (!isCurved) {
            this.pattern.getFanFrame(this._fanNormal, this._fanForward);
            const count = collectFanObstacles(origin, this._fanNormal, this._fanForward, 0.02, this._obstacleList);
            setActiveObstacles(this._obstacleList, count);
        }

        const beamHits = this._beamHits;
        const beamNormals = this._beamNormals;
        const beamReal = this._beamReal;
        this._podHitPts.length = nBeams;

        const beamWidth = p.beamWidth;

        // Lancer les rayons des faisceaux vers l'environnement
        for (let i = 0; i < nBeams; i++) {
            const hitObj = getSceneHit(origin, beams[i].dir);
            const hit = beamHits[i];
            const nrm = beamNormals[i];
            hit.copy(hitObj.hit);
            nrm.copy(hitObj.normal);
            beamReal[i] = hitObj.isRealSurface ? 1 : 0;
            this._podHitPts[i] = hit;

            out.pushBeam(row, origin.x, origin.y, origin.z, hit.x, hit.y, hit.z);

            // N'afficher le halo d'impact que si le laser touche une surface réelle (sol / mur / obstacle / joueur)
            if (hitObj.isRealSurface) {
                const hdx = hit.x - origin.x, hdy = hit.y - origin.y, hdz = hit.z - origin.z;
                const hitDist = Math.sqrt(hdx * hdx + hdy * hdy + hdz * hdz);
                const divergenceFactor = beamSpread(hitDist);
                const beamRadius = (0.022 + 0.025 * beamWidth) * divergenceFactor;
                out.pushImpact(row,
                    hit.x + nrm.x * 0.015, hit.y + nrm.y * 0.015, hit.z + nrm.z * 0.015,
                    nrm.x, nrm.y, nrm.z, beamRadius);
            }
        }

        // Plan PAN volumétrique
        if (geomPanEnabled && nBeams > 1) {
            this._computeFan(beams, nBeams, pitch, a1, a2, isCurved);
        }

        setActiveObstacles(null, 0);
    }

    _computeFan(beams, nBeams, pitch, a1, a2, isCurved) {
        const p = this.params;
        const out = this.output;
        const row = this.row;
        const origin = this.pod.origin;
        const beamHits = this._beamHits;
        const beamNormals = this._beamNormals;
        const beamReal = this._beamReal;

        const lineHalfWidth = 0.015 + 0.015 * clamp(p.beamWidth, 0.2, 10.0);
        const spreadPerInterval = Math.abs(a2 - a1) / (nBeams - 1);

        for (let i = 0; i < nBeams - 1; i++) {
            const angleStart = beams[i].angleDeg;
            const angleEnd   = beams[i + 1].angleDeg;

            // ── LOD Adaptatif : Détection dynamique de joueur dans ce secteur angulaire ──
            const hasPlayer = isPlayerInWedge(origin, beams[i].dir, beams[i + 1].dir, 65);

            let effectiveSubs;
            let bsearchIters;

            if (isCurved) {
                const totalSamplesNeeded = Math.max(48, Math.ceil(48 * p.curveFrequency));
                effectiveSubs = Math.max(1, Math.ceil(totalSamplesNeeded / (nBeams - 1)));
                effectiveSubs = Math.min(effectiveSubs, ARC_SUBDIVISIONS);
                bsearchIters = hasPlayer ? 8 : 4;
            } else if (hasPlayer) {
                // Joueur dans le secteur : échantillonnage ultra-fin (0.08° par pas) pour découper bras, torse et vide
                effectiveSubs = Math.max(1, Math.min(ARC_SUBDIVISIONS, Math.ceil(spreadPerInterval / 0.08)));
                bsearchIters = 8;
            } else {
                // Aucun joueur : obstacles statiques simples (sol, scène, piliers) -> pas angulaire de 0.45°
                effectiveSubs = Math.max(1, Math.min(24, Math.ceil(spreadPerInterval / 0.45)));
                bsearchIters = 4;
            }

            let arcHit0   = beamHits[i];
            let arcNorm0  = beamNormals[i];
            let arcAngle0 = angleStart;
            let arcReal0  = beamReal[i] === 1;
            let slot = 0;

            for (let k = 0; k < effectiveSubs; k++) {
                let arcHit1, arcNorm1, arcAngle1, arcReal1;

                if (k === effectiveSubs - 1) {
                    arcHit1   = beamHits[i + 1];
                    arcNorm1  = beamNormals[i + 1];
                    arcAngle1 = angleEnd;
                    arcReal1  = beamReal[i + 1] === 1;
                } else {
                    arcAngle1 = angleStart + (angleEnd - angleStart) * ((k + 1) / effectiveSubs);
                    // Emplacement tournant : jamais celui de arcHit0
                    slot ^= 1;
                    const dir1 = this.pattern.getDirectionCurved(arcAngle1, pitch, a1, a2, this._subDir);
                    const hitObj1 = getSceneHit(origin, dir1);
                    arcHit1  = this._subHit[slot].copy(hitObj1.hit);
                    arcNorm1 = this._subNorm[slot].copy(hitObj1.normal);
                    arcReal1 = hitObj1.isRealSurface;
                }

                // Continuité de surface : même normale ET pas de décrochage brusque de profondeur (depth jump)
                const dist0 = arcHit0.distanceTo(origin);
                const dist1 = arcHit1.distanceTo(origin);
                const depthJump = Math.abs(dist0 - dist1) > Math.max(0.35, Math.min(dist0, dist1) * 0.12);
                const sameWall = (!arcReal0 && !arcReal1) || (arcReal0 && arcReal1 && !depthJump && arcNorm0.dot(arcNorm1) > 0.90);

                if (sameWall) {
                    out.pushFan(row, arcHit0, arcHit1);
                    this._pushPanImpact(origin, arcHit0, arcNorm0, arcReal0, arcHit1, arcNorm1, arcReal1, lineHalfWidth);
                } else {
                    let loAng = arcAngle0, hiAng = arcAngle1;
                    for (let iter = 0; iter < bsearchIters; iter++) {
                        const midAng = (loAng + hiAng) * 0.5;
                        const midDir = this.pattern.getDirectionCurved(midAng, pitch, a1, a2, this._subDir);
                        const midHit = getSceneHit(origin, midDir);
                        const distMid = midHit.hit.distanceTo(origin);
                        const midDepthJump = Math.abs(dist0 - distMid) > Math.max(0.35, Math.min(dist0, distMid) * 0.12);
                        const match = (!arcReal0 && !midHit.isRealSurface) ||
                                      (arcReal0 && midHit.isRealSurface && !midDepthJump && arcNorm0.dot(midHit.normal) > 0.90);
                        if (match) loAng = midAng;
                        else hiAng = midAng;
                    }
                    const cHitLo = getSceneHit(origin, this.pattern.getDirectionCurved(loAng, pitch, a1, a2, this._subDir));
                    const hitLo = this._loHit.copy(cHitLo.hit);
                    const normLo = this._loNorm.copy(cHitLo.normal);
                    const realLo = cHitLo.isRealSurface;

                    const cHitHi = getSceneHit(origin, this.pattern.getDirectionCurved(hiAng, pitch, a1, a2, this._subDir));
                    const hitHi = this._hiHit.copy(cHitHi.hit);
                    const normHi = this._hiNorm.copy(cHitHi.normal);
                    const realHi = cHitHi.isRealSurface;

                    // Découpe nette par un obstacle ou discontinuité de surface :
                    // chaque nappe s'arrête strictement sur sa surface respective.
                    out.pushFan(row, arcHit0, hitLo);
                    out.pushFan(row, hitHi, arcHit1);
                    // Combler la fente angulaire entre hitLo et hitHi jusqu'à l'obstacle le plus proche :
                    // sinon une fine bande vide apparaît de chaque côté de l'obstacle (joueur),
                    // visible comme deux traits entre la source et l'obstacle.
                    {
                        const dLo = hitLo.distanceTo(origin);
                        const dHi = hitHi.distanceTo(origin);
                        const dNear = Math.min(dLo, dHi);
                        if (dLo > 1e-4 && dHi > 1e-4) {
                            const gLo = this._gapLo.subVectors(hitLo, origin).multiplyScalar(dNear / dLo).add(origin);
                            const gHi = this._gapHi.subVectors(hitHi, origin).multiplyScalar(dNear / dHi).add(origin);
                            out.pushFan(row, gLo, gHi);
                        }
                    }
                    this._pushPanImpact(origin, arcHit0, arcNorm0, arcReal0, hitLo, normLo, realLo, lineHalfWidth);
                    this._pushPanImpact(origin, hitHi, normHi, realHi, arcHit1, arcNorm1, arcReal1, lineHalfWidth);
                }

                arcHit0   = arcHit1;
                arcNorm0  = arcNorm1;
                arcAngle0 = arcAngle1;
                arcReal0  = arcReal1;
            }
        }
    }

    /**
     * Ligne d'impact continue du plan : valide que le segment est un impact réel
     * transversal sur une surface en contact direct, puis l'écrit (100% inline, 0 allocation).
     */
    _pushPanImpact(origin, h0, n0, real0, h1, n1, real1, lineHalfWidth) {
        // 1. Les deux extrémités doivent impacter une surface physique réelle (pas le ciel ni le vide)
        if (!real0 || !real1) return;

        // 2. Les deux points doivent appartenir à la même face / orientation de surface
        if (n0.x * n1.x + n0.y * n1.y + n0.z * n1.z < 0.90) return;

        // 3. Longueur du segment (doit être un pas local, jamais un saut de pontage dans le vide)
        const sdx = h1.x - h0.x;
        const sdy = h1.y - h0.y;
        const sdz = h1.z - h0.z;
        const sdLenSq = sdx * sdx + sdy * sdy + sdz * sdz;
        if (sdLenSq < 1e-6 || sdLenSq > 9.0) return; // Min 1mm, Max 3m
        const sdInv = 1.0 / Math.sqrt(sdLenSq);
        const sdNx = sdx * sdInv;
        const sdNy = sdy * sdInv;
        const sdNz = sdz * sdInv;

        // 4. La surface doit faire face au laser incident (en contact direct frontal)
        const d0x = h0.x - origin.x;
        const d0y = h0.y - origin.y;
        const d0z = h0.z - origin.z;
        const d0Len = Math.sqrt(d0x * d0x + d0y * d0y + d0z * d0z);
        if (d0Len < 0.001) return;
        if ((d0x * n0.x + d0y * n0.y + d0z * n0.z) / d0Len >= -0.05) return;

        const d1x = h1.x - origin.x;
        const d1y = h1.y - origin.y;
        const d1z = h1.z - origin.z;
        const d1Len = Math.sqrt(d1x * d1x + d1y * d1y + d1z * d1z);
        if (d1Len < 0.001) return;
        if ((d1x * n1.x + d1y * n1.y + d1z * n1.z) / d1Len >= -0.05) return;

        // 5. Le segment doit être TRANSVERSAL à la direction du laser (nappe en balayage).
        const midRayX = (d0x + d1x) * 0.5;
        const midRayY = (d0y + d1y) * 0.5;
        const midRayZ = (d0z + d1z) * 0.5;
        const midRayDist = Math.sqrt(midRayX * midRayX + midRayY * midRayY + midRayZ * midRayZ);
        if (midRayDist < 0.001) return;
        const mrInv = 1.0 / midRayDist;
        if (Math.abs(sdNx * midRayX * mrInv + sdNy * midRayY * mrInv + sdNz * midRayZ * mrInv) > 0.60) return;

        // Normale moyenne pour le plan d'impact
        const avgNx = (n0.x + n1.x) * 0.5;
        const avgNy = (n0.y + n1.y) * 0.5;
        const avgNz = (n0.z + n1.z) * 0.5;

        // Vecteur perpendiculaire dans le plan d'impact : cross(sd, avgN)
        const svx = sdNy * avgNz - sdNz * avgNy;
        const svy = sdNz * avgNx - sdNx * avgNz;
        const svz = sdNx * avgNy - sdNy * avgNx;
        const svLenSq = svx * svx + svy * svy + svz * svz;
        if (svLenSq < 1e-6) return;

        // Divergence
        const hw = lineHalfWidth * beamSpread(midRayDist) / Math.sqrt(svLenSq);

        // Points décalés de la normale de surface (0.012m pour éviter le z-fighting)
        this.output.pushPanImpact(this.row,
            h0.x + n0.x * 0.012, h0.y + n0.y * 0.012, h0.z + n0.z * 0.012,
            h1.x + n1.x * 0.012, h1.y + n1.y * 0.012, h1.z + n1.z * 0.012,
            svx * hw, svy * hw, svz * hw);
    }

    /** Affiche / masque complètement ce laser */
    setVisible(visible) {
        this.visible = visible;
        this.group.visible = visible;
        this.pod.setVisible(visible);
    }

    /** Libère toutes les ressources (la ligne GPU est rendue au batch) */
    dispose() {
        this.pod.dispose();
        if (this.batch) this.batch.freeRow(this.row);
        this.scene.remove(this.group);
    }
}
