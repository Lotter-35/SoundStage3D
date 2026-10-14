/**
 * Laser2Scanner.js
 * ─────────────────────────────────────────────────────────────
 * Le « cœur » d'un laser PARFAIT (sans défaut) :
 *
 *  1. IMAGE : à l'instant t (horloge COMMUNE à tous les joueurs → même image au même instant partout, sans
 *     aucun point envoyé sur le réseau), l'image courante est dessinée EN ENTIER, quel que soit son nombre de
 *     points : miroirs parfaits (aucune inertie, vitesse illimitée), pas de vitesse de balayage, jamais
 *     d'image partielle ni de scintillement. Animation : image choisie par l'horloge (images/s du contenu).
 *
 *  2. MODULATION : couleurs d'écran converties en puissances (la couleur affichée est celle choisie),
 *     analogique ou tout-ou-rien (TTL), équilibrage des blancs (une couleur choisie reste cette couleur,
 *     comme sur un laser calibré).
 *
 *  3. RÉDUCTION en primitives : la puissance est répartie également entre les points de l'image, puis
 *       - FAISCEAU : points confondus (point fixe) → énergie de ces points
 *       - NAPPE    : points qui se suivent le long d'un trait → énergie répartie sur l'angle balayé
 *     Un faisceau qui reçoit beaucoup de points est éclatant, une nappe large est plus sombre qu'une
 *     petite (même puissance étalée sur plus d'angle).
 *
 * Tout est en radians d'angle optique (repère du laser). Aucune allocation par image.
 * ─────────────────────────────────────────────────────────────
 */

import { buildPatternFrames, LaserFrame } from './Laser2Patterns.js';
import { hexToRgb, LASER2_PARAMS_SCHEMA, SWEEP_SHAPES, COLOR_MODES, GRATINGS } from './config/laser2Params.js';

const DEG = Math.PI / 180;

/** Primitives par laser au-delà desquelles la simplification est renforcée (jamais de primitive perdue) */
export const MAX_PRIMS = 700;

/** Formes ILDA : écart maximal entre deux points allumés (unités −1…1) — traits longs complétés */
const ILDA_STEP = 0.035;
/** Points au plus après complément d'une forme ILDA (au-delà, traits moins subdivisés ; la forme reste entière) */
const ILDA_MAX_POINTS = 20000;

// Rendement visuel relatif de chaque source (le bleu paraît moins lumineux à puissance égale)
const EFFICACY = [0.75, 1.0, 0.5];

const _rgb = [0, 0, 0];
const TAU = Math.PI * 2;

/** Réglages qui changent le dessin (tout sauf placement, patch DMX et rendu) */
const SCANNER_KEYS = Object.entries(LASER2_PARAMS_SCHEMA)
    .filter(([k, s]) => !['place', 'dmx', 'smoke'].includes(s.folder) && !['visibility', 'forwardScatter', 'audienceMask'].includes(k))
    .map(([k]) => k);

/**
 * Clé de simulation : deux lasers avec la même clé dessinent exactement la même chose au même instant
 * (même contenu, mêmes effets) et peuvent partager un seul calcul.
 */
export function scannerKey(p, docKey = '') {
    return docKey + '|' + SCANNER_KEYS.map(k => p[k]).join('|');
}

/** Vitesse d'effet 0…100 % → cycles par seconde */
const rate = (pct, max = 3) => 0.05 + max * Math.pow(Math.max(0, Math.min(100, pct)) / 100, 1.5);
const tri = (x) => { const f = x - Math.floor(x); return f < 0.5 ? 4 * f - 1 : 3 - 4 * f; }; // -1…1
const sq = (x) => (x - Math.floor(x) < 0.5 ? 1 : -1);
function hash(a, b) {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
}
/** Valeur d'écran (sRGB 0…1, sélecteur de couleur, fichiers ILDA) → puissance linéaire : la couleur affichée
 *  est celle qu'on a choisie (sinon 50 % de puissance paraît bien plus clair que « 80 » dans le sélecteur) */
