/**
 * LedBarFixture.js
 * ─────────────────────────────────────────────────────────────
 * Une barre LED motorisée (tilt 360° continu, 8 / 16 / 32 LED) :
 *   - paramètres (consignes) : panneau, DMX ou réseau multijoueur
 *   - mécanique : tilt 16 bits, rotation continue, vitesse moteurs, macros de mouvement,
 *     zoom global ou segmenté (gauche / droite), routines de reset
 *   - couleur de chaque LED : master RGBW, pixels individuels ou générateur d'effets,
 *     + demi-couleur dans chaque faisceau
 *   - rendu : chaque LED est une « lyre » ultra-simple du batch des lyres (1 ligne de
 *     paramètres par LED, sans gobo) → mêmes faisceaux volumétriques, même tache au sol,
 *     même éblouissement, AUCUN nouveau shader et AUCUNE lumière Three.js.
 *     Faisceaux individuels jusqu'à ce qu'ils se chevauchent (~1,5 m), puis UN volume pour toute
 *     la barre qui additionne ses LED (sinon 16 à 32 faisceaux superposés calculés chacun à leur tour)
 *
 * Toutes les animations (effets, strobe, rotation, macros) suivent l'horloge commune :
 * identiques chez tous les joueurs.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import {
    defaultLedBarParams, LEDBAR_PARAMS_SCHEMA, MOVE_FX, HALF_MODES, pixelCountOf, hexToRgb, MAX_PIXELS, ZOOM_MIN, ZOOM_MAX
} from './config/ledBarParams.js';
import { decode, getFootprint } from './LedBarProfile.js';
import { computeFxPixels } from './LedBarEffects.js';
import { getLedBarHousingInstancer, pixelOffsetX, bodyLength, LED_LENS_RADIUS, BODY_DEPTH, PIXEL_PITCH } from './LedBarHousing.js';
import { findConeOccluders, OCCLUDERS_PER_SPOT } from '../spot/SpotOcclusion.js';

/** Portée de rendu des faisceaux (m) */
export const LEDBAR_BEAM_RANGE = 110;
/** Flux d'une LED (une lyre vaut 25 : une barre de 16 LED ≈ 1,5 lyre) */
const PIXEL_FLUX = 2.4;
/** Poids de facette < 0,99 : le shader des faisceaux prend son chemin économique (moins d'échantillons) */
const BEAM_WEIGHT = 0.98;
/** Demi-angle du cône d'une LED / demi-angle du zoom (marge du flou de bord) */
const LED_CONE = 1.19;
/** Distance où chaque point est éclairé par ~3 LED voisines (en pas) : le volume de la barre prend le relais */
const MERGE_OVERLAP = 1.5;
const DEG = Math.PI / 180;
const TILT_ACCEL = 1400;       // °/s²
const ZOOM_SPEED = 70;         // °/s
const RESET_TIME = 2.6;        // s

const PLACEMENT_KEYS = new Set(['posX', 'posY', 'posZ', 'yaw', 'pitch', 'roll']);
const PATCH_KEYS = new Set(['dmxUniverse', 'dmxAddress', 'dmxMode', 'dmxControl']);

const _rot = new THREE.Matrix4();
const _rgb = [0, 0, 0];
const _lp = new THREE.Vector3();
const _rgbB = [0, 0, 0];

const wrap180 = (a) => a - 360 * Math.floor((a + 180) / 360);
const fract = (x) => x - Math.floor(x);
function hash(a, b) {
    const s = Math.sin(a * 91.7 + b * 247.3) * 43758.5453;
    return s - Math.floor(s);
}

