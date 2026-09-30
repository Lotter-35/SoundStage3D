/**
 * DynamicResolution.js — Résolution dynamique : l'échelle de rendu baisse par paliers quand la carte
 * graphique dépasse le budget d'une image, et remonte quand elle a de la marge.
 *
 *   - temps GPU de chaque image mesuré par requêtes de minuterie (EXT_disjoint_timer_query_webgl2),
 *     lues quelques images plus tard (aucune attente) ; sans l'extension, la résolution ne bouge pas ;
 *   - cible : pourcentage réglable de la fréquence de l'écran, estimée sur les images les plus rapides
 *     et remise à zéro quand la fenêtre change d'écran ;
 *   - paliers de 100 % à 67 % de l'échelle de rendu choisie (qui reste le plafond) ; baisse d'autant de
 *     paliers que nécessaire, remontée d'un palier à la fois quand le palier du dessus tient dans le budget ;
 *   - décision sur la médiane des mesures depuis le dernier changement (un pic isolé ne compte pas) ;
 *   - au moins 1 s entre deux changements, 3 s pour remonter ; une remontée suivie d'une baisse double
 *     le délai de remontée (jusqu'à 30 s) : l'image ne « pompe » pas autour du seuil.
 */

const STEPS = [1, 0.92, 0.84, 0.76, 0.67];
const HEADROOM = 0.9;          // budget = 90 % de la durée d'une image (marge pour le navigateur)
const UP_MARGIN = 0.8;         // remontée seulement si le palier du dessus tient dans 80 % du budget
const DOWN_DELAY_MS = 1000;
const UP_DELAY_MS = 3000;
const MAX_UP_DELAY_MS = 30000;
const BOUNCE_MS = 10000;       // baisse moins de 10 s après une remontée = va-et-vient
const MIN_SAMPLES = 20;        // mesures depuis le dernier changement avant de décider
const WINDOW = 31;
const DOWN_BAN_MS = 30000;     // après une baisse inutile             // mesures gardées pour la médiane
const REFRESH_RATES = [50, 60, 75, 90, 100, 120, 144, 165, 170, 180, 200, 240];

export class DynamicResolution {
    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {(factor: number) => void} apply applique la fraction de l'échelle de rendu
     */
    constructor(renderer, apply) {
        this.gl = renderer.getContext();
        this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
        this.apply = apply;
        this.enabled = false;
        this.targetPercent = 100; // FPS visés, en % de la fréquence de l'écran
        this._screenKey = '';
        this._lastScreenCheck = 0;
        this.level = 0;
        this.gpuMs = 0;        // médiane récente du temps GPU d'une image
        this._window = [];
        this._sorted = [];
        this._upDelay = UP_DELAY_MS;
        this._lastUp = -Infinity;
        this.refreshHz = 60;
        this._pending = [];
        this._free = [];
        this._active = null;
        this._samples = 0;
        this._lastChange = 0;
        this._lastFrame = 0;
        this._intervals = new Float32Array(240);
        this._intervalCount = 0;
        this._intervalPos = 0;
        this._lastRefreshEstimate = 0;
    }

    get available() { return Boolean(this.ext); }
    get factor() { return STEPS[this.level]; }
    get targetHz() { return this.refreshHz * this.targetPercent / 100; }

    /** @param {number} pct FPS visés en % de la fréquence de l'écran */
    setTargetPercent(pct) {
        this.targetPercent = pct;
        this._downBan = null;
        this._reset();
    }

    /** @param {boolean} enabled */
    setEnabled(enabled) {
        this.enabled = Boolean(enabled);
        this._downFrom = null;
        this._downBan = null;
        this._reset();
        if (!this.enabled && this.level !== 0) this._setLevel(0, performance.now());
    }

    /** À appeler juste avant le rendu de l'image */
    begin() {
        if (!this.enabled || !this.ext || this._active) return;
        const q = this._free.pop() || this.gl.createQuery();
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
        this._active = q;
    }

    /** À appeler juste après le rendu de l'image */
    end() {
        if (!this._active) return;
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        this._pending.push(this._active);
        this._active = null;
    }

    /** Une fois par image : lecture des mesures prêtes, estimation de la fréquence de l'écran, décision */
    update(now) {
        this._trackRefresh(now);
        if (!this.enabled || !this.ext) return;
        const gl = this.gl;
        const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
        while (this._pending.length) {
            const q = this._pending[0];
            if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
            this._pending.shift();
            const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
            this._free.push(q);
            if (disjoint || !(ms > 0)) continue;
            this._window.push(ms);
            if (this._window.length > WINDOW) this._window.shift();
            this._samples++;
        }
        // Mesures en retard (image non terminée) : on n'accumule pas de requêtes
        if (this._pending.length > 8) this._free.push(...this._pending.splice(0, this._pending.length - 8));
        this._decide(now);
    }

