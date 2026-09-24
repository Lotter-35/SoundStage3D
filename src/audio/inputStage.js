/**
 * InputStage — Étage d'entrée DSP complet avant distribution vers le Crossover.
 *
 * Chaîne de traitement audio :
 *   1. Loudness Normalizer / Auto-Gain (Analyse LUFS ITU-R BS.1770 / EBU R128)
 *   2. Input Trim / Pré-gain Global (0% à 200%)
 *   3. Égaliseur 3 Bandes (Graves 100Hz, Médiums 1kHz, Aigus 6kHz, ±12 dB)
 *   4. Compresseur de Dynamique d'Entrée (Optionnel / Débrayable à chaud)
 *   5. Limiteur de Crête Brickwall (-0.1 dBFS, ratio 20:1, attaque instantanée 1ms)
 */
import { DSP_DEFAULTS } from '../config/dsp-defaults.js';

/**
 * Calcul des coefficients biquad pour le filtre de pondération K (ITU-R BS.1770-4).
 * @param {number} fs — Fréquence d'échantillonnage (Hz)
 */
function getKWeightingCoefficients(fs) {
    // Étape 1 : Filtre High-Shelf (modélisation de la tête humaine)
    const G = 3.9998438;
    const V0 = Math.pow(10, G / 20.0);
    const A = Math.sqrt(V0);
    const f0_1 = 1681.974448;
    const Q_1 = 0.707175236957588;
    const w0_1 = 2.0 * Math.PI * f0_1 / fs;
    const alpha_1 = Math.sin(w0_1) / (2.0 * Q_1);

    const a0_1 = (A + 1.0) - (A - 1.0) * Math.cos(w0_1) + 2.0 * Math.sqrt(A) * alpha_1;
    const b0_1 = (A * ((A + 1.0) + (A - 1.0) * Math.cos(w0_1) + 2.0 * Math.sqrt(A) * alpha_1)) / a0_1;
    const b1_1 = (-2.0 * A * ((A - 1.0) + (A + 1.0) * Math.cos(w0_1))) / a0_1;
    const b2_1 = (A * ((A + 1.0) + (A - 1.0) * Math.cos(w0_1) - 2.0 * Math.sqrt(A) * alpha_1)) / a0_1;
    const a1_1 = (2.0 * ((A - 1.0) - (A + 1.0) * Math.cos(w0_1))) / a0_1;
    const a2_1 = ((A + 1.0) - (A - 1.0) * Math.cos(w0_1) - 2.0 * Math.sqrt(A) * alpha_1) / a0_1;

    // Étape 2 : Filtre Passe-Haut RLB (pondération hautes fréquences)
    const f0_2 = 38.13547087613982;
    const Q_2 = 0.5003270373253953;
    const w0_2 = 2.0 * Math.PI * f0_2 / fs;
    const alpha_2 = Math.sin(w0_2) / (2.0 * Q_2);
    const a0_2 = 1.0 + alpha_2;
    const b0_2 = ((1.0 + Math.cos(w0_2)) / 2.0) / a0_2;
    const b1_2 = (-(1.0 + Math.cos(w0_2))) / a0_2;
    const b2_2 = ((1.0 + Math.cos(w0_2)) / 2.0) / a0_2;
    const a1_2 = (-2.0 * Math.cos(w0_2)) / a0_2;
    const a2_2 = (1.0 - alpha_2) / a0_2;

    return {
        stage1: { b0: b0_1, b1: b1_1, b2: b2_1, a1: a1_1, a2: a2_1 },
        stage2: { b0: b0_2, b1: b1_2, b2: b2_2, a1: a1_2, a2: a2_2 },
    };
}

/**
 * Mesure le Loudness Intégré (LUFS) d'un AudioBuffer selon la norme ITU-R BS.1770-4 / EBU R128.
 * @param {AudioBuffer} audioBuffer
 * @returns {{ lufs: number, rmsDb: number }}
 */
