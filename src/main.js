/**
 * main.js — Entry point. Orchestrates Three.js scene, audio engine, and render loop.
 */
import * as THREE from 'three';

import { createStage } from './scene/stage.js';
import { Listener } from './scene/listener.js';
import { createSkybox, updateSkybox } from './scene/skybox.js';
import { createVegetation, updateVegetation, setGrassQuality } from './scene/vegetation.js?v=2';

import { AudioEngine } from './audio/audioEngine.js';
import { Crossover } from './audio/crossover.js';
import { SpeakerSystem } from './audio/speakers.js';
import { createSaturation, createCompressor } from './audio/effects.js';
import { SineGenerator } from './audio/sineGenerator.js';
import { InputStage } from './audio/inputStage.js';

import { Controls } from './ui/controls.js';
import { makeDraggable } from './ui/draggable.js';
import { DSP_DEFAULTS } from './config/dsp-defaults.js';
import { saveLastAudio, loadLastAudio } from './audio/audioStorage.js';
import { setupAudioDebugProbes } from './audio/debugProbes.js';

// ─── Three.js setup ──────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

// Build 3D stage
const { coneContainer, coneGroups, dirLight } = createStage(scene);

// ─── Skybox ───────────────────────────────────────────────────────
// Fond couleur fallback (avant que le GLB soit prêt)
scene.background = new THREE.Color(0x87ceeb);
let skybox = null;
skybox = await createSkybox(scene);

// ─── Vegetation (instanced grass) ────────────────────────────────
await createVegetation(scene);

// ─── Listener (FPS controls + 3D Animated Character) ─────────────
const listener = new Listener(camera, document.body, scene);

// ─── Audio ───────────────────────────────────────────────────────
const audioEngine = new AudioEngine();
let inputStage = null;
let crossover = null;
let speakerSystem = null;
let sineGenerator = null;
let _musicWasPlayingBeforeSine = false;
let _currentAudioFileName = '';
let effects = null; // keep reference to prevent GC
let audioReady = false;

// ─── UI ──────────────────────────────────────────────────────────
// ─── UI ──────────────────────────────────────────────────────────
const controls = new Controls();

