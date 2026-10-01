/**
 * ildaShapes.js
 * ─────────────────────────────────────────────────────────────
 * 50 formes ILDA créatives, générées par programme et rangées en banques :
 *   Faisceaux, Nappes, Tunnels, Géométrie, Animations, Texte
 *
 * Chaque image reste sous ~900 points (dessinée sans scintillement à 30 kpps) ; masquage des sauts
 * (points éteints, plus nombreux pour un grand saut) et points d'angle pour que les miroirs suivent.
 * Animations en boucle : la dernière image enchaîne sans saut sur la première.
 *
 * Écrites une seule fois par le serveur (fichier témoin dans le dossier ilda) : une forme supprimée
 * par l'utilisateur ne réapparaît pas. Pour les régénérer : node server/ildaShapes.js [dossier ilda]
 * ─────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');

const TAU = Math.PI * 2;
const BLANK = 6;    // points éteints à l'arrivée d'un saut (+ selon la distance)
const CORNER = 4;   // points répétés sur un angle
const DWELL = 14;   // points d'un faisceau fixe
const STEP = 0.025; // pas entre deux points d'un trait (coordonnées −1…1)
const MARKER = '.formes-ss3d-v1';

// ─── Couleurs ────────────────────────────────────────────────────────────────

function hsv(h, s = 1, v = 1) {
    h = ((h % 1) + 1) % 1;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    const m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
    return { r: Math.round(m[0] * 255), g: Math.round(m[1] * 255), b: Math.round(m[2] * 255) };
}
const rgb = (r, g, b) => ({ r, g, b });
const dim = (c, k) => ({ r: Math.round(c.r * k), g: Math.round(c.g * k), b: Math.round(c.b * k) });
const mix = (a, b, t) => ({ r: Math.round(a.r + (b.r - a.r) * t), g: Math.round(a.g + (b.g - a.g) * t), b: Math.round(a.b + (b.b - a.b) * t) });
const RED = rgb(255, 0, 0), GREEN = rgb(0, 255, 0), BLUE = rgb(0, 60, 255), CYAN = rgb(0, 255, 255);
const MAGENTA = rgb(255, 0, 255), YELLOW = rgb(255, 230, 0), WHITE = rgb(255, 255, 255), ORANGE = rgb(255, 120, 0);
const PINK = rgb(255, 60, 160), VIOLET = rgb(140, 0, 255);

/** Générateur pseudo-aléatoire à graine (mêmes fichiers à chaque génération) */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
const pulse = (t) => 0.5 - 0.5 * Math.cos(TAU * t);   // 0 → 1 → 0 sur la boucle

// ─── Construction d'une image ────────────────────────────────────────────────

class Frame {
    constructor({ clipX = Infinity } = {}) {
        this.points = [];
        this.x = null;
        this.y = null;
        this.clipX = clipX;
    }

    _push(x, y, c) {
        if (c && Math.abs(x) > this.clipX) c = null;
        this.points.push(c ? { x, y, r: c.r, g: c.g, b: c.b } : { x, y, blank: true });
        this.x = x;
        this.y = y;
    }

    /** Saut masqué (les miroirs se déplacent faisceau éteint) */
    jump(x, y) {
        if (this.x !== null && Math.hypot(x - this.x, y - this.y) < 1e-4) return this;
        const d = this.x === null ? 1 : Math.hypot(x - this.x, y - this.y);
        const n = BLANK + Math.ceil(d * 4);
        for (let i = 0; i < n; i++) this._push(x, y, null);
        return this;
    }

    /** Faisceau fixe (point allumé longtemps : un rayon dans la fumée) */
    dwell(x, y, c, n = DWELL) {
        this.jump(x, y);
        for (let i = 0; i < n; i++) this._push(x, y, c);
        return this;
    }

    /** Trait droit depuis la position courante ; color(t) ou couleur fixe */
    lineTo(x, y, color, step = STEP) {
        const x0 = this.x, y0 = this.y;
        const n = Math.max(1, Math.ceil(Math.hypot(x - x0, y - y0) / step));
        for (let k = 1; k <= n; k++) {
            const t = k / n;
            this._push(x0 + (x - x0) * t, y0 + (y - y0) * t, typeof color === 'function' ? color(t) : color);
        }
        return this;
    }

