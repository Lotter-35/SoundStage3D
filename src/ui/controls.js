/**
 * Controls — UI overlay with separated lil-gui panels:
 * - Master & Environment (top-right)
 * - TOP & MID Pipelines (bottom-left)
 * - FILL & SUB Pipelines (bottom-right)
 * - Quick HUD action bar (Cônes, HRTF, Doppler, Oscillo, Herbe, Play/Pause, Changer MP3, Debug)
 * - Interactive tooltips on hover
 * - Individual reset buttons (↺) on each option
 * - Smooth continuous slider dragging with high precision
 */
import GUI from 'lil-gui';
import { DSP_DEFAULTS } from '../config/dsp-defaults.js';
import { DSP_TOOLTIPS } from '../config/dsp-tooltips.js';

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
        this.tooltipEl = document.getElementById('dsp-tooltip');
        this._tooltipTimer = null;

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

        // UI visibility state
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

    /** Helper to attach floating tooltip and per-option reset button */
    _setupController(ctrl, tooltipKey, defaultValue, isLeftGroup) {
        // 1. Tooltip
        const tipText = DSP_TOOLTIPS[tooltipKey];
        if (tipText && this.tooltipEl) {
            ctrl.domElement.setAttribute('data-tooltip', tipText);
            ctrl.domElement.addEventListener('mouseenter', () => {
                clearTimeout(this._tooltipTimer);
                this.tooltipEl.textContent = tipText;
                const rect = ctrl.domElement.getBoundingClientRect();
                const ttWidth = 280;
                let top = rect.top + rect.height / 2;
                let left;

                if (isLeftGroup) {
                    left = rect.right + 14;
                    this.tooltipEl.classList.add('arrow-right');
                } else {
                    left = rect.left - ttWidth - 14;
                    this.tooltipEl.classList.remove('arrow-right');
                }

                this.tooltipEl.classList.add('visible');
                this.tooltipEl.style.left = Math.max(8, left) + 'px';
                const ttHeight = this.tooltipEl.offsetHeight || 60;
                top = Math.max(8, Math.min(window.innerHeight - ttHeight - 8, top - ttHeight / 2));
                this.tooltipEl.style.top = top + 'px';
            });

            ctrl.domElement.addEventListener('mouseleave', () => {
                this._tooltipTimer = setTimeout(() => {
                    this.tooltipEl.classList.remove('visible');
                }, 80);
            });
        }

        // 2. Individual Reset Button
        if (defaultValue !== undefined) {
            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'lil-reset-btn';
            resetBtn.textContent = '↺';
            resetBtn.title = 'Réinitialiser cette option';
            resetBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                ctrl.setValue(defaultValue);
            });

            // Append inside $widget so it stays inline with input and does not blow up controller width
            if (ctrl.$widget) {
                ctrl.$widget.appendChild(resetBtn);
            } else {
                ctrl.domElement.appendChild(resetBtn);
            }

            // Prevent default browser drag/selection when clicking slider so drag mousemove is never suppressed
            if (ctrl.$slider) {
                ctrl.$slider.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                });
            }

            // Double click on option row also resets
            ctrl.domElement.addEventListener('dblclick', (e) => {
                // If user double clicks on input, let them select text
                if (e.target.tagName === 'INPUT') return;
                e.stopPropagation();
                ctrl.setValue(defaultValue);
            });
        }
    }

    _addGuiResetButton(gui, busKey) {
        if (!gui || !gui.$title) return;
        const btn = document.createElement('span');
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.className = 'lil-panel-reset-btn';
        btn.textContent = '↺ Tout reset';
        btn.title = 'Réinitialiser tous les réglages de ce menu';

        const triggerReset = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const defaults = DSP_DEFAULTS[busKey];
            if (defaults) {
                gui.controllersRecursive().forEach(ctrl => {
                    const defVal = defaults[ctrl.property];
                    if (defVal !== undefined) {
                        ctrl.setValue(defVal);
                    }
                });
            } else {
                gui.reset(true);
            }
            if (busKey === 'master' && DSP_DEFAULTS.master) {
                localStorage.setItem('soundstage3d:master-mouse-sensitivity', DSP_DEFAULTS.master['mouse-sensitivity']);
            }
        };

        btn.addEventListener('click', triggerReset);
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                triggerReset(e);
            }
        });

        gui.$title.appendChild(btn);
    }

    _initGuis() {
        const cMaster = document.getElementById('dsp-panel-master');
        const cTop    = document.getElementById('dsp-panel-top');
        const cMid    = document.getElementById('dsp-panel-mid');
        const cFill   = document.getElementById('dsp-panel-fill');
        const cSub    = document.getElementById('dsp-panel-sub');

        // Stop click and mousedown from propagating to canvas when clicking panels
        const stopProp = (e) => e.stopPropagation();
        [cMaster, cTop, cMid, cFill, cSub].forEach(container => {
            if (container) {
                container.addEventListener('click', stopProp);
                container.addEventListener('mousedown', stopProp);
            }
        });

        // ─── 1. Master GUI (Top-Right, right group) ───
        if (cMaster) {
            const gui = new GUI({ container: cMaster, title: '🎚 Master & Environnement', closeFolders: false, width: 300 });
            this.guis.master = gui;

            const fEnv = gui.addFolder('Environnement');
            const cAir = fEnv.add(this.state.master, 'air-abs', 0, 50, 1).name('Abs. air (Hz/m)').onChange(v => this._onMasterDsp && this._onMasterDsp('air-abs', v));
            this._setupController(cAir, 'master-air-abs', DSP_DEFAULTS.master['air-abs'], false);

            const cTreble = fEnv.add(this.state.master, 'treble', 0, 15, 0.1).name('Aigus (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('treble', v));
            this._setupController(cTreble, 'master-treble', DSP_DEFAULTS.master['treble'], false);

            const cReverb = fEnv.add(this.state.master, 'reverb', 0, 100, 1).name('Réverb (%)').onChange(v => this._onMasterDsp && this._onMasterDsp('reverb', v));
            this._setupController(cReverb, 'master-reverb', DSP_DEFAULTS.master['reverb'], false);

            const fLocal = gui.addFolder('Volume local 🔒');
            const cVol = fLocal.add(this.state.master, 'local-volume', 0, 1000, 1).name('Volume (%)').onChange(v => this._onMasterDsp && this._onMasterDsp('local-volume', v));
            this._setupController(cVol, 'master-local-volume', DSP_DEFAULTS.master['local-volume'], false);

            const cSens = fLocal.add(this.state.master, 'mouse-sensitivity', 10, 300, 1).name('Souris (%)').onChange(v => {
                localStorage.setItem('soundstage3d:master-mouse-sensitivity', v);
                if (this._onMasterDsp) this._onMasterDsp('mouse-sensitivity', v);
            });
            this._setupController(cSens, 'master-mouse-sensitivity', DSP_DEFAULTS.master['mouse-sensitivity'], false);

            this._addGuiResetButton(gui, 'master');
        }

        // ─── 2. TOP GUI (Bottom-Left, left group) ───
        if (cTop) {
            const gui = new GUI({ container: cTop, title: '🔉 TOP Pipeline', closeFolders: false, width: 300 });
            this.guis.top = gui;

            const fXover = gui.addFolder('Crossover LR4');
            const cXover = fXover.add(this.state.top, 'xover-freq', 800, 6000, 1).name('High Freq (Hz)').onChange(v => this._onTopDsp && this._onTopDsp('xover-freq', v));
            this._setupController(cXover, 'top-xover-freq', DSP_DEFAULTS.top['xover-freq'], true);

            const fComp = gui.addFolder('Compresseur');
            const cThresh = fComp.add(this.state.top, 'comp-threshold', -60, 0, 0.1).name('Seuil (dB)').onChange(v => this._onTopDsp && this._onTopDsp('comp-threshold', v));
            this._setupController(cThresh, 'top-comp-threshold', DSP_DEFAULTS.top['comp-threshold'], true);

            const cKnee = fComp.add(this.state.top, 'comp-knee', 0, 40, 0.1).name('Knee (dB)').onChange(v => this._onTopDsp && this._onTopDsp('comp-knee', v));
            this._setupController(cKnee, 'top-comp-knee', DSP_DEFAULTS.top['comp-knee'], true);

            const cRatio = fComp.add(this.state.top, 'comp-ratio', 1, 20, 0.1).name('Ratio (:1)').onChange(v => this._onTopDsp && this._onTopDsp('comp-ratio', v));
            this._setupController(cRatio, 'top-comp-ratio', DSP_DEFAULTS.top['comp-ratio'], true);

            const cAttack = fComp.add(this.state.top, 'comp-attack', 0, 100, 0.5).name('Attaque (ms)').onChange(v => this._onTopDsp && this._onTopDsp('comp-attack', v));
            this._setupController(cAttack, 'top-comp-attack', DSP_DEFAULTS.top['comp-attack'], true);

            const cRel = fComp.add(this.state.top, 'comp-release', 10, 1000, 1).name('Release (ms)').onChange(v => this._onTopDsp && this._onTopDsp('comp-release', v));
            this._setupController(cRel, 'top-comp-release', DSP_DEFAULTS.top['comp-release'], true);

            const fSat = gui.addFolder('Saturation');
            const cSatDr = fSat.add(this.state.top, 'sat-drive', 0, 100, 1).name('Drive (%)').onChange(v => this._onTopDsp && this._onTopDsp('sat-drive', v));
            this._setupController(cSatDr, 'top-sat-drive', DSP_DEFAULTS.top['sat-drive'], true);

            const cSatMx = fSat.add(this.state.top, 'sat-mix', 0, 100, 1).name('Mix (%)').onChange(v => this._onTopDsp && this._onTopDsp('sat-mix', v));
            this._setupController(cSatMx, 'top-sat-mix', DSP_DEFAULTS.top['sat-mix'], true);

            const fVol = gui.addFolder('Volume Bus');
            const cVol = fVol.add(this.state.top, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this._onTopDsp && this._onTopDsp('bus-volume', v));
            this._setupController(cVol, 'top-bus-volume', DSP_DEFAULTS.top['bus-volume'], true);

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            const cLim = fAcoustics.add(this.state.top, 'lim-threshold', -12, 0, 0.1).name('Limiteur (dB)').onChange(v => this._onTopDsp && this._onTopDsp('lim-threshold', v));
            this._setupController(cLim, 'top-lim-threshold', DSP_DEFAULTS.top['lim-threshold'], true);

            const cDist = fAcoustics.add(this.state.top, 'dist-k', 0, 200, 1).name('Attén. dist (k)').onChange(v => this._onTopDsp && this._onTopDsp('dist-k', v));
            this._setupController(cDist, 'top-dist-k', DSP_DEFAULTS.top['dist-k'], true);

            const cReflG = fAcoustics.add(this.state.top, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this._onTopDsp && this._onTopDsp('refl-gain', v));
            this._setupController(cReflG, 'top-refl-gain', DSP_DEFAULTS.top['refl-gain'], true);

            const cReflF = fAcoustics.add(this.state.top, 'refl-lpf', 200, 8000, 1).name('LPF Réflec. (Hz)').onChange(v => this._onTopDsp && this._onTopDsp('refl-lpf', v));
            this._setupController(cReflF, 'top-refl-lpf', DSP_DEFAULTS.top['refl-lpf'], true);

            this._addGuiResetButton(gui, 'top');
        }

        // ─── 3. MID GUI (Bottom-Left, left group) ───
        if (cMid) {
            const gui = new GUI({ container: cMid, title: '🔉 MID Pipeline', closeFolders: false, width: 300 });
            this.guis.mid = gui;

            const fXover = gui.addFolder('Crossover LR4');
            const cLow = fXover.add(this.state.mid, 'xover-low', 40, 200, 1).name('Low Freq (Hz)').onChange(v => this._onMidDsp && this._onMidDsp('xover-low', v));
            this._setupController(cLow, 'mid-xover-low', DSP_DEFAULTS.mid['xover-low'], true);

            const cHigh = fXover.add(this.state.mid, 'xover-high', 800, 6000, 1).name('High Freq (Hz)').onChange(v => this._onMidDsp && this._onMidDsp('xover-high', v));
            this._setupController(cHigh, 'mid-xover-high', DSP_DEFAULTS.mid['xover-high'], true);

            const fComp = gui.addFolder('Compresseur');
            const cThresh = fComp.add(this.state.mid, 'comp-threshold', -60, 0, 0.1).name('Seuil (dB)').onChange(v => this._onMidDsp && this._onMidDsp('comp-threshold', v));
            this._setupController(cThresh, 'mid-comp-threshold', DSP_DEFAULTS.mid['comp-threshold'], true);

            const cKnee = fComp.add(this.state.mid, 'comp-knee', 0, 40, 0.1).name('Knee (dB)').onChange(v => this._onMidDsp && this._onMidDsp('comp-knee', v));
            this._setupController(cKnee, 'mid-comp-knee', DSP_DEFAULTS.mid['comp-knee'], true);

            const cRatio = fComp.add(this.state.mid, 'comp-ratio', 1, 20, 0.1).name('Ratio (:1)').onChange(v => this._onMidDsp && this._onMidDsp('comp-ratio', v));
            this._setupController(cRatio, 'mid-comp-ratio', DSP_DEFAULTS.mid['comp-ratio'], true);

            const cAttack = fComp.add(this.state.mid, 'comp-attack', 0, 100, 0.5).name('Attaque (ms)').onChange(v => this._onMidDsp && this._onMidDsp('comp-attack', v));
            this._setupController(cAttack, 'mid-comp-attack', DSP_DEFAULTS.mid['comp-attack'], true);

            const cRel = fComp.add(this.state.mid, 'comp-release', 10, 1000, 1).name('Release (ms)').onChange(v => this._onMidDsp && this._onMidDsp('comp-release', v));
            this._setupController(cRel, 'mid-comp-release', DSP_DEFAULTS.mid['comp-release'], true);

            const fSat = gui.addFolder('Saturation');
            const cSatDr = fSat.add(this.state.mid, 'sat-drive', 0, 100, 1).name('Drive (%)').onChange(v => this._onMidDsp && this._onMidDsp('sat-drive', v));
            this._setupController(cSatDr, 'mid-sat-drive', DSP_DEFAULTS.mid['sat-drive'], true);

            const cSatMx = fSat.add(this.state.mid, 'sat-mix', 0, 100, 1).name('Mix (%)').onChange(v => this._onMidDsp && this._onMidDsp('sat-mix', v));
            this._setupController(cSatMx, 'mid-sat-mix', DSP_DEFAULTS.mid['sat-mix'], true);

            const fVol = gui.addFolder('Volume Bus');
            const cVol = fVol.add(this.state.mid, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this._onMidDsp && this._onMidDsp('bus-volume', v));
            this._setupController(cVol, 'mid-bus-volume', DSP_DEFAULTS.mid['bus-volume'], true);

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            const cLim = fAcoustics.add(this.state.mid, 'lim-threshold', -12, 0, 0.1).name('Limiteur (dB)').onChange(v => this._onMidDsp && this._onMidDsp('lim-threshold', v));
            this._setupController(cLim, 'mid-lim-threshold', DSP_DEFAULTS.mid['lim-threshold'], true);

            const cDist = fAcoustics.add(this.state.mid, 'dist-k', 0, 200, 1).name('Attén. dist (k)').onChange(v => this._onMidDsp && this._onMidDsp('dist-k', v));
            this._setupController(cDist, 'mid-dist-k', DSP_DEFAULTS.mid['dist-k'], true);

            const cReflG = fAcoustics.add(this.state.mid, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this._onMidDsp && this._onMidDsp('refl-gain', v));
            this._setupController(cReflG, 'mid-refl-gain', DSP_DEFAULTS.mid['refl-gain'], true);

            const cReflF = fAcoustics.add(this.state.mid, 'refl-lpf', 200, 8000, 1).name('LPF Réflec. (Hz)').onChange(v => this._onMidDsp && this._onMidDsp('refl-lpf', v));
            this._setupController(cReflF, 'mid-refl-lpf', DSP_DEFAULTS.mid['refl-lpf'], true);

            this._addGuiResetButton(gui, 'mid');
        }

        // ─── 4. FILL GUI (Bottom-Right, right group) ───
        if (cFill) {
            const gui = new GUI({ container: cFill, title: '🔉 FILL Pipeline', closeFolders: false, width: 300 });
            this.guis.fill = gui;

            const fMix = gui.addFolder('Mixage Source');
            const cMerge = fMix.add(this.state.fill, 'merge-gain', 0, 100, 1).name('Gain Mix (%)').onChange(v => this._onFillDsp && this._onFillDsp('merge-gain', v));
            this._setupController(cMerge, 'fill-merge-gain', DSP_DEFAULTS.fill['merge-gain'], false);

            const fVol = gui.addFolder('Volume Bus');
            const cVol = fVol.add(this.state.fill, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this._onFillDsp && this._onFillDsp('bus-volume', v));
            this._setupController(cVol, 'fill-bus-volume', DSP_DEFAULTS.fill['bus-volume'], false);

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            const cLim = fAcoustics.add(this.state.fill, 'lim-threshold', -12, 0, 0.1).name('Limiteur (dB)').onChange(v => this._onFillDsp && this._onFillDsp('lim-threshold', v));
            this._setupController(cLim, 'fill-lim-threshold', DSP_DEFAULTS.fill['lim-threshold'], false);

            const cDist = fAcoustics.add(this.state.fill, 'dist-k', 0, 200, 1).name('Attén. dist (k)').onChange(v => this._onFillDsp && this._onFillDsp('dist-k', v));
            this._setupController(cDist, 'fill-dist-k', DSP_DEFAULTS.fill['dist-k'], false);

            const cReflG = fAcoustics.add(this.state.fill, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this._onFillDsp && this._onFillDsp('refl-gain', v));
            this._setupController(cReflG, 'fill-refl-gain', DSP_DEFAULTS.fill['refl-gain'], false);

            const cReflF = fAcoustics.add(this.state.fill, 'refl-lpf', 200, 8000, 1).name('LPF Réflec. (Hz)').onChange(v => this._onFillDsp && this._onFillDsp('refl-lpf', v));
            this._setupController(cReflF, 'fill-refl-lpf', DSP_DEFAULTS.fill['refl-lpf'], false);

            this._addGuiResetButton(gui, 'fill');
        }

        // ─── 5. SUB GUI (Bottom-Right, right group) ───
        if (cSub) {
            const gui = new GUI({ container: cSub, title: '🔉 SUB Pipeline', closeFolders: false, width: 300 });
            this.guis.sub = gui;

            const fXover = gui.addFolder('Crossover LR4');
            const cLow = fXover.add(this.state.sub, 'xover-freq', 40, 150, 1).name('Low Freq (Hz)').onChange(v => this._onSubDsp && this._onSubDsp('xover-freq', v));
            this._setupController(cLow, 'sub-xover-freq', DSP_DEFAULTS.sub['xover-freq'], false);

            const fComp = gui.addFolder('Compresseur');
            const cThresh = fComp.add(this.state.sub, 'comp-threshold', -60, 0, 0.1).name('Seuil (dB)').onChange(v => this._onSubDsp && this._onSubDsp('comp-threshold', v));
            this._setupController(cThresh, 'sub-comp-threshold', DSP_DEFAULTS.sub['comp-threshold'], false);

            const cKnee = fComp.add(this.state.sub, 'comp-knee', 0, 40, 0.1).name('Knee (dB)').onChange(v => this._onSubDsp && this._onSubDsp('comp-knee', v));
            this._setupController(cKnee, 'sub-comp-knee', DSP_DEFAULTS.sub['comp-knee'], false);

            const cRatio = fComp.add(this.state.sub, 'comp-ratio', 1, 20, 0.1).name('Ratio (:1)').onChange(v => this._onSubDsp && this._onSubDsp('comp-ratio', v));
            this._setupController(cRatio, 'sub-comp-ratio', DSP_DEFAULTS.sub['comp-ratio'], false);

            const cAttack = fComp.add(this.state.sub, 'comp-attack', 0, 100, 0.5).name('Attaque (ms)').onChange(v => this._onSubDsp && this._onSubDsp('comp-attack', v));
            this._setupController(cAttack, 'sub-comp-attack', DSP_DEFAULTS.sub['comp-attack'], false);

            const cRel = fComp.add(this.state.sub, 'comp-release', 10, 1000, 1).name('Release (ms)').onChange(v => this._onSubDsp && this._onSubDsp('comp-release', v));
            this._setupController(cRel, 'sub-comp-release', DSP_DEFAULTS.sub['comp-release'], false);

            const fSat = gui.addFolder('Saturation');
            const cSatDr = fSat.add(this.state.sub, 'sat-drive', 0, 100, 1).name('Drive (%)').onChange(v => this._onSubDsp && this._onSubDsp('sat-drive', v));
            this._setupController(cSatDr, 'sub-sat-drive', DSP_DEFAULTS.sub['sat-drive'], false);

            const cSatMx = fSat.add(this.state.sub, 'sat-mix', 0, 100, 1).name('Mix (%)').onChange(v => this._onSubDsp && this._onSubDsp('sat-mix', v));
            this._setupController(cSatMx, 'sub-sat-mix', DSP_DEFAULTS.sub['sat-mix'], false);

            const fProx = gui.addFolder('Saturation Proximité');
            const cProxFar = fProx.add(this.state.sub, 'prox-far', 1, 15, 0.1).name('Dist. Début (m)').onChange(v => this._onSubDsp && this._onSubDsp('prox-far', v));
            this._setupController(cProxFar, 'sub-prox-far', DSP_DEFAULTS.sub['prox-far'], false);

            const cProxNear = fProx.add(this.state.sub, 'prox-near', 0.5, 5, 0.1).name('Dist. Max (m)').onChange(v => this._onSubDsp && this._onSubDsp('prox-near', v));
            this._setupController(cProxNear, 'sub-prox-near', DSP_DEFAULTS.sub['prox-near'], false);

            const cProxDr = fProx.add(this.state.sub, 'prox-drive', 0, 100, 1).name('Drive Max (%)').onChange(v => this._onSubDsp && this._onSubDsp('prox-drive', v));
            this._setupController(cProxDr, 'sub-prox-drive', DSP_DEFAULTS.sub['prox-drive'], false);

            const fVol = gui.addFolder('Volume Bus');
            const cVol = fVol.add(this.state.sub, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this._onSubDsp && this._onSubDsp('bus-volume', v));
            this._setupController(cVol, 'sub-bus-volume', DSP_DEFAULTS.sub['bus-volume'], false);

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            const cLim = fAcoustics.add(this.state.sub, 'lim-threshold', -12, 0, 0.1).name('Limiteur (dB)').onChange(v => this._onSubDsp && this._onSubDsp('lim-threshold', v));
            this._setupController(cLim, 'sub-lim-threshold', DSP_DEFAULTS.sub['lim-threshold'], false);

            const cDist = fAcoustics.add(this.state.sub, 'dist-k', 0, 200, 1).name('Attén. dist (k)').onChange(v => this._onSubDsp && this._onSubDsp('dist-k', v));
            this._setupController(cDist, 'sub-dist-k', DSP_DEFAULTS.sub['dist-k'], false);

            const cReflG = fAcoustics.add(this.state.sub, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this._onSubDsp && this._onSubDsp('refl-gain', v));
            this._setupController(cReflG, 'sub-refl-gain', DSP_DEFAULTS.sub['refl-gain'], false);

            const cReflF = fAcoustics.add(this.state.sub, 'refl-lpf', 200, 8000, 1).name('LPF Réflec. (Hz)').onChange(v => this._onSubDsp && this._onSubDsp('refl-lpf', v));
            this._setupController(cReflF, 'sub-refl-lpf', DSP_DEFAULTS.sub['refl-lpf'], false);

            this._addGuiResetButton(gui, 'sub');
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
