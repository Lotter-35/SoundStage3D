/**
 * LaserShow.js
 * ─────────────────────────────────────────────────────────────
 * Classe LaserShow : chef d'orchestre de tout le système laser.
 * - Gère N boîtiers (LaserPod)
 * - Orchestre les buffers GPU partagés (LaserRenderer)
 * - Applique le motif géométrique actif (PatternBase)
 * - Calcule les intersections analytiques avec la salle (Room)
 * - Gère le plan PAN volumétrique adaptatif avec contournement d'arêtes
 * - Expose l'API haut niveau pour la console de lumière / UI
 * ─────────────────────────────────────────────────────────────
 * OPTIMISÉ : 0 allocation GC par frame (pool de vecteurs pré-alloués)
 */

import {
    ROOM_W,
    HALF_H,
    HALF_D,
    MAX_PODS,
    MAX_BEAMS_PER_POD,
    ARC_SUBDIVISIONS,
    BEAM_DIVERGENCE,
    clamp
} from '../config/constants.js';
import { params } from '../config/params.js';
import { LaserPod } from './LaserPod.js?v=20';
import { LaserRenderer } from './LaserRenderer.js';
import { PatternHorizontalSweep } from './patterns/PatternHorizontalSweep.js?v=12';
import {
    laserShaderMaterial,
    fanShaderMaterial,
    podGlowMaterial,
    impactShaderMaterial,
    panImpactShaderMaterial,
    setShadersColor
} from './LaserShaders.js';

export class LaserShow {
    /**
     * @param {THREE.Scene} scene
     * @param {import('../core/Room.js').Room} room
     */
    constructor(scene, room) {
        this.scene = scene;
        this.room = room;

        // Moteur de rendu des buffers partagés
        this.renderer = new LaserRenderer(scene);

        // Motif actif (par défaut : Balayage horizontal)
        this.pattern = new PatternHorizontalSweep();

        // Initialisation du pool fixe de boîtiers
        this.pods = [];
        for (let p = 0; p < MAX_PODS; p++) {
            this.pods.push(new LaserPod(scene, p));
        }

        this.updatePodPositions();

        // ── Pool pré-alloué de vecteurs hit / normal (0 GC par frame) ─────────
        // Pire cas pratique :
        //   beams directs    : MAX_PODS × MAX_BEAMS  = 12 × 64  = 768
        //   sub-rayons PAN   : MAX_PODS × (MAX_BEAMS-1) × ARC_SUBDIVISIONS
        //                    = 12 × 63 × 64 = 48 384  (si 64 beams ET 64 subs)
        //   coins d'arêtes   : même ordre = 48 384
        // En pratique, beams élevé → peu de subs, et inversement.
        // On prend MAX_PODS × MAX_BEAMS × ARC_SUBDIVISIONS comme enveloppe sure.
        this._hitPool    = [];
        this._normalPool = [];
        const totalSlots = MAX_PODS * MAX_BEAMS_PER_POD * ARC_SUBDIVISIONS;
        for (let i = 0; i < totalSlots; i++) {
            this._hitPool.push(new THREE.Vector3());
            this._normalPool.push(new THREE.Vector3());
        }
        this._poolSize = totalSlots;

        // Pool de listes réutilisables pour hitPoints / hitNormals par pod
        this._podHitPts  = [];
        this._podHitNrms = [];
        for (let p = 0; p < MAX_PODS; p++) {
            this._podHitPts.push([]);
            this._podHitNrms.push([]);
        }

        // Couleurs pré-allouées pour éviter new THREE.Color() chaque frame
        this._baseColor  = new THREE.Color(params.color);
        this._giColor    = new THREE.Color();
        this._whiteColor = new THREE.Color(1, 1, 1);

        // Résultat de frame pré-alloué
        this._frameResult = {
            allPodHitPoints:  this._podHitPts,
            allPodHitNormals: this._podHitNrms,
            effectiveBeamPower: 0,
            effectivePanPower:  0,
            giColor:  this._giColor,
            nBeamsPerPod: 0,
            a1: 0,
            a2: 0,
            animTime: 0
        };
    }