    /** Ligne brisée (angles marqués) ; color(t, segment) avec t le long de la ligne entière */
    path(pts, color, { closed = false, step = STEP, corner = CORNER } = {}) {
        const list = closed ? [...pts, pts[0]] : pts;
        const segs = list.length - 1;
        const col = (t, s) => (typeof color === 'function' ? color(t, s) : color);
        this.jump(list[0][0], list[0][1]);
        for (let k = 0; k < corner; k++) this._push(list[0][0], list[0][1], col(0, 0));
        for (let s = 0; s < segs; s++) {
            const [bx, by] = list[s + 1];
            this.lineTo(bx, by, (t) => col((s + t) / segs, s), step);
            for (let k = 0; k < corner; k++) this._push(bx, by, col((s + 1) / segs, s));
        }
        return this;
    }

    /** Courbe paramétrique fn(t) → [x, y], t ∈ [0, 1], échantillonnée sur n points */
    curve(fn, color, n, { corner = CORNER } = {}) {
        const col = (t) => (typeof color === 'function' ? color(t) : color);
        const [x0, y0] = fn(0);
        this.jump(x0, y0);
        for (let k = 0; k < corner; k++) this._push(x0, y0, col(0));
        for (let i = 1; i <= n; i++) {
            const t = i / n;
            const [x, y] = fn(t);
            this._push(x, y, col(t));
        }
        const [x1, y1] = fn(1);
        for (let k = 0; k < corner; k++) this._push(x1, y1, col(1));
        return this;
    }

    /** Cercle (ou arc) : n points selon la longueur */
    circle(cx, cy, r, color, { a0 = 0, a1 = TAU, rx = r, ry = r } = {}) {
        const n = Math.max(12, Math.ceil(Math.abs(a1 - a0) * Math.max(rx, ry) / STEP));
        return this.curve((t) => {
            const a = a0 + (a1 - a0) * t;
            return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
        }, color, n);
    }

    done() {
        if (this.points.length === 0) this.points.push({ x: 0, y: 0, blank: true });
        return { format: 5, points: this.points };
    }
}

function frames(count, draw, options) {
    const out = [];
    for (let f = 0; f < count; f++) {
        const fr = new Frame(options);
        draw(fr, f / count, f);
        out.push(fr.done());
    }
    return out;
}

const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const polygon = (n, r, a, cx = 0, cy = 0) => Array.from({ length: n }, (_, k) => {
    const [x, y] = rot(r, 0, a + (k / n) * TAU);
    return [cx + x, cy + y];
});

/** Projection 3D → 2D (rotation Y puis X, perspective légère) */
function project([x, y, z], ay, ax, scale = 1) {
    let [x1, z1] = rot(x, z, ay);
    let [y1, z2] = rot(y, z1, ax);
    const k = scale * 2.4 / (2.4 + z2);
    return [x1 * k, y1 * k];
}

// ─── Police vectorielle (hauteur 1, largeur 0,6) ─────────────────────────────

const GLYPHS = {
    A: [[[0, 0], [0.3, 1], [0.6, 0]], [[0.12, 0.4], [0.48, 0.4]]],
    B: [[[0, 0], [0, 1], [0.42, 1], [0.57, 0.87], [0.57, 0.63], [0.42, 0.5], [0, 0.5]], [[0.42, 0.5], [0.6, 0.37], [0.6, 0.13], [0.45, 0], [0, 0]]],
    C: [[[0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15]]],
    D: [[[0, 0], [0, 1], [0.4, 1], [0.6, 0.8], [0.6, 0.2], [0.4, 0], [0, 0]]],
    E: [[[0.6, 1], [0, 1], [0, 0], [0.6, 0]], [[0, 0.5], [0.45, 0.5]]],
    G: [[[0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.45], [0.32, 0.45]]],
    I: [[[0.3, 0], [0.3, 1]]],
    L: [[[0, 1], [0, 0], [0.6, 0]]],
    N: [[[0, 0], [0, 1], [0.6, 0], [0.6, 1]]],
    O: [[[0.15, 0], [0.45, 0], [0.6, 0.15], [0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.15], [0.15, 0]]],
    P: [[[0, 0], [0, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65], [0.45, 0.5], [0, 0.5]]],
    R: [[[0, 0], [0, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.65], [0.45, 0.5], [0, 0.5]], [[0.3, 0.5], [0.6, 0]]],
    S: [[[0.6, 0.85], [0.45, 1], [0.15, 1], [0, 0.85], [0, 0.62], [0.15, 0.5], [0.45, 0.5], [0.6, 0.38], [0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15]]],
    T: [[[0, 1], [0.6, 1]], [[0.3, 1], [0.3, 0]]],
    U: [[[0, 1], [0, 0.15], [0.15, 0], [0.45, 0], [0.6, 0.15], [0.6, 1]]],
    V: [[[0, 1], [0.3, 0], [0.6, 1]]],
    Y: [[[0, 1], [0.3, 0.5], [0.6, 1]], [[0.3, 0.5], [0.3, 0]]],
    1: [[[0.12, 0.8], [0.35, 1], [0.35, 0]], [[0.12, 0], [0.58, 0]]],
    2: [[[0, 0.8], [0.15, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.6], [0, 0], [0.6, 0]]],
    3: [[[0, 0.85], [0.15, 1], [0.45, 1], [0.6, 0.85], [0.6, 0.62], [0.45, 0.5], [0.2, 0.5]], [[0.45, 0.5], [0.6, 0.38], [0.6, 0.15], [0.45, 0], [0.15, 0], [0, 0.15]]],
    '!': [[[0.3, 1], [0.3, 0.3]], [[0.3, 0.02], [0.3, 0]]],
};
const GLYPH_W = 0.6, GLYPH_GAP = 0.28;

