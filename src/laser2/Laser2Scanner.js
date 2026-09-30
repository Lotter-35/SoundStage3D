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

import { buildPatternFrames, LaserFrame } from './Laser2Patterns.js';
import { hexToRgb, scannerPps, LASER2_PARAMS_SCHEMA, SWEEP_SHAPES, COLOR_MODES, GRATINGS } from './config/laser2Params.js';

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
const TAU = Math.PI * 2;

/** Réglages qui changent le dessin (tout sauf placement, patch DMX et rendu) */
const SCANNER_KEYS = Object.entries(LASER2_PARAMS_SCHEMA)
    .filter(([k, s]) => !['place', 'dmx', 'smoke'].includes(s.folder) && !['visibility', 'forwardScatter', 'audienceMask'].includes(k))
    .map(([k]) => k);

/**
 * Clé de simulation : deux lasers avec la même clé dessinent exactement la même chose au même instant
 * (même contenu, mêmes galvos, mêmes effets) et peuvent partager une seule simulation.
 */
export function scannerKey(p, docKey = '') {
    return docKey + '|' + SCANNER_KEYS.map(k => p[k]).join('|');
}

/** Effets dépendant du temps recalculés tous les CHUNK échantillons (≈ 0,5 ms : invisible) */
const CHUNK = 16;

