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
        this.isLocked = false;
    }

    get context() {
        return this.ctx;
    }

    init() {
        if (this.ctx) {
            if (this.ctx.state === 'suspended') this.ctx.resume();
            return this.ctx;
        }
        // 'playback' (~100-150ms buffer) : immunité totale contre les spikes GPU (rendu 3D, ombres, lasers).
        // Élimine définitivement tout grésillement/craquement matériel dans le casque.
        const urlParams = new URLSearchParams(window.location.search);
        const requestedLatency = urlParams.get('latency') || 'playback';
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioCtx({ latencyHint: requestedLatency });
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

    setAudioBuffer(audioBuffer) {
        this.buffer = audioBuffer;
        this.startOffset = 0;
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
        if (this.isLocked) return;
        if (!this.buffer || !this.ctx) return;
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
        if (destination) this._lastDestination = destination;
        const dest = destination || this._lastDestination;

        // If already playing with an active source OF THIS EXACT BUFFER, do not restart
        if (this.isPlaying && this.sourceNode && this.sourceNode.buffer === this.buffer) return;

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
        if (!this.buffer) {
            this.startOffset = Math.max(0, Number(targetTime) || 0);
            return;
        }
        const dur = this.buffer.duration;
        if (dur > 0) {
            targetTime = Math.max(0, Math.min(dur, Number(targetTime) || 0));
        } else {
            targetTime = Math.max(0, Number(targetTime) || 0);
        }
        this.startOffset = targetTime;
        if (this.isLocked) return;

        if (this.isPlaying && this.outputGain && this.ctx) {
            const now = this.ctx.currentTime;

            // ── Fade-out ultra-rapide (12ms) pour éviter tout clic brutal ──
            this.outputGain.gain.cancelScheduledValues(now);
            this.outputGain.gain.setValueAtTime(this.outputGain.gain.value, now);
            this.outputGain.gain.linearRampToValueAtTime(0, now + 0.012);

            // Conserver les références pour le timer
            const oldSources = [...this._activeSources];
            const oldSourceNode = this.sourceNode;

            // Préparer le nouveau source AVANT de supprimer l'ancien
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

            // Démarrer le nouveau source après le fade-out (12ms)
            const startAt = now + 0.013;
            src.start(startAt, this.startOffset);
            this.startTime = startAt;
            this.sourceNode = src;
            this._activeSources.add(src);

            // Fade-in immédiat sur le nouveau source
            this.outputGain.gain.setValueAtTime(0, startAt);
            this.outputGain.gain.setTargetAtTime(1.0, startAt, 0.004);

            // Couper les anciennes sources après le fade-out
            this._clearPendingStops();
            const stopTimer = setTimeout(() => {
                if (oldSourceNode && oldSourceNode !== src) {
                    oldSourceNode.onended = null;
                    try { oldSourceNode.stop(); } catch (_) {}
                    try { oldSourceNode.disconnect(); } catch (_) {}
                    this._activeSources.delete(oldSourceNode);
                }
                for (const s of oldSources) {
                    if (s !== src) {
                        s.onended = null;
                        try { s.stop(); } catch (_) {}
                        try { s.disconnect(); } catch (_) {}
                        this._activeSources.delete(s);
                    }
                }
                this._stopTimers.delete(stopTimer);
            }, 20);
            this._stopTimers.add(stopTimer);

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
