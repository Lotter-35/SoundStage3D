/**
 * PatternHorizontalSweep.js
 * ─────────────────────────────────────────────────────────────
 * Motif laser : Balayage horizontal avec éventail (spread) et
 * oscillation verticale douce (pitch).
 *
 * Courbes supportées (paramètre patternShape) :
 *   Horizontal   — tous les faisceaux au même pitch (comportement d'origine)
 *   Sinusoïde    — forme sinusoïdale le long de l'éventail
 *   Parabolique  — arc parabolique (courbé vers le haut ou le bas)
 *   Zigzag       — dents de scie alternées
 *   Vague Double — sinusoïde à double période (deux bosses)
 * ─────────────────────────────────────────────────────────────
 * OPTIMISÉ : 0 allocation par frame — pool de vecteurs pré-alloués.
 */

import { PatternBase } from './PatternBase.js';
import { MAX_BEAMS_PER_POD } from '../../config/constants.js';
import { params } from '../../config/params.js';

const _PI_OVER_180 = Math.PI / 180;
const _TWO_PI      = Math.PI * 2;

export class PatternHorizontalSweep extends PatternBase {
    constructor() {
        super(
            'Balayage Horizontal',
            'Éventail horizontal de faisceaux avec courbe verticale paramétrable'
        );

        // ── Vecteur de direction réutilisable (0 GC) ──────────────────────────
        this._dir = new THREE.Vector3();

        // ── Pool de structures de faisceaux pré-alloués ───────────────────────
        this._beamPool = [];
        for (let i = 0; i < MAX_BEAMS_PER_POD; i++) {
            this._beamPool.push({ dir: new THREE.Vector3(), angleDeg: 0 });
        }
        this._beamResult = {
            beams:    this._beamPool,
            pitch:    0,
            nBeams:   0,
            a1:       0,
            a2:       0
        };
    }

    /**
     * Pitch de base oscillant du pod (animation globale).
     */
    getPitch(animTime, podPhase) {
        return Math.sin(animTime * 0.8 + podPhase) * 0.25;
    }

    /**
     * Calcule le décalage vertical de courbe pour un faisceau à une position
     * normalisée t ∈ [0, 1] dans l'éventail.
     *
     * @param {number} t  Position normalisée [0, 1] dans le spread
     * @returns {number}  Décalage de pitch en radians
     */
    _curveOffset(t) {
        const amp  = params.curveAmplitude;
        if (amp < 0.001) return 0;

        const freq = params.curveFrequency;

        switch (params.patternShape) {
            case 'Sinusoïde':
                // Onde sinusoïdale complète sur le spread
                return amp * Math.sin(t * freq * _TWO_PI);

            case 'Parabolique':
                // Arc parabolique : 0 aux extrémités, max au centre
                // Forme : 1 - (2t - 1)^2  → pic au centre, 0 aux bords
                return amp * (1 - (2 * t - 1) * (2 * t - 1));

            case 'Zigzag': {
                // Dents de scie : triangle wave normalisé
                // zigzag period = 1/freq sur l'axe t
                const cycle = (t * freq * 2) % 2;          // 0→2 en boucle
                const tri   = cycle < 1 ? cycle : 2 - cycle; // triangle 0→1→0
                return amp * (tri * 2 - 1);                  // centré en 0
            }

            case 'Vague Double':
                // Double sinusoïde — deux bosses complètes + phase décalée
                return amp * (
                    Math.sin(t * freq * _TWO_PI) * 0.6 +
                    Math.sin(t * freq * _TWO_PI * 2 + Math.PI * 0.5) * 0.4
                );

            case 'Horizontal':
            default:
                return 0;
        }
    }

    /**
     * Calcule le pitch complet (base + courbe) pour un angle donné dans l'éventail.
     *
     * @param {number} angleDeg Angle horizontal du faisceau (degrés)
     * @param {number} a1       Angle du faisceau le plus à gauche (degrés)
     * @param {number} a2       Angle du faisceau le plus à droite (degrés)
     * @param {number} basePitch Pitch de base (oscillation globale du pod)
     * @returns {number} Pitch total en radians
     */
    getCurvedPitch(angleDeg, a1, a2, basePitch) {
        const spread = a2 - a1;
        if (spread < 0.001 || params.patternShape === 'Horizontal') return basePitch;
        const t = (angleDeg - a1) / spread; // normalisation [0, 1]
        return basePitch + this._curveOffset(t);
    }

    /**
     * Calcule la direction normalisée d'un faisceau et l'écrit dans `out`.
     * Compatible avec l'appel direct depuis LaserShow (sub-rayons PAN).
     *
     * @param {number}         angleDeg Angle horizontal (degrés)
     * @param {number}         pitch    Pitch TOTAL (base + courbe déjà calculée)
     * @param {THREE.Vector3}  out      Vecteur de sortie pré-alloué
     */
    getDirection(angleDeg, pitch, out) {
        const rad  = angleDeg * _PI_OVER_180;
        const sinP = Math.sin(pitch);
        out.set(Math.sin(rad), sinP, Math.cos(rad)).normalize();
        return out;
    }

    /**
     * Calcule la direction avec courbe intégrée (pour les sous-rayons du plan PAN).
     * Remplace l'appel nu `getDirection(angleDeg, basePitch, out)` quand a1/a2 sont connus.
     *
     * @param {number}         angleDeg  Angle horizontal (degrés)
     * @param {number}         basePitch Pitch de base (oscillation pod)
     * @param {number}         a1        Angle gauche de l'éventail (degrés)
     * @param {number}         a2        Angle droit de l'éventail (degrés)
     * @param {THREE.Vector3}  out       Vecteur de sortie pré-alloué
     */
    getDirectionCurved(angleDeg, basePitch, a1, a2, out) {
        const pitch = this.getCurvedPitch(angleDeg, a1, a2, basePitch);
        return this.getDirection(angleDeg, pitch, out);
    }

    /**
     * Calcule tous les faisceaux du pod pour la frame courante.
     * Retourne un objet réutilisé — NE PAS stocker entre frames.
     */
    getBeams(podOrigin, animTime, params_arg, podIndex, podPhase) {
        const nBeams  = params_arg.spread > 0 ? Math.max(1, Math.round(params_arg.count)) : 1;
        const a1      = params_arg.angle - params_arg.spread * 0.5;
        const a2      = params_arg.angle + params_arg.spread * 0.5;
        const pitch   = this.getPitch(animTime, podPhase);
        const invNm1  = nBeams > 1 ? 1.0 / (nBeams - 1) : 0;

        for (let i = 0; i < nBeams; i++) {
            const b       = this._beamPool[i];
            b.angleDeg    = (nBeams === 1) ? params_arg.angle : a1 + (a2 - a1) * (i * invNm1);
            // Pitch total = base + déformation courbe propre à ce faisceau
            const curved  = this.getCurvedPitch(b.angleDeg, a1, a2, pitch);
            this.getDirection(b.angleDeg, curved, b.dir);
        }

        this._beamResult.nBeams = nBeams;
        this._beamResult.pitch  = pitch;   // pitch DE BASE (sans courbe) pour les sous-rayons
        this._beamResult.a1     = a1;
        this._beamResult.a2     = a2;
        return this._beamResult;
    }
}
