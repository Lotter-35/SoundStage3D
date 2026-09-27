/**
 * LaserShow.js (adapté pour SoundStage3D)
 * ─────────────────────────────────────────────────────────────
 * Représente UN projecteur laser positionnable dans la scène.
 * Chaque instance est un laser indépendant avec ses propres params,
 * ses buffers GPU, son modèle 3D et son animation.
 *
 * Adapté depuis le projet LaserSimulation (GitHub: Lotter-35/LaserSimulation)
 * Changements majeurs :
 * - Un seul pod par instance (laser = 1 boîtier physique)
 * - Room.js remplacé par LaserSceneIntersector.js (festival en plein air)
 * - Shaders sous forme de factories (pas de singleton global)
 * - Params individuels par instance (createLaserParams())
 * - Fumée SimonDev appliquée synchroniquement sur les faisceaux et le plan laser
 * ─────────────────────────────────────────────────────────────
 * OPTIMISÉ : 0 allocation GC par frame (pool de vecteurs pré-alloués)
 */

import * as THREE from 'three';
import {
    MAX_BEAMS_PER_POD,
    ARC_SUBDIVISIONS,
    BEAM_DIVERGENCE,
    clamp
} from './config/laserConstants.js?v=2';
import { createLaserParams } from './config/laserParams.js?v=27';
import {
    createLaserShaderMaterial,
    createFanShaderMaterial,
    createPodGlowMaterial,
    createImpactShaderMaterial,
    createPanImpactShaderMaterial
} from './LaserShaders.js?v=10';
import { LaserPod } from './LaserPod.js?v=2';
import { LaserRenderer } from './LaserRenderer.js?v=4';
import { PatternHorizontalSweep } from './patterns/PatternHorizontalSweep.js?v=25';
import { getSceneHit, isPlayerInWedge } from './LaserSceneIntersector.js?v=9';
import { enableLaserBloom } from './LaserManager.js';

export class LaserShow {
    /**
     * @param {THREE.Scene} scene
     * @param {THREE.Vector3} position Position initiale du laser
     * @param {object} [paramOverrides] Surcharges de params optionnelles
     */
    constructor(scene, position = new THREE.Vector3(0, 5, 0), paramOverrides = {}) {
        this.scene = scene;

        // Params individuels — chaque laser a les siens
        this.params = createLaserParams(paramOverrides);

        // Groupe racine pour le raycasting et le gizmo
        this.group = new THREE.Group();
        this.group.name = 'laser-show-group';
        this.group.position.copy(position);
        this.scene.add(this.group);

        // Matériaux GLSL individuels (factory — 1 jeu par laser)
        this.materials = {
            laserShaderMaterial:    createLaserShaderMaterial(this.params),
            fanShaderMaterial:      createFanShaderMaterial(this.params),
            podGlowMaterial:        createPodGlowMaterial(this.params),
            impactShaderMaterial:   createImpactShaderMaterial(this.params),
            panImpactShaderMaterial: createPanImpactShaderMaterial(this.params),
        };

        // Moteur de rendu des buffers GPU
        this.renderer = new LaserRenderer(scene, this.materials);

        // Motif géométrique actif
        this.pattern = new PatternHorizontalSweep();

        // Pod unique (1 laser = 1 boîtier physique)
        this.pod = new LaserPod(scene, 0, this.materials);
        this.pod.setBasePosition(position.x, position.y, position.z);
        this.pod.setVisible(true);

        // Activer le layer de bloom et d'aberration chromatique sélective sur les éléments émissifs
        enableLaserBloom(this.renderer.beamsMesh);
        enableLaserBloom(this.renderer.impactMesh);
        enableLaserBloom(this.renderer.panImpactMesh);
        enableLaserBloom(this.pod.fanMesh);
        enableLaserBloom(this.pod.glowMesh);

        // Pause animation & temps local synchronisé
        this.isPaused = Boolean(this.params.pauseMotion);
        this._animTime = 0;
        this._smokeTime = 0;
        this._pausedOffset = 0;
        this._frozenAnimTime = null;
        this._lastSharedTime = 0;

        // Pool pré-alloué de vecteurs hit/normal (0 GC par frame)
        const totalSlots = MAX_BEAMS_PER_POD * ARC_SUBDIVISIONS * 4;
        this._hitPool    = Array.from({ length: totalSlots }, () => new THREE.Vector3());
        this._normalPool = Array.from({ length: totalSlots }, () => new THREE.Vector3());
        this._poolSize   = totalSlots;

        // Listes réutilisables pour les hits de ce pod
        this._podHitPts  = [];
        this._podHitNrms = [];
        this._podHitReal = []; // true = surface réelle, false = ciel/vide

        // Couleurs pré-allouées
        this._baseColor  = new THREE.Color(this.params.color);
        this._giColor    = new THREE.Color();
        this._whiteColor = new THREE.Color(1, 1, 1);

        // Vecteur de direction pour les sub-rayons PAN
        this._subDir = new THREE.Vector3();
        // Vecteur normal du plan laser (perpendiculaire à l'éventail de nappe)
        this._panNormal = new THREE.Vector3(0, 1, 0);

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
        if (key === 'color') {
            this._setColor(value);
        } else if (key === 'pauseMotion') {
            this.isPaused = Boolean(value);
        }
    }