function textWidth(str, h) {
    return str.length * (GLYPH_W + GLYPH_GAP) * h - GLYPH_GAP * h;
}

/** Texte centré en (cx, cy) ; color(i) par lettre ; offset(i) → [dx, dy, échelle] */
function drawText(fr, str, cx, cy, h, color, offset = null) {
    let x = cx - textWidth(str, h) / 2;
    for (let i = 0; i < str.length; i++) {
        const g = GLYPHS[str[i]];
        if (g) {
            const [dx, dy, s] = offset ? offset(i) : [0, 0, 1];
            const lx = x + (GLYPH_W * h) / 2 + dx;
            const ly = cy + dy;
            const hh = h * s;
            for (const stroke of g) {
                const pts = stroke.map(([u, v]) => [lx + (u - GLYPH_W / 2) * hh, ly + (v - 0.5) * hh]);
                fr.path(pts, color(i), { step: 0.02, corner: 3 });
            }
        }
        x += (GLYPH_W + GLYPH_GAP) * h;
    }
}

// ─── Les 50 formes ───────────────────────────────────────────────────────────

const SHAPES = [
    // ══ Faisceaux (rayons fixes dans la fumée) ══
    ['Faisceaux', 'Éventail respirant', () => frames(60, (fr, t) => {
        const spread = 0.2 + 0.7 * pulse(t);
        for (let i = 0; i < 12; i++) fr.dwell(-spread + (2 * spread * i) / 11, 0, hsv(i / 12));
    })],
    ['Faisceaux', 'Balayage croisé', () => frames(60, (fr, t) => {
        const u = 1 - Math.abs(1 - 2 * t);
        for (let i = 0; i < 5; i++) fr.dwell(-0.85 + 1.5 * ease(u) + i * 0.05, 0.08, CYAN);
        for (let i = 0; i < 5; i++) fr.dwell(0.85 - 1.5 * ease(u) - i * 0.05, -0.08, MAGENTA);
    })],
    ['Faisceaux', 'Pluie de faisceaux', () => {
        const rand = rng(11);
        return frames(48, (fr) => {
            const beams = Array.from({ length: 10 }, () => [-0.9 + 1.8 * rand(), -0.3 + 0.8 * rand(), [WHITE, CYAN, BLUE][Math.floor(rand() * 3)]]);
            beams.sort((a, b) => a[0] - b[0]);
            for (const [x, y, c] of beams) fr.dwell(x, y, c, 10);
        });
    }],
    ['Faisceaux', 'Radar', () => frames(72, (fr, t) => {
        for (let k = 5; k >= 0; k--) {
            const a = TAU * t - k * 0.13;
            fr.dwell(Math.cos(a) * 0.7, Math.sin(a) * 0.7, dim(GREEN, 1 - k * 0.16), k === 0 ? 20 : 8);
        }
        fr.dwell(0, 0, dim(GREEN, 0.5), 8);
    })],
    ['Faisceaux', 'Hélice', () => frames(60, (fr, t) => {
        for (let k = 0; k < 6; k++) {
            const a = (TAU / 6) * (t + k);
            fr.dwell(Math.cos(a) * 0.5, Math.sin(a) * 0.5, k % 2 ? WHITE : RED);
        }
    })],
    ['Faisceaux', 'Chenillard arc-en-ciel', () => frames(32, (fr, t) => {
        const head = t * 16;
        for (let i = 0; i < 16; i++) {
            const d = (head - i + 16) % 16;
            if (d < 4) fr.dwell(-0.9 + (1.8 * i) / 15, 0, dim(hsv(i / 16), 1 - d * 0.22));
        }
    })],
    ['Faisceaux', 'Double couronne', () => frames(60, (fr, t) => {
        for (let k = 0; k < 6; k++) { const a = (TAU / 6) * (k + t); fr.dwell(Math.cos(a) * 0.3, Math.sin(a) * 0.3, YELLOW, 12); }
        for (let k = 0; k < 10; k++) { const a = (TAU / 10) * (k - t); fr.dwell(Math.cos(a) * 0.75, Math.sin(a) * 0.75, BLUE, 12); }
    })],
    ['Faisceaux', 'Stroboscope de faisceaux', () => frames(8, (fr, t, f) => {
        for (let i = 0; i < 10; i++) if ((i % 2) === (f < 4 ? 0 : 1)) fr.dwell(-0.9 + (1.8 * i) / 9, 0.05, f < 4 ? WHITE : BLUE, 16);
    })],
    ['Faisceaux', 'Vague de faisceaux', () => frames(60, (fr, t) => {
        for (let i = 0; i < 14; i++) {
            const x = -0.9 + (1.8 * i) / 13;
            fr.dwell(x, 0.35 * Math.sin(TAU * (x * 0.6 + t)), hsv(0.55 + 0.1 * Math.sin(TAU * (x * 0.5 + t))));
        }
    })],
    ['Faisceaux', 'Explosion', () => frames(40, (fr, t) => {
        const r = 0.05 + 0.85 * Math.pow(t, 0.7);
        const c = t < 0.4 ? mix(WHITE, ORANGE, t / 0.4) : mix(ORANGE, dim(RED, 0.4), (t - 0.4) / 0.6);
        for (let k = 0; k < 16; k++) { const a = (k / 16) * TAU; fr.dwell(Math.cos(a) * r, Math.sin(a) * r, c, 10); }
    })],

    // ══ Nappes (plans de lumière) ══
    ['Nappes', 'Ciel liquide', () => frames(90, (fr, t) => {
        const y = (x) => 0.1 * Math.sin(TAU * (x * 0.8 + t)) + 0.05 * Math.sin(TAU * (x * 2.1 - 2 * t)) + 0.1;
        const c = (x) => hsv(0.6 + 0.12 * x);
        fr.curve((u) => { const x = -0.95 + 1.9 * u; return [x, y(x)]; }, (u) => c(-0.95 + 1.9 * u), 80);
        fr.curve((u) => { const x = 0.95 - 1.9 * u; return [x, y(x)]; }, (u) => c(0.95 - 1.9 * u), 80, { corner: 0 });
    })],
    ['Nappes', 'Nappe double', () => frames(60, (fr, t) => {
        const d = 0.08 + 0.3 * pulse(t);
        fr.path([[-0.9, d], [0.9, d]], CYAN);
        fr.path([[0.9, -d], [-0.9, -d]], MAGENTA);
    })],
    ['Nappes', 'Rideau vertical', () => frames(60, (fr, t) => {
        const x = 0.85 * Math.sin(TAU * t);
        fr.path([[x, -0.8], [x, 0.8], [x, -0.8]], GREEN);
    })],
    ['Nappes', 'Nappe tournante', () => frames(72, (fr, t) => {
        const a = Math.PI * t;
        const [x, y] = rot(0.9, 0, a);
        fr.path([[-x, -y], [x, y], [-x, -y]], (u) => mix(RED, YELLOW, 1 - Math.abs(1 - 2 * ((u * 2) % 1))));
    })],
    ['Nappes', 'Vague arc-en-ciel', () => frames(60, (fr, t) => {
        const y = (x) => 0.3 * Math.sin(TAU * (x * 0.9 - t));
        fr.curve((u) => { const x = -0.9 + 1.8 * u; return [x, y(x)]; }, (u) => hsv(u * 0.8 + t), 90);
        fr.curve((u) => { const x = 0.9 - 1.8 * u; return [x, y(x)]; }, (u) => hsv((1 - u) * 0.8 + t), 90, { corner: 0 });
    })],
    ['Nappes', 'Double hélice', () => frames(60, (fr, t) => {
        const y = (x, s) => s * 0.3 * Math.sin(TAU * (x * 0.75 + t));
        fr.curve((u) => { const x = -0.9 + 1.8 * u; return [x, y(x, 1)]; }, BLUE, 80);
        fr.curve((u) => { const x = 0.9 - 1.8 * u; return [x, y(x, -1)]; }, RED, 80);
        for (let k = 0; k < 7; k++) {
            const x = -0.75 + k * 0.25;
            fr.path([[x, y(x, 1)], [x, y(x, -1)]], dim(WHITE, 0.6), { corner: 2 });
        }
    })],
    ['Nappes', 'Horizon qui tombe', () => frames(45, (fr, t) => {
        const y = 0.85 - 1.7 * t * t;
        fr.path([[-0.9, y], [0.9, y], [-0.9, y]], dim(mix(WHITE, BLUE, t), 1 - 0.6 * t));
    })],
    ['Nappes', 'Nappe électrique', () => {
        const rand = rng(23);
        return frames(24, (fr) => {
            const pts = Array.from({ length: 20 }, (_, i) => [-0.9 + (1.8 * i) / 19, (rand() - 0.5) * 0.24]);
            fr.path(pts, () => (rand() < 0.2 ? WHITE : VIOLET), { corner: 1 });
        });
    }],

    // ══ Tunnels (cercles et polygones : cônes de lumière) ══
    ['Tunnels', 'Tunnel arc-en-ciel', () => frames(60, (fr, t) => {
        fr.circle(0, 0, 0.6, (u) => hsv(u + t));
    })],
    ['Tunnels', 'Tunnel pointillé', () => frames(60, (fr, t) => {
        for (let k = 0; k < 12; k++) {
            const a = (TAU / 12) * (k + t);
            fr.circle(0, 0, 0.6, CYAN, { a0: a, a1: a + (TAU / 12) * 0.6 });
        }
    })],
    ['Tunnels', 'Tunnel carré', () => frames(60, (fr, t) => {
        fr.path(polygon(4, 0.75, (TAU / 4) * t + Math.PI / 4), (u) => mix(ORANGE, YELLOW, u), { closed: true });
    })],
    ['Tunnels', 'Tunnel respirant', () => frames(60, (fr, t) => {
        const k = pulse(t);
        fr.circle(0, 0, 0.3 + 0.35 * k, mix(BLUE, MAGENTA, k));
    })],
    ['Tunnels', 'Tunnel en spirale', () => frames(60, (fr, t) => {
        fr.curve((u) => {
            const a = u * 3 * TAU + TAU * t;
            const r = 0.05 + 0.8 * u;
            return [Math.cos(a) * r, Math.sin(a) * r];
        }, (u) => hsv(0.5 + 0.3 * u), 300);
    })],
    ['Tunnels', 'Tunnel hexagonal', () => frames(60, (fr, t) => {
        fr.path(polygon(6, 0.65, (TAU / 6) * t), (u, s) => (s % 2 ? WHITE : RED), { closed: true });
    })],
    ['Tunnels', 'Double tunnel', () => frames(60, (fr, t) => {
        for (let k = 0; k < 8; k++) { const a = (TAU / 8) * (k + t); fr.circle(0, 0, 0.72, GREEN, { a0: a, a1: a + (TAU / 8) * 0.55 }); }
        for (let k = 0; k < 6; k++) { const a = (TAU / 6) * (k - t); fr.circle(0, 0, 0.4, YELLOW, { a0: a, a1: a + (TAU / 6) * 0.55 }); }
    })],

    // ══ Géométrie ══
    ['Géométrie', 'Triangle tournant', () => frames(60, (fr, t) => {
        fr.path(polygon(3, 0.75, (TAU / 3) * t - Math.PI / 2), (u, s) => hsv(s / 3 + u * 0.05), { closed: true });
    })],
    ['Géométrie', 'Rosace', () => frames(90, (fr, t) => {
        fr.curve((u) => {
            const a = u * TAU;
            const r = 0.8 * Math.cos(4 * a);
            return rot(Math.cos(a) * r, Math.sin(a) * r, (TAU / 8) * t);
        }, (u) => hsv(u + t), 420);
    })],
    ['Géométrie', 'Lissajous', () => frames(90, (fr, t) => {
        fr.curve((u) => [0.8 * Math.sin(3 * u * TAU + TAU * t), 0.8 * Math.sin(2 * u * TAU)], (u) => hsv(0.45 + 0.2 * Math.sin(u * TAU)), 360);
    })],
    ['Géométrie', 'Cube 3D', () => frames(72, (fr, t) => {
        const v = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map((p) => p.map((c) => c * 0.4));
        const P = v.map((p) => project(p, (TAU / 4) * t, 0.5));
        fr.path([P[0], P[1], P[2], P[3]], CYAN, { closed: true });
        fr.path([P[4], P[5], P[6], P[7]], CYAN, { closed: true });
        for (let k = 0; k < 4; k++) fr.path([P[k], P[k + 4]], dim(CYAN, 0.8));
    })],
    ['Géométrie', 'Pyramide 3D', () => frames(72, (fr, t) => {
        const v = [[-0.5, -0.4, -0.5], [0.5, -0.4, -0.5], [0.5, -0.4, 0.5], [-0.5, -0.4, 0.5], [0, 0.55, 0]];
        const P = v.map((p) => project(p, (TAU / 4) * t, 0.35));
        fr.path([P[0], P[1], P[2], P[3]], ORANGE, { closed: true });
        fr.path([P[0], P[4], P[2]], YELLOW);
        fr.path([P[1], P[4], P[3]], YELLOW);
    })],
    ['Géométrie', 'Gyroscope', () => frames(90, (fr, t) => {
        const ring = (axis, color) => fr.curve((u) => {
            const a = u * TAU;
            let p = [Math.cos(a) * 0.65, Math.sin(a) * 0.65, 0];
            if (axis === 1) p = [p[0], 0, p[1]];
            if (axis === 2) p = [0, p[0], p[1]];
            return project(p, TAU * t, 0.4 + 0.3 * Math.sin(TAU * t));
        }, color, 160);
        ring(0, RED); ring(1, GREEN); ring(2, BLUE);
    })],
    ['Géométrie', 'Atome', () => frames(60, (fr, t) => {
        for (let k = 0; k < 3; k++) {
            const r = (k * Math.PI) / 3;
            fr.curve((u) => rot(Math.cos(u * TAU) * 0.8, Math.sin(u * TAU) * 0.25, r), BLUE, 150);
            const a = TAU * t * (k % 2 ? -1 : 1) + k * 2;
            fr.dwell(...rot(Math.cos(a) * 0.8, Math.sin(a) * 0.25, r), WHITE, 10);
        }
        fr.dwell(0, 0, RED, 16);
    })],
    ['Géométrie', 'Spirographe', () => frames(120, (fr, t) => {
        const grow = Math.min(1, t / 0.75);
        const R = 5, r = 3, d = 5, s = 0.8 / 7;
        fr.curve((u) => {
            const a = u * grow * 3 * TAU;
            return [((R - r) * Math.cos(a) + d * Math.cos(((R - r) / r) * a)) * s, ((R - r) * Math.sin(a) - d * Math.sin(((R - r) / r) * a)) * s];
        }, (u) => hsv(u * grow * 0.9 + 0.8), Math.max(20, Math.round(600 * grow)));
    })],
    ['Géométrie', 'Grille ondulée', () => frames(60, (fr, t) => {
        for (let k = 0; k < 5; k++) {
            const y0 = -0.6 + k * 0.3;
            const dir = k % 2 ? -1 : 1;
            fr.curve((u) => { const x = dir * (-0.85 + 1.7 * u); return [x, y0 + 0.08 * Math.sin(TAU * (x * 0.8 + t + k * 0.15))]; }, hsv(0.5 + k * 0.06), 70);
        }
    })],
    ['Géométrie', 'Mandala', () => frames(120, (fr, t) => {
        fr.path(polygon(6, 0.8, (TAU / 6) * t), MAGENTA, { closed: true });
        fr.path(polygon(3, 0.6, -(TAU / 3) * t), YELLOW, { closed: true });
        fr.path(polygon(4, 0.35, (TAU / 4) * t), CYAN, { closed: true });
    })],

    // ══ Animations ══
    ['Animations', 'Cœur battant', () => frames(30, (fr, t) => {
        const beat = 1 + 0.12 * Math.max(Math.exp(-Math.pow((t - 0.1) / 0.06, 2)), 0.7 * Math.exp(-Math.pow((t - 0.35) / 0.06, 2)));
        fr.curve((u) => {
            const a = u * TAU;
            const x = 16 * Math.pow(Math.sin(a), 3);
            const y = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
            return [x * 0.045 * beat, (y + 2) * 0.045 * beat];
        }, RED, 260);
    })],
    ['Animations', 'Égaliseur', () => frames(30, (fr, t) => {
        for (let i = 0; i < 12; i++) {
            const x = -0.85 + (1.7 * i) / 11;
            const h = 0.15 + 0.7 * Math.abs(Math.sin(TAU * t * (1 + (i % 3)) + i * 1.7) * Math.cos(TAU * t + i * 0.6));
            const top = -0.7 + 1.4 * h;
            fr.path([[x, -0.7], [x, top]], (u) => { const y = u * h; return y < 0.45 ? GREEN : y < 0.7 ? YELLOW : RED; }, { corner: 3 });
        }
    })],
    ['Animations', 'Oscilloscope', () => frames(45, (fr, t) => {
        const y = (x) => 0.25 * Math.sin(TAU * (3 * x + t)) * Math.cos(Math.PI * x * 0.5) + 0.08 * Math.sin(TAU * (11 * x - 2 * t));
        fr.curve((u) => { const x = -0.9 + 1.8 * u; return [x, y(x)]; }, GREEN, 140);
        fr.curve((u) => { const x = 0.9 - 1.8 * u; return [x, y(x)]; }, GREEN, 140, { corner: 0 });
    })],
    ['Animations', "Feu d'artifice", () => frames(60, (fr, t) => {
        const bursts = [[0, -0.2, 0.55, 0], [-0.45, 0.1, 0.4, 0.5], [0.45, 0.2, 0.35, 0.25]];
        const cols = [hsv(0.95), hsv(0.3), hsv(0.6)];
        bursts.forEach(([bx, by, size, start], k) => {
            const u = (t - start + 1) % 1;
            if (u < 0.25) {
                const e = u / 0.25;
                fr.dwell(bx, -0.9 + (by + 0.9) * ease(e), dim(ORANGE, 0.8), 6);
            } else if (u < 0.85) {
                const e = (u - 0.25) / 0.6;
                const r = size * Math.sqrt(e);
                for (let p = 0; p < 14; p++) {
                    const a = (p / 14) * TAU;
                    fr.dwell(bx + Math.cos(a) * r, by + Math.sin(a) * r - 0.35 * e * e, dim(cols[k], 1 - e * 0.8), 5);
                }
            }
        });
    })],
    ['Animations', 'Soleil', () => frames(60, (fr, t) => {
        fr.circle(0, 0, 0.3, YELLOW);
        for (let k = 0; k < 12; k++) {
            const a = (TAU / 12) * (k + t);
            const len = 0.62 + 0.12 * Math.sin(TAU * t * 2 + k * Math.PI);
            fr.path([[Math.cos(a) * 0.38, Math.sin(a) * 0.38], [Math.cos(a) * len, Math.sin(a) * len]], ORANGE, { corner: 2 });
        }
    })],
    ['Animations', 'Éclair', () => {
        const bolt = (seed) => {
            const rand = rng(seed);
            const pts = [[-0.1 + rand() * 0.2, 0.85]];
            for (let i = 1; i <= 9; i++) pts.push([pts[i - 1][0] + (rand() - 0.5) * 0.3, 0.85 - i * 0.19]);
            const b = 3 + Math.floor(rand() * 4);
            const branch = [pts[b], [pts[b][0] + 0.25 * (rand() < 0.5 ? -1 : 1), pts[b][1] - 0.25], [pts[b][0] + 0.35 * (rand() < 0.5 ? -1 : 1), pts[b][1] - 0.45]];
            return [pts, branch];
        };
        const A = bolt(5), B = bolt(9);
        const on = { 0: A, 1: A, 3: A, 12: B, 13: B, 15: B };
        return frames(24, (fr, t, f) => {
            const b = on[f];
            if (!b) return;
            fr.path(b[0], mix(WHITE, BLUE, 0.3), { corner: 1 });
            fr.path(b[1], dim(BLUE, 0.8), { corner: 1 });
        });
    }],
    ['Animations', 'Pac-Man', () => frames(40, (fr, t) => {
        const m = 0.08 + 0.55 * Math.abs(Math.sin(TAU * t));
        for (let k = 0; k < 3; k++) {
            const x = 0.3 + 0.3 * k - 0.3 * t;
            fr.dwell(x, 0, WHITE, 10);
        }
        const cx = -0.35;
        fr.path([[cx, 0], [cx + Math.cos(m) * 0.45, Math.sin(m) * 0.45]], YELLOW, { corner: 2 });
        fr.circle(cx, 0, 0.45, YELLOW, { a0: m, a1: TAU - m });
        fr.lineTo(cx, 0, YELLOW);
        fr.dwell(cx + 0.05, 0.22, BLUE, 6);
    })],
    ['Animations', 'Planète à anneaux', () => frames(90, (fr, t) => {
        fr.circle(0, 0, 0.32, ORANGE);
        fr.curve((u) => rot(Math.cos(u * TAU) * 0.75, Math.sin(u * TAU) * 0.17, 0.25), (u) => {
            const a = u * TAU;
            const [x, y] = [Math.cos(a) * 0.75, Math.sin(a) * 0.17];
            // Moitié arrière de l'anneau cachée par la planète
            if (Math.sin(a) > 0 && Math.hypot(...rot(x, y, 0.25)) < 0.32) return rgb(0, 0, 0);
            return hsv(0.12 + 0.05 * Math.sin(a * 3 + TAU * t), 0.6);
        }, 220);
        const a = TAU * t;
        fr.dwell(Math.cos(a) * 0.9, Math.sin(a) * 0.35, WHITE, 8);
    })],
    ['Animations', 'Boule à facettes', () => {
        const rand = rng(31);
        const pts = [];
        for (let lat = -2; lat <= 2; lat++) for (let lon = 0; lon < 8; lon++) pts.push([lat * 0.33, lon / 8, rand()]);
        return frames(30, (fr, t) => {
            const vis = [];
            for (const [lat, lon, ph] of pts) {
                const a = (lon + t / 8) * TAU;
                const z = Math.cos(a) * Math.cos(lat);
                if (z < 0.1) continue;
                const tw = 0.3 + 0.7 * Math.pow(pulse((t * 3 + ph) % 1), 3);
                vis.push([Math.sin(a) * Math.cos(lat) * 0.7, Math.sin(lat) * 0.7, dim(WHITE, tw)]);
            }
            vis.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
            for (const [x, y, c] of vis) fr.dwell(x, y, c, 6);
        });
    }],
    ['Animations', 'Serpent', () => frames(60, (fr, t) => {
        const head = -1.2 + 2.9 * t;
        fr.clipX = 0.95;
        fr.curve((u) => { const x = head - 0.9 * u; return [x, 0.3 * Math.sin(TAU * (x * 0.7) + TAU * t)]; }, (u) => mix(GREEN, BLUE, u), 90);
    })],

    // ══ Texte ══
    ['Texte', 'SOUNDSTAGE', () => frames(30, (fr, t) => {
        drawText(fr, 'SOUNDSTAGE', 0, 0, 0.17, (i) => hsv(i / 10 + t));
    })],
    ['Texte', 'DROP', () => frames(30, (fr, t) => {
        const s = 0.8 + 0.45 * Math.pow(1 - t, 3);
        drawText(fr, 'DROP', 0, 0, 0.35 * s, (i) => (i % 2 ? WHITE : RED));
    })],
    ['Texte', 'PARTY', () => frames(40, (fr, t) => {
        drawText(fr, 'PARTY', 0, 0, 0.3, (i) => hsv(i / 5), (i) => [0, 0.12 * Math.sin(TAU * t + i * 0.9), 1]);
    })],
    ['Texte', 'Compte à rebours', () => frames(120, (fr, t) => {
        const seg = Math.min(3, Math.floor(t * 4));
        const u = t * 4 - seg;
        const [txt, col] = [['3', RED], ['2', ORANGE], ['1', YELLOW], ['GO!', GREEN]][seg];
        drawText(fr, txt, 0, 0, (seg === 3 ? 0.4 : 0.7) * (1.25 - 0.35 * ease(u)), () => col);
    })],
    ['Texte', 'BIENVENUE défilant', () => {
        const h = 0.3;
        const w = textWidth('BIENVENUE', h);
        return frames(120, (fr, t) => {
            const cx = 1.0 + w / 2 - (2.0 + w) * t;
            drawText(fr, 'BIENVENUE', cx, 0, h, (i) => hsv(0.55 + i * 0.05));
        }, { clipX: 0.95 });
    }],
];