    /**
     * Change le motif géométrique actif (forme / animation galvos).
     */
    setPattern(patternInstance) {
        this.pattern = patternInstance;
    }

    /**
     * Recalcule la disposition spatiale des boîtiers laser selon params.
     */
    updatePodPositions() {
        const count = params.numPods;
        const basePodY = -HALF_H + 1.7 + params.podHeightAboveUser;

        let span = params.podSpacing2;
        if (count > 2) {
            span = Math.min(ROOM_W - 6, Math.max(params.podSpacing2, (count - 1) * 5.0));
        }

        for (let p = 0; p < MAX_PODS; p++) {
            if (p < count) {
                let posX = 0;
                if (count === 2) {
                    posX = (p === 0 ? -params.podSpacing2 / 2 : params.podSpacing2 / 2);
                } else if (count > 2) {
                    posX = -span / 2 + (p / (count - 1)) * span;
                }

                const posY = basePodY + (count <= 2 ? 0 : Math.sin(p * 0.7) * 0.8);
                const posZ = -HALF_D + 0.1;

                this.pods[p].setBasePosition(posX, posY, posZ);
                this.pods[p].setVisible(true);
            } else {
                this.pods[p].setVisible(false);
            }
        }
    }

    setColor(hex) {
        setShadersColor(hex);
        this._baseColor.set(hex);
    }

    /**
     * Met à jour les uniforms de tous les ShaderMaterials pour la frame courante.
     */
    _updateUniforms(effectiveBeamPower, effectivePanPower, nBeamsPerPod) {
        const beamPanAttenuation = (params.laserPan && params.spread > 0 && nBeamsPerPod > 1) ? 0.70 : 1.0;

        laserShaderMaterial.uniforms.uBeamPower.value        = effectiveBeamPower * beamPanAttenuation;
        laserShaderMaterial.uniforms.uBeamWidth.value        = params.beamWidth;
        laserShaderMaterial.uniforms.uBeamDivergence.value   = BEAM_DIVERGENCE;
        laserShaderMaterial.uniforms.uGlowIntensity.value    = params.glowIntensity;
        laserShaderMaterial.uniforms.uGlowScattering.value   = params.glowScattering;
        laserShaderMaterial.uniforms.uGlowFalloff.value      = params.glowFalloff;
        laserShaderMaterial.uniforms.uFogDensity.value       = params.fogDensity;
        laserShaderMaterial.uniforms.uFogGlowCoupling.value  = params.fogGlowCoupling;

        fanShaderMaterial.uniforms.uPanPower.value           = effectivePanPower;
        fanShaderMaterial.uniforms.uBeamPower.value          = effectiveBeamPower;
        fanShaderMaterial.uniforms.uBeamWidth.value          = params.beamWidth;
        fanShaderMaterial.uniforms.uGlowIntensity.value      = params.glowIntensity;
        fanShaderMaterial.uniforms.uFogDensity.value         = params.fogDensity;
        fanShaderMaterial.uniforms.uFogGlowCoupling.value    = params.fogGlowCoupling;

        impactShaderMaterial.uniforms.uImpactPower.value         = params.beamWidth > 0.001 ? effectiveBeamPower : 0.0;
        impactShaderMaterial.uniforms.uFogDensity.value          = params.fogDensity;
        impactShaderMaterial.uniforms.uImpactGlowIntensity.value = params.impactGlowIntensity;
        impactShaderMaterial.uniforms.uImpactGlowRadius.value    = params.impactGlowRadius;
        impactShaderMaterial.uniforms.uFogGlowCoupling.value     = params.fogGlowCoupling;

        panImpactShaderMaterial.uniforms.uLinePower.value           = effectivePanPower;
        panImpactShaderMaterial.uniforms.uFogDensity.value          = params.fogDensity;
        panImpactShaderMaterial.uniforms.uImpactGlowIntensity.value = params.impactGlowIntensity;
        panImpactShaderMaterial.uniforms.uImpactGlowRadius.value    = params.impactGlowRadius;
        panImpactShaderMaterial.uniforms.uFogGlowCoupling.value     = params.fogGlowCoupling;

        podGlowMaterial.uniforms.uSourceEmissionPower.value  = params.sourceEmissionPower;
        podGlowMaterial.uniforms.uSourceGlowRadius.value     = params.sourceGlowRadius;
        podGlowMaterial.uniforms.uFogDensity.value          = params.fogDensity;
        podGlowMaterial.uniforms.uFogGlowCoupling.value     = params.fogGlowCoupling;

        const computedSourceGlow = (effectiveBeamPower * 0.35 + effectivePanPower * 0.75) * 1.10;
        laserShaderMaterial.uniforms.uSourceGlowPower.value = computedSourceGlow;
        fanShaderMaterial.uniforms.uSourceGlowPower.value   = computedSourceGlow;
        podGlowMaterial.uniforms.uSourceGlowPower.value     = computedSourceGlow;

        return computedSourceGlow;
    }