async function initAudio(file = null) {
    if (audioReady) {
        if (file) {
            _currentAudioFileName = file.name;
            if (controls.state.sine.active) {
                controls.setSineActive(false);
                if (sineGenerator) sineGenerator.stop();
            }
            _musicWasPlayingBeforeSine = false;
            audioEngine.stop();
            await audioEngine.loadFile(file);
            if (inputStage) inputStage.analyzeBuffer(audioEngine.buffer);
            audioEngine.play(inputStage ? inputStage.input : crossover.input);
            controls.setPlayState(true);
            const np = document.getElementById('now-playing');
            if (np) np.textContent = file.name;
        }
        return;
    }

    // Init audio context
    const ctx = audioEngine.init();

    if (file) {
        _currentAudioFileName = file.name;
        await audioEngine.loadFile(file);
    }

    // Build Input Stage (Normalisation LUFS, Trim, EQ 3 bandes, Compresseur, Limiteur)
    inputStage = new InputStage(ctx);
    inputStage.onAnalysisUpdate(data => controls.updateInputAnalysis(data));
    if (audioEngine.buffer) {
        inputStage.analyzeBuffer(audioEngine.buffer);
    }

    // Build DSP graph
    crossover = new Crossover(ctx, {
        lowFreq: DSP_DEFAULTS.sub['xover-freq'],
        highFreq: DSP_DEFAULTS.mid['xover-high'] ?? DSP_DEFAULTS.top['xover-freq'],
    });

    // Connect InputStage output to Crossover input
    inputStage.output.connect(crossover.input);

    const subComp = createCompressor(ctx, {
        threshold: DSP_DEFAULTS.sub['comp-threshold'],
        knee:      DSP_DEFAULTS.sub['comp-knee'],
        ratio:     DSP_DEFAULTS.sub['comp-ratio'],
        attack:    DSP_DEFAULTS.sub['comp-attack'],
        release:   DSP_DEFAULTS.sub['comp-release'],
    });
    const subSat = createSaturation(ctx, {
        drive: DSP_DEFAULTS.sub['sat-drive'],
        mix:   DSP_DEFAULTS.sub['sat-mix'],
    });
    const midComp = createCompressor(ctx, {
        threshold: DSP_DEFAULTS.mid['comp-threshold'],
        knee:      DSP_DEFAULTS.mid['comp-knee'],
        ratio:     DSP_DEFAULTS.mid['comp-ratio'],
        attack:    DSP_DEFAULTS.mid['comp-attack'],
        release:   DSP_DEFAULTS.mid['comp-release'],
    });
    const midSat = createSaturation(ctx, {
        drive: DSP_DEFAULTS.mid['sat-drive'],
        mix:   DSP_DEFAULTS.mid['sat-mix'],
    });
    const topComp = createCompressor(ctx, {
        threshold: DSP_DEFAULTS.top['comp-threshold'],
        knee:      DSP_DEFAULTS.top['comp-knee'],
        ratio:     DSP_DEFAULTS.top['comp-ratio'],
        attack:    DSP_DEFAULTS.top['comp-attack'],
        release:   DSP_DEFAULTS.top['comp-release'],
    });
    const topSat = createSaturation(ctx, {
        drive: DSP_DEFAULTS.top['sat-drive'],
        mix:   DSP_DEFAULTS.top['sat-mix'],
    });
    effects = { subComp, subSat, midComp, midSat, topComp, topSat };

    speakerSystem = new SpeakerSystem(
        ctx,
        crossover.subBusOutput,
        crossover.midBusOutput,
        crossover.topBusOutput,
        effects
    );

    // Tone Generator routed into InputStage input
    sineGenerator = new SineGenerator(ctx, inputStage.input);
    sineGenerator.setFrequency(controls.state.sine.frequency);
    sineGenerator.setVolume(controls.state.sine.volume);

    audioReady = true;
    window.__DEBUG = { audioEngine, speakerSystem, listener, sineGenerator, camera, inputStage };

    // Apply initial bus volumes from config
    speakerSystem.setBusVolume('sub', DSP_DEFAULTS.sub['bus-volume'] / 100);
    speakerSystem.setBusVolume('mid', DSP_DEFAULTS.mid['bus-volume'] / 100);
    speakerSystem.setBusVolume('top', DSP_DEFAULTS.top['bus-volume'] / 100);
    speakerSystem.setBusVolume('fill', DSP_DEFAULTS.fill['bus-volume'] / 100);

    // Initialisation des sondes de diagnostic en temps réel
    setupAudioDebugProbes(audioEngine, crossover, effects, speakerSystem);

    if (file) {
        audioEngine.play(inputStage.input);
        controls.setPlayState(true);
        const np = document.getElementById('now-playing');
        if (np) np.textContent = file.name;
    } else {
        controls.setPlayState(false);
    }
}

// Initialise audio et HUD directement dès le chargement
controls.showHUD();

let savedAudioFile = null;
try {
    savedAudioFile = await loadLastAudio();
} catch (err) {
    console.warn('Failed to load saved audio from IndexedDB:', err);
}

try {
    await initAudio(savedAudioFile);
} catch (err) {
    console.warn('Failed to initialize audio with saved file:', err);
    if (!audioReady) await initAudio(null);
}

// Déverrouillage automatique du contexte audio sur la première interaction
const unlockAudioContext = () => {
    if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
        audioEngine.ctx.resume();
    }
};
window.addEventListener('keydown', unlockAudioContext);
window.addEventListener('pointerdown', unlockAudioContext);
window.addEventListener('click', unlockAudioContext);

// Synchronisation du mode caméra avec le HUD
controls.onCameraToggle(() => {
    listener.cycleCameraMode();
});
listener.onCameraModeChange((mode, isFlying) => {
    controls.setCameraModeLabel(mode, isFlying);
});
controls.setCameraModeLabel(listener.cameraMode, listener.isFlying);
listener.setSensitivity((controls.state.user?.['mouse-sensitivity'] ?? 100) / 100);
listener.setInvertPitch(controls.state.user?.['invert-y'] ?? false);
listener.setInvertYaw(controls.state.user?.['invert-x'] ?? false);

controls.onEnter(async (file) => {
    await initAudio(file);
    listener.lock();
    if (file) saveLastAudio(file);
});

