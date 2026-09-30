/**
 * Laser2Fixture.js
 * ─────────────────────────────────────────────────────────────
 * Un nouveau laser (moteur de points + galvos) posé dans la scène :
 *   - paramètres (panneau, réseau multijoueur, DMX plus tard)
 *   - simulation du scanner (Laser2Scanner) sur l'horloge commune
 *   - conversion des primitives (angles) en géométrie monde : faisceaux et nappes, coupés au sol
 *   - boîtier instancié + lentille qui prend la couleur émise
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { LASER2_PARAMS_SCHEMA, HARDWARE_PRESETS, defaultLaser2Params } from './config/laser2Params.js';
import { Laser2Scanner, displayColor } from './Laser2Scanner.js';
import { BEAM_STRIDE, SHEET_STRIDE, IMPACT_STRIDE } from './Laser2Batch.js';
import { cullObstacles, laser2Hit, playersInCone, SURF_SKY, SURF_PLAYER } from './Laser2Collision.js';
import { getLaser2HousingInstancer, APERTURE_Z, BODY } from './Laser2Housing.js';

const DEG = Math.PI / 180;
/** Portée maximale d'un rayon (ciel) */
export const LASER2_RANGE = 1000;
/** Distance max à laquelle un joueur est testé (au-delà, les capsules sont ignorées) */
const PLAYER_RANGE = 150;
/** Profondeur max de subdivision d'une nappe à la frontière de deux surfaces */
const MAX_DEPTH = 7;

const PLACEMENT_KEYS = new Set(['posX', 'posY', 'posZ', 'yaw', 'pitch', 'roll']);

const _D = [0, 0, 0];
const _dA = new THREE.Vector3();
const _dB = new THREE.Vector3();
const _last = [NaN, NaN];
const newHit = () => ({ t: 0, id: SURF_SKY, nx: 0, ny: 1, nz: 0 });
const _hitA = newHit();
const _hitB = newHit();
const _hitBeam = newHit();
// Pile de subdivision (1 direction + 1 impact par niveau, 0 allocation)
const _dStack = Array.from({ length: MAX_DEPTH + 2 }, () => new THREE.Vector3());
const _hStack = Array.from({ length: MAX_DEPTH + 2 }, newHit);
const _P0 = new THREE.Vector3();
const _P1 = new THREE.Vector3();

export class Laser2Fixture {
    /**
     * @param {object} o
     * @param {string} o.id
     * @param {number} o.number
     * @param {THREE.Scene} o.scene
     * @param {() => number} o.clock horloge commune (s)
     * @param {object} [o.params]
     */
    constructor({ id, number, scene, clock, params = {} }) {
        this.id = id;
        this.number = number;
        this.isLaser2 = true;
        this.scene = scene;
        this.clock = clock;
        this.params = { ...defaultLaser2Params(), ...params };

        this.group = new THREE.Group();
        this.group.name = `Laser2_${id}`;
        this.group.userData.laser2Instance = this;
        scene.add(this.group);

        this._instancer = getLaser2HousingInstancer(scene);
        this._slot = this._instancer.alloc();
        this.pickMesh = new THREE.Mesh(this._instancer.pickGeometry, this._instancer.pickMaterial);
        this.pickMesh.name = 'laser2-pick';
        this.pickMesh.userData.laser2Instance = this;
        this.pickMesh.scale.set(BODY.w + 0.1, BODY.h + 0.1, BODY.d + 0.1);
        this.group.add(this.pickMesh);

        this.scanner = new Laser2Scanner();
        this._cfgDirty = true;
        this.isBeingDragged = false;

        // Repère monde du laser (mis à jour avec la position / l'orientation)
        this.origin = new THREE.Vector3();
        this.right = new THREE.Vector3();
        this.up = new THREE.Vector3();
        this.fwd = new THREE.Vector3();
        this._geoVersion = -1;
        this._placeVersion = 0;
        this._builtPlace = -1;

        // Instances GPU de ce laser (réutilisées)
        this.beamData = new Float32Array(64 * BEAM_STRIDE);
        this.sheetData = new Float32Array(64 * SHEET_STRIDE);
        this.impactData = new Float32Array(64 * IMPACT_STRIDE);
        this.beamN = 0;
        this.sheetN = 0;
        this.impactN = 0;

        // Obstacles pouvant entrer dans le cône de balayage (recalculés quand le laser bouge)
        this._boxes = new Int16Array(160);
        this._boxes[0] = -1;
        this._cullKey = '';
        this._playersIn = false;

        this.applyTransform();
    }

