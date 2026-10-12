/**
 * Laser2Patterns.js
 * ─────────────────────────────────────────────────────────────
 * Générateur interne de motifs : produit une IMAGE laser = suite de points (x, y ∈ [-1, 1],
 * niveau de couleur r g b ∈ [0, 1], 0 = masqué), exactement comme une image ILDA.
 *
 * Les images sont « optimisées » comme le fait un vrai logiciel laser :
 *   - points interpolés au pas choisi (densité)
 *   - points d'angle répétés dans les coins (sinon les galvos les arrondissent)
 *   - points de masquage au début / à la fin de chaque trait (laser éteint pendant que les
 *     miroirs sautent au trait suivant)
 * Ces réglages ont un effet VISIBLE : peu de points d'angle = coins arrondis, peu de points de
 * masquage = traînées de lumière entre deux traits.
 * ─────────────────────────────────────────────────────────────
 */

const TAU = Math.PI * 2;

export class LaserFrame {
    constructor(capacity = 256) {
        this.n = 0;
        this.cap = capacity;
        this.x = new Float32Array(capacity);
        this.y = new Float32Array(capacity);
        this.r = new Float32Array(capacity);
        this.g = new Float32Array(capacity);
        this.b = new Float32Array(capacity);
    }

    _grow() {
        this.cap *= 2;
        for (const k of ['x', 'y', 'r', 'g', 'b']) {
            const a = new Float32Array(this.cap);
            a.set(this[k]);
            this[k] = a;
        }
    }

    push(x, y, r, g, b) {
        if (this.n >= this.cap) this._grow();
        const i = this.n++;
        this.x[i] = x; this.y[i] = y; this.r[i] = r; this.g[i] = g; this.b[i] = b;
    }
}

/** Construction d'une image à partir de traits (moveTo / lineTo), avec optimisation laser */
class PathBuilder {
    constructor(frame, { step, corner, blank }) {
        this.f = frame;
        this.step = step;
        this.corner = corner;
        this.blank = blank;
        this.cx = 0; this.cy = 0;
        this.lit = false;       // un trait est en cours
        this.dx = 0; this.dy = 0; // direction du dernier segment
        this.sx = 0; this.sy = 0; // début du trait (fermeture)
        this.started = false;
        this.strokes = 0;
    }

    /** Fin du trait courant : points de masquage sur place (le faisceau s'éteint avant le saut) */
    _endStroke() {
        if (!this.lit) return;
        for (let i = 0; i < this.blank; i++) this.f.push(this.cx, this.cy, 0, 0, 0);
        this.lit = false;
    }

    moveTo(x, y) {
        this._endStroke();
        if (this.started) {
            // Saut masqué : quelques points intermédiaires (les miroirs ne sautent pas instantanément)
            this._blankTravel(x, y);
        } else {
            this.fx = x; this.fy = y;
        }
        this.started = true;
        this.strokes++;
        this.cx = x; this.cy = y;
        this.sx = x; this.sy = y;
        this.dx = 0; this.dy = 0;
    }

    /** Saut masqué : points intermédiaires selon la distance (les miroirs ne sautent pas instantanément) */
    _blankTravel(x, y) {
        const d = Math.hypot(x - this.cx, y - this.cy);
        const n = Math.min(40, Math.ceil(d / 0.06));
        for (let i = 1; i <= n; i++) {
            const t = i / (n + 1);
            this.f.push(this.cx + (x - this.cx) * t, this.cy + (y - this.cy) * t, 0, 0, 0);
        }
        for (let i = 0; i < this.blank; i++) this.f.push(x, y, 0, 0, 0);
    }

    /** Point allumé répété (faisceau fixe / point d'angle) */
    dwell(count, level = 1) {
        for (let i = 0; i < count; i++) this.f.push(this.cx, this.cy, level, level, level);
        this.lit = true;
    }

    /** Déplacement vers le point suivant : masqué (level = 0) ou allumé à un niveau réduit (nappe) */
    travel(x, y, level) {
        if (level <= 0.001) { this.moveTo(x, y); return; }
        const ex = x - this.cx, ey = y - this.cy;
        const d = Math.hypot(ex, ey);
        const n = Math.max(1, Math.ceil(d / this.step));
        for (let i = 1; i <= n; i++) this.f.push(this.cx + ex * i / n, this.cy + ey * i / n, level, level, level);
        this.cx = x; this.cy = y;
        this.dx = d > 1e-6 ? ex / d : 0; this.dy = d > 1e-6 ? ey / d : 0;
        this.lit = true;
    }

