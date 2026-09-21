/**
 * Controls — UI overlay with separated lil-gui panels:
 * - Master & Environment (top-right)
 * - TOP & MID Pipelines (bottom-left)
 * - FILL & SUB Pipelines (bottom-right)
 * - Quick HUD action bar (Cônes, HRTF, Doppler, Oscillo, Herbe, Play/Pause, Changer MP3, Debug)
 */
import GUI from 'lil-gui';
import { DSP_DEFAULTS } from '../config/dsp-defaults.js';

export class Controls {
    constructor() {
        this.overlay = document.getElementById('overlay');
        this.hud = document.getElementById('hud');
        this.fileInput = document.getElementById('audio-file');
        this.fileNameEl = document.getElementById('file-name');
        this.enterBtn = document.getElementById('enter-btn');
        this.playBtn = document.getElementById('play-btn');
        this.changeMp3Btn = document.getElementById('change-mp3-btn');
        this.dspBtn = document.getElementById('dsp-btn');
        this.dspPanels = document.getElementById('dsp-panels');
        this.dspMasterWrap = document.getElementById('dsp-master-wrap');
        this.positionDisplay = document.getElementById('position-display');

        // Level meters (top-left inside HUD)
        this._meters = ['sub', 'mid', 'top', 'fill', 'master'].map(id => {
            const el = document.getElementById(`meter-${id}`);
            return el ? {
                fill: el.querySelector('.meter-fill'),
                peak: el.querySelector('.meter-peak'),
                clip: el.querySelector('.meter-clip'),
                peakHold: 0,
                peakTimer: 0,
                clipTimer: 0,
            } : null;
        }).filter(Boolean);

        // Callbacks
        this._file = null;
        this._onEnter = null;
        this._onPlayPause = null;
        this._onChangeMp3 = null;
        this._onDopplerToggle = null;
        this._onOscilloscopeToggle = null;
        this._onConesToggle = null;
        this._onHrtfToggle = null;
        this._onHrtfBrightness = null;
        this._onGrassChange = null;
        this._onMasterDsp = null;
        this._onSubDsp = null;
        this._onMidDsp = null;
        this._onTopDsp = null;
        this._onFillDsp = null;

        // UI visibility state (hidden by default, toggled via dsp-btn)
        this._dspVisible = false;

        // State models for each bus
        const savedSens = localStorage.getItem('soundstage3d:master-mouse-sensitivity');
        this.state = {
            master: {
                ...DSP_DEFAULTS.master,
                'mouse-sensitivity': savedSens !== null ? Number(savedSens) : DSP_DEFAULTS.master['mouse-sensitivity'],
            },
            sub:  { ...DSP_DEFAULTS.sub },
            mid:  { ...DSP_DEFAULTS.mid },
            top:  { ...DSP_DEFAULTS.top },
            fill: { ...DSP_DEFAULTS.fill },
        };

        this.guis = {};

        // Initialize lil-gui separate panels
        this._initGuis();

        // Initialize HUD buttons
        this._initHud();
    }

    _initGuis() {
        const cMaster = document.getElementById('dsp-panel-master');
        const cTop    = document.getElementById('dsp-panel-top');
        const cMid    = document.getElementById('dsp-panel-mid');
        const cFill   = document.getElementById('dsp-panel-fill');
        const cSub    = document.getElementById('dsp-panel-sub');

        // Helper to stop pointer lock / canvas click propagation
        const stopProp = (e) => e.stopPropagation();
        const protectGui = (gui) => {
            ['mousedown', 'pointerdown', 'mouseup', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel'].forEach(evt => {
                gui.domElement.addEventListener(evt, stopProp);
            });
        };

