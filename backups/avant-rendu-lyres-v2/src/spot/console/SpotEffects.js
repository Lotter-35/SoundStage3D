/**
 * SpotEffects.js
 * ─────────────────────────────────────────────────────────────
 * Moteur d'effets des lyres (comme le « FX engine » d'une console lumière) :
 *   - un effet = forme d'onde appliquée à une liste ORDONNÉE de lyres
 *   - décalage : la lyre n°i démarre `i × décalage` secondes après la première
 *     (ou décalage réparti sur un cycle complet → vague continue)
 *   - l'effet s'AJOUTE à la position / au dimmer de base (on peut viser un point
 *     puis balayer autour), sans modifier les paramètres des lyres
 *   - entrée et sortie en fondu (les moteurs gardent leur inertie)
 *
 * Multijoueur : seule la DÉFINITION de l'effet circule sur le réseau (type, réglages,
 * lyres, instant de départ sur l'horloge commune) ; chaque joueur calcule le même
 * mouvement au même instant → aucun flux continu de positions.
 * ─────────────────────────────────────────────────────────────
 */

export const FX_TYPES = {
    panSweep:   { label: '↔ Balayage Pan',  ampLabel: 'Amplitude (°)', amp: { min: 5, max: 180, step: 1, value: 60 } },
    tiltSweep:  { label: '↕ Balayage Tilt', ampLabel: 'Amplitude (°)', amp: { min: 5, max: 120, step: 1, value: 30 } },
    circle:     { label: '◯ Cercle',        ampLabel: 'Rayon (°)',     amp: { min: 3, max: 90, step: 1, value: 20 } },
    dimmerWave: { label: '〰 Vague dimmer', ampLabel: 'Profondeur (%)', amp: { min: 10, max: 100, step: 1, value: 100 } },
    colorChase: { label: '🌈 Chenillard couleur', ampLabel: 'Saturation (%)', amp: { min: 10, max: 100, step: 1, value: 100 } },
};

export const FX_ORDERS = [
    'Gauche → droite', 'Droite → gauche', 'Centre → extérieur', 'Extérieur → centre', 'Ordre de sélection', 'Aléatoire',
];

const FADE_IN = 0.5;   // s
const FADE_OUT = 0.7;  // s
const TAU = Math.PI * 2;

function hueToHex(h, s) {
    // HSV (v = 1) → #rrggbb
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = 1 - s, q = 1 - s * f, t = 1 - s * (1 - f);
    let r, g, b;
    switch (((i % 6) + 6) % 6) {
        case 0: r = 1; g = t; b = p; break;
        case 1: r = q; g = 1; b = p; break;
        case 2: r = p; g = 1; b = t; break;
        case 3: r = p; g = q; b = 1; break;
        case 4: r = t; g = p; b = 1; break;
        default: r = 1; g = p; b = q;
    }
    const to = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return '#' + to(r) + to(g) + to(b);
}

export class SpotEffects {
    constructor() {
        /** @type {Map<string, object>} définition + état local (fondu de sortie) */
        this.effects = new Map();
        this._listeners = [];
    }

    onChange(cb) {
        this._listeners.push(cb);
    }

    _changed() {
        for (const cb of this._listeners) {
            try { cb(); } catch (e) { console.error('[SpotEffects]', e); }
        }
    }

    /**
     * @param {{ id, type, ids: string[], amp, speed, offset, spread, start }} def
     */
    start(def) {
        if (!def || !def.id || !FX_TYPES[def.type]) return;
        this.effects.set(def.id, { ...def, stopAt: null });
        this._changed();
    }

    stop(id) {
        const fx = this.effects.get(id);
        if (fx && fx.stopAt === null) {
            fx.stopAt = -1; // horodaté à la prochaine application
            this._changed();
        }
    }

    stopAll() {
        for (const id of this.effects.keys()) this.stop(id);
    }

    /** Remplace tous les effets (état complet reçu du serveur) */
    setAll(defs) {
        this.effects.clear();
        for (const def of Object.values(defs || {})) {
            if (def && def.id && FX_TYPES[def.type]) this.effects.set(def.id, { ...def, stopAt: null });
        }
        this._changed();
    }

    /** Effets en cours (hors ceux qui s'éteignent) */
    list() {
        return Array.from(this.effects.values()).filter(fx => fx.stopAt === null);
    }

    /**
     * Calcule la contribution des effets sur chaque lyre (fixture.fx).
     * @param {Map<string, import('../SpotFixture.js').SpotFixture>} spots
     * @param {number} now horloge commune (s)
     */
    apply(spots, now) {
        for (const f of spots.values()) {
            const fx = f.fx;
            fx.pan = 0; fx.tilt = 0; fx.dim = 1; fx.color = null;
        }
        if (this.effects.size === 0) return;

        let removed = false;
        for (const [key, e] of this.effects) {
            if (e.stopAt === -1) e.stopAt = now;
            let wEnd = 1;
            if (e.stopAt !== null) {
                wEnd = 1 - (now - e.stopAt) / FADE_OUT;
                if (wEnd <= 0) {
                    this.effects.delete(key);
                    removed = true;
                    continue;
                }
            }
            const n = e.ids.length;
            const speed = Math.max(0.01, e.speed);
            // Répartir sur un cycle : la dernière lyre est décalée d'un tour complet → vague continue
            const step = e.spread ? 1 / (speed * Math.max(1, n)) : e.offset;
            for (let i = 0; i < n; i++) {
                const f = spots.get(e.ids[i]);
                if (!f || f.dmxControlled) continue; // la régie DMX a la priorité
                const local = now - e.start - i * step;
                if (local <= 0) continue; // cette lyre n'a pas encore démarré
                const w = Math.min(1, local / FADE_IN) * wEnd;
                const ph = TAU * speed * local;
                const fx = f.fx;
                switch (e.type) {
                    case 'panSweep':
                        fx.pan += w * e.amp * Math.sin(ph);
                        break;
                    case 'tiltSweep':
                        fx.tilt += w * e.amp * Math.sin(ph);
                        break;
                    case 'circle':
                        fx.pan += w * e.amp * Math.sin(ph);
                        fx.tilt += w * e.amp * Math.cos(ph);
                        break;
                    case 'dimmerWave':
                        fx.dim *= 1 - w * (e.amp / 100) * (0.5 - 0.5 * Math.cos(ph));
                        break;
                    case 'colorChase':
                        if (w > 0.5) fx.color = hueToHex(((speed * local) % 1 + 1) % 1, e.amp / 100);
                        break;
                }
            }
        }
        if (removed) this._changed();
    }
}
