/**
 * Laser2Core.js — cœur de calcul des nouveaux lasers (sans Three.js : tourne dans un Web Worker,
 * ou sur le fil principal si les workers sont indisponibles).
 * ─────────────────────────────────────────────────────────────
 *  - LaserCore  : un laser (réglages, repère monde, forme ILDA) → géométrie monde :
 *                 faisceaux, nappes coupées sur les surfaces, traces d'impact, couleur de la lentille
 *  - CoreSystem : tous les lasers, avec
 *      · CACHE PARTAGÉ : les lasers qui dessinent exactement la même chose (même contenu, mêmes galvos,
 *        mêmes effets) partagent UNE simulation de scanner ; seule la géométrie monde reste par laser
 *      · BUDGET GLOBAL : au-delà d'un nombre de primitives, la simplification des trajectoires se renforce
 *        (et se relâche quand la charge baisse)
 * ─────────────────────────────────────────────────────────────
 */

import { Laser2Scanner, displayColor, scannerKey } from '../Laser2Scanner.js';
import { defaultLaser2Params } from '../config/laser2Params.js';
import { BEAM_STRIDE, SHEET_STRIDE, IMPACT_STRIDE } from './strides.js';
import { cullObstacles, laser2Hit, playersInCone, SURF_SKY, SURF_GROUND, SURF_PLAYER } from './Collision.js';
import { V3 } from './V3.js';

const DEG = Math.PI / 180;
/** Portée maximale d'un rayon (ciel) */
export const LASER2_RANGE = 1000;
/** Distance max à laquelle un joueur est testé */
const PLAYER_RANGE = 150;
/** Profondeur max de subdivision d'une nappe à la frontière de deux surfaces */
const MAX_DEPTH = 7;
/** Budget global de primitives (faisceaux + nappes) pour tous les lasers */
export const PRIM_BUDGET = 9000;

const _D = [0, 0, 0];
const _dA = new V3();
const _dB = new V3();
const _last = [NaN, NaN];
const newHit = () => ({ t: 0, id: SURF_SKY, nx: 0, ny: 1, nz: 0 });
const _hitA = newHit();
const _hitB = newHit();
const _hitBeam = newHit();
const _dStack = Array.from({ length: MAX_DEPTH + 2 }, () => new V3());
const _hStack = Array.from({ length: MAX_DEPTH + 2 }, newHit);
const _P0 = new V3();
const _P1 = new V3();

export class LaserCore {
    constructor(id) {
        this.id = id;
        this.params = defaultLaser2Params();
        this.origin = new V3();
        this.right = new V3(1, 0, 0);
        this.up = new V3(0, 1, 0);
        this.fwd = new V3(0, 0, 1);
        this.docKey = '';
        this.scanner = null;
        this.poolKey = '';
        this._placeVersion = 1;
        this._builtPlace = -1;
        this._geoVersion = -1;
        this._geoScanner = null;
        this._cullKey = '';
        this._boxes = new Int16Array(160);
        this._boxes[0] = -1;
        this._playersIn = false;

        this.beamData = new Float32Array(64 * BEAM_STRIDE);
        this.sheetData = new Float32Array(64 * SHEET_STRIDE);
        this.impactData = new Float32Array(64 * IMPACT_STRIDE);
        this.beamN = 0;
        this.sheetN = 0;
        this.impactN = 0;
        this.lens = [0, 0, 0];
        this.changed = true;      // géométrie modifiée depuis le dernier envoi
    }

    setParams(p) {
        Object.assign(this.params, p);
        this._placeVersion++;     // visibilité, masquage… : géométrie à refaire
    }

    /** Repère monde : sortie du faisceau + axes (droite, haut, avant) */
    setTransform(t) {
        this.origin.set(t[0], t[1], t[2]);
        this.right.set(t[3], t[4], t[5]);
        this.up.set(t[6], t[7], t[8]);
        this.fwd.set(t[9], t[10], t[11]);
        this._placeVersion++;
    }