controls.onPlayPause(() => {
    if (!audioReady) return;
    // If sine generator mode is active
    if (controls.state.sine.active && sineGenerator) {
        if (sineGenerator.isPlaying) {
            sineGenerator.stop();
            controls.setPlayState(false);
        } else {
            sineGenerator.start();
            controls.setPlayState(true);
        }
        return;
    }

    if (audioEngine.isPlaying) {
        audioEngine.pause();
        controls.setPlayState(false);
    } else {
        audioEngine.play(inputStage ? inputStage.input : crossover.input);
        controls.setPlayState(true);
    }
});

controls.onSeek((targetTime) => {
    if (!audioReady) return;
    audioEngine.seek(targetTime);
});

controls.onSkip((deltaSec) => {
    if (!audioReady) return;
    audioEngine.seek(audioEngine.getCurrentTime() + deltaSec);
});

controls.onPrev(() => {
    if (!audioReady) return;
    audioEngine.seek(0);
});

controls.onNext(() => {
    if (!audioReady) return;
    // Loop back to start since there is only one track currently loaded
    audioEngine.seek(0);
});

controls.onSineToggle((active) => {
    if (!audioReady || !sineGenerator) return;
    const np = document.getElementById('now-playing');
    if (active) {
        if (audioEngine.isPlaying) {
            _musicWasPlayingBeforeSine = true;
            audioEngine.pause();
        } else {
            _musicWasPlayingBeforeSine = false;
        }
        sineGenerator.start();
        controls.setPlayState(true);
        if (np) np.textContent = `🔊 Sinus : ${controls.state.sine.frequency} Hz`;
    } else {
        sineGenerator.stop();
        if (_musicWasPlayingBeforeSine) {
            audioEngine.play(inputStage ? inputStage.input : crossover.input);
            controls.setPlayState(true);
            if (np) np.textContent = _currentAudioFileName;
        } else {
            controls.setPlayState(false);
            controls.resetMeters();
            if (np) np.textContent = _currentAudioFileName ? `⏸ ${_currentAudioFileName}` : '';
        }
    }
});

controls.onSineFrequency((freq) => {
    if (!sineGenerator) return;
    sineGenerator.setFrequency(freq);
    if (sineGenerator.isPlaying) {
        const np = document.getElementById('now-playing');
        if (np) np.textContent = `🔊 Sinus : ${freq} Hz`;
    }
});

controls.onSineVolume((vol) => {
    if (!sineGenerator) return;
    sineGenerator.setVolume(vol);
});

controls.onChangeMp3(async (file) => {
    if (!audioReady) return;
    if (controls.state.sine.active) {
        controls.setSineActive(false);
        if (sineGenerator) sineGenerator.stop();
    }
    _musicWasPlayingBeforeSine = false;
    _currentAudioFileName = file.name;
    audioEngine.stop();
    await audioEngine.loadFile(file);
    if (inputStage) inputStage.analyzeBuffer(audioEngine.buffer);
    audioEngine.play(inputStage ? inputStage.input : crossover.input);
    controls.setPlayState(true);
    const np = document.getElementById('now-playing');
    if (np) np.textContent = file.name;
    saveLastAudio(file);
});

// Drag & drop support anywhere on the page
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && (file.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a)$/i.test(file.name))) {
        if (controls.state.sine.active) {
            controls.setSineActive(false);
            if (sineGenerator) sineGenerator.stop();
        }
        _musicWasPlayingBeforeSine = false;
        _currentAudioFileName = file.name;
        if (!audioReady) {
            await initAudio(file);
        } else {
            audioEngine.stop();
            await audioEngine.loadFile(file);
            if (inputStage) inputStage.analyzeBuffer(audioEngine.buffer);
            audioEngine.play(inputStage ? inputStage.input : crossover.input);
            controls.setPlayState(true);
            const np = document.getElementById('now-playing');
            if (np) np.textContent = file.name;
        }
        saveLastAudio(file);
    }
});


controls.onGrassChange((distance) => {
    setGrassQuality(distance);
});

// ─── Camera View HUD Toggle is handled via controls.onCameraToggle and listener.cycleCameraMode ───

// ─── FFT Frequency Spectrum Visualizer (Headphone Output) ───
const spectrumCanvas = document.getElementById('spectrum-visualizer');
const spectrumCtx = spectrumCanvas ? spectrumCanvas.getContext('2d') : null;
let spectrumRunning = false;
let spectrumAnimId = null;

