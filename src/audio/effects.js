/**
 * Effects — PA saturation, PA compression, ground reflection.
 *
 * Saturation & compression are inserted per-bus (sub / top) between crossover output and speakers.
 * Ground reflection is per-speaker and created in speakers.js; this module provides the factory.
 */

/**
 * Build a soft-clip WaveShaperNode.
 * Curve: f(x) = 1.5x - 0.5x^3  (smooth Chebyshev polynomial)
 */
export function createSaturation(ctx) {
    // Wet/dry structure: input → shaper (wet) + dry bypass → output
    const input = ctx.createGain();
    input.gain.value = 1;

    const shaper = ctx.createWaveShaper();
    shaper.oversample = '2x';

    const dry = ctx.createGain();
    dry.gain.value = 0; // 100% wet by default

    const wet = ctx.createGain();
    wet.gain.value = 1;

    const output = ctx.createGain();
    output.gain.value = 1;

    // Generate default curve (drive=50%)
    _applySatCurve(shaper, 50);

    input.connect(shaper);
    shaper.connect(wet);
    wet.connect(output);
    input.connect(dry);
    dry.connect(output);

    // Return the input GainNode as the main node (so upstream can .connect(sat))
    // Attach output and controls as extra properties
    input._output = output;
    input._shaper = shaper;
    input._wet = wet;
    input._dry = dry;
    input._ctx = ctx;

    // Override connect so that downstream connects from the output
    const origConnect = input.connect.bind(input);
    input.connect = function(dest, ...args) {
        // If connecting to downstream, use output node
        return output.connect(dest, ...args);
    };
    // Keep a way to connect to input for upstream
    input._connectUpstream = origConnect;

    /** Set drive amount 0–100 */
    input.setDrive = (drive) => {
        _applySatCurve(shaper, drive);
    };

    /** Set wet/dry mix 0–100 (0=full dry, 100=full wet) */
    input.setMix = (mix) => {
        const w = mix / 100;
        wet.gain.setTargetAtTime(w, ctx.currentTime, 0.04);
        dry.gain.setTargetAtTime(1 - w, ctx.currentTime, 0.04);
    };

    return input;
}

/** Build wave-shaper curve with variable drive. */
function _applySatCurve(shaper, drive) {
    const samples = 8192;
    const curve = new Float32Array(samples);
    // drive 0 = linear, drive 100 = hard clip
    const amount = Math.max(0.01, drive / 50); // 0..2 range
    for (let i = 0; i < samples; i++) {
        const x = (i * 2) / samples - 1;
        curve[i] = (1 + amount) * x / (1 + amount * Math.abs(x));
    }
    shaper.curve = curve;
}

/**
 * Build a DynamicsCompressorNode for PA limiting.
 */
export function createCompressor(ctx) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -24;
    comp.knee.value = 30;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    return comp;
}

/**
 * Build a ground-reflection chain for one speaker.
 *
 * @param {AudioContext} ctx
 * @param {{x:number,y:number,z:number}} speakerPos — original speaker position
 * @param {object} [options]
 * @param {string} [options.panningModel='HRTF'] — 'HRTF' or 'equalpower'
 * @returns {{ input: GainNode, panner: PannerNode }}
 *   input  – connect the same signal feeding the direct-path speaker
 *   panner – the final node, connect to ctx.destination
 */
export function createGroundReflection(ctx, speakerPos, options = {}) {
    // Reflection: image source mirrored below ground (Y inverted)
    const reflectPos = { x: speakerPos.x, y: -speakerPos.y, z: speakerPos.z };

    const input = ctx.createGain();
    input.gain.value = 1;

    // Extra path length ≈ 2 * speakerHeight → delay
    const extraPath = 2 * Math.abs(speakerPos.y); // meters
    const delayTime = extraPath / 343; // seconds
    const delay = ctx.createDelay(0.2);
    delay.delayTime.value = Math.min(delayTime, 0.2);

    // Low-pass: ground absorbs highs
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 1500;
    lpf.Q.value = 0.707;

    // Attenuate reflection
    const gain = ctx.createGain();
    gain.value = 0.2;
    gain.gain.value = 0.2;

    // Spatialize from reflected position
    const panner = ctx.createPanner();
    panner.panningModel = options.panningModel || 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 500;
    panner.rolloffFactor = 1;
    panner.positionX.value = reflectPos.x;
    panner.positionY.value = reflectPos.y;
    panner.positionZ.value = reflectPos.z;
    // Omni for reflections
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    panner.coneOuterGain = 1;

    // Wire: input → delay → lpf → gain → panner
    input.connect(delay);
    delay.connect(lpf);
    lpf.connect(gain);
    gain.connect(panner);

    return { input, panner, delayNode: delay, gainNode: gain, reflectPos, _lpf: lpf };
}
