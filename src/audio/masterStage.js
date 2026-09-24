/**
 * MasterStage — Étage de sortie final (MASTER OUT Stage).
 * Chaîne de traitement audio conforme aux spécifications :
 *
 * Étape 1 : Sommation & EQ Global du Festival (Master Equalizer 4 bandes paramétriques)
 * Étape 2 : Compresseur de Master / Bus ("Glue Compressor" avec bypass & make-up gain)
 * [Point d'insertion de la réverbération acoustique environnementale]
 * Étape 3 : Limiteur de Sortie Final (True Peak Brickwall Limiter avec seuil réglable & bypass)
 */

export class MasterStage {
    /**
     * @param {AudioContext} ctx
     * @param {object} [options]
     */
    constructor(ctx, options = {}) {
        this.ctx = ctx;

        // Entrée principale (sommation de toutes les enceintes 3D)
        this.input = ctx.createGain();
        this.input.gain.value = 1.0;

        // ─── Étape 1 : EQ Global du Festival (4 bandes paramétriques) ───
        // Bande 1 : Graves (Low Shelf à 80 Hz)
        this.eqLow = ctx.createBiquadFilter();
        this.eqLow.type = 'lowshelf';
        this.eqLow.frequency.value = 80;
        this.eqLow.gain.value = options['eq-low'] ?? 0;

        // Bande 2 : Bas-Médiums (Peaking à 400 Hz)
        this.eqMidLow = ctx.createBiquadFilter();
        this.eqMidLow.type = 'peaking';
        this.eqMidLow.frequency.value = 400;
        this.eqMidLow.Q.value = 1.0;
        this.eqMidLow.gain.value = options['eq-mid-low'] ?? 0;

        // Bande 3 : Haut-Médiums (Peaking à 2500 Hz)
        this.eqMidHigh = ctx.createBiquadFilter();
        this.eqMidHigh.type = 'peaking';
        this.eqMidHigh.frequency.value = 2500;
        this.eqMidHigh.Q.value = 1.0;
        this.eqMidHigh.gain.value = options['eq-mid-high'] ?? 0;

        // Bande 4 : Aigus (High Shelf à 10000 Hz)
        this.eqHigh = ctx.createBiquadFilter();
        this.eqHigh.type = 'highshelf';
        this.eqHigh.frequency.value = 10000;
        this.eqHigh.gain.value = options['eq-high'] ?? 0;

        // Chaînage de l'EQ
        this.input.connect(this.eqLow);
        this.eqLow.connect(this.eqMidLow);
        this.eqMidLow.connect(this.eqMidHigh);
        this.eqMidHigh.connect(this.eqHigh);

        // ─── Étape 2 : Compresseur de Master / Bus ("Glue Compressor") ───
        this.compNode = ctx.createDynamicsCompressor();
        this.compNode.threshold.value = options['comp-threshold'] ?? -12;
        this.compNode.ratio.value     = options['comp-ratio'] ?? 2.0;
        this.compNode.attack.value    = (options['comp-attack'] ?? 30) / 1000;
        this.compNode.release.value   = (options['comp-release'] ?? 100) / 1000;
        this.compNode.knee.value      = 6.0;

        this.compMakeup = ctx.createGain();
        const makeupDb = options['comp-makeup'] ?? 0;
        this.compMakeup.gain.value = Math.pow(10, makeupDb / 20);

        this.compWet = ctx.createGain();
        this.compDry = ctx.createGain();
        this._compEnabled = options['comp-enabled'] ?? false;
        this.compWet.gain.value = this._compEnabled ? 1.0 : 0.0;
        this.compDry.gain.value = this._compEnabled ? 0.0 : 1.0;

        this.compOutput = ctx.createGain();
        this.compOutput.gain.value = 1.0;

        // Routage compresseur (Wet / Dry bypass)
        this.eqHigh.connect(this.compNode);
        this.compNode.connect(this.compMakeup);
        this.compMakeup.connect(this.compWet);
        this.compWet.connect(this.compOutput);

        this.eqHigh.connect(this.compDry);
        this.compDry.connect(this.compOutput);

        // ─── Point d'insertion (Sommation du bus avant limiteur final) ───
        // Permet d'injecter la réverbération acoustique avant le limiteur de sortie
        this.limiterInput = ctx.createGain();
        this.limiterInput.gain.value = 1.0;
        this.compOutput.connect(this.limiterInput);

        // ─── Étape 3 : Limiteur de Sortie Final (True Peak / Brickwall) ───
        this.limiterNode = ctx.createDynamicsCompressor();
        const limThresh = options['limiter-threshold'] ?? -0.1;
        this.limiterNode.threshold.value = limThresh;
        this.limiterNode.knee.value      = 0.0; // Hard knee pour plafond strict
        this.limiterNode.ratio.value     = 20.0; // Pente maximale
        this.limiterNode.attack.value    = (options['limiter-attack'] ?? 0.5) / 1000;
        this.limiterNode.release.value   = (options['limiter-release'] ?? 50) / 1000;

        this.limiterWet = ctx.createGain();
        this.limiterDry = ctx.createGain();
        this._limiterEnabled = options['limiter-enabled'] ?? true;
        this.limiterWet.gain.value = this._limiterEnabled ? 1.0 : 0.0;
        this.limiterDry.gain.value = this._limiterEnabled ? 0.0 : 1.0;

        this.output = ctx.createGain();
        this.output.gain.value = 1.0;

        // Routage limiteur (Wet / Dry bypass)
        this.limiterInput.connect(this.limiterNode);
        this.limiterNode.connect(this.limiterWet);
        this.limiterWet.connect(this.output);

        this.limiterInput.connect(this.limiterDry);
        this.limiterDry.connect(this.output);
    }