        // ─── 1. Master GUI (Top-Right) ───
        if (cMaster) {
            const gui = new GUI({ container: cMaster, title: '🎚 Master & Environnement', closeFolders: false });
            protectGui(gui);
            this.guis.master = gui;

            const fEnv = gui.addFolder('Environnement');
            fEnv.add(this.state.master, 'air-abs', 0, 50, 1).name('Abs. air (Hz/m)').onChange(v => this._onMasterDsp && this._onMasterDsp('air-abs', v));
            fEnv.add(this.state.master, 'treble', 0, 15, 0.5).name('Aigus (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('treble', v));
            fEnv.add(this.state.master, 'reverb', 0, 100, 1).name('Réverb (%)').onChange(v => this._onMasterDsp && this._onMasterDsp('reverb', v));

            const fLocal = gui.addFolder('Volume local 🔒');
            fLocal.add(this.state.master, 'local-volume', 0, 1000, 1).name('Volume (%)').onChange(v => this._onMasterDsp && this._onMasterDsp('local-volume', v));
            fLocal.add(this.state.master, 'mouse-sensitivity', 10, 300, 5).name('Souris (%)').onChange(v => {
                localStorage.setItem('soundstage3d:master-mouse-sensitivity', v);
                if (this._onMasterDsp) this._onMasterDsp('mouse-sensitivity', v);
            });

            gui.add({ reset: () => this.resetBus('master') }, 'reset').name('↺ Reset Master');
        }

        // ─── 2. TOP GUI (Bottom-Left, order 1) ───
        if (cTop) {
            const gui = new GUI({ container: cTop, title: '🔉 TOP Pipeline', closeFolders: false });
            protectGui(gui);
            this.guis.top = gui;

            const fXover = gui.addFolder('Crossover LR4');
            fXover.add(this.state.top, 'xover-freq', 800, 6000, 50).name('High Freq (Hz)').onChange(v => this._onTopDsp && this._onTopDsp('xover-freq', v));

            const fComp = gui.addFolder('Compresseur');
            fComp.add(this.state.top, 'comp-threshold', -60, 0, 1).name('Seuil (dB)').onChange(v => this._onTopDsp && this._onTopDsp('comp-threshold', v));
            fComp.add(this.state.top, 'comp-knee', 0, 40, 1).name('Knee (dB)').onChange(v => this._onTopDsp && this._onTopDsp('comp-knee', v));
            fComp.add(this.state.top, 'comp-ratio', 1, 20, 0.5).name('Ratio (:1)').onChange(v => this._onTopDsp && this._onTopDsp('comp-ratio', v));
            fComp.add(this.state.top, 'comp-attack', 0, 100, 1).name('Attaque (ms)').onChange(v => this._onTopDsp && this._onTopDsp('comp-attack', v));
            fComp.add(this.state.top, 'comp-release', 10, 1000, 10).name('Release (ms)').onChange(v => this._onTopDsp && this._onTopDsp('comp-release', v));

            const fSat = gui.addFolder('Saturation');
            fSat.add(this.state.top, 'sat-drive', 0, 100, 1).name('Drive (%)').onChange(v => this._onTopDsp && this._onTopDsp('sat-drive', v));
            fSat.add(this.state.top, 'sat-mix', 0, 100, 1).name('Mix (%)').onChange(v => this._onTopDsp && this._onTopDsp('sat-mix', v));

            const fVol = gui.addFolder('Volume Bus');
            fVol.add(this.state.top, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this._onTopDsp && this._onTopDsp('bus-volume', v));

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            fAcoustics.add(this.state.top, 'lim-threshold', -12, 0, 0.5).name('Limiteur (dB)').onChange(v => this._onTopDsp && this._onTopDsp('lim-threshold', v));
            fAcoustics.add(this.state.top, 'dist-k', 0, 200, 5).name('Attén. dist (k)').onChange(v => this._onTopDsp && this._onTopDsp('dist-k', v));
            fAcoustics.add(this.state.top, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this._onTopDsp && this._onTopDsp('refl-gain', v));
            fAcoustics.add(this.state.top, 'refl-lpf', 200, 8000, 100).name('LPF Réflec. (Hz)').onChange(v => this._onTopDsp && this._onTopDsp('refl-lpf', v));

            gui.add({ reset: () => this.resetBus('top') }, 'reset').name('↺ Reset TOP');
        }

        // ─── 3. MID GUI (Bottom-Left, order 2) ───
        if (cMid) {
            const gui = new GUI({ container: cMid, title: '🔉 MID Pipeline', closeFolders: false });
            protectGui(gui);
            this.guis.mid = gui;

            const fXover = gui.addFolder('Crossover LR4');
            fXover.add(this.state.mid, 'xover-low', 40, 200, 1).name('Low Freq (Hz)').onChange(v => this._onMidDsp && this._onMidDsp('xover-low', v));
            fXover.add(this.state.mid, 'xover-high', 800, 6000, 50).name('High Freq (Hz)').onChange(v => this._onMidDsp && this._onMidDsp('xover-high', v));

            const fComp = gui.addFolder('Compresseur');
            fComp.add(this.state.mid, 'comp-threshold', -60, 0, 1).name('Seuil (dB)').onChange(v => this._onMidDsp && this._onMidDsp('comp-threshold', v));
            fComp.add(this.state.mid, 'comp-knee', 0, 40, 1).name('Knee (dB)').onChange(v => this._onMidDsp && this._onMidDsp('comp-knee', v));
            fComp.add(this.state.mid, 'comp-ratio', 1, 20, 0.5).name('Ratio (:1)').onChange(v => this._onMidDsp && this._onMidDsp('comp-ratio', v));
            fComp.add(this.state.mid, 'comp-attack', 0, 100, 1).name('Attaque (ms)').onChange(v => this._onMidDsp && this._onMidDsp('comp-attack', v));
            fComp.add(this.state.mid, 'comp-release', 10, 1000, 10).name('Release (ms)').onChange(v => this._onMidDsp && this._onMidDsp('comp-release', v));

            const fSat = gui.addFolder('Saturation');
            fSat.add(this.state.mid, 'sat-drive', 0, 100, 1).name('Drive (%)').onChange(v => this._onMidDsp && this._onMidDsp('sat-drive', v));
            fSat.add(this.state.mid, 'sat-mix', 0, 100, 1).name('Mix (%)').onChange(v => this._onMidDsp && this._onMidDsp('sat-mix', v));

            const fVol = gui.addFolder('Volume Bus');
            fVol.add(this.state.mid, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this._onMidDsp && this._onMidDsp('bus-volume', v));

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            fAcoustics.add(this.state.mid, 'lim-threshold', -12, 0, 0.5).name('Limiteur (dB)').onChange(v => this._onMidDsp && this._onMidDsp('lim-threshold', v));
            fAcoustics.add(this.state.mid, 'dist-k', 0, 200, 5).name('Attén. dist (k)').onChange(v => this._onMidDsp && this._onMidDsp('dist-k', v));
            fAcoustics.add(this.state.mid, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this._onMidDsp && this._onMidDsp('refl-gain', v));
            fAcoustics.add(this.state.mid, 'refl-lpf', 200, 8000, 100).name('LPF Réflec. (Hz)').onChange(v => this._onMidDsp && this._onMidDsp('refl-lpf', v));

            gui.add({ reset: () => this.resetBus('mid') }, 'reset').name('↺ Reset MID');
        }

        // ─── 4. FILL GUI (Bottom-Right, order 4) ───
        if (cFill) {
            const gui = new GUI({ container: cFill, title: '🔉 FILL Pipeline', closeFolders: false });
            protectGui(gui);
            this.guis.fill = gui;

            const fMix = gui.addFolder('Mixage Source');
            fMix.add(this.state.fill, 'merge-gain', 0, 100, 1).name('Gain Mix (%)').onChange(v => this._onFillDsp && this._onFillDsp('merge-gain', v));

            const fVol = gui.addFolder('Volume Bus');
            fVol.add(this.state.fill, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this._onFillDsp && this._onFillDsp('bus-volume', v));

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            fAcoustics.add(this.state.fill, 'lim-threshold', -12, 0, 0.5).name('Limiteur (dB)').onChange(v => this._onFillDsp && this._onFillDsp('lim-threshold', v));
            fAcoustics.add(this.state.fill, 'dist-k', 0, 200, 5).name('Attén. dist (k)').onChange(v => this._onFillDsp && this._onFillDsp('dist-k', v));
            fAcoustics.add(this.state.fill, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this._onFillDsp && this._onFillDsp('refl-gain', v));
            fAcoustics.add(this.state.fill, 'refl-lpf', 200, 8000, 100).name('LPF Réflec. (Hz)').onChange(v => this._onFillDsp && this._onFillDsp('refl-lpf', v));

            gui.add({ reset: () => this.resetBus('fill') }, 'reset').name('↺ Reset FILL');
        }

        // ─── 5. SUB GUI (Bottom-Right, order 5) ───
        if (cSub) {
            const gui = new GUI({ container: cSub, title: '🔉 SUB Pipeline', closeFolders: false });
            protectGui(gui);
            this.guis.sub = gui;

            const fXover = gui.addFolder('Crossover LR4');
            fXover.add(this.state.sub, 'xover-freq', 40, 150, 1).name('Low Freq (Hz)').onChange(v => this._onSubDsp && this._onSubDsp('xover-freq', v));

            const fComp = gui.addFolder('Compresseur');
            fComp.add(this.state.sub, 'comp-threshold', -60, 0, 1).name('Seuil (dB)').onChange(v => this._onSubDsp && this._onSubDsp('comp-threshold', v));
            fComp.add(this.state.sub, 'comp-knee', 0, 40, 1).name('Knee (dB)').onChange(v => this._onSubDsp && this._onSubDsp('comp-knee', v));
            fComp.add(this.state.sub, 'comp-ratio', 1, 20, 0.5).name('Ratio (:1)').onChange(v => this._onSubDsp && this._onSubDsp('comp-ratio', v));
            fComp.add(this.state.sub, 'comp-attack', 0, 100, 1).name('Attaque (ms)').onChange(v => this._onSubDsp && this._onSubDsp('comp-attack', v));
            fComp.add(this.state.sub, 'comp-release', 10, 1000, 10).name('Release (ms)').onChange(v => this._onSubDsp && this._onSubDsp('comp-release', v));

            const fSat = gui.addFolder('Saturation');
            fSat.add(this.state.sub, 'sat-drive', 0, 100, 1).name('Drive (%)').onChange(v => this._onSubDsp && this._onSubDsp('sat-drive', v));
            fSat.add(this.state.sub, 'sat-mix', 0, 100, 1).name('Mix (%)').onChange(v => this._onSubDsp && this._onSubDsp('sat-mix', v));

            const fProx = gui.addFolder('Saturation Proximité');
            fProx.add(this.state.sub, 'prox-far', 1, 15, 0.5).name('Dist. Début (m)').onChange(v => this._onSubDsp && this._onSubDsp('prox-far', v));
            fProx.add(this.state.sub, 'prox-near', 0.5, 5, 0.5).name('Dist. Max (m)').onChange(v => this._onSubDsp && this._onSubDsp('prox-near', v));
            fProx.add(this.state.sub, 'prox-drive', 0, 100, 1).name('Drive Max (%)').onChange(v => this._onSubDsp && this._onSubDsp('prox-drive', v));

            const fVol = gui.addFolder('Volume Bus');
            fVol.add(this.state.sub, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this._onSubDsp && this._onSubDsp('bus-volume', v));

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            fAcoustics.add(this.state.sub, 'lim-threshold', -12, 0, 0.5).name('Limiteur (dB)').onChange(v => this._onSubDsp && this._onSubDsp('lim-threshold', v));
            fAcoustics.add(this.state.sub, 'dist-k', 0, 200, 5).name('Attén. dist (k)').onChange(v => this._onSubDsp && this._onSubDsp('dist-k', v));
            fAcoustics.add(this.state.sub, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this._onSubDsp && this._onSubDsp('refl-gain', v));
            fAcoustics.add(this.state.sub, 'refl-lpf', 200, 8000, 100).name('LPF Réflec. (Hz)').onChange(v => this._onSubDsp && this._onSubDsp('refl-lpf', v));

            gui.add({ reset: () => this.resetBus('sub') }, 'reset').name('↺ Reset SUB');
        }
    }

