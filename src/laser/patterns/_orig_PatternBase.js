/**
 * PatternBase.js
 * ─────────────────────────────────────────────────────────────
 * Classe abstraite de base pour tous les motifs géométriques laser (patterns).
 * Prépare l'architecture pour les futurs motifs de la console de lumière :
 * - Balayage horizontal / vertical
 * - Cercle, ellipse, spirale
 * - Triangle, étoile, polygones
 * - Courbes de Lissajous
 * - Dessin vectoriel libre / texte
 * ─────────────────────────────────────────────────────────────
 */

export class PatternBase {
    /**
     * @param {string} name Nom lisible du motif
     * @param {string} [description] Description
     */
    constructor(name, description = '') {
        if (new.target === PatternBase) {
            throw new TypeError('Impossible d\'instancier PatternBase directement (classe abstraite).');
        }
        this.name = name;
        this.description = description;

        // Vecteur de direction partagé — toute sous-classe devrait avoir ce membre
        // pour que LaserShow puisse l'utiliser sans risque d'undefined.
        if (!this._dir) {
            this._dir = new THREE.Vector3();
        }
    }

    /**
     * Calcule et retourne la liste des faisceaux émis par un pod pour une frame donnée.
     * @param {THREE.Vector3} podOrigin Origine du boîtier laser
     * @param {number} animTime Temps écoulé (secondes)
     * @param {object} params Paramètres de configuration
     * @param {number} podIndex Index du pod
     * @param {number} podPhase Phase d'oscillation du pod
     */
    getBeams(podOrigin, animTime, params, podIndex, podPhase) {
        throw new Error('getBeams() doit être implémenté par la classe dérivée.');
    }

    /**
     * Calcule la direction normalisée d'un faisceau et l'écrit dans `out`.
     * Doit être implémentée par la classe dérivée.
     * @param {number}        angleDeg
     * @param {number}        pitch    Pitch total (radians)
     * @param {THREE.Vector3} out      Vecteur de sortie pré-alloué
     */
    getDirection(angleDeg, pitch, out) {
        // Implémentation par défaut — les classes dérivées peuvent la surcharger
        const rad = angleDeg * (Math.PI / 180);
        out.set(Math.sin(rad), Math.sin(pitch), Math.cos(rad)).normalize();
        return out;
    }

    /**
     * Variante de getDirection qui tient compte de la courbe de tracé.
     * Implémentation par défaut : identique à getDirection (pas de courbe).
     * Les sous-classes qui supportent les courbes (ex. PatternHorizontalSweep)
     * surchargent cette méthode pour appliquer le décalage de pitch par faisceau.
     *
     * @param {number}        angleDeg  Angle horizontal (degrés)
     * @param {number}        basePitch Pitch de base sans courbe (radians)
     * @param {number}        a1        Angle gauche de l'éventail (degrés)
     * @param {number}        a2        Angle droit de l'éventail (degrés)
     * @param {THREE.Vector3} out       Vecteur de sortie pré-alloué
     */
    getDirectionCurved(angleDeg, basePitch, a1, a2, out) {
        return this.getDirection(angleDeg, basePitch, out);
    }

    getName() {
        return this.name;
    }

    getDescription() {
        return this.description;
    }
}