    _setColor(hex) {
        const c = new THREE.Color(hex);
        this.materials.laserShaderMaterial.uniforms.uColor.value.copy(c);
        this.materials.fanShaderMaterial.uniforms.uColor.value.copy(c);
        this.materials.podGlowMaterial.uniforms.uColor.value.copy(c);
        this.materials.impactShaderMaterial.uniforms.uColor.value.copy(c);
        this.materials.panImpactShaderMaterial.uniforms.uColor.value.copy(c);
        this._baseColor.set(hex);
    }

    /** Met à jour les uniforms des shaders pour la frame courante */
    _updateUniforms(effectiveBeamPower, effectivePanPower, nBeamsPerPod, animTime = 0, globalSmokeState = null) {
        const p = this.params;
        const beamPanAttenuation = (p.laserPan && p.spread > 0 && nBeamsPerPod > 1) ? 0.70 : 1.0;

        const lsm = this.materials.laserShaderMaterial;
        lsm.uniforms.uBeamPower.value       = effectiveBeamPower * beamPanAttenuation;
        lsm.uniforms.uBeamWidth.value       = p.beamWidth;
        lsm.uniforms.uBeamDivergence.value  = BEAM_DIVERGENCE;
        lsm.uniforms.uGlowIntensity.value   = p.glowIntensity;
        lsm.uniforms.uGlowScattering.value  = p.glowScattering;
        lsm.uniforms.uGlowFalloff.value     = p.glowFalloff;
        lsm.uniforms.uFogDensity.value      = p.fogDensity;
        lsm.uniforms.uFogGlowCoupling.value = p.fogGlowCoupling;

        const fsm = this.materials.fanShaderMaterial;

        // ── Fumée atmosphérique globale partagée (optimisation CPU : calculée une seule fois au niveau du LaserManager) ──
        if (fsm.uniforms.uWind) {
            if (globalSmokeState && globalSmokeState.wind) {
                fsm.uniforms.uWind.value.copy(globalSmokeState.wind);
            } else {
                // Fallback autonome si non piloté par LaserManager
                const speedVar = p.panSmokeSpeedVariation !== undefined ? p.panSmokeSpeedVariation : 1.0;
                const smokeSpeed = p.panSmokeSpeed !== undefined ? p.panSmokeSpeed : 0.15;
                const gustPhase = this._smokeTime * 0.25;
                const gustWave = Math.sin(gustPhase) * 0.62 + Math.sin(gustPhase * 0.47 + 1.3) * 0.38;
                const effectiveTime = (this._smokeTime + gustWave * (speedVar * 2.5)) * smokeSpeed;

                const windChange = p.panSmokeWindChange !== undefined ? p.panSmokeWindChange : 1.0;
                const windRate = 0.06 * (1.0 + windChange * 0.45);
                const slowT = effectiveTime * windRate;
                const meanderAmp = 1.0 + windChange * 1.8;

                const mx = (Math.sin(slowT * 0.72) * 4.2 + Math.sin(slowT * 0.26 + 0.8) * 2.8) * meanderAmp;
                const my = (Math.sin(slowT * 0.40 + 1.2) * 1.8 + Math.cos(slowT * 0.18) * 1.0) * meanderAmp;
                const mz = (Math.cos(slowT * 0.58) * 3.8 + Math.cos(slowT * 0.31 + 2.1) * 2.5) * meanderAmp;

                const lx = effectiveTime * 0.18;
                const ly = effectiveTime * 0.04;
                const lz = effectiveTime * 0.13;

                const meanderWeight = Math.min(1.0, Math.max(0.0, windChange / 1.2));
                const wx = mx * meanderWeight + lx * (1.0 - meanderWeight) + lx;
                const wy = my * meanderWeight + ly * (1.0 - meanderWeight) + ly;
                const wz = mz * meanderWeight + lz * (1.0 - meanderWeight) + lz;

                fsm.uniforms.uWind.value.set(wx, wy, wz);
            }
        }

        // Synchronisation des uniforms de fumée pour le plan (fsm)
        if (fsm.uniforms.uOrigin) fsm.uniforms.uOrigin.value.copy(this.pod.origin);
        if (fsm.uniforms.uTime) fsm.uniforms.uTime.value = (globalSmokeState && globalSmokeState.time !== undefined) ? globalSmokeState.time : this._smokeTime;
        if (fsm.uniforms.uSmokeEnabled) fsm.uniforms.uSmokeEnabled.value = (p.panSmokeEnabled !== false) ? 1.0 : 0.0;
        if (fsm.uniforms.uSmokeSpeed) fsm.uniforms.uSmokeSpeed.value = p.panSmokeSpeed !== undefined ? p.panSmokeSpeed : 0.30;
        if (fsm.uniforms.uSmokeScale) fsm.uniforms.uSmokeScale.value = p.panSmokeScale !== undefined ? p.panSmokeScale : 0.35;
        if (fsm.uniforms.uSmokeContrast) fsm.uniforms.uSmokeContrast.value = p.panSmokeContrast !== undefined ? p.panSmokeContrast : 0.50;
        if (fsm.uniforms.uSmokeBrightness) fsm.uniforms.uSmokeBrightness.value = p.panSmokeBrightness !== undefined ? p.panSmokeBrightness : 2.0;
        if (fsm.uniforms.uSmokeWindChange) fsm.uniforms.uSmokeWindChange.value = p.panSmokeWindChange !== undefined ? p.panSmokeWindChange : 1.0;
        if (fsm.uniforms.uSmokeSpeedVariation) fsm.uniforms.uSmokeSpeedVariation.value = p.panSmokeSpeedVariation !== undefined ? p.panSmokeSpeedVariation : 1.0;
        if (fsm.uniforms.uSmokePatchDensity) fsm.uniforms.uSmokePatchDensity.value = p.panSmokePatchDensity !== undefined ? p.panSmokePatchDensity : 0.50;
        if (fsm.uniforms.uSmokePatchScale) fsm.uniforms.uSmokePatchScale.value = p.panSmokePatchScale !== undefined ? p.panSmokePatchScale : 0.04;
        if (fsm.uniforms.uSmokePatchContrast) fsm.uniforms.uSmokePatchContrast.value = p.panSmokePatchContrast !== undefined ? p.panSmokePatchContrast : 0.40;
        if (fsm.uniforms.uSmokePatchSpeed) fsm.uniforms.uSmokePatchSpeed.value = p.panSmokePatchSpeed !== undefined ? p.panSmokePatchSpeed : 0.04;
        if (fsm.uniforms.uSmokePerpSpeed) fsm.uniforms.uSmokePerpSpeed.value = p.panSmokePerpSpeed !== undefined ? p.panSmokePerpSpeed : 0.15;
        if (fsm.uniforms.uLaserCount) fsm.uniforms.uLaserCount.value = (globalSmokeState && globalSmokeState.laserCount !== undefined) ? globalSmokeState.laserCount : 1.0;
        if (fsm.uniforms.uPanNormal) fsm.uniforms.uPanNormal.value.copy(this._panNormal);
        fsm.uniforms.uPanPower.value        = effectivePanPower;
        fsm.uniforms.uBeamPower.value       = effectiveBeamPower;
        fsm.uniforms.uBeamWidth.value       = p.beamWidth;
        fsm.uniforms.uGlowIntensity.value   = p.glowIntensity;
        fsm.uniforms.uFogDensity.value      = p.fogDensity;
        fsm.uniforms.uFogGlowCoupling.value = p.fogGlowCoupling;

        const ism = this.materials.impactShaderMaterial;
        ism.uniforms.uImpactPower.value         = p.beamWidth > 0.001 ? effectiveBeamPower : 0.0;
        ism.uniforms.uFogDensity.value          = p.fogDensity;
        ism.uniforms.uImpactGlowIntensity.value = p.impactGlowIntensity;
        ism.uniforms.uImpactGlowRadius.value    = p.impactGlowRadius;
        ism.uniforms.uFogGlowCoupling.value     = p.fogGlowCoupling;

        const pism = this.materials.panImpactShaderMaterial;
        pism.uniforms.uLinePower.value           = effectivePanPower;
        pism.uniforms.uFogDensity.value          = p.fogDensity;
        pism.uniforms.uImpactGlowIntensity.value = p.impactGlowIntensity;
        pism.uniforms.uImpactGlowRadius.value    = p.impactGlowRadius;
        pism.uniforms.uFogGlowCoupling.value     = p.fogGlowCoupling;

        const pgm = this.materials.podGlowMaterial;
        pgm.uniforms.uSourceEmissionPower.value = p.sourceEmissionPower;
        pgm.uniforms.uSourceGlowRadius.value    = p.sourceGlowRadius;
        pgm.uniforms.uFogDensity.value          = p.fogDensity;
        pgm.uniforms.uFogGlowCoupling.value     = p.fogGlowCoupling;

        const whiteMult = p.sourceWhitePower !== undefined ? p.sourceWhitePower : 1.0;
        const computedSourceGlow = (effectiveBeamPower * 0.35 + effectivePanPower * 0.75) * 1.10 * whiteMult;
        lsm.uniforms.uSourceGlowPower.value = computedSourceGlow;
        fsm.uniforms.uSourceGlowPower.value = computedSourceGlow;
        pgm.uniforms.uSourceGlowPower.value = computedSourceGlow;

        return computedSourceGlow;
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
            // Plus l'amplitude/écart est grand, plus le laser met de temps pour faire l'aller-retour (vitesse en °/s constante)
            const pitchOmega = pitchSpeed > 0 ? (pitchSpeed * 22.5) / pitchAmp : 0;
            const yawOmega   = yawSpeed > 0   ? (yawSpeed   * 22.5) / yawAmp   : 0;
            const rollOmega  = rollSpeed > 0  ? (isRollFull360 ? rollSpeed : ((rollSpeed * 135.0) / rollAmp)) : 0;

            if (pitchOmega > 0) this._pitchAnimTime = (this._pitchAnimTime || 0) + dt * pitchOmega;
            if (yawOmega > 0)   this._yawAnimTime   = (this._yawAnimTime   || 0) + dt * yawOmega;
            if (rollOmega > 0)  this._rollAnimTime  = (this._rollAnimTime  || 0) + dt * rollOmega;
        }