    _coneHalf() {
        const a = Math.tan(this.params.maxAngle * DEG);
        return Math.atan(a * Math.SQRT2) + 0.03;
    }

    /** Géométrie monde (à appeler après la simulation du scanner) */
    build() {
        const sc = this.scanner;
        if (!sc) return;
        const half = this._coneHalf();
        const players = playersInCone(this.origin, this.fwd, half, PLAYER_RANGE);
        const wasIn = this._playersIn;
        this._playersIn = players;
        if (!players && !wasIn && sc === this._geoScanner && sc.version === this._geoVersion && this._builtPlace === this._placeVersion) return;
        const key = `${this._placeVersion}|${this.params.maxAngle}`;
        if (key !== this._cullKey) {
            cullObstacles(this.origin, this.fwd, half, LASER2_RANGE, this._boxes);
            this._cullKey = key;
        }
        this._buildWorld();
        this._geoScanner = sc;
        this._geoVersion = sc.version;
        this._builtPlace = this._placeVersion;
        this.changed = true;
    }

    /** Direction monde d'un couple d'angles optiques (X ILDA positif = droite vu de derrière le laser) */
    _dir(ax, ay, out) {
        const tx = -Math.tan(ax), ty = Math.tan(ay);
        out.copy(this.fwd).addScaledVector(this.right, tx).addScaledVector(this.up, ty).normalize();
        return out;
    }

    _hit(d, out) {
        return laser2Hit(this.origin, d, this._boxes, this._playersIn, LASER2_RANGE, out);
    }

    _buildWorld() {
        const sc = this.scanner;
        const p = this.params;
        const O = this.origin;
        const ap = p.aperture * 1e-3;
        const div = p.divergence * 1e-3;
        const g = Math.min(0.9, p.forwardScatter / 100);
        const vis = p.visibility;
        this._ap = ap; this._div = div; this._g = g; this._vis = vis;
        // Volutes : intensité, taille (m), vitesse, contraste (faisceaux : plus discrètes)
        const sm = p.smokeOn ? p.smokeAmount / 100 : 0;
        const sm4 = this._smoke || (this._smoke = [0, 0, 0, 0]);
        sm4[0] = sm; sm4[1] = Math.max(0.1, p.smokeScale); sm4[2] = (p.smokeSpeed / 100) * 1.5; sm4[3] = p.smokeContrast / 100;
        const smB = p.smokeBeams ? sm * 0.6 : 0;
        this.impactN = 0;
        let lr = 0, lg = 0, lb = 0;

        // Faisceaux (+ point d'impact sur la surface touchée)
        const nb = sc.beamCount;
        if (nb * BEAM_STRIDE > this.beamData.length) this.beamData = new Float32Array(Math.ceil(nb * 1.5 + 8) * BEAM_STRIDE);
        const B = this.beamData;
        let bn = 0;
        for (let i = 0; i < nb; i++) {
            const s = i * 5;
            displayColor(sc.beams[s + 2], sc.beams[s + 3], sc.beams[s + 4], _D);
            const M = Math.max(_D[0], _D[1], _D[2]);
            if (M <= 1e-6) continue;
            lr += _D[0]; lg += _D[1]; lb += _D[2];
            this._dir(sc.beams[s], sc.beams[s + 1], _dA);
            const h = this._hit(_dA, _hitBeam);
            // Masquage du public : le laser s'éteint dans les directions qui touchent le sol ou un joueur
            if (this._masked(h)) continue;
            const t = h.t;
            const o = bn++ * BEAM_STRIDE;
            B[o] = O.x; B[o + 1] = O.y; B[o + 2] = O.z; B[o + 3] = ap;
            B[o + 4] = O.x + _dA.x * t; B[o + 5] = O.y + _dA.y * t; B[o + 6] = O.z + _dA.z * t; B[o + 7] = div;
            B[o + 8] = _D[0] / M; B[o + 9] = _D[1] / M; B[o + 10] = _D[2] / M; B[o + 11] = M * vis;
            B[o + 12] = g;
            B[o + 13] = smB; B[o + 14] = sm4[1]; B[o + 15] = sm4[2]; B[o + 16] = sm4[3];
            if (h.id !== SURF_SKY) {
                _P0.set(B[o + 4], B[o + 5], B[o + 6]);
                this._pushImpact(_P0, _P0, h, ap + t * div, M * vis, _D, M);
            }
        }
        this.beamN = bn;

        // Nappes : coupées exactement sur chaque surface, subdivisées aux frontières
        const ns = sc.sheetCount;
        _last[0] = NaN;
        this._sn = 0;
        for (let i = 0; i < ns; i++) {
            const s = i * 7;
            displayColor(sc.sheets[s + 4], sc.sheets[s + 5], sc.sheets[s + 6], _D);
            const M = Math.max(_D[0], _D[1], _D[2]);
            if (M <= 1e-6) continue;
            lr += _D[0]; lg += _D[1]; lb += _D[2];
            const a0x = sc.sheets[s], a0y = sc.sheets[s + 1], a1x = sc.sheets[s + 2], a1y = sc.sheets[s + 3];
            // Les nappes s'enchaînent : le début de celle-ci est souvent la fin de la précédente
            if (a0x === _last[0] && a0y === _last[1]) {
                _dA.copy(_dB);
                copyHit(_hitA, _hitB);
            } else {
                this._dir(a0x, a0y, _dA);
                this._hit(_dA, _hitA);
            }
            this._dir(a1x, a1y, _dB);
            this._hit(_dB, _hitB);
            _last[0] = a1x; _last[1] = a1y;
            this._angle = Math.sqrt((a1x - a0x) * (a1x - a0x) + (a1y - a0y) * (a1y - a0y));
            this._M = M;
            this._piece(0, _dA, _hitA, 1, _dB, _hitB, 0);
        }
        this.sheetN = this._sn;

        // Lentille : couleur moyenne émise
        const lm = Math.max(lr, lg, lb);
        if (lm > 1e-6) {
            const k = Math.min(3, 0.6 + lm * 0.4) / lm;
            this.lens[0] = lr * k; this.lens[1] = lg * k; this.lens[2] = lb * k;
        } else {
            this.lens[0] = this.lens[1] = this.lens[2] = 0;
        }
    }

