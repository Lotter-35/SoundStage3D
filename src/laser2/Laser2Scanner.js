/**
 * Laser2Scanner.js
 * ─────────────────────────────────────────────────────────────
 * Le « cœur » d'un laser réel, simulé point par point :
 *
 *  1. SORTIE (DAC) : les points de l'image partent au rythme choisi (kpps). L'index du point
 *     courant découle de l'horloge COMMUNE à tous les joueurs → même point au même instant partout,
 *     sans aucun point envoyé sur le réseau.
 *
 *  2. GALVOS : chaque miroir (X, Y) est un servo du second ordre (pulsation propre, amortissement)
 *     avec accélération et vitesse maximales, calé sur la vitesse nominale des scanners (norme ILDA,
 *     à 8°) : un grand saut est plus lent qu'un petit, les coins s'arrondissent, un cercle rétrécit
 *     quand on dessine plus vite que les scanners, un amortissement faible donne des dépassements.
 *
 *  3. MODULATION : couleur appliquée instantanément (les miroirs, eux, sont en retard) avec le
 *     décalage couleur du boîtier, seuil des diodes (analogique) ou tout-ou-rien (TTL), équilibrage
 *     des blancs (une couleur choisie reste cette couleur, comme sur un laser calibré).
 *
 *  4. INTÉGRATION (persistance) : la vraie trajectoire est accumulée sur une fenêtre de temps fixe,
 *     indépendante des FPS, puis réduite en primitives :
 *       - FAISCEAU : le point reste (quasi) immobile → énergie des points d'arrêt
 *       - NAPPE    : le point balaie → énergie répartie sur l'angle balayé
 *     La luminosité suit le temps passé : coins et arrêts éclatants, nappes plus faibles, un grand
 *     éventail plus sombre qu'un petit (même puissance étalée sur plus d'angle).
 *
 * Tout est en radians d'angle optique (repère du laser). Aucune allocation par image.
 * ─────────────────────────────────────────────────────────────
 */

import { buildPatternFrame, LaserFrame } from './Laser2Patterns.js';
import { hexToRgb, scannerPps } from './config/laser2Params.js';

const DEG = Math.PI / 180;
export const RING = 16384;
const RING_MASK = RING - 1;

/** Fenêtre de persistance : œil (image stable) et caméra (on voit le tracé) */
const EYE_WINDOW = 1 / 25;
const CAMERA_WINDOW = 1 / 60;

/** Primitives maximales par laser (au-delà, simplification plus forte) */
export const MAX_PRIMS = 700;

// Couleur affichée par unité de puissance équilibrée (max = 1) : 638 / 520 / 450 nm
const PRIM = [
    [1.0, 0.03, 0.0],   // rouge 638 nm (légèrement orangé)
    [0.05, 1.0, 0.15],  // vert 520 nm (légèrement bleuté)
    [0.12, 0.02, 1.0],  // bleu 450 nm (royal / violacé)
];
// Rendement visuel relatif de chaque source (le bleu paraît moins lumineux à puissance égale)
const EFFICACY = [0.75, 1.0, 0.5];

const _rgb = [0, 0, 0];

export class Laser2Scanner {
    constructor() {
        // Anneau des échantillons simulés (angles réels des miroirs + puissances émises)
        this.ax = new Float32Array(RING);
        this.ay = new Float32Array(RING);
        this.ux = new Float32Array(RING);   // consignes (aperçu)
        this.uy = new Float32Array(RING);
        this.pr = new Float32Array(RING);
        this.pg = new Float32Array(RING);
        this.pb = new Float32Array(RING);
        this.k = -Infinity;                 // dernier échantillon simulé

        // État des galvos
        this.px = 0; this.vx = 0;
        this.py = 0; this.vy = 0;

        this.frame = new LaserFrame(512);
        this._frameKey = '';
        this._cfgKey = '';

        // Primitives (angles + puissances moyennes, en unités affichées)
        this.beams = new Float32Array(64 * 5);   // ax, ay, dr, dg, db
        this.sheets = new Float32Array(64 * 7);  // ax0, ay0, ax1, ay1, dr, dg, db
        this.beamCount = 0;
        this.sheetCount = 0;
        this.version = 0;                        // incrémenté quand les primitives changent

        this._static = false;
        this._staticSince = -1;
        this.stats = { points: 0, frameHz: 0, window: 0, beams: 0, sheets: 0 };
    }

