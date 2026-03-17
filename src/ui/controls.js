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
        this.changeMp3Btn = document.getElementById('change-mp3-btn');
        this.positionDisplay = document.getElementById('position-display');

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
        this._onChangeMp3 = null;
        this._onDopplerToggle = null;
        this._dopplerOn = false;

        this._onOscilloscopeToggle = null;
        this._oscilloscopeOn = false;

        this._onConesToggle = null; // cb(bus, visible) or cb('all', visible)

        this._onHrtfToggle = null;
        this._onHrtfBrightness = null;
        this._hrtfOn = false;
        this.hrtfBtn = document.getElementById('hrtf-btn');
        this.hrtfComp = document.getElementById('hrtf-comp');
        this.hrtfBrightnessSlider = document.getElementById('hrtf-brightness');
        this.hrtfBrightnessVal = document.getElementById('hrtf-brightness-val');

        this.hrtfBtn.addEventListener('click', () => {
            this._hrtfOn = !this._hrtfOn;
            this.hrtfBtn.textContent = this._hrtfOn ? '🎧 HRTF: ON' : '🎧 HRTF: OFF';
            this.hrtfComp.classList.toggle('hidden', !this._hrtfOn);
            if (this._onHrtfToggle) this._onHrtfToggle(this._hrtfOn);
            // Apply or reset brightness compensation
            const db = this._hrtfOn ? Number(this.hrtfBrightnessSlider.value) : 0;
            if (this._onHrtfBrightness) this._onHrtfBrightness(db);
        });

        this.hrtfBrightnessSlider.addEventListener('input', () => {
            const db = Number(this.hrtfBrightnessSlider.value);
            this.hrtfBrightnessVal.textContent = '+' + db + ' dB';
            if (this._hrtfOn && this._onHrtfBrightness) this._onHrtfBrightness(db);
        });

        this.dopplerBtn = document.getElementById('doppler-btn');
        this.dopplerBtn.addEventListener('click', () => {
            this._dopplerOn = !this._dopplerOn;
            this.dopplerBtn.textContent = this._dopplerOn ? '🔊 Doppler: ON' : '🔇 Doppler: OFF';
            if (this._onDopplerToggle) this._onDopplerToggle(this._dopplerOn);
        });

        this.oscilloscopeBtn = document.getElementById('oscilloscope-btn');
        this.oscilloscopeBtn.addEventListener('click', () => {
            this._oscilloscopeOn = !this._oscilloscopeOn;
            this.oscilloscopeBtn.textContent = this._oscilloscopeOn ? '📈 Oscillo: ON' : '📈 Oscillo: OFF';
            if (this._onOscilloscopeToggle) this._onOscilloscopeToggle(this._oscilloscopeOn);
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

        // Volume sliders (now managed by DSP panels)

        // ─── DSP Panel toggle ─────────────────────────────────────────
        this.dspBtn = document.getElementById('dsp-btn');
        this.dspPanels = document.getElementById('dsp-panels');
        this.dspMasterWrap = document.getElementById('dsp-master-wrap');
        this._dspVisible = false;
        this.dspBtn.addEventListener('click', () => {
            this._dspVisible = !this._dspVisible;
            this.dspPanels.classList.toggle('hidden', !this._dspVisible);
            this.dspMasterWrap.classList.toggle('hidden', !this._dspVisible);
            this.dspBtn.classList.toggle('active', this._dspVisible);
        });

        // Panel collapse/expand toggles
        document.querySelectorAll('.dsp-panel-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const body = btn.closest('.dsp-panel').querySelector('.dsp-panel-body');
                const collapsed = body.classList.toggle('collapsed');
                btn.textContent = collapsed ? '+' : '−';
            });
        });

        // ─── DSP Sub panel callbacks ──────────────────────────────────
        this._onSubDsp = null; // cb(param, value)
        this._initDspSliders('sub', {
            'xover-freq':    { suffix: ' Hz' },
            'comp-threshold':{ suffix: ' dB' },
            'comp-knee':     { suffix: ' dB' },
            'comp-ratio':    { suffix: ':1' },
            'comp-attack':   { suffix: ' ms' },
            'comp-release':  { suffix: ' ms' },
            'sat-drive':     { suffix: '%' },
            'sat-mix':       { suffix: '%' },
            'prox-far':      { format: v => parseFloat(v).toFixed(1) + ' m' },
            'prox-near':     { format: v => parseFloat(v).toFixed(1) + ' m' },
            'prox-drive':    { suffix: '%' },
            'bus-volume':    { suffix: '%' },
            'dist-k':        { format: v => (v / 1000).toFixed(3) },
            'refl-gain':     { format: v => (v / 100).toFixed(2) },
            'refl-lpf':      { suffix: ' Hz' },
            'lim-threshold': { suffix: ' dB' },
        });

        // ─── DSP Mid panel callbacks ──────────────────────────────────
        this._onMidDsp = null; // cb(param, value)
        this._initDspSliders('mid', {
            'xover-low':     { suffix: ' Hz' },
            'xover-high':    { suffix: ' Hz' },
            'comp-threshold':{ suffix: ' dB' },
            'comp-knee':     { suffix: ' dB' },
            'comp-ratio':    { suffix: ':1' },
            'comp-attack':   { suffix: ' ms' },
            'comp-release':  { suffix: ' ms' },
            'sat-drive':     { suffix: '%' },
            'sat-mix':       { suffix: '%' },
            'bus-volume':    { suffix: '%' },
            'dist-k':        { format: v => (v / 1000).toFixed(3) },
            'refl-gain':     { format: v => (v / 100).toFixed(2) },
            'refl-lpf':      { suffix: ' Hz' },
            'lim-threshold': { suffix: ' dB' },
        });

        // ─── DSP Top panel callbacks ──────────────────────────────────
        this._onTopDsp = null;
        this._initDspSliders('top', {
            'xover-freq':    { suffix: ' Hz' },
            'comp-threshold':{ suffix: ' dB' },
            'comp-knee':     { suffix: ' dB' },
            'comp-ratio':    { suffix: ':1' },
            'comp-attack':   { suffix: ' ms' },
            'comp-release':  { suffix: ' ms' },
            'sat-drive':     { suffix: '%' },
            'sat-mix':       { suffix: '%' },
            'bus-volume':    { suffix: '%' },
            'dist-k':        { format: v => (v / 1000).toFixed(3) },
            'refl-gain':     { format: v => (v / 100).toFixed(2) },
            'refl-lpf':      { suffix: ' Hz' },
            'lim-threshold': { suffix: ' dB' },
        });

        // ─── DSP Fill panel callbacks ─────────────────────────────────
        this._onFillDsp = null;
        this._initDspSliders('fill', {
            'merge-gain':    { format: v => (v / 100).toFixed(2) },
            'bus-volume':    { suffix: '%' },
            'dist-k':        { format: v => (v / 1000).toFixed(3) },
            'refl-gain':     { format: v => (v / 100).toFixed(2) },
            'refl-lpf':      { suffix: ' Hz' },
            'lim-threshold': { suffix: ' dB' },
        });

        // ─── DSP Master panel callbacks ────────────────────────────────
        this._onMasterDsp = null;
        this._initDspSliders('master', {
            'air-abs':          { suffix: ' Hz/m' },
            'treble':           { suffix: ' dB' },
            'reverb':           { suffix: '%' },
            'local-volume':     { suffix: '%' },
            'mouse-sensitivity':{ format: v => (v / 100).toFixed(1) + '×' },
        });

        // ─── DSP Tooltip (position: fixed, to escape overflow clips) ───
        this._tooltipEl = document.getElementById('dsp-tooltip');
        this._tooltipTimer = null;
        document.querySelectorAll('[data-tooltip]').forEach(el => {
            el.addEventListener('mouseenter', () => {
                clearTimeout(this._tooltipTimer);
                const text = el.getAttribute('data-tooltip');
                if (!text) return;
                this._tooltipEl.textContent = text;
                const rect = el.getBoundingClientRect();
                const ttWidth = 280; // matches CSS width
                let top = rect.top + rect.height / 2;
                let left;

                // Determine which panel this element belongs to
                const panel = el.closest('.dsp-panel');
                const panelId = panel ? panel.id : '';
                const isLeftGroup = (panelId === 'dsp-panel-top' || panelId === 'dsp-panel-mid');
                // FILL, SUB, and Master → tooltip to the left

                if (isLeftGroup) {
                    // Tooltip to the RIGHT of this panel
                    const panelRect = panel.getBoundingClientRect();
                    left = panelRect.right + 16;
                    this._tooltipEl.classList.add('arrow-right');
                } else {
                    // Tooltip to the LEFT of this panel
                    const panelRect = panel ? panel.getBoundingClientRect() : rect;
                    left = panelRect.left - ttWidth - 16;
                    this._tooltipEl.classList.remove('arrow-right');
                }

                // Avoid going off-screen
                this._tooltipEl.classList.add('visible');
                this._tooltipEl.style.left = Math.max(8, left) + 'px';
                // Measure actual height to center vertically
                const ttHeight = this._tooltipEl.offsetHeight;
                top = Math.max(8, Math.min(window.innerHeight - ttHeight - 8, top - ttHeight / 2));
                this._tooltipEl.style.top = top + 'px';
            });
            el.addEventListener('mouseleave', () => {
                this._tooltipTimer = setTimeout(() => {
                    this._tooltipEl.classList.remove('visible');
                }, 80);
            });
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
        document.querySelectorAll('.vol-slider input[type="range"], .dsp-param input[type="range"], .hud-slider-drop input[type="range"]').forEach(slider => {
            slider.addEventListener('dblclick', () => {
                this._resetSlider(slider);
            });
        });

        // ─── Persistence localStorage pour les réglages locaux ─────────
        const PERSIST_KEYS = ['master-mouse-sensitivity'];
        for (const id of PERSIST_KEYS) {
            const slider = document.getElementById(id);
            if (!slider) continue;
            const saved = localStorage.getItem('soundstage3d:' + id);
            if (saved !== null) {
                slider.value = saved;
                slider.dispatchEvent(new Event('input'));
            }
            slider.addEventListener('input', () => {
                localStorage.setItem('soundstage3d:' + id, slider.value);
            });
        }

        this.fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            this._file = file;
            this.fileNameEl.textContent = file.name;
            this.enterBtn.disabled = false;
        });

        this.enterBtn.addEventListener('click', () => {
            if (this._onEnter) {
                this._onEnter(this._file || null);
            }
        });

        this.playBtn.addEventListener('click', () => {
            if (this._onPlayPause) this._onPlayPause();
        });

        this.changeMp3Btn.addEventListener('click', () => {
            // Create a hidden file input and trigger it
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

    /**
     * Initialise all DSP sliders for a bus panel.
     * @param {string} bus — 'sub', 'mid', 'top', 'fill'
     * @param {object} params — { paramKey: { suffix?, format? } }
     */
    _initDspSliders(bus, params) {
        const cbKey = `_on${bus.charAt(0).toUpperCase() + bus.slice(1)}Dsp`;
        for (const [param, opts] of Object.entries(params)) {
            const id = `${bus}-${param}`;
            const slider = document.getElementById(id);
            const valEl = document.getElementById(`${id}-val`);
            if (!slider || !valEl) continue;

            const formatVal = (v) => {
                if (opts.format) return opts.format(Number(v));
                return v + (opts.suffix || '');
            };

            // Set initial label
            valEl.textContent = formatVal(slider.value);

            slider.addEventListener('input', () => {
                valEl.textContent = formatVal(slider.value);
                if (this[cbKey]) this[cbKey](param, Number(slider.value));
            });
        }
    }

    /** Register callback when user clicks Enter. Callback receives the File object. */
    onEnter(cb) { this._onEnter = cb; }

    /** Register play/pause toggle callback */
    onPlayPause(cb) { this._onPlayPause = cb; }

    /** Register change MP3 callback */
    onChangeMp3(cb) { this._onChangeMp3 = cb; }

    /** Register doppler toggle callback */
    onDopplerToggle(cb) { this._onDopplerToggle = cb; }
    onOscilloscopeToggle(cb) { this._onOscilloscopeToggle = cb; }

    /** Register HRTF toggle callback */
    onHrtfToggle(cb) { this._onHrtfToggle = cb; }

    /** Register HRTF brightness compensation callback */
    onHrtfBrightness(cb) { this._onHrtfBrightness = cb; }

    /** Register cones toggle callback */
    onConesToggle(cb) { this._onConesToggle = cb; }

    /** Register clarity (air absorption) change callback */
    onMasterDsp(cb) { this._onMasterDsp = cb; }

    /** Register SUB DSP panel change callback: cb(param, value) */
    onSubDsp(cb) { this._onSubDsp = cb; }

    /** Register MID DSP panel change callback: cb(param, value) */
    onMidDsp(cb) { this._onMidDsp = cb; }

    /** Register TOP DSP panel change callback: cb(param, value) */
    onTopDsp(cb) { this._onTopDsp = cb; }

    /** Register FILL DSP panel change callback: cb(param, value) */
    onFillDsp(cb) { this._onFillDsp = cb; }

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