    get displayName() { return `Laser #${this.number}`; }

    // ── Paramètres ────────────────────────────────────────────────────────
    setParam(key, value) {
        this.setParams({ [key]: value });
    }

    setParams(obj) {
        let placement = false;
        // Choix d'un modèle : sa fiche technique (puissances, scanners, optique) est appliquée
        const preset = obj.preset && HARDWARE_PRESETS[obj.preset];
        if (preset) obj = { ...preset, ...obj };
        for (const [k, v] of Object.entries(obj)) {
            if (!(k in LASER2_PARAMS_SCHEMA)) continue;
            this.params[k] = v;
            if (PLACEMENT_KEYS.has(k)) placement = true;
        }
        this._cfgDirty = true;
        if (placement) this.applyTransform();
    }

    applyTransform() {
        const p = this.params;
        this.group.position.set(p.posX, p.posY, p.posZ);
        this.group.rotation.set(p.pitch * DEG, p.yaw * DEG, p.roll * DEG, 'YXZ');
        this._afterTransform();
    }

    syncFromGizmo() {
        const p = this.params;
        const pos = this.group.position;
        p.posX = Math.round(pos.x * 100) / 100;
        p.posY = Math.round(pos.y * 100) / 100;
        p.posZ = Math.round(pos.z * 100) / 100;
        const e = new THREE.Euler().setFromQuaternion(this.group.quaternion, 'YXZ');
        p.pitch = Math.round(e.x / DEG * 10) / 10;
        p.yaw = Math.round(e.y / DEG * 10) / 10;
        p.roll = Math.round(e.z / DEG * 10) / 10;
        this._afterTransform();
    }

    _afterTransform() {
        this.group.updateMatrixWorld(true);
        const m = this.group.matrixWorld;
        this.right.setFromMatrixColumn(m, 0).normalize();
        this.up.setFromMatrixColumn(m, 1).normalize();
        this.fwd.setFromMatrixColumn(m, 2).normalize();
        this.origin.set(0, 0, APERTURE_Z).applyMatrix4(m);
        this._instancer.write(this._slot, m);
        this._placeVersion++;
    }

    getPlacement() {
        const p = this.params;
        return { posX: p.posX, posY: p.posY, posZ: p.posZ, yaw: p.yaw, pitch: p.pitch, roll: p.roll };
    }

    getPickableObjects() {
        return [this.pickMesh];
    }

    // ── Mise à jour par image ─────────────────────────────────────────────
    update() {
        if (this._cfgDirty) {
            this.scanner.configure(this.params);
            this._cfgDirty = false;
        }
        if (this.isBeingDragged) this.syncFromGizmo();
        this.scanner.update(this.clock());
        // Joueurs dans le cône : impacts sur les corps recalculés à chaque image
        const half = this._coneHalf();
        const players = playersInCone(this.origin, this.fwd, half, PLAYER_RANGE);
        const wasIn = this._playersIn;
        this._playersIn = players;
        if (players || wasIn || this.scanner.version !== this._geoVersion || this._builtPlace !== this._placeVersion) {
            const key = `${this._placeVersion}|${this.params.maxAngle}`;
            if (key !== this._cullKey) {
                cullObstacles(this.origin, this.fwd, half, LASER2_RANGE, this._boxes);
                this._cullKey = key;
            }
            this._buildWorld();
            this._geoVersion = this.scanner.version;
            this._builtPlace = this._placeVersion;
        }
    }

    /** Direction monde d'un couple d'angles optiques (X ILDA positif = droite vu de derrière le laser) */
    _dir(ax, ay, out) {
        const tx = -Math.tan(ax), ty = Math.tan(ay);
        out.copy(this.fwd).addScaledVector(this.right, tx).addScaledVector(this.up, ty).normalize();
        return out;
    }

