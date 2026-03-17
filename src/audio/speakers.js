/**
 * Speakers — Virtual speaker emitters with per-speaker DSP chains.
 *
 * Each speaker chain:
 *   busInput → distanceGain → propagationDelay → airAbsorptionFilter → pannerNode → destination
 *                                                                    + groundReflection branch
 *
 * 14 speakers:
 *   7 subwoofers at y=1, z=0, x= -9,-6,-3,0,3,6,9 — omnidirectional, fed by SUB BUS
 *   midLeft   (-12, 6, -2)  — directional (wider), fed by MID BUS
 *   midRight  (12, 6, -2)   — directional (wider), fed by MID BUS
 *   arrayLeft  (-12, 8, 0)  — directional, fed by TOP BUS
 *   arrayRight (12, 8, 0)   — directional, fed by TOP BUS
 *   2 front-fills diagonal at y=3, z=1.2 — wide directional, fed by MID+TOP BUS
 */

import { createGroundReflection } from './effects.js';
import { DSP_DEFAULTS } from '../config/dsp-defaults.js';

const SPEED_OF_SOUND = 343; // m/s
const DEFAULT_DISTANCE_K = (DSP_DEFAULTS.sub['dist-k'] ?? 60) / 1000;
const DEFAULT_AIR_ABS = DSP_DEFAULTS.master['air-abs'] ?? 40;
const MAX_DELAY = 1.0;

// Proximity saturation thresholds (sub only) — mutable via UI
let PROX_FAR  = DSP_DEFAULTS.sub['prox-far'] ?? 4.0;
let PROX_NEAR = DSP_DEFAULTS.sub['prox-near'] ?? 2.0;
let PROX_DRIVE_MAX = DSP_DEFAULTS.sub['prox-drive'] ?? 75;

// Generate 7 sub definitions matching the visual sub boxes in stage.js
const SUB_DEFS = [];
for (let i = -3; i <= 3; i++) {
    SUB_DEFS.push({
        id: `sub${i + 3}`,
        bus: 'sub',
        position: { x: i * 3, y: 1, z: 0 },
        omnidirectional: true,
    });
}

export const SPEAKER_DEFS = [
    ...SUB_DEFS,
    {
        id: 'midLeft',
        bus: 'mid',
        position: { x: -12, y: 6, z: -2 },
        omnidirectional: false,
        orientation: { x: 0, y: -0.2, z: 1 },
        coneInner: 80,
        coneOuter: 140,
        coneOuterGain: 0.35,
    },
    {
        id: 'midRight',
        bus: 'mid',
        position: { x: 12, y: 6, z: -2 },
        omnidirectional: false,
        orientation: { x: 0, y: -0.2, z: 1 },
        coneInner: 80,
        coneOuter: 140,
        coneOuterGain: 0.35,
    },
    {
        id: 'arrayLeft',
        bus: 'top',
        position: { x: -12, y: 8, z: 0 },
        omnidirectional: false,
        orientation: { x: 0, y: -0.3, z: 1 },
    },
    {
        id: 'arrayRight',
        bus: 'top',
        position: { x: 12, y: 8, z: 0 },
        omnidirectional: false,
        orientation: { x: 0, y: -0.3, z: 1 },
    },
    // 2 front-fills on stage — diagonal, covering center audience
    {
        id: 'fillLeft',
        bus: 'fill',
        position: { x: -5, y: 6, z: -3 },
        omnidirectional: false,
        orientation: { x: 0.6, y: -0.6, z: 1 },
        coneInner: 40,
        coneOuter: 90,
        coneOuterGain: 0.25,
    },
    {
        id: 'fillRight',
        bus: 'fill',
        position: { x: 5, y: 6, z: -3 },
        omnidirectional: false,
        orientation: { x: -0.6, y: -0.6, z: 1 },
        coneInner: 40,
        coneOuter: 90,
        coneOuterGain: 0.25,
    },
];