        const animTimes = {
            pitch: this._pitchAnimTime || 0,
            yaw:   this._yawAnimTime   || 0,
            roll:  this._rollAnimTime  || 0,
        };
        const effectiveSweepTime = this._pitchAnimTime || 0;

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

        const computedSourceGlow = this._updateUniforms(
            effectiveBeamPower, effectivePanPower, nBeamsPerPod, effectiveSweepTime, globalSmokeState
        );

        // Couleur GI (riche en couleur pure sans délavage blanc)
        this._baseColor.set(p.color);
        const baseSourceGlow = (effectiveBeamPower * 0.35 + effectivePanPower * 0.75) * 1.10;
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

        let globalBeamIdx = 0;
        let globalImpactIdx = 0;
        let globalFanSegmentIdx = 0;
        let hitPoolOffset = 0;

        this._podHitPts.length  = 0;
        this._podHitNrms.length = 0;
        this._podHitReal.length = 0;

        const origin = this.pod.origin;

        // Obtenir les faisceaux du motif avec les horloges de balayage par axe (bridées au cône optique)
        const patternResult = this.pattern.getBeams(
            origin, animTimes, p, 0, this.pod.phase
        );
        const { beams, pitch, a1, a2 } = patternResult;
        const nBeams = patternResult.nBeams;

