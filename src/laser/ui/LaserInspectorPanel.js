/**
 * LaserInspectorPanel.js
 * ─────────────────────────────────────────────────────────────
 * Panneau de contrôle individuel d'un laser.
 * Affiché à GAUCHE de l'écran quand on clique sur un laser en 3D.
 *
 * Sections :
 * - ⚡ Style Laser : nombre traits, taille, écart, couleur, puissance, forme
 * - ✨ Tweaking Visuel Source : glow, halo impact, PAN
 * - 🌟 Clignotement : strobe on/off, vitesse
 * - 🏗️ Position : X, Y, Z
 * - Actions : Dupliquer, Supprimer
 *
 * Style glassmorphism cohérent avec l'UI SoundStage3D.
 * ─────────────────────────────────────────────────────────────
 */

import { globalLaserPostParams } from '../LaserManager.js';

export class LaserInspectorPanel {
    /**
     * @param {object} options
     * @param {LaserManager} options.laserManager
     * @param {HTMLElement} options.panelEl  — L'élément DOM #laser-inspector-panel
     */
    constructor({ laserManager, panelEl }) {
        this.laserManager = laserManager;
        this.panelEl = panelEl;

        this._currentLaser = null;
        this._currentLaserId = null;

        this._build();
    }

    /** Ouvre le panneau pour un laser donné */
    openForLaser(id, laserShow) {
        this._currentLaser   = laserShow;
        this._currentLaserId = id;
        this._refresh();
        this.panelEl.classList.add('open');
    }

    /** Ferme le panneau */
    close() {
        this.panelEl.classList.remove('open');
        this._currentLaser   = null;
        this._currentLaserId = null;
    }

    /** Retourne true si le panneau est ouvert */
    get isOpen() {
        return this.panelEl.classList.contains('open');
    }

    /** Construit la structure DOM initiale */
    _build() {
        this.panelEl.innerHTML = `
        <div class="lp-header">
            <div class="lp-title">
                <span class="lp-icon">🔴</span>
                <span class="lp-title-text">Laser <span id="lp-laser-id">#1</span></span>
            </div>
            <button id="lp-close-btn" class="lp-close-btn" title="Fermer">✕</button>
        </div>

        <div class="lp-body">

            <!-- Style Laser -->
            <div class="lp-section">
                <div class="lp-section-title">⚡ Style Laser</div>

                <div class="lp-row">
                    <label>Couleur</label>
                    <input type="color" id="lp-color" value="#0055ff">
                </div>

                <div class="lp-row">
                    <label>Nombre de traits</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-count" min="1" max="32" step="1" value="8">
                        <span class="lp-val" id="lp-count-val">8</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Taille trait</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-beamWidth" min="0" max="3" step="0.05" value="1.0">
                        <span class="lp-val" id="lp-beamWidth-val">1.0</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Écart laser</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-spread" min="0" max="110" step="0.5" value="50">
                        <span class="lp-val" id="lp-spread-val">50</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Angle horiz.</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-angle" min="-180" max="180" step="1" value="0">
                        <span class="lp-val" id="lp-angle-val">0°</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Puissance générale</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-masterPower" min="0" max="1.5" step="0.05" value="0.8">
                        <span class="lp-val" id="lp-masterPower-val">0.80</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Puissance traits</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-beamPower" min="0" max="1.5" step="0.05" value="0.8">
                        <span class="lp-val" id="lp-beamPower-val">0.80</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Puissance PAN</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-panPower" min="0" max="1.5" step="0.05" value="0.8">
                        <span class="lp-val" id="lp-panPower-val">0.80</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Laser PAN</label>
                    <label class="lp-toggle">
                        <input type="checkbox" id="lp-laserPan" checked>
                        <span class="lp-toggle-slider"></span>
                    </label>
                </div>

                <div class="lp-row">
                    <label>Forme tracé</label>
                    <select id="lp-patternShape" class="lp-select">
                        <option value="Horizontal">Horizontal</option>
                        <option value="Sinusoïde">Sinusoïde</option>
                        <option value="Parabolique">Parabolique</option>
                        <option value="Zigzag">Zigzag</option>
                        <option value="Vague Double">Vague Double</option>
                    </select>
                </div>

                <div class="lp-row" id="lp-curve-row">
                    <label>Amplitude courbe</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-curveAmplitude" min="0" max="1.5" step="0.01" value="0.3">
                        <span class="lp-val" id="lp-curveAmplitude-val">0.30</span>
                    </div>
                </div>
            </div>

            <!-- Clignotement -->
            <div class="lp-section">
                <div class="lp-section-title">🌟 Clignotement</div>
                <div class="lp-row">
                    <label>Actif</label>
                    <label class="lp-toggle">
                        <input type="checkbox" id="lp-strobe">
                        <span class="lp-toggle-slider"></span>
                    </label>
                </div>
                <div class="lp-row">
                    <label>Vitesse (Hz)</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-strobeSpeed" min="0.5" max="30" step="0.5" value="12">
                        <span class="lp-val" id="lp-strobeSpeed-val">12.0</span>
                    </div>
                </div>
            </div>

            <!-- Tweaking visuel source -->
            <div class="lp-section">
                <div class="lp-section-title">✨ Tweaking Visuel Source</div>

                <div class="lp-row">
                    <label>Puissance buse</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-sourceEmissionPower" min="0" max="4" step="0.05" value="1.5">
                        <span class="lp-val" id="lp-sourceEmissionPower-val">1.50</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Rayon halo buse</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-sourceGlowRadius" min="0.2" max="3" step="0.1" value="0.7">
                        <span class="lp-val" id="lp-sourceGlowRadius-val">0.70</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Intensité glow</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-glowIntensity" min="0" max="3" step="0.05" value="1.0">
                        <span class="lp-val" id="lp-glowIntensity-val">1.00</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Diffusion faisceau</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-glowScattering" min="0" max="3" step="0.05" value="1.0">
                        <span class="lp-val" id="lp-glowScattering-val">1.00</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Densité fumée</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-fogDensity" min="0" max="0.05" step="0.001" value="0.015">
                        <span class="lp-val" id="lp-fogDensity-val">0.015</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Intensité éclairage</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-giIntensity" min="0" max="10" step="0.1" value="2.0">
                        <span class="lp-val" id="lp-giIntensity-val">2.00</span>
                    </div>
                </div>

                <div class="lp-row">
                    <label>Portée éclairage</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-giDistance" min="2" max="60" step="0.5" value="15">
                        <span class="lp-val" id="lp-giDistance-val">15.0</span>
                    </div>
                </div>
            </div>

            <!-- Position -->
            <div class="lp-section">
                <div class="lp-section-title">📍 Position 3D</div>
                <div class="lp-row">
                    <label>X</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-pos-x" min="-100" max="100" step="0.1" value="0">
                        <span class="lp-val" id="lp-pos-x-val">0.0</span>
                    </div>
                </div>
                <div class="lp-row">
                    <label>Y (hauteur)</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-pos-y" min="0" max="40" step="0.1" value="5">
                        <span class="lp-val" id="lp-pos-y-val">5.0</span>
                    </div>
                </div>
                <div class="lp-row">
                    <label>Z</label>
                    <div class="lp-slider-wrap">
                        <input type="range" id="lp-pos-z" min="-100" max="100" step="0.1" value="0">
                        <span class="lp-val" id="lp-pos-z-val">0.0</span>
                    </div>
                </div>
            </div>

            <!-- Actions -->
            <div class="lp-section lp-actions-section">
                <button id="lp-duplicate-btn" class="lp-btn lp-btn-secondary">📋 Dupliquer</button>
                <button id="lp-delete-btn" class="lp-btn lp-btn-danger">🗑️ Supprimer</button>
            </div>

        </div>
        `;

        // Bind close
        this.panelEl.querySelector('#lp-close-btn').addEventListener('click', () => this.close());

        // Delegate tous les changements
        this._bindEvents();
    }

