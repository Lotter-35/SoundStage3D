/**
 * AudioEngine — Core audio context, file loading, playback control.
 */
export class AudioEngine {
    constructor() {
        this.ctx = null;
        this.buffer = null;
        this.sourceNode = null;
        this.outputGain = null;
        this.isPlaying = false;
        this.startOffset = 0;
        this.startTime = 0;
        this._lastDestination = null;
        this._activeSources = new Set();
        this._stopTimers = new Set();
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

    _clearPendingStops() {
        for (const timer of this._stopTimers) {
            clearTimeout(timer);
        }
        this._stopTimers.clear();
    }

    _killSource(src) {
        if (!src) return;
        src.onended = null;
        try {
            src.stop();
        } catch (_) {}
        try {
            src.disconnect();
        } catch (_) {}
        this._activeSources.delete(src);
    }

    _killAllSources() {
        this._clearPendingStops();
        if (this.sourceNode) {
            this._killSource(this.sourceNode);
            this.sourceNode = null;
        }
        for (const src of this._activeSources) {
            this._killSource(src);
        }
        this._activeSources.clear();
    }

    /**
     * Create and start a new source node. Connect it to the given destination.
     * @param {AudioNode} destination — first node in the DSP chain (crossover input)
     */
    play(destination) {
        if (!this.buffer || !this.ctx) return;
        if (destination) this._lastDestination = destination;
        const dest = destination || this._lastDestination;

        // If already playing with an active source, do not start a duplicate
        if (this.isPlaying && this.sourceNode) return;

        // Ensure all previous sources (fading or stale) are completely terminated
        this._killAllSources();

        if (!this.outputGain) {
            this.outputGain = this.ctx.createGain();
        }
        try { this.outputGain.disconnect(); } catch (_) {}
        if (dest) {
            this.outputGain.connect(dest);
        }

        // Smooth fade-in (10ms) to prevent starting click
        const now = this.ctx.currentTime;
        this.outputGain.gain.cancelScheduledValues(0);
        this.outputGain.gain.setValueAtTime(0, now);
        this.outputGain.gain.setTargetAtTime(1.0, now, 0.004);

        const src = this.ctx.createBufferSource();
        src.buffer = this.buffer;
        src.loop = true;
        src.connect(this.outputGain);

        src.onended = () => {
            this._activeSources.delete(src);
            // Only update isPlaying if this is still the active source
            if (this.sourceNode === src) {
                this.sourceNode = null;
                this.isPlaying = false;
            }
        };

        this.sourceNode = src;
        this._activeSources.add(src);

        // Normalize start offset within buffer bounds
        if (this.buffer.duration > 0) {
            this.startOffset = this.startOffset % this.buffer.duration;
            if (this.startOffset < 0) this.startOffset = 0;
        }

        src.start(0, this.startOffset);
        this.startTime = this.ctx.currentTime;
        this.isPlaying = true;
    }

    pause() {
        if (!this.isPlaying && !this.sourceNode) return;
        const now = this.ctx.currentTime;
        if (this.isPlaying) {
            this.startOffset += now - this.startTime;
            if (this.buffer && this.buffer.duration > 0) {
                this.startOffset = this.startOffset % this.buffer.duration;
                if (this.startOffset < 0) this.startOffset = 0;
            }
        }
        this.isPlaying = false;

        const src = this.sourceNode;
        this.sourceNode = null;

        // Smooth de-click fade-out (15ms)
        if (this.outputGain) {
            this.outputGain.gain.cancelScheduledValues(0);
            this.outputGain.gain.setTargetAtTime(0, now, 0.003);
        }

        if (src) {
            src.onended = null;
            const timer = setTimeout(() => {
                this._killSource(src);
                this._stopTimers.delete(timer);
            }, 20);
            this._stopTimers.add(timer);
        }
    }

    stop() {
        const now = this.ctx ? this.ctx.currentTime : 0;
        this.isPlaying = false;
        this.startOffset = 0;

        if (this.outputGain && this.ctx) {
            this.outputGain.gain.cancelScheduledValues(0);
            this.outputGain.gain.setTargetAtTime(0, now, 0.003);
        }

        this._killAllSources();
    }

    seek(targetTime) {
        if (!this.buffer) return;
        const dur = this.buffer.duration;
        if (dur > 0) {
            targetTime = Math.max(0, Math.min(dur, Number(targetTime) || 0));
        } else {
            targetTime = Math.max(0, Number(targetTime) || 0);
        }
        this.startOffset = targetTime;

        if (this.isPlaying && this.outputGain) {
            // Kill existing sources immediately
            this._killAllSources();

            const src = this.ctx.createBufferSource();
            src.buffer = this.buffer;
            src.loop = true;
            src.connect(this.outputGain);

            src.onended = () => {
                this._activeSources.delete(src);
                if (this.sourceNode === src) {
                    this.sourceNode = null;
                    this.isPlaying = false;
                }
            };

            this.sourceNode = src;
            this._activeSources.add(src);

            src.start(0, this.startOffset);
            this.startTime = this.ctx.currentTime;
            this.isPlaying = true;
        }
    }

    getCurrentTime() {
        if (!this.buffer) return 0;
        const dur = this.buffer.duration;
        if (!dur || dur <= 0) return 0;
        if (this.isPlaying && this.ctx) {
            const elapsed = this.ctx.currentTime - this.startTime;
            const t = (this.startOffset + elapsed) % dur;
            return t < 0 ? 0 : t;
        }
        const t = this.startOffset % dur;
        return t < 0 ? 0 : t;
    }

    getDuration() {
        return this.buffer ? this.buffer.duration : 0;
    }
}