export class LedBarFixture {
    /**
     * @param {object} o
     * @param {string} o.id
     * @param {number} o.number
     * @param {THREE.Scene} o.scene
     * @param {import('../spot/SpotBatch.js').SpotBatch} o.batch
     * @param {import('../dmx/DmxPatch.js').DmxPatch} o.patch
     * @param {() => number} o.clock horloge commune (s)
     * @param {object} [o.params]
     */
    constructor({ id, number, scene, batch, patch, clock, params = {} }) {
        this.id = id;
        this.number = number;
        this.isLedBar = true;
        this.scene = scene;
        this.batch = batch;
        this.patch = patch;
        this.clock = clock;

        const base = defaultLedBarParams();
        this.params = { ...base, ...params };
        this.params.pixels = normalizePixels(params.pixels || base.pixels);

        this.group = new THREE.Group();
        this.group.name = `LedBar_${id}`;
        this.group.userData.ledBarInstance = this;
        scene.add(this.group);

        this._instancer = getLedBarHousingInstancer(scene);
        this.pickMesh = new THREE.Mesh(this._instancer.pickGeometry, this._instancer.pickMaterial);
        this.pickMesh.name = 'ledbar-pick';
        this.pickMesh.userData.ledBarInstance = this;
        this.group.add(this.pickMesh);

        // État mécanique
        this.tiltAngle = this.params.tilt;   // angle réel (non borné : rotation infinie)
        this.tiltVel = 0;
        this.zoomL = this.params.zoom;
        this.zoomR = this.params.zoomSplit ? this.params.zoomRight : this.params.zoom;
        this._resetT = -1;
        this._resetMode = null;
        this._lastDmxReset = null;
        this.isBeingDragged = false;
        this.dmxDirty = false;

        this._base = new THREE.Matrix4();
        this._head = new THREE.Matrix4();
        this._lastHead = new THREE.Matrix4();
        this._lastHead.elements[0] = NaN;
        this._lastBase = new THREE.Matrix4();
        this.axis = new THREE.Vector3(0, 0, 1);
        this.right = new THREE.Vector3(1, 0, 0);
        this.up = new THREE.Vector3(0, 1, 0);
        this.center = new THREE.Vector3();
        this.occluders = new Float32Array(OCCLUDERS_PER_SPOT).fill(-1);
        this.intensity = 0;

        this._n = 0;
        this._rows = [];
        this._slot = null;
        this._colors = new Float32Array(MAX_PIXELS * 3);
        this._lensPos = [];
        this._lastLens = new Float32Array(MAX_PIXELS * 3).fill(-1);
        this._resize();

        this.applyTransform();
        patch.register(this);
    }

    get displayName() { return `Barre LED #${this.number}`; }
    get pixelCount() { return this._n; }

    // ── Patch DMX ─────────────────────────────────────────────────────────
    get dmxUniverse() { return this.params.dmxUniverse; }
    get dmxAddress() { return this.params.dmxAddress; }
    get dmxFootprint() { return getFootprint(this.params.dmxMode, this._n); }
    get dmxControlled() { return Boolean(this.params.dmxControl); }

    applyDmx(universe) {
        const { params, reset } = decode(universe, this.params.dmxAddress, this.params.dmxMode, this._n);
        for (const k in params) this.params[k] = params[k];
        if (reset && reset !== this._lastDmxReset) this.reset(reset);
        this._lastDmxReset = reset;
        this.dmxDirty = true;
    }

    // ── Paramètres ────────────────────────────────────────────────────────
    setParam(key, value) {
        this.setParams({ [key]: value });
    }

    setParams(obj) {
        let placement = false, resize = false;
        for (const [k, v] of Object.entries(obj)) {
            if (k === 'pixels') { this.params.pixels = normalizePixels(v); continue; }
            if (!(k in LEDBAR_PARAMS_SCHEMA)) continue;
            this.params[k] = v;
            if (PLACEMENT_KEYS.has(k)) placement = true;
            if (k === 'pixelCount') resize = true;
            if (PATCH_KEYS.has(k) || k === 'pixelCount') this.patch.invalidate(this);
        }
        if (resize) this._resize();
        if (placement) this.applyTransform();
    }

    /** Couleur d'une LED (sélecteur du panneau) */
    setPixel(i, hex) {
        if (i < 0 || i >= MAX_PIXELS) return;
        this.params.pixels[i] = hex;
    }

    /** Routine de reset : 'tilt' | 'zoom' | 'all' */
    reset(mode = 'all') {
        this._resetMode = mode;
        this._resetT = 0;
    }

