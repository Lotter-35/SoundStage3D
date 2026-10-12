/**
 * PatternHorizontalSweep.js
 * ─────────────────────────────────────────────────────────────
 * Motif laser : Balayage automatisé sur les 3 axes (Pitch, Yaw, Roll)
 * avec respect absolu du cône de diffusion de la fenêtre optique (aperture),
 * boîtier 3D physique 100% statique et éventail paramétrable.
 *
 * Courbes supportées (paramètre patternShape) :
 *   Horizontal   — tous les faisceaux au même pitch
 *   Sinusoïde    — forme sinusoïdale le long de l'éventail
 *   Parabolique  — arc parabolique (courbé vers le haut ou le bas)
 *   Zigzag       — dents de scie alternées
 *   Vague Double — sinusoïde à double période (deux bosses)
 * ─────────────────────────────────────────────────────────────
 * OPTIMISÉ : 0 allocation par frame — pool de vecteurs pré-alloués.
 */

import * as THREE from 'three';

import { PatternBase } from './PatternBase.js';
import { MAX_BEAMS_PER_POD } from '../config/laserConstants.js';

const _PI_OVER_180 = Math.PI / 180;
const _TWO_PI      = Math.PI * 2;

// Limites de déviation angulaire de la visée interne (buse / galvos)
// Empêche le faisceau de pointer vers l'arrière du boîtier (reste orienté vers l'avant)
const MAX_AIM_YAW   = 65.0; // Angle max de visée gauche/droite (°)
const MAX_AIM_PITCH = 65.0; // Angle max de visée haut/bas (°)

export class PatternHorizontalSweep extends PatternBase {
    constructor() {
        super(
            'Balayage Horizontal',
            'Éventail horizontal de faisceaux avec balayage 3 axes fluide et visée directe'
        );

        // ── Vecteur de direction et repère de rotation réutilisables (0 GC) ──
        this._dir       = new THREE.Vector3();
        this._rotEuler  = new THREE.Euler(0, 0, 0, 'YXZ');
        this._rotQuat   = new THREE.Quaternion();
        this._localDir  = new THREE.Vector3();
        this._basePitch = 0;

        // ── Pool de structures de faisceaux pré-alloués ───────────────────────
        this._beamPool = [];
        for (let i = 0; i < MAX_BEAMS_PER_POD; i++) {
            this._beamPool.push({ dir: new THREE.Vector3(), angleDeg: 0 });
        }
        this._beamResult = {
            beams:        this._beamPool,
            pitch:        0,
            nBeams:       0,
            a1:           0,
            a2:           0,
            centerAngle:  0,
            housingAngle: 0,
            housingTilt:  0,
            housingRoll:  0,
        };
    }

    /**
     * Pitch de base oscillant du faisceau (inclinaison + déviation + oscillation balayage).
     */
    getPitch(sweepTime, podPhase = 0) {
        const p = this._params;
        const pitchTime = (typeof sweepTime === 'object' && sweepTime !== null) ? (sweepTime.pitch || 0) : (typeof sweepTime === 'number' ? sweepTime : 0);
        const pitchSweepAmp = p && p.pitchSweepAmp !== undefined ? p.pitchSweepAmp : 15.0;
        const pitchSweep = pitchSweepAmp > 0.001 ? Math.sin(pitchTime + podPhase) * pitchSweepAmp : 0.0;
        const reqPitchDev = (p && p.beamPitchOffset !== undefined ? p.beamPitchOffset : 0) + pitchSweep;
        const totalPitchDev = Math.max(-MAX_AIM_PITCH, Math.min(MAX_AIM_PITCH, reqPitchDev));
        return ((p && p.tilt !== undefined ? p.tilt : 0) + totalPitchDev) * _PI_OVER_180;
    }