    /**
     * Boucle principale de mise à jour du LaserShow appelée à chaque frame.
     * @param {number} delta Temps écoulé depuis la dernière frame (secondes)
     * @param {number} animTime Temps global de l'animation (secondes)
     */
    update(delta, animTime) {
        const nBeamsPerPod = params.spread > 0 ? Math.max(1, Math.round(params.count)) : 1;

        // Facteur de clignotement (Mode Flash pur : 50% allumé, 50% éteint)
        let strobeFactor = 1.0;
        if (params.strobe) {
            const t = animTime * params.strobeSpeed;
            const phase = t - Math.floor(t);
            strobeFactor = phase < 0.5 ? 1.0 : 0.0;
        }

        const effectiveBeamPower = params.beamPower * params.masterPower * strobeFactor;
        const effectivePanPower  = params.panPower  * params.masterPower * strobeFactor;

        const computedSourceGlow = this._updateUniforms(effectiveBeamPower, effectivePanPower, nBeamsPerPod);

        // Calcul couleur GI — sans aucune allocation
        this._baseColor.set(params.color);
        const totalLightPower = computedSourceGlow * params.sourceEmissionPower * params.giIntensity;
        const whiteTransition = clamp(computedSourceGlow * 0.35, 0.0, 1.0);
        if (params.giBounceColor) {
            this._giColor.copy(this._baseColor).lerp(this._whiteColor, whiteTransition * 0.6);
        } else {
            this._giColor.set(1, 1, 1);
        }

        // Mise à jour de la position et de l'éclat de chaque pod actif
        for (let p = 0; p < params.numPods; p++) {
            this.pods[p].updateSource(
                params.sourceDistanceOffset,
                params.giWallOffset,
                this._giColor,
                totalLightPower,
                params.giDistance,
                strobeFactor,
                params.angle
            );
        }

        let globalBeamIdx = 0;
        let globalFanSegmentIdx = 0;
        let lastA1 = 0;
        let lastA2 = 0;
        let hitPoolOffset = 0;

        // Vider les listes par pod (réutilisation des arrays)
        for (let p = 0; p < MAX_PODS; p++) {
            this._podHitPts[p].length  = 0;
            this._podHitNrms[p].length = 0;
        }

        // Boucle sur tous les boîtiers actifs
        for (let p = 0; p < params.numPods; p++) {
            const pod = this.pods[p];

            // 1. Obtenir les faisceaux du motif actif (objet réutilisé, 0 GC)
            const patternResult = this.pattern.getBeams(
                pod.origin,
                animTime,
                params,
                p,
                pod.phase
            );
            const { beams, pitch, a1, a2 } = patternResult;
            const nBeams = patternResult.nBeams;
            lastA1 = a1;
            lastA2 = a2;

            const podHitPts  = this._podHitPts[p];
            const podHitNrms = this._podHitNrms[p];
            // On réutilise le pool du pattern (angleDeg est dedans)

            // 2. Lancer les rayons vers la boîte 3D
            for (let i = 0; i < nBeams; i++) {
                const b = beams[i];
                const hitObj = this.room.getBoxHit(pod.origin, b.dir);

                // Copie dans le pool pré-alloué — fallback new uniquement si pool épuisé
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

                podHitPts.push(poolHit);
                podHitNrms.push(poolNorm);

                // Écriture du faisceau et de son halo d'impact
                this.renderer.writeBeam(globalBeamIdx, pod.origin, poolHit);
                this.renderer.writePointImpact(globalBeamIdx, pod.origin, poolHit, poolNorm, params.beamWidth);

                globalBeamIdx++;
            }

            // 3. Plan PAN volumétrique (nappe de lumière et ligne d'impact continue)
            const fanMesh = pod.fanMesh;
            if (params.laserPan && nBeamsPerPod > 1 && params.spread > 0 && effectivePanPower > 0.001) {
                fanMesh.visible = true;
                const fanPos  = fanMesh.geometry.attributes.position.array;
                const fanDist = fanMesh.geometry.attributes.aDistRatio.array;
                const fanLat  = fanMesh.geometry.attributes.aLateral.array;
                let ptr = 0, dPtr = 0, lPtr = 0;
                let fanTriCount = 0;

                const lineHalfWidth = 0.015 + 0.015 * clamp(params.beamWidth, 0.2, 3.0);

                // ── Subdivisions adaptatives ─────────────────────────────────────────
                // Mode courbe : densité basée sur la complexité visuelle de la courbe.
                //   → Cible : 48 points × fréquence sur le spread total, min 48.
                //   → Ex. : freq=1, 2 beams → 48 subs/intervalle → sinus parfait.
                //   → Ex. : freq=2, 8 beams → 14 subs/intervalle → lisse.
                // Mode horizontal : basé sur l'angle (≤5° par sous-segment).
                const spreadPerInterval = (nBeamsPerPod > 1)
                    ? Math.abs(a2 - a1) / (nBeamsPerPod - 1)
                    : 0;

                let effectiveSubs;
                const isCurved = params.patternShape !== 'Horizontal' && params.curveAmplitude > 0.001;
                if (nBeamsPerPod < 2) {
                    effectiveSubs = 1;
                } else if (isCurved) {
                    // Densité totale sur le spread : 48 × fréquence, minimum 48
                    const totalSamplesNeeded = Math.max(48, Math.ceil(48 * params.curveFrequency));
                    effectiveSubs = Math.max(1, Math.ceil(totalSamplesNeeded / (nBeamsPerPod - 1)));
                    effectiveSubs = Math.min(effectiveSubs, ARC_SUBDIVISIONS); // cap au buffer
                } else {
                    // Horizontal : ≤5° par sous-segment pour un arc parfaitement lisse
                    effectiveSubs = Math.max(1, Math.min(ARC_SUBDIVISIONS, Math.ceil(spreadPerInterval / 5)));
                }

                const emitFanTri = (h0, h1, latA, latB) => {
                    fanPos[ptr++] = pod.origin.x; fanPos[ptr++] = pod.origin.y; fanPos[ptr++] = pod.origin.z;
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

                    let arcHit0   = podHitPts[i];
                    let arcNorm0  = podHitNrms[i];
                    let arcAngle0 = angleStart;

                    for (let k = 0; k < effectiveSubs; k++) {
                        let arcHit1, arcNorm1, arcAngle1;

                        if (k === effectiveSubs - 1) {
                            arcHit1   = podHitPts[i + 1];
                            arcNorm1  = podHitNrms[i + 1];
                            arcAngle1 = angleEnd;
                        } else {
                            const t1 = (k + 1) / effectiveSubs;
                            arcAngle1 = angleStart + (angleEnd - angleStart) * t1;

                            // Slot dans le pool pour ce sous-rayon
                            let subPoolHit, subPoolNorm;
                            if (hitPoolOffset < this._poolSize) {
                                subPoolHit  = this._hitPool[hitPoolOffset];
                                subPoolNorm = this._normalPool[hitPoolOffset];
                                hitPoolOffset++;
                            } else {
                                subPoolHit  = new THREE.Vector3();
                                subPoolNorm = new THREE.Vector3();
                            }

                            // Sous-rayon avec courbe appliquée (même courbe que les faisceaux)
                            const dir1 = this.pattern.getDirectionCurved(arcAngle1, pitch, a1, a2, this.pattern._dir);
                            const hitObj1 = this.room.getBoxHit(pod.origin, dir1);
                            subPoolHit.copy(hitObj1.hit);
                            subPoolNorm.copy(hitObj1.normal);

                            arcHit1  = subPoolHit;
                            arcNorm1 = subPoolNorm;
                        }

                        // Détection de transition d'arête
                        const sameWall = arcNorm0.dot(arcNorm1) > 0.999;
                        let cornerHit = null;

                        if (!sameWall) {
                            let loAng = arcAngle0, hiAng = arcAngle1;
                            for (let iter = 0; iter < 10; iter++) {
                                const midAng = (loAng + hiAng) * 0.5;
                                const midDir = this.pattern.getDirectionCurved(midAng, pitch, a1, a2, this.pattern._dir);
                                const midNorm = this.room.getBoxHit(pod.origin, midDir).normal;
                                if (midNorm.dot(arcNorm0) > 0.999) loAng = midAng;
                                else hiAng = midAng;
                            }
                            const cornerAng = (loAng + hiAng) * 0.5;
                            const cornerDir = this.pattern.getDirectionCurved(cornerAng, pitch, a1, a2, this.pattern._dir);
                            const cHitObj = this.room.getBoxHit(pod.origin, cornerDir);

                            // Slot dans le pool pour le coin d'arête
                            let cornerSlot;
                            if (hitPoolOffset < this._poolSize) {
                                cornerSlot = this._hitPool[hitPoolOffset];
                                hitPoolOffset++;
                            } else {
                                cornerSlot = new THREE.Vector3();
                            }
                            cornerSlot.copy(cHitObj.hit);
                            cornerHit = cornerSlot;
                        }

                        // Émission triangles du plan volumétrique
                        if (sameWall) {
                            emitFanTri(arcHit0, arcHit1, 0.0, 1.0);
                        } else {
                            emitFanTri(arcHit0, cornerHit, 0.0, 0.5);
                            emitFanTri(cornerHit, arcHit1, 0.5, 1.0);
                        }

                        // Émission quads ligne d'impact continue
                        if (sameWall) {
                            if (this.renderer.writePanImpactQuad(globalFanSegmentIdx, pod.origin, arcHit0, arcNorm0, arcHit1, lineHalfWidth)) {
                                globalFanSegmentIdx++;
                            }
                        } else {
                            if (this.renderer.writePanImpactQuad(globalFanSegmentIdx, pod.origin, arcHit0, arcNorm0, cornerHit, lineHalfWidth)) {
                                globalFanSegmentIdx++;
                            }
                            if (this.renderer.writePanImpactQuad(globalFanSegmentIdx, pod.origin, cornerHit, arcNorm1, arcHit1, lineHalfWidth)) {
                                globalFanSegmentIdx++;
                            }
                        }

                        arcHit0   = arcHit1;
                        arcNorm0  = arcNorm1;
                        arcAngle0 = arcAngle1;
                    }
                }

                fanMesh.geometry.attributes.position.needsUpdate   = true;
                fanMesh.geometry.attributes.aDistRatio.needsUpdate = true;
                fanMesh.geometry.attributes.aLateral.needsUpdate   = true;
                fanMesh.geometry.setDrawRange(0, fanTriCount * 3);
            } else {
                fanMesh.visible = false;
            }
        }

        // Finalise tous les drawRanges et marqueurs GPU
        this.renderer.finalizeFrame(globalBeamIdx, globalFanSegmentIdx);

        // Mise à jour du résultat de frame (références stables)
        this._frameResult.effectiveBeamPower = effectiveBeamPower;
        this._frameResult.effectivePanPower  = effectivePanPower;
        this._frameResult.nBeamsPerPod       = nBeamsPerPod;
        this._frameResult.a1                 = lastA1;
        this._frameResult.a2                 = lastA2;
        this._frameResult.animTime           = animTime;

        return this._frameResult;
    }

    dispose() {
        for (const pod of this.pods) {
            pod.dispose();
        }
    }
}