class Speaker {
    /**
     * @param {AudioContext} ctx
     * @param {object} def — speaker definition from SPEAKER_DEFS
     * @param {AudioNode} output — node to connect panner outputs to
     */
    constructor(ctx, def, output) {
        this.ctx = ctx;
        this.id = def.id;
        this.position = def.position;
        this._dopplerEnabled = false;
        this._isSub = def.omnidirectional === true;
        this._isMid = def.bus === 'mid';
        this._isFill = def.bus === 'fill';
        this._distanceK = DEFAULT_DISTANCE_K;
        this._airAbsCoeff = DEFAULT_AIR_ABS;

        // --- Distance attenuation gain ---
        this.distanceGain = ctx.createGain();
        this.distanceGain.gain.value = 1;

        // --- Propagation delay ---
        this.propagationDelay = ctx.createDelay(MAX_DELAY);
        this.propagationDelay.delayTime.value = 0;

        // --- Air absorption (2× cascaded low-pass → 24 dB/oct) ---
        this.airAbsorption1 = ctx.createBiquadFilter();
        this.airAbsorption1.type = 'lowpass';
        this.airAbsorption1.frequency.value = 18000;
        this.airAbsorption1.Q.value = 0.707;

        this.airAbsorption2 = ctx.createBiquadFilter();
        this.airAbsorption2.type = 'lowpass';
        this.airAbsorption2.frequency.value = 18000;
        this.airAbsorption2.Q.value = 0.707;

        // --- High-shelf for clarity boost (active when slider > 100) ---
        this.highShelf = ctx.createBiquadFilter();
        this.highShelf.type = 'highshelf';
        this.highShelf.frequency.value = 3000;
        this.highShelf.gain.value = 0;

        // --- Panner ---
        this.panner = ctx.createPanner();
        this.panner.panningModel = 'equalpower';
        this.panner.distanceModel = 'inverse';
        this.panner.refDistance = 1;
        this.panner.maxDistance = 500;
        this.panner.rolloffFactor = 0.4; // mild, we handle attenuation manually

        this.panner.positionX.value = def.position.x;
        this.panner.positionY.value = def.position.y;
        this.panner.positionZ.value = def.position.z;

        if (def.omnidirectional) {
            this.panner.coneInnerAngle = 360;
            this.panner.coneOuterAngle = 360;
            this.panner.coneOuterGain = 1;
        } else {
            this.panner.coneInnerAngle = def.coneInner || 60;
            this.panner.coneOuterAngle = def.coneOuter || 120;
            this.panner.coneOuterGain = def.coneOuterGain || 0.3;
            // Orientation toward audience (+Z)
            const o = def.orientation;
            this.panner.orientationX.value = o.x;
            this.panner.orientationY.value = o.y;
            this.panner.orientationZ.value = o.z;
        }

        // --- Ground reflection ---
        this.reflection = createGroundReflection(ctx, def.position, {
            panningModel: 'equalpower',
        });

        // --- Wiring ---
        this.distanceGain.connect(this.propagationDelay);

        // All speakers: full chain with air absorption & high-shelf
        this.propagationDelay.connect(this.airAbsorption1);
        this.airAbsorption1.connect(this.airAbsorption2);
        this.airAbsorption2.connect(this.highShelf);

        // Sub speakers: proximity saturation between high-shelf and panner
        if (this._isSub) {
            this._proxShaper = ctx.createWaveShaper();
            this._proxShaper.oversample = '2x';
            this._proxWet = ctx.createGain();
            this._proxDry = ctx.createGain();
            this._proxOut = ctx.createGain();
            this._proxWet.gain.value = 0;
            this._proxDry.gain.value = 1;
            this._proxOut.gain.value = 1;
            this._applyProxCurve(0); // linear (no distortion)

            this.highShelf.connect(this._proxShaper);
            this._proxShaper.connect(this._proxWet);
            this._proxWet.connect(this._proxOut);
            this.highShelf.connect(this._proxDry);
            this._proxDry.connect(this._proxOut);
            this._proxOut.connect(this.panner);
        } else {
            this.highShelf.connect(this.panner);
        }

        this.panner.connect(output);

        // Reflection branch: distanceGain → reflection.input → ... → reflection.panner → output
        this.distanceGain.connect(this.reflection.input);
        this.reflection.panner.connect(output);
    }