    /**
     * Calcule le décalage vertical de courbe pour un faisceau à une position
     * normalisée t ∈ [0, 1] dans l'éventail.
     *
     * @param {number} t  Position normalisée [0, 1] dans le spread
     * @returns {number}  Décalage de pitch en radians
     */
    _curveOffset(t) {
        const amp = this._params.curveAmplitude;
        if (amp < 0.001) return 0;

        const freq = this._params.curveFrequency;
        let raw = 0;

        switch (this._params.patternShape) {
            case 'Sinusoïde':
                raw = amp * Math.sin(t * freq * _TWO_PI);
                break;

            case 'Parabolique':
                raw = amp * (1 - (2 * t - 1) * (2 * t - 1));
                break;

            case 'Zigzag': {
                const cycle = (t * freq * 2) % 2;
                const tri   = cycle < 1 ? cycle : 2 - cycle;
                raw = amp * (tri * 2 - 1);
                break;
            }

            case 'Vague Double':
                raw = amp * (
                    Math.sin(t * freq * _TWO_PI) * 0.6 +
                    Math.sin(t * freq * _TWO_PI * 2 + Math.PI * 0.5) * 0.4
                );
                break;

            case 'Horizontal':
            default:
                return 0;
        }

        const maxCurveRad = MAX_AIM_PITCH * 0.5 * _PI_OVER_180;
        return Math.max(-maxCurveRad, Math.min(maxCurveRad, raw));
    }

    /**
     * Calcule le pitch complet (base + courbe) pour un angle donné dans l'éventail.
     */
    getCurvedPitch(angleDeg, a1, a2, basePitch) {
        const spread = a2 - a1;
        if (spread < 0.001 || this._params.patternShape === 'Horizontal') return basePitch;
        const t = (angleDeg - a1) / spread;
        return basePitch + this._curveOffset(t);
    }

    /**
     * Calcule la direction normalisée d'un faisceau dans l'espace monde en intégrant le Roll.
     */
    getDirection(angleDeg, pitch, out) {
        const centerAngle = this._currentCenterAngle !== undefined ? this._currentCenterAngle : ((this._params && this._params.angle !== undefined) ? this._params.angle : 0);
        const relAngleRad = (angleDeg - centerAngle) * _PI_OVER_180;
        const curveOffset = (this._params && pitch !== undefined) ? (pitch - this._basePitch) : 0;

        this._localDir.set(Math.sin(relAngleRad), Math.sin(curveOffset), Math.cos(relAngleRad)).normalize();
        out.copy(this._localDir).applyQuaternion(this._rotQuat);
        return out;
    }

    /**
     * Calcule la direction avec courbe intégrée (pour les sous-rayons du plan PAN).
     */
    getDirectionCurved(angleDeg, basePitch, a1, a2, out) {
        const pitch = this.getCurvedPitch(angleDeg, a1, a2, basePitch);
        return this.getDirection(angleDeg, pitch, out);
    }

    /**
     * Normale du plan de l'éventail et direction centrale (espace monde) pour la frame courante.
     * Pour le motif 'Horizontal', tous les rayons sont exactement contenus dans ce plan.
     */
    getFanFrame(outNormal, outForward) {
        outNormal.set(0, 1, 0).applyQuaternion(this._rotQuat);
        outForward.set(0, 0, 1).applyQuaternion(this._rotQuat);
    }