function srgbToLinear(v) {
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Teinte (0…1) → RGB saturé */
function hue(h, out) {
    const x = (h - Math.floor(h)) * 6;
    const i = Math.floor(x), f = x - i, q = 1 - f;
    switch (i) {
        case 0: out[0] = 1; out[1] = f; out[2] = 0; break;
        case 1: out[0] = q; out[1] = 1; out[2] = 0; break;
        case 2: out[0] = 0; out[1] = 1; out[2] = f; break;
        case 3: out[0] = 0; out[1] = q; out[2] = 1; break;
        case 4: out[0] = f; out[1] = 0; out[2] = 1; break;
        default: out[0] = 1; out[1] = 0; out[2] = q;
    }
    return out;
}
const _hue = [0, 0, 0];
const SEGMENT_HUES = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6];

export class Laser2Scanner {
    constructor() {
        // Points de l'image courante (angles + puissances émises) ; indice 0 = dernier point (l'image se
        // referme sur elle-même), points 1…n = image
        this.ax = new Float32Array(1024);
        this.ay = new Float32Array(1024);
        this.pr = new Float32Array(1024);
        this.pg = new Float32Array(1024);
        this.pb = new Float32Array(1024);
        this.ready = false;                  // une image a été calculée

        this._patternFrame = new LaserFrame(512);
        this._patternPool = [this._patternFrame];
        this._emptyFrame = new LaserFrame(1);
        this._emptyFrame.push(0, 0, 0, 0, 0);
        this.frame = this._patternFrame;     // image affichée
        this.frames = [this._patternFrame];  // images de la source (animation ILDA : plusieurs)
        this._doc = null;                    // forme ILDA (bibliothèque partagée)
        this._frameKey = '';
        this._cfgKey = '';
        this._animated = false;
        this._fixedIdx = 0;
        this._dirty = true;                  // réglages changés : image à recalculer
        this._lastIdx = -1;
        this._lastOn = null;
        this._lastTol = 0;

        // Primitives (angles + puissances moyennes, en unités affichées)
        this.beams = new Float32Array(64 * 5);   // ax, ay, dr, dg, db
        this.sheets = new Float32Array(64 * 7);  // ax0, ay0, ax1, ay1, dr, dg, db
        this.beamCount = 0;
        this.sheetCount = 0;
        this.version = 0;                        // incrémenté quand les primitives changent

        this.stats = { points: 0, beams: 0, sheets: 0, frames: 1, fps: 0 };
    }

    /** Forme ILDA à projeter (null : rien, en attendant son chargement) */
    setDocument(doc) {
        if (doc === this._doc) return;
        this._doc = doc;
        this._docSerial = (this._docSerial || 0) + 1;
    }