export function measureAudioBufferLoudness(audioBuffer) {
    if (!audioBuffer || audioBuffer.length === 0) {
        return { lufs: -70.0, rmsDb: -70.0 };
    }

    const fs = audioBuffer.sampleRate;
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const { stage1, stage2 } = getKWeightingCoefficients(fs);

    // Bloc de mesure : fenêtres de 400 ms avec 75% de recouvrement (pas de 100 ms)
    const blockSize = Math.round(0.400 * fs);
    const stepSize = Math.round(0.100 * fs);

    // Calcul de l'énergie RMS simple sur l'ensemble
    let totalSquareSum = 0;
    const filteredChannels = [];

    // Appliquer le filtre de pondération K sur chaque canal
    for (let ch = 0; ch < numChannels; ch++) {
        const inputData = audioBuffer.getChannelData(ch);
        const filtered = new Float32Array(length);

        let s1_x1 = 0, s1_x2 = 0, s1_y1 = 0, s1_y2 = 0;
        let s2_x1 = 0, s2_x2 = 0, s2_y1 = 0, s2_y2 = 0;

        for (let i = 0; i < length; i++) {
            const x = inputData[i];
            totalSquareSum += x * x;

            // Filtre Stage 1 (High-Shelf)
            const y1 = stage1.b0 * x + stage1.b1 * s1_x1 + stage1.b2 * s1_x2 - stage1.a1 * s1_y1 - stage1.a2 * s1_y2;
            s1_x2 = s1_x1; s1_x1 = x;
            s1_y2 = s1_y1; s1_y1 = y1;

            // Filtre Stage 2 (RLB High-Pass)
            const y2 = stage2.b0 * y1 + stage2.b1 * s2_x1 + stage2.b2 * s2_x2 - stage2.a1 * s2_y1 - stage2.a2 * s2_y2;
            s2_x2 = s2_x1; s2_x1 = y1;
            s2_y2 = s2_y1; s2_y1 = y2;

            filtered[i] = y2;
        }
        filteredChannels.push(filtered);
    }

    const overallRms = Math.sqrt(totalSquareSum / (length * numChannels || 1));
    const rmsDb = overallRms > 0 ? Math.max(-70, 20 * Math.log10(overallRms)) : -70;

    // Découpage en blocs de 400ms et calcul de l'énergie locale zj
    const blockEnergies = [];
    const channelWeights = [1.0, 1.0]; // Gauche, Droite (Poids 1.0 standard stéréo)

    for (let start = 0; start + blockSize <= length; start += stepSize) {
        let blockSum = 0;
        for (let ch = 0; ch < Math.min(2, numChannels); ch++) {
            const data = filteredChannels[ch];
            let chSum = 0;
            for (let i = start; i < start + blockSize; i++) {
                chSum += data[i] * data[i];
            }
            const meanSquare = chSum / blockSize;
            blockSum += (channelWeights[ch] || 1.0) * meanSquare;
        }

        // LKFS du bloc individuel
        if (blockSum > 1e-12) {
            const blockLoudness = -0.691 + 10 * Math.log10(blockSum);
            // Seuil de gating absolu : -70 LKFS
            if (blockLoudness > -70.0) {
                blockEnergies.push({ energy: blockSum, loudness: blockLoudness });
            }
        }
    }

    if (blockEnergies.length === 0) {
        return { lufs: -70.0, rmsDb };
    }

    // Seuil de gating relatif : moyenne des blocs au-dessus de -70 LKFS moins 10 dB
    let ungatedEnergySum = 0;
    for (let k = 0; k < blockEnergies.length; k++) {
        ungatedEnergySum += blockEnergies[k].energy;
    }
    const ungatedLoudness = -0.691 + 10 * Math.log10(ungatedEnergySum / blockEnergies.length);
    const relativeThreshold = ungatedLoudness - 10.0;

    // Calcul final avec les blocs au-dessus du seuil relatif
    let gatedEnergySum = 0;
    let gatedCount = 0;
    for (let k = 0; k < blockEnergies.length; k++) {
        if (blockEnergies[k].loudness > relativeThreshold) {
            gatedEnergySum += blockEnergies[k].energy;
            gatedCount++;
        }
    }

    if (gatedCount === 0) {
        return { lufs: -70.0, rmsDb };
    }

    const integratedLufs = -0.691 + 10 * Math.log10(gatedEnergySum / gatedCount);
    return {
        lufs: Math.round(integratedLufs * 10) / 10,
        rmsDb: Math.round(rmsDb * 10) / 10,
    };
}

