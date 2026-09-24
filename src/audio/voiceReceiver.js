/**
 * VoiceReceiver.js — Réception et lecture en temps réel de la voix des autres joueurs.
 * 
 * Reçoit les paquets PCM 16-bit compressés transmis par WebSocket,
 * les convertit en Float32 et planifie leur lecture fluide sans coupure
 * (jitter buffer adaptatif ~40ms) directement dans l'étage micro (InputStage.micGainNode).
 */
export class VoiceReceiver {
    /**
     * @param {AudioContext} ctx
     * @param {AudioNode} destinationNode — Noeud cible (ex: inputStage.micGainNode)
     */
    constructor(ctx, destinationNode) {
        this.ctx = ctx;
        this.destinationNode = destinationNode;
        /** @type {Map<string, { nextPlayTime: number, gainNode: GainNode, lastPacketTime: number }>} */
        this.peers = new Map();
    }

    /**
     * Reçoit et joue un chunk de voix d'un pair.
     * @param {string} peerId — Identifiant du joueur émetteur
     * @param {number} sampleRate — Fréquence d'échantillonnage (ex: 24000 Hz)
     * @param {Int16Array} pcmInt16 — Échantillons PCM 16-bit
     */
    receive(peerId, sampleRate, pcmInt16) {
        if (!pcmInt16 || pcmInt16.length === 0 || !this.ctx) return;

        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }

        let peer = this.peers.get(peerId);
        if (!peer) {
            const gainNode = this.ctx.createGain();
            gainNode.gain.value = 1.5; // Gain adapté pour que la voix perce clairement dans le mix des enceintes de festival
            if (this.destinationNode) {
                gainNode.connect(this.destinationNode);
            }
            peer = { nextPlayTime: 0, gainNode, lastPacketTime: 0 };
            this.peers.set(peerId, peer);
        }

        peer.lastPacketTime = Date.now();

        // Conversion Int16 vers Float32 (-1.0 à +1.0)
        const numSamples = pcmInt16.length;
        const floatData = new Float32Array(numSamples);
        for (let i = 0; i < numSamples; i++) {
            floatData[i] = pcmInt16[i] / 32768.0;
        }

        // Création de l'AudioBuffer
        const buffer = this.ctx.createBuffer(1, numSamples, sampleRate);
        buffer.copyToChannel(floatData, 0);

        const now = this.ctx.currentTime;

        // Gestion du jitter buffer adaptatif :
        // 1. Si le buffer a expiré (début de parole ou micro-coupure réseau) :
        //    on planifie à now + 40ms pour absorber les variations de latence.
        if (peer.nextPlayTime < now + 0.02) {
            peer.nextPlayTime = now + 0.04;
        }
        // 2. Si le buffer s'est trop éloigné dans le futur (> 200ms de retard accumulé) :
        //    on recalibre à now + 50ms pour retrouver le temps réel.
        else if (peer.nextPlayTime > now + 0.20) {
            peer.nextPlayTime = now + 0.05;
        }

        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(peer.gainNode);
        source.start(peer.nextPlayTime);

        peer.nextPlayTime += buffer.duration;
    }

    /**
     * Supprime les ressources audio d'un joueur déconnecté.
     * @param {string} peerId
     */
    removePeer(peerId) {
        const peer = this.peers.get(peerId);
        if (peer) {
            try { peer.gainNode.disconnect(); } catch (_) {}
            this.peers.delete(peerId);
        }
    }

    /**
     * Libère toutes les connexions.
     */
    dispose() {
        for (const [peerId, peer] of this.peers) {
            try { peer.gainNode.disconnect(); } catch (_) {}
        }
        this.peers.clear();
    }
}
