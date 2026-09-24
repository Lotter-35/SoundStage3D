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
import { makeDraggable, makeResizable } from './draggable.js';

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
        this._onMicToggle = null;
        this._onInvite = null;

        // UI visibility state
        this._dspVisible = false;
        this._sinePanelVisible = false;
        this.sineBtn = document.getElementById('sine-btn');
        this.sinePanelWrap = document.getElementById('sine-panel-wrap');
        this.micBtn = document.getElementById('mic-btn');
        this.inviteBtn = document.getElementById('invite-btn');
        this.mpStatusEl = document.getElementById('mp-status');

        // State models for each bus
        let savedUser = {};
        try {
            const rawUser = localStorage.getItem('soundstage3d:user-settings');
            if (rawUser) savedUser = JSON.parse(rawUser);
        } catch (_) {}

        // Compatibilité avec l'ancienne clé spécifique si présente
        const savedSens = localStorage.getItem('soundstage3d:master-mouse-sensitivity');
        if (savedUser['mouse-sensitivity'] === undefined && savedSens !== null) {
            savedUser['mouse-sensitivity'] = Number(savedSens);
        }

        this.state = {
            master: { ...DSP_DEFAULTS.master },
            env:    { ...DSP_DEFAULTS.env },
            user: {
                ...DSP_DEFAULTS.user,
                ...savedUser,
                'mouse-sensitivity': savedUser['mouse-sensitivity'] !== undefined ? Number(savedUser['mouse-sensitivity']) : (DSP_DEFAULTS.user?.['mouse-sensitivity'] ?? 60),
                'grass-distance': savedUser['grass-distance'] !== undefined ? Number(savedUser['grass-distance']) : (DSP_DEFAULTS.user?.['grass-distance'] ?? 0),
                'local-volume': savedUser['local-volume'] !== undefined ? Number(savedUser['local-volume']) : (DSP_DEFAULTS.user?.['local-volume'] ?? 100),
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

    /**
     * Apply a single DSP parameter received from server to the GUI slider.
     * Calls setValue() which triggers onChange → audio engine updated automatically.
     * Sets _suppressMpSend=true to prevent the onChange from re-sending to server (infinite loop).
     */
    applyDspFromServer(bus, param, value) {
        const gui = this.guis[bus];
        if (!gui) return;
        if (this.state[bus] !== undefined) {
            this.state[bus][param] = value;
        }
        const ctrl = gui.controllersRecursive().find(c => c.property === param);
        if (ctrl) {
            this._suppressMpSend = true;
            ctrl.setValue(value);
            this._suppressMpSend = false;
        }
    }

    /**
     * Apply a full DSP state snapshot from server (called on ROOM_JOINED).
     */
    applyFullDspState(dspState) {
        if (!dspState) return;
        this._suppressMpSend = true;
        for (const [bus, params] of Object.entries(dspState)) {
            for (const [param, value] of Object.entries(params)) {
                const gui = this.guis[bus];
                if (!gui) continue;
                if (this.state[bus] !== undefined) this.state[bus][param] = value;
                const ctrl = gui.controllersRecursive().find(c => c.property === param);
                if (ctrl) ctrl.setValue(value);
            }
        }
        this._suppressMpSend = false;
    }

    /**
     * Switch to guest mode: hide DSP, playback, sine, mic, play, changeMp3.
     * Only Contrôles Utilisateur and Environnement remain accessible.
     */
    setGuestMode() {
        if (this.dspBtn) this.dspBtn.classList.add('hidden');
        if (this.dspPanels) this.dspPanels.classList.add('hidden');
        if (this.sineBtn) this.sineBtn.classList.add('hidden');
        if (this.sinePanelWrap) this.sinePanelWrap.classList.add('hidden');
        const playbackBtn = document.getElementById('playback-btn');
        if (playbackBtn) playbackBtn.classList.add('hidden');
        const playbackBarWrap = document.getElementById('playback-bar-wrap');
        if (playbackBarWrap) playbackBarWrap.classList.add('hidden');
        if (this.micBtn) this.micBtn.classList.add('hidden');
        if (this.playBtn) this.playBtn.classList.add('hidden');
        if (this.changeMp3Btn) this.changeMp3Btn.classList.add('hidden');
        if (this.inviteBtn) this.inviteBtn.classList.add('hidden');
        this._dspVisible = false;
    }

    /** Update multiplayer player count badge */
    updateMpStatus(count) {
        if (!this.mpStatusEl) return;
        this.mpStatusEl.textContent = count <= 1 ? '👤 Solo' : `👥 ${count} joueurs`;
    }

    /** Register callback for Invite button click */
    onInvite(cb) { this._onInvite = cb; }


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
            if (busKey === 'user') {
                localStorage.setItem('soundstage3d:user-settings', JSON.stringify({
                    'local-volume': DSP_DEFAULTS.user['local-volume'] ?? 100,
                    'grass-distance': DSP_DEFAULTS.user['grass-distance'] ?? 0,
                    'mouse-sensitivity': DSP_DEFAULTS.user['mouse-sensitivity'] ?? 60,
                }));
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
            const gui = new GUI({ container: cMaster, title: 'MASTER Output', closeFolders: false, width: 300 });
            this.guis.master = gui;

            // EQ Global (Master EQ 4 bandes)
            const fEq = gui.addFolder('EQ Global');
            const cEqLow = fEq.add(this.state.master, 'eq-low', -12, 12, 0.5).name('Graves (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('eq-low', v));
            this._setupController(cEqLow, 'master-eq-low', DSP_DEFAULTS.master['eq-low'], false);

            const cEqMidLow = fEq.add(this.state.master, 'eq-mid-low', -12, 12, 0.5).name('Bas-Médiums (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('eq-mid-low', v));
            this._setupController(cEqMidLow, 'master-eq-mid-low', DSP_DEFAULTS.master['eq-mid-low'], false);

            const cEqMidHigh = fEq.add(this.state.master, 'eq-mid-high', -12, 12, 0.5).name('Haut-Médiums (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('eq-mid-high', v));
            this._setupController(cEqMidHigh, 'master-eq-mid-high', DSP_DEFAULTS.master['eq-mid-high'], false);

            const cEqHigh = fEq.add(this.state.master, 'eq-high', -12, 12, 0.5).name('Aigus (dB)').onChange(v => this._onMasterDsp && this._onMasterDsp('eq-high', v));
            this._setupController(cEqHigh, 'master-eq-high', DSP_DEFAULTS.master['eq-high'], false);

            // Compresseur ("Glue Compressor") - réduit par défaut
            const fComp = gui.addFolder('Compresseur');
            fComp.close();
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

            // Limiteur de Sortie Final (True Peak / Brickwall) - réduit par défaut
            const fLim = gui.addFolder('Limiteur');
            fLim.close();
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
            const gui = new GUI({ container: cEnv, title: 'Environnement Acoustique', closeFolders: false, width: 300 });
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
            const gui = new GUI({ container: cUser, title: 'Contrôles Utilisateur', closeFolders: false, width: 300 });
            this.guis.user = gui;

            const _saveUser = () => {
                try {
                    localStorage.setItem('soundstage3d:user-settings', JSON.stringify({
                        'local-volume': this.state.user['local-volume'],
                        'grass-distance': this.state.user['grass-distance'],
                        'mouse-sensitivity': this.state.user['mouse-sensitivity'],
                    }));
                } catch (_) {}
            };

            const fAudio = gui.addFolder('Écoute');
            const cVol = fAudio.add(this.state.user, 'local-volume', 0, 1000, 1).name('Volume local').onChange(v => {
                _saveUser();
                if (this._onUserDsp) this._onUserDsp('local-volume', v);
            });
            this._setupController(cVol, 'user-local-volume', DSP_DEFAULTS.user['local-volume'], false);

            const fEnv = gui.addFolder('Environnement');
            const cGrass = fEnv.add(this.state.user, 'grass-distance', 0, 60, 1).name('Afficher herbe (m)').onChange(v => {
                _saveUser();
                if (this._onGrassChange) this._onGrassChange(v);
                if (this._onUserDsp) this._onUserDsp('grass-distance', v);
            });
            this._setupController(cGrass, 'user-grass-distance', 0, false);

            const fControls = gui.addFolder('Caméra');
            const cSens = fControls.add(this.state.user, 'mouse-sensitivity', 0, 200, 1).name('Sensibilité (%)').onChange(v => {
                _saveUser();
                if (this._onUserDsp) this._onUserDsp('mouse-sensitivity', v);
            });
            cSens.max(Infinity); // Permet de saisir au clavier une valeur supérieure à 200
            this._setupController(cSens, 'user-mouse-sensitivity', DSP_DEFAULTS.user['mouse-sensitivity'] ?? 60, false);

            this._addGuiResetButton(gui, 'user');
        }

        // ─── 1.5 INPUT Stage GUI (Above TOP Pipeline) ───
        if (cInput) {
            const gui = new GUI({ container: cInput, title: '🎚️ INPUT Stage', closeFolders: false, width: 300 });
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

            // 4. Compresseur - réduit par défaut
            const fComp = gui.addFolder('Compresseur');
            fComp.close();
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

            // 5. Microphone Direct
            const fMic = gui.addFolder('Micro Direct');
            const cMicVol = fMic.add(this.state.input, 'mic-volume', 0, 200, 1).name('Volume Micro (%)').onChange(v => this._onInputDsp && this._onInputDsp('mic-volume', v));
            this._setupController(cMicVol, 'input-mic-volume', DSP_DEFAULTS.input['mic-volume'] ?? 100, true);

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
            fComp.close();
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
            fComp.close();
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
            fComp.close();
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
            this.dspBtn.addEventListener('click', (e) => {
                if (e.target.closest('#dsp-reset-all-btn')) return;
                this._dspVisible = !this._dspVisible;
                if (this.dspPanels) this.dspPanels.classList.toggle('hidden', !this._dspVisible);
                if (this.envPanelWrap) this.envPanelWrap.classList.toggle('hidden', !this._dspVisible);
                if (this.userPanelWrap) this.userPanelWrap.classList.toggle('hidden', !this._dspVisible);
                this.dspBtn.classList.toggle('active', this._dspVisible);
            });
        }

        const dspResetAllBtn = document.getElementById('dsp-reset-all-btn');
        const dspConfirmDrop = document.getElementById('dsp-confirm-drop');
        const dspConfirmYes = document.getElementById('dsp-confirm-yes');
        const dspConfirmNo = document.getElementById('dsp-confirm-no');

        if (dspResetAllBtn && dspConfirmDrop) {
            dspResetAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                dspConfirmDrop.classList.toggle('hidden');
            });

            if (dspConfirmYes) {
                dspConfirmYes.addEventListener('click', (e) => {
                    e.stopPropagation();
                    dspConfirmDrop.classList.add('hidden');
                    this.resetAllDsp();
                });
            }

            if (dspConfirmNo) {
                dspConfirmNo.addEventListener('click', (e) => {
                    e.stopPropagation();
                    dspConfirmDrop.classList.add('hidden');
                });
            }

            document.addEventListener('click', (e) => {
                if (!dspConfirmDrop.contains(e.target) && e.target !== dspResetAllBtn) {
                    dspConfirmDrop.classList.add('hidden');
                }
            });
        }

        // Toggle Sine Generator panel visibility
        if (this.sineBtn) {
            this.sineBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._sinePanelVisible = !this._sinePanelVisible;
                if (this.sinePanelWrap) this.sinePanelWrap.classList.toggle('hidden', !this._sinePanelVisible);
                this.sineBtn.classList.toggle('active', this._sinePanelVisible);
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
                if (this._isPlaybackLocked) return;
                if (!this._hasTrack && !this.state.sine?.active) return;
                if (this._onPlayPause) this._onPlayPause();
            });
        }

        // Microphone Button
        if (this.micBtn) {
            this.micBtn.addEventListener('click', () => {
                if (this._onMicToggle) this._onMicToggle();
            });
        }

        // Invite Button (multiplayer — master only)
        if (this.inviteBtn) {
            this.inviteBtn.addEventListener('click', () => {
                if (this._onInvite) this._onInvite();
            });
        }

        // Playback Head Controller (Bottom Center)
        this._playbackVisible = false;
        this._isPlaying = false;
        this._isPlaybackLocked = false;
        this._hasTrack = false;
        this._lockedText = '';
        this._isUserScrubbing = false;
        this._onSeek = null;
        this._onSkip = null;
        this._queue = []; // Array<{ id, name, file }>
        this._currentQueueIndex = -1;
        this._onQueueSelect = null;
        this._onQueueReorder = null;
        this._onQueueAdd = null;
        this._onQueueRemove = null;

        this.playbackBtn = document.getElementById('playback-btn');
        this.playbackBarWrap = document.getElementById('playback-bar-wrap');
        this.pbTrackTitle = document.getElementById('pb-track-title');
        if (this.pbTrackTitle) this.pbTrackTitle.textContent = '';
        this.pbCollapseBtn = document.getElementById('pb-collapse-btn');
        this.pbAddBtn = document.getElementById('pb-add-btn');
        this.pbCloseBtn = document.getElementById('pb-close-btn');
        this.pbTimeCurrent = document.getElementById('pb-time-current');
        this.pbTimeTotal = document.getElementById('pb-time-total');
        this.pbSlider = document.getElementById('pb-slider');
        this.pbWaveformWrap = document.getElementById('pb-waveform-wrap');
        this.pbWaveformCanvas = document.getElementById('pb-waveform-canvas');
        this.pbWaveformHoverLine = document.getElementById('pb-waveform-hover-line');
        this.pbWaveformHoverTime = document.getElementById('pb-waveform-hover-time');
        this.pbWaveformPlayhead = document.getElementById('pb-waveform-playhead');
        this._wfCtx = this.pbWaveformCanvas ? this.pbWaveformCanvas.getContext('2d') : null;
        this._peaksCache = new WeakMap();
        this._currentPeaks = null;
        this._currentAudioBuffer = null;
        this._defaultPeaks = this._generateDefaultPeaks(300);
        this._hoverWaveformRatio = -1;
        this._hoverWaveformX = -1;
        this._isDraggingWaveform = false;
        this._currentTime = 0;
        this._duration = 0;

        this.pbPrevBtn = document.getElementById('pb-prev-btn');
        this.pbPlayBtn = document.getElementById('pb-play-btn');
        this.pbNextBtn = document.getElementById('pb-next-btn');
        this.pbShuffleBtn = document.getElementById('pb-shuffle-btn');
        this._isShuffle = false;
        this._onShuffleToggle = null;

        this.pbPlaylistSelect = document.getElementById('pb-playlist-select');
        this.pbPlaylistStatus = document.getElementById('pb-playlist-status');
        this.pbPlRefreshBtn = document.getElementById('pb-pl-refresh-btn');
        this.pbPlNewBtn = document.getElementById('pb-pl-new-btn');
        this.pbPlRenameBtn = document.getElementById('pb-pl-rename-btn');
        this.pbPlDeleteBtn = document.getElementById('pb-pl-delete-btn');
        this._playlists = [];
        this._selectedPlaylistId = '';
        this._contextPlaylistId = null;
        this._playlistSnapshots = new Map();
        this._onPlaylistLoad = null;
        this._onPlaylistSave = null;
        this._onPlaylistRename = null;
        this._onPlaylistDelete = null;
        this._onPlaylistRefresh = null;
        this._autoSaveTimer = null;
        this._isReloading = false;
        this._reloadResetTimer = null;
        this._onPlaylistTrackAdd = null;
        this._onPlaylistTrackPlay = null;
        this._onPlaylistTracksChange = null;
        this._plDraggedIndex = null;
        this._plDraggedTrackId = null;
        this._draggedIndex = null;
        this._draggedTrackId = null;
        this._dragOverTrackId = null;
        this._dragOverIsTop = null;

        this.pbListsSplit = document.getElementById('pb-lists-split');
        this.pbSplitResizer = document.getElementById('pb-split-resizer');
        this.pbPlSection = document.getElementById('pb-pl-section');
        this.pbPlToggleBtn = document.getElementById('pb-pl-toggle-btn');
        this.pbPlChevron = document.getElementById('pb-pl-chevron');
        this.pbPlCount = document.getElementById('pb-pl-count');
        this.pbPlAddFilesBtn = document.getElementById('pb-pl-add-files-btn');
        this.pbPlLoadBtn = document.getElementById('pb-pl-load-btn');
        this.pbPlQueueAllBtn = document.getElementById('pb-pl-queue-all-btn');
        this.pbPlContainer = document.getElementById('pb-pl-container');
        this.pbPlList = document.getElementById('pb-pl-list');
        this._isPlCollapsed = false;
        this._onPlaylistFilesAdd = null;
        this._onPlaylistQueueAll = null;

        this._splitRatio = 0.45;
        this._savedPlaybackHeight = null;
        try {
            const savedSize = JSON.parse(localStorage.getItem('soundstage3d:win-size:playback'));
            if (savedSize && typeof savedSize.height === 'number' && savedSize.height >= 240) {
                this._savedPlaybackHeight = savedSize.height;
            }
        } catch (_) {}
        try {
            const savedRatio = parseFloat(localStorage.getItem('soundstage3d:playback-split-ratio'));
            if (Number.isFinite(savedRatio) && savedRatio >= 0.1 && savedRatio <= 0.9) {
                this._splitRatio = savedRatio;
            }
        } catch (_) {}
        this._setSplitRatio(this._splitRatio);

        if (this.pbPlToggleBtn && this.pbPlContainer) {
            this.pbPlToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._isPlCollapsed = !this._isPlCollapsed;
                if (!this._isPlCollapsed && this.playbackBarWrap?.classList.contains('pb-compact')) {
                    this.playbackBarWrap.classList.remove('pb-compact');
                    if (this.pbCollapseBtn) this.pbCollapseBtn.textContent = '▾';
                }
                this.pbPlContainer.classList.toggle('collapsed', this._isPlCollapsed);
                if (this.pbPlSection) {
                    this.pbPlSection.classList.toggle('collapsed', this._isPlCollapsed);
                }
                if (this.pbPlChevron) {
                    this.pbPlChevron.textContent = this._isPlCollapsed ? '▸' : '▾';
                }
                this._updateListsLayout();
            });
        }

        if (this.pbPlAddFilesBtn) {
            this.pbPlAddFilesBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'file';
                input.multiple = true;
                input.accept = '.mp3,.wav,.ogg,.flac,.m4a,audio/*';
                input.addEventListener('change', (ev) => {
                    const files = Array.from(ev.target.files || []);
                    if (files.length > 0) {
                        this._handlePlaylistFilesSelected(files);
                    }
                });
                input.click();
            });
        }

        if (this.pbPlContainer) {
            this.pbPlContainer.addEventListener('dragover', (e) => {
                if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'copy';
                }
            });
            this.pbPlContainer.addEventListener('drop', (e) => {
                if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    const audioFiles = Array.from(e.dataTransfer.files).filter(f => f.type?.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a)$/i.test(f.name));
                    if (audioFiles.length > 0) {
                        e.preventDefault();
                        e.stopPropagation();
                        this._handlePlaylistFilesSelected(audioFiles);
                    }
                }
            });
        }

        if (this.pbPlLoadBtn) {
            this.pbPlLoadBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._selectedPlaylistId && this._onPlaylistLoad) {
                    this._onPlaylistLoad(this._selectedPlaylistId);
                }
            });
        }

        if (this.pbPlQueueAllBtn) {
            this.pbPlQueueAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._selectedPlaylistId && this._onPlaylistQueueAll) {
                    this._onPlaylistQueueAll(this._selectedPlaylistId);
                }
            });
        }

        if (this.pbPlaylistSelect) {
            this.pbPlaylistSelect.addEventListener('change', (e) => {
                e.stopPropagation();
                const plId = this.pbPlaylistSelect.value;
                this._selectedPlaylistId = plId;
                this._renderPlaylistTracks();
                this._updatePlaylistDirtyState();
            });
        }

        if (this.pbPlRefreshBtn) {
            this.pbPlRefreshBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                this.setPlaylistReloadingState();
                try {
                    if (this._onPlaylistRefresh) {
                        await Promise.all([
                            this._onPlaylistRefresh(),
                            new Promise(resolve => setTimeout(resolve, 350))
                        ]);
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 350));
                    }
                } catch (err) {
                    console.warn('[Playlist] Error refreshing:', err);
                } finally {
                    this.setPlaylistReloadedState();
                }
            });
        }

        if (this.pbPlNewBtn) {
            this.pbPlNewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const name = window.prompt("Nom de la nouvelle playlist :", "Nouvelle Playlist");
                if (name && name.trim()) {
                    const cleanName = name.trim();
                    const newId = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                    const newPl = {
                        id: newId,
                        name: cleanName,
                        tracks: [],
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    };
                    this._playlists.push(newPl);
                    this.updatePlaylists(this._playlists, newId);
                    if (this._onPlaylistSave) {
                        this._onPlaylistSave(cleanName, newId, []);
                    }
                }
            });
        }

        if (this.pbPlRenameBtn) {
            this.pbPlRenameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!this._selectedPlaylistId) {
                    window.alert("Veuillez d'abord sélectionner une playlist à renommer.");
                    return;
                }
                const pl = this._playlists.find(p => p.id === this._selectedPlaylistId);
                const currentName = pl ? pl.name : '';
                const newName = window.prompt("Nouveau nom de la playlist :", currentName);
                if (newName && newName.trim() && this._onPlaylistRename) {
                    this._onPlaylistRename(this._selectedPlaylistId, newName.trim());
                }
            });
        }

        if (this.pbPlDeleteBtn) {
            this.pbPlDeleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!this._selectedPlaylistId) {
                    window.alert("Veuillez d'abord sélectionner une playlist à supprimer.");
                    return;
                }
                const pl = this._playlists.find(p => p.id === this._selectedPlaylistId);
                const name = pl ? pl.name : '';
                if (window.confirm(`Supprimer définitivement la playlist "${name}" du serveur ?`)) {
                    if (this._onPlaylistDelete) {
                        this._onPlaylistDelete(this._selectedPlaylistId);
                        this._selectedPlaylistId = '';
                    }
                }
            });
        }

        this.pbQueueSection = document.getElementById('pb-queue-section');
        this.pbQueueToggleBtn = document.getElementById('pb-queue-toggle-btn');
        this.pbQueueChevron = document.getElementById('pb-queue-chevron');
        this.pbQueueCount = document.getElementById('pb-queue-count');
        this.pbQueueContainer = document.getElementById('pb-queue-container');
        this._isQueueCollapsed = false;

        this.pbQNowSection = document.getElementById('pb-q-now-section');
        this.pbQNowItem = document.getElementById('pb-q-now-item');
        this.pbQManualSection = document.getElementById('pb-q-manual-section');
        this.pbQClearBtn = document.getElementById('pb-q-clear-btn');
        this.pbQManualList = document.getElementById('pb-q-manual-list');
        this.pbQContextSection = document.getElementById('pb-q-context-section');
        this.pbQContextTitle = document.getElementById('pb-q-context-title');
        this.pbQContextList = document.getElementById('pb-q-context-list');

        this._onManualQueueClear = null;
        this._onManualQueueRemove = null;
        this._onManualQueueReorder = null;
        this._onContextQueueSelect = null;
        this._onContextQueueRemove = null;
        this._onContextQueueReorder = null;

        if (this.pbQClearBtn) {
            this.pbQClearBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._onManualQueueClear) this._onManualQueueClear();
            });
        }

        if (this.pbShuffleBtn) {
            this.pbShuffleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._isShuffle = !this._isShuffle;
                this.setShuffleState(this._isShuffle);
                if (this._onShuffleToggle) this._onShuffleToggle(this._isShuffle);
            });
        }

        // Écouteur pour déplacer le splitter de redimensionnement entre Playlist et File d'attente
        if (this.pbSplitResizer && this.pbListsSplit) {
            this.pbSplitResizer.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                if (this._isPlCollapsed || this._isQueueCollapsed) return;

                e.preventDefault();
                e.stopPropagation();

                this.pbSplitResizer.classList.add('is-resizing');
                document.body.style.userSelect = 'none';
                document.body.style.cursor = 'row-resize';

                const splitRect = this.pbListsSplit.getBoundingClientRect();
                const resizerH = this.pbSplitResizer.offsetHeight || 10;
                const availableHeight = splitRect.height - resizerH;

                const onPointerMove = (moveEvt) => {
                    if (availableHeight <= 0) return;
                    const relY = moveEvt.clientY - splitRect.top - (resizerH / 2);
                    const minH = 40;
                    const clampedY = Math.max(minH, Math.min(availableHeight - minH, relY));
                    const newRatio = clampedY / availableHeight;
                    this._setSplitRatio(newRatio);
                };

                const onPointerUp = () => {
                    window.removeEventListener('pointermove', onPointerMove);
                    window.removeEventListener('pointerup', onPointerUp);
                    window.removeEventListener('pointercancel', onPointerUp);
                    this.pbSplitResizer.classList.remove('is-resizing');
                    document.body.style.userSelect = '';
                    document.body.style.cursor = '';

                    try {
                        localStorage.setItem('soundstage3d:playback-split-ratio', this._splitRatio.toFixed(4));
                    } catch (_) {}
                };

                window.addEventListener('pointermove', onPointerMove);
                window.addEventListener('pointerup', onPointerUp);
                window.addEventListener('pointercancel', onPointerUp);
            });
        }

        if (this.pbQueueToggleBtn && this.pbQueueContainer) {
            this.pbQueueToggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._isQueueCollapsed = !this._isQueueCollapsed;
                if (!this._isQueueCollapsed && this.playbackBarWrap?.classList.contains('pb-compact')) {
                    this.playbackBarWrap.classList.remove('pb-compact');
                    if (this.pbCollapseBtn) this.pbCollapseBtn.textContent = '▾';
                }
                this.pbQueueContainer.classList.toggle('collapsed', this._isQueueCollapsed);
                if (this.pbQueueSection) {
                    this.pbQueueSection.classList.toggle('collapsed', this._isQueueCollapsed);
                }
                if (this.pbQueueChevron) {
                    this.pbQueueChevron.textContent = this._isQueueCollapsed ? '▸' : '▾';
                }
                this._updateListsLayout();
            });
        }
        this._updateListsLayout();

        if (this.pbAddBtn) {
            this.pbAddBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const input = document.createElement('input');
                input.type = 'file';
                input.multiple = true;
                input.accept = '.mp3,.wav,.ogg,.flac,.m4a,audio/*';
                input.addEventListener('change', (ev) => {
                    const files = Array.from(ev.target.files || []);
                    if (files.length > 0 && this._onQueueAdd) {
                        this._onQueueAdd(files);
                    }
                });
                input.click();
            });
        }

        if (this.pbCollapseBtn) {
            this.pbCollapseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!this.playbackBarWrap) return;
                const isCompact = this.playbackBarWrap.classList.contains('pb-compact');
                this.setPlaybackCompact(!isCompact, true);
            });
        }

        if (this.playbackBtn) {
            this.playbackBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._playbackVisible = !this._playbackVisible;
                if (this.playbackBarWrap) this.playbackBarWrap.classList.toggle('hidden', !this._playbackVisible);
                this.playbackBtn.classList.toggle('active', this._playbackVisible);

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
                }
            });
        }
        if (this.pbSlider) {
            this.pbSlider.addEventListener('mousedown', () => {
                if (this._isPlaybackLocked) return;
                this._isUserScrubbing = true;
            });
            this.pbSlider.addEventListener('touchstart', () => {
                if (this._isPlaybackLocked) return;
                this._isUserScrubbing = true;
            }, { passive: true });
            this.pbSlider.addEventListener('input', () => {
                if (this._isPlaybackLocked) return;
                const val = Number(this.pbSlider.value);
                if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = this._formatTime(val);
            });
            this.pbSlider.addEventListener('change', () => {
                if (this._isPlaybackLocked) return;
                const val = Number(this.pbSlider.value);
                if (this._onSeek) this._onSeek(val);
                this._isUserScrubbing = false;
            });
            this.pbSlider.addEventListener('mouseup', () => { this._isUserScrubbing = false; });
            this.pbSlider.addEventListener('touchend', () => { this._isUserScrubbing = false; });
        }
        if (this.pbWaveformWrap) {
            const getProgressFromEvent = (e) => {
                const rect = this.pbWaveformWrap.getBoundingClientRect();
                if (rect.width <= 0) return 0;
                const clientX = (e.touches && e.touches.length > 0) ? e.touches[0].clientX : e.clientX;
                return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            };

            const updateHover = (e) => {
                const rect = this.pbWaveformWrap.getBoundingClientRect();
                if (rect.width <= 0) return;
                const clientX = (e.touches && e.touches.length > 0) ? e.touches[0].clientX : e.clientX;
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                this._hoverWaveformRatio = ratio;
                this._hoverWaveformX = ratio * rect.width;

                const pct = `${(ratio * 100).toFixed(2)}%`;
                if (this.pbWaveformHoverLine) {
                    this.pbWaveformHoverLine.classList.remove('hidden');
                    this.pbWaveformHoverLine.style.left = pct;
                }
                if (this.pbWaveformHoverTime) {
                    this.pbWaveformHoverTime.classList.remove('hidden');
                    this.pbWaveformHoverTime.style.left = pct;
                    const hoverTime = ratio * (this._duration || 0);
                    this.pbWaveformHoverTime.textContent = this._formatTime(hoverTime);
                }
            };

            const clearHover = () => {
                this._hoverWaveformRatio = -1;
                this._hoverWaveformX = -1;
                if (this.pbWaveformHoverLine) this.pbWaveformHoverLine.classList.add('hidden');
                if (this.pbWaveformHoverTime) this.pbWaveformHoverTime.classList.add('hidden');
                this._drawWaveform();
            };

            this.pbWaveformWrap.addEventListener('mousemove', (e) => {
                if (this._isDraggingWaveform || !this._hasTrack) return;
                updateHover(e);
                this._drawWaveform();
            });

            this.pbWaveformWrap.addEventListener('mouseleave', () => {
                if (!this._isDraggingWaveform) {
                    clearHover();
                }
            });

            const onStartScrub = (e) => {
                if (this._isPlaybackLocked || !this._hasTrack) return;
                this._isUserScrubbing = true;
                this._isDraggingWaveform = true;
                updateHover(e);
                const progress = getProgressFromEvent(e);
                const seekTime = progress * (this._duration || 0);
                this._currentTime = seekTime;
                if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = this._formatTime(seekTime);
                if (this.pbSlider) this.pbSlider.value = seekTime;
                this._drawWaveform();

                const onMove = (moveEvt) => {
                    updateHover(moveEvt);
                    const p = getProgressFromEvent(moveEvt);
                    const t = p * (this._duration || 0);
                    this._currentTime = t;
                    if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = this._formatTime(t);
                    if (this.pbSlider) this.pbSlider.value = t;
                    this._drawWaveform();
                };

                const onEnd = (endEvt) => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onEnd);
                    window.removeEventListener('touchmove', onMove);
                    window.removeEventListener('touchend', onEnd);
                    window.removeEventListener('touchcancel', onEnd);

                    this._isDraggingWaveform = false;
                    this._isUserScrubbing = false;
                    const finalProgress = endEvt ? getProgressFromEvent(endEvt) : progress;
                    const finalTime = finalProgress * (this._duration || 0);
                    this._currentTime = finalTime;
                    if (this._onSeek) {
                        this._onSeek(finalTime);
                    }
                    clearHover();
                };

                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onEnd);
                window.addEventListener('touchmove', onMove);
                window.addEventListener('touchend', onEnd);
                window.addEventListener('touchcancel', onEnd);
            };

            this.pbWaveformWrap.addEventListener('mousedown', onStartScrub);
            this.pbWaveformWrap.addEventListener('touchstart', onStartScrub, { passive: true });

            if (window.ResizeObserver) {
                const ro = new ResizeObserver(() => {
                    this._drawWaveform();
                });
                ro.observe(this.pbWaveformWrap);
            }
        }
        if (this.pbPrevBtn) {
            this.pbPrevBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._isPlaybackLocked || !this._hasTrack) return;
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
                if (this._isPlaybackLocked || !this._hasTrack) return;
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
                if (this._isPlaybackLocked || !this._hasTrack) return;
                if (this._onPlayPause) this._onPlayPause();
            });
        }

        // Make playback controller and level meters draggable & resizable
        if (this.playbackBarWrap) {
            const pbHandle = this.playbackBarWrap.querySelector('.pb-info') || this.playbackBarWrap;
            makeDraggable(this.playbackBarWrap, pbHandle, 'playback', false);
            makeResizable(this.playbackBarWrap, {
                minWidth: () => this._getPlaybackMinWidth(),
                minHeight: () => this._getPlaybackMinHeight(),
                storageKey: 'playback',
                onResize: (w, h) => {
                    const isCompact = this.playbackBarWrap.classList.contains('pb-compact');
                    if (isCompact) {
                        // En mode compact : si l'utilisateur tire vers le bas et agrandit la fenêtre (h >= 180),
                        // faire réapparaître immédiatement les menus du bas (playlist et file d'attente) !
                        if (h >= 180) {
                            this.playbackBarWrap.classList.remove('pb-compact');
                            if (this.pbCollapseBtn) {
                                this.pbCollapseBtn.textContent = '▾';
                                this.pbCollapseBtn.title = "Réduire la fenêtre (masquer la playlist et la file d'attente)";
                            }
                            const minW = this._getPlaybackMinWidth();
                            if (this.playbackBarWrap.offsetWidth < minW) {
                                this.playbackBarWrap.style.width = `${minW}px`;
                            }
                            try { localStorage.setItem('soundstage3d:playback-compact', 'false'); } catch (_) {}
                        }
                    } else {
                        // En mode ouvert : si l'utilisateur réduit en hauteur en dessous de 200px, basculer en compact
                        if (h > 0 && h < 200) {
                            const curH = this.playbackBarWrap.offsetHeight;
                            if (curH >= 240) this._savedPlaybackHeight = curH;
                            this.playbackBarWrap.classList.add('pb-compact');
                            if (this.pbCollapseBtn) {
                                this.pbCollapseBtn.textContent = '▴';
                                this.pbCollapseBtn.title = "Agrandir la fenêtre (afficher la playlist et la file d'attente)";
                            }
                            try { localStorage.setItem('soundstage3d:playback-compact', 'true'); } catch (_) {}
                        } else if (h >= 240) {
                            this._savedPlaybackHeight = h;
                            try { localStorage.setItem('soundstage3d:playback-compact', 'false'); } catch (_) {}
                        }
                    }
                    this._drawWaveform();
                }
            });
            this.playbackBarWrap.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

            // Initialiser l'état compact selon le localStorage (par défaut: ouvert/agrandi pour voir playlist et file)
            let initialCompact = false;
            try {
                initialCompact = localStorage.getItem('soundstage3d:playback-compact') === 'true';
            } catch (_) {}
            this.setPlaybackCompact(initialCompact, false);
        }
        const metersEl = document.getElementById('meters');
        if (metersEl) {
            makeDraggable(metersEl, metersEl, 'meters');
        }

        // Change MP3 button
        if (this.changeMp3Btn) {
            this.changeMp3Btn.addEventListener('click', () => {
                if (this._isPlaybackLocked) return;
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

        this._hasTrack = false;
        this._updatePlayButtonState();
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

    resetAllDsp() {
        const dspBuses = ['sub', 'mid', 'top', 'fill', 'master', 'env', 'input'];
        for (const bus of dspBuses) {
            this.resetBus(bus);
        }
        this.resetSine();
        if (this._onResetAllDsp) this._onResetAllDsp();
    }

    onResetAllDsp(cb) {
        this._onResetAllDsp = cb;
    }

    setSineActive(active) {
        this.state.sine.active = Boolean(active);
        const gui = this.guis.sine;
        if (gui) {
            const ctrl = gui.controllersRecursive().find(c => c.property === 'active');
            if (ctrl) ctrl.updateDisplay();
        }
        this._updatePlayButtonState();
    }

    _updatePlayButtonState() {
        const canPlay = (this._hasTrack || Boolean(this.state?.sine?.active)) && !this._isPlaybackLocked;
        const canTrackPlay = this._hasTrack && !this._isPlaybackLocked;

        if (this.playBtn) {
            this.playBtn.disabled = !canPlay;
            this.playBtn.style.opacity = !canPlay ? '0.35' : '';
            this.playBtn.style.pointerEvents = !canPlay ? 'none' : '';
            this.playBtn.style.cursor = !canPlay ? 'not-allowed' : 'pointer';

            if (this._isPlaybackLocked) {
                this.playBtn.textContent = this._lockedText || '⏳ Chargement...';
                this.playBtn.title = this._lockedText || 'Chargement en cours...';
            } else if (!this._hasTrack && !this.state?.sine?.active) {
                this.playBtn.textContent = '▶ Play';
                this.playBtn.title = 'Aucune musique chargée';
            } else {
                this.playBtn.textContent = this._isPlaying ? '⏸ Pause' : '▶ Play';
                this.playBtn.title = this._isPlaying ? 'Mettre en pause' : 'Lancer la lecture';
            }
        }

        if (this.pbPlayBtn) {
            this.pbPlayBtn.disabled = !canTrackPlay;
            this.pbPlayBtn.style.opacity = !canTrackPlay ? '0.35' : '';
            this.pbPlayBtn.style.pointerEvents = !canTrackPlay ? 'none' : '';
            this.pbPlayBtn.style.cursor = !canTrackPlay ? 'not-allowed' : 'pointer';

            if (this._isPlaybackLocked) {
                this.pbPlayBtn.textContent = '⏳';
                this.pbPlayBtn.title = this._lockedText || 'Chargement en cours...';
            } else if (!this._hasTrack) {
                this.pbPlayBtn.textContent = '▶';
                this.pbPlayBtn.title = 'Aucune musique chargée';
            } else {
                this.pbPlayBtn.textContent = this._isPlaying ? '⏸' : '▶';
                this.pbPlayBtn.title = this._isPlaying ? 'Mettre en pause' : 'Lancer la lecture';
            }
        }

        if (this.pbSlider) {
            this.pbSlider.disabled = !canTrackPlay;
            this.pbSlider.style.opacity = !canTrackPlay ? '0.35' : '';
            this.pbSlider.style.pointerEvents = !canTrackPlay ? 'none' : '';
            this.pbSlider.style.cursor = !canTrackPlay ? 'not-allowed' : 'pointer';
            if (!this._hasTrack) {
                this.pbSlider.value = 0;
            }
        }

        if (this.pbWaveformWrap) {
            this.pbWaveformWrap.classList.toggle('disabled', !canTrackPlay);
            this.pbWaveformWrap.title = canTrackPlay ? "Cliquer ou glisser pour naviguer" : "Aucune musique chargée";
        }
        if (!this._hasTrack) {
            this._currentTime = 0;
            this._duration = 0;
            this._currentPeaks = null;
            this._drawWaveform();
        }

        if (this.pbPrevBtn) {
            this.pbPrevBtn.disabled = !canTrackPlay;
            this.pbPrevBtn.style.opacity = !canTrackPlay ? '0.35' : '';
            this.pbPrevBtn.style.pointerEvents = !canTrackPlay ? 'none' : '';
            this.pbPrevBtn.style.cursor = !canTrackPlay ? 'not-allowed' : 'pointer';
        }

        if (this.pbNextBtn) {
            this.pbNextBtn.disabled = !canTrackPlay;
            this.pbNextBtn.style.opacity = !canTrackPlay ? '0.35' : '';
            this.pbNextBtn.style.pointerEvents = !canTrackPlay ? 'none' : '';
            this.pbNextBtn.style.cursor = !canTrackPlay ? 'not-allowed' : 'pointer';
        }
    }

    setHasTrack(hasTrack) {
        this._hasTrack = Boolean(hasTrack);
        if (!this._hasTrack) {
            this._currentTime = 0;
            this._duration = 0;
            this._currentPeaks = null;
            this._currentAudioBuffer = null;
            this._drawWaveform();
            if (this.pbTrackTitle && !this._isPlaybackLocked) {
                this.pbTrackTitle.textContent = '';
            }
            if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = '00:00';
            if (this.pbTimeTotal) this.pbTimeTotal.textContent = '00:00';
            if (this.pbSlider) this.pbSlider.value = 0;
        }
        this._updatePlayButtonState();
    }

    setPlaybackLocked(locked, text = '') {
        this._isPlaybackLocked = Boolean(locked);
        this._lockedText = text;

        if (this.changeMp3Btn) {
            this.changeMp3Btn.disabled = this._isPlaybackLocked;
            this.changeMp3Btn.style.opacity = this._isPlaybackLocked ? '0.5' : '';
            this.changeMp3Btn.style.pointerEvents = this._isPlaybackLocked ? 'none' : '';
            this.changeMp3Btn.style.cursor = this._isPlaybackLocked ? 'not-allowed' : 'pointer';
        }

        if (this.sineBtn) {
            this.sineBtn.disabled = this._isPlaybackLocked;
            this.sineBtn.style.opacity = this._isPlaybackLocked ? '0.5' : '';
            this.sineBtn.style.pointerEvents = this._isPlaybackLocked ? 'none' : '';
        }

        if (this.pbTrackTitle) {
            if (this._isPlaybackLocked && text) {
                this.pbTrackTitle.textContent = text;
            } else if (!this._isPlaying) {
                this.pbTrackTitle.textContent = '';
            }
        }

        this._updatePlayButtonState();
    }

    setPlayState(isPlaying) {
        this._isPlaying = Boolean(isPlaying);
        this._updatePlayButtonState();
        if (!this._isPlaying) {
            this.resetMeters();
            if (this.pbTrackTitle && !this._isPlaybackLocked) {
                this.pbTrackTitle.textContent = '';
            }
        }
        this._renderPlaylistTracks();
    }

    _formatTime(sec) {
        if (!Number.isFinite(sec) || sec < 0) sec = 0;
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }

    updatePlayback(currentTime, duration, isPlaying, trackName, hasTrackExplicit) {
        this._isPlaying = Boolean(isPlaying);
        const hasTrack = hasTrackExplicit !== undefined
            ? Boolean(hasTrackExplicit)
            : Boolean((duration > 0 || (trackName && trackName !== 'Aucun fichier chargé')) && this._currentTrack);
        if (hasTrack !== this._hasTrack) {
            this._hasTrack = hasTrack;
            this._updatePlayButtonState();
        }
        this._duration = hasTrack ? (duration || 0) : 0;
        if (!this._isUserScrubbing) {
            this._currentTime = hasTrack ? (currentTime || 0) : 0;
            if (this.pbSlider) {
                this.pbSlider.max = this._duration > 0 ? this._duration : 100;
                this.pbSlider.value = this._currentTime;
            }
            if (this.pbTimeCurrent) this.pbTimeCurrent.textContent = this._formatTime(this._currentTime);
            if (this.pbTimeTotal) this.pbTimeTotal.textContent = this._formatTime(this._duration);
            this._drawWaveform();
        }
        if (this.pbTrackTitle && !this._isPlaybackLocked) {
            const expectedText = (this._isPlaying && this._hasTrack && trackName && trackName !== 'Aucun fichier chargé') ? trackName : '';
            if (this.pbTrackTitle.textContent !== expectedText) {
                this.pbTrackTitle.textContent = expectedText;
            }
        }
        if (this._hasTrack && !this._isPlaybackLocked) {
            const playText = this._isPlaying ? '⏸ Pause' : '▶ Play';
            if (this.playBtn && this.playBtn.textContent !== playText) {
                this.playBtn.textContent = playText;
            }
            const pbPlayText = this._isPlaying ? '⏸' : '▶';
            if (this.pbPlayBtn && this.pbPlayBtn.textContent !== pbPlayText) {
                this.pbPlayBtn.textContent = pbPlayText;
            }
        }
    }

    setAudioBuffer(audioBuffer) {
        if (!audioBuffer) {
            this._currentAudioBuffer = null;
            this._currentPeaks = null;
            this._drawWaveform();
            return;
        }
        this._currentAudioBuffer = audioBuffer;
        if (this._peaksCache.has(audioBuffer)) {
            this._currentPeaks = this._peaksCache.get(audioBuffer);
        } else {
            const peaks = this._extractPeaks(audioBuffer);
            this._peaksCache.set(audioBuffer, peaks);
            this._currentPeaks = peaks;
        }
        this._drawWaveform();
    }

    _generateDefaultPeaks(num = 300) {
        const peaks = new Float32Array(num);
        for (let i = 0; i < num; i++) {
            const env = Math.sin((i / num) * Math.PI);
            const wave = Math.sin(i * 0.18) * 0.25 + Math.cos(i * 0.07) * 0.25 + 0.5;
            peaks[i] = Math.max(0.08, Math.min(0.85, env * wave * 0.8 + 0.1));
        }
        return peaks;
    }

    _extractPeaks(buffer, numSamples = 400) {
        if (!buffer || !buffer.length) return this._defaultPeaks;
        const totalSamples = buffer.length;
        const numChannels = buffer.numberOfChannels;
        const ch0 = buffer.getChannelData(0);
        const ch1 = numChannels > 1 ? buffer.getChannelData(1) : null;

        const samplesPerBar = Math.floor(totalSamples / numSamples);
        const peaks = new Float32Array(numSamples);
        let max = 0.001;
        const step = Math.max(1, Math.floor(samplesPerBar / 35));

        for (let i = 0; i < numSamples; i++) {
            const start = i * samplesPerBar;
            const end = Math.min(start + samplesPerBar, totalSamples);
            let peak = 0;
            for (let j = start; j < end; j += step) {
                const val0 = Math.abs(ch0[j]);
                if (val0 > peak) peak = val0;
                if (ch1) {
                    const val1 = Math.abs(ch1[j]);
                    if (val1 > peak) peak = val1;
                }
            }
            peaks[i] = peak;
            if (peak > max) max = peak;
        }

        for (let i = 0; i < numSamples; i++) {
            peaks[i] = Math.max(0.06, Math.min(1.0, peaks[i] / max));
        }
        return peaks;
    }

    _drawWaveform() {
        if (!this.pbWaveformCanvas || !this._wfCtx || !this.pbWaveformWrap) return;
        const rect = this.pbWaveformWrap.getBoundingClientRect();
        const W = rect.width;
        const H = rect.height;
        if (W <= 0 || H <= 0) return;

        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(W * dpr);
        const targetH = Math.round(H * dpr);
        if (this.pbWaveformCanvas.width !== targetW || this.pbWaveformCanvas.height !== targetH) {
            this.pbWaveformCanvas.width = targetW;
            this.pbWaveformCanvas.height = targetH;
        }

        const ctx = this._wfCtx;
        ctx.resetTransform ? ctx.resetTransform() : ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, W, H);

        if (!this._hasTrack) {
            if (this.pbWaveformPlayhead) this.pbWaveformPlayhead.style.display = 'none';
            if (this.pbWaveformHoverLine) this.pbWaveformHoverLine.classList.add('hidden');
            if (this.pbWaveformHoverTime) this.pbWaveformHoverTime.classList.add('hidden');
            return;
        }

        const peaks = this._currentPeaks || this._defaultPeaks;
        const barWidth = 2;
        const gap = 1.5;
        const pitch = barWidth + gap;
        const numBars = Math.floor((W + gap) / pitch);
        if (numBars <= 0) return;

        const baselineY = Math.floor(H * 0.70);
        const progress = (this._hasTrack && this._duration > 0)
            ? Math.max(0, Math.min(1, this._currentTime / this._duration))
            : 0;
        const playedX = progress * W;
        const hoverRatio = this._hoverWaveformRatio;

        if (this.pbWaveformPlayhead) {
            if (this._hasTrack && this._duration > 0) {
                this.pbWaveformPlayhead.style.display = 'block';
                this.pbWaveformPlayhead.style.left = `${(progress * 100).toFixed(2)}%`;
            } else {
                this.pbWaveformPlayhead.style.display = 'none';
            }
        }

        // Si la barre de hover est active, synchroniser ses styles en % lors du redimensionnement
        if (hoverRatio >= 0) {
            const pct = `${(hoverRatio * 100).toFixed(2)}%`;
            if (this.pbWaveformHoverLine && !this.pbWaveformHoverLine.classList.contains('hidden')) {
                this.pbWaveformHoverLine.style.left = pct;
            }
            if (this.pbWaveformHoverTime && !this.pbWaveformHoverTime.classList.contains('hidden')) {
                this.pbWaveformHoverTime.style.left = pct;
                const hoverTime = hoverRatio * (this._duration || 0);
                this.pbWaveformHoverTime.textContent = this._formatTime(hoverTime);
            }
        }

        const hasRound = typeof ctx.roundRect === 'function';

        for (let b = 0; b < numBars; b++) {
            const x = b * pitch;
            const pIdx = Math.floor((b / numBars) * peaks.length);
            const peak = peaks[pIdx] || 0.08;
            const barProgress = (x + barWidth / 2) / W;
            const isPlayed = this._hasTrack && (barProgress <= progress);
            const isHoverPreview = hoverRatio >= 0 && !isPlayed && (barProgress <= hoverRatio);

            // Upper bar (going UP from baseline)
            const maxUpperH = baselineY - 2;
            const upperH = Math.max(2, peak * maxUpperH);
            const upperY = baselineY - upperH;

            // Lower reflection (going DOWN from baseline)
            const maxLowerH = (H - baselineY - 2) * 0.75;
            const lowerH = Math.max(1, peak * maxLowerH);
            const lowerY = baselineY + 1.5;

            // Colors (SoundCloud palette: orange for played, translucent warm amber for hover preview, subtle zinc for unplayed)
            let upperFill = 'rgba(255, 255, 255, 0.30)';
            let lowerFill = 'rgba(255, 255, 255, 0.14)';

            if (isPlayed) {
                upperFill = '#ff5500';
                lowerFill = '#cc4400';
            } else if (isHoverPreview) {
                upperFill = 'rgba(255, 125, 45, 0.75)';
                lowerFill = 'rgba(204, 68, 0, 0.45)';
            }

            ctx.fillStyle = upperFill;
            if (hasRound) {
                ctx.beginPath();
                ctx.roundRect(x, upperY, barWidth, upperH, [1, 1, 0, 0]);
                ctx.fill();
            } else {
                ctx.fillRect(x, upperY, barWidth, upperH);
            }

            ctx.fillStyle = lowerFill;
            if (hasRound) {
                ctx.beginPath();
                ctx.roundRect(x, lowerY, barWidth, lowerH, [0, 0, 1, 1]);
                ctx.fill();
            } else {
                ctx.fillRect(x, lowerY, barWidth, lowerH);
            }
        }
    }

    _setSplitRatio(ratio) {
        const clamped = Math.max(0.12, Math.min(0.88, ratio));
        this._splitRatio = clamped;
        if (this.pbListsSplit) {
            this.pbListsSplit.style.setProperty('--pl-flex', clamped.toFixed(4));
            this.pbListsSplit.style.setProperty('--q-flex', (1 - clamped).toFixed(4));
        }
    }

    _updateListsLayout() {
        const plOpen = !this._isPlCollapsed;
        const qOpen = !this._isQueueCollapsed;

        // Le splitter n'est visible que si les DEUX listes sont ouvertes
        if (this.pbSplitResizer) {
            this.pbSplitResizer.style.display = (plOpen && qOpen) ? 'flex' : 'none';
        }
        if (this.pbListsSplit) {
            this.pbListsSplit.classList.toggle('no-split', !(plOpen && qOpen));
        }

        if (!this.playbackBarWrap) return;

        if (!plOpen && !qOpen) {
            // Les deux sont fermées : format compact (barre de lecture seule avec boutons)
            this.setPlaybackCompact(true, true);
        } else {
            // Au moins une liste est ouverte : si non explicitement sauvegardé compact, restaurer
            let savedCompact = false;
            try {
                savedCompact = localStorage.getItem('soundstage3d:playback-compact') === 'true';
            } catch (_) {}
            if (!savedCompact && this.playbackBarWrap.classList.contains('pb-compact')) {
                this.setPlaybackCompact(false, true);
            }
        }
    }

    setPlaybackCompact(isCompact, saveToStorage = true) {
        if (!this.playbackBarWrap) return;
        if (isCompact) {
            const curH = this.playbackBarWrap.offsetHeight;
            if (curH >= 240) {
                this._savedPlaybackHeight = curH;
            }
            this.playbackBarWrap.classList.add('pb-compact');
            this.playbackBarWrap.style.height = 'auto';
            if (this.pbCollapseBtn) {
                this.pbCollapseBtn.textContent = '▴';
                this.pbCollapseBtn.title = "Agrandir la fenêtre (afficher la playlist et la file d'attente)";
            }
        } else {
            this.playbackBarWrap.classList.remove('pb-compact');
            const restoreH = Math.max(320, this._savedPlaybackHeight || 480);
            this.playbackBarWrap.style.height = `${restoreH}px`;
            const minW = this._getPlaybackMinWidth();
            if (this.playbackBarWrap.offsetWidth < minW) {
                this.playbackBarWrap.style.width = `${minW}px`;
            }
            if (this.pbCollapseBtn) {
                this.pbCollapseBtn.textContent = '▾';
                this.pbCollapseBtn.title = "Réduire la fenêtre (masquer la playlist et la file d'attente)";
            }
        }
        this._drawWaveform();
        if (saveToStorage) {
            try {
                localStorage.setItem('soundstage3d:playback-compact', isCompact ? 'true' : 'false');
                const finalRect = this.playbackBarWrap.getBoundingClientRect();
                const saveH = isCompact ? 145 : Math.max(320, this._savedPlaybackHeight || finalRect.height || 480);
                localStorage.setItem('soundstage3d:win-size:playback', JSON.stringify({
                    width: Math.max(this._getPlaybackMinWidth(), finalRect.width || 680),
                    height: saveH
                }));
            } catch (_) {}
        }
    }

    _getPlaybackMinHeight() {
        return 145; // Permet de réduire la fenêtre pour masquer complètement la playlist et la file d'attente
    }

    _getPlaybackMinWidth() {
        const isCompact = this.playbackBarWrap && this.playbackBarWrap.classList.contains('pb-compact');
        if (isCompact) {
            return 320; // Format compact : 320px suffit pour la barre de scrub et les contrôles
        }
        const plOpen = !this._isPlCollapsed;
        const qOpen = !this._isQueueCollapsed;
        if (plOpen && qOpen) {
            return 500; // Playlist et file d'attente côte à côte : largeur suffisante pour tous les boutons d'action
        }
        if (plOpen || qOpen) {
            return 380; // Une seule liste ouverte : sélecteur et boutons d'action affichés sans troncature
        }
        return 320; // Format compact
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
    onMicToggle(cb) { this._onMicToggle = cb; }
    onQueueSelect(cb) { this._onQueueSelect = cb; }
    onQueueReorder(cb) { this._onQueueReorder = cb; }
    onQueueAdd(cb) { this._onQueueAdd = cb; }
    onQueueRemove(cb) { this._onQueueRemove = cb; }

    onShuffleToggle(cb) { this._onShuffleToggle = cb; }
    setShuffleState(isShuffle) {
        this._isShuffle = !!isShuffle;
        if (this.pbShuffleBtn) {
            this.pbShuffleBtn.classList.toggle('active', this._isShuffle);
            this.pbShuffleBtn.title = this._isShuffle ? 'Lecture aléatoire activée' : 'Lecture aléatoire désactivée';
        }
    }

    onPlaylistLoad(cb) { this._onPlaylistLoad = cb; }
    onPlaylistSave(cb) { this._onPlaylistSave = cb; }
    onPlaylistRename(cb) { this._onPlaylistRename = cb; }
    onPlaylistDelete(cb) { this._onPlaylistDelete = cb; }
    onPlaylistRefresh(cb) { this._onPlaylistRefresh = cb; }
    onPlaylistTrackAdd(cb) { this._onPlaylistTrackAdd = cb; }
    onPlaylistTrackPlay(cb) { this._onPlaylistTrackPlay = cb; }
    onPlaylistTracksChange(cb) { this._onPlaylistTracksChange = cb; }
    onPlaylistFilesAdd(cb) { this._onPlaylistFilesAdd = cb; }
    onPlaylistQueueAll(cb) { this._onPlaylistQueueAll = cb; }

    _handlePlaylistFilesSelected(files) {
        if (!files || files.length === 0) return;
        if (!this._selectedPlaylistId) {
            let plName = window.prompt("Nom de la nouvelle playlist pour ces morceaux :", "Ma Playlist");
            if (!plName || !plName.trim()) plName = "Ma Playlist";
            const newId = `pl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const newPl = {
                id: newId,
                name: plName.trim(),
                tracks: [],
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            this._playlists.push(newPl);
            this.updatePlaylists(this._playlists, newId);
        }

        if (this._isPlCollapsed) {
            this._isPlCollapsed = false;
            if (this.pbPlContainer) this.pbPlContainer.classList.remove('collapsed');
            if (this.pbPlSection) this.pbPlSection.classList.remove('collapsed');
            if (this.pbPlChevron) this.pbPlChevron.textContent = '▾';
            this._updateListsLayout();
        }

        if (this._onPlaylistFilesAdd) {
            this._onPlaylistFilesAdd(this._selectedPlaylistId, files);
        }
    }

    notifyPlaylistTracksUpdated(playlistId) {
        if (!playlistId) return;
        const pl = this._playlists.find(p => p.id === playlistId);
        if (!pl) return;

        // Mettre à jour l'option dans le menu déroulant
        if (this.pbPlaylistSelect) {
            const opt = this.pbPlaylistSelect.querySelector(`option[value="${playlistId}"]`);
            if (opt) {
                opt.textContent = `${pl.name} (${(pl.tracks ? pl.tracks.length : pl.trackCount) || 0} morceaux)`;
            }
        }

        // Si cette playlist est actuellement sélectionnée, mettre à jour la liste et le statut
        if (this._selectedPlaylistId === playlistId) {
            this._renderPlaylistTracks();
            this._updatePlaylistDirtyState();
        }

        if (this._onPlaylistTracksChange) {
            this._onPlaylistTracksChange(playlistId, pl.tracks);
        }
    }

    onManualQueueClear(cb) { this._onManualQueueClear = cb; }
    onManualQueueRemove(cb) { this._onManualQueueRemove = cb; }
    onManualQueueReorder(cb) { this._onManualQueueReorder = cb; }
    onContextQueueSelect(cb) { this._onContextQueueSelect = cb; }
    onContextQueueRemove(cb) { this._onContextQueueRemove = cb; }
    onContextQueueReorder(cb) { this._onContextQueueReorder = cb; }

    getPlaylist(playlistId) {
        return this._playlists.find(p => p.id === playlistId) || null;
    }

    updatePlaylists(playlists, activeId = null) {
        this._playlists = Array.isArray(playlists) ? playlists : [];
        for (const pl of this._playlists) {
            if (Array.isArray(pl.tracks)) {
                this._playlistSnapshots.set(pl.id, JSON.stringify(pl.tracks));
            }
        }

        if (activeId !== null && activeId !== undefined) {
            this._selectedPlaylistId = activeId;
        } else if (this._selectedPlaylistId && !this._playlists.some(p => p.id === this._selectedPlaylistId)) {
            this._selectedPlaylistId = '';
        }

        if (!this.pbPlaylistSelect) return;
        this.pbPlaylistSelect.innerHTML = '';

        const defOpt = document.createElement('option');
        defOpt.value = '';
        defOpt.textContent = this._playlists.length === 0 ? '-- Aucune playlist serveur --' : '-- Choisir une playlist --';
        this.pbPlaylistSelect.appendChild(defOpt);

        for (const pl of this._playlists) {
            const opt = document.createElement('option');
            opt.value = pl.id;
            opt.textContent = `${pl.name} (${(pl.tracks ? pl.tracks.length : pl.trackCount) || 0} morceaux)`;
            if (pl.id === this._selectedPlaylistId) {
                opt.selected = true;
            }
            this.pbPlaylistSelect.appendChild(opt);
        }
        this._renderPlaylistTracks();
        this.setPlaylistSavedState(this._selectedPlaylistId);
    }

    markPlaylistSaved(playlistId) {
        this.setPlaylistSavedState(playlistId);
    }

    _renderPlaylistTracks() {
        if (!this.pbPlList) return;
        this.pbPlList.innerHTML = '';

        const pl = this._selectedPlaylistId ? this._playlists.find(p => p.id === this._selectedPlaylistId) : null;
        const tracks = pl && Array.isArray(pl.tracks) ? pl.tracks : [];

        if (this.pbPlCount) {
            this.pbPlCount.textContent = tracks.length;
        }

        if (this.pbPlLoadBtn) {
            const hasTracks = tracks.length > 0;
            this.pbPlLoadBtn.disabled = !hasTracks;
            this.pbPlLoadBtn.classList.toggle('disabled', !hasTracks);
            this.pbPlLoadBtn.title = hasTracks ? `Lire "${pl ? pl.name : 'la playlist'}"` : 'Playlist vide ou aucune sélection';
        }

        if (this.pbPlQueueAllBtn) {
            const hasTracks = tracks.length > 0;
            this.pbPlQueueAllBtn.disabled = !hasTracks;
            this.pbPlQueueAllBtn.classList.toggle('disabled', !hasTracks);
            this.pbPlQueueAllBtn.title = hasTracks ? `Ajouter les ${tracks.length} morceau(x) de "${pl ? pl.name : 'la playlist'}" à la suite` : 'Playlist vide ou aucune sélection';
        }

        if (!pl) {
            const empty = document.createElement('div');
            empty.className = 'pb-queue-empty';
            empty.textContent = 'Sélectionnez une playlist pour voir ses morceaux';
            this.pbPlList.appendChild(empty);
            return;
        }

        if (tracks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'pb-queue-empty';
            empty.innerHTML = 'Cette playlist est vide.<br><button class="pb-pl-empty-add-btn">➕ Ajouter des musiques</button>';
            const emptyBtn = empty.querySelector('.pb-pl-empty-add-btn');
            if (emptyBtn) {
                emptyBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (this.pbPlAddFilesBtn) this.pbPlAddFilesBtn.click();
                });
            }
            this.pbPlList.appendChild(empty);
            return;
        }

        const isContextPlaylist = Boolean(this._selectedPlaylistId && (this._selectedPlaylistId === this._contextPlaylistId));

        tracks.forEach((track, index) => {
            const el = document.createElement('div');
            el.className = 'pb-queue-item pb-pl-item';
            el.draggable = true;
            el.dataset.index = index;
            el.dataset.trackId = track.id;

            const isCurrentlyPlaying = isContextPlaylist && this._currentTrack &&
                ((track.id && this._currentTrack.id && track.id === this._currentTrack.id) ||
                 (track.name && this._currentTrack.name && track.name === this._currentTrack.name));

            if (isCurrentlyPlaying) {
                el.classList.add('playing');
                el.classList.add('active');
            }

            const handle = document.createElement('span');
            handle.className = 'pb-pl-drag-handle';
            handle.textContent = '⋮⋮';
            handle.title = 'Glisser pour réorganiser dans la playlist';

            const num = document.createElement('span');
            num.className = 'pb-queue-num';
            if (isCurrentlyPlaying) {
                num.classList.add('pb-pl-playing-icon');
                num.textContent = this._isPlaying ? '▶' : '⏸';
                num.title = this._isPlaying ? 'Morceau en cours de lecture' : 'Morceau en pause';
            } else {
                num.textContent = `${index + 1}.`;
            }

            const name = document.createElement('span');
            name.className = 'pb-queue-name';
            name.textContent = track.name || `Piste ${index + 1}`;
            name.title = track.name || '';

            let serverBadge = null;
            if (track.uploading) {
                serverBadge = document.createElement('span');
                serverBadge.className = 'pb-pl-server-badge uploading';
                serverBadge.title = 'Envoi vers le serveur en cours...';
                serverBadge.textContent = '⏳ Envoi...';
            } else if (track.onServer === false) {
                el.classList.add('not-on-server');
                serverBadge = document.createElement('span');
                serverBadge.className = 'pb-pl-server-badge offline';
                serverBadge.title = 'Fichier audio non chargé sur le serveur (non accessible aux autres participants)';
                serverBadge.textContent = '⚠️ Hors serveur';
            }

            let badge = null;
            if (isCurrentlyPlaying) {
                badge = document.createElement('span');
                badge.className = 'pb-pl-playing-badge';
                if (this._isPlaying) {
                    badge.innerHTML = '<span class="pb-eq-bars"><span></span><span></span><span></span></span> En lecture';
                } else {
                    badge.textContent = '⏸ En pause';
                }
            }

            const actions = document.createElement('div');
            actions.className = 'pb-pl-actions';

            const addBtn = document.createElement('button');
            addBtn.className = 'pb-pl-add-track-btn';
            addBtn.innerHTML = `<svg viewBox="0 0 512 512" width="13" height="13" fill="none" stroke="currentColor" stroke-width="40" stroke-linecap="round" stroke-linejoin="round">
                <line x1="48" y1="124" x2="396" y2="124"></line>
                <line x1="48" y1="248" x2="396" y2="248"></line>
                <line x1="48" y1="372" x2="196" y2="372"></line>
                <polygon points="236,372 396,276 396,468"></polygon>
            </svg>`;
            addBtn.title = "Ajouter à la file d'attente (prioritaire)";
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._onPlaylistTrackAdd) {
                    this._onPlaylistTrackAdd(track);
                }
            });

            const removeBtn = document.createElement('button');
            removeBtn.className = 'pb-pl-remove-btn';
            removeBtn.innerHTML = '✕';
            removeBtn.title = 'Supprimer ce morceau de la playlist';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                pl.tracks.splice(index, 1);
                this._renderPlaylistTracks();
                this._triggerAutoSave();
                if (this._onPlaylistTracksChange) {
                    this._onPlaylistTracksChange(this._selectedPlaylistId, pl.tracks);
                }
            });

            actions.appendChild(addBtn);
            actions.appendChild(removeBtn);

            el.appendChild(handle);
            el.appendChild(num);
            el.appendChild(name);
            if (serverBadge) el.appendChild(serverBadge);
            if (badge) el.appendChild(badge);
            el.appendChild(actions);

            // Clic sur la ligne pour lancer le morceau et définir le contexte
            el.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                if (this._onPlaylistTrackPlay) {
                    this._onPlaylistTrackPlay(this._selectedPlaylistId, index, track);
                }
            });

            // Drag & drop dans la playlist
            el.addEventListener('dragstart', (e) => {
                this._plDraggedIndex = index;
                this._plDraggedTrackId = track.id;
                el.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(index));
            });

            el.addEventListener('dragend', () => {
                el.classList.remove('dragging');
                if (this.pbPlList) {
                    this.pbPlList.querySelectorAll('.pb-pl-item').forEach(it => {
                        it.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
                    });
                }
                this._plDraggedIndex = null;
                this._plDraggedTrackId = null;
            });

            el.addEventListener('dragover', (e) => {
                e.preventDefault();
                if (this._plDraggedTrackId === track.id) return;
                e.dataTransfer.dropEffect = 'move';

                const rect = el.getBoundingClientRect();
                const isTop = (e.clientY - rect.top) < (rect.height / 2);
                el.classList.toggle('drag-over-top', isTop);
                el.classList.toggle('drag-over-bottom', !isTop);
            });

            el.addEventListener('dragleave', (e) => {
                if (e.relatedTarget && el.contains(e.relatedTarget)) return;
                el.classList.remove('drag-over-top', 'drag-over-bottom');
            });

            el.addEventListener('drop', (e) => {
                e.preventDefault();
                el.classList.remove('drag-over-top', 'drag-over-bottom');
                if (this._plDraggedIndex === null || this._plDraggedIndex === undefined || this._plDraggedIndex === index) return;

                const rect = el.getBoundingClientRect();
                const isTop = (e.clientY - rect.top) < (rect.height / 2);
                let targetIdx = isTop ? index : index + 1;
                if (this._plDraggedIndex < targetIdx) targetIdx--;

                const [moved] = pl.tracks.splice(this._plDraggedIndex, 1);
                pl.tracks.splice(targetIdx, 0, moved);

                this._renderPlaylistTracks();
                this._triggerAutoSave();
                if (this._onPlaylistTracksChange) {
                    this._onPlaylistTracksChange(this._selectedPlaylistId, pl.tracks);
                }
            });

            this.pbPlList.appendChild(el);
        });
    }

    triggerAutoSave() {
        this._triggerAutoSave();
    }

    _triggerAutoSave() {
        const pl = this._selectedPlaylistId ? this._playlists.find(p => p.id === this._selectedPlaylistId) : null;
        if (!pl || !this._selectedPlaylistId) return;

        // Visual feedback : "Sauvegarde..." en gris
        if (this.pbPlaylistStatus) {
            this.pbPlaylistStatus.classList.remove('hidden', 'saved');
            this.pbPlaylistStatus.classList.add('saving');
            this.pbPlaylistStatus.textContent = 'Sauvegarde...';
        }

        if (this._autoSaveTimer) {
            clearTimeout(this._autoSaveTimer);
        }

        this._autoSaveTimer = setTimeout(() => {
            this._autoSaveTimer = null;
            if (this._onPlaylistSave) {
                const name = pl.name || 'Ma Playlist';
                const tracks = Array.isArray(pl.tracks) ? pl.tracks : [];
                this._onPlaylistSave(name, pl.id, tracks);
            }
            this.setPlaylistSavedState(pl.id);
        }, 300);
    }

    setPlaylistSavedState(playlistId = null) {
        const targetId = playlistId || this._selectedPlaylistId;
        const pl = targetId ? this._playlists.find(p => p.id === targetId) : null;
        if (pl && Array.isArray(pl.tracks)) {
            this._playlistSnapshots.set(pl.id, JSON.stringify(pl.tracks));
        }
        if (this._isReloading) return;
        if (this.pbPlaylistStatus) {
            if (this._selectedPlaylistId) {
                this.pbPlaylistStatus.classList.remove('hidden', 'saving', 'reloading');
                this.pbPlaylistStatus.classList.add('saved');
                this.pbPlaylistStatus.textContent = 'Sauvegardé';
            } else {
                this.pbPlaylistStatus.classList.add('hidden');
                this.pbPlaylistStatus.textContent = '';
            }
        }
    }

    setPlaylistReloadingState() {
        this._isReloading = true;
        if (this._reloadResetTimer) {
            clearTimeout(this._reloadResetTimer);
            this._reloadResetTimer = null;
        }
        if (this.pbPlaylistStatus) {
            this.pbPlaylistStatus.classList.remove('hidden', 'saved', 'reloaded');
            this.pbPlaylistStatus.classList.add('saving', 'reloading');
            this.pbPlaylistStatus.textContent = 'Reload...';
        }
    }

    setPlaylistReloadedState() {
        this._isReloading = false;
        if (this.pbPlaylistStatus) {
            if (this._selectedPlaylistId) {
                this.pbPlaylistStatus.classList.remove('hidden', 'saving', 'reloading');
                this.pbPlaylistStatus.classList.add('saved', 'reloaded');
                this.pbPlaylistStatus.textContent = 'Reload';
            } else {
                this.pbPlaylistStatus.classList.add('hidden');
                this.pbPlaylistStatus.textContent = '';
            }
        }
        if (this._reloadResetTimer) {
            clearTimeout(this._reloadResetTimer);
        }
        this._reloadResetTimer = setTimeout(() => {
            this._reloadResetTimer = null;
            if (this.pbPlaylistStatus && this.pbPlaylistStatus.textContent === 'Reload' && this._selectedPlaylistId) {
                this.pbPlaylistStatus.textContent = 'Sauvegardé';
            }
        }, 2500);
    }

    _updatePlaylistDirtyState() {
        const pl = this._selectedPlaylistId ? this._playlists.find(p => p.id === this._selectedPlaylistId) : null;
        if (!pl || !this._selectedPlaylistId) {
            if (this.pbPlaylistStatus) {
                this.pbPlaylistStatus.classList.add('hidden');
                this.pbPlaylistStatus.textContent = '';
            }
            return;
        }

        const originalJson = this._playlistSnapshots.get(pl.id);
        const currentJson = JSON.stringify(pl.tracks || []);
        const isModified = originalJson !== undefined && originalJson !== currentJson;

        if (isModified) {
            this._triggerAutoSave();
        } else {
            this.setPlaylistSavedState(pl.id);
        }
    }

    updateQueue(options = {}) {
        if (Array.isArray(options)) {
            const queue = options;
            const currentIndex = arguments[1] !== undefined ? arguments[1] : -1;
            const cur = (currentIndex >= 0 && currentIndex < queue.length) ? queue[currentIndex] : null;
            const rest = currentIndex >= 0 ? queue.slice(currentIndex + 1) : [...queue];
            return this.updateQueue({
                currentTrack: cur,
                manualQueue: [],
                contextQueue: rest,
                contextName: '',
                isShuffle: this._isShuffle
            });
        }
        const {
            currentTrack = null,
            manualQueue = [],
            contextQueue = [],
            contextName = '',
            contextPlaylistId = undefined,
            isShuffle = false
        } = options;
        this._currentTrack = currentTrack;
        this._manualQueue = manualQueue || [];
        this._contextQueue = contextQueue || [];
        this._contextName = contextName || '';
        if (contextPlaylistId !== undefined) {
            this._contextPlaylistId = contextPlaylistId;
        }
        this._isShuffle = !!isShuffle;

        if (!this._currentTrack) {
            this.setHasTrack(false);
        }

        const totalCount = (currentTrack ? 1 : 0) + this._manualQueue.length + this._contextQueue.length;
        if (this.pbQueueCount) {
            this.pbQueueCount.textContent = totalCount;
        }
        this._renderSpotifyQueue();
        this._renderPlaylistTracks();
    }

    _renderSpotifyQueue() {
        if (!this.pbQueueContainer) return;

        // 1. Titre en cours de lecture
        if (this._currentTrack && this.pbQNowSection && this.pbQNowItem) {
            this.pbQNowSection.classList.remove('hidden');
            this.pbQNowItem.innerHTML = '';

            const num = document.createElement('span');
            num.className = 'pb-queue-num';
            num.textContent = '▶';

            let spinner = null;
            if (this._currentTrack.loading) {
                spinner = document.createElement('span');
                spinner.className = 'pb-queue-spinner';
                spinner.title = 'Chargement en cours...';
            }

            const name = document.createElement('span');
            name.className = 'pb-queue-name';
            name.textContent = this._currentTrack.name || 'Piste en cours';
            name.title = this._currentTrack.name || '';

            this.pbQNowItem.appendChild(num);
            if (spinner) this.pbQNowItem.appendChild(spinner);
            this.pbQNowItem.appendChild(name);
        } else if (this.pbQNowSection) {
            this.pbQNowSection.classList.add('hidden');
        }

        // 2. À suivre dans la file d'attente (manuelle prioritaire)
        if (this.pbQManualSection && this.pbQManualList) {
            this.pbQManualList.innerHTML = '';
            if (this._manualQueue.length > 0) {
                this.pbQManualSection.classList.remove('hidden');
                this._manualQueue.forEach((item, index) => {
                    const el = this._createQueueItemElement(item, index, 'manual');
                    this.pbQManualList.appendChild(el);
                });
            } else {
                this.pbQManualSection.classList.add('hidden');
            }
        }

        // 3. À suivre (contexte playlist)
        if (this.pbQContextSection && this.pbQContextList) {
            this.pbQContextList.innerHTML = '';
            if (this.pbQContextTitle) {
                const shuffleSuffix = this._isShuffle ? ' 🔀' : '';
                this.pbQContextTitle.textContent = this._contextName ? `À suivre • ${this._contextName}${shuffleSuffix}` : `À suivre${shuffleSuffix}`;
            }

            if (this._contextQueue.length > 0) {
                this.pbQContextSection.classList.remove('hidden');
                this._contextQueue.forEach((item, index) => {
                    const el = this._createQueueItemElement(item, index, 'context');
                    this.pbQContextList.appendChild(el);
                });
            } else {
                if (!this._currentTrack && this._manualQueue.length === 0) {
                    this.pbQContextSection.classList.remove('hidden');
                    const empty = document.createElement('div');
                    empty.className = 'pb-queue-empty';
                    empty.textContent = 'Aucune musique en attente';
                    this.pbQContextList.appendChild(empty);
                } else {
                    this.pbQContextSection.classList.add('hidden');
                }
            }
        }
    }

    _createQueueItemElement(item, index, type) {
        const el = document.createElement('div');
        el.className = `pb-queue-item${item.loading ? ' loading' : ''}`;
        el.draggable = true;
        el.dataset.index = index;
        el.dataset.type = type;
        const trackId = String(item.id || item.name || index);
        el.dataset.trackId = trackId;

        const handle = document.createElement('span');
        handle.className = 'pb-queue-drag-handle';
        handle.textContent = '⋮⋮';

        let spinner = null;
        if (item.loading) {
            spinner = document.createElement('span');
            spinner.className = 'pb-queue-spinner';
            spinner.title = 'Chargement en cours...';
        }

        const name = document.createElement('span');
        name.className = 'pb-queue-name';
        name.textContent = item.name || 'Piste audio';
        name.title = item.name || '';
        if (type === 'context') {
            name.style.cursor = 'pointer';
            name.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this._onContextQueueSelect) this._onContextQueueSelect(index);
            });
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'pb-queue-remove';
        removeBtn.innerHTML = '✕';
        removeBtn.title = 'Supprimer de la file';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (type === 'manual' && this._onManualQueueRemove) {
                this._onManualQueueRemove(index);
            } else if (type === 'context' && this._onContextQueueRemove) {
                this._onContextQueueRemove(index);
            }
        });

        el.appendChild(handle);
        if (spinner) el.appendChild(spinner);
        el.appendChild(name);
        el.appendChild(removeBtn);

        // Drag and drop events
        el.addEventListener('dragstart', (e) => {
            this._draggedIndex = index;
            this._draggedType = type;
            this._draggedTrackId = trackId;
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(index));
        });

        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            const parentList = type === 'manual' ? this.pbQManualList : this.pbQContextList;
            if (parentList) {
                parentList.querySelectorAll('.pb-queue-item').forEach(itemEl => {
                    itemEl.classList.remove('drag-over-top', 'drag-over-bottom', 'dragging');
                });
            }
            this._draggedIndex = null;
            this._draggedType = null;
            this._draggedTrackId = null;
        });

        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (this._draggedType !== type || this._draggedTrackId === trackId) return;
            e.dataTransfer.dropEffect = 'move';

            const rect = el.getBoundingClientRect();
            const isTop = (e.clientY - rect.top) < (rect.height / 2);
            el.classList.toggle('drag-over-top', isTop);
            el.classList.toggle('drag-over-bottom', !isTop);
        });

        el.addEventListener('dragleave', (e) => {
            if (e.relatedTarget && el.contains(e.relatedTarget)) return;
            el.classList.remove('drag-over-top', 'drag-over-bottom');
        });

        el.addEventListener('drop', (e) => {
            e.preventDefault();
            el.classList.remove('drag-over-top', 'drag-over-bottom');
            if (this._draggedType !== type || this._draggedIndex === null || this._draggedIndex === undefined || this._draggedIndex === index) return;

            const rect = el.getBoundingClientRect();
            const isTop = (e.clientY - rect.top) < (rect.height / 2);
            let targetIdx = isTop ? index : index + 1;
            if (this._draggedIndex < targetIdx) targetIdx--;

            if (type === 'manual' && this._onManualQueueReorder) {
                this._onManualQueueReorder(this._draggedIndex, targetIdx);
            } else if (type === 'context' && this._onContextQueueReorder) {
                this._onContextQueueReorder(this._draggedIndex, targetIdx);
            }
        });

        return el;
    }

    setMicActive(active) {
        if (!this.micBtn) return;
        this.micBtn.textContent = active ? '🎤 Micro: ON' : '🎤 Micro: OFF';
        this.micBtn.classList.toggle('active', active);
    }

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