export class InputStage {
    /**
     * @param {AudioContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;

        const def = DSP_DEFAULTS.input || {};

        // État interne
        this.autoGainEnabled = def['auto-gain'] ?? true;
        this.targetLufs = def['target-lufs'] ?? -14;
        this.measuredLufs = null;
        this.measuredRms = null;
        this.appliedGainDb = 0;
        this.compEnabled = def['comp-enabled'] ?? false;
        this.onUpdateCallback = null;

        // ── 1. Nœud d'entrée ──────────────────────────────────────────
        this.input = ctx.createGain();
        this.input.gain.value = 1.0;

        // Entrée dédiée au microphone en direct (injectée dans this.input)
        this.micGainNode = ctx.createGain();
        this.micGainNode.gain.value = (def['mic-volume'] ?? 100) / 100;
        this.micGainNode.connect(this.input);

        // ── 2. Nœud d'Auto-Gain (Normalisation LUFS) ───────────────────
        this.autoGainNode = ctx.createGain();
        this.autoGainNode.gain.value = 1.0;

        // ── 3. Nœud Input Trim (Pré-gain global) ───────────────────────
        this.trimNode = ctx.createGain();
        this.trimNode.gain.value = (def['input-trim'] ?? 100) / 100;

        // ── 4. Égaliseur 3 Bandes ─────────────────────────────────────
        // Graves (Low-Shelf 100 Hz)
        this.eqLow = ctx.createBiquadFilter();
        this.eqLow.type = 'lowshelf';
        this.eqLow.frequency.value = 100;
        this.eqLow.gain.value = def['eq-low'] ?? 0;

        // Médiums (Peaking 1 kHz, Q=1.0)
        this.eqMid = ctx.createBiquadFilter();
        this.eqMid.type = 'peaking';
        this.eqMid.frequency.value = 1000;
        this.eqMid.Q.value = 1.0;
        this.eqMid.gain.value = def['eq-mid'] ?? 0;

        // Aigus (High-Shelf 6 kHz)
        this.eqHigh = ctx.createBiquadFilter();
        this.eqHigh.type = 'highshelf';
        this.eqHigh.frequency.value = 6000;
        this.eqHigh.gain.value = def['eq-high'] ?? 0;

        // ── 5. Compresseur d'Entrée (Optionnel avec bypass transparent) ─
        this.compInput = ctx.createGain();
        this.compNode = ctx.createDynamicsCompressor();
        this.compNode.threshold.value = def['comp-threshold'] ?? -18;
        this.compNode.knee.value = def['comp-knee'] ?? 12;
        this.compNode.ratio.value = def['comp-ratio'] ?? 3;
        this.compNode.attack.value = (def['comp-attack'] ?? 10) / 1000;
        this.compNode.release.value = (def['comp-release'] ?? 150) / 1000;

        this.dryCompGain = ctx.createGain();
        this.dryCompGain.gain.value = this.compEnabled ? 0.0 : 1.0;

        this.wetCompGain = ctx.createGain();
        this.wetCompGain.gain.value = this.compEnabled ? 1.0 : 0.0;

        this.compOutput = ctx.createGain();

        // ── 6. Limiteur Brickwall de Crête (-0.1 dBFS) ─────────────────
        this.limiterNode = ctx.createDynamicsCompressor();
        this.limiterNode.threshold.value = def['limiter-ceiling'] ?? -0.1;
        this.limiterNode.knee.value = 0.0; // Hard knee instantané
        this.limiterNode.ratio.value = 20.0; // Brickwall limiter
        this.limiterNode.attack.value = 0.001; // 1 ms instantané
        this.limiterNode.release.value = 0.050; // 50 ms réactif

        // ── 7. Nœud de sortie (vers le Crossover) ─────────────────────
        this.output = ctx.createGain();
        this.output.gain.value = 1.0;

        // ── Câblage de la chaîne audio ────────────────────────────────
        // input → autoGainNode → trimNode → eqLow → eqMid → eqHigh → compInput
        this.input.connect(this.autoGainNode);
        this.autoGainNode.connect(this.trimNode);
        this.trimNode.connect(this.eqLow);
        this.eqLow.connect(this.eqMid);
        this.eqMid.connect(this.eqHigh);
        this.eqHigh.connect(this.compInput);

        // Branching compresseur (wet/dry bypass)
        this.compInput.connect(this.compNode);
        this.compNode.connect(this.wetCompGain);
        this.wetCompGain.connect(this.compOutput);

        this.compInput.connect(this.dryCompGain);
        this.dryCompGain.connect(this.compOutput);

        // compOutput → limiterNode → output
        this.compOutput.connect(this.limiterNode);
        this.limiterNode.connect(this.output);
    }

    /**
     * Analyse un AudioBuffer décodé et calcule la normalisation LUFS.
     * @param {AudioBuffer} audioBuffer
     * @returns {{ lufs: number, rmsDb: number, gainDb: number }}
     */
    analyzeBuffer(audioBuffer) {
        if (!audioBuffer) return null;

        const { lufs, rmsDb } = measureAudioBufferLoudness(audioBuffer);
        this.measuredLufs = lufs;
        this.measuredRms = rmsDb;

        this._applyAutoGain();

        if (this.onUpdateCallback) {
            this.onUpdateCallback({
                measuredLufs: this.measuredLufs,
                measuredRms: this.measuredRms,
                appliedGainDb: this.appliedGainDb,
            });
        }

        return {
            lufs: this.measuredLufs,
            rmsDb: this.measuredRms,
            gainDb: this.appliedGainDb,
        };
    }