        // Synchroniser le boîtier 3D et le glow avec l'orientation du châssis (sans la déviation du faisceau intérieur)
        const housingAngle = patternResult.housingAngle !== undefined ? patternResult.housingAngle : p.angle;
        const housingTilt = patternResult.housingTilt !== undefined ? patternResult.housingTilt : (p.tilt || 0);
        const housingRoll = patternResult.housingRoll !== undefined ? patternResult.housingRoll : (p.roll || 0);
        this.pod.updateSource(
            p.sourceDistanceOffset || 0,
            p.giWallOffset || 0,
            this._giColor,
            totalLightPower,
            p.giDistance,
            strobeFactor,
            housingAngle,
            housingTilt,
            housingRoll
        );

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
        if (this.materials.fanShaderMaterial.uniforms.uPanNormal) {
            this.materials.fanShaderMaterial.uniforms.uPanNormal.value.copy(this._panNormal);
        }

        // Lancer les rayons vers l'environnement
        for (let i = 0; i < nBeams; i++) {
            const b = beams[i];
            const hitObj = getSceneHit(origin, b.dir);

            let poolHit, poolNorm;
            if (hitPoolOffset < this._poolSize) {
                poolHit  = this._hitPool[hitPoolOffset];
                poolNorm = this._normalPool[hitPoolOffset];
                hitPoolOffset++;
            } else {
                poolHit  = new THREE.Vector3();
                poolNorm = new THREE.Vector3();
            }
            poolHit.copy(hitObj.hit);
            poolNorm.copy(hitObj.normal);

            this._podHitPts.push(poolHit);
            this._podHitNrms.push(poolNorm);
            this._podHitReal.push(hitObj.isRealSurface);

            this.renderer.writeBeam(globalBeamIdx, origin, poolHit);
            // N'afficher le halo d'impact que si le laser touche une surface réelle (sol / mur / obstacle / joueur)
            if (hitObj.isRealSurface) {
                this.renderer.writePointImpact(globalImpactIdx, origin, poolHit, poolNorm, p.beamWidth);
                globalImpactIdx++;
            }
            globalBeamIdx++;
        }