    /**
     * Update distance-dependent parameters.
     * Call every frame with the current listener position.
     * @param {{x:number,y:number,z:number}} listenerPos
     */
    update(listenerPos) {
        const dx = listenerPos.x - this.position.x;
        const dy = listenerPos.y - this.position.y;
        const dz = listenerPos.z - this.position.z;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        this._lastDistance = distance;
        const t = this.ctx.currentTime;
        // Subs use longer smoothing to avoid zipper noise on 7 simultaneous sources
        const smooth = this._isSub ? 0.08 : 0.04;

        // Distance attenuation
        const gain = 1 / (1 + this._distanceK * distance);
        this.distanceGain.gain.setTargetAtTime(gain, t, smooth);

        // Propagation delay
        if (this._dopplerEnabled) {
            const delay = Math.min(distance / SPEED_OF_SOUND, MAX_DELAY);
            this.propagationDelay.delayTime.setTargetAtTime(delay, t, 0.05);
        } else {
            this.propagationDelay.delayTime.setTargetAtTime(0, t, smooth);
        }

        // Air absorption: high-frequency rolloff with distance (24 dB/oct cascaded)
        // MID/FILL have a higher cutoff floor to preserve their useful band (90–2kHz)
        const cutoffFloor = (this._isMid || this._isFill) ? 1500 : 500;
        const cutoff = Math.max(cutoffFloor, 18000 - distance * this._airAbsCoeff);
        this.airAbsorption1.frequency.setTargetAtTime(cutoff, t, smooth);
        this.airAbsorption2.frequency.setTargetAtTime(cutoff, t, smooth);

        // Sub proximity saturation: ramp drive + mix from 3m to 1m (S-curve)
        if (this._isSub) {
            const t0 = Math.max(0, Math.min(1, (PROX_FAR - distance) / (PROX_FAR - PROX_NEAR)));
            const prox = t0 * t0 * (3 - 2 * t0); // smoothstep S-curve
            this._applyProxCurve(prox * PROX_DRIVE_MAX);
            this._proxWet.gain.setTargetAtTime(prox, t, smooth);
            this._proxDry.gain.setTargetAtTime(1 - prox, t, smooth);
        }
    }

    /** Re-apply proximity saturation with current stored distance (for live slider updates). */
    _updateProxSat() {
        if (!this._isSub || this._lastDistance == null) return;
        const distance = this._lastDistance;
        const t = this.ctx.currentTime;
        const t0 = Math.max(0, Math.min(1, (PROX_FAR - distance) / (PROX_FAR - PROX_NEAR)));
        const prox = t0 * t0 * (3 - 2 * t0);
        this._applyProxCurve(prox * PROX_DRIVE_MAX);
        this._proxWet.gain.setTargetAtTime(prox, t, 0.04);
        this._proxDry.gain.setTargetAtTime(1 - prox, t, 0.04);
    }

    setDoppler(enabled) {
        this._dopplerEnabled = enabled;
        if (!enabled) {
            this.propagationDelay.delayTime.setTargetAtTime(0, this.ctx.currentTime, 0.04);
        }
    }

    /**
     * Set the distance attenuation coefficient.
     * @param {number} k — higher = faster falloff (short range), lower = further reach
     */
    setDistanceK(k) {
        this._distanceK = k;
    }

    /**
     * Set the air absorption coefficient (Hz lost per meter).
     * @param {number} coeff — higher = faster high-freq rolloff, lower = clearer at distance
     */
    setAirAbsCoeff(coeff) {
        this._airAbsCoeff = coeff;
    }

    /**
     * Set high-shelf boost gain in dB.
     * @param {number} db — 0 = neutral, up to +15 dB for extreme brightness
     */
    setHighShelfGain(db) {
        this.highShelf.gain.setTargetAtTime(db, this.ctx.currentTime, 0.04);
    }

    /** Build proximity saturation wave-shaper curve (same algo as bus saturation). */
    _applyProxCurve(drive) {
        const samples = 4096;
        const curve = new Float32Array(samples);
        const amount = Math.max(0.01, drive / 50);
        for (let i = 0; i < samples; i++) {
            const x = (i * 2) / samples - 1;
            curve[i] = (1 + amount) * x / (1 + amount * Math.abs(x));
        }
        this._proxShaper.curve = curve;
    }