    /**
     * Calcule et applique le gain de normalisation selon la cible LUFS configurée.
     * @private
     */
    _applyAutoGain() {
        const t = this.ctx.currentTime;
        if (!this.autoGainEnabled || this.measuredLufs === null || this.measuredLufs <= -65) {
            this.appliedGainDb = 0;
            this.autoGainNode.gain.setTargetAtTime(1.0, t, 0.04);
            return;
        }

        // Écart : Cible - Mesuré (ex: -14 - (-11) = -3 dB)
        let deltaDb = this.targetLufs - this.measuredLufs;
        // Sécurité : limiter l'amplitude de correction à ±18 dB
        deltaDb = Math.max(-18, Math.min(18, deltaDb));
        this.appliedGainDb = Math.round(deltaDb * 10) / 10;

        const linearGain = Math.pow(10, deltaDb / 20);
        this.autoGainNode.gain.setTargetAtTime(linearGain, t, 0.04);
    }

    /**
     * Enregistre un callback pour notifier l'UI lors de l'analyse ou du recalcul.
     * @param {Function} cb
     */
    onAnalysisUpdate(cb) {
        this.onUpdateCallback = cb;
    }

    /**
     * Modification d'un paramètre DSP de l'étage d'entrée.
     * @param {string} param
     * @param {number|boolean} value
     */
    setParam(param, value) {
        const t = this.ctx.currentTime;

        switch (param) {
            case 'auto-gain':
                this.autoGainEnabled = Boolean(value);
                this._applyAutoGain();
                if (this.onUpdateCallback) {
                    this.onUpdateCallback({
                        measuredLufs: this.measuredLufs,
                        measuredRms: this.measuredRms,
                        appliedGainDb: this.appliedGainDb,
                    });
                }
                break;

            case 'target-lufs':
                this.targetLufs = parseFloat(value);
                this._applyAutoGain();
                if (this.onUpdateCallback) {
                    this.onUpdateCallback({
                        measuredLufs: this.measuredLufs,
                        measuredRms: this.measuredRms,
                        appliedGainDb: this.appliedGainDb,
                    });
                }
                break;

            case 'input-trim':
                this.trimNode.gain.setTargetAtTime(parseFloat(value) / 100, t, 0.03);
                break;

            case 'eq-low':
                this.eqLow.gain.setTargetAtTime(parseFloat(value), t, 0.03);
                break;

            case 'eq-mid':
                this.eqMid.gain.setTargetAtTime(parseFloat(value), t, 0.03);
                break;

            case 'eq-high':
                this.eqHigh.gain.setTargetAtTime(parseFloat(value), t, 0.03);
                break;

            case 'comp-enabled':
                this.compEnabled = Boolean(value);
                this.wetCompGain.gain.setTargetAtTime(this.compEnabled ? 1.0 : 0.0, t, 0.03);
                this.dryCompGain.gain.setTargetAtTime(this.compEnabled ? 0.0 : 1.0, t, 0.03);
                break;

            case 'comp-threshold':
                this.compNode.threshold.setTargetAtTime(parseFloat(value), t, 0.03);
                break;

            case 'comp-knee':
                this.compNode.knee.setTargetAtTime(parseFloat(value), t, 0.03);
                break;

            case 'comp-ratio':
                this.compNode.ratio.setTargetAtTime(parseFloat(value), t, 0.03);
                break;

            case 'comp-attack':
                this.compNode.attack.setTargetAtTime(parseFloat(value) / 1000, t, 0.03);
                break;

            case 'comp-release':
                this.compNode.release.setTargetAtTime(parseFloat(value) / 1000, t, 0.03);
                break;

            case 'limiter-ceiling':
                this.limiterNode.threshold.setTargetAtTime(parseFloat(value), t, 0.03);
                break;

            case 'mic-volume':
                this.micGainNode.gain.setTargetAtTime(parseFloat(value) / 100, t, 0.03);
                break;
        }
    }
}
