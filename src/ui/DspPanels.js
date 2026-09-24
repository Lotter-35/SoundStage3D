/**
 * DspPanels — lil-gui control panels for all audio processing stages:
 * - Master Out (EQ Global, Compresseur, Limiteur)
 * - Environnement Acoustique (Atmosphère, Réverbération)
 * - Contrôles Utilisateur (Écoute, Environnement, Caméra)
 * - Input Stage (LUFS, Trim, EQ 3 Bandes, Compresseur, Micro Direct)
 * - Pipelines TOP, MID, FILL, SUB (Crossover, Compresseur, Saturation, Volume Bus, Acoustique)
 * - Générateur Sinus (Actif, Fréquence, Volume, Presets)
 */
import GUI from 'lil-gui';
import { DSP_DEFAULTS } from '../config/dsp-defaults.js';
import { DSP_TOOLTIPS } from '../config/dsp-tooltips.js';
import { makeDraggable } from './draggable.js';

export class DspPanels {
    constructor(state, callbacks = {}) {
        this.state = state;
        this.callbacks = callbacks;
        this.guis = {};

        this.tooltipEl = document.getElementById('dsp-tooltip');
        this._tooltipTimer = null;

        this.dspPanels = document.getElementById('dsp-panels');
        this.envPanelWrap = document.getElementById('env-panel-wrap');
        this.userPanelWrap = document.getElementById('user-panel-wrap');
        this.sinePanelWrap = document.getElementById('sine-panel-wrap');

        this._dspVisible = false;
        this._sinePanelVisible = false;

        this._inputLufsDisplay = null;
        this._inputGainDisplay = null;

        this._initGuis();
    }

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

            if (ctrl.$widget) {
                ctrl.$widget.appendChild(resetBtn);
            } else {
                ctrl.domElement.appendChild(resetBtn);
            }