function spectrumStart() {
    if (!audioReady || !spectrumCanvas || !spectrumCtx) return;
    spectrumCanvas.classList.remove('hidden');
    const analyser = speakerSystem.getHeadphoneAnalyser();
    const binCount = analyser.frequencyBinCount;
    const freqData = new Float32Array(binCount);
    const sampleRate = speakerSystem.ctx.sampleRate;
    const W = spectrumCanvas.width;
    const H = spectrumCanvas.height;

    // Peak hold memory for each horizontal pixel column
    const peakY = new Float32Array(W).fill(H);
    const peakDecaySpeed = 0.6; // pixels dropped per frame

    spectrumRunning = true;

    // Precalculate frequency for each pixel column (logarithmic: 20 Hz to 20 kHz)
    const minFreq = 20;
    const maxFreq = 20000;
    const logMin = Math.log10(minFreq);
    const logMax = Math.log10(maxFreq);
    const logRange = logMax - logMin;

    const colFreqs = new Float32Array(W);
    const colBins = new Float32Array(W);
    for (let x = 0; x < W; x++) {
        const f = minFreq * Math.pow(maxFreq / minFreq, x / (W - 1));
        colFreqs[x] = f;
        colBins[x] = (f * analyser.fftSize) / sampleRate;
    }

    // Grid frequencies to label
    const gridFreqs = [
        { f: 20, label: '20' },
        { f: 50, label: '50' },
        { f: 100, label: '100' },
        { f: 250, label: '250' },
        { f: 500, label: '500' },
        { f: 1000, label: '1k' },
        { f: 2000, label: '2k' },
        { f: 5000, label: '5k' },
        { f: 10000, label: '10k' },
        { f: 20000, label: '20k' },
    ];

    // Additional intermediate ticks without labels
    const tickFreqs = [
        30, 40, 60, 70, 80, 90,
        150, 200, 300, 400, 600, 700, 800, 900,
        1500, 3000, 4000, 6000, 7000, 8000, 9000,
        12000, 15000, 18000
    ];

    // dB grid lines (-84 dB to 0 dB)
    const minDb = -84;
    const maxDb = 0;
    const dbRange = maxDb - minDb;
    const gridDbs = [0, -12, -24, -36, -48, -60, -72];

    const paddingTop = 24;
    const paddingBottom = 20;
    const usableH = H - paddingTop - paddingBottom;

    function draw() {
        if (!spectrumRunning) return;
        spectrumAnimId = requestAnimationFrame(draw);

        analyser.getFloatFrequencyData(freqData);

        spectrumCtx.clearRect(0, 0, W, H);

        // 1. Draw horizontal dB grid lines & labels
        spectrumCtx.lineWidth = 1;
        spectrumCtx.font = '9px monospace';
        for (const db of gridDbs) {
            const normY = (maxDb - db) / dbRange;
            const y = paddingTop + normY * usableH;

            spectrumCtx.strokeStyle = db === 0 ? 'rgba(255, 70, 70, 0.45)' : 'rgba(255, 255, 255, 0.08)';
            spectrumCtx.beginPath();
            spectrumCtx.moveTo(0, y);
            spectrumCtx.lineTo(W, y);
            spectrumCtx.stroke();

            spectrumCtx.fillStyle = db === 0 ? 'rgba(255, 90, 90, 0.7)' : 'rgba(255, 255, 255, 0.30)';
            spectrumCtx.textAlign = 'right';
            spectrumCtx.fillText(`${db} dB`, W - 6, y - 3);
        }

        // 2. Draw vertical frequency ticks & grid lines
        for (const tf of tickFreqs) {
            const x = ((Math.log10(tf) - logMin) / logRange) * W;
            spectrumCtx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
            spectrumCtx.beginPath();
            spectrumCtx.moveTo(x, paddingTop);
            spectrumCtx.lineTo(x, H - paddingBottom);
            spectrumCtx.stroke();
        }

        for (const gf of gridFreqs) {
            const x = ((Math.log10(gf.f) - logMin) / logRange) * W;
            spectrumCtx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            spectrumCtx.beginPath();
            spectrumCtx.moveTo(x, paddingTop);
            spectrumCtx.lineTo(x, H - paddingBottom);
            spectrumCtx.stroke();

            spectrumCtx.fillStyle = 'rgba(255, 255, 255, 0.50)';
            spectrumCtx.textAlign = 'center';
            spectrumCtx.fillText(gf.label, x, H - 6);
        }

        // 3. Compute spectrum Y coordinates across pixel columns
        let peakMaxDb = -120;
        let peakMaxFreq = 0;
        const colY = new Float32Array(W);

        for (let x = 0; x < W; x++) {
            const binFloat = colBins[x];
            const bin0 = Math.max(0, Math.min(binCount - 1, Math.floor(binFloat)));
            const bin1 = Math.min(binCount - 1, bin0 + 1);
            const frac = binFloat - bin0;

            const val = freqData[bin0] * (1 - frac) + freqData[bin1] * frac;
            if (val > peakMaxDb) {
                peakMaxDb = val;
                peakMaxFreq = colFreqs[x];
            }

            const clampedVal = Math.max(minDb, Math.min(maxDb, val));
            const normY = (maxDb - clampedVal) / dbRange;
            colY[x] = paddingTop + normY * usableH;

            // Update peak-hold line
            if (colY[x] < peakY[x]) {
                peakY[x] = colY[x];
            } else {
                peakY[x] = Math.min(H - paddingBottom, peakY[x] + peakDecaySpeed);
            }
        }

        // 4. Draw filled spectrum area with luminous multi-stop vertical gradient
        const grad = spectrumCtx.createLinearGradient(0, paddingTop, 0, H - paddingBottom);
        grad.addColorStop(0.00, 'rgba(0, 245, 255, 0.50)');  // Neon cyan
        grad.addColorStop(0.30, 'rgba(0, 160, 255, 0.35)');  // Electric blue
        grad.addColorStop(0.70, 'rgba(140, 50, 255, 0.20)'); // Electric violet
        grad.addColorStop(1.00, 'rgba(10, 15, 30, 0.02)');   // Transparent deep

        spectrumCtx.beginPath();
        spectrumCtx.moveTo(0, H - paddingBottom);
        for (let x = 0; x < W; x++) {
            spectrumCtx.lineTo(x, colY[x]);
        }
        spectrumCtx.lineTo(W, H - paddingBottom);
        spectrumCtx.closePath();
        spectrumCtx.fillStyle = grad;
        spectrumCtx.fill();

        // 5. Draw peak hold line
        spectrumCtx.beginPath();
        spectrumCtx.strokeStyle = 'rgba(255, 215, 60, 0.65)';
        spectrumCtx.lineWidth = 1.2;
        for (let x = 0; x < W; x++) {
            if (x === 0) spectrumCtx.moveTo(x, peakY[x]);
            else spectrumCtx.lineTo(x, peakY[x]);
        }
        spectrumCtx.stroke();

        // 6. Draw bright spectrum top stroke line
        spectrumCtx.beginPath();
        spectrumCtx.strokeStyle = '#00f0ff';
        spectrumCtx.lineWidth = 1.8;
        spectrumCtx.shadowColor = '#00f0ff';
        spectrumCtx.shadowBlur = 4;
        for (let x = 0; x < W; x++) {
            if (x === 0) spectrumCtx.moveTo(x, colY[x]);
            else spectrumCtx.lineTo(x, colY[x]);
        }
        spectrumCtx.stroke();
        spectrumCtx.shadowBlur = 0; // reset shadow

        // 7. Title badge & Peak readout
        spectrumCtx.fillStyle = '#00e5ff';
        spectrumCtx.font = 'bold 10px "SF Mono", monospace';
        spectrumCtx.textAlign = 'left';
        spectrumCtx.fillText('📊 RTA FFT • SORTIE CASQUE', 8, 15);

        if (peakMaxDb > -80) {
            const freqFmt = peakMaxFreq >= 1000 ? `${(peakMaxFreq / 1000).toFixed(1)} kHz` : `${Math.round(peakMaxFreq)} Hz`;
            spectrumCtx.fillStyle = '#ffdf60';
            spectrumCtx.textAlign = 'right';
            spectrumCtx.fillText(`Pic : ${freqFmt} (${peakMaxDb.toFixed(1)} dB)`, W - 60, 15);
        }
    }

    draw();
}