    /** Lie tous les événements de contrôle */
    _bindEvents() {
        const on = (id, event, fn) => {
            const el = this.panelEl.querySelector(`#${id}`);
            if (el) el.addEventListener(event, fn);
        };

        // Sliders et inputs — helper générique
        const bindSlider = (id, paramKey, format = null) => {
            on(id, 'input', (e) => {
                if (!this._currentLaser) return;
                const v = parseFloat(e.target.value);
                this._currentLaser.setParam(paramKey, v);
                const valEl = this.panelEl.querySelector(`#${id}-val`);
                if (valEl) valEl.textContent = format ? format(v) : v.toFixed(2);
            });
        };

        const bindCheck = (id, paramKey) => {
            on(id, 'change', (e) => {
                if (!this._currentLaser) return;
                this._currentLaser.setParam(paramKey, e.target.checked);
            });
        };

        const bindSelect = (id, paramKey) => {
            on(id, 'change', (e) => {
                if (!this._currentLaser) return;
                this._currentLaser.setParam(paramKey, e.target.value);
            });
        };

        // Couleur
        on('lp-color', 'input', (e) => {
            if (!this._currentLaser) return;
            this._currentLaser.setParam('color', e.target.value);
        });

        // Style laser
        bindSlider('lp-count', 'count', v => Math.round(v));
        bindSlider('lp-beamWidth', 'beamWidth');
        bindSlider('lp-spread', 'spread', v => v.toFixed(1));
        bindSlider('lp-angle', 'angle', v => `${Math.round(v)}°`);
        bindSlider('lp-masterPower', 'masterPower');
        bindSlider('lp-beamPower', 'beamPower');
        bindSlider('lp-panPower', 'panPower');
        bindCheck('lp-laserPan', 'laserPan');
        bindSelect('lp-patternShape', 'patternShape');
        bindSlider('lp-curveAmplitude', 'curveAmplitude');

        // Clignotement
        bindCheck('lp-strobe', 'strobe');
        bindSlider('lp-strobeSpeed', 'strobeSpeed', v => v.toFixed(1));

        // Tweaking visuel
        bindSlider('lp-sourceEmissionPower', 'sourceEmissionPower');
        bindSlider('lp-sourceGlowRadius', 'sourceGlowRadius');
        bindSlider('lp-glowIntensity', 'glowIntensity');
        bindSlider('lp-glowScattering', 'glowScattering');
        bindSlider('lp-fogDensity', 'fogDensity', v => v.toFixed(3));
        bindSlider('lp-giIntensity', 'giIntensity');
        bindSlider('lp-giDistance', 'giDistance', v => v.toFixed(1));

        // Position
        const bindPos = (id, axis, valId) => {
            on(id, 'input', (e) => {
                if (!this._currentLaser) return;
                const v = parseFloat(e.target.value);
                const pos = this._currentLaser.getPosition();
                pos[axis] = v;
                this._currentLaser.setPosition(pos.x, pos.y, pos.z);
                const valEl = this.panelEl.querySelector(`#${valId}`);
                if (valEl) valEl.textContent = v.toFixed(1);
            });
        };
        bindPos('lp-pos-x', 'x', 'lp-pos-x-val');
        bindPos('lp-pos-y', 'y', 'lp-pos-y-val');
        bindPos('lp-pos-z', 'z', 'lp-pos-z-val');

        // Actions
        on('lp-duplicate-btn', 'click', () => {
            if (!this._currentLaser) return;
            const pos = this._currentLaser.getPosition().clone();
            pos.x += 1.5;
            const result = this.laserManager.addLaser(pos, { ...this._currentLaser.params });
            this.openForLaser(result.id, result.laserShow);
        });

        on('lp-delete-btn', 'click', () => {
            if (this._currentLaserId == null) return;
            this.laserManager.removeLaser(this._currentLaserId);
            this.close();
        });
    }