/** Vitesse d'effet 0…100 % → cycles par seconde */
const rate = (pct, max = 3) => 0.05 + max * Math.pow(Math.max(0, Math.min(100, pct)) / 100, 1.5);
const tri = (x) => { const f = x - Math.floor(x); return f < 0.5 ? 4 * f - 1 : 3 - 4 * f; }; // -1…1
const sq = (x) => (x - Math.floor(x) < 0.5 ? 1 : -1);
function hash(a, b) {
    const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return s - Math.floor(s);
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

        this._patternFrame = new LaserFrame(512);
        this._patternPool = [this._patternFrame];
        this._emptyFrame = new LaserFrame(1);
        this._emptyFrame.push(0, 0, 0, 0, 0);
        this.frame = this._patternFrame;     // image en cours de dessin
        this.frames = [this._patternFrame];  // images de la source (animation ILDA : plusieurs)
        this._doc = null;                    // forme ILDA (bibliothèque partagée)
        this._frameKey = '';
        this._cfgKey = '';
        this._animated = false;
        this._fixedIdx = 0;
        // Image courante de la simulation (_locate)
        this._lf = this._patternFrame;
        this._li = 0;
        this._lNext = Infinity;

        // Primitives (angles + puissances moyennes, en unités affichées)
        this.beams = new Float32Array(64 * 5);   // ax, ay, dr, dg, db
        this.sheets = new Float32Array(64 * 7);  // ax0, ay0, ax1, ay1, dr, dg, db
        this.beamCount = 0;
        this.sheetCount = 0;
        this.version = 0;                        // incrémenté quand les primitives changent

        this._static = false;
        this._staticSince = -1;
        this.stats = { points: 0, frameHz: 0, window: 0, beams: 0, sheets: 0, frames: 1 };
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
        } else {
            frameKey = `${p.pattern}|${p.density}|${p.cornerPoints}|${p.blankPoints}|${p.beamCount}|${p.beamDwell}|${p.fanSpread}|${p.fanBlend}`;
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
        this.lvl = ilda && !this.mono ? [dim, dim, dim] : [_rgb[0] * dim, _rgb[1] * dim, _rgb[2] * dim];
        this.chan = [pw[0] > 0 ? bal : 0, pw[1] > 0 ? bal : 0, pw[2] > 0 ? bal : 0];
        this.dimmer = dim;
        this.ttl = p.modulation !== 'Analogique';
        this.thr = p.threshold / 100;
        this.shift = Math.round(p.colorShift);
        this.shutter = p.shutter;
        this.strobeRate = p.strobeRate;
        this.divergence = p.divergence * 1e-3;
        this.persistence = p.persistence;

        const cfgKey = `${frameKey}|${this._docSerial || 0}|` + SCANNER_KEYS.map(k => p[k]).join('|');
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
        const canFreeze = this.persistence !== 'Caméra' && !this._dynamic && this.shutter !== 'Strobe'
            && !this._animated && this.frame.n <= Math.round(EYE_WINDOW * pps);

        // Image fixe redessinée en boucle : après 3 images simulées, le résultat ne change plus
        if (canFreeze && this._static) return false;

        if (!(kNow - this.k < RING - 64) || kNow < this.k - 2) {
            // Premier appel, saut d'horloge ou longue pause : on repart un peu avant la fenêtre
            // Animation : de quoi couvrir les créneaux complets de la persistance
            const span = this._animated ? Math.ceil((Math.round(EYE_WINDOW * this.fps) + 1) * pps / this.fps) : 0;
            const warm = Math.min(RING - 64 - win, 400 + this.frame.n + span);
            this.k = kNow - win - warm;
            const u = this._command(this.k);
            this.px = u[0]; this.py = u[1]; this.vx = 0; this.vy = 0;
        }
        if (kNow <= this.k) return false;
        this._simulate(this.k + 1, kNow);
        this.k = kNow;
        // Image en cours (animation) : fenêtre de persistance et statistiques
        if (this._animated) {
            this._locate(kNow);
            this.frame = this._lf;
        }

        if (this._animated && this.persistence !== 'Caméra') {
            // Animation : persistance calée sur des créneaux d'image COMPLETS (le dernier terminé et ceux
            // d'avant, ~40 ms) : chaque image compte entière, la luminosité ne papillote pas
            const s = Math.floor(kNow * this.fps / pps);
            const m = Math.max(1, Math.round(EYE_WINDOW * this.fps));
            const k1 = Math.ceil(s * pps / this.fps);
            const k0 = Math.max(Math.ceil((s - m) * pps / this.fps), kNow - (RING - 64) + 1);
            this._extract(k0, k1);
        } else {
            this._extract(kNow - win + 1, kNow + 1);
        }
        this.version++;

        if (canFreeze) {
            if (this._staticSince < 0) this._staticSince = kNow;
            else if (kNow - this._staticSince > this.frame.n * 3 + 400) this._static = true;
        }
        const n = this.frame.n;
        this.stats.points = n;
        this.stats.frameHz = pps / n;
        this.stats.window = win / pps;
        this.stats.frames = this.frames.length;
        this.stats.beams = this.beamCount;
        this.stats.sheets = this.sheetCount;
        return true;
    }

    /**
     * Image et point dessinés à l'échantillon k (déterministe : même résultat chez tous les joueurs).
     * Animation : l'image f occupe le créneau de temps [f / fps, (f + 1) / fps[ et y est redessinée
     * en boucle depuis le début du créneau. Résultat dans _lf (image), _li (point), _lNext (créneau suivant).
     */
    _locate(k) {
        if (!this._animated) {
            const f = this.frames[this._fixedIdx] || this.frames[0];
            this._lf = f;
            this._li = ((k % f.n) + f.n) % f.n;
            this._lNext = Infinity;
            this._lTail = Infinity;
            return;
        }
        const pps = this.pps, fps = this.fps, N = this.frames.length;
        const slot = Math.floor(k * fps / pps);
        let idx;
        if (this._pingPong) {
            const P = 2 * N - 2;
            const m = ((slot % P) + P) % P;
            idx = m < N ? m : P - m;
        } else {
            idx = ((slot % N) + N) % N;
        }
        const f = this.frames[idx];
        const start = Math.ceil(slot * pps / fps);
        const next = Math.ceil((slot + 1) * pps / fps);
        // Comme un vrai logiciel laser : l'image n'est jamais coupée en plein dessin. Seuls des passages
        // COMPLETS sont dessinés dans le créneau ; le reste du créneau, le laser attend éteint sur le
        // dernier point (sinon la partie déjà tracée reçoit plus d'énergie : bandes qui scintillent).
        const reps = Math.max(1, Math.floor((next - start) / f.n));
        this._lf = f;
        this._lNext = next;
        this._lTail = start + Math.min(next - start, reps * f.n);
        this._li = k >= this._lTail ? f.n - 1 : (((k - start) % f.n) + f.n) % f.n;
    }

    /** Consigne des miroirs pour l'échantillon k (rad) */
    _command(k) {
        this._locate(k);
        const f = this._lf;
        const i = this._li;
        const t = k / this.pps;
        this._timeFx(t);
        const a = this.rot0 + this.rotSpeed * t;
        return this._transform(f.x[i], f.y[i], Math.cos(a), Math.sin(a), _cmd);
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

    /** Point de l'image → consigne des miroirs (rad) : vague, rotations 3D et Z, zoom, taille, position, balayage */
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

    _simulate(k0, k1) {
        this._locate(k0);
        let f = this._lf;
        let n = f.n;
        let fx = f.x, fy = f.y, fr = f.r, fg = f.g, fb = f.b;
        let next = this._lNext;
        let tail = this._lTail;
        const mono = this.mono;
        const T = 1 / this.pps;
        const sub = this.sub, h = T / sub;
        const wn2 = this.wn * this.wn, c2 = 2 * this.zeta * this.wn;
        const [p00, p01, p10, p11] = this.phi;
        const amax = this.amax, vmax = this.vmax, lim = this.maxAngle * 1.05;
        let nextFx = k0;
        const drawAll = this.drawA <= 0 && this.drawB >= 1;
        const drawA = this.drawA, drawB = this.drawB, dotLen = this.dotLen;
        const cmode = this.colorMode;
        const lr = this.lvl[0], lg = this.lvl[1], lb = this.lvl[2];
        const cr = this.chan[0], cg = this.chan[1], cb = this.chan[2];
        const ttl = this.ttl, thr = this.thr;
        const strobe = this.shutter === 'Strobe', open = this.shutter !== 'Fermé';
        const rate = this.strobeRate;
        const rot = this.rotSpeed !== 0;
        // Rotation calculée de proche en proche (pas de cos / sin par point)
        const a0 = this.rot0 + this.rotSpeed * k0 * T;
        let rc = Math.cos(a0), rs = Math.sin(a0);
        const dc = Math.cos(this.rotSpeed * T), ds = Math.sin(this.rotSpeed * T);
        const shift = this.shift;
        let i = this._li;
        let j = (((i - shift) % n) + n) % n;   // couleur émise : point d'il y a `shift` échantillons
        let px = this.px, vx = this.vx, py = this.py, vy = this.vy;
        const AX = this.ax, AY = this.ay, UX = this.ux, UY = this.uy, PR = this.pr, PG = this.pg, PB = this.pb;

        for (let k = k0; k <= k1; k++) {
            if (k >= next) {
                // Image suivante de l'animation
                this._locate(k);
                f = this._lf; n = f.n;
                fx = f.x; fy = f.y; fr = f.r; fg = f.g; fb = f.b;
                next = this._lNext;
                tail = this._lTail;
                i = this._li;
                j = (((i - shift) % n) + n) % n;
            }
            // Fin de créneau : attente éteinte sur le dernier point de l'image
            const hold = k >= tail;
            if (hold) { i = n - 1; j = n - 1; }
            if (k >= nextFx) {
                this._timeFx(k * T);
                nextFx = k + CHUNK;
            }
            this._transform(fx[i], fy[i], rc, rs, _cmd);
            if (rot) {
                const cn = rc * dc - rs * ds;
                rs = rs * dc + rc * ds;
                rc = cn;
            }
            const ux = _cmd[0], uy = _cmd[1];

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
            let on = open && !hold;
            if (on && strobe) {
                const ph = k * T * rate;
                on = ph - Math.floor(ph) < 0.3;
            }
            // Tracé progressif (début / fin) et pointillés : sur le point émis
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
                    vr = fr[j] * lr; vg = fg[j] * lg; vb = fb[j] * lb;
                }
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
        let tol = 7e-4 * (this.tolScale || 1);
        for (let pass = 0; pass < 4; pass++) {
            if (this._extractPass(k0, k1, tol)) break;
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

    /** @returns {boolean} false si le budget de primitives est dépassé */
    _extractPass(k0, k1, tol) {
        const N = k1 - k0;
        const inv = 1 / N;                                   // énergie → puissance moyenne
        const dwellTol = Math.max(this.divergence * 0.5, 2.5e-4);
        // Une portion balayée reste une nappe même courte (couleur qui change à chaque point : nappe
        // multicolore, pas une rangée de faisceaux). Seul un trajet quasi immobile devient un faisceau.
        const minSheet = dwellTol;
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

/** Écart angulaire entre deux ordres du réseau de diffraction (rad) */
const GRATING_ANGLE = 4 * DEG;
const GRATING_OFFSETS = {
    3: [[-1, 0], [0, 0], [1, 0]],
    5: [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]],
    9: [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
};

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