    _initHud() {
        // Toggle DSP panels visibility
        if (this.dspBtn) {
            this.dspBtn.textContent = '🎛 DSP';
            this.dspBtn.addEventListener('click', () => {
                this._dspVisible = !this._dspVisible;
                if (this.dspPanels) this.dspPanels.classList.toggle('hidden', !this._dspVisible);
                if (this.dspMasterWrap) this.dspMasterWrap.classList.toggle('hidden', !this._dspVisible);
                this.dspBtn.classList.toggle('active', this._dspVisible);
            });
        }

        // HRTF button & brightness slider
        this._hrtfOn = false;
        this.hrtfBtn = document.getElementById('hrtf-btn');
        this.hrtfComp = document.getElementById('hrtf-comp');
        this.hrtfBrightnessSlider = document.getElementById('hrtf-brightness');
        this.hrtfBrightnessVal = document.getElementById('hrtf-brightness-val');

        if (this.hrtfBtn) {
            this.hrtfBtn.addEventListener('click', () => {
                this._hrtfOn = !this._hrtfOn;
                this.hrtfBtn.textContent = this._hrtfOn ? '🎧 HRTF: ON' : '🎧 HRTF: OFF';
                if (this.hrtfComp) this.hrtfComp.classList.toggle('hidden', !this._hrtfOn);
                if (this._onHrtfToggle) this._onHrtfToggle(this._hrtfOn);
                const db = this._hrtfOn && this.hrtfBrightnessSlider ? Number(this.hrtfBrightnessSlider.value) : 0;
                if (this._onHrtfBrightness) this._onHrtfBrightness(db);
            });
        }

        if (this.hrtfBrightnessSlider) {
            this.hrtfBrightnessSlider.addEventListener('input', () => {
                const db = Number(this.hrtfBrightnessSlider.value);
                if (this.hrtfBrightnessVal) this.hrtfBrightnessVal.textContent = '+' + db + ' dB';
                if (this._hrtfOn && this._onHrtfBrightness) this._onHrtfBrightness(db);
            });
        }

        // Doppler button
        this._dopplerOn = false;
        this.dopplerBtn = document.getElementById('doppler-btn');
        if (this.dopplerBtn) {
            this.dopplerBtn.addEventListener('click', () => {
                this._dopplerOn = !this._dopplerOn;
                this.dopplerBtn.textContent = this._dopplerOn ? '🔊 Doppler: ON' : '🔇 Doppler: OFF';
                if (this._onDopplerToggle) this._onDopplerToggle(this._dopplerOn);
            });
        }

        // Oscilloscope button
        this._oscilloscopeOn = false;
        this.oscilloscopeBtn = document.getElementById('oscilloscope-btn');
        if (this.oscilloscopeBtn) {
            this.oscilloscopeBtn.addEventListener('click', () => {
                this._oscilloscopeOn = !this._oscilloscopeOn;
                this.oscilloscopeBtn.textContent = this._oscilloscopeOn ? '📈 Oscillo: ON' : '📈 Oscillo: OFF';
                if (this._onOscilloscopeToggle) this._onOscilloscopeToggle(this._oscilloscopeOn);
            });
        }

        // Cones dropdown
        this.conesBtn = document.getElementById('cones-btn');
        this.conesMenu = document.getElementById('cones-menu');
        if (this.conesBtn && this.conesMenu) {
            const coneCheckboxes = this.conesMenu.querySelectorAll('input[data-cone-bus]');
            const coneAllBox = this.conesMenu.querySelector('input[data-cone-bus="all"]');

            this.conesBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.conesMenu.classList.toggle('open');
            });