    applyTransform() {
        const p = this.params;
        this.group.position.set(p.posX, p.posY, p.posZ);
        this.group.rotation.set(p.pitch * DEG, p.yaw * DEG, p.roll * DEG, 'YXZ');
        this.group.updateMatrixWorld(true);
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
    }

    getPlacement() {
        const p = this.params;
        return { posX: p.posX, posY: p.posY, posZ: p.posZ, yaw: p.yaw, pitch: p.pitch, roll: p.roll };
    }

    getPickableObjects() {
        return [this.pickMesh];
    }

    /** (Ré)alloue les instances et lignes GPU selon le nombre de LED */
    _resize() {
        const n = pixelCountOf(this.params);
        if (n === this._n) return;
        if (this._slot) this._instancer.freeBar(this._slot);
        this._freeRows();
        this._n = n;
        this._slot = this._instancer.allocBar(n);
        // Lignes consécutives : le volume de la barre les lit à la suite
        this._firstRow = this.batch.allocBlock(n);
        this._rows = Array.from({ length: n }, (_, i) => this._firstRow + i);
        // Faisceau unique qui remplace ceux des LED quand la caméra est dedans (voir pushInstances)
        this._mergedRow = this.batch.allocRow();
        this._mergedLens = new THREE.Vector3();
        // Volume de toute la barre au-delà de la zone où les faisceaux des LED sont séparés
        this._barRow = this.batch.allocRow();
        this._barLens = new THREE.Vector3();
        this._lensPos = Array.from({ length: n }, () => new THREE.Vector3());
        this._lastLens.fill(-1);
        this._lastHead.elements[0] = NaN;
        this._lastBase.elements[0] = NaN;
        const L = bodyLength(n);
        this.pickMesh.scale.set(L + 0.14, 0.34, 0.3);
        this.pickMesh.position.set(0, -0.08, 0);
        this.pickMesh.updateMatrixWorld(true);
    }