    /**
     * Mise à jour des paramètres de l'étage Master.
     * @param {string} param
     * @param {number|boolean} value
     */
    setParam(param, value) {
        const t = this.ctx.currentTime;
        switch (param) {
            // Étape 1 : Égaliseur Global
            case 'eq-low':
                this.eqLow.gain.setTargetAtTime(value, t, 0.02);
                break;
            case 'eq-mid-low':
                this.eqMidLow.gain.setTargetAtTime(value, t, 0.02);
                break;
            case 'eq-mid-high':
                this.eqMidHigh.gain.setTargetAtTime(value, t, 0.02);
                break;
            case 'eq-high':
                this.eqHigh.gain.setTargetAtTime(value, t, 0.02);
                break;

            // Étape 2 : Compresseur de Bus
            case 'comp-enabled':
                this._compEnabled = !!value;
                this.compWet.gain.setTargetAtTime(this._compEnabled ? 1.0 : 0.0, t, 0.02);
                this.compDry.gain.setTargetAtTime(this._compEnabled ? 0.0 : 1.0, t, 0.02);
                break;
            case 'comp-threshold':
                this.compNode.threshold.setTargetAtTime(value, t, 0.02);
                break;
            case 'comp-ratio':
                this.compNode.ratio.setTargetAtTime(value, t, 0.02);
                break;
            case 'comp-attack':
                this.compNode.attack.setTargetAtTime(Math.max(0.0001, value / 1000), t, 0.02);
                break;
            case 'comp-release':
                this.compNode.release.setTargetAtTime(Math.max(0.01, value / 1000), t, 0.02);
                break;
            case 'comp-makeup': {
                const lin = Math.pow(10, value / 20);
                this.compMakeup.gain.setTargetAtTime(lin, t, 0.02);
                break;
            }

            // Étape 3 : Limiteur de Sortie Final
            case 'limiter-enabled':
                this._limiterEnabled = !!value;
                this.limiterWet.gain.setTargetAtTime(this._limiterEnabled ? 1.0 : 0.0, t, 0.02);
                this.limiterDry.gain.setTargetAtTime(this._limiterEnabled ? 0.0 : 1.0, t, 0.02);
                break;
            case 'limiter-threshold':
                this.limiterNode.threshold.setTargetAtTime(value, t, 0.02);
                break;
            case 'limiter-attack':
                this.limiterNode.attack.setTargetAtTime(Math.max(0.0001, value / 1000), t, 0.02);
                break;
            case 'limiter-release':
                this.limiterNode.release.setTargetAtTime(Math.max(0.01, value / 1000), t, 0.02);
                break;
        }
    }
}
