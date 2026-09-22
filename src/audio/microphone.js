/**
 * MicrophoneInput — Capture du microphone en direct avec Web Audio API.
 * Le flux capturé est routé vers l'étage d'entrée DSP (`InputStage`),
 * ce qui permet à la voix de traverser l'Auto-gain, l'EQ, le compresseur,
 * le limiteur, le crossover multibande et les spatialisateurs 3D.
 */
export class MicrophoneInput {
    /**
     * @param {AudioContext} ctx
     * @param {AudioNode} destinationNode — Noeud cible où injecter le microphone (InputStage.input)
     */
    constructor(ctx, destinationNode) {
        this.ctx = ctx;
        this.destinationNode = destinationNode;

        this.stream = null;
        this.sourceNode = null;
        this.gainNode = ctx.createGain();
        this.gainNode.gain.value = 1.0; // 100% par défaut
        this.gainNode.connect(this.destinationNode);

        this.isActive = false;
        this.onError = null;
        this.onStateChange = null;
    }

    /**
     * Règle le volume du microphone en pourcentage (0 à 200%).
     * @param {number} volPercent
     */
    setVolume(volPercent) {
        const linear = Math.max(0, Number(volPercent) || 0) / 100;
        if (this.gainNode) {
            this.gainNode.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.02);
        }
    }

    /**
     * Active le microphone de l'utilisateur.
     * @returns {Promise<boolean>}
     */
    async start() {
        if (this.isActive) return true;

        if (this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }

        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('getUserMedia non supporté par ce navigateur.');
            }

            // Options audio optimales pour le micro en direct (désactivation de l'écho-annulation agressive si souhaité, mais utile pour éviter le larsen casque/enceintes)
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
                video: false,
            });

            this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
            this.sourceNode.connect(this.gainNode);

            this.isActive = true;
            if (this.onStateChange) this.onStateChange(true);
            return true;
        } catch (err) {
            console.error('Erreur accès microphone:', err);
            this.stop();
            if (this.onError) this.onError(err);
            return false;
        }
    }

    /**
     * Coupe et libère le microphone.
     */
    stop() {
        if (this.sourceNode) {
            try {
                this.sourceNode.disconnect();
            } catch (_) {}
            this.sourceNode = null;
        }

        if (this.stream) {
            try {
                this.stream.getTracks().forEach(track => track.stop());
            } catch (_) {}
            this.stream = null;
        }

        const wasActive = this.isActive;
        this.isActive = false;
        if (wasActive && this.onStateChange) {
            this.onStateChange(false);
        }
    }

    /**
     * Alterne l'état actif / inactif du micro.
     * @returns {Promise<boolean>}
     */
    async toggle() {
        if (this.isActive) {
            this.stop();
            return false;
        } else {
            return await this.start();
        }
    }
}