    // ── Configuration (à chaque changement de paramètres) ─────────────────
    configure(p) {
        const ilda = p.source === 'Fichier ILDA' || p.source === 'ILDA live';
        let frameKey;
        if (ilda) {
            const doc = this._doc;
            this.frames = doc && doc.frames.length ? doc.frames : [this._emptyFrame];
            frameKey = `ilda|${doc ? doc.path : ''}|${this._docSerial || 0}|${this.frames.length}|${p.playMode}|${p.ildaFps}|${p.ildaFrame}|${p.ildaColor}`;
            this._docRef = doc;
            // Formes ILDA peu détaillées : points ajoutés le long des traits longs (luminosité égale le long du trait)
            this.frames = completeFrames(this.frames);
        } else {
            frameKey = `${p.pattern}|${p.density}|${p.beamCount}|${p.beamDwell}|${p.fanSpread}|${p.fanBlend}`;
            if (frameKey !== this._frameKey || this._docRef !== 'pattern') this._patternFrames = buildPatternFrames(p, this._patternPool);
            this.frames = this._patternFrames;
            this._docRef = 'pattern';
        }
        this._frameKey = frameKey;
        const N = this.frames.length;
        this._animated = N > 1 && p.playMode !== 'Image fixe';
        this._pingPong = p.playMode === 'Aller-retour';
        this._fixedIdx = Math.max(0, Math.min(N - 1, Math.round(p.ildaFrame)));
        this.fps = Math.max(1, p.ildaFps);
        this.frame = this.frames[this._animated ? 0 : this._fixedIdx];
        this.maxAngle = p.maxAngle * DEG;

        // Géométrie
        this.sx = p.sizeX / 100; this.sy = p.sizeY / 100;
        this.ox = p.offsetX / 100; this.oy = p.offsetY / 100;
        this.rot0 = p.rotation * DEG;
        this.rotSpeed = (p.rotSpeed / 100) * 2 * Math.PI;  // 100 % = 1 tour/s

        // Effets (tracé, pointillés, zoom, balayage, vague, rotations 3D, couleur, diffraction)
        this.drawA = Math.min(p.drawStart, p.drawEnd) / 100;
        this.drawB = Math.max(p.drawStart, p.drawEnd) / 100;
        this.dotLen = p.dots > 0 ? Math.max(1, Math.round(2 + (1 - p.dots / 100) * 18)) : 0;
        this.zoomMode = p.zoomFx === 'Pulse' ? 1 : p.zoomFx === 'Avant-arrière' ? 2 : 0;
        this.zoomRate = rate(p.zoomFxSpeed);
        this.swX = p.sweepX / 100; this.swY = p.sweepY / 100;
        this.swRate = rate(p.sweepSpeed, 2);
        this.swShape = Math.max(0, SWEEP_SHAPES.indexOf(p.sweepShape));
        this.waveA = (p.waveAmp / 100) * 0.5;
        this.waveW = TAU * (0.2 + 3 * p.waveSpeed / 100);
        this.rx0 = p.rotX * DEG; this.rxSpeed = (p.rotXSpeed / 100) * TAU;
        this.ry0 = p.rotY * DEG; this.rySpeed = (p.rotYSpeed / 100) * TAU;
        this.colorMode = Math.max(0, COLOR_MODES.indexOf(p.colorMode));
        this.colorRate = rate(p.colorSpeed, 2);
        this.grating = [1, 3, 5, 9][Math.max(0, GRATINGS.indexOf(p.grating))];
        this._dynamic = this.rotSpeed !== 0 || this.zoomMode !== 0 || this.swX > 0 || this.swY > 0
            || this.waveA > 0 || this.rxSpeed !== 0 || this.rySpeed !== 0 || this.colorMode >= 2
            || (this.colorMode === 1 && p.colorSpeed > 0);

        // Couleur et modulation (équilibrage des blancs : chaque source ramenée à la plus faible)
        hexToRgb(p.color, _rgb);
        const dim = Math.max(0, Math.min(1, p.dimmer / 100));
        const pw = [p.powerR, p.powerG, p.powerB];
        let bal = Infinity;
        for (let c = 0; c < 3; c++) if (pw[c] > 0) bal = Math.min(bal, pw[c] * EFFICACY[c]);
        if (!Number.isFinite(bal)) bal = 0;
        // Fichier ILDA : ses propres couleurs (× dimmer) ou sa luminosité teintée par la couleur du laser
        this.mono = ilda && p.ildaColor === 'Couleur du laser';
        // Couleurs d'écran converties en puissances linéaires : la couleur affichée est celle choisie
        for (let c = 0; c < 3; c++) _rgb[c] = srgbToLinear(_rgb[c]);
        this.lvl = ilda && !this.mono ? [dim, dim, dim] : [_rgb[0] * dim, _rgb[1] * dim, _rgb[2] * dim];
        this.chan = [pw[0] > 0 ? bal : 0, pw[1] > 0 ? bal : 0, pw[2] > 0 ? bal : 0];
        this.dimmer = dim;
        this.ttl = p.modulation !== 'Analogique';
        this.shutter = p.shutter;
        this.strobeRate = p.strobeRate;
        this.divergence = p.divergence * 1e-3;

        const cfgKey = `${frameKey}|${this._docSerial || 0}|` + SCANNER_KEYS.map(k => p[k]).join('|');
        if (cfgKey !== this._cfgKey) {
            this._cfgKey = cfgKey;
            this._dirty = true;
        }
    }

    /** Image de la source affichée à l'instant t (animation : créneau de l'horloge commune) */
    _frameIndex(t) {
        if (!this._animated) return this._fixedIdx;
        const N = this.frames.length;
        const slot = Math.floor(t * this.fps);
        if (this._pingPong) {
            const P = 2 * N - 2;
            const m = ((slot % P) + P) % P;
            return m < N ? m : P - m;
        }
        return ((slot % N) + N) % N;
    }