    /** Set ground reflection gain (0..1) */
    setReflectionGain(value) {
        this.reflection.gainNode.gain.setTargetAtTime(value, this.ctx.currentTime, 0.04);
    }

    /** Set ground reflection lowpass frequency */
    setReflectionLpf(freq) {
        // The lpf is between delay and gain in the reflection chain
        // Access via the reflection's internal nodes — we need to expose it
        if (this.reflection._lpf) {
            this.reflection._lpf.frequency.setTargetAtTime(freq, this.ctx.currentTime, 0.04);
        }
    }

    /** The node to connect the bus output to. */
    get input() {
        return this.distanceGain;
    }
}

/**
 * SpeakerSystem — owns the virtual speakers and per-bus effect chains.
 */
export class SpeakerSystem {
    /**
     * @param {AudioContext} ctx
     * @param {AudioNode} subBus — crossover sub output
     * @param {AudioNode} midBus — crossover mid output
     * @param {AudioNode} topBus — crossover top output
     * @param {object} effects — { subComp, subSat, midComp, midSat, topComp, topSat }
     */
    constructor(ctx, subBus, midBus, topBus, effects) {
        this.ctx = ctx;
        this.speakers = [];
        // Keep references to effect nodes to prevent garbage collection
        this._effects = effects;

        // ── Bus volume controls ──
        this.subVolume = ctx.createGain();
        this.subVolume.gain.value = 1;
        this.midVolume = ctx.createGain();
        this.midVolume.gain.value = 1;
        this.topVolume = ctx.createGain();
        this.topVolume.gain.value = 1;
        this.fillVolume = ctx.createGain();
        this.fillVolume.gain.value = 1;

        // Wire bus effects: subBus → subCompressor → subSaturation → subVolume
        subBus.connect(effects.subComp);
        effects.subComp.connect(effects.subSat);
        effects.subSat.connect(this.subVolume);

        // Wire bus effects: midBus → midCompressor → midSaturation → midVolume
        midBus.connect(effects.midComp);
        effects.midComp.connect(effects.midSat);
        effects.midSat.connect(this.midVolume);

        // Wire bus effects: topBus → topCompressor → topSaturation → topVolume
        topBus.connect(effects.topComp);
        effects.topComp.connect(effects.topSat);
        effects.topSat.connect(this.topVolume);

        // Front-fill bus: taps from mid+top processed signals (after effects, before bus volume)
        // This way fill volume is independent from mid/top volume
        this.fillMerge = ctx.createGain();
        this.fillMerge.gain.value = 0.5; // -6dB each to avoid summing boost
        effects.midSat.connect(this.fillMerge);
        effects.topSat.connect(this.fillMerge);
        this.fillMerge.connect(this.fillVolume);

        // ── Analysers for level metering ──
        this.subAnalyser = ctx.createAnalyser();
        this.subAnalyser.fftSize = 256;
        this.subVolume.connect(this.subAnalyser);

        // MID bus limiter (brick-wall)
        this.midLimiter = ctx.createDynamicsCompressor();
        this.midLimiter.threshold.value = -3;
        this.midLimiter.knee.value = 2;
        this.midLimiter.ratio.value = 20;
        this.midLimiter.attack.value = 0.001;
        this.midLimiter.release.value = 0.05;
        this.midVolume.connect(this.midLimiter);

        this.midAnalyser = ctx.createAnalyser();
        this.midAnalyser.fftSize = 256;
        this.midLimiter.connect(this.midAnalyser);

        // TOP bus limiter (brick-wall)
        this.topLimiter = ctx.createDynamicsCompressor();
        this.topLimiter.threshold.value = -3;
        this.topLimiter.knee.value = 2;
        this.topLimiter.ratio.value = 20;
        this.topLimiter.attack.value = 0.001;
        this.topLimiter.release.value = 0.05;
        this.topVolume.connect(this.topLimiter);

        this.topAnalyser = ctx.createAnalyser();
        this.topAnalyser.fftSize = 256;
        this.topLimiter.connect(this.topAnalyser);

        // FILL bus limiter (brick-wall)
        this.fillLimiter = ctx.createDynamicsCompressor();
        this.fillLimiter.threshold.value = -3;
        this.fillLimiter.knee.value = 2;
        this.fillLimiter.ratio.value = 20;
        this.fillLimiter.attack.value = 0.001;
        this.fillLimiter.release.value = 0.05;
        this.fillVolume.connect(this.fillLimiter);

        this.fillAnalyser = ctx.createAnalyser();
        this.fillAnalyser.fftSize = 256;
        this.fillLimiter.connect(this.fillAnalyser);

        // Master output chain: masterOutput → limiter → ctx.destination
        this.masterOutput = ctx.createGain();
        this.masterOutput.gain.value = 1;

        // Brick-wall limiter to prevent clipping
        this.masterLimiter = ctx.createDynamicsCompressor();
        this.masterLimiter.threshold.value = -3;
        this.masterLimiter.knee.value = 2;
        this.masterLimiter.ratio.value = 20;
        this.masterLimiter.attack.value = 0.001;
        this.masterLimiter.release.value = 0.05;

        // HRTF brightness compensation: high-shelf boost to counter HRTF dullness
        this.hrtfShelf = ctx.createBiquadFilter();
        this.hrtfShelf.type = 'highshelf';
        this.hrtfShelf.frequency.value = 2500;
        this.hrtfShelf.gain.value = 0; // off by default (equalpower mode)

        // Reverb: parallel wet/dry send off hrtfShelf → masterLimiter
        this.reverbConvolver = ctx.createConvolver();
        this.reverbConvolver.buffer = this._createReverbIR(2.5, 2.0);
        this.reverbWet = ctx.createGain();
        this.reverbWet.gain.value = 0; // fully dry by default

        this.masterOutput.connect(this.hrtfShelf);
        this.hrtfShelf.connect(this.masterLimiter);           // dry path (always full)
        this.hrtfShelf.connect(this.reverbConvolver);          // wet send
        this.reverbConvolver.connect(this.reverbWet);
        this.reverbWet.connect(this.masterLimiter);

        // Local volume gain — end-of-chain, not synchronized in multi: for the local user only
        this.localVolumeGain = ctx.createGain();
        this.localVolumeGain.gain.value = 1;
        this.masterLimiter.connect(this.localVolumeGain);
        this.localVolumeGain.connect(ctx.destination);

        // Master analyser taps after limiter (what the listener actually hears)
        this.masterAnalyser = ctx.createAnalyser();
        this.masterAnalyser.fftSize = 256;
        this.masterLimiter.connect(this.masterAnalyser);

        // Pre-allocated buffers for level metering (avoid GC)
        this._meterBufs = {
            sub: new Float32Array(256),
            mid: new Float32Array(256),
            top: new Float32Array(256),
            fill: new Float32Array(256),
            master: new Float32Array(256),
        };

        // Create speakers
        for (const def of SPEAKER_DEFS) {
            const speaker = new Speaker(ctx, def, this.masterOutput);
            this.speakers.push(speaker);

            if (def.bus === 'sub') {
                this.subVolume.connect(speaker.input);
            } else if (def.bus === 'mid') {
                this.midLimiter.connect(speaker.input);
            } else if (def.bus === 'fill') {
                this.fillLimiter.connect(speaker.input);
            } else {
                this.topLimiter.connect(speaker.input);
            }
        }

        // Staggered update state: alternate which half of speakers update each frame
        this._updateFrame = 0;
        this._lastPos = { x: NaN, y: NaN, z: NaN };
        // Debug stats
        this._debugStats = { skippedFrames: 0, updatedSpeakers: 0, totalFrames: 0 };
    }

