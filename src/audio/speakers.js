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

const SPEED_OF_SOUND = 343; // m/s
const DEFAULT_DISTANCE_K = 0.06; // attenuation coefficient: gain = 1/(1 + k*d)
const DEFAULT_AIR_ABS = 40;  // Hz/m — air absorption rate for high-freq rolloff
const MAX_DELAY = 1.0;      // seconds (covers ~343 m)

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

        if (this._isMid || this._isFill) {
            // Mid/Fill speakers: bypass air absorption & high-shelf (signal already band-limited)
            this.propagationDelay.connect(this.panner);
        } else {
            // Sub & Top: full chain with air absorption
            this.propagationDelay.connect(this.airAbsorption1);
            this.airAbsorption1.connect(this.airAbsorption2);
            this.airAbsorption2.connect(this.highShelf);
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
        // Skip for mid/fill speakers (already band-limited by crossover)
        if (!this._isMid && !this._isFill) {
            const cutoff = Math.max(500, 18000 - distance * this._airAbsCoeff);
            this.airAbsorption1.frequency.setTargetAtTime(cutoff, t, smooth);
            this.airAbsorption2.frequency.setTargetAtTime(cutoff, t, smooth);
        }
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

        this.midAnalyser = ctx.createAnalyser();
        this.midAnalyser.fftSize = 256;
        this.midVolume.connect(this.midAnalyser);

        this.topAnalyser = ctx.createAnalyser();
        this.topAnalyser.fftSize = 256;
        this.topVolume.connect(this.topAnalyser);

        this.fillAnalyser = ctx.createAnalyser();
        this.fillAnalyser.fftSize = 256;
        this.fillVolume.connect(this.fillAnalyser);

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

        this.masterOutput.connect(this.masterLimiter);
        this.masterLimiter.connect(ctx.destination);

        // Master analyser taps after limiter (what the listener actually hears)
        this.masterAnalyser = ctx.createAnalyser();
        this.masterAnalyser.fftSize = 256;
        this.masterLimiter.connect(this.masterAnalyser);

        // Create speakers
        for (const def of SPEAKER_DEFS) {
            const speaker = new Speaker(ctx, def, this.masterOutput);
            this.speakers.push(speaker);

            if (def.bus === 'sub') {
                this.subVolume.connect(speaker.input);
            } else if (def.bus === 'mid') {
                this.midVolume.connect(speaker.input);
            } else if (def.bus === 'fill') {
                this.fillVolume.connect(speaker.input);
            } else {
                this.topVolume.connect(speaker.input);
            }
        }
    }

    /**
     * Update all speakers with current listener position.
     * @param {{x:number,y:number,z:number}} listenerPos
     */
    update(listenerPos) {
        for (const speaker of this.speakers) {
            speaker.update(listenerPos);
        }
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
     * Set air absorption (clarity) for line arrays and mids.
     * @param {number} sliderValue — 0 (max absorption) to 100 (neutral) to 200 (boosted brightness)
     */
    setClarity(sliderValue) {
        if (sliderValue <= 100) {
            const coeff = (1 - sliderValue / 100) * 300;
            for (const speaker of this.speakers) {
                if (!speaker._isSub) {
                    speaker.setAirAbsCoeff(coeff);
                    speaker.setHighShelfGain(0);
                }
            }
        } else {
            const boostDb = ((sliderValue - 100) / 100) * 15;
            for (const speaker of this.speakers) {
                if (!speaker._isSub) {
                    speaker.setAirAbsCoeff(0);
                    speaker.setHighShelfGain(boostDb);
                }
            }
        }
    }

    /**
     * Read peak levels from the four analysers.
     * Returns { sub, mid, top, master } each in 0..1 range (1 = 0 dBFS).
     */
    getLevels() {
        return {
            fill: peakLevel(this.fillAnalyser),
            sub: peakLevel(this.subAnalyser),
            mid: peakLevel(this.midAnalyser),
            top: peakLevel(this.topAnalyser),
            master: peakLevel(this.masterAnalyser),
        };
    }
}

/** Read peak amplitude from an AnalyserNode, returns 0..1 */
function peakLevel(analyser) {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
        const abs = Math.abs(buf[i]);
        if (abs > peak) peak = abs;
    }
    return peak;
}