    /** Demi-angle du cône de balayage (diagonale du carré ±angle max) */
    _coneHalf() {
        const a = Math.tan(this.params.maxAngle * DEG);
        return Math.atan(a * Math.SQRT2) + 0.03;
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
            const t = h.t;
            const o = bn++ * BEAM_STRIDE;
            B[o] = O.x; B[o + 1] = O.y; B[o + 2] = O.z; B[o + 3] = ap;
            B[o + 4] = O.x + _dA.x * t; B[o + 5] = O.y + _dA.y * t; B[o + 6] = O.z + _dA.z * t; B[o + 7] = div;
            B[o + 8] = _D[0] / M; B[o + 9] = _D[1] / M; B[o + 10] = _D[2] / M; B[o + 11] = M * vis;
            B[o + 12] = g;
            if (h.id !== SURF_SKY) {
                _P0.set(B[o + 4], B[o + 5], B[o + 6]);
                this._pushImpact(_P0, _P0, h, ap + t * div, M * vis, _D, M);
            }
        }
        this.beamN = bn;

        // Nappes : coupées exactement sur chaque surface, subdivisées aux frontières
        const ns = sc.sheetCount;
        _last[0] = NaN;
        let sn = 0;
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
        sn = this._sn;
        this.sheetN = sn;

        // Lentille : couleur moyenne émise
        const lm = Math.max(lr, lg, lb);
        if (lm > 1e-6) {
            const k = Math.min(3, 0.6 + lm * 0.4) / lm;
            this._instancer.lensColor(this._slot, lr * k, lg * k, lb * k);
        } else {
            this._instancer.lensColor(this._slot, 0, 0, 0);
        }
    }

    /**
     * Portion [s0, s1] d'une nappe (directions d0, d1 et leurs impacts) : émise telle quelle si ses deux
     * bords touchent la même surface plane (ou le ciel), sinon coupée en deux à mi-angle.
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

    _emitPiece(s0, d0, h0, s1, d1, h1) {
        const O = this.origin;
        const f = s1 - s0;
        const angle = this._angle * f;
        const M = this._M * f;
        _P0.copy(O).addScaledVector(d0, h0.t);
        _P1.copy(O).addScaledVector(d1, h1.t);
        const need = (this._sn + 1) * SHEET_STRIDE;
        if (need > this.sheetData.length) this.sheetData = growF32(this.sheetData, need);
        this._sn = this._pushSheet(this._sn, _P0, _P1, angle, _D, M, this._ap, this._div, this._g, this._vis);
        // Trait lumineux sur la surface touchée par les deux bords
        if (h0.id === h1.id && h0.id !== SURF_SKY) {
            const tm = (h0.t + h1.t) * 0.5;
            this._pushImpact(_P0, _P1, h0, this._ap + tm * this._div, M * this._vis, _D, Math.max(_D[0], _D[1], _D[2]));
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

    _pushSheet(sn, A, Bp, angle, D, M, ap, div, g, vis) {
        const S = this.sheetData;
        const O = this.origin;
        const o = sn * SHEET_STRIDE;
        S[o] = O.x; S[o + 1] = O.y; S[o + 2] = O.z; S[o + 3] = ap;
        S[o + 4] = A.x; S[o + 5] = A.y; S[o + 6] = A.z; S[o + 7] = div;
        S[o + 8] = Bp.x; S[o + 9] = Bp.y; S[o + 10] = Bp.z; S[o + 11] = Math.max(angle, 1e-5);
        const m = Math.max(D[0], D[1], D[2]);
        S[o + 12] = D[0] / m; S[o + 13] = D[1] / m; S[o + 14] = D[2] / m; S[o + 15] = M * vis;
        S[o + 16] = g;
        return sn + 1;
    }

    dispose() {
        this.scene.remove(this.group);
        if (this._slot) this._instancer.free(this._slot);
        this._slot = null;
        this.beamN = 0;
        this.sheetN = 0;
        this.impactN = 0;
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