            document.addEventListener('click', (e) => {
                if (!this.conesMenu.contains(e.target) && e.target !== this.conesBtn) {
                    this.conesMenu.classList.remove('open');
                }
            });

            if (coneAllBox) {
                coneAllBox.addEventListener('change', () => {
                    const on = coneAllBox.checked;
                    coneCheckboxes.forEach(cb => { cb.checked = on; });
                    if (this._onConesToggle) this._onConesToggle('all', on);
                });
            }

            coneCheckboxes.forEach(cb => {
                if (cb === coneAllBox) return;
                cb.addEventListener('change', () => {
                    const bus = cb.dataset.coneBus;
                    if (this._onConesToggle) this._onConesToggle(bus, cb.checked);
                    if (coneAllBox) {
                        const busBoxes = [...coneCheckboxes].filter(c => c !== coneAllBox);
                        const allOn = busBoxes.every(c => c.checked);
                        const anyOn = busBoxes.some(c => c.checked);
                        coneAllBox.checked = allOn;
                        coneAllBox.indeterminate = !allOn && anyOn;
                    }
                });
            });
        }

        // Play/Pause button
        if (this.playBtn) {
            this.playBtn.addEventListener('click', () => {
                if (this._onPlayPause) this._onPlayPause();
            });
        }

        // Change MP3 button
        if (this.changeMp3Btn) {
            this.changeMp3Btn.addEventListener('click', () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.mp3,.wav,audio/mpeg,audio/wav';
                input.addEventListener('change', (e) => {
                    const file = e.target.files[0];
                    if (file && this._onChangeMp3) this._onChangeMp3(file);
                });
                input.click();
            });
        }

        // File input in overlay (if used)
        if (this.fileInput) {
            this.fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (!file) return;
                this._file = file;
                if (this.fileNameEl) this.fileNameEl.textContent = file.name;
                if (this.enterBtn) this.enterBtn.disabled = false;
            });
        }

        if (this.enterBtn) {
            this.enterBtn.addEventListener('click', () => {
                if (this._onEnter) this._onEnter(this._file || null);
            });
        }
    }

    resetBus(bus) {
        if (!DSP_DEFAULTS[bus]) return;
        Object.assign(this.state[bus], DSP_DEFAULTS[bus]);
        const cbKey = `_on${bus.charAt(0).toUpperCase() + bus.slice(1)}Dsp`;
        for (const [k, v] of Object.entries(this.state[bus])) {
            if (this[cbKey]) this[cbKey](k, v);
        }
        const gui = this.guis[bus];
        if (gui) {
            gui.controllersRecursive().forEach(c => c.updateDisplay());
        }
    }

    setPlayState(isPlaying) {
        if (this.playBtn) {
            this.playBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
        }
    }

    // Callbacks
    onEnter(cb) { this._onEnter = cb; }
    onPlayPause(cb) { this._onPlayPause = cb; }
    onChangeMp3(cb) { this._onChangeMp3 = cb; }
    onDopplerToggle(cb) { this._onDopplerToggle = cb; }
    onOscilloscopeToggle(cb) { this._onOscilloscopeToggle = cb; }
    onHrtfToggle(cb) { this._onHrtfToggle = cb; }
    onHrtfBrightness(cb) { this._onHrtfBrightness = cb; }
    onConesToggle(cb) { this._onConesToggle = cb; }
    onGrassChange(cb) { this._onGrassChange = cb; }
    onMasterDsp(cb) { this._onMasterDsp = cb; }
    onSubDsp(cb) { this._onSubDsp = cb; }
    onMidDsp(cb) { this._onMidDsp = cb; }
    onTopDsp(cb) { this._onTopDsp = cb; }
    onFillDsp(cb) { this._onFillDsp = cb; }

    showHUD() {
        if (this.overlay) this.overlay.classList.add('hidden');
        if (this.hud) this.hud.classList.remove('hidden');
    }

    showOverlay() {
        if (this.overlay) this.overlay.classList.remove('hidden');
        if (this.hud) this.hud.classList.add('hidden');
    }

    updatePosition(pos, fohDist) {
        if (this.positionDisplay) {
            this.positionDisplay.textContent =
                `X: ${pos.x.toFixed(1)}  Y: ${pos.y.toFixed(1)}  Z: ${pos.z.toFixed(1)}`;
        }
    }

    updateMeters(levels) {
        const keys = ['sub', 'mid', 'top', 'fill', 'master'];
        const now = performance.now();
        for (let i = 0; i < this._meters.length; i++) {
            const m = this._meters[i];
            const raw = levels[keys[i]];
            const db = raw > 0.00001 ? 20 * Math.log10(raw) : -60;
            const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

            m.fill.style.height = pct + '%';

            if (pct >= m.peakHold) {
                m.peakHold = pct;
                m.peakTimer = now + 1500;
            } else if (now > m.peakTimer) {
                m.peakHold = Math.max(pct, m.peakHold - 1.2);
            }
            m.peak.style.bottom = m.peakHold + '%';

            if (raw >= 0.99) {
                m.clipTimer = now + 2000;
            }
            m.clip.classList.toggle('active', now < m.clipTimer);
        }
    }
}