    /**
     * Update all speakers with current listener position.
     * Uses dirty checking (skip if listener barely moved) and staggered updates
     * (half the speakers per frame) to reduce main-thread overhead.
     * @param {{x:number,y:number,z:number}} listenerPos
     */
    update(listenerPos) {
        this._debugStats.totalFrames++;

        // Dirty check: skip entirely if listener hasn't moved enough
        const dx = listenerPos.x - this._lastPos.x;
        const dy = listenerPos.y - this._lastPos.y;
        const dz = listenerPos.z - this._lastPos.z;
        const moved2 = dx * dx + dy * dy + dz * dz;
        if (moved2 < 0.0025) {
            this._debugStats.skippedFrames++;
            return;
        }

        this._lastPos.x = listenerPos.x;
        this._lastPos.y = listenerPos.y;
        this._lastPos.z = listenerPos.z;

        // Stagger: update even-indexed speakers on even frames, odd on odd
        const parity = this._updateFrame & 1;
        this._updateFrame++;
        let count = 0;
        for (let i = parity; i < this.speakers.length; i += 2) {
            this.speakers[i].update(listenerPos);
            count++;
        }
        this._debugStats.updatedSpeakers = count;
    }

    /**
     * Enable or disable propagation delay (Doppler effect).
     * @param {boolean} enabled
     */
    setDoppler(enabled) {
        for (const speaker of this.speakers) {
            speaker.setDoppler(enabled);
        }
    }

