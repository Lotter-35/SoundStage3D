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

    init() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
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

        this.sourceNode = this.ctx.createBufferSource();
        this.sourceNode.buffer = this.buffer;
        this.sourceNode.loop = true;
        this.sourceNode.connect(destination);

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
        if (!this.isPlaying) return;
        this.startOffset += this.ctx.currentTime - this.startTime;
        this.sourceNode.stop();
        this.sourceNode.disconnect();
        this.sourceNode = null;
        this.isPlaying = false;
    }

    stop() {
        if (this.sourceNode) {
            this.sourceNode.stop();
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }
        this.isPlaying = false;
        this.startOffset = 0;
    }

    get context() {
        return this.ctx;
    }
}