    /**
     * Portion [s0, s1] d'une nappe : émise telle quelle si ses deux bords touchent la même surface plane
     * (ou le ciel), sinon coupée en deux à mi-angle.
     */
    _piece(s0, d0, h0, s1, d1, h1, depth) {
        const span = (s1 - s0) * this._angle;
        let split = false;
        if (depth < MAX_DEPTH && span > 2e-4) {
            if (h0.id !== h1.id) split = true;
            else if (h0.id === SURF_PLAYER) split = span > 0.004;
            // Même surface aux deux bords mais obstacle au milieu (pilier…) : contrôle du milieu
            else if (depth === 0 && span > 0.009 && this._boxes[0] >= 0) {
                const dm = _dStack[0].lerpVectors(d0, d1, 0.5).normalize();
                split = this._hit(dm, _hStack[0]).id !== h0.id;
            }
        }
        if (!split) {
            this._emitPiece(s0, d0, h0, s1, d1, h1);
            return;
        }
        const sm = (s0 + s1) * 0.5;
        const dm = _dStack[depth + 1].lerpVectors(d0, d1, 0.5).normalize();
        const hm = this._hit(dm, _hStack[depth + 1]);
        this._piece(s0, d0, h0, sm, dm, hm, depth + 1);
        this._piece(sm, dm, hm, s1, d1, h1, depth + 1);
    }

    /** Direction masquée (public) : impact au sol ou sur un joueur */
    _masked(h) {
        if (!this.params.audienceMask) return false;
        return h.id === SURF_PLAYER || h.id === SURF_GROUND;
    }