    /**
     * Switch panning model for all speakers.
     * @param {'equalpower'|'HRTF'} model
     */
    setPanningModel(model) {
        for (const speaker of this.speakers) {
            speaker.panner.panningModel = model;
            speaker.reflection.panner.panningModel = model;
        }
    }

    /**
     * Set HRTF high-shelf brightness compensation.
     * @param {number} db — boost in dB (0 = no compensation)
     */
    setHrtfBrightness(db) {
        this.hrtfShelf.gain.setTargetAtTime(db, this.ctx.currentTime, 0.05);
    }

    /**
     * Set bus volume (0..1.5).
     * @param {'sub'|'mid'|'top'|'fill'} bus
     * @param {number} value
     */
    setBusVolume(bus, value) {
        const node = bus === 'sub' ? this.subVolume
            : bus === 'mid' ? this.midVolume
            : bus === 'fill' ? this.fillVolume
            : this.topVolume;
        node.gain.setTargetAtTime(value, this.ctx.currentTime, 0.04);
    }

    /**
     * Set propagation range for a bus.
     * @param {'sub'|'mid'|'top'} bus
     * @param {number} sliderValue — 0 (short range) to 200 (long range), 50 = default
     */
    setRange(bus, sliderValue) {
        // Exponential mapping: K = DEFAULT_K * 2^((50 - value) / 15)
        const k = DEFAULT_DISTANCE_K * Math.pow(2, (50 - sliderValue) / 15);
        for (const speaker of this.speakers) {
            const sBus = SPEAKER_DEFS.find(d => d.id === speaker.id)?.bus;
            if (sBus === bus) {
                speaker.setDistanceK(k);
            }
        }
    }

    /**
     * Set a global Master DSP parameter (air absorption or treble boost).
     * @param {string} param — parameter key from the Master panel
     * @param {number} value — raw slider value
     */
    setMasterDspParam(param, value) {
        switch (param) {
            case 'air-abs':
                for (const s of this.speakers) s.setAirAbsCoeff(value);
                break;
            case 'treble':
                for (const s of this.speakers) s.setHighShelfGain(value);
                break;
            case 'local-volume':
                this.localVolumeGain.gain.cancelScheduledValues(0);
                this.localVolumeGain.gain.value = value / 100;
                break;
            case 'reverb':
                this.reverbWet.gain.setTargetAtTime(value / 100, this.ctx.currentTime, 0.05);
                break;
        }
    }