    /**
     * Calcule tous les faisceaux du pod pour la frame courante selon le modèle de visée laser.
     * @param {THREE.Vector3} podOrigin
     * @param {object|number} animTimes Horloges de balayage { pitch, yaw, roll }
     * @param {object} params_arg Paramètres du laser
     * @param {number} podIndex
     * @param {number} podPhase
     */
    getBeams(podOrigin, animTimes, params_arg, podIndex, podPhase) {
        this._params = params_arg;
        const p = params_arg;

        const pitchTime = (animTimes && typeof animTimes.pitch === 'number') ? animTimes.pitch : (typeof animTimes === 'number' ? animTimes : 0);
        const yawTime   = (animTimes && typeof animTimes.yaw === 'number') ? animTimes.yaw : pitchTime;
        const rollTime  = (animTimes && typeof animTimes.roll === 'number') ? animTimes.roll : pitchTime;

        // ── 1. AXE GAUCHE / DROITE (Visée horizontale du faisceau) ──
        // Le balayage oscille sans à-coups ni pause plate autour du point de visée.
        const yawSweepAmp = p.yawSweepAmp !== undefined ? p.yawSweepAmp : (p.horizontalSweepAmp || 0.0);
        const yawSweep = yawSweepAmp > 0.001 ? Math.cos(yawTime + podPhase) * yawSweepAmp : 0.0;
        const reqYawDev = (p.beamYawOffset || 0) + yawSweep;

        // Limite de sécurité pour ne pas viser l'arrière du boîtier
        const totalYawDev = Math.max(-MAX_AIM_YAW, Math.min(MAX_AIM_YAW, reqYawDev));
        const centerAngle = (p.angle || 0) + totalYawDev;
        this._currentCenterAngle = centerAngle;

        // ── 2. AXE HAUT / BAS (Visée verticale du faisceau) ──
        const pitchSweepAmp = p.pitchSweepAmp !== undefined ? p.pitchSweepAmp : 15.0;
        const pitchSweep = pitchSweepAmp > 0.001 ? Math.sin(pitchTime + podPhase) * pitchSweepAmp : 0.0;
        const reqPitchDev = (p.beamPitchOffset || 0) + pitchSweep;
        const totalPitchDev = Math.max(-MAX_AIM_PITCH, Math.min(MAX_AIM_PITCH, reqPitchDev));
        const pitch = ((p.tilt || 0) + totalPitchDev) * _PI_OVER_180;
        this._basePitch = pitch;

        // ── 3. AXE ROTATION DU PLAN (Roulis / Roll autour du faisceau) ──
        const rollSweepAmp = p.rollSweepAmp !== undefined ? p.rollSweepAmp : 0.0;
        const isRollFull360 = (rollSweepAmp >= 359.5) || Boolean(p.rollContinuous);

        let rollSweep = 0;
        if (isRollFull360) {
            // À 360° (ou rotation continue), tourne à vitesse constante sans jamais faire demi-tour
            rollSweep = (rollTime * 90.0) % 360;
        } else if (rollSweepAmp > 0.001) {
            // Allers-retours à vitesse angulaire constante avec l'amplitude demandée
            rollSweep = Math.sin(rollTime + podPhase) * rollSweepAmp;
        }
        const reqRollDev = (p.beamRollOffset || 0) + rollSweep;
        const rollRad = ((p.roll || 0) + reqRollDev) * _PI_OVER_180;

        // ── 4. ORIENTATION CENTRALE DU FAISCEAU DANS L'ESPACE ──
        this._rotEuler.set(-pitch, centerAngle * _PI_OVER_180, rollRad, 'YXZ');
        this._rotQuat.setFromEuler(this._rotEuler);

        // ── 5. CALCUL DES FAISCEAUX DE L'ÉVENTAIL (RÉTRÉCIT PARFAITEMENT PAR LE CENTRE) ──
        const halfSpread = Math.max(0, (p.spread !== undefined ? p.spread : 50) * 0.5);
        const nBeams = (p.spread > 0 && halfSpread > 0.001) ? Math.max(1, Math.round(p.count)) : 1;
        const a1 = centerAngle - halfSpread;
        const a2 = centerAngle + halfSpread;
        const invNm1 = nBeams > 1 ? 1.0 / (nBeams - 1) : 0;

        // Pool de faisceaux extensible (centaines de traits par émetteur)
        while (this._beamPool.length < nBeams) {
            this._beamPool.push({ dir: new THREE.Vector3(), angleDeg: 0 });
        }

        for (let i = 0; i < nBeams; i++) {
            const b = this._beamPool[i];
            b.angleDeg = (nBeams === 1) ? centerAngle : a1 + (a2 - a1) * (i * invNm1);
            const curved = this.getCurvedPitch(b.angleDeg, a1, a2, pitch);
            this.getDirection(b.angleDeg, curved, b.dir);
        }

        this._beamResult.nBeams = nBeams;
        this._beamResult.pitch = pitch;
        this._beamResult.a1 = a1;
        this._beamResult.a2 = a2;
        this._beamResult.centerAngle = centerAngle;

        // ── 6. ORIENTATION DU BOÎTIER 3D (RESTE 100% STATIQUE FACE AUX BALAYAGES ET DÉVIATIONS INTERNES) ──
        // Le boîtier physique ne bouge QUE si la position & orientation globale du laser est changée
        this._beamResult.housingAngle = p.angle || 0;
        this._beamResult.housingTilt = p.tilt || 0;
        this._beamResult.housingRoll = p.roll || 0;

        return this._beamResult;
    }
}
