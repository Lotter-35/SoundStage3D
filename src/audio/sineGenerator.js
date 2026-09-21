/**
 * SineGenerator — Pure tone generator routed into the crossover input.
 * Allows sweeping frequencies from 0 Hz to 20,000 Hz.
 */
export class SineGenerator {
    /**
     * @param {AudioContext} ctx
     * @param {AudioNode} destination — crossover.input
     */
    constructor(ctx, destination) {
        this.ctx = ctx;
        this.destination = destination;
        this.oscillator = null;

        this.gainNode = ctx.createGain();
        this.gainNode.gain.value = 0.5; // default 50%
        this.gainNode.connect(destination);

        this.frequency = 440; // Hz
        this.volume = 50;     // %
        this.isPlaying = false;
    }

    /**
     * Set oscillator frequency in Hz (0 to 20000).
     * @param {number} freq
     */
    setFrequency(freq) {
        this.frequency = Math.max(0, Math.min(20000, Number(freq) || 0));
        if (this.oscillator) {
            this.oscillator.frequency.setTargetAtTime(this.frequency, this.ctx.currentTime, 0.005);
        }
    }

    /**
     * Set volume in % (0 to 100).
     * @param {number} vol
     */
    setVolume(vol) {
        this.volume = Math.max(0, Math.min(100, Number(vol) || 0));
        const gain = this.volume / 100;
        this.gainNode.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
    }

    /**
     * Start playing the sine wave.
     */
    start() {
        if (this.isPlaying) return;
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }

        this.oscillator = this.ctx.createOscillator();
        this.oscillator.type = 'sine';
        this.oscillator.frequency.setValueAtTime(this.frequency, this.ctx.currentTime);
        this.oscillator.connect(this.gainNode);

        // Gentle ramp in (10ms) to avoid click on start
        const targetGain = this.volume / 100;
        this.gainNode.gain.cancelScheduledValues(0);
        this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
        this.gainNode.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.01);

        this.oscillator.start();
        this.isPlaying = true;
    }

    /**
     * Stop playing the sine wave with a smooth fade-out.
     */
    stop() {
        if (!this.isPlaying || !this.oscillator) return;
        const osc = this.oscillator;
        this.isPlaying = false;
        this.oscillator = null;

        try {
            // Gentle ramp down (15ms) to prevent audio pop
            this.gainNode.gain.cancelScheduledValues(0);
            this.gainNode.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
            setTimeout(() => {
                try {
                    osc.stop();
                    osc.disconnect();
                } catch (_) {}
            }, 30);
        } catch (_) {
            try {
                osc.stop();
                osc.disconnect();
            } catch (_) {}
        }
    }

    toggle() {
        if (this.isPlaying) this.stop();
        else this.start();
        return this.isPlaying;
    }
}
