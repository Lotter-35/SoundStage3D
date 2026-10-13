/**
 * GpuPassTimer.js — Mesure du temps GPU de chaque passe de rendu (scène, faisceaux classiques, faisceaux
 * SS Depth, halo, brouillard, blooms, composition finale…), pour comparer les modes de rendu.
 *
 *   - requêtes de minuterie (EXT_disjoint_timer_query_webgl2) lues quelques images plus tard (aucune attente) ;
 *   - sections SÉQUENTIELLES (begin / end, jamais imbriquées : WebGL n'autorise qu'une requête active) ;
 *   - sans l'extension : synchronisation (lecture d'un pixel d'une petite cible) autour de chaque section
 *     (mesure grossière, ralentit l'image) ;
 *   - moyenne par image sur une fenêtre de 0,5 s ; aucun coût quand la mesure est désactivée.
 *
 * La résolution dynamique (DynamicResolution) mesure toute l'image avec sa propre requête : elle est mise en
 * pause pendant la mesure par passe (les deux requêtes ne peuvent pas être actives en même temps).
 */

const WINDOW_MS = 500;
const MAX_PENDING = 256;

class GpuPassTimer {
    constructor() {
        this.gl = null;
        this.ext = null;
        this.enabled = false;
        this.mode = 'aucune';
        /** Dernières moyennes : [{ name, ms }] dans l'ordre de la première apparition, total (ms / image) */
        this.results = [];
        this.total = 0;
        this.frames = 0;
        this._sums = new Map();       // nom → somme des ms de la fenêtre
        this._order = [];
        this._cur = null;             // { q, name } (minuterie) ou { t0, name } (gl.finish)
        this._pending = [];           // { q, name }
        this._free = [];
        this._pool = [];
        this._windowStart = 0;
        this._framesInWindow = 0;
    }

    init(renderer) {
        this.gl = renderer.getContext();
        this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
        this.mode = this.ext ? 'minuterie GPU' : 'synchro CPU (approx.)';
    }

    /** Mesure par synchronisation CPU même si la minuterie GPU existe (tests en rendu logiciel) */
    forceSync() {
        this.ext = null;
        this.mode = 'synchro CPU (approx.)';
    }

    // Attend la fin de tout le travail GPU en cours : lecture d'un pixel d'une petite cible dédiée
    _sync() {
        const gl = this.gl;
        if (!this._syncFb) {
            this._syncTex = gl.createTexture();
            const prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
            gl.bindTexture(gl.TEXTURE_2D, this._syncTex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindTexture(gl.TEXTURE_2D, prevTex);
            this._syncFb = gl.createFramebuffer();
            this._syncPx = new Uint8Array(4);
            const prevR = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._syncFb);
            gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._syncTex, 0);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevR);
        }
        const prevR = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._syncFb);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._syncPx);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevR);
    }

    setEnabled(v) {
        this.enabled = Boolean(v) && Boolean(this.gl);
        if (this._cur) this.end();
        this._sums.clear();
        this._order.length = 0;
        this.results = [];
        this.total = 0;
        this._framesInWindow = 0;
        this._windowStart = performance.now();
    }

    _entry() {
        return this._pool.pop() || { q: null, name: '', t0: 0 };
    }

    /** Début d'une section (termine la précédente si elle est encore ouverte) */
    begin(name) {
        if (!this.enabled) return;
        if (this._cur) this.end();
        const e = this._entry();
        e.name = name;
        if (this.ext) {
            if (this._pending.length >= MAX_PENDING) { this._pool.push(e); return; }
            e.q = this._free.pop() || this.gl.createQuery();
            this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, e.q);
        } else {
            this._sync();
            e.t0 = performance.now();
        }
        this._cur = e;
    }

    end() {
        const e = this._cur;
        if (!e) return;
        this._cur = null;
        if (this.ext) {
            this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
            this._pending.push(e);
        } else {
            this._sync();
            this._add(e.name, performance.now() - e.t0);
            this._pool.push(e);
        }
    }

    _add(name, ms) {
        if (!this._sums.has(name)) { this._sums.set(name, 0); this._order.push(name); }
        this._sums.set(name, this._sums.get(name) + ms);
    }

    /** Une fois par image, après le rendu : lecture des requêtes prêtes, moyennes toutes les 0,5 s */
    frame(now) {
        if (!this.enabled) return;
        if (this._cur) this.end();
        const gl = this.gl;
        if (this.ext) {
            const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
            while (this._pending.length) {
                const e = this._pending[0];
                if (!gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) break;
                this._pending.shift();
                const ms = gl.getQueryParameter(e.q, gl.QUERY_RESULT) / 1e6;
                this._free.push(e.q);
                e.q = null;
                if (!disjoint) this._add(e.name, ms);
                this._pool.push(e);
            }
        }
        this._framesInWindow++;
        if (now - this._windowStart < WINDOW_MS) return;
        const n = Math.max(1, this._framesInWindow);
        const out = [];
        let total = 0;
        for (const name of this._order) {
            const ms = this._sums.get(name) / n;
            out.push({ name, ms });
            total += ms;
            this._sums.set(name, 0);
        }
        this.results = out;
        this.total = total;
        this.frames = n;
        this._framesInWindow = 0;
        this._windowStart = now;
    }
}

/** Instance unique (les passes l'importent directement) */
export const gpuPassTimer = new GpuPassTimer();
