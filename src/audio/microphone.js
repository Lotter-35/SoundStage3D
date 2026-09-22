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
        this._currentVolume = 100;
        this.gainNode.gain.value = 0.0; // commence muet tant que non activé

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
        this._currentVolume = Math.max(0, Number(volPercent) || 0);
        if (this.gainNode && this.isActive) {
            const linear = this._currentVolume / 100;
            this.gainNode.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.01);
        }
    }

    /**
     * Active le microphone de l'utilisateur de manière fluide et continue (sans hachage).
     * @returns {Promise<boolean>}
     */
    async start() {
        if (this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }

        try {
            // Si le flux et le nœud source sont déjà initialisés, on réactive simplement le gain sans recréer le MediaStream
            if (this.stream && this.sourceNode && this.stream.active) {
                this.isActive = true;
                const linear = this._currentVolume / 100;
                this.gainNode.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.01);
                if (this.onStateChange) this.onStateChange(true);
                return true;
            }

            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('getUserMedia non supporté par ce navigateur.');
            }

            // Options audio optimales en direct continu :
            // Pas de coupures de paquets, pas d'AGC ni de noise suppression qui hachent la voix.
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    channelCount: { ideal: 1 },
                    latency: { ideal: 0.005 },
                },
                video: false,
            });

            this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
            this.sourceNode.connect(this.gainNode);

            this.isActive = true;
            const linear = this._currentVolume / 100;
            this.gainNode.gain.setTargetAtTime(linear, this.ctx.currentTime, 0.01);

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
     * Coupe le son du micro instantanément (gain à 0) tout en gardant la capture active pour éviter les artefacts de reprise.
     */
    stop() {
        this.isActive = false;
        if (this.gainNode) {
            this.gainNode.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.01);
        }
        if (this.onStateChange) {
            this.onStateChange(false);
        }
    }

    /**
     * Ferme complètement le flux matériel (si nécessaire).
     */
    dispose() {
        this.stop();
        if (this.sourceNode) {
            try { this.sourceNode.disconnect(); } catch (_) {}
            this.sourceNode = null;
        }
        if (this.stream) {
            try { this.stream.getTracks().forEach(track => track.stop()); } catch (_) {}
            this.stream = null;
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
