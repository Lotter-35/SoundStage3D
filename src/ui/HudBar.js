/**
 * HudBar — Manages top HUD buttons, level meters, position display,
 * dropdowns (cones, HRTF), microphone, camera mode, and overlays.
 */
import { makeDraggable } from './draggable.js';

export class HudBar {
    constructor(callbacks = {}) {
        this.callbacks = callbacks;

        this.overlay = document.getElementById('overlay');
        this.hud = document.getElementById('hud');
        this.fileInput = document.getElementById('audio-file');
        this.fileNameEl = document.getElementById('file-name');
        this.enterBtn = document.getElementById('enter-btn');
        this.playBtn = document.getElementById('play-btn');
        this.changeMp3Btn = document.getElementById('change-mp3-btn');
        this.dspBtn = document.getElementById('dsp-btn');
        this.sineBtn = document.getElementById('sine-btn');
        this.micBtn = document.getElementById('mic-btn');
        this.camBtn = document.getElementById('cam-btn');
        this.spectrumBtn = document.getElementById('spectrum-btn');
        this.inviteBtn = document.getElementById('invite-btn');
        this.mpStatusEl = document.getElementById('mp-status');

        this.positionDisplay = document.getElementById('position-display');
        this._lastPosStr = '';

        // Cones dropdown
        this.conesBtn = document.getElementById('cones-btn');
        this.conesMenu = document.getElementById('cones-menu');

        // HRTF controls
        this._hrtfOn = false;
        this.hrtfBtn = document.getElementById('hrtf-btn');
        this.hrtfComp = document.getElementById('hrtf-comp');
        this.hrtfBrightnessSlider = document.getElementById('hrtf-brightness');
        this.hrtfBrightnessVal = document.getElementById('hrtf-brightness-val');

        // Spectrum state
        this._spectrumOn = false;

        // DSP Reset confirmation popup
        this.dspResetAllBtn = document.getElementById('dsp-reset-all-btn');
        this.dspConfirmDrop = document.getElementById('dsp-confirm-drop');
        this.dspConfirmYes = document.getElementById('dsp-confirm-yes');
        this.dspConfirmNo = document.getElementById('dsp-confirm-no');

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

        this._initEvents();
    }