function spectrumStop() {
    spectrumRunning = false;
    if (spectrumAnimId) cancelAnimationFrame(spectrumAnimId);
    if (spectrumCanvas) spectrumCanvas.classList.add('hidden');
}

controls.onSpectrumToggle((enabled) => {
    if (enabled) spectrumStart(); else spectrumStop();
});

controls.onHrtfToggle((enabled) => {
    if (!audioReady) return;
    speakerSystem.setPanningModel(enabled ? 'HRTF' : 'equalpower');
});

controls.onHrtfBrightness((db) => {
    if (!audioReady) return;
    speakerSystem.setHrtfBrightness(db);
});

controls.onConesToggle((bus, visible) => {
    if (bus === 'all') {
        coneContainer.visible = visible;
        for (const g of Object.values(coneGroups)) g.visible = visible;
    } else if (coneGroups[bus]) {
        coneGroups[bus].visible = visible;
        // Ensure container is visible if any bus is on
        coneContainer.visible = Object.values(coneGroups).some(g => g.visible);
    }
});

controls.onMasterDsp((param, value) => {
    if (!audioReady || !speakerSystem) return;
    speakerSystem.setMasterDspParam(param, value);
});

controls.onEnvDsp((param, value) => {
    if (!audioReady || !speakerSystem) return;
    speakerSystem.setEnvDspParam(param, value);
});

