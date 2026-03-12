/**
 * main.js — Entry point. Orchestrates Three.js scene, audio engine, and render loop.
 */
import * as THREE from 'three';

import { createStage } from './scene/stage.js';
import { Listener } from './scene/listener.js';

import { AudioEngine } from './audio/audioEngine.js';
import { Crossover } from './audio/crossover.js';
import { SpeakerSystem } from './audio/speakers.js';
import { createSaturation, createCompressor } from './audio/effects.js';

import { Controls } from './ui/controls.js';

// ─── Three.js setup ──────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

// Build 3D stage
const { coneContainer, coneGroups } = createStage(scene);

// ─── Listener (FPS controls) ────────────────────────────────────
const listener = new Listener(camera, document.body);

// ─── Audio ───────────────────────────────────────────────────────
const audioEngine = new AudioEngine();
let crossover = null;
let speakerSystem = null;
let effects = null; // keep reference to prevent GC
let audioReady = false;

// ─── UI ──────────────────────────────────────────────────────────
const controls = new Controls();

controls.onEnter(async (file) => {
    // Init audio context (needs user gesture)
    const ctx = audioEngine.init();

    // Load file
    await audioEngine.loadFile(file);

    // Build DSP graph
    crossover = new Crossover(ctx);

    const subComp = createCompressor(ctx);
    const subSat = createSaturation(ctx);
    const midComp = createCompressor(ctx);
    const midSat = createSaturation(ctx);
    const topComp = createCompressor(ctx);
    const topSat = createSaturation(ctx);
    effects = { subComp, subSat, midComp, midSat, topComp, topSat };

    speakerSystem = new SpeakerSystem(
        ctx,
        crossover.subBusOutput,
        crossover.midBusOutput,
        crossover.topBusOutput,
        effects
    );

    audioReady = true;

    // Apply initial slider values to audio engine
    speakerSystem.setBusVolume('fill', Number(document.getElementById('fill-bus-volume').value) / 100);

    // Start playback — source connects to crossover input
    audioEngine.play(crossover.input);
    controls.setPlayState(true);

    // Show track name
    document.getElementById('now-playing').textContent = file.name;

    // Switch to HUD and lock pointer
    controls.showHUD();
    listener.lock();
});

controls.onPlayPause(() => {
    if (!audioReady) return;
    if (audioEngine.isPlaying) {
        audioEngine.pause();
        controls.setPlayState(false);
    } else {
        audioEngine.play(crossover.input);
        controls.setPlayState(true);
    }
});

controls.onChangeMp3(async (file) => {
    if (!audioReady) return;
    audioEngine.stop();
    await audioEngine.loadFile(file);
    audioEngine.play(crossover.input);
    controls.setPlayState(true);
    document.getElementById('now-playing').textContent = file.name;
});

controls.onDopplerToggle((enabled) => {
    if (!audioReady) return;
    speakerSystem.setDoppler(enabled);
});

// ─── Oscilloscope ───
const oscCanvas = document.getElementById('oscilloscope');
const oscCtx = oscCanvas.getContext('2d');
let oscRunning = false;
let oscBuffer = null; // circular buffer for ~5s of waveform
let oscWritePos = 0;
let oscAnimId = null;