        // Plan PAN volumétrique
        const fanMesh = this.pod.fanMesh;
        if (p.laserPan && nBeamsPerPod > 1 && p.spread > 0 && effectivePanPower > 0.001) {
            fanMesh.visible = true;
            const fanPos  = fanMesh.geometry.attributes.position.array;
            const fanDist = fanMesh.geometry.attributes.aDistRatio.array;
            const fanLat  = fanMesh.geometry.attributes.aLateral.array;
            let ptr = 0, dPtr = 0, lPtr = 0;
            let fanTriCount = 0;

            const lineHalfWidth = 0.015 + 0.015 * clamp(p.beamWidth, 0.2, 3.0);

            // Subdivisions adaptatives
            const spreadPerInterval = (nBeamsPerPod > 1)
                ? Math.abs(a2 - a1) / (nBeamsPerPod - 1)
                : 0;

            const isCurved = p.patternShape !== 'Horizontal' && p.curveAmplitude > 0.001;

            const emitFanTri = (h0, h1, latA, latB) => {
                fanPos[ptr++] = origin.x; fanPos[ptr++] = origin.y; fanPos[ptr++] = origin.z;
                fanDist[dPtr++] = 0.0;
                fanLat[lPtr++] = 0.5;
                fanPos[ptr++] = h0.x; fanPos[ptr++] = h0.y; fanPos[ptr++] = h0.z;
                fanDist[dPtr++] = 1.0;
                fanLat[lPtr++] = latA;
                fanPos[ptr++] = h1.x; fanPos[ptr++] = h1.y; fanPos[ptr++] = h1.z;
                fanDist[dPtr++] = 1.0;
                fanLat[lPtr++] = latB;
                fanTriCount++;
            };

            for (let i = 0; i < nBeamsPerPod - 1; i++) {
                const angleStart = beams[i].angleDeg;
                const angleEnd   = beams[i + 1].angleDeg;
                const dirStart   = beams[i].dir;
                const dirEnd     = beams[i + 1].dir;

                // ── LOD Adaptatif : Détection dynamique de joueur dans ce secteur angulaire ──
                const hasPlayer = isPlayerInWedge(origin, dirStart, dirEnd, 65);

                let effectiveSubs;
                let bsearchIters;

                if (nBeamsPerPod < 2) {
                    effectiveSubs = 1;
                    bsearchIters = 4;
                } else if (isCurved) {
                    const totalSamplesNeeded = Math.max(48, Math.ceil(48 * p.curveFrequency));
                    effectiveSubs = Math.max(1, Math.ceil(totalSamplesNeeded / (nBeamsPerPod - 1)));
                    effectiveSubs = Math.min(effectiveSubs, ARC_SUBDIVISIONS);
                    bsearchIters = hasPlayer ? 8 : 4;
                } else if (hasPlayer) {
                    // Joueur dans le secteur : échantillonnage ultra-fin (0.08° par pas) pour découper bras, torse et vide
                    effectiveSubs = Math.max(24, Math.min(ARC_SUBDIVISIONS, Math.ceil(spreadPerInterval / 0.08)));
                    bsearchIters = 8;
                } else {
                    // Aucun joueur : obstacles statiques simples (sol, scène, piliers) -> LOD léger ultra-fluide (0.45° par pas)
                    effectiveSubs = Math.max(8, Math.min(24, Math.ceil(spreadPerInterval / 0.45)));
                    bsearchIters = 4;
                }

                let arcHit0   = this._podHitPts[i];
                let arcNorm0  = this._podHitNrms[i];
                let arcAngle0 = angleStart;
                let arcReal0  = this._podHitReal[i];

                for (let k = 0; k < effectiveSubs; k++) {
                    let arcHit1, arcNorm1, arcAngle1, arcReal1;

                    if (k === effectiveSubs - 1) {
                        arcHit1   = this._podHitPts[i + 1];
                        arcNorm1  = this._podHitNrms[i + 1];
                        arcAngle1 = angleEnd;
                        arcReal1  = this._podHitReal[i + 1];
                    } else {
                        const t1 = (k + 1) / effectiveSubs;
                        arcAngle1 = angleStart + (angleEnd - angleStart) * t1;

                        let subPoolHit, subPoolNorm;
                        if (hitPoolOffset < this._poolSize) {
                            subPoolHit  = this._hitPool[hitPoolOffset];
                            subPoolNorm = this._normalPool[hitPoolOffset];
                            hitPoolOffset++;
                        } else {
                            subPoolHit  = new THREE.Vector3();
                            subPoolNorm = new THREE.Vector3();
                        }

                        const dir1 = this.pattern.getDirectionCurved(arcAngle1, pitch, a1, a2, this._subDir);
                        const hitObj1 = getSceneHit(origin, dir1);
                        subPoolHit.copy(hitObj1.hit);
                        subPoolNorm.copy(hitObj1.normal);
                        arcHit1  = subPoolHit;
                        arcNorm1 = subPoolNorm;
                        arcReal1 = hitObj1.isRealSurface;
                    }

                    // Continuité de surface : même normale ET pas de décrochage brusque de profondeur (depth jump)
                    const dist0 = arcHit0.distanceTo(origin);
                    const dist1 = arcHit1.distanceTo(origin);
                    const depthJump = Math.abs(dist0 - dist1) > Math.max(0.35, Math.min(dist0, dist1) * 0.12);
                    const sameWall = (!arcReal0 && !arcReal1) || (arcReal0 && arcReal1 && !depthJump && arcNorm0.dot(arcNorm1) > 0.90);
                    let hitLoSlot = null;
                    let normLoSlot = null;
                    let realLoSlot = false;
                    let hitHiSlot = null;
                    let normHiSlot = null;
                    let realHiSlot = false;

                    if (!sameWall) {
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
                        const dirLo = this.pattern.getDirectionCurved(loAng, pitch, a1, a2, this._subDir);
                        const cHitLo = getSceneHit(origin, dirLo);
                        const dirHi = this.pattern.getDirectionCurved(hiAng, pitch, a1, a2, this._subDir);
                        const cHitHi = getSceneHit(origin, dirHi);

                        if (hitPoolOffset + 1 < this._poolSize) {
                            hitLoSlot  = this._hitPool[hitPoolOffset];
                            normLoSlot = this._normalPool[hitPoolOffset];
                            hitPoolOffset++;
                            hitHiSlot  = this._hitPool[hitPoolOffset];
                            normHiSlot = this._normalPool[hitPoolOffset];
                            hitPoolOffset++;
                        } else {
                            hitLoSlot  = new THREE.Vector3();
                            normLoSlot = new THREE.Vector3();
                            hitHiSlot  = new THREE.Vector3();
                            normHiSlot = new THREE.Vector3();
                        }
                        hitLoSlot.copy(cHitLo.hit);
                        normLoSlot.copy(cHitLo.normal);
                        realLoSlot = cHitLo.isRealSurface;

                        hitHiSlot.copy(cHitHi.hit);
                        normHiSlot.copy(cHitHi.normal);
                        realHiSlot = cHitHi.isRealSurface;
                    }

                    if (sameWall) {
                        emitFanTri(arcHit0, arcHit1, 0.0, 1.0);
                        if (this.renderer.writePanImpactQuad(globalFanSegmentIdx, origin, arcHit0, arcNorm0, arcReal0, arcHit1, arcNorm1, arcReal1, lineHalfWidth)) {
                            globalFanSegmentIdx++;
                        }
                    } else {
                        // Découpe nette par un obstacle ou discontinuité de surface :
                        // Chaque nappe s'arrête strictement sur sa surface respective.
                        // AUCUN triangle diagonal ni trait d'impact ne traverse le vide entre les deux côtés !
                        emitFanTri(arcHit0, hitLoSlot, 0.0, 0.5);
                        emitFanTri(hitHiSlot, arcHit1, 0.5, 1.0);

                        if (this.renderer.writePanImpactQuad(globalFanSegmentIdx, origin, arcHit0, arcNorm0, arcReal0, hitLoSlot, normLoSlot, realLoSlot, lineHalfWidth)) {
                            globalFanSegmentIdx++;
                        }
                        if (this.renderer.writePanImpactQuad(globalFanSegmentIdx, origin, hitHiSlot, normHiSlot, realHiSlot, arcHit1, arcNorm1, arcReal1, lineHalfWidth)) {
                            globalFanSegmentIdx++;
                        }
                    }

                    arcHit0   = arcHit1;
                    arcNorm0  = arcNorm1;
                    arcAngle0 = arcAngle1;
                    arcReal0  = arcReal1;
                }
            }

            fanMesh.geometry.attributes.position.needsUpdate   = true;
            fanMesh.geometry.attributes.aDistRatio.needsUpdate = true;
            fanMesh.geometry.attributes.aLateral.needsUpdate   = true;
            fanMesh.geometry.setDrawRange(0, fanTriCount * 3);
        } else {
            fanMesh.visible = false;
        }

        this.renderer.finalizeFrame(globalBeamIdx, globalImpactIdx, globalFanSegmentIdx);
    }

    /** Affiche / masque complètement ce laser */
    setVisible(visible) {
        this.group.visible = visible;
        this.pod.setVisible(visible);
        this.renderer.beamsMesh.visible = visible;
        this.renderer.impactMesh.visible = visible;
        this.renderer.panImpactMesh.visible = visible;
    }

    /** Libère toutes les ressources GPU */
    dispose() {
        this.pod.dispose();
        this.renderer.beamGeo.dispose();
        this.renderer.impactGeo.dispose();
        this.renderer.panImpactGeo.dispose();
        for (const mat of Object.values(this.materials)) {
            mat.dispose();
        }
        this.scene.remove(this.renderer.beamsMesh);
        this.scene.remove(this.renderer.impactMesh);
        this.scene.remove(this.renderer.panImpactMesh);
        this.scene.remove(this.group);
    }
}