    // ── Configuration (à chaque changement de paramètres) ─────────────────
    configure(p) {
        const frameKey = `${p.pattern}|${p.density}|${p.cornerPoints}|${p.blankPoints}|${p.beamCount}|${p.beamDwell}`;
        if (frameKey !== this._frameKey) {
            buildPatternFrame(p, this.frame);
            this._frameKey = frameKey;
        }
        this.pps = Math.max(1000, p.scanRate * 1000);
        const rated = scannerPps(p.scanner);
        // Servo : pulsation propre ∝ vitesse nominale ; accélération / vitesse maximales calées sur
        // le dessin de la mire ILDA à 8° (un saut de plus de ~8° est limité en accélération)
        const s = rated / 30000;
        this.wn = 2 * Math.PI * 1100 * s;
        this.zeta = p.damping;
        this.amax = 3.6e8 * s * s * DEG;        // rad/s²
        this.vmax = 2.6e4 * s * DEG;            // rad/s
        this.sub = Math.max(1, Math.ceil(this.wn / this.pps / 0.3));
        this.maxAngle = p.maxAngle * DEG;
        this.phi = transitionMatrix(this.wn, this.zeta, 1 / this.pps);

        // Géométrie
        this.sx = p.sizeX / 100; this.sy = p.sizeY / 100;
        this.ox = p.offsetX / 100; this.oy = p.offsetY / 100;
        this.rot0 = p.rotation * DEG;
        this.rotSpeed = (p.rotSpeed / 100) * 2 * Math.PI;  // 100 % = 1 tour/s

        // Couleur et modulation (équilibrage des blancs : chaque source ramenée à la plus faible)
        hexToRgb(p.color, _rgb);
        const dim = Math.max(0, Math.min(1, p.dimmer / 100));
        const pw = [p.powerR, p.powerG, p.powerB];
        let bal = Infinity;
        for (let c = 0; c < 3; c++) if (pw[c] > 0) bal = Math.min(bal, pw[c] * EFFICACY[c]);
        if (!Number.isFinite(bal)) bal = 0;
        this.lvl = [_rgb[0] * dim, _rgb[1] * dim, _rgb[2] * dim];
        this.chan = [pw[0] > 0 ? bal : 0, pw[1] > 0 ? bal : 0, pw[2] > 0 ? bal : 0];
        this.ttl = p.modulation !== 'Analogique';
        this.thr = p.threshold / 100;
        this.shift = Math.round(p.colorShift);
        this.shutter = p.shutter;
        this.strobeRate = p.strobeRate;
        this.divergence = p.divergence * 1e-3;
        this.persistence = p.persistence;

        const cfgKey = `${frameKey}|${this.pps}|${rated}|${p.damping}|${p.maxAngle}|${p.sizeX}|${p.sizeY}|${p.offsetX}|${p.offsetY}|${p.rotation}|${p.rotSpeed}|${p.color}|${p.dimmer}|${pw}|${p.modulation}|${p.threshold}|${p.colorShift}|${p.shutter}|${p.strobeRate}|${p.divergence}|${p.persistence}`;
        if (cfgKey !== this._cfgKey) {
            this._cfgKey = cfgKey;
            this._staticSince = -1;
            this._static = false;
            this.k = -Infinity;     // nouvelle simulation de la fenêtre (même si l'horloge est à l'arrêt)
        }
    }

    /** Durée d'une image (s) */
    get framePeriod() {
        return this.frame.n / this.pps;
    }

