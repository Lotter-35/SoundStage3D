/**
 * DazzleEffect.js (adapté pour SoundStage3D)
 * ─────────────────────────────────────────────────────────────
 * Système d'éblouissement laser physiologique ultra-optimisé.
 *
 * Porté depuis le projet de référence LaserSimulation
 * (https://github.com/Lotter-35/LaserSimulation)
 *
 * Adaptations pour SoundStage3D :
 * - Pas de singleton `params` global → reçoit les données laser par appel
 * - Fonctionne avec N LaserShow indépendants (multi-laser)
 * - postProcessing = référence au LaserManager (bloomPass + chromaPass)
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { BEAM_DIVERGENCE, clamp } from '../config/laserConstants.js';

export class DazzleEffect {
    /**
     * @param {THREE.Camera} camera
     * @param {object} postProcessing — objet avec bloomPass et chromaPass (le LaserManager)
     * @param {object} baseParams — { bloomStrength, chroma } valeurs de repos
     */
    constructor(camera, postProcessing, baseParams) {
        this.camera = camera;
        this.postProcessing = postProcessing;
        this.baseParams = baseParams;

        this.dazzleOverlay     = document.getElementById('dazzle-overlay');
        this.afterimageOverlay = document.getElementById('afterimage-overlay');

        // État interne lissé de l'éblouissement
        this.dazzleFlash      = 0;
        this.dazzleAfterburn  = 0;
        this.dazzleAfterHue   = new THREE.Color(0x0055ff);
        this.chromaBoost      = 0;
        this.dazzleScreenX    = 50;
        this.dazzleScreenY    = 50;
        this.sourceVisibility = 0; // Facteur continu [0, 1]

        this._lastColorHex     = '';
        this._hasOverlayActive = false;

        // Constantes d'amortissement physiologique (valeurs du projet de référence)
        this.FLASH_DECAY     = 3.8;
        this.AFTERBURN_DECAY = 0.5;
        this.CHROMA_DECAY    = 2.8;
        this.PUPIL_RADIUS    = 0.18;
        this.BEAM_HALF_WIDTH = 0.12;

        // Pool de vecteurs pré-alloués (0 allocation garbage collector par frame)
        this._segAB       = new THREE.Vector3();
        this._segAC       = new THREE.Vector3();
        this._closest     = new THREE.Vector3();
        this._camFwd      = new THREE.Vector3();
        this._dirToPod    = new THREE.Vector3();
        this._dirToSource = new THREE.Vector3();
        this._edgeAB      = new THREE.Vector3();
        this._edgeAC      = new THREE.Vector3();
        this._planNormal  = new THREE.Vector3();
        this._eyeToOrigin = new THREE.Vector3();
        this._projected   = new THREE.Vector3();
        this._bestOrigin  = new THREE.Vector3();
        this._centerDir   = new THREE.Vector3();
    }

    /**
     * Distance au carré minimale entre le point P et le segment [A, B].
     */
    distPointToSegmentSq(P, A, B) {
        this._segAB.subVectors(B, A);
        this._segAC.subVectors(P, A);
        const lenSq = this._segAB.lengthSq();
        if (lenSq < 1e-8) return P.distanceToSquared(A);
        const t = clamp(this._segAC.dot(this._segAB) / lenSq, 0, 1);
        this._closest.copy(A).addScaledVector(this._segAB, t);
        return P.distanceToSquared(this._closest);
    }

    /**
     * Mise à jour haute performance appelée à chaque frame.
     *
     * @param {number} delta  — temps écoulé (secondes)
     * @param {Array<{pod, hitPts, params, effectiveBeamPower, effectivePanPower}>} laserData
     *   Tableau de données par laser actif, fourni par LaserManager
     */
    update(delta, laserData) {
        const eyePos = this.camera.position;
        this.camera.getWorldDirection(this._camFwd);

        // Déclin passif si tous les lasers sont éteints
        let anyActive = false;
        for (const ld of laserData) {
            if (ld.effectiveBeamPower > 0.005 || ld.effectivePanPower > 0.005) {
                anyActive = true;
                break;
            }
        }

        if (!anyActive) {
            this.dazzleFlash      = Math.max(0, this.dazzleFlash      - this.FLASH_DECAY * delta);
            this.dazzleAfterburn  = Math.max(0, this.dazzleAfterburn  - this.AFTERBURN_DECAY * delta);
            this.chromaBoost      = Math.max(0, this.chromaBoost      - this.CHROMA_DECAY * delta);
            this.sourceVisibility = Math.max(0, this.sourceVisibility - 6.0 * delta);
            this._applyToScreen();
            return;
        }

        let globalMaxStrength = 0;
        let hasDazzlingPod = false;
        let bestColor = '#0055ff';

        // ── Analyse par laser actif ──────────────────────────────────────────
        for (const ld of laserData) {
            const { pod, hitPts, params, effectiveBeamPower, effectivePanPower } = ld;
            if (!hitPts || hitPts.length === 0) continue;

            let podHitStrength = 0;
            let podFanStrength = 0;

            // Direction caméra -> source
            this._dirToSource.subVectors(pod.origin, eyePos);
            const distToPod = this._dirToSource.length();
            if (distToPod < 0.01) continue;

            this._dirToSource.multiplyScalar(1.0 / distToPod);
            const gazeDotSource = this._camFwd.dot(this._dirToSource);

            // 1. FAISCEAUX DIRECTS (traversée pupille)
            if (effectiveBeamPower > 0.005) {
                const beamDivAtEye = 1.0 + (distToPod * 0.008) * BEAM_DIVERGENCE;
                const effectiveBeamWidth = this.BEAM_HALF_WIDTH * (0.5 + 0.5 * (params.beamWidth || 1.0)) * beamDivAtEye;
                const threshold = this.PUPIL_RADIUS + effectiveBeamWidth;
                const thresholdSq = threshold * threshold;

                const lookFactor = clamp(gazeDotSource * 0.7 + 0.3, 0.1, 1.0);

                for (let i = 0; i < hitPts.length; i++) {
                    const distSq = this.distPointToSegmentSq(eyePos, pod.origin, hitPts[i]);
                    if (distSq < thresholdSq) {
                        const dist = Math.sqrt(distSq);
                        const proximity = clamp(1.0 - dist / threshold, 0, 1);
                        const s = proximity * proximity * effectiveBeamPower * lookFactor;
                        if (s > podHitStrength) podHitStrength = s;
                    }
                }
            }

            // 2. FEUILLE PAN VOLUMÉTRIQUE
            if (effectivePanPower > 0.005 && params.laserPan && hitPts.length > 1 && params.spread > 0) {
                const FAN_PLANE_HALF_THICKNESS = 0.50;
                const FAN_POWER_SCALE = 0.38;

                if (gazeDotSource > 0.01) {
                    const firstPt = hitPts[0];
                    const lastPt  = hitPts[hitPts.length - 1];

                    this._edgeAB.subVectors(firstPt, pod.origin);
                    this._edgeAC.subVectors(lastPt, pod.origin);
                    this._planNormal.crossVectors(this._edgeAB, this._edgeAC);
                    const planLenSq = this._planNormal.lengthSq();

                    if (planLenSq > 1e-6) {
                        this._planNormal.multiplyScalar(1.0 / Math.sqrt(planLenSq));
                        this._eyeToOrigin.subVectors(eyePos, pod.origin);
                        const signedDist = Math.abs(this._eyeToOrigin.dot(this._planNormal));

                        if (signedDist <= FAN_PLANE_HALF_THICKNESS) {
                            const distEyeToPod = this._eyeToOrigin.length();
                            if (distEyeToPod > 0.1) {
                                this._dirToPod.copy(this._eyeToOrigin).multiplyScalar(1.0 / distEyeToPod);
                                this._centerDir.addVectors(this._edgeAB, this._edgeAC).normalize();
                                const cosAngle = this._dirToPod.dot(this._centerDir);

                                const halfSpreadRad = ((params.spread * 0.5) + 6.0) * (Math.PI / 180);
                                const minCos = Math.cos(halfSpreadRad);

                                if (cosAngle >= minCos) {
                                    const maxReach = Math.max(firstPt.distanceTo(pod.origin), lastPt.distanceTo(pod.origin)) + 0.5;
                                    if (distEyeToPod <= maxReach) {
                                        const planStrength = clamp(1.0 - signedDist / FAN_PLANE_HALF_THICKNESS, 0, 1);
                                        const s = planStrength * planStrength * effectivePanPower * FAN_POWER_SCALE * clamp(gazeDotSource * 1.2, 0, 1);
                                        if (s > podFanStrength) podFanStrength = s;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            const podTotalStrength = clamp(podHitStrength + podFanStrength * 0.6, 0, 1);

            if (podTotalStrength > globalMaxStrength) {
                globalMaxStrength = podTotalStrength;
                this._bestOrigin.copy(pod.origin);
                hasDazzlingPod = true;
                bestColor = params.color || '#0055ff';
            }
        }

        // ── Calcul de projection écran & Visibilité lissée ──────────────────────
        let targetScreenX = this.dazzleScreenX;
        let targetScreenY = this.dazzleScreenY;
        let targetVisibility = 0;

        if (globalMaxStrength > 0.005 && hasDazzlingPod) {
            this._dirToSource.subVectors(this._bestOrigin, eyePos);
            const dotFwd = this._dirToSource.dot(this._camFwd);

            if (dotFwd > 0.05) {
                this._projected.copy(this._bestOrigin).project(this.camera);

                const px = this._projected.x;
                const py = this._projected.y;

                if (px >= -1.4 && px <= 1.4 && py >= -1.4 && py <= 1.4) {
                    targetScreenX = clamp((px *  0.5 + 0.5) * 100, 0, 100);
                    targetScreenY = clamp((-py * 0.5 + 0.5) * 100, 0, 100);

                    const edgeDist = Math.max(Math.abs(px), Math.abs(py));
                    const edgeFade = clamp((1.4 - edgeDist) / 0.45, 0, 1);
                    const facingFade = clamp(dotFwd * 1.6, 0, 1);

                    targetVisibility = edgeFade * facingFade;
                }
            }
        }

        // Lissage temporel
        const visSpeed = targetVisibility > this.sourceVisibility ? 18.0 : 7.0;
        this.sourceVisibility += (targetVisibility - this.sourceVisibility) * Math.min(1.0, visSpeed * delta);

        if (targetVisibility > 0.02) {
            const posLerp = Math.min(1.0, 20.0 * delta);
            this.dazzleScreenX += (targetScreenX - this.dazzleScreenX) * posLerp;
            this.dazzleScreenY += (targetScreenY - this.dazzleScreenY) * posLerp;
        }

        // Flash et persistance rétinienne
        if (globalMaxStrength > this.dazzleFlash) {
            const attack = Math.min(1.0, 20.0 * delta);
            this.dazzleFlash += (globalMaxStrength - this.dazzleFlash) * attack;

            const newAfterburn = globalMaxStrength * 0.85;
            if (newAfterburn > this.dazzleAfterburn) {
                this.dazzleAfterburn = newAfterburn;
                this.dazzleAfterHue.set(bestColor);
            }
            this.chromaBoost = Math.max(this.chromaBoost, globalMaxStrength * 1.1);
        } else {
            this.dazzleFlash = Math.max(0, this.dazzleFlash - this.FLASH_DECAY * delta);
        }

        this.dazzleAfterburn = Math.max(0, this.dazzleAfterburn - this.AFTERBURN_DECAY * delta);
        this.chromaBoost     = Math.max(0, this.chromaBoost     - this.CHROMA_DECAY * delta);

        this._applyToScreen();
    }

    /**
     * Application fluide sur l'écran via les variables CSS et uniforms Three.js.
     */
    _applyToScreen() {
        if (!this.dazzleOverlay || !this.afterimageOverlay) return;

        const flashOpacity = clamp(this.dazzleFlash * this.sourceVisibility, 0, 1);
        const afterOpacity = clamp(this.dazzleAfterburn * 0.7, 0, 0.8);

        const sxStr = `${this.dazzleScreenX.toFixed(1)}%`;
        const syStr = `${this.dazzleScreenY.toFixed(1)}%`;

        // 1. Overlay Flash
        if (flashOpacity < 0.003) {
            if (this.dazzleOverlay.style.display !== 'none') {
                this.dazzleOverlay.style.display = 'none';
                this.dazzleOverlay.style.opacity = '0';
            }
        } else {
            if (this.dazzleOverlay.style.display !== 'block') {
                this.dazzleOverlay.style.display = 'block';
            }
            this.dazzleOverlay.style.opacity = flashOpacity.toFixed(3);
            this.dazzleOverlay.style.setProperty('--dazzle-x', sxStr);
            this.dazzleOverlay.style.setProperty('--dazzle-y', syStr);
        }

        // 2. Traînée rétinienne (phosphène persistant)
        if (afterOpacity < 0.003) {
            if (this.afterimageOverlay.style.display !== 'none') {
                this.afterimageOverlay.style.display = 'none';
                this.afterimageOverlay.style.opacity = '0';
            }
        } else {
            if (this.afterimageOverlay.style.display !== 'block') {
                this.afterimageOverlay.style.display = 'block';
            }
            this.afterimageOverlay.style.opacity = afterOpacity.toFixed(3);
            this.afterimageOverlay.style.setProperty('--dazzle-x', sxStr);
            this.afterimageOverlay.style.setProperty('--dazzle-y', syStr);

            if (this._lastColorHex !== this.dazzleAfterHue.getHexString()) {
                this._lastColorHex = this.dazzleAfterHue.getHexString();
                const r = Math.round(this.dazzleAfterHue.r * 255);
                const g = Math.round(this.dazzleAfterHue.g * 255);
                const b = Math.round(this.dazzleAfterHue.b * 255);
                this.afterimageOverlay.style.setProperty('--after-c1', `rgba(${r},${g},${b},0.80)`);
                this.afterimageOverlay.style.setProperty('--after-c2', `rgba(${r},${g},${b},0.45)`);
                this.afterimageOverlay.style.setProperty('--after-c3', `rgba(${r},${g},${b},0.15)`);
            }
        }

        // 3. Post-processing Bloom & Chroma (lissé en continu)
        if (this.postProcessing) {
            const baseBloom  = this.baseParams.bloomStrength;
            const baseChroma = this.baseParams.chroma;

            const targetBloom  = baseBloom  + (this.dazzleFlash * this.sourceVisibility) * 1.5;
            const targetChroma = baseChroma + this.chromaBoost * 2.0;

            if (this.postProcessing._bloomPass) {
                this.postProcessing._bloomPass.strength = targetBloom;
            }
            if (this.postProcessing._chromaPass) {
                this.postProcessing._chromaPass.uniforms.uChroma.value = targetChroma;
            }
        }

        this._hasOverlayActive = (flashOpacity >= 0.003 || afterOpacity >= 0.003);
    }

    /**
     * Réinitialise instantanément tous les effets d'éblouissement.
     */
    reset() {
        this.dazzleFlash      = 0;
        this.dazzleAfterburn  = 0;
        this.chromaBoost      = 0;
        this.sourceVisibility = 0;

        if (this._hasOverlayActive) {
            if (this.dazzleOverlay) {
                this.dazzleOverlay.style.display  = 'none';
                this.dazzleOverlay.style.opacity  = '0';
            }
            if (this.afterimageOverlay) {
                this.afterimageOverlay.style.display = 'none';
                this.afterimageOverlay.style.opacity = '0';
            }
            if (this.postProcessing) {
                if (this.postProcessing._bloomPass)
                    this.postProcessing._bloomPass.strength = this.baseParams.bloomStrength;
                if (this.postProcessing._chromaPass)
                    this.postProcessing._chromaPass.uniforms.uChroma.value = this.baseParams.chroma;
            }
            this._hasOverlayActive = false;
        }
    }
}