    // ── Mise à jour par frame ─────────────────────────────────────────────
    update(dt) {
        const p = this.params;
        const t = this.clock();
        dt = Math.min(dt, 0.1);

        // ── Routine de reset (noir pendant la calibration, moteurs en butée puis retour) ──
        let resetting = false, resetTilt = null, resetZoom = null;
        if (this._resetT >= 0) {
            this._resetT += dt;
            const f = this._resetT / RESET_TIME;
            if (f >= 1) this._resetT = -1;
            else {
                resetting = true;
                const doTilt = this._resetMode !== 'zoom';
                const doZoom = this._resetMode !== 'tilt';
                if (doTilt) resetTilt = f < 0.45 ? -90 : f < 0.8 ? 90 : 0;
                if (doZoom) resetZoom = f < 0.45 ? ZOOM_MIN : ZOOM_MAX;
            }
        }

        // ── Tilt (position 16 bits, rotation continue ou macro) ──
        const speed = Math.max(0, Math.min(100, p.moveSpeed)) / 100;
        const vmax = resetting ? 540 : 25 + 515 * Math.pow(speed, 1.3);
        let target = p.tilt;
        let feed = 0;
        const macro = MOVE_FX.indexOf(p.moveFx);
        const mRate = 0.03 + 1.2 * Math.pow(Math.max(0, p.moveFxSpeed) / 100, 1.5);
        if (resetTilt !== null) {
            target = resetTilt;
        } else if (Math.abs(p.rotation) >= 1) {
            // Rotation infinie : phase = vitesse × horloge commune (même angle chez tous les joueurs)
            const rate = (p.rotation / 100) * 360;
            target = p.tilt + rate * t;
            feed = rate;
        } else if (macro === 1) {
            target = p.tilt + p.moveFxAmp * Math.sin(2 * Math.PI * mRate * t);
        } else if (macro === 2) {
            target = p.tilt + p.moveFxAmp * Math.sin(2 * Math.PI * mRate * t) * (this.number % 2 ? 1 : -1);
        } else if (macro === 3) {
            target = p.tilt + p.moveFxAmp * Math.sin(2 * Math.PI * (mRate * t - this.number * 0.12));
        } else if (macro === 4) {
            const rate = mRate * 360;
            target = p.tilt + rate * t;
            feed = rate;
        }
        const diff = wrap180(target - this.tiltAngle);
        const want = Math.max(-vmax, Math.min(vmax, feed + diff * 7));
        const dv = want - this.tiltVel;
        const maxDv = TILT_ACCEL * dt;
        this.tiltVel += Math.max(-maxDv, Math.min(maxDv, dv));
        this.tiltAngle += this.tiltVel * dt;
        if (Math.abs(this.tiltAngle) > 36000) this.tiltAngle = wrap180(this.tiltAngle);

        // ── Zoom (motorisé, global ou segmenté) ──
        const zl = resetZoom !== null ? resetZoom : p.zoom;
        const zr = resetZoom !== null ? resetZoom : (p.zoomSplit ? p.zoomRight : p.zoom);
        const zs = ZOOM_SPEED * (resetting ? 1.5 : 0.4 + 0.6 * speed) * dt;
        this.zoomL += Math.max(-zs, Math.min(zs, zl - this.zoomL));
        this.zoomR += Math.max(-zs, Math.min(zs, zr - this.zoomR));

        // ── Pose : étrier fixe, tête tournée autour de l'axe long (X) ──
        this.group.updateMatrixWorld();
        this._base.copy(this.group.matrixWorld);
        _rot.makeRotationX(-(p.invertTilt ? -1 : 1) * this.tiltAngle * DEG);
        this._head.multiplyMatrices(this._base, _rot);
        if (!this._base.equals(this._lastBase)) {
            this._lastBase.copy(this._base);
            this._instancer.writeYoke(this._slot, this._base);
        }
        const moved = !this._head.equals(this._lastHead);
        if (moved) {
            this._lastHead.copy(this._head);
            this._instancer.writeHead(this._slot, this._head);
            const e = this._head.elements;
            this.right.set(e[0], e[1], e[2]).normalize();
            this.up.set(e[4], e[5], e[6]).normalize();
            this.axis.set(e[8], e[9], e[10]).normalize();
            this.center.set(e[12], e[13], e[14]);
            for (let i = 0; i < this._n; i++) {
                this._lensPos[i].set(pixelOffsetX(i, this._n), 0, BODY_DEPTH / 2 + 0.004).applyMatrix4(this._head);
            }
            this._barLens.set(0, 0, BODY_DEPTH / 2 + 0.004).applyMatrix4(this._head);
        }

        // ── Intensité : dimmer × obturateur (strobe calé sur l'horloge commune) ──
        let shutter = 1;
        const rate = Math.max(1, Math.min(30, p.strobeRate));
        switch (p.shutter) {
            case 'Fermé': shutter = 0; break;
            case 'Strobe': shutter = fract(t * rate) < 0.22 ? 1 : 0; break;
            case 'Strobe aléatoire': {
                const k = Math.floor(t * rate);
                shutter = hash(k, this.number) > 0.55 && fract(t * rate) < 0.35 ? 1 : 0;
                break;
            }
            case 'Pulse ouverture': shutter = fract(t * rate); break;
            case 'Pulse fermeture': shutter = 1 - fract(t * rate); break;
            default: shutter = 1;
        }
        this.intensity = resetting ? 0 : Math.max(0, Math.min(100, p.dimmer)) / 100 * shutter;

        // ── Couleur de chaque LED ──
        const n = this._n;
        const cols = this._colors;
        if (!computeFxPixels(p, n, t, cols, this.number)) {
            if (p.pixelMode) {
                for (let i = 0; i < n; i++) {
                    hexToRgb(p.pixels[i], _rgb);
                    cols[i * 3] = _rgb[0]; cols[i * 3 + 1] = _rgb[1]; cols[i * 3 + 2] = _rgb[2];
                }
            } else {
                hexToRgb(p.color, _rgb);
                for (let i = 0; i < n; i++) {
                    cols[i * 3] = _rgb[0]; cols[i * 3 + 1] = _rgb[1]; cols[i * 3 + 2] = _rgb[2];
                }
            }
        }
        const w = Math.max(0, Math.min(100, p.white)) / 100;
        if (w > 0) for (let i = 0; i < n * 3; i++) cols[i] = Math.min(1, cols[i] + w);

        // Demi-couleur : seconde couleur sur une moitié de chaque faisceau
        const half = HALF_MODES.indexOf(p.halfMode);
        if (half > 0) {
            hexToRgb(p.halfColor, _rgbB);
            if (w > 0) for (let k = 0; k < 3; k++) _rgbB[k] = Math.min(1, _rgbB[k] + w);
        }
        const split = half > 0 ? Math.max(-1, Math.min(1, p.halfPos / 100)) : 2;
        const splitAxis = half === 2 ? this.up : this.right;

        // ── Obstacles de la scène (1 test pour toute la barre) ──
        const tanL = Math.tan(Math.max(this.zoomL, this.zoomR) * 0.5 * DEG) * 1.19;
        if (moved || this._occTanL !== tanL) {
            this._occTanL = tanL;
            findConeOccluders(this.center, this.axis, tanL, bodyLength(n) / 2 + LED_LENS_RADIUS, LEDBAR_BEAM_RANGE, this.occluders);
        }

        // ── Lignes de paramètres GPU (1 par LED, format des lyres : voir SpotShaders.js) ──
        const flux = this.intensity * p.beamIntensity * PIXEL_FLUX / BEAM_WEIGHT;
        const splashW = p.splash ? 1 : 0;
        const glare = p.lensGlare;
        const lensK = Math.min(this.intensity, 1) * 4.0;
        // Zoom gauche / droite, et distance où le volume de la barre prend le relais des faisceaux individuels
        const thL = Math.tan(Math.max(ZOOM_MIN * 0.5, this.zoomL) * 0.5 * DEG);
        const thR = p.zoomSplit ? Math.tan(Math.max(ZOOM_MIN * 0.5, this.zoomR) * 0.5 * DEG) : thL;
        const splitI = p.zoomSplit ? Math.ceil(n / 2) : n;
        const merge = n >= 2;
        const sMerge = merge ? Math.max(0.05, (MERGE_OVERLAP * PIXEL_PITCH - LED_LENS_RADIUS) / (Math.min(thL, thR) * LED_CONE)) : 0;
        for (let i = 0; i < n; i++) {
            const r = this.batch.paramsRow(this._rows[i]);
            const o = i * 3;
            const tanHalf = i < splitI ? thL : thR;
            const tanCone = tanHalf * LED_CONE;
            r[0] = cols[o]; r[1] = cols[o + 1]; r[2] = cols[o + 2]; r[3] = flux;
            r[4] = _rgbB[0]; r[5] = _rgbB[1]; r[6] = _rgbB[2]; r[7] = split;
            r[8] = tanHalf; r[9] = 1; r[10] = 0; r[11] = 18;
            r[12] = 0; r[13] = 0; r[14] = 0; r[15] = 0;
            r[16] = 0; r[17] = 0; r[18] = splashW; r[19] = LED_LENS_RADIUS;
            r[20] = 0; r[21] = 0; r[22] = 0; r[23] = 0;
            r[24] = 0; r[25] = 0; r[26] = 0; r[27] = 0;
            r[28] = 0; r[29] = glare; r[30] = tanCone; r[31] = LED_LENS_RADIUS / tanCone;
            r[32] = this.occluders[0]; r[33] = this.occluders[1]; r[34] = this.occluders[2]; r[35] = this.occluders[3];
            r[36] = 0; r[37] = tanCone; r[38] = 1; r[39] = 0;     // pas de prisme : enveloppe = cône de la LED
            r[44] = 0; r[45] = 0; r[46] = 0; r[47] = sMerge;      // faisceau individuel jusqu'au volume de la barre

            // Lentille : s'illumine de la couleur de la LED (bloom), reflet sombre éteinte
            let lr = 0.02 + cols[o] * lensK, lg = 0.02 + cols[o + 1] * lensK, lb = 0.024 + cols[o + 2] * lensK;
            if (split < 1.5 && lensK > 0) {
                lr = 0.02 + (cols[o] + _rgbB[0]) * 0.5 * lensK;
                lg = 0.02 + (cols[o + 1] + _rgbB[1]) * 0.5 * lensK;
                lb = 0.024 + (cols[o + 2] + _rgbB[2]) * 0.5 * lensK;
            }
            const ll = this._lastLens;
            if (ll[o] !== lr || ll[o + 1] !== lg || ll[o + 2] !== lb) {
                ll[o] = lr; ll[o + 1] = lg; ll[o + 2] = lb;
                this._instancer.writeLens(this._slot, i, lr, lg, lb);
            }
        }
        // Ligne du volume de la barre (format : voir SpotShaders.js, « Ligne d'une BARRE LED »)
        if (merge) {
            const b = this.batch.paramsRow(this._barRow);
            const tcMax = Math.max(thL, thR) * LED_CONE;
            b.fill(0);
            b[3] = BEAM_WEIGHT;
            b[4] = _rgbB[0]; b[5] = _rgbB[1]; b[6] = _rgbB[2]; b[7] = split;
            b[9] = 1; b[11] = 18;
            b[18] = splashW; b[19] = LED_LENS_RADIUS;
            b[29] = glare; b[30] = tcMax; b[31] = LED_LENS_RADIUS / tcMax;
            b[32] = this.occluders[0]; b[33] = this.occluders[1]; b[34] = this.occluders[2]; b[35] = this.occluders[3];
            b[36] = thL; b[37] = thR; b[38] = splitI; b[39] = LED_CONE;
            b[40] = this._firstRow; b[41] = n; b[42] = PIXEL_PITCH; b[43] = half === 2 ? 1 : 0;
            b[46] = sMerge;
        }
        this._merge = merge;
        this._splitAxis = splitAxis;
        this._flux = flux;
    }

