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
    dwell(count) {
        for (let i = 0; i < count; i++) this.f.push(this.cx, this.cy, 1, 1, 1);
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

/**
 * Construit l'image d'un motif interne.
 * @param {object} p paramètres du laser
 * @param {LaserFrame} frame image à remplir (réutilisée)
 */
export function buildPatternFrame(p, frame) {
    frame.n = 0;
    const b = new PathBuilder(frame, {
        step: stepFromDensity(p.density),
        corner: Math.round(p.cornerPoints),
        blank: Math.round(p.blankPoints),
    });
    const circleSteps = (r) => Math.max(8, Math.ceil((TAU * r) / b.step));

    switch (p.pattern) {
        case 'Mire ILDA': {
            // Mire de réglage : carré, cercle inscrit (doit toucher le carré à la vitesse nominale),
            // croix centrale. Plus vite que les scanners → le cercle rétrécit, les coins s'arrondissent.
            b.polygon([[-1, -1], [1, -1], [1, 1], [-1, 1]]);
            b.curve((t) => [Math.cos(t * TAU), Math.sin(t * TAU)], circleSteps(1), true);
            b.moveTo(-0.25, 0); b.lineTo(0.25, 0);
            b.moveTo(0, -0.25); b.lineTo(0, 0.25);
            break;
        }
        case 'Faisceaux (éventail)': {
            const n = Math.max(1, Math.round(p.beamCount));
            for (let i = 0; i < n; i++) {
                const x = n === 1 ? 0 : -1 + (2 * i) / (n - 1);
                b.moveTo(x, 0);
                b.dwell(Math.max(1, Math.round(p.beamDwell)));
            }
            break;
        }
        case 'Nappe (ligne)': {
            // Aller-retour allumé : une nappe continue
            b.moveTo(-1, 0);
            b.lineTo(1, 0);
            b.lineTo(-1, 0);
            break;
        }
        case 'Nappe + faisceaux': {
            // Ligne allumée avec des arrêts : faisceaux brillants dans une nappe plus faible
            const n = Math.max(2, Math.round(p.beamCount));
            const dw = Math.max(1, Math.round(p.beamDwell));
            b.moveTo(-1, 0);
            b.dwell(dw);
            for (let i = 1; i < n; i++) { b.lineTo(-1 + (2 * i) / (n - 1), 0); b.dwell(dw); }
            for (let i = n - 2; i >= 0; i--) { b.lineTo(-1 + (2 * i) / (n - 1), 0); b.dwell(dw); }
            break;
        }
        case 'Point fixe': {
            b.moveTo(0, 0);
            b.dwell(Math.max(4, Math.round(p.beamDwell)));
            break;
        }
        case 'Cercle (cône)':
            b.curve((t) => [Math.cos(t * TAU), Math.sin(t * TAU)], circleSteps(1), true);
            break;
        case 'Carré':
            b.polygon([[-1, -1], [1, -1], [1, 1], [-1, 1]]);
            break;
        case 'Triangle':
            b.polygon(regular(3, 1));
            break;
        case 'Étoile': {
            const pts = [];
            for (let i = 0; i < 10; i++) {
                const a = -Math.PI / 2 + (i / 10) * TAU;
                const r = i % 2 === 0 ? 1 : 0.42;
                pts.push([Math.cos(a) * r, Math.sin(a) * r]);
            }
            b.polygon(pts);
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
        default:
            b.moveTo(0, 0);
            b.dwell(8);
    }
    b.finish();
    if (frame.n === 0) frame.push(0, 0, 0, 0, 0);
    return frame;
}