    lineTo(x, y) {
        const ex = x - this.cx, ey = y - this.cy;
        const d = Math.hypot(ex, ey);
        if (d < 1e-6) return;
        const ux = ex / d, uy = ey / d;
        // Coin : répétition du point si la direction change nettement
        if (!this.lit) this.dwell(Math.max(1, this.corner));
        else if (ux * this.dx + uy * this.dy < 0.94) this.dwell(this.corner);
        const n = Math.max(1, Math.ceil(d / this.step));
        for (let i = 1; i <= n; i++) {
            const t = i / n;
            this.f.push(this.cx + ex * t, this.cy + ey * t, 1, 1, 1);
        }
        this.cx = x; this.cy = y;
        this.dx = ux; this.dy = uy;
        this.lit = true;
    }

    /** Courbe fermée ou ouverte donnée par une fonction (pas adaptatif) */
    curve(fn, steps, closed) {
        const p0 = fn(0);
        this.moveTo(p0[0], p0[1]);
        if (!closed) this.dwell(Math.max(1, this.corner));
        this.curveTo(fn, steps);
        if (!closed) this.dwell(Math.max(1, this.corner));
    }

    /** Prolonge le trait courant le long d'une courbe (sans point d'arrêt) */
    curveTo(fn, steps) {
        for (let i = 1; i <= steps; i++) {
            const p = fn(i / steps);
            this.f.push(p[0], p[1], 1, 1, 1);
            this.cx = p[0]; this.cy = p[1];
        }
        this.lit = true;
    }

    polygon(pts) {
        this.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) this.lineTo(pts[i][0], pts[i][1]);
        this.lineTo(pts[0][0], pts[0][1]);
        this.dwell(this.corner);
    }

    /** Fin de l'image : saut masqué vers le premier point (l'image est redessinée en boucle) */
    finish() {
        // Un seul trait qui se referme sur lui-même (cercle, polygone, aller-retour) : il est
        // redessiné en boucle sans jamais s'éteindre
        if (this.strokes === 1 && Math.hypot(this.cx - this.fx, this.cy - this.fy) < 1e-4) return;
        this._endStroke();
        if (this.started) {
            this._blankTravel(this.fx, this.fy);
            this.cx = this.fx; this.cy = this.fy;
        }
    }
}

function regular(n, r, rot = -Math.PI / 2) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * TAU;
        out.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return out;
}

/** Pas d'interpolation (unités normalisées) selon la densité (%) */
export function stepFromDensity(density) {
    const d = Math.max(5, Math.min(100, density)) / 100;
    return 0.012 / d;
}

/** Nombre d'images des motifs animés */
export const ANIMATION_FRAMES = 32;
const ANIMATED = new Set(['Cercle pulsant', 'Vague défilante', 'Tunnel qui s\'ouvre', 'Éventail qui s\'ouvre', 'Faisceaux qui balaient', 'Étoile qui respire']);

export function isAnimatedPattern(name) {
    return ANIMATED.has(name);
}

/** Pseudo-aléatoire déterministe (positions des faisceaux dispersés, identiques chez tous) */
function rnd(i, k) {
    const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
    return s - Math.floor(s);
}

function star(inner, rot = 0) {
    const pts = [];
    for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + rot + (i / 10) * TAU;
        const r = i % 2 === 0 ? 1 : inner;
        pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    return pts;
}

/** Éventail de n faisceaux entre -w et +w (fanBlend : trajet allumé entre les faisceaux → nappe) */
function fan(b, p, n, w, y = 0, offset = 0) {
    const dw = Math.max(1, Math.round(p.beamDwell));
    const blend = Math.max(0, Math.min(1, p.fanBlend / 100));
    for (let i = 0; i < n; i++) {
        const x = (n === 1 ? 0 : -w + (2 * w * i) / (n - 1)) + offset;
        if (i === 0) b.moveTo(x, y); else b.travel(x, y, blend);
        b.dwell(dw);
    }
}

