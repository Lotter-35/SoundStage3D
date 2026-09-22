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

    // ─── INPUT (Étage d'Entrée) ───────────────────────────────────────
    input: {
        'auto-gain':         true,   // Normalisation LUFS activée par défaut
        'target-lufs':       -14,    // dB LUFS (-14 standard streaming, -23 standard broadcast)
        'input-trim':        100,    // % (0% - 200%)
        'eq-low':              0,    // dB (-12 à +12, low-shelf 100Hz)
        'eq-mid':              0,    // dB (-12 à +12, peaking 1kHz)
        'eq-high':             0,    // dB (-12 à +12, high-shelf 6kHz)
        'comp-enabled':    false,    // Compresseur optionnel (désactivé par défaut)
        'comp-threshold':    -18,    // dB
        'comp-knee':          12,    // dB
        'comp-ratio':          3,    // :1
        'comp-attack':        10,    // ms
        'comp-release':      150,    // ms
        'limiter-ceiling':  -0.1,    // dBFS (plafond brickwall)
    },

    // ─── SUB ──────────────────────────────────────────────────────────
    sub: {
        'xover-freq':      90,      // Hz — crossover LP frequency
        'comp-threshold':  -24,     // dB
        'comp-knee':        30,     // dB
        'comp-ratio':        4,     // :1
        'comp-attack':       3,     // ms  (audio node receives /1000)
        'comp-release':    250,     // ms  (audio node receives /1000)
        'sat-drive':       100,     // %
        'sat-mix':         100,     // %
        'prox-far':        4.0,     // m — proximity saturation start distance
        'prox-near':       2.0,     // m — proximity saturation full distance
        'prox-drive':       75,     // % — max proximity saturation drive
        'bus-volume':      100,     // %  (audio node receives /100)
        'dist-k':            8,     // ×0.001 → actual coefficient
        'refl-gain':        20,     // ×0.01 → actual gain
        'refl-lpf':       1500,     // Hz
        'lim-threshold':    -3,     // dB
        'energy-limit':      7,     // Subs effectifs (1 à 7) — 7 = aucune limite, 1 = comme 1 seul sub
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

    // ─── MASTER OUT STAGE ─────────────────────────────────────────────
    master: {
        // Étape 1 : EQ Global Festival (4 bandes paramétriques)
        'eq-low':            0,     // dB (-12 à +12) — Low Shelf 80 Hz
        'eq-mid-low':        0,     // dB (-12 à +12) — Peaking 400 Hz
        'eq-mid-high':       0,     // dB (-12 à +12) — Peaking 2500 Hz
        'eq-high':           0,     // dB (-12 à +12) — High Shelf 10000 Hz

        // Étape 2 : Compresseur de Bus ("Glue Compressor")
        'comp-enabled':   false,    // boolean — bypass par défaut
        'comp-threshold':   -12,    // dB (-40 à 0)
        'comp-ratio':       2.0,    // :1 (1 à 20)
        'comp-attack':       30,    // ms (0.1 à 100)
        'comp-release':     100,    // ms (10 à 1000)
        'comp-makeup':        0,    // dB (-6 à +18)

        // Étape 3 : Limiteur de Sortie Final (True Peak / Brickwall)
        'limiter-enabled': true,    // boolean — actif par défaut
        'limiter-threshold': -0.1,  // dBFS (-12 à 0)
        'limiter-attack':   0.5,    // ms (0.1 à 10)
        'limiter-release':   50,    // ms (10 à 500)
    },

    // ─── ENVIRONNEMENT ACOUSTIQUE ─────────────────────────────────────
    env: {
        'air-abs':           40,    // Hz/m — coefficient d'absorption de l'air
        'treble':             0,    // dB — brillance générale
        'reverb-wet':         0,    // % (0 à 100) — niveau wet
        'reverb-decay':     2.5,    // s (0.5 à 8.0) — durée de queue
        'reverb-damping':  6000,    // Hz (1000 à 18000) — amortissement HF
        'reverb-predelay':   10,    // ms (0 à 100) — pré-délai
    },

    // ─── CONTRÔLES UTILISATEUR ────────────────────────────────────────
    user: {
        'local-volume':     100,    // % (0 à 1000) — écoute locale
        'mouse-sensitivity':100,    // % (10 à 300) — sensibilité souris
        'invert-y':        false,   // boolean — axe vertical
        'invert-x':        false,   // boolean — axe horizontal
        'grass-enabled':   false,   // boolean — rendu herbe 3D
    },
};
