/**
 * Controls — UI overlay with separated lil-gui panels:
 * - Master & Environment (top-right)
 * - TOP & MID Pipelines (bottom-left)
 * - FILL & SUB Pipelines (bottom-right)
 * - Quick HUD action bar (Cônes, HRTF, Spectre, Sinus, Herbe, Play/Pause, Changer MP3, Debug)
 * - Interactive tooltips on hover
 * - Individual reset buttons (↺) on each option
 * - Smooth continuous slider dragging with high precision
 */
import GUI from 'lil-gui';
import { DSP_DEFAULTS } from '../config/dsp-defaults.js';
import { DSP_TOOLTIPS } from '../config/dsp-tooltips.js';
import { makeDraggable } from './draggable.js';

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
        this.envPanelWrap = document.getElementById('env-panel-wrap');
        this.userPanelWrap = document.getElementById('user-panel-wrap');
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
        this._onSpectrumToggle = null;
        this._onConesToggle = null;
        this._onHrtfToggle = null;
        this._onHrtfBrightness = null;
        this._onGrassChange = null;
        this._onMasterDsp = null;
        this._onEnvDsp = null;
        this._onUserDsp = null;
        this._onInputDsp = null;
        this._onSubDsp = null;
        this._onMidDsp = null;
        this._onTopDsp = null;
        this._onFillDsp = null;
        this._onSineToggle = null;
        this._onSineFrequency = null;
        this._onSineVolume = null;

        // UI visibility state
        this._dspVisible = false;
        this._sinePanelVisible = false;
        this.sineBtn = document.getElementById('sine-btn');
        this.sinePanelWrap = document.getElementById('sine-panel-wrap');

        // State models for each bus
        const savedSens = localStorage.getItem('soundstage3d:master-mouse-sensitivity');
        const savedInvY = localStorage.getItem('soundstage3d:master-invert-y');
        const savedInvX = localStorage.getItem('soundstage3d:master-invert-x');
        this.state = {
            master: { ...DSP_DEFAULTS.master },
            env:    { ...DSP_DEFAULTS.env },
            user: {
                ...DSP_DEFAULTS.user,
                'mouse-sensitivity': savedSens !== null ? Number(savedSens) : (DSP_DEFAULTS.user?.['mouse-sensitivity'] ?? 100),
                'invert-y': savedInvY === 'true',
                'invert-x': savedInvX === 'true',
                'grass-enabled': false,
            },
            input: {
                ...DSP_DEFAULTS.input,
                'measured-lufs': '--',
                'applied-gain': '0.0 dB',
            },
            sub:  { ...DSP_DEFAULTS.sub },
            mid:  { ...DSP_DEFAULTS.mid },
            top:  { ...DSP_DEFAULTS.top },
            fill: { ...DSP_DEFAULTS.fill },
            sine: {
                active: false,
                frequency: 440,
                volume: 50,
            },
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
                localStorage.setItem('soundstage3d:master-uncapped-fps', 'false');
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

    _addSineResetButton(gui) {
        if (!gui || !gui.$title) return;
        const btn = document.createElement('span');
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.className = 'lil-panel-reset-btn';
        btn.textContent = '↺ Tout reset';
        btn.title = 'Réinitialiser le générateur sinus aux valeurs par défaut';

        const triggerReset = (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.resetSine();
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
        const cEnv    = document.getElementById('dsp-panel-env');
        const cUser   = document.getElementById('dsp-panel-user');
        const cInput  = document.getElementById('dsp-panel-input');
        const cTop    = document.getElementById('dsp-panel-top');
        const cMid    = document.getElementById('dsp-panel-mid');
        const cFill   = document.getElementById('dsp-panel-fill');
        const cSub    = document.getElementById('dsp-panel-sub');
        const cSine   = document.getElementById('sine-panel');

        // Stop click and mousedown from propagating to canvas when clicking panels
        const stopProp = (e) => e.stopPropagation();
        [cMaster, cEnv, cUser, cInput, cTop, cMid, cFill, cSub, cSine].forEach(container => {
            if (container) {
                container.addEventListener('click', stopProp);
                container.addEventListener('mousedown', stopProp);
            }
        });

        // ─── 1. MASTER OUT Stage GUI (Bottom-Right, above SUB) ───
        if (cMaster) {
            const gui = new GUI({ container: cMaster, title: '🎚️ MASTER OUT Stage', closeFolders: true, width: 300 });
            this.guis.master = gui;

            // Étape 1 : Égaliseur Global du Festival (Master EQ 4 bandes)
            const fEq = gui.addFolder('Étape 1 : EQ Global Festival');
            const cEqLow = fEq.add(this.state.master, 'eq-low', -12, 12, 0.5).name('Graves 80Hz (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('eq-low', v));
            this._setupController(cEqLow, 'master-eq-low', DSP_DEFAULTS.master['eq-low'], false);

            const cEqMidLow = fEq.add(this.state.master, 'eq-mid-low', -12, 12, 0.5).name('Bas-Méd 400Hz (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('eq-mid-low', v));
            this._setupController(cEqMidLow, 'master-eq-mid-low', DSP_DEFAULTS.master['eq-mid-low'], false);

            const cEqMidHigh = fEq.add(this.state.master, 'eq-mid-high', -12, 12, 0.5).name('Haut-Méd 2.5k (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('eq-mid-high', v));
            this._setupController(cEqMidHigh, 'master-eq-mid-high', DSP_DEFAULTS.master['eq-mid-high'], false);

            const cEqHigh = fEq.add(this.state.master, 'eq-high', -12, 12, 0.5).name('Aigus 10kHz (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('eq-high', v));
            this._setupController(cEqHigh, 'master-eq-high', DSP_DEFAULTS.master['eq-high'], false);

            // Étape 2 : Compresseur de Bus ("Glue Compressor")
            const fComp = gui.addFolder('Étape 2 : Compresseur de Bus');
            const cCompOn = fComp.add(this.state.master, 'comp-enabled').name('Actif').onChange(v => this._onMasterDsp && this._onMasterDsp('comp-enabled', v));
            this._setupController(cCompOn, 'master-comp-enabled', DSP_DEFAULTS.master['comp-enabled'], false);

            const cThresh = fComp.add(this.state.master, 'comp-threshold', -40, 0, 0.5).name('Seuil (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('comp-threshold', v));
            this._setupController(cThresh, 'master-comp-threshold', DSP_DEFAULTS.master['comp-threshold'], false);

            const cRatio = fComp.add(this.state.master, 'comp-ratio', 1, 20, 0.1).name('Ratio (:1)').onChange(v => this._onMasterDsp && this._onMasterDsp('comp-ratio', v));
            this._setupController(cRatio, 'master-comp-ratio', DSP_DEFAULTS.master['comp-ratio'], false);

            const cAtt = fComp.add(this.state.master, 'comp-attack', 0.1, 100, 0.5).name('Attaque (ms)').onChange(v => this._onMasterDsp && this._onMasterDsp('comp-attack', v));
            this._setupController(cAtt, 'master-comp-attack', DSP_DEFAULTS.master['comp-attack'], false);

            const cRel = fComp.add(this.state.master, 'comp-release', 10, 1000, 5).name('Release (ms)').onChange(v => this._onMasterDsp && this._onMasterDsp('comp-release', v));
            this._setupController(cRel, 'master-comp-release', DSP_DEFAULTS.master['comp-release'], false);

            const cMakeup = fComp.add(this.state.master, 'comp-makeup', -6, 18, 0.5).name('Make-up (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('comp-makeup', v));
            this._setupController(cMakeup, 'master-comp-makeup', DSP_DEFAULTS.master['comp-makeup'], false);

            // Étape 3 : Limiteur de Sortie Final (True Peak / Brickwall)
            const fLim = gui.addFolder('Étape 3 : Limiteur de Sortie');
            const cLimOn = fLim.add(this.state.master, 'limiter-enabled').name('Actif').onChange(v => this._onMasterDsp && this._onMasterDsp('limiter-enabled', v));
            this._setupController(cLimOn, 'master-limiter-enabled', DSP_DEFAULTS.master['limiter-enabled'], false);

            const cCeil = fLim.add(this.state.master, 'limiter-threshold', -12, 0, 0.1).name('Plafond (dBFS)').onChange(v => this._onMasterDsp && this._onMasterDsp('limiter-threshold', v));
            this._setupController(cCeil, 'master-limiter-threshold', DSP_DEFAULTS.master['limiter-threshold'], false);

            const cLimAtt = fLim.add(this.state.master, 'limiter-attack', 0.1, 10, 0.1).name('Attaque (ms)').onChange(v => this._onMasterDsp && this._onMasterDsp('limiter-attack', v));
            this._setupController(cLimAtt, 'master-limiter-attack', DSP_DEFAULTS.master['limiter-attack'], false);

            const cLimRel = fLim.add(this.state.master, 'limiter-release', 10, 500, 5).name('Release (ms)').onChange(v => this._onMasterDsp && this._onMasterDsp('limiter-release', v));
            this._setupController(cLimRel, 'master-limiter-release', DSP_DEFAULTS.master['limiter-release'], false);

            this._addGuiResetButton(gui, 'master');
        }

        // ─── 1.2 ENVIRONNEMENT Acoustique GUI (Top-Right) ───
        if (cEnv) {
            const gui = new GUI({ container: cEnv, title: '🌳 Environnement Acoustique', closeFolders: false, width: 300 });
            this.guis.env = gui;

            const fAir = gui.addFolder('Atmosphère');
            const cAir = fAir.add(this.state.env, 'air-abs', 0, 50, 1).name('Abs. air (Hz/m)').onChange(v => this._onEnvDsp && this._onEnvDsp('air-abs', v));
            this._setupController(cAir, 'env-air-abs', DSP_DEFAULTS.env['air-abs'], false);

            const cTreble = fAir.add(this.state.env, 'treble', 0, 15, 0.5).name('Aigus (dB)').onChange(v => this._onEnvDsp && this._onEnvDsp('treble', v));
            this._setupController(cTreble, 'env-treble', DSP_DEFAULTS.env['treble'], false);

            const fRev = gui.addFolder('Réverbération Acoustique');
            const cWet = fRev.add(this.state.env, 'reverb-wet', 0, 100, 1).name('Dry / Wet (%)').onChange(v => this._onEnvDsp && this._onEnvDsp('reverb-wet', v));
            this._setupController(cWet, 'env-reverb-wet', DSP_DEFAULTS.env['reverb-wet'], false);

            const cDecay = fRev.add(this.state.env, 'reverb-decay', 0.5, 8.0, 0.1).name('Durée RT60 (s)').onChange(v => this._onEnvDsp && this._onEnvDsp('reverb-decay', v));
            this._setupController(cDecay, 'env-reverb-decay', DSP_DEFAULTS.env['reverb-decay'], false);

            const cDamp = fRev.add(this.state.env, 'reverb-damping', 1000, 18000, 100).name('Amort. HF (Hz)').onChange(v => this._onEnvDsp && this._onEnvDsp('reverb-damping', v));
            this._setupController(cDamp, 'env-reverb-damping', DSP_DEFAULTS.env['reverb-damping'], false);

            const cPre = fRev.add(this.state.env, 'reverb-predelay', 0, 100, 1).name('Pré-délai (ms)').onChange(v => this._onEnvDsp && this._onEnvDsp('reverb-predelay', v));
            this._setupController(cPre, 'env-reverb-predelay', DSP_DEFAULTS.env['reverb-predelay'], false);

            this._addGuiResetButton(gui, 'env');
        }

        // ─── 1.3 CONTRÔLES Utilisateur GUI (Top-Right Offset) ───
        if (cUser) {
            const gui = new GUI({ container: cUser, title: '👤 Contrôles Utilisateur', closeFolders: false, width: 300 });
            this.guis.user = gui;

            const fAudio = gui.addFolder('Écoute & Environnement');
            const cVol = fAudio.add(this.state.user, 'local-volume', 0, 1000, 1).name('Volume local (%)').onChange(v => this._onUserDsp && this._onUserDsp('local-volume', v));
            this._setupController(cVol, 'user-local-volume', DSP_DEFAULTS.user['local-volume'], false);

            const cGrass = fAudio.add(this.state.user, 'grass-enabled').name('🌿 Afficher herbe').onChange(v => {
                if (this._onGrassChange) this._onGrassChange(v ? 'medium' : 'off');
            });
            this._setupController(cGrass, 'user-grass-enabled', false, false);

            const fControls = gui.addFolder('Caméra & Navigation');
            const cSens = fControls.add(this.state.user, 'mouse-sensitivity', 10, 300, 1).name('Sensibilité (%)').onChange(v => {
                localStorage.setItem('soundstage3d:master-mouse-sensitivity', v);
                if (this._onUserDsp) this._onUserDsp('mouse-sensitivity', v);
            });
            this._setupController(cSens, 'user-mouse-sensitivity', 100, false);

            const cInvY = fControls.add(this.state.user, 'invert-y').name('Inverser Axe Y (H/B)').onChange(v => {
                localStorage.setItem('soundstage3d:master-invert-y', v);
                if (this._onUserDsp) this._onUserDsp('invert-y', v);
            });
            this._setupController(cInvY, 'user-invert-y', false, false);

            const cInvX = fControls.add(this.state.user, 'invert-x').name('Inverser Axe X (G/D)').onChange(v => {
                localStorage.setItem('soundstage3d:master-invert-x', v);
                if (this._onUserDsp) this._onUserDsp('invert-x', v);
            });
            this._setupController(cInvX, 'user-invert-x', false, false);

            this._addGuiResetButton(gui, 'user');
        }

        // ─── 1.5 INPUT Stage GUI (Above TOP Pipeline) ───
        if (cInput) {
            const gui = new GUI({ container: cInput, title: '🎚️ INPUT Stage', closeFolders: true, width: 300 });
            this.guis.input = gui;

            // 1. Normalisation LUFS / Auto-Gain
            const fLufs = gui.addFolder('Normalisation LUFS (Auto-Gain)');
            const cAutoGain = fLufs.add(this.state.input, 'auto-gain').name('Actif').onChange(v => this._onInputDsp && this._onInputDsp('auto-gain', v));
            this._setupController(cAutoGain, 'input-auto-gain', DSP_DEFAULTS.input['auto-gain'], true);

            const cTargetLufs = fLufs.add(this.state.input, 'target-lufs', [-14, -23, -16, -18, -20]).name('Cible LUFS').onChange(v => this._onInputDsp && this._onInputDsp('target-lufs', Number(v)));
            this._setupController(cTargetLufs, 'input-target-lufs', DSP_DEFAULTS.input['target-lufs'], true);

            this._inputLufsDisplay = fLufs.add(this.state.input, 'measured-lufs').name('LUFS mesuré').listen().disable();
            this._inputGainDisplay = fLufs.add(this.state.input, 'applied-gain').name('Gain appliqué').listen().disable();

            // 2. Input Trim / Pré-gain Global
            const fTrim = gui.addFolder('Pré-Gain Global (Trim)');
            const cTrim = fTrim.add(this.state.input, 'input-trim', 0, 200, 1).name('Trim (%)').onChange(v => this._onInputDsp && this._onInputDsp('input-trim', v));
            this._setupController(cTrim, 'input-trim', DSP_DEFAULTS.input['input-trim'], true);

            // 3. Égaliseur 3 Bandes
            const fEq = gui.addFolder('Égaliseur 3 Bandes');
            const cEqLow = fEq.add(this.state.input, 'eq-low', -12, 12, 0.5).name('Graves (dB)').onChange(v => this._onInputDsp && this._onInputDsp('eq-low', v));
            this._setupController(cEqLow, 'input-eq-low', DSP_DEFAULTS.input['eq-low'], true);

            const cEqMid = fEq.add(this.state.input, 'eq-mid', -12, 12, 0.5).name('Médiums (dB)').onChange(v => this._onInputDsp && this._onInputDsp('eq-mid', v));
            this._setupController(cEqMid, 'input-eq-mid', DSP_DEFAULTS.input['eq-mid'], true);

            const cEqHigh = fEq.add(this.state.input, 'eq-high', -12, 12, 0.5).name('Aigus (dB)').onChange(v => this._onInputDsp && this._onInputDsp('eq-high', v));
            this._setupController(cEqHigh, 'input-eq-high', DSP_DEFAULTS.input['eq-high'], true);

            // 4. Compresseur d'Entrée
            const fComp = gui.addFolder('Compresseur d\'Entrée');
            const cCompOn = fComp.add(this.state.input, 'comp-enabled').name('Actif').onChange(v => this._onInputDsp && this._onInputDsp('comp-enabled', v));
            this._setupController(cCompOn, 'input-comp-enabled', DSP_DEFAULTS.input['comp-enabled'], true);

            const cThresh = fComp.add(this.state.input, 'comp-threshold', -60, 0, 0.5).name('Seuil (dB)').onChange(v => this._onInputDsp && this._onInputDsp('comp-threshold', v));
            this._setupController(cThresh, 'input-comp-threshold', DSP_DEFAULTS.input['comp-threshold'], true);

            const cKnee = fComp.add(this.state.input, 'comp-knee', 0, 40, 0.5).name('Knee (dB)').onChange(v => this._onInputDsp && this._onInputDsp('comp-knee', v));
            this._setupController(cKnee, 'input-comp-knee', DSP_DEFAULTS.input['comp-knee'], true);

            const cRatio = fComp.add(this.state.input, 'comp-ratio', 1, 20, 0.1).name('Ratio (:1)').onChange(v => this._onInputDsp && this._onInputDsp('comp-ratio', v));
            this._setupController(cRatio, 'input-comp-ratio', DSP_DEFAULTS.input['comp-ratio'], true);

            const cAttack = fComp.add(this.state.input, 'comp-attack', 0, 100, 0.5).name('Attaque (ms)').onChange(v => this._onInputDsp && this._onInputDsp('comp-attack', v));
            this._setupController(cAttack, 'input-comp-attack', DSP_DEFAULTS.input['comp-attack'], true);

            const cRel = fComp.add(this.state.input, 'comp-release', 10, 1000, 1).name('Release (ms)').onChange(v => this._onInputDsp && this._onInputDsp('comp-release', v));
            this._setupController(cRel, 'input-comp-release', DSP_DEFAULTS.input['comp-release'], true);

            this._addGuiResetButton(gui, 'input');
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

            const cEnergy = fAcoustics.add(this.state.sub, 'energy-limit', 1, 7, 0.1).name('Limite énergie (subs)').onChange(v => this._onSubDsp && this._onSubDsp('energy-limit', v));
            this._setupController(cEnergy, 'sub-energy-limit', DSP_DEFAULTS.sub['energy-limit'], false);

            const cDist = fAcoustics.add(this.state.sub, 'dist-k', 0, 200, 1).name('Attén. dist (k)').onChange(v => this._onSubDsp && this._onSubDsp('dist-k', v));
            this._setupController(cDist, 'sub-dist-k', DSP_DEFAULTS.sub['dist-k'], false);

            const cReflG = fAcoustics.add(this.state.sub, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this._onSubDsp && this._onSubDsp('refl-gain', v));
            this._setupController(cReflG, 'sub-refl-gain', DSP_DEFAULTS.sub['refl-gain'], false);

            const cReflF = fAcoustics.add(this.state.sub, 'refl-lpf', 200, 8000, 1).name('LPF Réflec. (Hz)').onChange(v => this._onSubDsp && this._onSubDsp('refl-lpf', v));
            this._setupController(cReflF, 'sub-refl-lpf', DSP_DEFAULTS.sub['refl-lpf'], false);

            this._addGuiResetButton(gui, 'sub');
        }

        // ─── 6. SINE GENERATOR GUI (Bottom-Center) ───
        if (cSine) {
            const gui = new GUI({ container: cSine, title: '🔊 Générateur Sinus', closeFolders: false, width: 320 });
            this.guis.sine = gui;

            const cActive = gui.add(this.state.sine, 'active').name('Actif').onChange(v => {
                if (this._onSineToggle) this._onSineToggle(v);
            });
            this._setupController(cActive, 'sine-active', false, false);

            const cFreq = gui.add(this.state.sine, 'frequency', 0, 20000, 1).name('Fréquence (Hz)').onChange(v => {
                if (this._onSineFrequency) this._onSineFrequency(v);
            });
            this._setupController(cFreq, 'sine-frequency', 440, false);

            const cVol = gui.add(this.state.sine, 'volume', 0, 100, 1).name('Volume (%)').onChange(v => {
                if (this._onSineVolume) this._onSineVolume(v);
            });
            this._setupController(cVol, 'sine-volume', 50, false);

            const fPresets = gui.addFolder('Presets Fréquences');
            const presets = [
                { label: '40 Hz (Sub Infra)', val: 40 },
                { label: '80 Hz (Sub Kick)', val: 80 },
                { label: '250 Hz (Bas-Médium)', val: 250 },
                { label: '1 000 Hz (1 kHz Médium)', val: 1000 },
                { label: '4 000 Hz (4 kHz Aigu)', val: 4000 },
                { label: '10 000 Hz (10 kHz Brillance)', val: 10000 },
                { label: '15 000 Hz (15 kHz Ultra-Aigu)', val: 15000 },
            ];
            const presetActions = {};
            presets.forEach(p => {
                presetActions[p.label] = () => {
                    cFreq.setValue(p.val);
                };
                fPresets.add(presetActions, p.label);
            });
            fPresets.close();

            this._addSineResetButton(gui);
        }

        // Clean up any stale position saved when INPUT was stuck in the top-left or MASTER was in old top-right wrap
        try {
            const savedInputPos = localStorage.getItem('soundstage3d:win-pos:input');
            if (savedInputPos) {
                const parsed = JSON.parse(savedInputPos);
                if (parsed && typeof parsed.top === 'number' && parsed.top < 250) {
                    localStorage.removeItem('soundstage3d:win-pos:input');
                }
            }
            const savedMasterPos = localStorage.getItem('soundstage3d:win-pos:master');
            if (savedMasterPos) {
                const parsed = JSON.parse(savedMasterPos);
                if (parsed && typeof parsed.top === 'number' && parsed.top < 200) {
                    localStorage.removeItem('soundstage3d:win-pos:master');
                }
            }
        } catch (_) {}

        // Make all panels draggable by their title header
        if (this.guis.master?.$title) makeDraggable(document.getElementById('dsp-panel-master'), this.guis.master.$title, 'master');
        if (this.guis.input?.$title)  makeDraggable(document.getElementById('dsp-panel-input'), this.guis.input.$title, 'input');
        if (this.guis.top?.$title)    makeDraggable(document.getElementById('dsp-panel-top'), this.guis.top.$title, 'top');
        if (this.guis.mid?.$title)    makeDraggable(document.getElementById('dsp-panel-mid'), this.guis.mid.$title, 'mid');
        if (this.guis.fill?.$title)   makeDraggable(document.getElementById('dsp-panel-fill'), this.guis.fill.$title, 'fill');
        if (this.guis.sub?.$title)    makeDraggable(document.getElementById('dsp-panel-sub'), this.guis.sub.$title, 'sub');
        if (this.guis.env?.$title)    makeDraggable(document.getElementById('env-panel-wrap'), this.guis.env.$title, 'env');
        if (this.guis.user?.$title)   makeDraggable(document.getElementById('user-panel-wrap'), this.guis.user.$title, 'user');
        if (this.guis.sine?.$title)   makeDraggable(document.getElementById('sine-panel-wrap'), this.guis.sine.$title, 'sine');
    }

    _initHud() {
        // Toggle DSP panels visibility
        if (this.dspBtn) {
            this.dspBtn.textContent = '🎛 DSP';
            this.dspBtn.addEventListener('click', () => {
                this._dspVisible = !this._dspVisible;
                if (this.dspPanels) this.dspPanels.classList.toggle('hidden', !this._dspVisible);
                if (this.envPanelWrap) this.envPanelWrap.classList.toggle('hidden', !this._dspVisible);
                if (this.userPanelWrap) this.userPanelWrap.classList.toggle('hidden', !this._dspVisible);
                this.dspBtn.classList.toggle('active', this._dspVisible);
            });
        }

        // Toggle Sine Generator panel visibility
        if (this.sineBtn) {
            this.sineBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._sinePanelVisible = !this._sinePanelVisible;
                if (this.sinePanelWrap) this.sinePanelWrap.classList.toggle('hidden', !this._sinePanelVisible);
                this.sineBtn.classList.toggle('active', this._sinePanelVisible);
                this.sineBtn.textContent = this._sinePanelVisible ? '🔊 Sinus ▴' : '🔊 Sinus ▾';
            });
        }
        if (this.sinePanelWrap) {
            this.sinePanelWrap.addEventListener('pointerdown', (e) => e.stopPropagation());
            this.sinePanelWrap.addEventListener('mousedown', (e) => e.stopPropagation());
            this.sinePanelWrap.addEventListener('click', (e) => e.stopPropagation());
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

        // Spectrum FFT button
        this._spectrumOn = false;
        this.spectrumBtn = document.getElementById('spectrum-btn');
        if (this.spectrumBtn) {
            this.spectrumBtn.addEventListener('click', () => {
                this._spectrumOn = !this._spectrumOn;
                this.spectrumBtn.textContent = this._spectrumOn ? '📊 Spectre: ON' : '📊 Spectre: OFF';
                this.spectrumBtn.classList.toggle('active', this._spectrumOn);
                if (this._onSpectrumToggle) this._onSpectrumToggle(this._spectrumOn);
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

        // Camera View Mode button
        this.camBtn = document.getElementById('cam-btn');
        if (this.camBtn) {
            this.camBtn.addEventListener('click', () => {
                if (this._onCameraToggle) this._onCameraToggle();
            });
        }

        // Play/Pause button
        if (this.playBtn) {
            this.playBtn.addEventListener('click', () => {
                if (this._onPlayPause) this._onPlayPause();
            });
        }

        // Playback Head Controller (Bottom Center)
        this._playbackVisible = false;
        this._isPlaying = false;
        this._isUserScrubbing = false;
        this._onSeek = null;
        this._onSkip = null;
        this.playbackBtn = document.getElementById('playback-btn');
        this.playbackBarWrap = document.getElementById('playback-bar-wrap');
        this.pbTrackTitle = document.getElementById('pb-track-title');
        this.pbCloseBtn = document.getElementById('pb-close-btn');
        this.pbTimeCurrent = document.getElementById('pb-time-current');
        this.pbTimeTotal = document.getElementById('pb-time-total');
        this.pbSlider = document.getElementById('pb-slider');
        this.pbPrevBtn = document.getElementById('pb-prev-btn');
        this.pbPlayBtn = document.getElementById('pb-play-btn');
        this.pbNextBtn = document.getElementById('pb-next-btn');

        if (this.playbackBtn) {
            this.playbackBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._playbackVisible = !this._playbackVisible;
                if (this.playbackBarWrap) this.playbackBarWrap.classList.toggle('hidden', !this._playbackVisible);
                this.playbackBtn.classList.toggle('active', this._playbackVisible);
                this.playbackBtn.textContent = this._playbackVisible ? '⏱️ Lecteur ▴' : '⏱️ Lecteur ▾';

                if (this._playbackVisible && this.pbPlayBtn) {
                    this.pbPlayBtn.textContent = this._isPlaying ? '⏸' : '▶';
                }
            });
        }
        if (this.playbackBarWrap) {
            this.playbackBarWrap.addEventListener('pointerdown', (e) => e.stopPropagation());
            this.playbackBarWrap.addEventListener('mousedown', (e) => e.stopPropagation());
            this.playbackBarWrap.addEventListener('click', (e) => e.stopPropagation());
        }
        if (this.pbCloseBtn) {
            this.pbCloseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._playbackVisible = false;
                if (this.playbackBarWrap) this.playbackBarWrap.classList.add('hidden');
                if (this.playbackBtn) {
                    this.playbackBtn.classList.remove('active');
                    this.playbackBtn.textContent = '⏱️ Lecteur ▾';
                }
            });
        }
        if (this.pbSlider) {
            this.pbSlider.addEventListener('mousedown', () => { this._isUserScrubbing = true; });
            this.pbSlider.addEventListener('touchstart', () => { this._isUserScrubbing = true; }, { passive: true });
            this.pbSlider.addEventListener('input', () => {
                const val = Number(this.pbSlider.value);
                if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = this._formatTime(val);
            });
            this.pbSlider.addEventListener('change', () => {
                const val = Number(this.pbSlider.value);
                if (this._onSeek) this._onSeek(val);
                this._isUserScrubbing = false;
            });
            this.pbSlider.addEventListener('mouseup', () => { this._isUserScrubbing = false; });
            this.pbSlider.addEventListener('touchend', () => { this._isUserScrubbing = false; });
        }
        if (this.pbPrevBtn) {
            this.pbPrevBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._onPrev) {
                    this._onPrev();
                } else if (this._onSeek) {
                    this._onSeek(0);
                }
            });
        }
        if (this.pbNextBtn) {
            this.pbNextBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._onNext) {
                    this._onNext();
                } else if (this._onSeek) {
                    this._onSeek(0);
                }
            });
        }
        if (this.pbPlayBtn) {
            this.pbPlayBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._onPlayPause) this._onPlayPause();
            });
        }

        // Make playback controller and level meters draggable
        if (this.playbackBarWrap) {
            const pbHandle = this.playbackBarWrap.querySelector('.pb-info') || this.playbackBarWrap;
            makeDraggable(this.playbackBarWrap, pbHandle, 'playback');
        }
        const metersEl = document.getElementById('meters');
        if (metersEl) {
            makeDraggable(metersEl, metersEl, 'meters');
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

    resetSine() {
        const gui = this.guis.sine;
        if (gui) {
            gui.controllersRecursive().forEach(ctrl => {
                if (ctrl.property === 'frequency') {
                    ctrl.setValue(440);
                } else if (ctrl.property === 'volume') {
                    ctrl.setValue(50);
                }
            });
        }
    }

    setSineActive(active) {
        this.state.sine.active = Boolean(active);
        const gui = this.guis.sine;
        if (gui) {
            const ctrl = gui.controllersRecursive().find(c => c.property === 'active');
            if (ctrl) ctrl.updateDisplay();
        }
    }

    setPlayState(isPlaying) {
        this._isPlaying = Boolean(isPlaying);
        if (this.playBtn) {
            this.playBtn.textContent = this._isPlaying ? '⏸ Pause' : '▶ Play';
        }
        if (this.pbPlayBtn) {
            this.pbPlayBtn.textContent = this._isPlaying ? '⏸' : '▶';
        }
        if (!this._isPlaying) {
            this.resetMeters();
        }
    }

    _formatTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) sec = 0;
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }

    updatePlayback(currentTime, duration, isPlaying, trackName) {
        this._isPlaying = Boolean(isPlaying);
        if (!this._isUserScrubbing && this.pbSlider) {
            this.pbSlider.max = duration > 0 ? duration : 100;
            this.pbSlider.value = currentTime || 0;
            if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = this._formatTime(currentTime);
            if (this.pbTimeTotal) this.pbTimeTotal.textContent = this._formatTime(duration);
        }
        if (trackName && this.pbTrackTitle) {
            this.pbTrackTitle.textContent = trackName;
        }
        if (this.pbPlayBtn) {
            this.pbPlayBtn.textContent = this._isPlaying ? '⏸' : '▶';
        }
        if (this.playBtn) {
            this.playBtn.textContent = this._isPlaying ? '⏸ Pause' : '▶ Play';
        }
    }

    onSeek(cb) { this._onSeek = cb; }
    onSkip(cb) { this._onSkip = cb; }
    onPrev(cb) { this._onPrev = cb; }
    onNext(cb) { this._onNext = cb; }

    setCameraModeLabel(mode, isFlying = false) {
        if (!this.camBtn) return;
        const flySuffix = isFlying ? ' [Vol]' : '';
        if (mode === 'thirdPerson') {
            this.camBtn.textContent = `🎥 Vue: 3ème pers.${flySuffix}`;
            this.camBtn.classList.add('active');
        } else {
            this.camBtn.textContent = `🎥 Vue: 1ère pers.${flySuffix}`;
            this.camBtn.classList.remove('active');
        }
    }

    // Callbacks
    onCameraToggle(cb) { this._onCameraToggle = cb; }
    onEnter(cb) { this._onEnter = cb; }
    onPlayPause(cb) { this._onPlayPause = cb; }
    onChangeMp3(cb) { this._onChangeMp3 = cb; }
    onSpectrumToggle(cb) { this._onSpectrumToggle = cb; }
    onHrtfToggle(cb) { this._onHrtfToggle = cb; }
    onHrtfBrightness(cb) { this._onHrtfBrightness = cb; }
    onConesToggle(cb) { this._onConesToggle = cb; }
    onGrassChange(cb) { this._onGrassChange = cb; }
    onMasterDsp(cb) { this._onMasterDsp = cb; }
    onEnvDsp(cb) { this._onEnvDsp = cb; }
    onUserDsp(cb) { this._onUserDsp = cb; }
    onInputDsp(cb) { this._onInputDsp = cb; }
    onSubDsp(cb) { this._onSubDsp = cb; }
    onMidDsp(cb) { this._onMidDsp = cb; }
    onTopDsp(cb) { this._onTopDsp = cb; }
    onFillDsp(cb) { this._onFillDsp = cb; }
    onSineToggle(cb) { this._onSineToggle = cb; }
    onSineFrequency(cb) { this._onSineFrequency = cb; }
    onSineVolume(cb) { this._onSineVolume = cb; }

    /**
     * Met à jour l'affichage de l'analyse LUFS et du gain appliqué dans l'UI.
     * @param {{ measuredLufs: number|null, measuredRms: number|null, appliedGainDb: number }} data
     */
    updateInputAnalysis(data) {
        if (!data || !this.state.input) return;
        const { measuredLufs, appliedGainDb } = data;
        this.state.input['measured-lufs'] = (measuredLufs !== null && measuredLufs !== undefined) ? `${measuredLufs} LUFS` : '--';
        this.state.input['applied-gain'] = (appliedGainDb !== undefined) ? `${appliedGainDb > 0 ? '+' : ''}${appliedGainDb} dB` : '0.0 dB';
        if (this._inputLufsDisplay) this._inputLufsDisplay.updateDisplay();
        if (this._inputGainDisplay) this._inputGainDisplay.updateDisplay();
    }

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
            const str = `X: ${pos.x.toFixed(1)}  Y: ${pos.y.toFixed(1)}  Z: ${pos.z.toFixed(1)}`;
            if (this._lastPosStr !== str) {
                this._lastPosStr = str;
                this.positionDisplay.textContent = str;
            }
        }
    }

    resetMeters() {
        for (let i = 0; i < this._meters.length; i++) {
            const m = this._meters[i];
            m.fill.style.height = '0%';
            m.peak.style.bottom = '0%';
            m.peakHold = 0;
            m.clip.classList.remove('active');
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
