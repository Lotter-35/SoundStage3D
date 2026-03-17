/**
 * DSP Defaults — Single source of truth for all slider/audio default values.
 *
 * Edit this file to change the initial state of every DSP parameter.
 * Values here drive both the UI sliders AND the audio engine on startup.
 *
 * Each bus (sub, mid, top, fill, master) has its own independent defaults.
 * Slider min/max/step remain in the HTML — only the *value* is managed here.
 */

export const DSP_DEFAULTS = {

    // ─── SUB ──────────────────────────────────────────────────────────
    sub: {
        'xover-freq':      90,      // Hz — crossover LP frequency
        'comp-threshold':  -24,     // dB
        'comp-knee':        30,     // dB
        'comp-ratio':        4,     // :1
        'comp-attack':       3,     // ms  (audio node receives /1000)
        'comp-release':    250,     // ms  (audio node receives /1000)
        'sat-drive':        50,     // %
        'sat-mix':         100,     // %
        'prox-far':        4.0,     // m — proximity saturation start distance
        'prox-near':       2.0,     // m — proximity saturation full distance
        'prox-drive':       75,     // % — max proximity saturation drive
        'bus-volume':      100,     // %  (audio node receives /100)
        'dist-k':           60,     // ×0.001 → actual coefficient
        'refl-gain':        20,     // ×0.01 → actual gain
        'refl-lpf':       1500,     // Hz
        'lim-threshold':    -3,     // dB
    },

    // ─── MID ──────────────────────────────────────────────────────────
    mid: {
        'xover-low':        90,     // Hz — crossover HP frequency (SUB↔MID)
        'xover-high':     2000,     // Hz — crossover LP frequency (MID↔TOP)
        'comp-threshold':  -24,     // dB
        'comp-knee':        30,     // dB
        'comp-ratio':        4,     // :1
        'comp-attack':       3,     // ms
        'comp-release':    250,     // ms
        'sat-drive':        50,     // %
        'sat-mix':         100,     // %
        'bus-volume':      100,     // %
        'dist-k':           60,     // ×0.001
        'refl-gain':        20,     // ×0.01
        'refl-lpf':       1500,     // Hz
        'lim-threshold':    -3,     // dB
    },

    // ─── TOP ──────────────────────────────────────────────────────────
    top: {
        'xover-freq':     2000,     // Hz — crossover HP frequency (MID↔TOP)
        'comp-threshold':  -24,     // dB
        'comp-knee':        30,     // dB
        'comp-ratio':        4,     // :1
        'comp-attack':       3,     // ms
        'comp-release':    250,     // ms
        'sat-drive':        50,     // %
        'sat-mix':         100,     // %
        'bus-volume':      100,     // %
        'dist-k':           60,     // ×0.001
        'refl-gain':        20,     // ×0.01
        'refl-lpf':       1500,     // Hz
        'lim-threshold':    -3,     // dB
    },

    // ─── FILL ─────────────────────────────────────────────────────────
    fill: {
        'merge-gain':       50,     // ×0.01 → source merge level
        'bus-volume':       20,     // %
        'dist-k':           60,     // ×0.001
        'refl-gain':        20,     // ×0.01
        'refl-lpf':       1500,     // Hz
        'lim-threshold':    -3,     // dB
    },

    // ─── MASTER GLOBAL ────────────────────────────────────────────────
    master: {
        'air-abs':          40,     // Hz/m — air absorption coefficient
        'treble':            0,     // dB — high-shelf boost
        'reverb':            0,     // % — reverb wet level
        'local-volume':    100,     // % — local output volume
        'mouse-sensitivity':100,    // % — mouse sensitivity multiplier
    },
};