    /** Nombre d'échantillons de la fenêtre de persistance */
    _windowSamples() {
        const n = this.frame.n;
        if (this.persistence === 'Caméra') return Math.max(2, Math.round(CAMERA_WINDOW * this.pps));
        // Œil : une image complète si elle est redessinée assez vite (image stable), sinon la fenêtre
        // de l'œil seulement (l'image scintille, comme en vrai)
        const w = Math.round(EYE_WINDOW * this.pps);
        return Math.min(RING - 64, n <= w ? n : w);
    }

    // ── Simulation jusqu'à l'instant t (horloge commune) ───────────────────
    /**
     * @param {number} t temps commun (s)
     * @returns {boolean} true si les primitives ont changé
     */
    update(t) {
        const pps = this.pps;
        const kNow = Math.floor(t * pps);
        const win = this._windowSamples();
        const canFreeze = this.persistence !== 'Caméra' && this.rotSpeed === 0 && this.shutter !== 'Strobe'
            && this.frame.n <= Math.round(EYE_WINDOW * pps);

        // Image fixe redessinée en boucle : après 3 images simulées, le résultat ne change plus
        if (canFreeze && this._static) return false;

        if (!(kNow - this.k < RING - 64) || kNow < this.k - 2) {
            // Premier appel, saut d'horloge ou longue pause : on repart un peu avant la fenêtre
            const warm = Math.min(RING - 64 - win, 400 + this.frame.n);
            this.k = kNow - win - warm;
            const u = this._command(this.k);
            this.px = u[0]; this.py = u[1]; this.vx = 0; this.vy = 0;
        }
        if (kNow <= this.k) return false;
        this._simulate(this.k + 1, kNow);
        this.k = kNow;

        this._extract(kNow - win + 1, kNow + 1);
        this.version++;

        if (canFreeze) {
            if (this._staticSince < 0) this._staticSince = kNow;
            else if (kNow - this._staticSince > this.frame.n * 3 + 400) this._static = true;
        }
        const n = this.frame.n;
        this.stats.points = n;
        this.stats.frameHz = pps / n;
        this.stats.window = win / pps;
        this.stats.beams = this.beamCount;
        this.stats.sheets = this.sheetCount;
        return true;
    }

    /** Consigne des miroirs pour l'échantillon k (rad) */
    _command(k) {
        const f = this.frame;
        const i = ((k % f.n) + f.n) % f.n;
        let x = f.x[i], y = f.y[i];
        if (this.rot0 !== 0 || this.rotSpeed !== 0) {
            const a = this.rot0 + this.rotSpeed * (k / this.pps);
            const c = Math.cos(a), s = Math.sin(a);
            const xr = x * c - y * s;
            y = x * s + y * c;
            x = xr;
        }
        x = x * this.sx + this.ox;
        y = y * this.sy + this.oy;
        x = x < -1 ? -1 : x > 1 ? 1 : x;
        y = y < -1 ? -1 : y > 1 ? 1 : y;
        _cmd[0] = x * this.maxAngle;
        _cmd[1] = y * this.maxAngle;
        return _cmd;
    }