    _initEvents() {
        // Overlay Enter button & File input
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
                if (this.callbacks.onEnter) this.callbacks.onEnter(this._file || null);
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
                    if (file && this.callbacks.onChangeMp3) this.callbacks.onChangeMp3(file);
                });
                input.click();
            });
        }

        // Play/Pause button
        if (this.playBtn) {
            this.playBtn.addEventListener('click', () => {
                if (this.callbacks.onPlayPause) this.callbacks.onPlayPause();
            });
        }

        // Microphone Button
        if (this.micBtn) {
            this.micBtn.addEventListener('click', () => {
                if (this.callbacks.onMicToggle) this.callbacks.onMicToggle();
            });
        }

        // Camera View Mode button
        if (this.camBtn) {
            this.camBtn.addEventListener('click', () => {
                if (this.callbacks.onCameraToggle) this.callbacks.onCameraToggle();
            });
        }

        // Invite Button (multiplayer master)
        if (this.inviteBtn) {
            this.inviteBtn.addEventListener('click', () => {
                if (this.callbacks.onInvite) this.callbacks.onInvite();
            });
        }

        // Spectrum FFT button
        if (this.spectrumBtn) {
            this.spectrumBtn.addEventListener('click', () => {
                this._spectrumOn = !this._spectrumOn;
                this.spectrumBtn.textContent = this._spectrumOn ? '📊 Spectre: ON' : '📊 Spectre: OFF';
                this.spectrumBtn.classList.toggle('active', this._spectrumOn);
                if (this.callbacks.onSpectrumToggle) this.callbacks.onSpectrumToggle(this._spectrumOn);
            });
        }

        // Sine Generator toggle button
        if (this.sineBtn) {
            this.sineBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.callbacks.onSineBtnClick) this.callbacks.onSineBtnClick();
            });
        }

        // DSP panels toggle button & Reset all popup
        if (this.dspBtn) {
            this.dspBtn.addEventListener('click', (e) => {
                if (e.target.closest('#dsp-reset-all-btn')) return;
                if (this.callbacks.onDspBtnClick) this.callbacks.onDspBtnClick();
            });
        }

        if (this.dspResetAllBtn && this.dspConfirmDrop) {
            this.dspResetAllBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.dspConfirmDrop.classList.toggle('hidden');
            });

            if (this.dspConfirmYes) {
                this.dspConfirmYes.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.dspConfirmDrop.classList.add('hidden');
                    if (this.callbacks.onResetAllDsp) this.callbacks.onResetAllDsp();
                });
            }

            if (this.dspConfirmNo) {
                this.dspConfirmNo.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.dspConfirmDrop.classList.add('hidden');
                });
            }

            document.addEventListener('click', (e) => {
                if (!this.dspConfirmDrop.contains(e.target) && e.target !== this.dspResetAllBtn) {
                    this.dspConfirmDrop.classList.add('hidden');
                }
            });
        }

        // HRTF button & brightness slider
        if (this.hrtfBtn) {
            this.hrtfBtn.addEventListener('click', () => {
                this._hrtfOn = !this._hrtfOn;
                this.hrtfBtn.textContent = this._hrtfOn ? '🎧 HRTF: ON' : '🎧 HRTF: OFF';
                if (this.hrtfComp) this.hrtfComp.classList.toggle('hidden', !this._hrtfOn);
                if (this.callbacks.onHrtfToggle) this.callbacks.onHrtfToggle(this._hrtfOn);
                const db = this._hrtfOn && this.hrtfBrightnessSlider ? Number(this.hrtfBrightnessSlider.value) : 0;
                if (this.callbacks.onHrtfBrightness) this.callbacks.onHrtfBrightness(db);
            });
        }

        if (this.hrtfBrightnessSlider) {
            this.hrtfBrightnessSlider.addEventListener('input', () => {
                const db = Number(this.hrtfBrightnessSlider.value);
                if (this.hrtfBrightnessVal) this.hrtfBrightnessVal.textContent = '+' + db + ' dB';
                if (this._hrtfOn && this.callbacks.onHrtfBrightness) this.callbacks.onHrtfBrightness(db);
            });
        }

        // Cones dropdown
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
                    if (this.callbacks.onConesToggle) this.callbacks.onConesToggle('all', on);
                });
            }

            coneCheckboxes.forEach(cb => {
                if (cb === coneAllBox) return;
                cb.addEventListener('change', () => {
                    const bus = cb.dataset.coneBus;
                    if (this.callbacks.onConesToggle) this.callbacks.onConesToggle(bus, cb.checked);
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

        // Meters draggable
        const metersEl = document.getElementById('meters');
        if (metersEl) {
            makeDraggable(metersEl, metersEl, 'meters');
        }
    }

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

    setMicActive(active) {
        if (!this.micBtn) return;
        this.micBtn.textContent = active ? '🎤 Micro: ON' : '🎤 Micro: OFF';
        this.micBtn.classList.toggle('active', active);
    }

    setGuestMode(isGuest) {
        const guestHideSelectors = ['#input-file-container', '#track-change-row', '#audio-file'];
        for (const sel of guestHideSelectors) {
            const el = document.querySelector(sel);
            if (el) el.classList.toggle('hidden', isGuest);
        }
        if (this.changeMp3Btn) this.changeMp3Btn.classList.add('hidden');
        if (this.inviteBtn) this.inviteBtn.classList.toggle('hidden', isGuest);
    }

    setPlayerCount(count) {
        if (!this.mpStatusEl) return;
        this.mpStatusEl.textContent = count <= 1 ? '👤 Solo' : `👥 ${count} joueurs`;
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