/**
 * Dessine un motif dans le constructeur de trait.
 * @param {number} phase 0…1 (image d'une animation)
 */
function drawPattern(b, p, name, phase) {
    const n = Math.max(1, Math.round(p.beamCount));
    const w = Math.max(0, Math.min(1, p.fanSpread / 100));
    const circleSteps = (r) => Math.max(8, Math.ceil((TAU * Math.max(0.05, r)) / b.step));
    const circle = (r, cx = 0, cy = 0) => b.curve((t) => [cx + Math.cos(t * TAU) * r, cy + Math.sin(t * TAU) * r], circleSteps(r), true);
    switch (name) {
        // ── Faisceaux ──
        case 'Faisceaux (éventail)':
            fan(b, p, n, w);
            break;
        case 'Point fixe':
            b.moveTo(0, 0);
            b.dwell(Math.max(4, Math.round(p.beamDwell)));
            break;
        case 'Faisceaux en cercle': {
            const dw = Math.max(1, Math.round(p.beamDwell));
            const blend = Math.max(0, Math.min(1, p.fanBlend / 100));
            for (let i = 0; i < n; i++) {
                const a = (i / n) * TAU;
                const x = Math.cos(a) * w, y = Math.sin(a) * w;
                if (i === 0) b.moveTo(x, y); else b.travel(x, y, blend);
                b.dwell(dw);
            }
            break;
        }
        case 'Double éventail':
            fan(b, p, n, w, 0.45);
            fan(b, p, n, w, -0.45);
            break;
        case 'Faisceaux en croix': {
            fan(b, p, n, w);
            const dw = Math.max(1, Math.round(p.beamDwell));
            for (let i = 0; i < n; i++) {
                const y = n === 1 ? 0 : -w + (2 * w * i) / (n - 1);
                b.moveTo(0, y);
                b.dwell(dw);
            }
            break;
        }
        case 'Faisceaux dispersés': {
            const dw = Math.max(1, Math.round(p.beamDwell));
            for (let i = 0; i < n; i++) {
                b.moveTo((rnd(i, 1) * 2 - 1) * w, (rnd(i, 2) * 2 - 1) * w);
                b.dwell(dw);
            }
            break;
        }
        // ── Nappes & tunnels ──
        case 'Nappe (ligne)':
            b.moveTo(-w, 0);
            b.lineTo(w, 0);
            b.lineTo(-w, 0);
            break;
        case 'Nappe + faisceaux': {
            const m = Math.max(2, n);
            const dw = Math.max(1, Math.round(p.beamDwell));
            b.moveTo(-w, 0);
            b.dwell(dw);
            for (let i = 1; i < m; i++) { b.lineTo(-w + (2 * w * i) / (m - 1), 0); b.dwell(dw); }
            for (let i = m - 2; i >= 0; i--) { b.lineTo(-w + (2 * w * i) / (m - 1), 0); b.dwell(dw); }
            break;
        }
        case 'Nappe verticale':
            b.moveTo(0, -w);
            b.lineTo(0, w);
            b.lineTo(0, -w);
            break;
        case 'Cercle (cône)':
            circle(1);
            break;
        case 'Double cercle':
            circle(1);
            circle(0.5);
            break;
        case 'Nappe en V':
            b.moveTo(-w, 1);
            b.lineTo(0, -1);
            b.lineTo(w, 1);
            b.lineTo(0, -1);
            b.lineTo(-w, 1);
            break;
        case 'Nappe en croix':
            b.moveTo(-w, 0); b.lineTo(w, 0); b.lineTo(-w, 0);
            b.moveTo(0, -w); b.lineTo(0, w); b.lineTo(0, -w);
            break;
        // ── Graphiques ──
        case 'Mire ILDA':
            // Mire de réglage : carré, cercle inscrit (doit toucher le carré à la vitesse nominale),
            // croix centrale. Plus vite que les scanners → le cercle rétrécit, les coins s'arrondissent.
            b.polygon([[-1, -1], [1, -1], [1, 1], [-1, 1]]);
            circle(1);
            b.moveTo(-0.25, 0); b.lineTo(0.25, 0);
            b.moveTo(0, -0.25); b.lineTo(0, 0.25);
            break;
        case 'Carré':
            b.polygon([[-1, -1], [1, -1], [1, 1], [-1, 1]]);
            break;
        case 'Triangle':
            b.polygon(regular(3, 1));
            break;
        case 'Étoile':
            b.polygon(star(0.42));
            break;
        case 'Losange':
            b.polygon([[0, 1], [0.65, 0], [0, -1], [-0.65, 0]]);
            break;
        case 'Cœur':
            b.curve((t) => {
                const a = t * TAU;
                const x = 16 * Math.pow(Math.sin(a), 3);
                const y = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
                return [x / 17, y / 17 + 0.1];
            }, circleSteps(1.2), true);
            break;
        case 'Spirale': {
            const turns = 4;
            b.curve((t) => [Math.cos(t * TAU * turns) * t, Math.sin(t * TAU * turns) * t], Math.ceil(turns * TAU * 0.55 / b.step), false);
            break;
        }
        case 'Sinusoïde': {
            // Aller sur la sinusoïde, retour sur la sinusoïde décalée : un seul trait fermé
            const steps = Math.ceil(4.2 / b.step);
            b.curve((t) => [-1 + 2 * t, Math.sin(t * TAU * 2) * 0.6], steps, false);
            b.curveTo((t) => [1 - 2 * t, -Math.sin((1 - t) * TAU * 2) * 0.6], steps);
            b.dwell(Math.max(1, b.corner));
            break;
        }
        case 'Zigzag': {
            const k = 8;
            b.moveTo(-1, -0.5);
            for (let i = 1; i <= k; i++) b.lineTo(-1 + (2 * i) / k, i % 2 ? 0.5 : -0.5);
            for (let i = k - 1; i >= 0; i--) b.lineTo(-1 + (2 * i) / k, i % 2 ? 0.5 : -0.5);
            break;
        }
        // ── Animations (phase 0…1) ──
        case 'Cercle pulsant':
            circle(0.3 + 0.7 * (0.5 - 0.5 * Math.cos(phase * TAU)));
            break;
        case 'Vague défilante': {
            const steps = Math.ceil(4.2 / b.step);
            const ph = phase * TAU;
            b.curve((t) => [-1 + 2 * t, Math.sin(t * TAU * 2 - ph) * 0.5], steps, false);
            b.curveTo((t) => [1 - 2 * t, Math.sin((1 - t) * TAU * 2 - ph) * 0.5], steps);
            break;
        }
        case 'Tunnel qui s\'ouvre':
            circle(0.05 + 0.95 * phase);
            break;
        case 'Éventail qui s\'ouvre':
            fan(b, p, n, w * (0.5 - 0.5 * Math.cos(phase * TAU)));
            break;
        case 'Faisceaux qui balaient':
            fan(b, p, n, w * 0.5, 0, Math.sin(phase * TAU) * 0.5);
            break;
        case 'Étoile qui respire':
            b.polygon(star(0.25 + 0.5 * (0.5 - 0.5 * Math.cos(phase * TAU))));
            break;
        default:
            b.moveTo(0, 0);
            b.dwell(8);
    }
}

function buildOne(p, name, frame, phase) {
    frame.n = 0;
    const b = new PathBuilder(frame, {
        step: stepFromDensity(p.density),
        corner: Math.round(p.cornerPoints),
        blank: Math.round(p.blankPoints),
    });
    drawPattern(b, p, name, phase);
    b.finish();
    if (frame.n === 0) frame.push(0, 0, 0, 0, 0);
    return frame;
}

/**
 * Construit l'image d'un motif interne (première image s'il est animé).
 * @param {object} p paramètres du laser
 * @param {LaserFrame} frame image à remplir (réutilisée)
 */
export function buildPatternFrame(p, frame) {
    return buildOne(p, p.pattern, frame, 0);
}

/**
 * Images d'un motif interne : une seule, ou ANIMATION_FRAMES pour un motif animé.
 * @param {LaserFrame[]} pool images réutilisées (complétée si besoin)
 * @returns {LaserFrame[]}
 */
export function buildPatternFrames(p, pool) {
    const count = isAnimatedPattern(p.pattern) ? ANIMATION_FRAMES : 1;
    while (pool.length < count) pool.push(new LaserFrame(256));
    for (let i = 0; i < count; i++) buildOne(p, p.pattern, pool[i], i / count);
    return pool.slice(0, count);
}