    _emitPiece(s0, d0, h0, s1, d1, h1) {
        if (this._masked(h0) || this._masked(h1)) return;
        const O = this.origin;
        const f = s1 - s0;
        const angle = this._angle * f;
        const M = this._M * f;
        _P0.copy(O).addScaledVector(d0, h0.t);
        _P1.copy(O).addScaledVector(d1, h1.t);
        const need = (this._sn + 1) * SHEET_STRIDE;
        if (need > this.sheetData.length) this.sheetData = growF32(this.sheetData, need);
        const S = this.sheetData;
        const o = this._sn++ * SHEET_STRIDE;
        S[o] = O.x; S[o + 1] = O.y; S[o + 2] = O.z; S[o + 3] = this._ap;
        S[o + 4] = _P0.x; S[o + 5] = _P0.y; S[o + 6] = _P0.z; S[o + 7] = this._div;
        S[o + 8] = _P1.x; S[o + 9] = _P1.y; S[o + 10] = _P1.z; S[o + 11] = Math.max(angle, 1e-5);
        const m = Math.max(_D[0], _D[1], _D[2]);
        S[o + 12] = _D[0] / m; S[o + 13] = _D[1] / m; S[o + 14] = _D[2] / m; S[o + 15] = M * this._vis;
        S[o + 16] = this._g;
        const sm4 = this._smoke;
        S[o + 17] = sm4[0]; S[o + 18] = sm4[1]; S[o + 19] = sm4[2]; S[o + 20] = sm4[3];
        // Trait lumineux sur la surface touchée par les deux bords
        if (h0.id === h1.id && h0.id !== SURF_SKY) {
            const tm = (h0.t + h1.t) * 0.5;
            this._pushImpact(_P0, _P1, h0, this._ap + tm * this._div, M * this._vis, _D, m);
        }
    }

    /** Point (P0 = P1) ou trait lumineux sur une surface */
    _pushImpact(P0, P1, h, width, power, D, m) {
        const need = (this.impactN + 1) * IMPACT_STRIDE;
        if (need > this.impactData.length) this.impactData = growF32(this.impactData, need);
        const I = this.impactData;
        const o = this.impactN++ * IMPACT_STRIDE;
        I[o] = P0.x; I[o + 1] = P0.y; I[o + 2] = P0.z; I[o + 3] = width;
        I[o + 4] = P1.x; I[o + 5] = P1.y; I[o + 6] = P1.z; I[o + 7] = power;
        I[o + 8] = h.nx; I[o + 9] = h.ny; I[o + 10] = h.nz;
        I[o + 11] = D[0] / m; I[o + 12] = D[1] / m; I[o + 13] = D[2] / m;
    }
}

export class CoreSystem {
    constructor() {
        /** @type {Map<string, LaserCore>} */
        this.cores = new Map();
        /** Formes ILDA : clé → images { n, x, y, r, g, b } */
        this.docs = new Map();
        /** Simulations partagées : clé → { scanner, users } */
        this.pool = new Map();
        this.tolScale = 1;
        this.totalPrims = 0;
        this.shared = 0;
    }

    /** Crée / met à jour un laser : { params?, transform?, docKey? } */
    set(id, msg) {
        let c = this.cores.get(id);
        if (!c) { c = new LaserCore(id); this.cores.set(id, c); }
        if (msg.params) c.setParams(msg.params);
        if (msg.transform) c.setTransform(msg.transform);
        if (msg.docKey !== undefined) c.docKey = msg.docKey;
        c._dirtyCfg = true;
    }

    remove(id) {
        const c = this.cores.get(id);
        if (!c) return;
        this._release(c);
        this.cores.delete(id);
    }

    setDoc(key, frames) {
        // Image live : remplace la précédente du même canal (« live:N#série »)
        if (key.startsWith('live:')) {
            const prefix = key.slice(0, key.indexOf('#') + 1);
            for (const k of this.docs.keys()) if (k !== key && k.startsWith(prefix)) this.docs.delete(k);
        }
        this.docs.set(key, frames);
        for (const c of this.cores.values()) if (c.docKey === key) c._dirtyCfg = true;
    }