    // ── Image à l'instant t (horloge commune) ─────────────────────────────
    /**
     * @param {number} t temps commun (s)
     * @returns {boolean} true si les primitives ont changé
     */
    update(t) {
        const idx = this._frameIndex(t);
        let on = this.shutter !== 'Fermé';
        if (on && this.shutter === 'Strobe') {
            const ph = t * this.strobeRate;
            on = ph - Math.floor(ph) < 0.3;
        }
        const tol = this.tolScale || 1;
        // Rien n'a changé (image fixe, pas d'effet qui dépend du temps) : primitives inchangées
        if (!this._dirty && !this._dynamic && idx === this._lastIdx && on === this._lastOn && tol === this._lastTol) return false;
        this._dirty = false;
        this._lastIdx = idx;
        this._lastOn = on;
        this._lastTol = tol;

        const f = this.frames[idx] || this.frames[0];
        this.frame = f;
        const n = f.n;
        if (n > 0) {
            if (n + 1 > this.ax.length) this._growPoints(n + 1);
            this._draw(f, t, on);
            this._extract(1, n + 1);
        } else {
            this.beamCount = 0;
            this.sheetCount = 0;
        }
        this.ready = true;
        this.version++;

        this.stats.points = n;
        this.stats.fps = this.fps;
        this.stats.frames = this.frames.length;
        this.stats.beams = this.beamCount;
        this.stats.sheets = this.sheetCount;
        return true;
    }

    _growPoints(need) {
        let cap = this.ax.length;
        while (cap < need) cap *= 2;
        for (const k of ['ax', 'ay', 'pr', 'pg', 'pb']) this[k] = new Float32Array(cap);
    }

    /**
     * Effets qui ne dépendent que du temps (horloge commune) : zoom automatique, balayage,
     * rotations 3D, phase de la vague et des effets de couleur.
     */
    _timeFx(t) {
        let z = 1;
        if (this.zoomMode === 1) z = 1 - 0.5 * (0.5 - 0.5 * Math.cos(TAU * this.zoomRate * t));
        else if (this.zoomMode === 2) z = 0.5 - 0.5 * Math.cos(TAU * this.zoomRate * t);
        this._zs = z;
        let sx = 0, sy = 0;
        if (this.swX > 0 || this.swY > 0) {
            const ph = this.swRate * t;
            switch (this.swShape) {
                case 0: sx = Math.sin(TAU * ph); sy = sx; break;                       // sinus
                case 1: sx = tri(ph); sy = sx; break;                                   // triangle
                case 2: sx = sq(ph); sy = sx; break;                                    // carré
                case 3: sx = Math.cos(TAU * ph); sy = Math.sin(TAU * ph); break;        // cercle
                case 4: sx = Math.sin(TAU * ph); sy = Math.sin(2 * TAU * ph); break;    // huit
                default:                                                                // aléatoire (lisse)
                    sx = 0.6 * Math.sin(TAU * ph * 1.13) + 0.4 * Math.sin(TAU * ph * 2.71 + 1.3);
                    sy = 0.6 * Math.sin(TAU * ph * 0.87 + 2.1) + 0.4 * Math.sin(TAU * ph * 2.29 + 0.4);
            }
        }
        this._swx = sx * this.swX;
        this._swy = sy * this.swY;
        this._c3x = Math.cos(this.rx0 + this.rxSpeed * t);
        this._c3y = Math.cos(this.ry0 + this.rySpeed * t);
        this._wph = this.waveW * t;
        this._cph = this.colorRate * t;
    }

    /** Point de l'image → angle des miroirs (rad) : vague, rotations 3D et Z, zoom, taille, position, balayage */
    _transform(x, y, rc, rs, out) {
        if (this.waveA > 0) y += this.waveA * Math.sin(x * 1.5 * TAU - this._wph);
        x *= this._c3y;
        y *= this._c3x;
        const xr = x * rc - y * rs;
        y = x * rs + y * rc;
        x = xr * this._zs * this.sx + this.ox + this._swx;
        y = y * this._zs * this.sy + this.oy + this._swy;
        out[0] = (x < -1 ? -1 : x > 1 ? 1 : x) * this.maxAngle;
        out[1] = (y < -1 ? -1 : y > 1 ? 1 : y) * this.maxAngle;
        return out;
    }

