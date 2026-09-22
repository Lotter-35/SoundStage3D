/**
 * AudioEngine — Core audio context, file loading, playback control.
 */
export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.buffer = null;
        this.sourceNode = null;
        this.isPlaying = false;
        this.startOffset = 0;
        this.startTime = 0;
    }

    get context() {
        return this.ctx;
    }

    init() {
        if (this.ctx) {
            if (this.ctx.state === 'suspended') this.ctx.resume();
            return this.ctx;
        }
        // 'playback' hint ensures a larger hardware buffer to resist 3D lagspikes without dropouts
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioCtx({ latencyHint: 'playback' });
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
        return this.ctx;
    }

    async loadFile(file) {
        const arrayBuffer = await file.arrayBuffer();
        this.buffer = await this.ctx.decodeAudioData(arrayBuffer);
        return this.buffer;
    }

    /**
     * Create and start a new source node. Connect it to the given destination.
     * @param {AudioNode} destination — first node in the DSP chain (crossover input)
     */
    play(destination) {
        if (this.isPlaying) return;
        if (!this.buffer) return;

        if (!this.outputGain) {
            this.outputGain = this.ctx.createGain();
        }
        try { this.outputGain.disconnect(); } catch (_) {}
        this.outputGain.connect(destination);

        // Smooth fade-in (10ms) to prevent starting click, full 1.0 output
        const now = this.ctx.currentTime;
        this.outputGain.gain.cancelScheduledValues(0);
        this.outputGain.gain.setValueAtTime(0, now);
        this.outputGain.gain.setTargetAtTime(1.0, now, 0.004);

        this.sourceNode = this.ctx.createBufferSource();
        this.sourceNode.buffer = this.buffer;
        this.sourceNode.loop = true;
        this.sourceNode.connect(this.outputGain);

        this.sourceNode.start(0, this.startOffset);
        this.startTime = this.ctx.currentTime;
        this.isPlaying = true;

        this.sourceNode.onended = () => {
            if (this.isPlaying) {
                // Looping — should not fire, but safety net
                this.isPlaying = false;
            }
        };
    }

    pause() {
        if (!this.isPlaying || !this.sourceNode) return;
        const now = this.ctx.currentTime;
        this.startOffset += now - this.startTime;
        this.isPlaying = false;
        const src = this.sourceNode;
        this.sourceNode = null;

        // Smooth de-click fade-out (15ms)
        if (this.outputGain) {
            this.outputGain.gain.cancelScheduledValues(0);
            this.outputGain.gain.setTargetAtTime(0, now, 0.003);
        }

        setTimeout(() => {
            try {
                src.stop();
                src.disconnect();
            } catch (_) {}
        }, 20);
    }

    stop() {
        if (!this.sourceNode) {
            this.isPlaying = false;
            this.startOffset = 0;
            return;
        }
        const now = this.ctx.currentTime;
        this.isPlaying = false;
        this.startOffset = 0;
        const src = this.sourceNode;
        this.sourceNode = null;

        if (this.outputGain) {
            this.outputGain.gain.cancelScheduledValues(0);
            this.outputGain.gain.setTargetAtTime(0, now, 0.003);
        }

        setTimeout(() => {
            try {
                src.stop();
                src.disconnect();
            } catch (_) {}
        }, 20);
    }

    get context() {
        return this.ctx;
    }
}