    _decide(now) {
        if (this._samples < MIN_SAMPLES) return;
        const sorted = this._sorted;
        sorted.length = 0;
        for (const v of this._window) sorted.push(v);
        sorted.sort((a, b) => a - b);
        this.gpuMs = sorted[sorted.length >> 1];
        const budget = (1000 / this.targetHz) * HEADROOM;
        const since = now - this._lastChange;
        const f = STEPS[this.level];
        // Baisse inutile : la mesure n'a presque pas bougé → la limite n'est pas le nombre de pixels
        // (temps CPU du rendu, compté dans la minuterie). Retour à la résolution d'avant, plus de baisse
        // tant que la mesure ne dépasse pas nettement celle qui l'avait déclenchée.
        if (this._downFrom && this.gpuMs > this._downFrom.ms * 0.9) {
            this._downBan = { until: now + DOWN_BAN_MS, ms: this._downFrom.ms * 1.15 };
            const back = this._downFrom.level;
            this._downFrom = null;
            this._setLevel(back, now);
            return;
        }
        this._downFrom = null;
        const banned = this._downBan && now < this._downBan.until && this.gpuMs < this._downBan.ms;
        if (this.gpuMs > budget && !banned && since >= DOWN_DELAY_MS && this.level < STEPS.length - 1) {
            // Coût ≈ proportionnel au nombre de pixels : palier qui ramène la mesure dans le budget
            const want = f * Math.sqrt(budget / this.gpuMs);
            let level = this.level + 1;
            while (level < STEPS.length - 1 && STEPS[level] > want) level++;
            if (now - this._lastUp < BOUNCE_MS) this._upDelay = Math.min(MAX_UP_DELAY_MS, this._upDelay * 2);
            const from = { level: this.level, ms: this.gpuMs };
            this._setLevel(level, now);
            this._downFrom = from;
        } else if (this.level > 0 && since >= this._upDelay) {
            const up = STEPS[this.level - 1];
            // Une partie du temps ne dépend pas des pixels (ombres, CPU) : on n'en compte que les 2/3
            const predicted = this.gpuMs * (1 / 3 + (2 / 3) * (up * up) / (f * f));
            if (predicted < budget * UP_MARGIN) {
                this._lastUp = now;
                this._setLevel(this.level - 1, now);
            }
        }
        // Longtemps sans baisse : délai de remontée normal
        if (since > MAX_UP_DELAY_MS * 2) this._upDelay = UP_DELAY_MS;
    }

    _setLevel(level, now) {
        this.level = level;
        this._lastChange = now;
        this._reset();
        this.apply(STEPS[level]);
    }

    _reset() {
        this._samples = 0;
        this._window.length = 0;
        // Les mesures en cours concernent l'ancienne résolution : ignorées
        this._free.push(...this._pending);
        this._pending.length = 0;
    }

    /** Fréquence de l'écran : les 10 % d'images les plus rapides suivent la synchro verticale */
    _trackRefresh(now) {
        // Fenêtre passée sur un autre écran : on repart de zéro (nouvelle fréquence en ~1 s)
        if (now - this._lastScreenCheck > 500) {
            this._lastScreenCheck = now;
            const sc = window.screen || {};
            const key = `${sc.availLeft ?? ''},${sc.availTop ?? ''},${sc.width}x${sc.height},${window.devicePixelRatio}`;
            if (key !== this._screenKey) {
                const first = this._screenKey === '';
                this._screenKey = key;
                if (!first) {
                    this._intervalCount = 0;
                    this._intervalPos = 0;
                    this._lastRefreshEstimate = 0;
                    this._reset();
                }
            }
        }
        const dt = this._lastFrame ? now - this._lastFrame : 0;
        this._lastFrame = now;
        if (dt > 0 && dt < 100) {
            this._intervals[this._intervalPos] = dt;
            this._intervalPos = (this._intervalPos + 1) % this._intervals.length;
            this._intervalCount = Math.min(this._intervals.length, this._intervalCount + 1);
        }
        if (this._intervalCount < 60 || now - this._lastRefreshEstimate < 1000) return;
        this._lastRefreshEstimate = now;
        const sorted = Array.from(this._intervals.subarray(0, this._intervalCount)).sort((a, b) => a - b);
        const hz = 1000 / sorted[Math.floor(sorted.length * 0.1)];
        let best = REFRESH_RATES[0];
        for (const r of REFRESH_RATES) if (Math.abs(r - hz) < Math.abs(best - hz)) best = r;
        const hzNew = Math.abs(best - hz) / best < 0.06 ? best : Math.round(hz);
        if (hzNew !== this.refreshHz) {
            this.refreshHz = hzNew;
            this._reset();
        }
    }
}
