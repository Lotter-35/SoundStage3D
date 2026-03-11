/**
 * Crossover — 3-band Linkwitz-Riley 24dB/oct
 *   SUB BUS  : < 90 Hz
 *   MID BUS  : 90 Hz – 2 kHz
 *   TOP BUS  : > 2 kHz
 *
 * LR4 = two cascaded 2nd-order Butterworth filters (12dB each → 24dB total).
 */

const LOW_FREQ = 90;
const HIGH_FREQ = 2000;

export class Crossover {
    /**
     * @param {AudioContext} ctx
     */
    constructor(ctx) {
        this.ctx = ctx;

        // --- Input gain (connection point) ---
        this.input = ctx.createGain();
        this.input.gain.value = 1;

        // --- SUB BUS: LR4 lowpass @ 90 Hz ---
        this.subLp1 = ctx.createBiquadFilter();
        this.subLp1.type = 'lowpass';
        this.subLp1.frequency.value = LOW_FREQ;
        this.subLp1.Q.value = 0.707;

        this.subLp2 = ctx.createBiquadFilter();
        this.subLp2.type = 'lowpass';
        this.subLp2.frequency.value = LOW_FREQ;
        this.subLp2.Q.value = 0.707;

        // --- MID BUS: LR4 highpass @ 90 Hz → LR4 lowpass @ 2 kHz ---
        this.midHp1 = ctx.createBiquadFilter();
        this.midHp1.type = 'highpass';
        this.midHp1.frequency.value = LOW_FREQ;
        this.midHp1.Q.value = 0.707;

        this.midHp2 = ctx.createBiquadFilter();
        this.midHp2.type = 'highpass';
        this.midHp2.frequency.value = LOW_FREQ;
        this.midHp2.Q.value = 0.707;

        this.midLp1 = ctx.createBiquadFilter();
        this.midLp1.type = 'lowpass';
        this.midLp1.frequency.value = HIGH_FREQ;
        this.midLp1.Q.value = 0.707;

        this.midLp2 = ctx.createBiquadFilter();
        this.midLp2.type = 'lowpass';
        this.midLp2.frequency.value = HIGH_FREQ;
        this.midLp2.Q.value = 0.707;

        // --- TOP BUS: LR4 highpass @ 2 kHz ---
        this.topHp1 = ctx.createBiquadFilter();
        this.topHp1.type = 'highpass';
        this.topHp1.frequency.value = HIGH_FREQ;
        this.topHp1.Q.value = 0.707;

        this.topHp2 = ctx.createBiquadFilter();
        this.topHp2.type = 'highpass';
        this.topHp2.frequency.value = HIGH_FREQ;
        this.topHp2.Q.value = 0.707;

        // --- Output gain nodes (connection points for downstream) ---
        this.subBusOutput = ctx.createGain();
        this.subBusOutput.gain.value = 1;

        this.midBusOutput = ctx.createGain();
        this.midBusOutput.gain.value = 1;

        this.topBusOutput = ctx.createGain();
        this.topBusOutput.gain.value = 1;

        // --- Wiring ---
        // SUB path: input → subLp1 → subLp2 → subBusOutput
        this.input.connect(this.subLp1);
        this.subLp1.connect(this.subLp2);
        this.subLp2.connect(this.subBusOutput);

        // MID path: input → midHp1 → midHp2 → midLp1 → midLp2 → midBusOutput
        this.input.connect(this.midHp1);
        this.midHp1.connect(this.midHp2);
        this.midHp2.connect(this.midLp1);
        this.midLp1.connect(this.midLp2);
        this.midLp2.connect(this.midBusOutput);

        // TOP path: input → topHp1 → topHp2 → topBusOutput
        this.input.connect(this.topHp1);
        this.topHp1.connect(this.topHp2);
        this.topHp2.connect(this.topBusOutput);
    }
}
