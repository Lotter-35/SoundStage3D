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
    speakerSystem.setBusVolume('fill', Number(document.getElementById('vol-fill').value) / 100);
    speakerSystem.setRange('sub', Number(document.getElementById('range-sub').value));

    // Start playback — source connects to crossover input
    audioEngine.play(crossover.input);
    controls.setPlayState(true);

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
});

controls.onDopplerToggle((enabled) => {
    if (!audioReady) return;
    speakerSystem.setDoppler(enabled);
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

controls.onVolumeChange((bus, value) => {
    if (!audioReady) return;
    speakerSystem.setBusVolume(bus, value);
});

controls.onRangeChange((bus, value) => {
    if (!audioReady) return;
    speakerSystem.setRange(bus, value);
});

controls.onClarityChange((value) => {
    if (!audioReady) return;
    speakerSystem.setClarity(value);
});

controls.onSubDsp((param, value) => {
    if (!audioReady) return;
    speakerSystem.setSubDspParam(param, value, { crossover, effects });
});

// ─── Pointer lock ↔ overlay management ──────────────────────────
listener.onLockChange((locked) => {
    if (!locked && audioReady) {
        // Show a small message, but don't go back to start screen
        // User can click canvas to re-lock
    }
});

// Mode button & listener callback
const modeBtn = document.getElementById('mode-btn');
listener.onModeChange((isCharacter) => {
    modeBtn.textContent = isCharacter ? '🎮 Mode: Personnage' : '🎮 Mode: Vol libre';
});
modeBtn.addEventListener('click', () => {
    // Toggle via simulated F key
    listener.characterMode = !listener.characterMode;
    if (listener.characterMode) {
        listener.camera.position.y = 1.7;
    }
    modeBtn.textContent = listener.characterMode ? '🎮 Mode: Personnage' : '🎮 Mode: Vol libre';
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