    _simulate(k0, k1) {
        const f = this.frame;
        const n = f.n;
        const fx = f.x, fy = f.y, fr = f.r, fg = f.g, fb = f.b;
        const T = 1 / this.pps;
        const sub = this.sub, h = T / sub;
        const wn2 = this.wn * this.wn, c2 = 2 * this.zeta * this.wn;
        const [p00, p01, p10, p11] = this.phi;
        const amax = this.amax, vmax = this.vmax, lim = this.maxAngle * 1.05;
        const maxA = this.maxAngle, gx = this.sx, gy = this.sy, ox = this.ox, oy = this.oy;
        const lr = this.lvl[0], lg = this.lvl[1], lb = this.lvl[2];
        const cr = this.chan[0], cg = this.chan[1], cb = this.chan[2];
        const ttl = this.ttl, thr = this.thr;
        const strobe = this.shutter === 'Strobe', open = this.shutter !== 'Fermé';
        const rate = this.strobeRate;
        const rot = this.rot0 !== 0 || this.rotSpeed !== 0;
        // Rotation calculée de proche en proche (pas de cos / sin par point)
        const a0 = this.rot0 + this.rotSpeed * k0 * T;
        let rc = Math.cos(a0), rs = Math.sin(a0);
        const dc = Math.cos(this.rotSpeed * T), ds = Math.sin(this.rotSpeed * T);
        let i = ((k0 % n) + n) % n;
        let j = (((k0 - this.shift) % n) + n) % n;   // couleur émise : point d'il y a `shift` échantillons
        let px = this.px, vx = this.vx, py = this.py, vy = this.vy;
        const AX = this.ax, AY = this.ay, UX = this.ux, UY = this.uy, PR = this.pr, PG = this.pg, PB = this.pb;

        for (let k = k0; k <= k1; k++) {
            let x = fx[i], y = fy[i];
            if (rot) {
                const xr = x * rc - y * rs;
                y = x * rs + y * rc;
                x = xr;
                const cn = rc * dc - rs * ds;
                rs = rs * dc + rc * ds;
                rc = cn;
            }
            x = x * gx + ox;
            y = y * gy + oy;
            const ux = (x < -1 ? -1 : x > 1 ? 1 : x) * maxA;
            const uy = (y < -1 ? -1 : y > 1 ? 1 : y) * maxA;

            // Miroir X : solution exacte du servo linéaire, petites étapes bornées pendant les sauts
            let e = px - ux;
            let a = -wn2 * e - c2 * vx;
            if (a > amax || a < -amax || vx >= vmax || vx <= -vmax) {
                for (let q = 0; q < sub; q++) {
                    a = wn2 * (ux - px) - c2 * vx;
                    a = a > amax ? amax : a < -amax ? -amax : a;
                    vx += a * h;
                    vx = vx > vmax ? vmax : vx < -vmax ? -vmax : vx;
                    px += vx * h;
                }
            } else {
                const e2 = p00 * e + p01 * vx;
                vx = p10 * e + p11 * vx;
                px = ux + e2;
                vx = vx > vmax ? vmax : vx < -vmax ? -vmax : vx;
            }
            // Miroir Y
            e = py - uy;
            a = -wn2 * e - c2 * vy;
            if (a > amax || a < -amax || vy >= vmax || vy <= -vmax) {
                for (let q = 0; q < sub; q++) {
                    a = wn2 * (uy - py) - c2 * vy;
                    a = a > amax ? amax : a < -amax ? -amax : a;
                    vy += a * h;
                    vy = vy > vmax ? vmax : vy < -vmax ? -vmax : vy;
                    py += vy * h;
                }
            } else {
                const e2 = p00 * e + p01 * vy;
                vy = p10 * e + p11 * vy;
                py = uy + e2;
                vy = vy > vmax ? vmax : vy < -vmax ? -vmax : vy;
            }
            if (px > lim) { px = lim; vx = 0; } else if (px < -lim) { px = -lim; vx = 0; }
            if (py > lim) { py = lim; vy = 0; } else if (py < -lim) { py = -lim; vy = 0; }

            let r = 0, g = 0, b = 0;
            let on = open;
            if (on && strobe) {
                const ph = k * T * rate;
                on = ph - Math.floor(ph) < 0.3;
            }
            if (on) {
                const vr = fr[j] * lr, vg = fg[j] * lg, vb = fb[j] * lb;
                if (ttl) {
                    r = vr >= 0.5 ? cr : 0; g = vg >= 0.5 ? cg : 0; b = vb >= 0.5 ? cb : 0;
                } else {
                    r = vr < thr ? 0 : vr * cr; g = vg < thr ? 0 : vg * cg; b = vb < thr ? 0 : vb * cb;
                }
            }
            const o = k & RING_MASK;
            AX[o] = px; AY[o] = py;
            UX[o] = ux; UY[o] = uy;
            PR[o] = r; PG[o] = g; PB[o] = b;
            if (++i === n) i = 0;
            if (++j === n) j = 0;
        }
        this.px = px; this.vx = vx; this.py = py; this.vy = vy;
    }

