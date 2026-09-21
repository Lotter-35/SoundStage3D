/**
 * Controls — Modern UI overlay powered by lil-gui:
 * - Master & Environment audio controls
 * - Per-bus DSP pipeline parameters (SUB, MID, TOP, FILL)
 * - 3D Graphics & Visual aids (Grass quality, Cones, Oscilloscope)
 * - Spatialisation & 3D Audio (HRTF binaural, Doppler)
 * - Audio playback actions & level meters
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

        // UI state
        this._guiVisible = true;
        this._isPlaying = false;

        const savedSens = localStorage.getItem('soundstage3d:master-mouse-sensitivity');
        this.state = {
            master: {
                ...DSP_DEFAULTS.master,
                'mouse-sensitivity': savedSens !== null ? Number(savedSens) : DSP_DEFAULTS.master['mouse-sensitivity'],
            },
            sub: { ...DSP_DEFAULTS.sub },
            mid: { ...DSP_DEFAULTS.mid },
            top: { ...DSP_DEFAULTS.top },
            fill: { ...DSP_DEFAULTS.fill },
            graphics: {
                grass: 'off',
                oscilloscope: false,
                conesAll: false,
                conesSub: false,
                conesMid: false,
                conesTop: false,
                conesFill: false,
            },
            spatial: {
                hrtf: false,
                hrtfBrightness: 4,
                doppler: false,
            },
            actions: {
                playPause: () => { if (this._onPlayPause) this._onPlayPause(); },
                loadMp3: () => { this._triggerFilePicker(); },
                resetAll: () => { this.resetAllDefaults(); },
            }
        };

        this.controllers = {};

        // Initialize GUI and HUD
        this._initGui();
        this._initHud();
    }

    _initGui() {
        this.gui = new GUI({ title: '⚙️ Options & DSP', width: 330, closeFolders: true });

        // Protect canvas pointer lock from lil-gui interactions
        const stopProp = (e) => e.stopPropagation();
        ['mousedown', 'pointerdown', 'mouseup', 'pointerup', 'click', 'dblclick', 'contextmenu', 'wheel'].forEach(evt => {
            this.gui.domElement.addEventListener(evt, stopProp);
        });

        // ── 🔊 Master & Environnement ──
        const fMaster = this.gui.addFolder('🔊 Master & Environnement');
        this.controllers['master:local-volume'] = fMaster.add(this.state.master, 'local-volume', 0, 200, 1)
            .name('Volume Local (%)')
            .onChange(v => this._onMasterDsp && this._onMasterDsp('local-volume', v));
        this.controllers['master:reverb'] = fMaster.add(this.state.master, 'reverb', 0, 100, 1)
            .name('Réverbération (%)')
            .onChange(v => this._onMasterDsp && this._onMasterDsp('reverb', v));
        this.controllers['master:air-abs'] = fMaster.add(this.state.master, 'air-abs', 0, 50, 1)
            .name('Absorption Air (Hz/m)')
            .onChange(v => this._onMasterDsp && this._onMasterDsp('air-abs', v));
        this.controllers['master:treble'] = fMaster.add(this.state.master, 'treble', 0, 15, 0.5)
            .name('Brillance Aigus (dB)')
            .onChange(v => this._onMasterDsp && this._onMasterDsp('treble', v));
        this.controllers['master:mouse-sensitivity'] = fMaster.add(this.state.master, 'mouse-sensitivity', 10, 300, 5)
            .name('Sensibilité Souris (%)')
            .onChange(v => {
                localStorage.setItem('soundstage3d:master-mouse-sensitivity', v);
                if (this._onMasterDsp) this._onMasterDsp('mouse-sensitivity', v);
            });

        // ── 🔉 Bus SUB ──
        const fSub = this.gui.addFolder('🔉 Bus SUB');
        this.controllers['sub:bus-volume'] = fSub.add(this.state.sub, 'bus-volume', 0, 200, 1)
            .name('Volume SUB (%)')
            .onChange(v => this._onSubDsp && this._onSubDsp('bus-volume', v));
        this.controllers['sub:xover-freq'] = fSub.add(this.state.sub, 'xover-freq', 40, 150, 1)
            .name('Crossover LP (Hz)')
            .onChange(v => this._onSubDsp && this._onSubDsp('xover-freq', v));

        const fSubComp = fSub.addFolder('Compresseur');
        this.controllers['sub:comp-threshold'] = fSubComp.add(this.state.sub, 'comp-threshold', -60, 0, 1).name('Seuil (dB)').onChange(v => this._onSubDsp && this._onSubDsp('comp-threshold', v));
        this.controllers['sub:comp-ratio'] = fSubComp.add(this.state.sub, 'comp-ratio', 1, 20, 0.5).name('Ratio (:1)').onChange(v => this._onSubDsp && this._onSubDsp('comp-ratio', v));
        this.controllers['sub:comp-attack'] = fSubComp.add(this.state.sub, 'comp-attack', 0, 100, 1).name('Attaque (ms)').onChange(v => this._onSubDsp && this._onSubDsp('comp-attack', v));
        this.controllers['sub:comp-release'] = fSubComp.add(this.state.sub, 'comp-release', 10, 1000, 10).name('Relâchement (ms)').onChange(v => this._onSubDsp && this._onSubDsp('comp-release', v));
        this.controllers['sub:comp-knee'] = fSubComp.add(this.state.sub, 'comp-knee', 0, 40, 1).name('Knee (dB)').onChange(v => this._onSubDsp && this._onSubDsp('comp-knee', v));

        const fSubSat = fSub.addFolder('Saturation & Proximité');
        this.controllers['sub:sat-drive'] = fSubSat.add(this.state.sub, 'sat-drive', 0, 100, 1).name('Drive Sat (%)').onChange(v => this._onSubDsp && this._onSubDsp('sat-drive', v));
        this.controllers['sub:sat-mix'] = fSubSat.add(this.state.sub, 'sat-mix', 0, 100, 1).name('Mix Sat (%)').onChange(v => this._onSubDsp && this._onSubDsp('sat-mix', v));
        this.controllers['sub:prox-far'] = fSubSat.add(this.state.sub, 'prox-far', 1, 15, 0.5).name('Prox Début (m)').onChange(v => this._onSubDsp && this._onSubDsp('prox-far', v));
        this.controllers['sub:prox-near'] = fSubSat.add(this.state.sub, 'prox-near', 0.5, 5, 0.5).name('Prox Max (m)').onChange(v => this._onSubDsp && this._onSubDsp('prox-near', v));
        this.controllers['sub:prox-drive'] = fSubSat.add(this.state.sub, 'prox-drive', 0, 100, 1).name('Prox Drive (%)').onChange(v => this._onSubDsp && this._onSubDsp('prox-drive', v));

        const fSubAcoustics = fSub.addFolder('Limiteur & Acoustique');
        this.controllers['sub:lim-threshold'] = fSubAcoustics.add(this.state.sub, 'lim-threshold', -12, 0, 0.5).name('Seuil Limiteur (dB)').onChange(v => this._onSubDsp && this._onSubDsp('lim-threshold', v));
        this.controllers['sub:dist-k'] = fSubAcoustics.add(this.state.sub, 'dist-k', 0, 200, 5).name('Atténuation (k)').onChange(v => this._onSubDsp && this._onSubDsp('dist-k', v));
        this.controllers['sub:refl-gain'] = fSubAcoustics.add(this.state.sub, 'refl-gain', 0, 100, 1).name('Gain Réflexion (%)').onChange(v => this._onSubDsp && this._onSubDsp('refl-gain', v));
        this.controllers['sub:refl-lpf'] = fSubAcoustics.add(this.state.sub, 'refl-lpf', 200, 8000, 100).name('Filtre Réflexion (Hz)').onChange(v => this._onSubDsp && this._onSubDsp('refl-lpf', v));

        // ── 🔉 Bus MID ──
        const fMid = this.gui.addFolder('🔉 Bus MID');
        this.controllers['mid:bus-volume'] = fMid.add(this.state.mid, 'bus-volume', 0, 200, 1).name('Volume MID (%)').onChange(v => this._onMidDsp && this._onMidDsp('bus-volume', v));
        this.controllers['mid:xover-low'] = fMid.add(this.state.mid, 'xover-low', 40, 200, 1).name('Xover Bas / SUB (Hz)').onChange(v => this._onMidDsp && this._onMidDsp('xover-low', v));
        this.controllers['mid:xover-high'] = fMid.add(this.state.mid, 'xover-high', 800, 6000, 50).name('Xover Haut / TOP (Hz)').onChange(v => this._onMidDsp && this._onMidDsp('xover-high', v));

        const fMidComp = fMid.addFolder('Compresseur & Saturation');
        this.controllers['mid:comp-threshold'] = fMidComp.add(this.state.mid, 'comp-threshold', -60, 0, 1).name('Seuil (dB)').onChange(v => this._onMidDsp && this._onMidDsp('comp-threshold', v));
        this.controllers['mid:comp-ratio'] = fMidComp.add(this.state.mid, 'comp-ratio', 1, 20, 0.5).name('Ratio (:1)').onChange(v => this._onMidDsp && this._onMidDsp('comp-ratio', v));
        this.controllers['mid:comp-attack'] = fMidComp.add(this.state.mid, 'comp-attack', 0, 100, 1).name('Attaque (ms)').onChange(v => this._onMidDsp && this._onMidDsp('comp-attack', v));
        this.controllers['mid:comp-release'] = fMidComp.add(this.state.mid, 'comp-release', 10, 1000, 10).name('Relâchement (ms)').onChange(v => this._onMidDsp && this._onMidDsp('comp-release', v));
        this.controllers['mid:comp-knee'] = fMidComp.add(this.state.mid, 'comp-knee', 0, 40, 1).name('Knee (dB)').onChange(v => this._onMidDsp && this._onMidDsp('comp-knee', v));
        this.controllers['mid:sat-drive'] = fMidComp.add(this.state.mid, 'sat-drive', 0, 100, 1).name('Drive Sat (%)').onChange(v => this._onMidDsp && this._onMidDsp('sat-drive', v));
        this.controllers['mid:sat-mix'] = fMidComp.add(this.state.mid, 'sat-mix', 0, 100, 1).name('Mix Sat (%)').onChange(v => this._onMidDsp && this._onMidDsp('sat-mix', v));

        const fMidAcoustics = fMid.addFolder('Limiteur & Acoustique');
        this.controllers['mid:lim-threshold'] = fMidAcoustics.add(this.state.mid, 'lim-threshold', -12, 0, 0.5).name('Seuil Limiteur (dB)').onChange(v => this._onMidDsp && this._onMidDsp('lim-threshold', v));
        this.controllers['mid:dist-k'] = fMidAcoustics.add(this.state.mid, 'dist-k', 0, 200, 5).name('Atténuation (k)').onChange(v => this._onMidDsp && this._onMidDsp('dist-k', v));
        this.controllers['mid:refl-gain'] = fMidAcoustics.add(this.state.mid, 'refl-gain', 0, 100, 1).name('Gain Réflexion (%)').onChange(v => this._onMidDsp && this._onMidDsp('refl-gain', v));
        this.controllers['mid:refl-lpf'] = fMidAcoustics.add(this.state.mid, 'refl-lpf', 200, 8000, 100).name('Filtre Réflexion (Hz)').onChange(v => this._onMidDsp && this._onMidDsp('refl-lpf', v));

        // ── 🔉 Bus TOP ──
        const fTop = this.gui.addFolder('🔉 Bus TOP');
        this.controllers['top:bus-volume'] = fTop.add(this.state.top, 'bus-volume', 0, 200, 1).name('Volume TOP (%)').onChange(v => this._onTopDsp && this._onTopDsp('bus-volume', v));
        this.controllers['top:xover-freq'] = fTop.add(this.state.top, 'xover-freq', 800, 6000, 50).name('Xover Haut (Hz)').onChange(v => this._onTopDsp && this._onTopDsp('xover-freq', v));

        const fTopComp = fTop.addFolder('Compresseur & Saturation');
        this.controllers['top:comp-threshold'] = fTopComp.add(this.state.top, 'comp-threshold', -60, 0, 1).name('Seuil (dB)').onChange(v => this._onTopDsp && this._onTopDsp('comp-threshold', v));
        this.controllers['top:comp-ratio'] = fTopComp.add(this.state.top, 'comp-ratio', 1, 20, 0.5).name('Ratio (:1)').onChange(v => this._onTopDsp && this._onTopDsp('comp-ratio', v));
        this.controllers['top:comp-attack'] = fTopComp.add(this.state.top, 'comp-attack', 0, 100, 1).name('Attaque (ms)').onChange(v => this._onTopDsp && this._onTopDsp('comp-attack', v));
        this.controllers['top:comp-release'] = fTopComp.add(this.state.top, 'comp-release', 10, 1000, 10).name('Relâchement (ms)').onChange(v => this._onTopDsp && this._onTopDsp('comp-release', v));
        this.controllers['top:comp-knee'] = fTopComp.add(this.state.top, 'comp-knee', 0, 40, 1).name('Knee (dB)').onChange(v => this._onTopDsp && this._onTopDsp('comp-knee', v));
        this.controllers['top:sat-drive'] = fTopComp.add(this.state.top, 'sat-drive', 0, 100, 1).name('Drive Sat (%)').onChange(v => this._onTopDsp && this._onTopDsp('sat-drive', v));
        this.controllers['top:sat-mix'] = fTopComp.add(this.state.top, 'sat-mix', 0, 100, 1).name('Mix Sat (%)').onChange(v => this._onTopDsp && this._onTopDsp('sat-mix', v));

        const fTopAcoustics = fTop.addFolder('Limiteur & Acoustique');
        this.controllers['top:lim-threshold'] = fTopAcoustics.add(this.state.top, 'lim-threshold', -12, 0, 0.5).name('Seuil Limiteur (dB)').onChange(v => this._onTopDsp && this._onTopDsp('lim-threshold', v));
        this.controllers['top:dist-k'] = fTopAcoustics.add(this.state.top, 'dist-k', 0, 200, 5).name('Atténuation (k)').onChange(v => this._onTopDsp && this._onTopDsp('dist-k', v));
        this.controllers['top:refl-gain'] = fTopAcoustics.add(this.state.top, 'refl-gain', 0, 100, 1).name('Gain Réflexion (%)').onChange(v => this._onTopDsp && this._onTopDsp('refl-gain', v));
        this.controllers['top:refl-lpf'] = fTopAcoustics.add(this.state.top, 'refl-lpf', 200, 8000, 100).name('Filtre Réflexion (Hz)').onChange(v => this._onTopDsp && this._onTopDsp('refl-lpf', v));

        // ── 🔉 Bus FILL ──
        const fFill = this.gui.addFolder('🔉 Bus FILL');
        this.controllers['fill:bus-volume'] = fFill.add(this.state.fill, 'bus-volume', 0, 200, 1).name('Volume FILL (%)').onChange(v => this._onFillDsp && this._onFillDsp('bus-volume', v));
        this.controllers['fill:merge-gain'] = fFill.add(this.state.fill, 'merge-gain', 0, 100, 1).name('Merge Gain (%)').onChange(v => this._onFillDsp && this._onFillDsp('merge-gain', v));

        const fFillAcoustics = fFill.addFolder('Limiteur & Acoustique');
        this.controllers['fill:lim-threshold'] = fFillAcoustics.add(this.state.fill, 'lim-threshold', -12, 0, 0.5).name('Seuil Limiteur (dB)').onChange(v => this._onFillDsp && this._onFillDsp('lim-threshold', v));
        this.controllers['fill:dist-k'] = fFillAcoustics.add(this.state.fill, 'dist-k', 0, 200, 5).name('Atténuation (k)').onChange(v => this._onFillDsp && this._onFillDsp('dist-k', v));
        this.controllers['fill:refl-gain'] = fFillAcoustics.add(this.state.fill, 'refl-gain', 0, 100, 1).name('Gain Réflexion (%)').onChange(v => this._onFillDsp && this._onFillDsp('refl-gain', v));
        this.controllers['fill:refl-lpf'] = fFillAcoustics.add(this.state.fill, 'refl-lpf', 200, 8000, 100).name('Filtre Réflexion (Hz)').onChange(v => this._onFillDsp && this._onFillDsp('refl-lpf', v));

        // ── 🌿 Graphismes & Affichage ──
        const fGraphics = this.gui.addFolder('🌿 Graphismes & Affichage');
        this.controllers['graphics:grass'] = fGraphics.add(this.state.graphics, 'grass', {
            'Désactivée (Max FPS)': 'off',
            'Éco': 'low',
            'Normale': 'medium',
            'Haute': 'high'
        }).name('Herbe 3D').onChange(v => this._onGrassChange && this._onGrassChange(v));

        this.controllers['graphics:oscilloscope'] = fGraphics.add(this.state.graphics, 'oscilloscope').name('📈 Oscilloscope').onChange(v => {
            if (this._onOscilloscopeToggle) this._onOscilloscopeToggle(v);
        });

        const fCones = fGraphics.addFolder('Cônes de diffusion');
        this.controllers['graphics:conesAll'] = fCones.add(this.state.graphics, 'conesAll').name('💠 Tous les cônes').onChange(v => {
            this.state.graphics.conesSub = v;
            this.state.graphics.conesMid = v;
            this.state.graphics.conesTop = v;
            this.state.graphics.conesFill = v;
            this.controllers['graphics:conesSub'].updateDisplay();
            this.controllers['graphics:conesMid'].updateDisplay();
            this.controllers['graphics:conesTop'].updateDisplay();
            this.controllers['graphics:conesFill'].updateDisplay();
            if (this._onConesToggle) this._onConesToggle('all', v);
        });
        this.controllers['graphics:conesSub'] = fCones.add(this.state.graphics, 'conesSub').name('SUB').onChange(v => {
            if (this._onConesToggle) this._onConesToggle('sub', v);
            this._checkConesAll();
        });
        this.controllers['graphics:conesMid'] = fCones.add(this.state.graphics, 'conesMid').name('MID').onChange(v => {
            if (this._onConesToggle) this._onConesToggle('mid', v);
            this._checkConesAll();
        });
        this.controllers['graphics:conesTop'] = fCones.add(this.state.graphics, 'conesTop').name('TOP').onChange(v => {
            if (this._onConesToggle) this._onConesToggle('top', v);
            this._checkConesAll();
        });
        this.controllers['graphics:conesFill'] = fCones.add(this.state.graphics, 'conesFill').name('FILL').onChange(v => {
            if (this._onConesToggle) this._onConesToggle('fill', v);
            this._checkConesAll();
        });

        // ── 🎧 Spatialisation & 3D ──
        const fSpatial = this.gui.addFolder('🎧 Spatialisation & Audio 3D');
        this.controllers['spatial:hrtf'] = fSpatial.add(this.state.spatial, 'hrtf').name('🎧 Binaural HRTF').onChange(v => {
            if (this._onHrtfToggle) this._onHrtfToggle(v);
            const db = v ? this.state.spatial.hrtfBrightness : 0;
            if (this._onHrtfBrightness) this._onHrtfBrightness(db);
        });
        this.controllers['spatial:hrtfBrightness'] = fSpatial.add(this.state.spatial, 'hrtfBrightness', 0, 12, 0.5).name('✨ Brillance (dB)').onChange(v => {
            if (this.state.spatial.hrtf && this._onHrtfBrightness) this._onHrtfBrightness(v);
        });
        this.controllers['spatial:doppler'] = fSpatial.add(this.state.spatial, 'doppler').name('🔊 Effet Doppler').onChange(v => {
            if (this._onDopplerToggle) this._onDopplerToggle(v);
        });

        // ── ⚡ Actions ──
        const fActions = this.gui.addFolder('⚡ Actions');
        this.playBtnController = fActions.add(this.state.actions, 'playPause').name('⏸ Pause');
        fActions.add(this.state.actions, 'loadMp3').name('📂 Charger un MP3');
        fActions.add(this.state.actions, 'resetAll').name('↺ Réinitialiser par défaut');
    }

    _checkConesAll() {
        const { conesSub, conesMid, conesTop, conesFill } = this.state.graphics;
        this.state.graphics.conesAll = conesSub && conesMid && conesTop && conesFill;
        if (this.controllers['graphics:conesAll']) {
            this.controllers['graphics:conesAll'].updateDisplay();
        }
    }

    _initHud() {
        if (this.dspBtn) {
            this.dspBtn.textContent = '⚙️ Options';
            this.dspBtn.classList.toggle('active', this._guiVisible);
            this.dspBtn.addEventListener('click', () => {
                this._guiVisible = !this._guiVisible;
                this.gui.show(this._guiVisible);
                this.dspBtn.classList.toggle('active', this._guiVisible);
            });
        }

        if (this.playBtn) {
            this.playBtn.addEventListener('click', () => {
                if (this._onPlayPause) this._onPlayPause();
            });
        }

        if (this.changeMp3Btn) {
            this.changeMp3Btn.addEventListener('click', () => {
                this._triggerFilePicker();
            });
        }

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

    _triggerFilePicker() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.mp3,.wav,audio/mpeg,audio/wav';
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file && this._onChangeMp3) this._onChangeMp3(file);
        });
        input.click();
    }

    resetAllDefaults() {
        Object.assign(this.state.master, DSP_DEFAULTS.master);
        Object.assign(this.state.sub, DSP_DEFAULTS.sub);
        Object.assign(this.state.mid, DSP_DEFAULTS.mid);
        Object.assign(this.state.top, DSP_DEFAULTS.top);
        Object.assign(this.state.fill, DSP_DEFAULTS.fill);

        for (const [k, v] of Object.entries(this.state.master)) {
            if (this._onMasterDsp) this._onMasterDsp(k, v);
        }
        for (const [k, v] of Object.entries(this.state.sub)) {
            if (this._onSubDsp) this._onSubDsp(k, v);
        }
        for (const [k, v] of Object.entries(this.state.mid)) {
            if (this._onMidDsp) this._onMidDsp(k, v);
        }
        for (const [k, v] of Object.entries(this.state.top)) {
            if (this._onTopDsp) this._onTopDsp(k, v);
        }
        for (const [k, v] of Object.entries(this.state.fill)) {
            if (this._onFillDsp) this._onFillDsp(k, v);
        }

        this.gui.controllersRecursive().forEach(c => c.updateDisplay());
    }

    setPlayState(isPlaying) {
        this._isPlaying = isPlaying;
        if (this.playBtn) {
            this.playBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
        }
        if (this.playBtnController) {
            this.playBtnController.name(isPlaying ? '⏸ Pause' : '▶ Lecture');
        }
    }

    setGrassQuality(key) {
        this.state.graphics.grass = key;
        if (this.controllers['graphics:grass']) {
            this.controllers['graphics:grass'].updateDisplay();
        }
    }

    setOscilloscope(enabled) {
        this.state.graphics.oscilloscope = enabled;
        if (this.controllers['graphics:oscilloscope']) {
            this.controllers['graphics:oscilloscope'].updateDisplay();
        }
    }

    setHrtf(enabled) {
        this.state.spatial.hrtf = enabled;
        if (this.controllers['spatial:hrtf']) {
            this.controllers['spatial:hrtf'].updateDisplay();
        }
    }

    setDoppler(enabled) {
        this.state.spatial.doppler = enabled;
        if (this.controllers['spatial:doppler']) {
            this.controllers['spatial:doppler'].updateDisplay();
        }
    }

    // Callbacks registrations
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