    /** Toute l'image à l'instant t : angles et puissances des points 1…n (point 0 = point n) */
    _draw(f, t, open) {
        const n = f.n;
        const fx = f.x, fy = f.y, fr = f.r, fg = f.g, fb = f.b;
        const mono = this.mono;
        const drawAll = this.drawA <= 0 && this.drawB >= 1;
        const drawA = this.drawA, drawB = this.drawB, dotLen = this.dotLen;
        const cmode = this.colorMode;
        const lr = this.lvl[0], lg = this.lvl[1], lb = this.lvl[2];
        const cr = this.chan[0], cg = this.chan[1], cb = this.chan[2];
        const ttl = this.ttl;
        this._timeFx(t);
        const a = this.rot0 + this.rotSpeed * t;
        const rc = Math.cos(a), rs = Math.sin(a);
        const AX = this.ax, AY = this.ay, PR = this.pr, PG = this.pg, PB = this.pb;

        for (let j = 0; j < n; j++) {
            this._transform(fx[j], fy[j], rc, rs, _cmd);
            let r = 0, g = 0, b = 0;
            let on = open;
            // Tracé progressif (début / fin) et pointillés
            if (on && !drawAll) {
                const fr01 = j / n;
                on = fr01 >= drawA && fr01 <= drawB;
            }
            if (on && dotLen > 0) on = ((j / dotLen) | 0) % 2 === 0;
            if (on) {
                let vr, vg, vb;
                if (cmode > 0) {
                    // Effets de couleur : luminosité du point × couleur de l'effet
                    const m = fr[j] > fg[j] ? (fr[j] > fb[j] ? fr[j] : fb[j]) : (fg[j] > fb[j] ? fg[j] : fb[j]);
                    const u = j / n, cph = this._cph;
                    const dim = this.dimmer;
                    if (cmode === 1) hue(SEGMENT_HUES[(Math.floor(u * 6 + cph) % 6 + 6) % 6], _hue);
                    else if (cmode === 2) hue(u + cph, _hue);
                    else if (cmode === 4) hue(hash(j, Math.floor(cph * 4)), _hue);
                    _hue[0] = srgbToLinear(_hue[0]); _hue[1] = srgbToLinear(_hue[1]); _hue[2] = srgbToLinear(_hue[2]);
                    if (cmode === 3) {
                        // Chenillard : bande lumineuse qui parcourt le tracé (couleur du laser)
                        let d = Math.abs(u - (cph - Math.floor(cph)));
                        if (d > 0.5) d = 1 - d;
                        const kk = 0.12 + 0.88 * Math.exp(-(d * d) / 0.006);
                        vr = m * lr * kk; vg = m * lg * kk; vb = m * lb * kk;
                    } else {
                        vr = m * _hue[0] * dim; vg = m * _hue[1] * dim; vb = m * _hue[2] * dim;
                    }
                } else if (mono) {
                    const m = fr[j] > fg[j] ? (fr[j] > fb[j] ? fr[j] : fb[j]) : (fg[j] > fb[j] ? fg[j] : fb[j]);
                    vr = m * lr; vg = m * lg; vb = m * lb;
                } else {
                    vr = srgbToLinear(fr[j]) * lr; vg = srgbToLinear(fg[j]) * lg; vb = srgbToLinear(fb[j]) * lb;
                }
                if (ttl) {
                    // Tout ou rien : diode allumée au-delà de la moitié de la valeur d'écran (0,5 → 0,214 en linéaire)
                    r = vr >= 0.214 ? cr : 0; g = vg >= 0.214 ? cg : 0; b = vb >= 0.214 ? cb : 0;
                } else {
                    r = vr * cr; g = vg * cg; b = vb * cb;
                }
            }
            const o = j + 1;
            AX[o] = _cmd[0]; AY[o] = _cmd[1];
            PR[o] = r; PG[o] = g; PB[o] = b;
        }
        // L'image se referme : le point qui précède le premier est le dernier
        AX[0] = AX[n]; AY[0] = AY[n]; PR[0] = PR[n]; PG[0] = PG[n]; PB[0] = PB[n];
    }

    // ── Réduction de l'image en primitives ────────────────────────────────
    _extract(k0, k1) {
        // Trop de primitives : traits regroupés plus largement ; la dernière passe garde tout
        let tol = 7e-4 * (this.tolScale || 1);
        for (let pass = 0; pass < 4; pass++) {
            if (this._extractPass(k0, k1, tol, pass < 3 ? MAX_PRIMS : Infinity)) break;
            tol *= 2;
        }
        if (this.grating > 1) this._applyGrating();
    }