    // ── Réduction de la trajectoire en primitives ─────────────────────────
    _extract(k0, k1) {
        let tol = 7e-4;
        for (let pass = 0; pass < 4; pass++) {
            if (this._extractPass(k0, k1, tol)) return;
            tol *= 2;
        }
    }

    /** @returns {boolean} false si le budget de primitives est dépassé */
    _extractPass(k0, k1, tol) {
        const N = k1 - k0;
        const inv = 1 / N;                                   // énergie → puissance moyenne
        const dwellTol = Math.max(this.divergence * 0.5, 2.5e-4);
        const minSheet = dwellTol * 4;
        this.beamCount = 0;
        this.sheetCount = 0;
        let over = false;

        // État courant : 0 rien, 1 faisceau, 2 nappe
        let mode = 0;
        let bx = 0, by = 0, bw = 0, br = 0, bg = 0, bb = 0;          // faisceau (position pondérée)
        let sx0 = 0, sy0 = 0, sx1 = 0, sy1 = 0, sr = 0, sg = 0, sb = 0; // nappe
        let sL = 0, sd0 = 0, sdx = 0, sdy = 0, sProj = 0, sLevel = 0, sCount = 0;
        let prevLit = false, qx = 0, qy = 0;

        const emitBeam = (x, y, r, g, b) => {
            // Fusion avec un faisceau déjà émis au même endroit (image redessinée plusieurs fois)
            const B = this.beams;
            for (let i = Math.max(0, this.beamCount - 48); i < this.beamCount; i++) {
                const o = i * 5;
                if (Math.abs(B[o] - x) < dwellTol * 2 && Math.abs(B[o + 1] - y) < dwellTol * 2) {
                    const w0 = B[o + 2] + B[o + 3] + B[o + 4], w1 = r + g + b;
                    const wt = w0 + w1 > 0 ? w1 / (w0 + w1) : 0.5;
                    B[o] += (x - B[o]) * wt; B[o + 1] += (y - B[o + 1]) * wt;
                    B[o + 2] += r; B[o + 3] += g; B[o + 4] += b;
                    return;
                }
            }
            if (this.beamCount + this.sheetCount >= MAX_PRIMS) { over = true; return; }
            if ((this.beamCount + 1) * 5 > B.length) this.beams = grow(B);
            const o = this.beamCount++ * 5;
            const A = this.beams;
            A[o] = x; A[o + 1] = y; A[o + 2] = r; A[o + 3] = g; A[o + 4] = b;
        };
        const closeBeam = () => {
            if (bw > 0) emitBeam(bx / bw, by / bw, br * inv, bg * inv, bb * inv);
            bw = 0; br = bg = bb = 0; bx = by = 0;
        };
        const closeSheet = () => {
            if (sL < minSheet) {
                if (sr + sg + sb > 0) emitBeam((sx0 + sx1) * 0.5, (sy0 + sy1) * 0.5, sr * inv, sg * inv, sb * inv);
            } else if (this.beamCount + this.sheetCount >= MAX_PRIMS) {
                over = true;
            } else {
                if ((this.sheetCount + 1) * 7 > this.sheets.length) this.sheets = grow(this.sheets);
                const o = this.sheetCount++ * 7;
                const S = this.sheets;
                S[o] = sx0; S[o + 1] = sy0; S[o + 2] = sx1; S[o + 3] = sy1;
                S[o + 4] = sr * inv; S[o + 5] = sg * inv; S[o + 6] = sb * inv;
            }
            sr = sg = sb = 0; sL = 0; sCount = 0;
        };
        const startSheet = (x, y) => {
            sx0 = sx1 = x; sy0 = sy1 = y;
            sr = sg = sb = 0; sL = 0; sd0 = 0; sProj = 0; sCount = 0;
        };

        const PR = this.pr, PG = this.pg, PB = this.pb, AX = this.ax, AY = this.ay;
        for (let k = k0; k < k1; k++) {
            const o = k & RING_MASK;
            const r = PR[o], g = PG[o], b = PB[o];
            const x = AX[o], y = AY[o];
            const lvl = r + g + b;
            if (lvl <= 1e-6) {
                if (mode === 1) closeBeam(); else if (mode === 2) closeSheet();
                mode = 0; prevLit = false; qx = x; qy = y;
                continue;
            }
            const ddx = x - qx, ddy = y - qy;
            const d = prevLit ? Math.sqrt(ddx * ddx + ddy * ddy) : 0;
            if (!prevLit || d < dwellTol) {
                // Point d'arrêt : énergie ajoutée au faisceau courant
                if (mode === 2) closeSheet();
                if (mode !== 1) { mode = 1; bw = 0; br = bg = bb = 0; bx = by = 0; }
                bx += x * lvl; by += y * lvl; bw += lvl;
                br += r; bg += g; bb += b;
            } else {
                if (mode === 1) { closeBeam(); startSheet(qx, qy); mode = 2; }
                else if (mode === 0) { startSheet(qx, qy); mode = 2; }
                else {
                    // Le segment peut-il prolonger la nappe courante ? (droit, même vitesse, même couleur)
                    const ex = x - sx0, ey = y - sy0;
                    const proj = ex * sdx + ey * sdy;
                    const perp = Math.abs(ex * sdy - ey * sdx);
                    const ratio = d / sd0;
                    let cut = perp > tol || proj <= sProj || ratio < 0.6 || ratio > 1.7;
                    if (!cut) {
                        const lv = sLevel / sCount, se = sr + sg + sb;
                        cut = Math.abs(lvl - lv) > 0.15 * lv
                            || Math.abs(r / lvl - sr / se) > 0.06
                            || Math.abs(g / lvl - sg / se) > 0.06;
                    }
                    if (cut) {
                        closeSheet();
                        startSheet(qx, qy);
                    }
                }
                if (sCount === 0) {
                    sd0 = d;
                    sdx = (x - sx0) / d; sdy = (y - sy0) / d;
                    sLevel = 0;
                }
                sx1 = x; sy1 = y;
                sProj = (x - sx0) * sdx + (y - sy0) * sdy;
                sL += d;
                sr += r; sg += g; sb += b;
                sLevel += lvl; sCount++;
            }
            prevLit = true; qx = x; qy = y;
        }
        if (mode === 1) closeBeam(); else if (mode === 2) closeSheet();
        return !over;
    }
}

