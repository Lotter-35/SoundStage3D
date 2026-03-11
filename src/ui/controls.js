/**
 * Controls — UI overlay: file input, playback buttons, position display.
 */

export class Controls {
    constructor() {
        this.overlay = document.getElementById('overlay');
        this.hud = document.getElementById('hud');
        this.fileInput = document.getElementById('audio-file');
        this.fileNameEl = document.getElementById('file-name');
        this.enterBtn = document.getElementById('enter-btn');
        this.playBtn = document.getElementById('play-btn');
        this.stopBtn = document.getElementById('stop-btn');
        this.positionDisplay = document.getElementById('position-display');
        this.fohDisplay = document.getElementById('foh-distance');

        // Level meters
        this._meters = ['sub', 'mid', 'top', 'fill', 'master'].map(id => {
            const el = document.getElementById(`meter-${id}`);
            return {
                fill: el.querySelector('.meter-fill'),
                peak: el.querySelector('.meter-peak'),
                clip: el.querySelector('.meter-clip'),
                peakHold: 0,
                peakTimer: 0,
                clipTimer: 0,
            };
        });

        this._file = null;
        this._onEnter = null;
        this._onPlayPause = null;
        this._onStop = null;
        this._onDopplerToggle = null;
        this._dopplerOn = false;

        this._onConesToggle = null; // cb(bus, visible) or cb('all', visible)

        this.dopplerBtn = document.getElementById('doppler-btn');
        this.dopplerBtn.addEventListener('click', () => {
            this._dopplerOn = !this._dopplerOn;
            this.dopplerBtn.textContent = this._dopplerOn ? '🔊 Doppler: ON' : '🔇 Doppler: OFF';
            if (this._onDopplerToggle) this._onDopplerToggle(this._dopplerOn);
        });

        this.conesBtn = document.getElementById('cones-btn');
        this.conesMenu = document.getElementById('cones-menu');
        this._coneCheckboxes = this.conesMenu.querySelectorAll('input[data-cone-bus]');
        this._coneAllBox = this.conesMenu.querySelector('input[data-cone-bus="all"]');

        // Toggle dropdown open/close
        this.conesBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.conesMenu.classList.toggle('open');
        });

        // Close dropdown when clicking elsewhere
        document.addEventListener('click', (e) => {
            if (!this.conesMenu.contains(e.target) && e.target !== this.conesBtn) {
                this.conesMenu.classList.remove('open');
            }
        });

        // "Tous" checkbox toggles all
        this._coneAllBox.addEventListener('change', () => {
            const on = this._coneAllBox.checked;
            this._coneCheckboxes.forEach(cb => { cb.checked = on; });
            if (this._onConesToggle) this._onConesToggle('all', on);
        });

        // Individual bus checkboxes
        this._coneCheckboxes.forEach(cb => {
            if (cb === this._coneAllBox) return;
            cb.addEventListener('change', () => {
                const bus = cb.dataset.coneBus;
                if (this._onConesToggle) this._onConesToggle(bus, cb.checked);
                // Update "Tous" state
                const busBoxes = [...this._coneCheckboxes].filter(c => c !== this._coneAllBox);
                const allOn = busBoxes.every(c => c.checked);
                const anyOn = busBoxes.some(c => c.checked);
                this._coneAllBox.checked = allOn;
                this._coneAllBox.indeterminate = !allOn && anyOn;
            });
        });

        // Volume sliders
        this._onVolumeChange = null;
        this.volSubSlider = document.getElementById('vol-sub');
        this.volSubVal = document.getElementById('vol-sub-val');
        this.volMidSlider = document.getElementById('vol-mid');
        this.volMidVal = document.getElementById('vol-mid-val');
        this.volTopSlider = document.getElementById('vol-top');
        this.volTopVal = document.getElementById('vol-top-val');
        this.volFillSlider = document.getElementById('vol-fill');
        this.volFillVal = document.getElementById('vol-fill-val');

        this.volSubSlider.addEventListener('input', () => {
            const v = this.volSubSlider.value / 100;
            this.volSubVal.textContent = this.volSubSlider.value + '%';
            if (this._onVolumeChange) this._onVolumeChange('sub', v);
        });
        this.volMidSlider.addEventListener('input', () => {
            const v = this.volMidSlider.value / 100;
            this.volMidVal.textContent = this.volMidSlider.value + '%';
            if (this._onVolumeChange) this._onVolumeChange('mid', v);
        });
        this.volTopSlider.addEventListener('input', () => {
            const v = this.volTopSlider.value / 100;
            this.volTopVal.textContent = this.volTopSlider.value + '%';
            if (this._onVolumeChange) this._onVolumeChange('top', v);
        });
        this.volFillSlider.addEventListener('input', () => {
            const v = this.volFillSlider.value / 100;
            this.volFillVal.textContent = this.volFillSlider.value + '%';
            if (this._onVolumeChange) this._onVolumeChange('fill', v);
        });

        // Range (propagation) sliders
        this._onRangeChange = null;
        this.rangeSubSlider = document.getElementById('range-sub');
        this.rangeSubVal = document.getElementById('range-sub-val');
        this.rangeMidSlider = document.getElementById('range-mid');
        this.rangeMidVal = document.getElementById('range-mid-val');
        this.rangeTopSlider = document.getElementById('range-top');
        this.rangeTopVal = document.getElementById('range-top-val');
        this.rangeFillSlider = document.getElementById('range-fill');
        this.rangeFillVal = document.getElementById('range-fill-val');

        this.rangeSubSlider.addEventListener('input', () => {
            this.rangeSubVal.textContent = this.rangeSubSlider.value;
            if (this._onRangeChange) this._onRangeChange('sub', Number(this.rangeSubSlider.value));
        });
        this.rangeMidSlider.addEventListener('input', () => {
            this.rangeMidVal.textContent = this.rangeMidSlider.value;
            if (this._onRangeChange) this._onRangeChange('mid', Number(this.rangeMidSlider.value));
        });
        this.rangeTopSlider.addEventListener('input', () => {
            this.rangeTopVal.textContent = this.rangeTopSlider.value;
            if (this._onRangeChange) this._onRangeChange('top', Number(this.rangeTopSlider.value));
        });
        this.rangeFillSlider.addEventListener('input', () => {
            this.rangeFillVal.textContent = this.rangeFillSlider.value;
            if (this._onRangeChange) this._onRangeChange('fill', Number(this.rangeFillSlider.value));
        });

        // Clarity (air absorption) slider
        this._onClarityChange = null;
        this.claritySlider = document.getElementById('clarity-top');
        this.clarityVal = document.getElementById('clarity-top-val');

        this.claritySlider.addEventListener('input', () => {
            this.clarityVal.textContent = this.claritySlider.value;
            if (this._onClarityChange) this._onClarityChange(Number(this.claritySlider.value));
        });

        // --- Reset logic ---
        // Helper to reset a single slider to its data-default value and fire its input event
        this._resetSlider = (slider) => {
            const def = slider.dataset.default;
            if (def !== undefined) {
                slider.value = def;
                slider.dispatchEvent(new Event('input'));
            }
        };

        // Per-slider reset buttons
        document.querySelectorAll('.reset-btn[data-target]').forEach(btn => {
            btn.addEventListener('click', () => {
                const slider = document.getElementById(btn.dataset.target);
                if (slider) this._resetSlider(slider);
            });
        });

        // Double-click on any slider to reset
        document.querySelectorAll('.vol-slider input[type="range"]').forEach(slider => {
            slider.addEventListener('dblclick', () => {
                this._resetSlider(slider);
            });
        });

        // Reset All button
        document.getElementById('reset-all-btn').addEventListener('click', () => {
            document.querySelectorAll('.vol-slider input[type="range"][data-default]').forEach(slider => {
                this._resetSlider(slider);
            });
        });

        this.fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            this._file = file;
            this.fileNameEl.textContent = file.name;
            this.enterBtn.disabled = false;
        });

        this.enterBtn.addEventListener('click', () => {
            if (this._onEnter && this._file) {
                this._onEnter(this._file);
            }
        });

        this.playBtn.addEventListener('click', () => {
            if (this._onPlayPause) this._onPlayPause();
        });

        this.stopBtn.addEventListener('click', () => {
            if (this._onStop) this._onStop();
        });
    }

    /** Register callback when user clicks Enter. Callback receives the File object. */
    onEnter(cb) { this._onEnter = cb; }

    /** Register play/pause toggle callback */
    onPlayPause(cb) { this._onPlayPause = cb; }

    /** Register stop callback */
    onStop(cb) { this._onStop = cb; }

    /** Register doppler toggle callback */
    onDopplerToggle(cb) { this._onDopplerToggle = cb; }

    /** Register cones toggle callback */
    onConesToggle(cb) { this._onConesToggle = cb; }

    /** Register volume change callback */
    onVolumeChange(cb) { this._onVolumeChange = cb; }

    /** Register range (propagation) change callback */
    onRangeChange(cb) { this._onRangeChange = cb; }

    /** Register clarity (air absorption) change callback */
    onClarityChange(cb) { this._onClarityChange = cb; }

    /** Switch from start screen to HUD */
    showHUD() {
        this.overlay.classList.add('hidden');
        this.hud.classList.remove('hidden');
    }

    /** Switch back to start screen */
    showOverlay() {
        this.overlay.classList.remove('hidden');
        this.hud.classList.add('hidden');
    }

    /**
     * Update HUD position display.
     * @param {{x:number,y:number,z:number}} pos
     * @param {number} fohDist
     */
    updatePosition(pos, fohDist) {
        this.positionDisplay.textContent =
            `X: ${pos.x.toFixed(1)}  Y: ${pos.y.toFixed(1)}  Z: ${pos.z.toFixed(1)}`;
        this.fohDisplay.textContent = `Distance FOH: ${fohDist.toFixed(1)} m`;
    }

    /**
     * Update play button label.
     * @param {boolean} isPlaying
     */
    setPlayState(isPlaying) {
        this.playBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
    }

    /**
     * Update level meter bars.
     * @param {{ sub: number, mid: number, top: number, master: number }} levels — 0..1 peak values
     */
    updateMeters(levels) {
        const keys = ['sub', 'mid', 'top', 'fill', 'master'];
        const now = performance.now();
        for (let i = 0; i < 5; i++) {
            const m = this._meters[i];
            const raw = levels[keys[i]];
            // Convert to dB then to 0-100% (range: -60dB to 0dB)
            const db = raw > 0.00001 ? 20 * Math.log10(raw) : -60;
            const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

            m.fill.style.height = pct + '%';

            // Peak hold (falls after 1.5s)
            if (pct >= m.peakHold) {
                m.peakHold = pct;
                m.peakTimer = now + 1500;
            } else if (now > m.peakTimer) {
                m.peakHold = Math.max(pct, m.peakHold - 1.2);
            }
            m.peak.style.bottom = m.peakHold + '%';

            // Clip indicator (stays lit for 2s)
            if (raw >= 0.99) {
                m.clipTimer = now + 2000;
            }
            m.clip.classList.toggle('active', now < m.clipTimer);
        }
    }
}
