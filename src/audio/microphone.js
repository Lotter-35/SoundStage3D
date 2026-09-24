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
        this.onAudioData = null; // callback (pcmInt16, sampleRate) => void
        this.processorNode = null;
        this.dummyGain = null;
        this._silenceFrames = 0;
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

    _setupProcessor() {
        if (this.processorNode || !this.sourceNode) return;
        const bufferSize = 2048;
        this.processorNode = this.ctx.createScriptProcessor(bufferSize, 1, 1);
        this.processorNode.onaudioprocess = (e) => {
            if (!this.isActive) return;
            const input = e.inputBuffer.getChannelData(0);

            // Sous-échantillonnage 2:1 pour un transfert réseau léger (ex: 48kHz -> 24kHz)
            const targetLen = input.length >> 1;
            const pcm = new Int16Array(targetLen);
            let hasSignal = false;
            for (let i = 0, j = 0; i < input.length; i += 2, j++) {
                const s = (input[i] + input[i + 1]) * 0.5;
                if (Math.abs(s) > 0.001) hasSignal = true;
                const clamped = s < -1 ? -1 : s > 1 ? 1 : s;
                pcm[j] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
            }

            if (hasSignal) {
                this._silenceFrames = 0;
            } else {
                this._silenceFrames = (this._silenceFrames || 0) + 1;
            }

            // Envoi tant qu'il y a du signal ou pendant 6 trames (~250ms) de maintien naturel
            if (this.onAudioData && this._silenceFrames < 6) {
                const targetSampleRate = Math.floor(this.ctx.sampleRate / 2);
                this.onAudioData(pcm, targetSampleRate);
            }
        };

        this.sourceNode.connect(this.processorNode);

        // Connexion à un gain nul vers la destination pour forcer l'exécution de onaudioprocess dans Web Audio API
        this.dummyGain = this.ctx.createGain();
        this.dummyGain.gain.value = 0.0;
        this.processorNode.connect(this.dummyGain);
        this.dummyGain.connect(this.ctx.destination);
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

            // Récupération de getUserMedia (standard ou legacy)
            const getMedia = (navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
                ? (constraints) => navigator.mediaDevices.getUserMedia(constraints)
                : (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia)
                    ? (constraints) => new Promise((resolve, reject) => {
                        const legacyFn = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
                        legacyFn.call(navigator, constraints, resolve, reject);
                    })
                    : null;

            if (!getMedia) {
                if (typeof window !== 'undefined' && !window.isSecureContext) {
                    throw new Error("L'accès au microphone est bloqué car la connexion n'est pas sécurisée (HTTP). Utilisez 'localhost' ou autorisez cette IP dans les paramètres du navigateur.");
                }
                throw new Error('getUserMedia non supporté par ce navigateur ou bloqué par les paramètres.');
            }

            this.stream = await getMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: { ideal: 1 },
                },
                video: false,
            });

            this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
            this.sourceNode.connect(this.gainNode);

            this._setupProcessor();

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
        if (this.processorNode) {
            try { this.processorNode.disconnect(); } catch (_) {}
            this.processorNode.onaudioprocess = null;
            this.processorNode = null;
        }
        if (this.dummyGain) {
            try { this.dummyGain.disconnect(); } catch (_) {}
            this.dummyGain = null;
        }
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
