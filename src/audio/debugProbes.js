/**
 * Debug Probes — Real-time Web Audio PCM analysis.
 * Uses ScriptProcessorNodes running directly on the Web Audio engine thread,
 * ensuring they capture samples even during Alt+Tab, window blur, or 3D lagspikes.
 */

export function setupAudioDebugProbes(audioEngine, crossover, effects, speakerSystem) {
    const ctx = audioEngine.context;
    if (!ctx) return;

    // Helper: attach probe to an AudioNode
    function createAudioProbe(name, sourceNode, color) {
        if (!sourceNode) return;
        try {
            const sp = ctx.createScriptProcessor(2048, 1, 1);
            let lastPeak = 0;
            let lastLog = 0;

            sp.onaudioprocess = (e) => {
                const input = e.inputBuffer.getChannelData(0);
                const now = performance.now();

                let maxVal = 0;
                let maxJump = 0;
                let zeroCount = 0;

                for (let i = 0; i < input.length; i++) {
                    const sample = input[i];
                    const absVal = Math.abs(sample);
                    if (absVal > maxVal) maxVal = absVal;
                    if (absVal < 0.00001) zeroCount++;

                    if (i > 0) {
                        const jump = Math.abs(sample - input[i - 1]);
                        if (jump > maxJump) maxJump = jump;
                    }
                }

                // If not playing, reset baseline peak
                if (!audioEngine.isPlaying) {
                    lastPeak = maxVal;
                    return;
                }

                const canLog = (now - lastLog) > 300;

                // 1. Coupure nette à 0 (micro-coupure / silence inattendu en pleine lecture)
                if (lastPeak > 0.08 && zeroCount > (input.length * 0.95) && canLog) {
                    lastLog = now;
                    console.warn(
                        `%c${name} ⚠️ MICRO-COUPURE À ZÉRO DÉTECTÉE (signal tombé à 0 en plein playback)`,
                        `color: #fff; background: ${color}; font-weight: bold; padding: 2px 6px; border-radius: 3px;`
                    );
                }

                // 2. Pop / Clic anormal (saut non physique > 160% de la pleine échelle entre 2 échantillons)
                if (maxJump > 1.60 && canLog) {
                    lastLog = now;
                    console.warn(
                        `%c${name} 💥 POP / CLIC ANORMAL DÉTECTÉ (saut instantané de ${(maxJump * 100).toFixed(0)}% entre deux échantillons)`,
                        `color: #fff; background: ${color}; font-weight: bold; padding: 2px 6px; border-radius: 3px;`
                    );
                }

                // 3. Saturation / Collision plafond absolu 1.0
                if (maxVal >= 0.999 && canLog) {
                    lastLog = now;
                    if (name.includes('SOMMATION_SUB')) {
                        console.log(
                            `%c${name} 🔊 PUISSANCE ACOUSTIQUE CUMULÉE : pic = ${maxVal.toFixed(2)} (les subs s'additionnent librement)`,
                            `color: #fff; background: ${color}; font-weight: bold; padding: 2px 6px; border-radius: 3px;`
                        );
                    } else {
                        console.warn(
                            `%c${name} 🔴 SATURATION / CLIPPING FRANC (pic = ${maxVal.toFixed(3)})`,
                            `color: #fff; background: ${color}; font-weight: bold; padding: 2px 6px; border-radius: 3px;`
                        );
                    }
                }

                lastPeak = maxVal;
            };

            // In Web Audio, ScriptProcessorNode needs a connection to destination to stay alive
            const silentSink = ctx.createGain();
            silentSink.gain.value = 0;
            sourceNode.connect(sp);
            sp.connect(silentSink);
            silentSink.connect(ctx.destination);
        } catch (err) {
            console.error(`Failed to attach probe ${name}:`, err);
        }
    }

    // ─── Sonde 1 : Sortie de la source (avant crossover) ───
    createAudioProbe('[SONDE-1 : SOURCE]', crossover.input, '#0088cc');

    // ─── Sonde 2 : Sortie du filtre Crossover Sub (< 90 Hz) ───
    createAudioProbe('[SONDE-2 : XOVER_SUB]', crossover.subBusOutput, '#00a86b');

    // ─── Sonde 3 : Après effets Sub (saturation & compression sub) ───
    createAudioProbe('[SONDE-3 : EFFETS_SUB]', speakerSystem.subVolume, '#d48806');

    // ─── Sonde 4 : Sommation des 7 caissons de basse dans le Master ───
    createAudioProbe('[SONDE-4 : SOMMATION_SUB]', speakerSystem.masterOutput, '#cf1322');

    // ─── Sonde 5 : Sortie finale juste avant les écouteurs / carte son ───
    createAudioProbe('[SONDE-5 : SORTIE_FINALE]', speakerSystem.localVolumeGain, '#722ed1');

    // ─── Sonde 6 : Horloge & Buffer Web Audio (décrochage du pilote / thread audio) ───
    let lastClock = ctx.currentTime;
    let lastPerf = performance.now();
    let lastThreadLog = 0;
    setInterval(() => {
        const nowPerf = performance.now();
        const nowClock = ctx.currentTime;
        const realSec = (nowPerf - lastPerf) / 1000;
        const audioSec = nowClock - lastClock;
        lastPerf = nowPerf;
        lastClock = nowClock;

        if (audioEngine.isPlaying && realSec > 0.04) {
            const lagMs = (realSec - audioSec) * 1000;
            if (lagMs > 40 && (nowPerf - lastThreadLog > 400)) {
                lastThreadLog = nowPerf;
                console.warn(
                    `%c[SONDE-6 : PILOTE_AUDIO] ⏱️ DÉCROCHAGE BUFFER AUDIO : retard de ${lagMs.toFixed(0)} ms sur le flux audio (famine de buffer / freeze système)`,
                    'color: #fff; background: #eb2f96; font-weight: bold; padding: 2px 6px; border-radius: 3px;'
                );
            }
        }
    }, 50);

    // ─── Surveillance des événements Alt+Tab et perte de focus ───
    window.addEventListener('blur', () => {
        console.log('%c[SYS] 🖥️ Alt+Tab / Perte de focus de la fenêtre', 'color: #888; font-style: italic;');
    });
    window.addEventListener('focus', () => {
        console.log('%c[SYS] 🖥️ Retour sur la fenêtre (focus)', 'color: #888; font-style: italic;');
    });

    console.log(
        '%c[DEBUG AUDIO] ✅ Les 6 sondes audio en temps réel sont branchées et surveillent le signal.',
        'color: #52c41a; font-weight: bold; font-size: 13px;'
    );
}