    /**
     * Ajoute les faisceaux et éblouissements des LED allumées au batch des lyres.
     * Caméra DANS les faisceaux de la barre : chaque faisceau couvrirait tout l'écran (16 à 32 fois le
     * calcul plein écran → gros lag). Là où les faisceaux se chevauchent, on les remplace par UN faisceau
     * équivalent (couleur moyenne, éclairement identique à la position de la caméra).
     * @param {import('../spot/SpotBatch.js').SpotBatch} batch
     * @param {THREE.Camera} [camera]
     */
    pushInstances(batch, camera = null) {
        this.cameraInside = false;
        if (this._flux <= 1e-4) return;
        const cols = this._colors;
        const R = this._splitAxis || this.right;
        this.cameraInside = Boolean(camera && this._pushMerged(batch, camera.position, R));
        if (this.cameraInside) {
            for (let i = 0; i < this._n; i++) batch.pushGlare(this._lensPos[i], this._rows[i], this.axis, BEAM_WEIGHT);
            return;
        }
        for (let i = 0; i < this._n; i++) {
            const r = this.batch.paramsRow(this._rows[i]);
            // LED éteinte (noir) : aucun faisceau → aucun coût GPU
            if (cols[i * 3] + cols[i * 3 + 1] + cols[i * 3 + 2] + (r[7] < 1.5 ? r[4] + r[5] + r[6] : 0) < 0.004) continue;
            batch.pushVolume(this._lensPos[i], this._rows[i], this.axis, LEDBAR_BEAM_RANGE, R, BEAM_WEIGHT);
            batch.pushGlare(this._lensPos[i], this._rows[i], this.axis, BEAM_WEIGHT);
        }
        // Au-delà : toutes les LED en un seul volume (poids < 0 : mode barre du shader)
        if (this._merge) batch.pushVolume(this._barLens, this._barRow, this.axis, LEDBAR_BEAM_RANGE, this.right, -1);
    }