    /** Met à jour tous les contrôles avec les valeurs du laser courant */
    _refresh() {
        if (!this._currentLaser) return;
        const p = this._currentLaser.params;
        const pos = this._currentLaser.getPosition();

        const set = (id, value) => {
            const el = this.panelEl.querySelector(`#${id}`);
            if (el) el.value = value;
        };
        const setVal = (id, text) => {
            const el = this.panelEl.querySelector(`#${id}`);
            if (el) el.textContent = text;
        };
        const setCheck = (id, checked) => {
            const el = this.panelEl.querySelector(`#${id}`);
            if (el) el.checked = checked;
        };

        // ID
        const idEl = this.panelEl.querySelector('#lp-laser-id');
        if (idEl) idEl.textContent = `#${this._currentLaserId}`;

        // Style laser
        set('lp-color', p.color);
        set('lp-count', p.count);         setVal('lp-count-val', Math.round(p.count));
        set('lp-beamWidth', p.beamWidth); setVal('lp-beamWidth-val', p.beamWidth.toFixed(2));
        set('lp-spread', p.spread);       setVal('lp-spread-val', p.spread.toFixed(1));
        set('lp-angle', p.angle);         setVal('lp-angle-val', `${Math.round(p.angle)}°`);
        set('lp-masterPower', p.masterPower); setVal('lp-masterPower-val', p.masterPower.toFixed(2));
        set('lp-beamPower', p.beamPower); setVal('lp-beamPower-val', p.beamPower.toFixed(2));
        set('lp-panPower', p.panPower);   setVal('lp-panPower-val', p.panPower.toFixed(2));
        setCheck('lp-laserPan', p.laserPan);
        set('lp-patternShape', p.patternShape);
        set('lp-curveAmplitude', p.curveAmplitude); setVal('lp-curveAmplitude-val', p.curveAmplitude.toFixed(2));

        // Clignotement
        setCheck('lp-strobe', p.strobe);
        set('lp-strobeSpeed', p.strobeSpeed); setVal('lp-strobeSpeed-val', p.strobeSpeed.toFixed(1));

        // Tweaking visuel
        set('lp-sourceEmissionPower', p.sourceEmissionPower); setVal('lp-sourceEmissionPower-val', p.sourceEmissionPower.toFixed(2));
        set('lp-sourceGlowRadius', p.sourceGlowRadius); setVal('lp-sourceGlowRadius-val', p.sourceGlowRadius.toFixed(2));
        set('lp-glowIntensity', p.glowIntensity); setVal('lp-glowIntensity-val', p.glowIntensity.toFixed(2));
        set('lp-glowScattering', p.glowScattering); setVal('lp-glowScattering-val', p.glowScattering.toFixed(2));
        set('lp-fogDensity', p.fogDensity); setVal('lp-fogDensity-val', p.fogDensity.toFixed(3));
        set('lp-giIntensity', p.giIntensity); setVal('lp-giIntensity-val', p.giIntensity.toFixed(2));
        set('lp-giDistance', p.giDistance); setVal('lp-giDistance-val', p.giDistance.toFixed(1));

        // Position
        set('lp-pos-x', pos.x.toFixed(1)); setVal('lp-pos-x-val', pos.x.toFixed(1));
        set('lp-pos-y', pos.y.toFixed(1)); setVal('lp-pos-y-val', pos.y.toFixed(1));
        set('lp-pos-z', pos.z.toFixed(1)); setVal('lp-pos-z-val', pos.z.toFixed(1));
    }
}