controls.onUserDsp((param, value) => {
    if (param === 'mouse-sensitivity') {
        listener.setSensitivity(value / 100);
        return;
    }
    if (param === 'invert-y') {
        listener.setInvertPitch(value);
        return;
    }
    if (param === 'invert-x') {
        listener.setInvertYaw(value);
        return;
    }
    if (param === 'local-volume') {
        if (audioReady && speakerSystem) {
            speakerSystem.setLocalVolume(value);
        }
        return;
    }
    if (param === 'grass-distance') {
        setGrassQuality(value);
        return;
    }
});

controls.onInputDsp((param, value) => {
    if (!audioReady || !inputStage) return;
    inputStage.setParam(param, value);
});

controls.onSubDsp((param, value) => {
    if (!audioReady) return;
    speakerSystem.setSubDspParam(param, value, { crossover, effects });
});

controls.onMidDsp((param, value) => {
    if (!audioReady) return;
    speakerSystem.setMidDspParam(param, value, { crossover, effects });
});

controls.onTopDsp((param, value) => {
    if (!audioReady) return;
    speakerSystem.setTopDspParam(param, value, { crossover, effects });
});

controls.onFillDsp((param, value) => {
    if (!audioReady) return;
    speakerSystem.setFillDspParam(param, value);
});

// ─── Pointer lock ↔ overlay management ──────────────────────────
listener.onLockChange((locked) => {
    if (!locked && audioReady) {
        // Show a small message, but don't go back to start screen
        // User can click canvas to re-lock
    }
});

// Re-lock on canvas click and ensure audio context is active
canvas.addEventListener('click', () => {
    if (!audioReady) {
        initAudio();
    }
    if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
        audioEngine.ctx.resume();
    }
    if (!listener.isLocked) {
        listener.lock();
    }
});

// ─── Resize ──────────────────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Render loop ─────────────────────────────────────────────────
const clock = new THREE.Clock();
let _meterAccum = 0;
let _posAccum = 0;
let _pbAccum = 0;
const METER_INTERVAL = 1 / 15;  // ~15 fps for meters
const POS_INTERVAL = 1 / 10;    // ~10 fps for position text
const PB_INTERVAL = 1 / 10;     // ~10 fps for playback scrubber

// ─── Debug performance panel ────────────────────────────────────
const debugPanel = document.getElementById('debug-panel');
const debugContent = document.getElementById('debug-content');
const debugBtn = document.getElementById('debug-btn');
let _debugVisible = false;
debugBtn.addEventListener('click', () => {
    _debugVisible = !_debugVisible;
    debugPanel.classList.toggle('hidden', !_debugVisible);
    debugBtn.classList.toggle('active', _debugVisible);
    renderer.info.autoReset = !_debugVisible; // keep stats when debug is on
});
if (debugPanel) {
    makeDraggable(debugPanel, debugPanel, 'debug');
}