    /**
     * Generate a synthetic impulse response buffer for the reverb.
     * @param {number} duration — tail length in seconds
     * @param {number} decay — exponential decay factor (higher = faster fade)
     * @returns {AudioBuffer}
     */
    _createReverbIR(duration, decay) {
        const rate = this.ctx.sampleRate;
        const length = rate * duration;
        const buffer = this.ctx.createBuffer(2, length, rate);
        for (let ch = 0; ch < 2; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < length; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
            }
        }
        return buffer;
    }

    /**
     * Set a DSP parameter for the SUB bus.
     * @param {string} param — parameter key from the DSP panel
     * @param {number} value — raw slider value
     * @param {object} deps — { crossover, effects } external node references
     */
    setSubDspParam(param, value, deps) {
        const t = this.ctx.currentTime;
        const subSpeakers = this.speakers.filter(s => s._isSub);

        switch (param) {
            case 'xover-freq':
                if (deps.crossover) deps.crossover.setLowFreq(value);
                break;
            case 'comp-threshold':
                this._effects.subComp.threshold.setTargetAtTime(value, t, 0.04);
                break;
            case 'comp-knee':
                this._effects.subComp.knee.setTargetAtTime(value, t, 0.04);
                break;
            case 'comp-ratio':
                this._effects.subComp.ratio.setTargetAtTime(value, t, 0.04);
                break;
            case 'comp-attack':
                this._effects.subComp.attack.setTargetAtTime(value / 1000, t, 0.04);
                break;
            case 'comp-release':
                this._effects.subComp.release.setTargetAtTime(value / 1000, t, 0.04);
                break;
            case 'sat-drive':
                if (this._effects.subSat.setDrive) this._effects.subSat.setDrive(value);
                break;
            case 'sat-mix':
                if (this._effects.subSat.setMix) this._effects.subSat.setMix(value);
                break;
            case 'bus-volume':
                this.subVolume.gain.setTargetAtTime(value / 100, t, 0.04);
                break;
            case 'dist-k':
                for (const s of subSpeakers) s.setDistanceK(value / 1000);
                break;
            case 'refl-gain':
                for (const s of subSpeakers) s.setReflectionGain(value / 100);
                break;
            case 'refl-lpf':
                for (const s of subSpeakers) s.setReflectionLpf(value);
                break;
            case 'prox-far':
                PROX_FAR = parseFloat(value);
                for (const s of subSpeakers) s._updateProxSat();
                break;
            case 'prox-near':
                PROX_NEAR = parseFloat(value);
                for (const s of subSpeakers) s._updateProxSat();
                break;
            case 'prox-drive':
                PROX_DRIVE_MAX = parseFloat(value);
                for (const s of subSpeakers) s._updateProxSat();
                break;
            case 'lim-threshold':
                this.masterLimiter.threshold.setTargetAtTime(value, t, 0.04);
                break;
        }
    }

    /**
     * Set a DSP parameter for the MID bus.
     * @param {string} param — parameter key from the DSP panel
     * @param {number} value — raw slider value
     * @param {object} deps — { crossover, effects } external node references
     */
    setMidDspParam(param, value, deps) {
        const t = this.ctx.currentTime;
        const midSpeakers = this.speakers.filter(s => s._isMid);

        switch (param) {
            case 'xover-low':
                if (deps.crossover) deps.crossover.setLowFreq(value);
                break;
            case 'xover-high':
                if (deps.crossover) deps.crossover.setHighFreq(value);
                break;
            case 'comp-threshold':
                this._effects.midComp.threshold.setTargetAtTime(value, t, 0.04);
                break;
            case 'comp-knee':
                this._effects.midComp.knee.setTargetAtTime(value, t, 0.04);
                break;
            case 'comp-ratio':
                this._effects.midComp.ratio.setTargetAtTime(value, t, 0.04);
                break;
            case 'comp-attack':
                this._effects.midComp.attack.setTargetAtTime(value / 1000, t, 0.04);
                break;
            case 'comp-release':
                this._effects.midComp.release.setTargetAtTime(value / 1000, t, 0.04);
                break;
            case 'sat-drive':
                if (this._effects.midSat.setDrive) this._effects.midSat.setDrive(value);
                break;
            case 'sat-mix':
                if (this._effects.midSat.setMix) this._effects.midSat.setMix(value);
                break;
            case 'bus-volume':
                this.midVolume.gain.setTargetAtTime(value / 100, t, 0.04);
                break;
            case 'dist-k':
                for (const s of midSpeakers) s.setDistanceK(value / 1000);
                break;
            case 'refl-gain':
                for (const s of midSpeakers) s.setReflectionGain(value / 100);
                break;
            case 'refl-lpf':
                for (const s of midSpeakers) s.setReflectionLpf(value);
                break;
            case 'lim-threshold':
                this.midLimiter.threshold.setTargetAtTime(value, t, 0.04);
                break;
        }
    }

    /**
     * Set a DSP parameter for the TOP bus.
     * @param {string} param — parameter key from the DSP panel
     * @param {number} value — raw slider value
     * @param {object} deps — { crossover, effects } external node references
     */
    setTopDspParam(param, value, deps) {
        const t = this.ctx.currentTime;
        const topSpeakers = this.speakers.filter(s => !s._isSub && !s._isMid && !s._isFill);

        switch (param) {
            case 'xover-freq':
                if (deps.crossover) deps.crossover.setHighFreq(value);
                break;
            case 'comp-threshold':
                this._effects.topComp.threshold.setTargetAtTime(value, t, 0.04);
                break;
            case 'comp-knee':
                this._effects.topComp.knee.setTargetAtTime(value, t, 0.04);
                break;
            case 'comp-ratio':
                this._effects.topComp.ratio.setTargetAtTime(value, t, 0.04);
                break;
            case 'comp-attack':
                this._effects.topComp.attack.setTargetAtTime(value / 1000, t, 0.04);
                break;
            case 'comp-release':
                this._effects.topComp.release.setTargetAtTime(value / 1000, t, 0.04);
                break;
            case 'sat-drive':
                if (this._effects.topSat.setDrive) this._effects.topSat.setDrive(value);
                break;
            case 'sat-mix':
                if (this._effects.topSat.setMix) this._effects.topSat.setMix(value);
                break;
            case 'bus-volume':
                this.topVolume.gain.setTargetAtTime(value / 100, t, 0.04);
                break;
            case 'dist-k':
                for (const s of topSpeakers) s.setDistanceK(value / 1000);
                break;
            case 'refl-gain':
                for (const s of topSpeakers) s.setReflectionGain(value / 100);
                break;
            case 'refl-lpf':
                for (const s of topSpeakers) s.setReflectionLpf(value);
                break;
            case 'lim-threshold':
                this.topLimiter.threshold.setTargetAtTime(value, t, 0.04);
                break;
        }
    }

    /**
     * Set a DSP parameter for the FILL bus.
     * @param {string} param — parameter key from the DSP panel
     * @param {number} value — raw slider value
     */
    setFillDspParam(param, value) {
        const t = this.ctx.currentTime;
        const fillSpeakers = this.speakers.filter(s => s._isFill);

        switch (param) {
            case 'merge-gain':
                this.fillMerge.gain.setTargetAtTime(value / 100, t, 0.04);
                break;
            case 'bus-volume':
                this.fillVolume.gain.setTargetAtTime(value / 100, t, 0.04);
                break;
            case 'dist-k':
                for (const s of fillSpeakers) s.setDistanceK(value / 1000);
                break;
            case 'refl-gain':
                for (const s of fillSpeakers) s.setReflectionGain(value / 100);
                break;
            case 'refl-lpf':
                for (const s of fillSpeakers) s.setReflectionLpf(value);
                break;
            case 'lim-threshold':
                this.fillLimiter.threshold.setTargetAtTime(value, t, 0.04);
                break;
        }
    }

    /**
     * Read peak levels from the four analysers.
     * Returns { sub, mid, top, master } each in 0..1 range (1 = 0 dBFS).
     */
    getLevels() {
        return {
            fill: peakLevel(this.fillAnalyser, this._meterBufs.fill),
            sub: peakLevel(this.subAnalyser, this._meterBufs.sub),
            mid: peakLevel(this.midAnalyser, this._meterBufs.mid),
            top: peakLevel(this.topAnalyser, this._meterBufs.top),
            master: peakLevel(this.masterAnalyser, this._meterBufs.master),
        };
    }
}

/** Read peak amplitude from an AnalyserNode, returns 0..1 */
function peakLevel(analyser, buf) {
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
        const abs = Math.abs(buf[i]);
        if (abs > peak) peak = abs;
    }
    return peak;
}
