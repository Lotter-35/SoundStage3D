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
import { BEAM_STRIDE, SHEET_STRIDE } from './Laser2Batch.js';
import { getLaser2HousingInstancer, APERTURE_Z, BODY } from './Laser2Housing.js';

const DEG = Math.PI / 180;
/** Portée maximale d'un rayon (ciel) */
export const LASER2_RANGE = 1000;
const GROUND_Y = 0;

const PLACEMENT_KEYS = new Set(['posX', 'posY', 'posZ', 'yaw', 'pitch', 'roll']);

const _D = [0, 0, 0];
const _dA = new THREE.Vector3();
const _dB = new THREE.Vector3();
const _dM = new THREE.Vector3();
const _hA = new THREE.Vector3();
const _hB = new THREE.Vector3();
const _hM = new THREE.Vector3();
const _last = [NaN, NaN];

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
        this.beamN = 0;
        this.sheetN = 0;

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
        if (this.scanner.version !== this._geoVersion || this._builtPlace !== this._placeVersion) {
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

    /** Distance jusqu'au premier obstacle (sol) ou la portée max ; `true` si le rayon touche le sol */
    _hitT(d) {
        if (d.y < -1e-6) {
            const t = (this.origin.y - GROUND_Y) / -d.y;
            if (t < LASER2_RANGE) return t;
        }
        return LASER2_RANGE;
    }

    _buildWorld() {
        const sc = this.scanner;
        const p = this.params;
        const O = this.origin;
        const ap = p.aperture * 1e-3;
        const div = p.divergence * 1e-3;
        const g = Math.min(0.9, p.forwardScatter / 100);
        const vis = p.visibility;
        let lr = 0, lg = 0, lb = 0;

        // Faisceaux
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
            const t = this._hitT(_dA);
            const o = bn++ * BEAM_STRIDE;
            B[o] = O.x; B[o + 1] = O.y; B[o + 2] = O.z; B[o + 3] = ap;
            B[o + 4] = O.x + _dA.x * t; B[o + 5] = O.y + _dA.y * t; B[o + 6] = O.z + _dA.z * t; B[o + 7] = div;
            B[o + 8] = _D[0] / M; B[o + 9] = _D[1] / M; B[o + 10] = _D[2] / M; B[o + 11] = M * vis;
            B[o + 12] = g;
        }
        this.beamN = bn;

        // Nappes (coupées en deux quand un bord touche le sol et l'autre part dans le ciel)
        const ns = sc.sheetCount;
        _last[0] = NaN;
        if (ns * 2 * SHEET_STRIDE > this.sheetData.length) this.sheetData = new Float32Array(Math.ceil(ns * 2 * 1.5 + 8) * SHEET_STRIDE);
        let sn = 0;
        for (let i = 0; i < ns; i++) {
            const s = i * 7;
            displayColor(sc.sheets[s + 4], sc.sheets[s + 5], sc.sheets[s + 6], _D);
            const M = Math.max(_D[0], _D[1], _D[2]);
            if (M <= 1e-6) continue;
            lr += _D[0]; lg += _D[1]; lb += _D[2];
            const a0x = sc.sheets[s], a0y = sc.sheets[s + 1], a1x = sc.sheets[s + 2], a1y = sc.sheets[s + 3];
            // Les nappes s'enchaînent : le début de celle-ci est souvent la fin de la précédente
            if (a0x === _last[0] && a0y === _last[1]) _dA.copy(_dB);
            else this._dir(a0x, a0y, _dA);
            this._dir(a1x, a1y, _dB);
            _last[0] = a1x; _last[1] = a1y;
            const angle = Math.sqrt((a1x - a0x) * (a1x - a0x) + (a1y - a0y) * (a1y - a0y));
            const tA = this._hitT(_dA), tB = this._hitT(_dB);
            const groundA = tA < LASER2_RANGE, groundB = tB < LASER2_RANGE;
            _hA.copy(O).addScaledVector(_dA, tA);
            _hB.copy(O).addScaledVector(_dB, tB);
            if (groundA === groundB || angle < 1e-4) {
                sn = this._pushSheet(sn, _hA, _hB, angle, _D, M, ap, div, g, vis);
                continue;
            }
            // Recherche de la direction où le rayon cesse de toucher le sol
            let lo = 0, hi = 1;
            for (let it = 0; it < 12; it++) {
                const m = (lo + hi) * 0.5;
                _dM.lerpVectors(_dA, _dB, m).normalize();
                const hit = this._hitT(_dM) < LASER2_RANGE;
                if (hit === groundA) lo = m; else hi = m;
            }
            _dM.lerpVectors(_dA, _dB, lo).normalize();
            _hM.copy(O).addScaledVector(_dM, this._hitT(_dM));
            sn = this._pushSheet(sn, _hA, _hM, angle * lo, _D, M * lo, ap, div, g, vis);
            _dM.lerpVectors(_dA, _dB, hi).normalize();
            _hM.copy(O).addScaledVector(_dM, this._hitT(_dM));
            sn = this._pushSheet(sn, _hM, _hB, angle * (1 - hi), _D, M * (1 - hi), ap, div, g, vis);
        }
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
    }
}
