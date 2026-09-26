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
} from './config/laserConstants.js';
import { createLaserParams } from './config/laserParams.js?v=2';
import {
    createLaserShaderMaterial,
    createFanShaderMaterial,
    createPodGlowMaterial,
    createImpactShaderMaterial,
    createPanImpactShaderMaterial
} from './LaserShaders.js';
import { LaserPod } from './LaserPod.js';
import { LaserRenderer } from './LaserRenderer.js';
import { PatternHorizontalSweep } from './patterns/PatternHorizontalSweep.js';
import { getSceneHit } from './LaserSceneIntersector.js?v=3';
import { enableBloom } from './LaserManager.js';

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
        enableBloom(this.renderer.beamsMesh);
        enableBloom(this.renderer.impactMesh);
        enableBloom(this.renderer.panImpactMesh);
        enableBloom(this.pod.fanMesh);
        enableBloom(this.pod.glowMesh);

        // Pause animation & temps local synchronisé
        this.isPaused = Boolean(this.params.pauseMotion);
        this._animTime = 0;
        this._smokeTime = 0;
        this._pausedOffset = 0;
        this._frozenAnimTime = null;
        this._lastSharedTime = 0;

        // Pool pré-alloué de vecteurs hit/normal (0 GC par frame)
        const totalSlots = MAX_BEAMS_PER_POD * ARC_SUBDIVISIONS;
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

        // Repères réutilisables d'orientation laser 3D (0 GC)
        this._rotEuler   = new THREE.Euler(0, 0, 0, 'YXZ');
        this._rotQuat    = new THREE.Quaternion();
        this._smokeFwd   = new THREE.Vector3();
        this._smokeRight = new THREE.Vector3();
        this._smokeUp    = new THREE.Vector3();

        // Initialisation spatiale immédiate du boîtier 3D avec l'orientation des paramètres
        this.pod.updateSource(
            this.params.sourceDistanceOffset || 0,
            this.params.giWallOffset || 0,
            this._giColor,
            0,
            this.params.giDistance || 15,
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
    _updateUniforms(effectiveBeamPower, effectivePanPower, nBeamsPerPod, animTime = 0, smokeTime = 0) {
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

        // ── Calcul CPU du vent et des rafales (1 seule fois par frame pour tout le laser, 0% GPU !) ──
        if (fsm.uniforms.uWind) {
            const speedVar = p.panSmokeSpeedVariation !== undefined ? p.panSmokeSpeedVariation : 0.7;
            const smokeSpeed = p.panSmokeSpeed !== undefined ? p.panSmokeSpeed : 0.8;
            const gustPhase = smokeTime * 0.25;
            const gustWave = Math.sin(gustPhase) * 0.62 + Math.sin(gustPhase * 0.47 + 1.3) * 0.38;
            const effectiveTime = (smokeTime + gustWave * (speedVar * 2.5)) * smokeSpeed;

            const windChange = p.panSmokeWindChange !== undefined ? p.panSmokeWindChange : 0.8;
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

        // Synchronisation des uniforms de fumée pour le plan (fsm)
        if (fsm.uniforms.uOrigin) fsm.uniforms.uOrigin.value.copy(this.pod.origin);
        if (fsm.uniforms.uTime) fsm.uniforms.uTime.value = smokeTime;
        if (fsm.uniforms.uSmokeEnabled) fsm.uniforms.uSmokeEnabled.value = (p.panSmokeEnabled !== false) ? 1.0 : 0.0;
        if (fsm.uniforms.uSmokeSpeed) fsm.uniforms.uSmokeSpeed.value = p.panSmokeSpeed !== undefined ? p.panSmokeSpeed : 0.8;
        if (fsm.uniforms.uSmokeScale) fsm.uniforms.uSmokeScale.value = p.panSmokeScale !== undefined ? p.panSmokeScale : 0.08;
        if (fsm.uniforms.uSmokeContrast) fsm.uniforms.uSmokeContrast.value = p.panSmokeContrast !== undefined ? p.panSmokeContrast : 0.65;
        if (fsm.uniforms.uSmokeBrightness) fsm.uniforms.uSmokeBrightness.value = p.panSmokeBrightness !== undefined ? p.panSmokeBrightness : 0.75;
        if (fsm.uniforms.uSmokeWindChange) fsm.uniforms.uSmokeWindChange.value = p.panSmokeWindChange !== undefined ? p.panSmokeWindChange : 0.8;
        if (fsm.uniforms.uSmokeSpeedVariation) fsm.uniforms.uSmokeSpeedVariation.value = p.panSmokeSpeedVariation !== undefined ? p.panSmokeSpeedVariation : 0.7;
        if (fsm.uniforms.uSmokePatchDensity) fsm.uniforms.uSmokePatchDensity.value = p.panSmokePatchDensity !== undefined ? p.panSmokePatchDensity : 0.35;
        if (fsm.uniforms.uSmokePatchScale) fsm.uniforms.uSmokePatchScale.value = p.panSmokePatchScale !== undefined ? p.panSmokePatchScale : 0.03;
        if (fsm.uniforms.uSmokePatchContrast) fsm.uniforms.uSmokePatchContrast.value = p.panSmokePatchContrast !== undefined ? p.panSmokePatchContrast : 0.45;
        if (fsm.uniforms.uSmokePatchSpeed) fsm.uniforms.uSmokePatchSpeed.value = p.panSmokePatchSpeed !== undefined ? p.panSmokePatchSpeed : 0.02;
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

        const computedSourceGlow = (effectiveBeamPower * 0.35 + effectivePanPower * 0.75) * 1.10;
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
     */
    update(delta, animTime, cameraPos = null) {
        const p = this.params;
        const nBeamsPerPod = p.spread > 0 ? Math.max(1, Math.round(p.count)) : 1;
        const isPaused = this.isPaused || Boolean(p.pauseMotion);

        if (typeof animTime === 'number' && !isNaN(animTime)) {
            this._lastSharedTime = animTime;

            if (isPaused) {
                if (this._frozenAnimTime === null) {
                    this._frozenAnimTime = this._animTime;
                }
            } else {
                if (this._frozenAnimTime !== null) {
                    this._pausedOffset = animTime - this._frozenAnimTime;
                    this._frozenAnimTime = null;
                }
                this._animTime = animTime - (this._pausedOffset || 0);
            }
        } else {
            // Mode hors-ligne sans horloge partagée
            if (!isPaused) {
                const dt = (delta > 0 && delta < 0.5) ? delta : 0.016;
                this._animTime += dt;
            }
        }

        const effectiveAnimTime = isPaused
            ? (this._frozenAnimTime !== null ? this._frozenAnimTime : this._animTime)
            : this._animTime;

        // La simulation de fumée (SimonDev noise) continue TOUJOURS d'évoluer de façon fluide dans toutes les directions
        this._smokeTime += (delta > 0 && delta < 0.5) ? delta : 0.016;

        // Stroboscope
        let strobeFactor = 1.0;
        if (p.strobe) {
            const t = effectiveAnimTime * p.strobeSpeed;
            strobeFactor = (t - Math.floor(t)) < 0.5 ? 1.0 : 0.0;
        }

        const effectiveBeamPower = p.beamPower * p.masterPower * strobeFactor;
        const effectivePanPower  = p.panPower  * p.masterPower * strobeFactor;

        // Exposés pour le DazzleEffect (lus par LaserManager chaque frame)
        this._effectiveBeamPower = effectiveBeamPower;
        this._effectivePanPower  = effectivePanPower;

        const computedSourceGlow = this._updateUniforms(
            effectiveBeamPower, effectivePanPower, nBeamsPerPod, effectiveAnimTime, this._smokeTime
        );

        // Couleur GI
        this._baseColor.set(p.color);
        const totalLightPower = computedSourceGlow * p.sourceEmissionPower * p.giIntensity;
        const whiteTransition = clamp(computedSourceGlow * 0.35, 0.0, 1.0);
        if (p.giBounceColor) {
            this._giColor.copy(this._baseColor).lerp(this._whiteColor, whiteTransition * 0.6);
        } else {
            this._giColor.set(1, 1, 1);
        }

        // Position du pod = position du groupe (le laser a été déplacé)
        const podPos = this.group.position;
        this.pod.setBasePosition(podPos.x, podPos.y, podPos.z);
        this.pod.updateSource(
            p.sourceDistanceOffset || 0,
            p.giWallOffset || 0,
            this._giColor,
            totalLightPower,
            p.giDistance,
            strobeFactor,
            p.angle,
            p.tilt || 0,
            p.roll || 0
        );

        let globalBeamIdx = 0;
        let globalFanSegmentIdx = 0;
        let hitPoolOffset = 0;

        this._podHitPts.length  = 0;
        this._podHitNrms.length = 0;
        this._podHitReal.length = 0;

        const origin = this.pod.origin;

        // Obtenir les faisceaux du motif avec le temps effectif
        const patternResult = this.pattern.getBeams(
            origin, effectiveAnimTime, p, 0, this.pod.phase
        );
        const { beams, pitch, a1, a2 } = patternResult;
        const nBeams = patternResult.nBeams;

        // Synchronisation de la base orthonormée 3D du laser pour la fumée PAN et des faisceaux
        const fsm = this.materials.fanShaderMaterial;
        const lsm = this.materials.laserShaderMaterial;
        if (fsm && fsm.uniforms.uLaserForward) {
            const yawRad   = (p.angle || 0) * (Math.PI / 180);
            const pitchRad = pitch || 0;
            const rollRad  = (p.roll  || 0) * (Math.PI / 180);

            this._rotEuler.set(-pitchRad, yawRad, rollRad, 'YXZ');
            this._rotQuat.setFromEuler(this._rotEuler);

            this._smokeFwd.set(0, 0, 1).applyQuaternion(this._rotQuat);
            this._smokeRight.set(1, 0, 0).applyQuaternion(this._rotQuat);
            this._smokeUp.set(0, 1, 0).applyQuaternion(this._rotQuat);

            fsm.uniforms.uLaserForward.value.copy(this._smokeFwd);
            fsm.uniforms.uLaserRight.value.copy(this._smokeRight);
            fsm.uniforms.uLaserUp.value.copy(this._smokeUp);
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
            // N'afficher le halo d'impact que si le laser touche une surface réelle (sol / mur latéral en descente)
            if (hitObj.isRealSurface) {
                this.renderer.writePointImpact(globalBeamIdx, origin, poolHit, poolNorm, p.beamWidth);
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

            let effectiveSubs;
            const isCurved = p.patternShape !== 'Horizontal' && p.curveAmplitude > 0.001;
            if (nBeamsPerPod < 2) {
                effectiveSubs = 1;
            } else if (isCurved) {
                const totalSamplesNeeded = Math.max(48, Math.ceil(48 * p.curveFrequency));
                effectiveSubs = Math.max(1, Math.ceil(totalSamplesNeeded / (nBeamsPerPod - 1)));
                effectiveSubs = Math.min(effectiveSubs, ARC_SUBDIVISIONS);
            } else {
                effectiveSubs = Math.max(1, Math.min(ARC_SUBDIVISIONS, Math.ceil(spreadPerInterval / 5)));
            }

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

                    const sameWall = (!arcReal0 && !arcReal1) || (arcNorm0.dot(arcNorm1) > 0.999);
                    let cornerHit = null;

                    if (!sameWall) {
                        let loAng = arcAngle0, hiAng = arcAngle1;
                        for (let iter = 0; iter < 10; iter++) {
                            const midAng = (loAng + hiAng) * 0.5;
                            const midDir = this.pattern.getDirectionCurved(midAng, pitch, a1, a2, this._subDir);
                            const midNorm = getSceneHit(origin, midDir).normal;
                            if (midNorm.dot(arcNorm0) > 0.999) loAng = midAng;
                            else hiAng = midAng;
                        }
                        const cornerAng = (loAng + hiAng) * 0.5;
                        const cornerDir = this.pattern.getDirectionCurved(cornerAng, pitch, a1, a2, this._subDir);
                        const cHitObj = getSceneHit(origin, cornerDir);

                        let cornerSlot;
                        if (hitPoolOffset < this._poolSize) {
                            cornerSlot = this._hitPool[hitPoolOffset++];
                        } else {
                            cornerSlot = new THREE.Vector3();
                        }
                        cornerSlot.copy(cHitObj.hit);
                        cornerHit = cornerSlot;
                    }

                    if (sameWall) {
                        emitFanTri(arcHit0, arcHit1, 0.0, 1.0);
                    } else {
                        emitFanTri(arcHit0, cornerHit, 0.0, 0.5);
                        emitFanTri(cornerHit, arcHit1, 0.5, 1.0);
                    }

                    // N'afficher la ligne d'impact PAN que si le segment touche une surface réelle
                    const segmentIsReal = arcReal0 || arcReal1;
                    if (segmentIsReal) {
                        if (sameWall) {
                            if (this.renderer.writePanImpactQuad(globalFanSegmentIdx, origin, arcHit0, arcNorm0, arcHit1, lineHalfWidth)) {
                                globalFanSegmentIdx++;
                            }
                        } else {
                            if (this.renderer.writePanImpactQuad(globalFanSegmentIdx, origin, arcHit0, arcNorm0, cornerHit, lineHalfWidth)) {
                                globalFanSegmentIdx++;
                            }
                            if (this.renderer.writePanImpactQuad(globalFanSegmentIdx, origin, cornerHit, arcNorm1, arcHit1, lineHalfWidth)) {
                                globalFanSegmentIdx++;
                            }
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

        this.renderer.finalizeFrame(globalBeamIdx, globalFanSegmentIdx);
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