// ─── Écriture ────────────────────────────────────────────────────────────────

function asciiName(name) {
    return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8) || 'SS3D';
}

/**
 * Écrit les 50 formes dans dir/<banque>/<nom>.ild (les fichiers déjà présents sont gardés)
 * @param {string} dir dossier ilda de la bibliothèque
 * @param {(frames: object[], name: string) => Buffer} encodeIlda
 * @returns {number} nombre de fichiers écrits
 */
function writeShapeBanks(dir, encodeIlda) {
    let written = 0;
    for (const [bank, name, build] of SHAPES) {
        const bankDir = path.join(dir, bank);
        const file = path.join(bankDir, `${name}.ild`);
        if (fs.existsSync(file)) continue;
        fs.mkdirSync(bankDir, { recursive: true });
        fs.writeFileSync(file, encodeIlda(build(), asciiName(name)));
        written++;
    }
    return written;
}

/** Une seule fois par dossier (fichier témoin) : une forme supprimée ne réapparaît pas au redémarrage */
function ensureShapeBanks(dir, encodeIlda) {
    const marker = path.join(dir, MARKER);
    if (fs.existsSync(marker)) return 0;
    const n = writeShapeBanks(dir, encodeIlda);
    fs.writeFileSync(marker, `Formes ILDA de SoundStage3D écrites le ${new Date().toISOString()} (supprimer ce fichier pour les régénérer)\n`);
    return n;
}

module.exports = { SHAPES, writeShapeBanks, ensureShapeBanks };

// node server/ildaShapes.js [dossier ilda] → (ré)écrit les formes manquantes
if (require.main === module) {
    const { encodeIlda } = require('./ildaLibrary');
    const dir = path.resolve(process.argv[2] || path.join(__dirname, 'storage', 'ilda'));
    const n = writeShapeBanks(dir, encodeIlda);
    fs.writeFileSync(path.join(dir, MARKER), `Formes ILDA de SoundStage3D écrites le ${new Date().toISOString()} (supprimer ce fichier pour les régénérer)\n`);
    console.log(`${n} formes écrites dans ${dir} (${SHAPES.length} au total)`);
}