const _cmd = [0, 0];

/**
 * Matrice de transition exacte du servo linéaire sur une période d'échantillon T
 * (erreur e = θ − consigne, vitesse v) : [e', v'] = Φ · [e, v], consigne constante pendant T.
 */
function transitionMatrix(wn, zeta, T) {
    const wn2 = wn * wn, c2 = 2 * zeta * wn;
    const steps = 64, h = T / steps;
    const f = (e, v, out) => { out[0] = v; out[1] = -wn2 * e - c2 * v; };
    const k1 = [0, 0], k2 = [0, 0], k3 = [0, 0], k4 = [0, 0];
    const run = (e, v) => {
        for (let i = 0; i < steps; i++) {
            f(e, v, k1);
            f(e + k1[0] * h / 2, v + k1[1] * h / 2, k2);
            f(e + k2[0] * h / 2, v + k2[1] * h / 2, k3);
            f(e + k3[0] * h, v + k3[1] * h, k4);
            e += (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) * h / 6;
            v += (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) * h / 6;
        }
        return [e, v];
    };
    const c0 = run(1, 0), c1 = run(0, 1);
    return [c0[0], c1[0], c0[1], c1[1]];
}

function grow(a) {
    const b = new Float32Array(a.length * 2);
    b.set(a);
    return b;
}

/** Couleur affichée (linéaire) d'une primitive à partir des puissances équilibrées par source */
export function displayColor(r, g, b, out) {
    out[0] = r * PRIM[0][0] + g * PRIM[1][0] + b * PRIM[2][0];
    out[1] = r * PRIM[0][1] + g * PRIM[1][1] + b * PRIM[2][1];
    out[2] = r * PRIM[0][2] + g * PRIM[1][2] + b * PRIM[2][2];
    return out;
}