            if (ctrl.$slider) {
                ctrl.$slider.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                });
            }

            ctrl.domElement.addEventListener('dblclick', (e) => {
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
                try {
                    localStorage.setItem('soundstage3d:user-settings', JSON.stringify({
                        'local-volume': DSP_DEFAULTS.user['local-volume'] ?? 100,
                        'grass-distance': DSP_DEFAULTS.user['grass-distance'] ?? 0,
                        'mouse-sensitivity': DSP_DEFAULTS.user['mouse-sensitivity'] ?? 60,
                    }));
                } catch (_) {}
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

    _addFolderResetButton(folder, defaultsMap, onResetCallback) {
        if (!folder || !folder.$title) return;
        const btn = document.createElement('span');
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.className = 'lil-folder-reset-btn';
        btn.textContent = '↺ Reset';
        btn.title = 'Réinitialiser cette catégorie';

        const triggerReset = (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (defaultsMap) {
                folder.controllersRecursive().forEach(ctrl => {
                    const defVal = defaultsMap[ctrl.property];
                    if (defVal !== undefined) {
                        ctrl.setValue(defVal);
                    }
                });
            }
            if (onResetCallback) onResetCallback();
        };

        btn.addEventListener('click', triggerReset);
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('pointerdown', (e) => e.stopPropagation());
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                triggerReset(e);
            }
        });

        folder.$title.appendChild(btn);
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
        const cMaster  = document.getElementById('dsp-panel-master');
        const cEnv     = document.getElementById('dsp-panel-env');
        const cUser    = document.getElementById('dsp-panel-user');
        const cInput   = document.getElementById('dsp-panel-input');
        const cTop     = document.getElementById('dsp-panel-top');
        const cMid     = document.getElementById('dsp-panel-mid');
        const cFill    = document.getElementById('dsp-panel-fill');
        const cSub     = document.getElementById('dsp-panel-sub');
        const cSine    = document.getElementById('sine-panel');

        const stopProp = (e) => e.stopPropagation();
        [cMaster, cEnv, cUser, cInput, cTop, cMid, cFill, cSub, cSine].forEach(container => {
            if (container) {
                container.addEventListener('click', stopProp);
                container.addEventListener('mousedown', stopProp);
            }
        });

        // ─── 1. MASTER OUT Stage GUI ───
        if (cMaster) {
            const gui = new GUI({ container: cMaster, title: 'MASTER Output', closeFolders: false, width: 300 });
            this.guis.master = gui;

            const fEq = gui.addFolder('EQ Global');
            this._addFolderResetButton(fEq, DSP_DEFAULTS.master);
            const cEqLow = fEq.add(this.state.master, 'eq-low', -12, 12, 0.5).name('Graves (dB)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('eq-low', v));
            this._setupController(cEqLow, 'master-eq-low', DSP_DEFAULTS.master['eq-low'], false);

            const cEqMidLow = fEq.add(this.state.master, 'eq-mid-low', -12, 12, 0.5).name('Bas-Médiums (dB)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('eq-mid-low', v));
            this._setupController(cEqMidLow, 'master-eq-mid-low', DSP_DEFAULTS.master['eq-mid-low'], false);

            const cEqMidHigh = fEq.add(this.state.master, 'eq-mid-high', -12, 12, 0.5).name('Haut-Médiums (dB)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('eq-mid-high', v));
            this._setupController(cEqMidHigh, 'master-eq-mid-high', DSP_DEFAULTS.master['eq-mid-high'], false);

            const cEqHigh = fEq.add(this.state.master, 'eq-high', -12, 12, 0.5).name('Aigus (dB)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('eq-high', v));
            this._setupController(cEqHigh, 'master-eq-high', DSP_DEFAULTS.master['eq-high'], false);

            const fComp = gui.addFolder('Compresseur');
            this._addFolderResetButton(fComp, DSP_DEFAULTS.master);
            fComp.close();
            const cCompOn = fComp.add(this.state.master, 'comp-enabled').name('Actif').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('comp-enabled', v));
            this._setupController(cCompOn, 'master-comp-enabled', DSP_DEFAULTS.master['comp-enabled'], false);

            const cThresh = fComp.add(this.state.master, 'comp-threshold', -40, 0, 0.5).name('Seuil (dB)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('comp-threshold', v));
            this._setupController(cThresh, 'master-comp-threshold', DSP_DEFAULTS.master['comp-threshold'], false);

            const cRatio = fComp.add(this.state.master, 'comp-ratio', 1, 20, 0.1).name('Ratio (:1)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('comp-ratio', v));
            this._setupController(cRatio, 'master-comp-ratio', DSP_DEFAULTS.master['comp-ratio'], false);

            const cAtt = fComp.add(this.state.master, 'comp-attack', 0.1, 100, 0.5).name('Attaque (ms)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('comp-attack', v));
            this._setupController(cAtt, 'master-comp-attack', DSP_DEFAULTS.master['comp-attack'], false);

            const cRel = fComp.add(this.state.master, 'comp-release', 10, 1000, 5).name('Release (ms)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('comp-release', v));
            this._setupController(cRel, 'master-comp-release', DSP_DEFAULTS.master['comp-release'], false);

            const cMakeup = fComp.add(this.state.master, 'comp-makeup', -6, 18, 0.5).name('Make-up (dB)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('comp-makeup', v));
            this._setupController(cMakeup, 'master-comp-makeup', DSP_DEFAULTS.master['comp-makeup'], false);

            const fLim = gui.addFolder('Limiteur');
            this._addFolderResetButton(fLim, DSP_DEFAULTS.master);
            fLim.close();
            const cLimOn = fLim.add(this.state.master, 'limiter-enabled').name('Actif').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('limiter-enabled', v));
            this._setupController(cLimOn, 'master-limiter-enabled', DSP_DEFAULTS.master['limiter-enabled'], false);

            const cCeil = fLim.add(this.state.master, 'limiter-threshold', -12, 0, 0.1).name('Plafond (dBFS)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('limiter-threshold', v));
            this._setupController(cCeil, 'master-limiter-threshold', DSP_DEFAULTS.master['limiter-threshold'], false);

            const cLimAtt = fLim.add(this.state.master, 'limiter-attack', 0.1, 10, 0.1).name('Attaque (ms)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('limiter-attack', v));
            this._setupController(cLimAtt, 'master-limiter-attack', DSP_DEFAULTS.master['limiter-attack'], false);

            const cLimRel = fLim.add(this.state.master, 'limiter-release', 10, 500, 5).name('Release (ms)').onChange(v => this.callbacks.onMasterDsp && this.callbacks.onMasterDsp('limiter-release', v));
            this._setupController(cLimRel, 'master-limiter-release', DSP_DEFAULTS.master['limiter-release'], false);

            this._addGuiResetButton(gui, 'master');
        }

        // ─── 1.2 ENVIRONNEMENT Acoustique GUI ───
        if (cEnv) {
            const gui = new GUI({ container: cEnv, title: 'Environnement Acoustique', closeFolders: false, width: 300 });
            this.guis.env = gui;

            const fAir = gui.addFolder('Atmosphère');
            this._addFolderResetButton(fAir, DSP_DEFAULTS.env);
            const cAir = fAir.add(this.state.env, 'air-abs', 0, 50, 1).name('Abs. air (Hz/m)').onChange(v => this.callbacks.onEnvDsp && this.callbacks.onEnvDsp('air-abs', v));
            this._setupController(cAir, 'env-air-abs', DSP_DEFAULTS.env['air-abs'], false);

            const cTreble = fAir.add(this.state.env, 'treble', 0, 15, 0.5).name('Aigus (dB)').onChange(v => this.callbacks.onEnvDsp && this.callbacks.onEnvDsp('treble', v));
            this._setupController(cTreble, 'env-treble', DSP_DEFAULTS.env['treble'], false);

            const fRev = gui.addFolder('Réverbération Acoustique');
            this._addFolderResetButton(fRev, DSP_DEFAULTS.env);
            const cWet = fRev.add(this.state.env, 'reverb-wet', 0, 100, 1).name('Dry / Wet (%)').onChange(v => this.callbacks.onEnvDsp && this.callbacks.onEnvDsp('reverb-wet', v));
            this._setupController(cWet, 'env-reverb-wet', DSP_DEFAULTS.env['reverb-wet'], false);

            const cDecay = fRev.add(this.state.env, 'reverb-decay', 0.5, 8.0, 0.1).name('Durée RT60 (s)').onChange(v => this.callbacks.onEnvDsp && this.callbacks.onEnvDsp('reverb-decay', v));
            this._setupController(cDecay, 'env-reverb-decay', DSP_DEFAULTS.env['reverb-decay'], false);

            const cDamp = fRev.add(this.state.env, 'reverb-damping', 1000, 18000, 100).name('Amort. HF (Hz)').onChange(v => this.callbacks.onEnvDsp && this.callbacks.onEnvDsp('reverb-damping', v));
            this._setupController(cDamp, 'env-reverb-damping', DSP_DEFAULTS.env['reverb-damping'], false);

            const cPre = fRev.add(this.state.env, 'reverb-predelay', 0, 100, 1).name('Pré-délai (ms)').onChange(v => this.callbacks.onEnvDsp && this.callbacks.onEnvDsp('reverb-predelay', v));
            this._setupController(cPre, 'env-reverb-predelay', DSP_DEFAULTS.env['reverb-predelay'], false);

            this._addGuiResetButton(gui, 'env');
        }

        // ─── 1.3 CONTRÔLES Utilisateur GUI ───
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
            this._addFolderResetButton(fAudio, DSP_DEFAULTS.user, () => _saveUser());
            const cVol = fAudio.add(this.state.user, 'local-volume', 0, 1000, 1).name('Volume local').onChange(v => {
                _saveUser();
                if (this.callbacks.onUserDsp) this.callbacks.onUserDsp('local-volume', v);
            });
            this._setupController(cVol, 'user-local-volume', DSP_DEFAULTS.user['local-volume'], false);

            const fEnv = gui.addFolder('Environnement');
            this._addFolderResetButton(fEnv, DSP_DEFAULTS.user, () => _saveUser());
            const cGrass = fEnv.add(this.state.user, 'grass-distance', 0, 60, 1).name('Afficher herbe (m)').onChange(v => {
                _saveUser();
                if (this.callbacks.onGrassChange) this.callbacks.onGrassChange(v);
                if (this.callbacks.onUserDsp) this.callbacks.onUserDsp('grass-distance', v);
            });
            this._setupController(cGrass, 'user-grass-distance', 0, false);

            const fControls = gui.addFolder('Caméra');
            this._addFolderResetButton(fControls, DSP_DEFAULTS.user, () => _saveUser());
            const cSens = fControls.add(this.state.user, 'mouse-sensitivity', 0, 200, 1).name('Sensibilité (%)').onChange(v => {
                _saveUser();
                if (this.callbacks.onUserDsp) this.callbacks.onUserDsp('mouse-sensitivity', v);
            });
            cSens.max(Infinity);
            this._setupController(cSens, 'user-mouse-sensitivity', DSP_DEFAULTS.user['mouse-sensitivity'] ?? 60, false);

            this._addGuiResetButton(gui, 'user');
        }

        // ─── 1.5 INPUT Stage GUI ───
        if (cInput) {
            const gui = new GUI({ container: cInput, title: '🎚️ INPUT Stage', closeFolders: false, width: 300 });
            this.guis.input = gui;

            const fLufs = gui.addFolder('Normalisation LUFS (Auto-Gain)');
            this._addFolderResetButton(fLufs, DSP_DEFAULTS.input);
            const cAutoGain = fLufs.add(this.state.input, 'auto-gain').name('Actif').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('auto-gain', v));
            this._setupController(cAutoGain, 'input-auto-gain', DSP_DEFAULTS.input['auto-gain'], true);

            const cTargetLufs = fLufs.add(this.state.input, 'target-lufs', [-14, -23, -16, -18, -20]).name('Cible LUFS').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('target-lufs', Number(v)));
            this._setupController(cTargetLufs, 'input-target-lufs', DSP_DEFAULTS.input['target-lufs'], true);

            this._inputLufsDisplay = fLufs.add(this.state.input, 'measured-lufs').name('LUFS mesuré').listen().disable();
            this._inputGainDisplay = fLufs.add(this.state.input, 'applied-gain').name('Gain appliqué').listen().disable();

            const fTrim = gui.addFolder('Pré-Gain Global (Trim)');
            this._addFolderResetButton(fTrim, DSP_DEFAULTS.input);
            const cTrim = fTrim.add(this.state.input, 'input-trim', 0, 200, 1).name('Trim (%)').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('input-trim', v));
            this._setupController(cTrim, 'input-trim', DSP_DEFAULTS.input['input-trim'], true);

            const fEq = gui.addFolder('Égaliseur 3 Bandes');
            this._addFolderResetButton(fEq, DSP_DEFAULTS.input);
            const cEqLow = fEq.add(this.state.input, 'eq-low', -12, 12, 0.5).name('Graves (dB)').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('eq-low', v));
            this._setupController(cEqLow, 'input-eq-low', DSP_DEFAULTS.input['eq-low'], true);

            const cEqMid = fEq.add(this.state.input, 'eq-mid', -12, 12, 0.5).name('Médiums (dB)').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('eq-mid', v));
            this._setupController(cEqMid, 'input-eq-mid', DSP_DEFAULTS.input['eq-mid'], true);

            const cEqHigh = fEq.add(this.state.input, 'eq-high', -12, 12, 0.5).name('Aigus (dB)').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('eq-high', v));
            this._setupController(cEqHigh, 'input-eq-high', DSP_DEFAULTS.input['eq-high'], true);

            const fComp = gui.addFolder('Compresseur');
            this._addFolderResetButton(fComp, DSP_DEFAULTS.input);
            fComp.close();
            const cCompOn = fComp.add(this.state.input, 'comp-enabled').name('Actif').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('comp-enabled', v));
            this._setupController(cCompOn, 'input-comp-enabled', DSP_DEFAULTS.input['comp-enabled'], true);

            const cThresh = fComp.add(this.state.input, 'comp-threshold', -60, 0, 0.5).name('Seuil (dB)').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('comp-threshold', v));
            this._setupController(cThresh, 'input-comp-threshold', DSP_DEFAULTS.input['comp-threshold'], true);

            const cKnee = fComp.add(this.state.input, 'comp-knee', 0, 40, 0.5).name('Knee (dB)').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('comp-knee', v));
            this._setupController(cKnee, 'input-comp-knee', DSP_DEFAULTS.input['comp-knee'], true);

            const cRatio = fComp.add(this.state.input, 'comp-ratio', 1, 20, 0.1).name('Ratio (:1)').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('comp-ratio', v));
            this._setupController(cRatio, 'input-comp-ratio', DSP_DEFAULTS.input['comp-ratio'], true);

            const cAttack = fComp.add(this.state.input, 'comp-attack', 0, 100, 0.5).name('Attaque (ms)').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('comp-attack', v));
            this._setupController(cAttack, 'input-comp-attack', DSP_DEFAULTS.input['comp-attack'], true);

            const cRel = fComp.add(this.state.input, 'comp-release', 10, 1000, 1).name('Release (ms)').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('comp-release', v));
            this._setupController(cRel, 'input-comp-release', DSP_DEFAULTS.input['comp-release'], true);

            const fMic = gui.addFolder('Micro Direct');
            this._addFolderResetButton(fMic, DSP_DEFAULTS.input);
            const cMicVol = fMic.add(this.state.input, 'mic-volume', 0, 200, 1).name('Volume Micro (%)').onChange(v => this.callbacks.onInputDsp && this.callbacks.onInputDsp('mic-volume', v));
            this._setupController(cMicVol, 'input-mic-volume', DSP_DEFAULTS.input['mic-volume'] ?? 100, true);

            this._addGuiResetButton(gui, 'input');
        }

        // ─── 2. TOP GUI ───
        if (cTop) {
            const gui = new GUI({ container: cTop, title: '🔉 TOP Pipeline', closeFolders: false, width: 300 });
            this.guis.top = gui;

            const fXover = gui.addFolder('Crossover LR4');
            this._addFolderResetButton(fXover, DSP_DEFAULTS.top);
            const cXover = fXover.add(this.state.top, 'xover-freq', 800, 6000, 1).name('High Freq (Hz)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('xover-freq', v));
            this._setupController(cXover, 'top-xover-freq', DSP_DEFAULTS.top['xover-freq'], true);

            const fComp = gui.addFolder('Compresseur');
            this._addFolderResetButton(fComp, DSP_DEFAULTS.top);
            fComp.close();
            const cThresh = fComp.add(this.state.top, 'comp-threshold', -60, 0, 0.1).name('Seuil (dB)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('comp-threshold', v));
            this._setupController(cThresh, 'top-comp-threshold', DSP_DEFAULTS.top['comp-threshold'], true);

            const cKnee = fComp.add(this.state.top, 'comp-knee', 0, 40, 0.1).name('Knee (dB)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('comp-knee', v));
            this._setupController(cKnee, 'top-comp-knee', DSP_DEFAULTS.top['comp-knee'], true);

            const cRatio = fComp.add(this.state.top, 'comp-ratio', 1, 20, 0.1).name('Ratio (:1)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('comp-ratio', v));
            this._setupController(cRatio, 'top-comp-ratio', DSP_DEFAULTS.top['comp-ratio'], true);

            const cAttack = fComp.add(this.state.top, 'comp-attack', 0, 100, 0.5).name('Attaque (ms)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('comp-attack', v));
            this._setupController(cAttack, 'top-comp-attack', DSP_DEFAULTS.top['comp-attack'], true);

            const cRel = fComp.add(this.state.top, 'comp-release', 10, 1000, 1).name('Release (ms)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('comp-release', v));
            this._setupController(cRel, 'top-comp-release', DSP_DEFAULTS.top['comp-release'], true);

            const fSat = gui.addFolder('Saturation');
            this._addFolderResetButton(fSat, DSP_DEFAULTS.top);
            const cSatDr = fSat.add(this.state.top, 'sat-drive', 0, 100, 1).name('Drive (%)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('sat-drive', v));
            this._setupController(cSatDr, 'top-sat-drive', DSP_DEFAULTS.top['sat-drive'], true);

            const cSatMx = fSat.add(this.state.top, 'sat-mix', 0, 100, 1).name('Mix (%)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('sat-mix', v));
            this._setupController(cSatMx, 'top-sat-mix', DSP_DEFAULTS.top['sat-mix'], true);

            const fVol = gui.addFolder('Volume Bus');
            this._addFolderResetButton(fVol, DSP_DEFAULTS.top);
            const cVol = fVol.add(this.state.top, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('bus-volume', v));
            this._setupController(cVol, 'top-bus-volume', DSP_DEFAULTS.top['bus-volume'], true);

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            this._addFolderResetButton(fAcoustics, DSP_DEFAULTS.top);
            const cLim = fAcoustics.add(this.state.top, 'lim-threshold', -12, 0, 0.1).name('Limiteur (dB)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('lim-threshold', v));
            this._setupController(cLim, 'top-lim-threshold', DSP_DEFAULTS.top['lim-threshold'], true);

            const cDist = fAcoustics.add(this.state.top, 'dist-k', 0, 200, 1).name('Attén. dist (k)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('dist-k', v));
            this._setupController(cDist, 'top-dist-k', DSP_DEFAULTS.top['dist-k'], true);

            const cReflG = fAcoustics.add(this.state.top, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('refl-gain', v));
            this._setupController(cReflG, 'top-refl-gain', DSP_DEFAULTS.top['refl-gain'], true);

            const cReflF = fAcoustics.add(this.state.top, 'refl-lpf', 200, 8000, 1).name('LPF Réflec. (Hz)').onChange(v => this.callbacks.onTopDsp && this.callbacks.onTopDsp('refl-lpf', v));
            this._setupController(cReflF, 'top-refl-lpf', DSP_DEFAULTS.top['refl-lpf'], true);

            this._addGuiResetButton(gui, 'top');
        }

        // ─── 3. MID GUI ───
        if (cMid) {
            const gui = new GUI({ container: cMid, title: '🔉 MID Pipeline', closeFolders: false, width: 300 });
            this.guis.mid = gui;

            const fXover = gui.addFolder('Crossover LR4');
            this._addFolderResetButton(fXover, DSP_DEFAULTS.mid);
            const cLow = fXover.add(this.state.mid, 'xover-low', 40, 200, 1).name('Low Freq (Hz)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('xover-low', v));
            this._setupController(cLow, 'mid-xover-low', DSP_DEFAULTS.mid['xover-low'], true);

            const cHigh = fXover.add(this.state.mid, 'xover-high', 800, 6000, 1).name('High Freq (Hz)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('xover-high', v));
            this._setupController(cHigh, 'mid-xover-high', DSP_DEFAULTS.mid['xover-high'], true);

            const fComp = gui.addFolder('Compresseur');
            this._addFolderResetButton(fComp, DSP_DEFAULTS.mid);
            fComp.close();
            const cThresh = fComp.add(this.state.mid, 'comp-threshold', -60, 0, 0.1).name('Seuil (dB)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('comp-threshold', v));
            this._setupController(cThresh, 'mid-comp-threshold', DSP_DEFAULTS.mid['comp-threshold'], true);

            const cKnee = fComp.add(this.state.mid, 'comp-knee', 0, 40, 0.1).name('Knee (dB)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('comp-knee', v));
            this._setupController(cKnee, 'mid-comp-knee', DSP_DEFAULTS.mid['comp-knee'], true);

            const cRatio = fComp.add(this.state.mid, 'comp-ratio', 1, 20, 0.1).name('Ratio (:1)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('comp-ratio', v));
            this._setupController(cRatio, 'mid-comp-ratio', DSP_DEFAULTS.mid['comp-ratio'], true);

            const cAttack = fComp.add(this.state.mid, 'comp-attack', 0, 100, 0.5).name('Attaque (ms)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('comp-attack', v));
            this._setupController(cAttack, 'mid-comp-attack', DSP_DEFAULTS.mid['comp-attack'], true);

            const cRel = fComp.add(this.state.mid, 'comp-release', 10, 1000, 1).name('Release (ms)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('comp-release', v));
            this._setupController(cRel, 'mid-comp-release', DSP_DEFAULTS.mid['comp-release'], true);

            const fSat = gui.addFolder('Saturation');
            this._addFolderResetButton(fSat, DSP_DEFAULTS.mid);
            const cSatDr = fSat.add(this.state.mid, 'sat-drive', 0, 100, 1).name('Drive (%)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('sat-drive', v));
            this._setupController(cSatDr, 'mid-sat-drive', DSP_DEFAULTS.mid['sat-drive'], true);

            const cSatMx = fSat.add(this.state.mid, 'sat-mix', 0, 100, 1).name('Mix (%)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('sat-mix', v));
            this._setupController(cSatMx, 'mid-sat-mix', DSP_DEFAULTS.mid['sat-mix'], true);

            const fVol = gui.addFolder('Volume Bus');
            this._addFolderResetButton(fVol, DSP_DEFAULTS.mid);
            const cVol = fVol.add(this.state.mid, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('bus-volume', v));
            this._setupController(cVol, 'mid-bus-volume', DSP_DEFAULTS.mid['bus-volume'], true);

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            this._addFolderResetButton(fAcoustics, DSP_DEFAULTS.mid);
            const cLim = fAcoustics.add(this.state.mid, 'lim-threshold', -12, 0, 0.1).name('Limiteur (dB)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('lim-threshold', v));
            this._setupController(cLim, 'mid-lim-threshold', DSP_DEFAULTS.mid['lim-threshold'], true);

            const cDist = fAcoustics.add(this.state.mid, 'dist-k', 0, 200, 1).name('Attén. dist (k)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('dist-k', v));
            this._setupController(cDist, 'mid-dist-k', DSP_DEFAULTS.mid['dist-k'], true);

            const cReflG = fAcoustics.add(this.state.mid, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('refl-gain', v));
            this._setupController(cReflG, 'mid-refl-gain', DSP_DEFAULTS.mid['refl-gain'], true);

            const cReflF = fAcoustics.add(this.state.mid, 'refl-lpf', 200, 8000, 1).name('LPF Réflec. (Hz)').onChange(v => this.callbacks.onMidDsp && this.callbacks.onMidDsp('refl-lpf', v));
            this._setupController(cReflF, 'mid-refl-lpf', DSP_DEFAULTS.mid['refl-lpf'], true);

            this._addGuiResetButton(gui, 'mid');
        }

        // ─── 4. FILL GUI ───
        if (cFill) {
            const gui = new GUI({ container: cFill, title: '🔉 FILL Pipeline', closeFolders: false, width: 300 });
            this.guis.fill = gui;

            const fMix = gui.addFolder('Mixage Source');
            this._addFolderResetButton(fMix, DSP_DEFAULTS.fill);
            const cMerge = fMix.add(this.state.fill, 'merge-gain', 0, 100, 1).name('Gain Mix (%)').onChange(v => this.callbacks.onFillDsp && this.callbacks.onFillDsp('merge-gain', v));
            this._setupController(cMerge, 'fill-merge-gain', DSP_DEFAULTS.fill['merge-gain'], false);

            const fVol = gui.addFolder('Volume Bus');
            this._addFolderResetButton(fVol, DSP_DEFAULTS.fill);
            const cVol = fVol.add(this.state.fill, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this.callbacks.onFillDsp && this.callbacks.onFillDsp('bus-volume', v));
            this._setupController(cVol, 'fill-bus-volume', DSP_DEFAULTS.fill['bus-volume'], false);

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            this._addFolderResetButton(fAcoustics, DSP_DEFAULTS.fill);
            const cLim = fAcoustics.add(this.state.fill, 'lim-threshold', -12, 0, 0.1).name('Limiteur (dB)').onChange(v => this.callbacks.onFillDsp && this.callbacks.onFillDsp('lim-threshold', v));
            this._setupController(cLim, 'fill-lim-threshold', DSP_DEFAULTS.fill['lim-threshold'], false);

            const cDist = fAcoustics.add(this.state.fill, 'dist-k', 0, 200, 1).name('Attén. dist (k)').onChange(v => this.callbacks.onFillDsp && this.callbacks.onFillDsp('dist-k', v));
            this._setupController(cDist, 'fill-dist-k', DSP_DEFAULTS.fill['dist-k'], false);

            const cReflG = fAcoustics.add(this.state.fill, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this.callbacks.onFillDsp && this.callbacks.onFillDsp('refl-gain', v));
            this._setupController(cReflG, 'fill-refl-gain', DSP_DEFAULTS.fill['refl-gain'], false);

            const cReflF = fAcoustics.add(this.state.fill, 'refl-lpf', 200, 8000, 1).name('LPF Réflec. (Hz)').onChange(v => this.callbacks.onFillDsp && this.callbacks.onFillDsp('refl-lpf', v));
            this._setupController(cReflF, 'fill-refl-lpf', DSP_DEFAULTS.fill['refl-lpf'], false);

            this._addGuiResetButton(gui, 'fill');
        }

        // ─── 5. SUB GUI ───
        if (cSub) {
            const gui = new GUI({ container: cSub, title: '🔉 SUB Pipeline', closeFolders: false, width: 300 });
            this.guis.sub = gui;

            const fXover = gui.addFolder('Crossover LR4');
            this._addFolderResetButton(fXover, DSP_DEFAULTS.sub);
            const cLow = fXover.add(this.state.sub, 'xover-freq', 40, 150, 1).name('Low Freq (Hz)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('xover-freq', v));
            this._setupController(cLow, 'sub-xover-freq', DSP_DEFAULTS.sub['xover-freq'], false);

            const fComp = gui.addFolder('Compresseur');
            this._addFolderResetButton(fComp, DSP_DEFAULTS.sub);
            fComp.close();
            const cThresh = fComp.add(this.state.sub, 'comp-threshold', -60, 0, 0.1).name('Seuil (dB)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('comp-threshold', v));
            this._setupController(cThresh, 'sub-comp-threshold', DSP_DEFAULTS.sub['comp-threshold'], false);

            const cKnee = fComp.add(this.state.sub, 'comp-knee', 0, 40, 0.1).name('Knee (dB)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('comp-knee', v));
            this._setupController(cKnee, 'sub-comp-knee', DSP_DEFAULTS.sub['comp-knee'], false);

            const cRatio = fComp.add(this.state.sub, 'comp-ratio', 1, 20, 0.1).name('Ratio (:1)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('comp-ratio', v));
            this._setupController(cRatio, 'sub-comp-ratio', DSP_DEFAULTS.sub['comp-ratio'], false);

            const cAttack = fComp.add(this.state.sub, 'comp-attack', 0, 100, 0.5).name('Attaque (ms)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('comp-attack', v));
            this._setupController(cAttack, 'sub-comp-attack', DSP_DEFAULTS.sub['comp-attack'], false);

            const cRel = fComp.add(this.state.sub, 'comp-release', 10, 1000, 1).name('Release (ms)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('comp-release', v));
            this._setupController(cRel, 'sub-comp-release', DSP_DEFAULTS.sub['comp-release'], false);

            const fSat = gui.addFolder('Saturation');
            this._addFolderResetButton(fSat, DSP_DEFAULTS.sub);
            const cSatDr = fSat.add(this.state.sub, 'sat-drive', 0, 100, 1).name('Drive (%)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('sat-drive', v));
            this._setupController(cSatDr, 'sub-sat-drive', DSP_DEFAULTS.sub['sat-drive'], false);

            const cSatMx = fSat.add(this.state.sub, 'sat-mix', 0, 100, 1).name('Mix (%)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('sat-mix', v));
            this._setupController(cSatMx, 'sub-sat-mix', DSP_DEFAULTS.sub['sat-mix'], false);

            const fProx = gui.addFolder('Saturation Proximité');
            this._addFolderResetButton(fProx, DSP_DEFAULTS.sub);
            const cProxFar = fProx.add(this.state.sub, 'prox-far', 1, 15, 0.1).name('Dist. Début (m)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('prox-far', v));
            this._setupController(cProxFar, 'sub-prox-far', DSP_DEFAULTS.sub['prox-far'], false);

            const cProxNear = fProx.add(this.state.sub, 'prox-near', 0.5, 5, 0.1).name('Dist. Max (m)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('prox-near', v));
            this._setupController(cProxNear, 'sub-prox-near', DSP_DEFAULTS.sub['prox-near'], false);

            const cProxDr = fProx.add(this.state.sub, 'prox-drive', 0, 100, 1).name('Drive Max (%)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('prox-drive', v));
            this._setupController(cProxDr, 'sub-prox-drive', DSP_DEFAULTS.sub['prox-drive'], false);

            const fVol = gui.addFolder('Volume Bus');
            this._addFolderResetButton(fVol, DSP_DEFAULTS.sub);
            const cVol = fVol.add(this.state.sub, 'bus-volume', 0, 200, 1).name('Volume (%)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('bus-volume', v));
            this._setupController(cVol, 'sub-bus-volume', DSP_DEFAULTS.sub['bus-volume'], false);

            const fAcoustics = gui.addFolder('Acoustique & Limiteur');
            this._addFolderResetButton(fAcoustics, DSP_DEFAULTS.sub);
            const cLim = fAcoustics.add(this.state.sub, 'lim-threshold', -12, 0, 0.1).name('Limiteur (dB)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('lim-threshold', v));
            this._setupController(cLim, 'sub-lim-threshold', DSP_DEFAULTS.sub['lim-threshold'], false);

            const cEnergy = fAcoustics.add(this.state.sub, 'energy-limit', 1, 7, 0.1).name('Limite énergie (subs)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('energy-limit', v));
            this._setupController(cEnergy, 'sub-energy-limit', DSP_DEFAULTS.sub['energy-limit'], false);

            const cDist = fAcoustics.add(this.state.sub, 'dist-k', 0, 200, 1).name('Attén. dist (k)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('dist-k', v));
            this._setupController(cDist, 'sub-dist-k', DSP_DEFAULTS.sub['dist-k'], false);

            const cReflG = fAcoustics.add(this.state.sub, 'refl-gain', 0, 100, 1).name('Réflec. sol (%)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('refl-gain', v));
            this._setupController(cReflG, 'sub-refl-gain', DSP_DEFAULTS.sub['refl-gain'], false);

            const cReflF = fAcoustics.add(this.state.sub, 'refl-lpf', 200, 8000, 1).name('LPF Réflec. (Hz)').onChange(v => this.callbacks.onSubDsp && this.callbacks.onSubDsp('refl-lpf', v));
            this._setupController(cReflF, 'sub-refl-lpf', DSP_DEFAULTS.sub['refl-lpf'], false);

            this._addGuiResetButton(gui, 'sub');
        }

        // ─── 6. SINE GENERATOR GUI ───
        if (cSine) {
            const gui = new GUI({ container: cSine, title: '🔊 Générateur Sinus', closeFolders: false, width: 320 });
            this.guis.sine = gui;

            const cActive = gui.add(this.state.sine, 'active').name('Actif').onChange(v => {
                if (this.callbacks.onSineToggle) this.callbacks.onSineToggle(v);
            });
            this._setupController(cActive, 'sine-active', false, false);

            const cFreq = gui.add(this.state.sine, 'frequency', 0, 20000, 1).name('Fréquence (Hz)').onChange(v => {
                if (this.callbacks.onSineFrequency) this.callbacks.onSineFrequency(v);
            });
            this._setupController(cFreq, 'sine-frequency', 440, false);

            const cVol = gui.add(this.state.sine, 'volume', 0, 100, 1).name('Volume (%)').onChange(v => {
                if (this.callbacks.onSineVolume) this.callbacks.onSineVolume(v);
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

        // Clean up stale position
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

        // Make draggable
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

    applyDspFromServer(bus, param, value) {
        if (!this.state[bus] || this.state[bus][param] === undefined) return;
        this.state[bus][param] = value;
        const gui = this.guis[bus];
        if (gui) {
            gui.controllersRecursive().forEach(ctrl => {
                if (ctrl.property === param) {
                    ctrl.updateDisplay();
                }
            });
        }
    }

    applyFullDspState(serverDsp) {
        if (!serverDsp || typeof serverDsp !== 'object') return;
        const buses = ['input', 'sub', 'mid', 'top', 'fill', 'master', 'env'];
        for (const bus of buses) {
            const busData = serverDsp[bus];
            if (!busData || !this.state[bus]) continue;
            for (const [param, val] of Object.entries(busData)) {
                if (this.state[bus][param] !== undefined) {
                    this.state[bus][param] = val;
                    const gui = this.guis[bus];
                    if (gui) {
                        gui.controllersRecursive().forEach(ctrl => {
                            if (ctrl.property === param) ctrl.updateDisplay();
                        });
                    }
                }
            }
        }
    }

    resetBus(busKey) {
        const defaults = DSP_DEFAULTS[busKey];
        if (!defaults) return;
        const gui = this.guis[busKey];
        if (!gui) return;
        gui.controllersRecursive().forEach(ctrl => {
            const defVal = defaults[ctrl.property];
            if (defVal !== undefined) ctrl.setValue(defVal);
        });
    }

    resetSine() {
        const gui = this.guis.sine;
        if (!gui) return;
        gui.controllersRecursive().forEach(ctrl => {
            if (ctrl.property === 'frequency') ctrl.setValue(440);
            if (ctrl.property === 'volume')    ctrl.setValue(50);
            if (ctrl.property === 'active')    ctrl.setValue(false);
        });
    }

    resetAllDsp() {
        const dspBuses = ['input', 'sub', 'mid', 'top', 'fill', 'master', 'env'];
        for (const bus of dspBuses) {
            this.resetBus(bus);
        }
        if (this.callbacks.onResetAllDsp) this.callbacks.onResetAllDsp();
    }

    setSineActive(active) {
        if (!this.state.sine) return;
        this.state.sine.active = Boolean(active);
        const gui = this.guis.sine;
        if (gui) {
            gui.controllersRecursive().forEach(ctrl => {
                if (ctrl.property === 'active') ctrl.updateDisplay();
            });
        }
    }

    updateInputAnalysis(data) {
        if (!data || !this.state.input) return;
        const { measuredLufs, appliedGainDb } = data;
        this.state.input['measured-lufs'] = (measuredLufs !== null && measuredLufs !== undefined) ? `${measuredLufs} LUFS` : '--';
        this.state.input['applied-gain'] = (appliedGainDb !== undefined) ? `${appliedGainDb > 0 ? '+' : ''}${appliedGainDb} dB` : '0.0 dB';
        if (this._inputLufsDisplay) this._inputLufsDisplay.updateDisplay();
        if (this._inputGainDisplay) this._inputGainDisplay.updateDisplay();
    }

    toggleDsp(force) {
        this._dspVisible = force !== undefined ? force : !this._dspVisible;
        if (this.dspPanels) this.dspPanels.classList.toggle('hidden', !this._dspVisible);
        if (this.envPanelWrap) this.envPanelWrap.classList.toggle('hidden', !this._dspVisible);
        if (this.userPanelWrap) this.userPanelWrap.classList.toggle('hidden', !this._dspVisible);
        return this._dspVisible;
    }

    toggleSine(force) {
        this._sinePanelVisible = force !== undefined ? force : !this._sinePanelVisible;
        if (this.sinePanelWrap) this.sinePanelWrap.classList.toggle('hidden', !this._sinePanelVisible);
        return this._sinePanelVisible;
    }
}