    /**
     * Réseau de diffraction : le faisceau est divisé en plusieurs faisceaux simultanés décalés d'un angle
     * fixe (×3 en ligne, ×5 en croix, ×9 en grille), la puissance est partagée entre les copies.
     */
    _applyGrating() {
        const offs = GRATING_OFFSETS[this.grating];
        const m = offs.length;
        const k = 1 / m;
        const nb = this.beamCount, ns = this.sheetCount;
        while (nb * m * 5 > this.beams.length) this.beams = grow(this.beams);
        while (ns * m * 7 > this.sheets.length) this.sheets = grow(this.sheets);
        const B = this.beams, S = this.sheets;
        // Copies écrites de la fin vers le début (l'original est lu avant d'être écrasé)
        for (let i = nb - 1; i >= 0; i--) {
            const x = B[i * 5], y = B[i * 5 + 1], r = B[i * 5 + 2] * k, g = B[i * 5 + 3] * k, b = B[i * 5 + 4] * k;
            for (let c = m - 1; c >= 0; c--) {
                const o = (i * m + c) * 5;
                B[o] = x + offs[c][0] * GRATING_ANGLE; B[o + 1] = y + offs[c][1] * GRATING_ANGLE;
                B[o + 2] = r; B[o + 3] = g; B[o + 4] = b;
            }
        }
        for (let i = ns - 1; i >= 0; i--) {
            const q = i * 7;
            const x0 = S[q], y0 = S[q + 1], x1 = S[q + 2], y1 = S[q + 3];
            const r = S[q + 4] * k, g = S[q + 5] * k, b = S[q + 6] * k;
            for (let c = m - 1; c >= 0; c--) {
                const o = (i * m + c) * 7;
                const dx = offs[c][0] * GRATING_ANGLE, dy = offs[c][1] * GRATING_ANGLE;
                S[o] = x0 + dx; S[o + 1] = y0 + dy; S[o + 2] = x1 + dx; S[o + 3] = y1 + dy;
                S[o + 4] = r; S[o + 5] = g; S[o + 6] = b;
            }
        }
        this.beamCount = nb * m;
        this.sheetCount = ns * m;
    }