    _release(c) {
        if (!c.poolKey) return;
        const e = this.pool.get(c.poolKey);
        if (e && --e.users <= 0) this.pool.delete(c.poolKey);
        c.poolKey = '';
        c.scanner = null;
    }

    /** Simulation partagée correspondant aux réglages du laser */
    _acquire(c) {
        const ilda = c.params.source === 'Fichier ILDA' || c.params.source === 'ILDA live';
        const frames = ilda ? this.docs.get(c.docKey) : null;
        const docKey = ilda ? `${c.docKey}#${frames ? 1 : 0}` : '';
        const key = scannerKey(c.params, docKey);
        if (key === c.poolKey && c.scanner) return;
        const doc = frames ? { frames, path: c.docKey } : null;
        // Seul utilisateur de sa simulation et nouvelle clé inconnue (réglage modifié) : même simulation,
        // reconfigurée (pas de nouvelle allocation pendant qu'on déplace un curseur)
        const own = c.poolKey && this.pool.get(c.poolKey);
        if (own && own.users === 1 && !this.pool.has(key)) {
            this.pool.delete(c.poolKey);
            this.pool.set(key, own);
            c.poolKey = key;
            if (ilda) own.scanner.setDocument(doc);
            own.scanner.configure(c.params);
            return;
        }
        this._release(c);
        let e = this.pool.get(key);
        if (!e) {
            const scanner = new Laser2Scanner();
            if (ilda) scanner.setDocument(doc);
            scanner.configure(c.params);
            e = { scanner, users: 0 };
            this.pool.set(key, e);
        }
        e.users++;
        c.poolKey = key;
        c.scanner = e.scanner;
    }

    /**
     * Une image : simulations (une par clé partagée) puis géométrie monde de chaque laser.
     * @param {number} t horloge commune (s)
     */
    update(t) {
        for (const c of this.cores.values()) {
            if (c._dirtyCfg) { this._acquire(c); c._dirtyCfg = false; }
        }
        for (const e of this.pool.values()) {
            e.scanner.tolScale = this.tolScale;
            e.scanner.update(t);
        }
        let prims = 0;
        for (const c of this.cores.values()) {
            c.build();
            prims += c.beamN + c.sheetN;
        }
        this.totalPrims = prims;
        this.shared = this.cores.size - this.pool.size;
        // Budget global : simplification plus forte quand il y a trop de primitives à dessiner
        if (prims > PRIM_BUDGET) this.tolScale = Math.min(8, this.tolScale * 1.25);
        else if (prims < PRIM_BUDGET * 0.6 && this.tolScale > 1) this.tolScale = Math.max(1, this.tolScale / 1.1);
    }

    /** Aperçu du tracé d'un laser : consigne et trajectoire réelle sur 2 images (ou 40 ms) */
    preview(id) {
        const c = this.cores.get(id);
        const s = c && c.scanner;
        if (!s || !Number.isFinite(s.k)) return null;
        const win = Math.max(2, Math.min(s.frame.n * 2, Math.round(s.pps / 25), 4000));
        const out = { n: win, maxAngle: s.maxAngle, ux: new Float32Array(win), uy: new Float32Array(win), ax: new Float32Array(win), ay: new Float32Array(win), pr: new Float32Array(win), pg: new Float32Array(win), pb: new Float32Array(win) };
        const M = s.ax.length - 1;
        for (let i = 0; i < win; i++) {
            const o = (s.k - win + 1 + i) & M;
            out.ux[i] = s.ux[o]; out.uy[i] = s.uy[o]; out.ax[i] = s.ax[o]; out.ay[i] = s.ay[o];
            out.pr[i] = s.pr[o]; out.pg[i] = s.pg[o]; out.pb[i] = s.pb[o];
        }
        return out;
    }
}

function copyHit(dst, src) {
    dst.t = src.t; dst.id = src.id; dst.nx = src.nx; dst.ny = src.ny; dst.nz = src.nz;
}

function growF32(a, need) {
    let n = a.length;
    while (n < need) n *= 2;
    const b = new Float32Array(n);
    b.set(a);
    return b;
}