function oscStart() {
    if (!audioReady) return;
    oscCanvas.classList.remove('hidden');
    // Use a dedicated analyser with large fftSize for time-domain
    if (!speakerSystem._oscAnalyser) {
        const a = speakerSystem.ctx.createAnalyser();
        a.fftSize = 2048;
        a.smoothingTimeConstant = 0;
        speakerSystem.masterLimiter.connect(a);
        speakerSystem._oscAnalyser = a;
    }
    const analyser = speakerSystem._oscAnalyser;
    const sampleRate = speakerSystem.ctx.sampleRate;
    // ~5 seconds of samples
    const totalSamples = Math.ceil(sampleRate * 5);
    oscBuffer = new Float32Array(totalSamples);
    oscWritePos = 0;
    oscRunning = true;
    const timeBuf = new Float32Array(analyser.fftSize);

    function draw() {
        if (!oscRunning) return;
        oscAnimId = requestAnimationFrame(draw);

        // Grab current time-domain data and append to ring buffer
        analyser.getFloatTimeDomainData(timeBuf);
        for (let i = 0; i < timeBuf.length; i++) {
            oscBuffer[oscWritePos % totalSamples] = timeBuf[i];
            oscWritePos++;
        }

        // Draw
        const W = oscCanvas.width;
        const H = oscCanvas.height;
        oscCtx.clearRect(0, 0, W, H);

        // Grid lines
        oscCtx.strokeStyle = 'rgba(255,255,255,0.08)';
        oscCtx.lineWidth = 1;
        for (let y = 0; y <= 4; y++) {
            const yy = (y / 4) * H;
            oscCtx.beginPath(); oscCtx.moveTo(0, yy); oscCtx.lineTo(W, yy); oscCtx.stroke();
        }
        // Time markers every 1s
        oscCtx.fillStyle = 'rgba(255,255,255,0.3)';
        oscCtx.font = '10px monospace';
        for (let s = 1; s <= 4; s++) {
            const x = (s / 5) * W;
            oscCtx.beginPath(); oscCtx.moveTo(x, 0); oscCtx.lineTo(x, H); oscCtx.stroke();
            oscCtx.fillText('-' + (5 - s) + 's', x + 2, H - 4);
        }
        oscCtx.fillText('now', W - 22, H - 4);

        // Waveform
        const filled = Math.min(oscWritePos, totalSamples);
        if (filled < 2) return;
        // We want to display the last `totalSamples` samples across W pixels
        const samplesPerPx = totalSamples / W;

        oscCtx.beginPath();
        oscCtx.strokeStyle = '#4af';
        oscCtx.lineWidth = 1.2;

        const readStart = oscWritePos >= totalSamples ? oscWritePos : 0;
        for (let px = 0; px < W; px++) {
            const sampleIdx = Math.floor(px * samplesPerPx);
            // Compute min/max in this pixel's sample range for better visual
            const rangeEnd = Math.min(Math.floor((px + 1) * samplesPerPx), totalSamples);
            let mn = 1, mx = -1;
            for (let s = sampleIdx; s < rangeEnd; s++) {
                const idx = (readStart + s) % totalSamples;
                if (idx < filled || oscWritePos >= totalSamples) {
                    const v = oscBuffer[idx];
                    if (v < mn) mn = v;
                    if (v > mx) mx = v;
                }
            }
            if (mn > mx) { mn = 0; mx = 0; }
            const yMid = ((1 - ((mn + mx) / 2)) / 2) * H;
            if (px === 0) oscCtx.moveTo(px, yMid);
            else oscCtx.lineTo(px, yMid);
        }
        oscCtx.stroke();

        // Draw an envelope (min/max) for thickness
        oscCtx.beginPath();
        oscCtx.fillStyle = 'rgba(68,170,255,0.15)';
        // Top envelope
        for (let px = 0; px < W; px++) {
            const sampleIdx = Math.floor(px * samplesPerPx);
            const rangeEnd = Math.min(Math.floor((px + 1) * samplesPerPx), totalSamples);
            let mx = -1;
            for (let s = sampleIdx; s < rangeEnd; s++) {
                const idx = (readStart + s) % totalSamples;
                if (idx < filled || oscWritePos >= totalSamples) {
                    const v = oscBuffer[idx];
                    if (v > mx) mx = v;
                }
            }
            if (mx === -1) mx = 0;
            const y = ((1 - mx) / 2) * H;
            if (px === 0) oscCtx.moveTo(px, y);
            else oscCtx.lineTo(px, y);
        }
        // Bottom envelope (reverse)
        for (let px = W - 1; px >= 0; px--) {
            const sampleIdx = Math.floor(px * samplesPerPx);
            const rangeEnd = Math.min(Math.floor((px + 1) * samplesPerPx), totalSamples);
            let mn = 1;
            for (let s = sampleIdx; s < rangeEnd; s++) {
                const idx = (readStart + s) % totalSamples;
                if (idx < filled || oscWritePos >= totalSamples) {
                    const v = oscBuffer[idx];
                    if (v < mn) mn = v;
                }
            }
            if (mn === 1) mn = 0;
            const y = ((1 - mn) / 2) * H;
            oscCtx.lineTo(px, y);
        }
        oscCtx.closePath();
        oscCtx.fill();
    }
    draw();
}

function oscStop() {
    oscRunning = false;
    if (oscAnimId) cancelAnimationFrame(oscAnimId);
    oscCanvas.classList.add('hidden');
}

controls.onOscilloscopeToggle((enabled) => {
    if (enabled) oscStart(); else oscStop();
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
    if (!audioReady) return;
    speakerSystem.setMasterDspParam(param, value);
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

// Re-lock on canvas click when already running
canvas.addEventListener('click', () => {
    if (audioReady && !listener.isLocked) {
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

function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();

    // Update listener movement
    listener.update(dt);

    // Sync audio listener with camera
    if (audioReady) {
        // Auto-resume AudioContext if browser suspended it
        const ctx = audioEngine.context;
        if (ctx.state === 'suspended') ctx.resume();

        listener._audioCtxTime = ctx.currentTime;
        listener.syncAudioListener(ctx.listener);
        speakerSystem.update(listener.position);
    }

    // Update HUD
    controls.updatePosition(listener.position, listener.distanceToFOH);

    // Update level meters
    if (audioReady) {
        controls.updateMeters(speakerSystem.getLevels());
    }

    // Render
    renderer.render(scene, camera);
}

animate();
