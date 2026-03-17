/**
 * main.js — Entry point. Orchestrates Three.js scene, audio engine, and render loop.
 */
import * as THREE from 'three';

import { createStage } from './scene/stage.js';
import { Listener } from './scene/listener.js';
import { createSkybox, updateSkybox } from './scene/skybox.js';
import { createVegetation, updateVegetation } from './scene/vegetation.js';

import { AudioEngine } from './audio/audioEngine.js';
import { Crossover } from './audio/crossover.js';
import { SpeakerSystem } from './audio/speakers.js';
import { createSaturation, createCompressor } from './audio/effects.js';

import { Controls } from './ui/controls.js';

// ─── Three.js setup ──────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

// Build 3D stage
const { coneContainer, coneGroups } = createStage(scene);

// ─── Skybox ───────────────────────────────────────────────────────
// Fond couleur fallback (avant que le GLB soit prêt)
scene.background = new THREE.Color(0x87ceeb);
let skybox = null;
skybox = await createSkybox(scene);

// ─── Vegetation (instanced grass) ────────────────────────────────
await createVegetation(scene);

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

    if (file) {
        // Load file
        await audioEngine.loadFile(file);
    }

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

    if (file) {
        // Start playback — source connects to crossover input
        audioEngine.play(crossover.input);
        controls.setPlayState(true);
        document.getElementById('now-playing').textContent = file.name;
    }

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
    const W = oscCanvas.width;
    // ~5 seconds of samples
    const totalSamples = Math.ceil(sampleRate * 5);
    oscBuffer = new Float32Array(totalSamples);
    oscWritePos = 0;
    oscRunning = true;
    const timeBuf = new Float32Array(analyser.fftSize);

    // Pre-computed per-pixel min/max columns for O(W) drawing instead of O(totalSamples)
    const colMin = new Float32Array(W);
    const colMax = new Float32Array(W);
    const samplesPerPx = totalSamples / W;

    function draw() {
        if (!oscRunning) return;
        oscAnimId = requestAnimationFrame(draw);

        // Grab current time-domain data and append to ring buffer
        analyser.getFloatTimeDomainData(timeBuf);
        for (let i = 0; i < timeBuf.length; i++) {
            oscBuffer[oscWritePos % totalSamples] = timeBuf[i];
            oscWritePos++;
        }

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

        // Waveform — compute min/max per pixel column in a single pass
        const filled = Math.min(oscWritePos, totalSamples);
        if (filled < 2) return;

        const readStart = oscWritePos >= totalSamples ? oscWritePos : 0;

        // Single pass: compute min/max for each pixel column
        for (let px = 0; px < W; px++) { colMin[px] = 1; colMax[px] = -1; }
        for (let s = 0; s < totalSamples; s++) {
            const idx = (readStart + s) % totalSamples;
            if (idx >= filled && oscWritePos < totalSamples) continue;
            const px = Math.min((s / samplesPerPx) | 0, W - 1);
            const v = oscBuffer[idx];
            if (v < colMin[px]) colMin[px] = v;
            if (v > colMax[px]) colMax[px] = v;
        }

        // Draw center waveform line
        oscCtx.beginPath();
        oscCtx.strokeStyle = '#4af';
        oscCtx.lineWidth = 1.2;
        for (let px = 0; px < W; px++) {
            let mn = colMin[px], mx = colMax[px];
            if (mn > mx) { mn = 0; mx = 0; }
            const yMid = ((1 - ((mn + mx) / 2)) / 2) * H;
            if (px === 0) oscCtx.moveTo(px, yMid);
            else oscCtx.lineTo(px, yMid);
        }
        oscCtx.stroke();

        // Draw envelope fill
        oscCtx.beginPath();
        oscCtx.fillStyle = 'rgba(68,170,255,0.15)';
        // Top envelope
        for (let px = 0; px < W; px++) {
            let mx = colMax[px];
            if (mx === -1) mx = 0;
            const y = ((1 - mx) / 2) * H;
            if (px === 0) oscCtx.moveTo(px, y);
            else oscCtx.lineTo(px, y);
        }
        // Bottom envelope (reverse)
        for (let px = W - 1; px >= 0; px--) {
            let mn = colMin[px];
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
    if (param === 'mouse-sensitivity') {
        listener.setSensitivity(value / 100);
        return;
    }
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
let _meterAccum = 0;
let _posAccum = 0;
const METER_INTERVAL = 1 / 15;  // ~15 fps for meters
const POS_INTERVAL = 1 / 10;    // ~10 fps for position text

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

// FPS tracking
let _debugAccum = 0;
let _frameCount = 0;
let _fps = 0;
let _frameTimes = [];
let _frameTimeAvg = 0;
let _frameTimeMax = 0;
const DEBUG_INTERVAL = 0.5; // refresh debug every 500ms

function updateFpsCounter(dt) {
    _debugAccum += dt;
    _frameCount++;
    _frameTimes.push(dt * 1000);

    if (_debugAccum < DEBUG_INTERVAL) return;

    // Compute FPS stats
    _fps = Math.round(_frameCount / _debugAccum);
    _frameTimeAvg = _frameTimes.reduce((a, b) => a + b, 0) / _frameTimes.length;
    _frameTimeMax = Math.max(..._frameTimes);

    // Always update the small FPS counter
    const fpsEl = document.getElementById('fps-counter');
    if (fpsEl) fpsEl.textContent = _fps;

    _debugAccum = 0;
    _frameCount = 0;
    _frameTimes = [];
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
  Doppler          <span class="dbg-val">${speakerSystem.speakers[0]?._dopplerEnabled ? 'ON' : 'OFF'}</span>
  Panning model    <span class="dbg-val">${speakerSystem.speakers[0]?.panner.panningModel}</span>
  Oscillo          <span class="dbg-val">${oscRunning ? 'ON' : 'OFF'}</span>`;

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
    const ftClass = _frameTimeAvg <= 18 ? 'dbg-val' : _frameTimeAvg <= 33 ? 'dbg-warn' : 'dbg-bad';
    const ftMaxClass = _frameTimeMax <= 20 ? 'dbg-val' : _frameTimeMax <= 50 ? 'dbg-warn' : 'dbg-bad';

    debugContent.innerHTML =
`<span class="dbg-title">── FRAME ──────────────────────</span>
  FPS              <span class="${fpsClass}">${_fps}</span>
  Frame time avg   <span class="${ftClass}">${_frameTimeAvg.toFixed(1)} ms</span>
  Frame time max   <span class="${ftMaxClass}">${_frameTimeMax.toFixed(1)} ms</span>
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

    // Update HUD (throttled)
    _posAccum += dt;
    if (_posAccum >= POS_INTERVAL) {
        _posAccum = 0;
        controls.updatePosition(listener.position, listener.distanceToFOH);
    }

    // Update level meters (throttled)
    if (audioReady) {
        _meterAccum += dt;
        if (_meterAccum >= METER_INTERVAL) {
            _meterAccum = 0;
            controls.updateMeters(speakerSystem.getLevels());
        }
    }

    // Sync skybox with camera position
    updateSkybox(skybox, camera);

    // Show/hide grass chunks near camera
    updateVegetation(camera);

    // Render
    renderer.render(scene, camera);

    // Debug overlay (throttled internally)
    updateFpsCounter(dt);
    if (_debugVisible) updateDebug(dt);
}

animate();