    /** @returns {boolean} false si plus de `limit` primitives (passe interrompue) */
    _extractPass(k0, k1, tol, limit) {
        const N = k1 - k0;
        const inv = 1 / N;                                   // puissance répartie entre les points de l'image
        const dwellTol = Math.max(this.divergence * 0.5, 2.5e-4);
        // Une portion balayée reste une nappe même courte (couleur qui change à chaque point : nappe
        // multicolore, pas une rangée de faisceaux). Seul un trajet quasi immobile devient un faisceau.
        const minSheet = dwellTol;
        this.beamCount = 0;
        this.sheetCount = 0;
        let over = false;

        // État courant : 0 rien, 1 faisceau, 2 nappe
        let mode = 0;
        let bx = 0, by = 0, bw = 0, br = 0, bg = 0, bb = 0, bn = 0;  // faisceau (position pondérée, points)
        let sx0 = 0, sy0 = 0, sx1 = 0, sy1 = 0, sr = 0, sg = 0, sb = 0; // nappe
        let sL = 0, sd0 = 0, sdx = 0, sdy = 0, sProj = 0, sLevel = 0, sCount = 0;
        let prevLit = false, qx = 0, qy = 0;

        const emitBeam = (x, y, r, g, b) => {
            // Fusion avec un faisceau déjà émis au même endroit (point repris plus loin dans l'image)
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
            if (this.beamCount + this.sheetCount >= limit) { over = true; return; }
            if ((this.beamCount + 1) * 5 > B.length) this.beams = grow(B);
            const o = this.beamCount++ * 5;
            const A = this.beams;
            A[o] = x; A[o + 1] = y; A[o + 2] = r; A[o + 3] = g; A[o + 4] = b;
        };
        const closeBeam = () => {
            if (bw > 0) emitBeam(bx / bw, by / bw, br * inv, bg * inv, bb * inv);
            bw = 0; br = bg = bb = 0; bx = by = 0; bn = 0;
        };
        const closeSheet = () => {
            if (sL < minSheet) {
                if (sr + sg + sb > 0) emitBeam((sx0 + sx1) * 0.5, (sy0 + sy1) * 0.5, sr * inv, sg * inv, sb * inv);
            } else if (this.beamCount + this.sheetCount >= limit) {
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
        // Continuité : le trait qui mène au premier point part du point d'avant (sinon ce premier point
        // devient un faux faisceau fixe et le petit bout de trait manque à la nappe)
        {
            const o = k0 - 1;
            if (PR[o] + PG[o] + PB[o] > 1e-6) { prevLit = true; qx = AX[o]; qy = AY[o]; }
        }
        for (let o = k0; o < k1; o++) {
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
                if (mode !== 1) { mode = 1; bw = 0; br = bg = bb = 0; bx = by = 0; bn = 0; }
                bx += x * lvl; by += y * lvl; bw += lvl;
                br += r; bg += g; bb += b; bn++;
            } else {
                if (mode === 1) {
                    // Un seul point avant le trait (son point de départ) : il appartient au trait, pas un faisceau
                    const lone = bn === 1, cr = br, cg = bg, cb = bb;
                    if (lone) { bw = 0; br = bg = bb = 0; bx = by = 0; bn = 0; } else closeBeam();
                    startSheet(qx, qy);
                    if (lone) { sr = cr; sg = cg; sb = cb; }
                    mode = 2;
                }
                else if (mode === 0) { startSheet(qx, qy); mode = 2; }
                else {
                    // Le segment peut-il prolonger la nappe courante ? (droit, même pas, même couleur)
                    const ex = x - sx0, ey = y - sy0;
                    const proj = ex * sdx + ey * sdy;
                    const perp = Math.abs(ex * sdy - ey * sdx);
                    const ratio = d / sd0;
                    // Écart entre points quasi constant dans un morceau : quand les points se resserrent, la
                    // luminosité monte en dégradé fin au lieu de marches visibles (traits dans la nappe)
                    let cut = perp > tol || proj <= sProj || ratio < 0.88 || ratio > 1.14;
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

// ─── Formes ILDA complétées : points ajoutés le long des traits longs ────────
const _completed = new WeakMap();   // image d'origine → image complétée

/**
 * Images prêtes à projeter : points ajoutés le long des traits longs (la puissance étant répartie entre les
 * points, un long trait de 2 points paraîtrait bien plus sombre qu'un petit). Une forme déjà bien détaillée
 * reste identique ; une forme énorme est moins subdivisée, mais toujours dessinée en entier.
 */
function completeFrames(frames) {
    return frames.map((f) => {
        const hit = _completed.get(f);
        if (hit) return hit;
        let step = ILDA_STEP;
        let out = completeFrame(f, step);
        for (let i = 0; i < 4 && out.n > ILDA_MAX_POINTS && out.n > f.n; i++) {
            step *= out.n / ILDA_MAX_POINTS;
            out = completeFrame(f, step);
        }
        if (out.n > ILDA_MAX_POINTS && out.n > f.n) out = f;
        _completed.set(f, out);
        return out;
    });
}

function completeFrame(f, step) {
    const n = f.n;
    if (n < 2) return f;
    const out = new LaserFrame(n * 2 + 32);
    const lit = (i) => f.r[i] + f.g[i] + f.b[i] > 1e-4;
    for (let i = 0; i < n; i++) {
        const p = (i - 1 + n) % n;
        const x = f.x[i], y = f.y[i], r = f.r[i], g = f.g[i], b = f.b[i];
        if (lit(i) && lit(p)) {
            // Trait allumé : points intermédiaires (couleur du point d'arrivée, norme ILDA)
            const dx = x - f.x[p], dy = y - f.y[p];
            const k = Math.ceil(Math.sqrt(dx * dx + dy * dy) / step);
            for (let s = 1; s < k; s++) out.push(f.x[p] + dx * s / k, f.y[p] + dy * s / k, r, g, b);
        }
        out.push(x, y, r, g, b);
    }
    return out.n === n ? f : out;
}

/** Écart angulaire entre deux ordres du réseau de diffraction (rad) */
const GRATING_ANGLE = 4 * DEG;
const GRATING_OFFSETS = {
    3: [[-1, 0], [0, 0], [1, 0]],
    5: [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]],
    9: [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
};

function grow(a) {
    const b = new Float32Array(a.length * 2);
    b.set(a);
    return b;
}