// FPS & render performance tracking
let _debugAccum = 0;
let _frameCount = 0;
let _fps = 0;
let _frameTimeSum = 0;
let _frameTimeMax = 0;
let _frameTimeAvg = 0;
let _renderTimeSum = 0;
let _renderTimeMax = 0;
let _renderTimeAvg = 0;
const DEBUG_INTERVAL = 0.5; // refresh debug every 500ms

function updateFpsCounter(dt, renderMs = 0) {
    const dtMs = dt * 1000;
    _debugAccum += dt;
    _frameCount++;
    _frameTimeSum += dtMs;
    if (dtMs > _frameTimeMax) _frameTimeMax = dtMs;
    _renderTimeSum += renderMs;
    if (renderMs > _renderTimeMax) _renderTimeMax = renderMs;

    if (_debugAccum < DEBUG_INTERVAL) return;

    // Compute FPS & frame render stats
    _fps = Math.round(_frameCount / _debugAccum);
    _frameTimeAvg = _frameTimeSum / _frameCount;
    _renderTimeAvg = _renderTimeSum / _frameCount;

    // Always update the small FPS counter
    const fpsEl = document.getElementById('fps-counter');
    if (fpsEl) fpsEl.textContent = _fps + ' FPS';

    _debugAccum = 0;
    _frameCount = 0;
    _frameTimeSum = 0;
    _frameTimeMax = 0;
    _renderTimeSum = 0;
    _renderTimeMax = 0;
}

function updateDebug(dt) {

    // Renderer info (Three.js)
    const ri = renderer.info;
    const mem = ri.memory;
    const ren = ri.render;

    // Audio context info
    let audioLines = '';
    if (audioReady) {
        const ctx = audioEngine.context;
        const ss = speakerSystem._debugStats;
        const skipPct = ss.totalFrames > 0 ? ((ss.skippedFrames / ss.totalFrames) * 100).toFixed(0) : '0';
        audioLines =
`<span class="dbg-title">── AUDIO ──────────────────────</span>
  Context state    <span class="dbg-val">${ctx.state}</span>
  Sample rate      <span class="dbg-val">${ctx.sampleRate} Hz</span>
  Base latency     <span class="dbg-val">${(ctx.baseLatency * 1000).toFixed(1)} ms</span>
  Output latency   <span class="dbg-val">${(ctx.outputLatency * 1000).toFixed(1)} ms</span>
  Current time     <span class="dbg-val">${ctx.currentTime.toFixed(1)} s</span>
<span class="dbg-title">── SPEAKERS ───────────────────</span>
  Total speakers   <span class="dbg-val">${speakerSystem.speakers.length}</span>
  Updated/frame    <span class="dbg-val">${ss.updatedSpeakers} / ${speakerSystem.speakers.length}</span>  (stagger)
  Skipped frames   <span class="${skipPct > 50 ? 'dbg-val' : 'dbg-warn'}">${skipPct}%</span>  (dirty check)
  Panning model    <span class="dbg-val">${speakerSystem.speakers[0]?.panner.panningModel}</span>
  Spectre FFT      <span class="dbg-val">${spectrumRunning ? 'ON' : 'OFF'}</span>`;

        // Reset frame counters
        ss.skippedFrames = 0;
        ss.totalFrames = 0;
    }

    // JS Memory (Chrome only)
    let memLines = '';
    if (performance.memory) {
        const m = performance.memory;
        memLines =
`<span class="dbg-title">── JS MEMORY ──────────────────</span>
  Heap used        <span class="dbg-val">${(m.usedJSHeapSize / 1048576).toFixed(1)} MB</span>
  Heap total       <span class="dbg-val">${(m.totalJSHeapSize / 1048576).toFixed(1)} MB</span>
  Heap limit       <span class="dbg-val">${(m.jsHeapSizeLimit / 1048576).toFixed(0)} MB</span>
`;
    }

    // FPS color
    const fpsClass = _fps >= 55 ? 'dbg-val' : _fps >= 30 ? 'dbg-warn' : 'dbg-bad';
    const ftClass = _frameTimeAvg <= 8 ? 'dbg-val' : _frameTimeAvg <= 18 ? 'dbg-warn' : 'dbg-bad';
    const ftMaxClass = _frameTimeMax <= 16 ? 'dbg-val' : _frameTimeMax <= 33 ? 'dbg-warn' : 'dbg-bad';
    const vsyncHz = _frameTimeAvg > 0 ? Math.round(1000 / _frameTimeAvg) : 60;

    debugContent.innerHTML =
`<span class="dbg-title">── FRAME & PERFORMANCE ────────</span>
  FPS              <span class="${fpsClass}">${_fps}</span>
  Render (CPU)     <span class="dbg-val">${_renderTimeAvg.toFixed(2)} ms</span>
  Frame tick (rAF) <span class="${ftClass}">${_frameTimeAvg.toFixed(1)} ms</span>  (VSync ~${vsyncHz} Hz)
  Frame tick max   <span class="${ftMaxClass}">${_frameTimeMax.toFixed(1)} ms</span>
  Pixel ratio      <span class="dbg-val">${renderer.getPixelRatio()}</span>
  Resolution       <span class="dbg-val">${renderer.domElement.width}×${renderer.domElement.height}</span>
<span class="dbg-title">── THREE.JS RENDER ────────────</span>
  Draw calls       <span class="dbg-val">${ren.calls}</span>
  Triangles        <span class="dbg-val">${ren.triangles.toLocaleString()}</span>
  Points           <span class="dbg-val">${ren.points}</span>
  Lines            <span class="dbg-val">${ren.lines}</span>
<span class="dbg-title">── THREE.JS MEMORY ────────────</span>
  Geometries       <span class="dbg-val">${mem.geometries}</span>
  Textures         <span class="dbg-val">${mem.textures}</span>
${audioLines}
${memLines}`;

    if (!ri.autoReset) ri.reset();
}