    /** Faisceau fusionné si la caméra est dans la zone où les faisceaux des LED se chevauchent */
    _pushMerged(batch, cam, R) {
        const n = this._n;
        if (n < 2 || this._mergedRow === null) return false;
        const r0 = this.batch.paramsRow(this._rows[0]);
        const rN = this.batch.paramsRow(this._rows[n - 1]);
        const tanCone = Math.max(r0[30], rN[30]);
        if (!(tanCone > 0)) return false;
        const Lm = (n - 1) * PIXEL_PITCH / 2 + LED_LENS_RADIUS;       // rayon de la « lentille » fusionnée
        const lens = this._mergedLens.set(0, 0, BODY_DEPTH / 2 + 0.004).applyMatrix4(this._head);
        const aM = Lm / tanCone;
        _lp.copy(cam).sub(lens);
        const zc = _lp.dot(this.axis);                               // distance caméra ↔ lentilles le long de l'axe
        // Trop près de la barre : les faisceaux ne se chevauchent pas encore (on les garde séparés)
        if (zc < 2.5 * PIXEL_PITCH / tanCone || zc > LEDBAR_BEAM_RANGE) return false;
        const radial2 = _lp.lengthSq() - zc * zc;
        const rad = Lm + zc * tanCone;
        if (radial2 > rad * rad) return false;                       // caméra hors du faisceau de la barre

        // Couleurs moyennes et nombre de faisceaux qui éclairent la caméra
        const m = this.batch.paramsRow(this._mergedRow);
        let cr = 0, cg = 0, cb = 0, br = 0, bg = 0, bb = 0, tan = 0;
        for (let i = 0; i < n; i++) {
            const r = this.batch.paramsRow(this._rows[i]);
            cr += r[0]; cg += r[1]; cb += r[2];
            br += r[4]; bg += r[5]; bb += r[6];
            tan += r[8];
        }
        const inv = 1 / n;
        // Flux du faisceau fusionné : même éclairement que les vrais faisceaux à la position de la caméra
        // (somme des faisceaux qui la contiennent, chacun en 1/z² depuis son apex)
        const aS = LED_LENS_RADIUS / tanCone;
        let eReal = 0;
        for (let i = 0; i < n; i++) {
            _lp.copy(cam).sub(this._lensPos[i]);
            const z = _lp.dot(this.axis) + aS;
            if (z <= 0) continue;
            const rr = z * tanCone;
            if (_lp.lengthSq() - (z - aS) * (z - aS) <= rr * rr) eReal += 1 / (z * z);
        }
        if (eReal <= 0) return false;
        // × 0,6 (calé sur le rendu des faisceaux séparés) : dans les vrais faisceaux, la caméra est souvent loin de leur axe (image de fenêtre plus sombre au bord)
        const f = 0.6 * r0[3] * eReal * (zc + aM) * (zc + aM);
        m.set(r0);
        m[46] = 0; m[47] = 0;   // faisceau fusionné sur toute la portée
        m[0] = cr * inv; m[1] = cg * inv; m[2] = cb * inv; m[3] = f;
        m[4] = br * inv; m[5] = bg * inv; m[6] = bb * inv;
        m[8] = tan * inv;
        m[19] = Lm;
        m[30] = tanCone; m[31] = aM; m[37] = tanCone;
        batch.pushVolume(lens, this._mergedRow, this.axis, LEDBAR_BEAM_RANGE, R, BEAM_WEIGHT);
        return true;
    }

    dispose() {
        this.patch.unregister(this);
        this.scene.remove(this.group);
        if (this._slot) this._instancer.freeBar(this._slot);
        this._freeRows();
        this._slot = null;
    }

    _freeRows() {
        for (const r of this._rows) { this.batch.paramsRow(r).fill(0); this.batch.freeRow(r); }
        this._rows = [];
        if (this._mergedRow !== undefined && this._mergedRow !== null) {
            this.batch.paramsRow(this._mergedRow).fill(0);
            this.batch.freeRow(this._mergedRow);
            this._mergedRow = null;
        }
        if (this._barRow !== undefined && this._barRow !== null) {
            this.batch.paramsRow(this._barRow).fill(0);
            this.batch.freeRow(this._barRow);
            this._barRow = null;
        }
    }
}

function normalizePixels(arr) {
    const out = new Array(MAX_PIXELS).fill('#ffffff');
    if (Array.isArray(arr)) for (let i = 0; i < MAX_PIXELS && i < arr.length; i++) {
        if (typeof arr[i] === 'string' && /^#[0-9a-fA-F]{6}$/.test(arr[i])) out[i] = arr[i].toLowerCase();
    }
    return out;
}