let _lastFrameTime = performance.now();

function renderFrame() {
    const now = performance.now();
    const realFrameMs = now - _lastFrameTime;
    _lastFrameTime = now;

    const dt = Math.min(clock.getDelta(), 0.1);

    // Update listener movement
    listener.update(dt);

    if (audioReady) {
        // Protection anti-microcoupure : si l'onglet est en arrière-plan (Alt+Tab) ou si un lagspike 3D survient (> 45ms),
        // on ne surcharge pas Web Audio avec des calculs spatiaux afin de garantir un flux audio continu sans saccade.
        const isTabHidden = document.hidden;
        const isLagSpike = realFrameMs > 45;
        if (!isTabHidden && !isLagSpike) {
            const ctx = audioEngine.context;
            listener._audioCtxTime = ctx.currentTime;
            listener.syncAudioListener(ctx.listener, ctx);
            speakerSystem.update(listener.position);
        }
    }

    // Update HUD (throttled)
    _posAccum += dt;
    if (_posAccum >= POS_INTERVAL) {
        _posAccum = 0;
        controls.updatePosition(listener.position, listener.distanceToFOH);
    }

    // Update level meters only when audio is playing (throttled)
    const isAudioPlaying = audioReady && (audioEngine.isPlaying || (sineGenerator && sineGenerator.isPlaying));
    if (isAudioPlaying) {
        _meterAccum += dt;
        if (_meterAccum >= METER_INTERVAL) {
            _meterAccum = 0;
            const levels = speakerSystem.getLevels();
            controls.updateMeters(levels);
        }
    }

    // Update Playback Head Scrubber (throttled)
    _pbAccum += dt;
    if (_pbAccum >= PB_INTERVAL) {
        _pbAccum = 0;
        if (audioReady) {
            controls.updatePlayback(
                audioEngine.getCurrentTime(),
                audioEngine.getDuration(),
                audioEngine.isPlaying,
                _currentAudioFileName
            );
        }
    }

    // Sync skybox with camera position
    updateSkybox(skybox, camera);

    // Show/hide grass chunks near camera
    updateVegetation(camera);

    // Update dynamic shadow camera to follow player smoothly
    if (dirLight && listener) {
        const lp = listener.position;
        dirLight.target.position.set(lp.x, lp.y, lp.z);
        dirLight.position.set(lp.x + 32, lp.y + 40, lp.z + 38);
    }

    // Render with CPU time benchmark
    const t0 = performance.now();
    renderer.render(scene, camera);
    const renderTime = performance.now() - t0;

    // Debug overlay (throttled internally)
    updateFpsCounter(dt, renderTime);
    if (_debugVisible) updateDebug(dt);
}

function animate() {
    requestAnimationFrame(animate);
    renderFrame();
}

animate();
