/**
 * SpotFixture.js
 * ─────────────────────────────────────────────────────────────
 * Une lyre Spot de la scène :
 *   - paramètres (consignes) : panneau, DMX ou réseau multijoueur
 *   - simulation mécanique (SpotMotion) → état physique réel
 *   - pose articulée socle / lyre (pan) / tête (tilt), montage posé ou suspendu
 *   - écriture de sa ligne de paramètres GPU et de son faisceau (1 cône, enveloppe des facettes du prisme)
 *   - groupe de manipulation (gizmo) + volume de sélection invisible
 *   - patch DMX (univers, adresse, mode) et décodage de ses canaux
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { defaultSpotParams, SPOT_PARAMS_SCHEMA } from './config/spotParams.js';
import { SpotMotion } from './SpotMotion.js';
import { decode, getFootprint } from './SpotProfile.js';
import { getSpotHousingInstancer, TILT_PIVOT_Y, LENS_OFFSET, LENS_RADIUS } from './SpotHousing.js?v=2';
import { findConeOccluders, OCCLUDERS_PER_SPOT } from './SpotOcclusion.js';

/** Portée de rendu des faisceaux (m) */
export const SPOT_BEAM_RANGE = 140;
/** Échelle du flux lumineux des faisceaux (calibrage visuel, 3x plus puissant) */
const FLUX_SCALE = 75;
/** Zoom minimal réel : 0° = faisceau quasi parallèle (le flux reste réparti sur la section de la lentille) */
const MIN_ZOOM_DEG = 0.25;
const DEG = Math.PI / 180;
const MAX_FACETS = 9;

const PLACEMENT_KEYS = new Set(['posX', 'posY', 'posZ', 'yaw', 'pitch', 'roll', 'mount']);
const PATCH_KEYS = new Set(['dmxUniverse', 'dmxAddress', 'dmxMode', 'dmxControl']);

const _rotY = new THREE.Matrix4();
const _rotX = new THREE.Matrix4();
const _pivot = new THREE.Matrix4().makeTranslation(0, TILT_PIVOT_Y, 0);
const _lensLocal = new THREE.Vector3();

export class SpotFixture {
    /**
     * @param {object} o
     * @param {string} o.id
     * @param {number} o.number Numéro d'affichage
     * @param {THREE.Scene} o.scene
     * @param {import('./SpotBatch.js').SpotBatch} o.batch
     * @param {import('../dmx/DmxPatch.js').DmxPatch} o.patch
     * @param {object} [o.params]
     */
    constructor({ id, number, scene, batch, patch, params = {} }) {
        this.id = id;
        this.number = number;
        this.scene = scene;
        this.batch = batch;
        this.patch = patch;

        this.params = { ...defaultSpotParams(), ...params };
        this.motion = new SpotMotion(this.params);
        this.row = batch.allocRow();

        // Groupe manipulé par le gizmo (position + orientation) ; le montage est un enfant
        this.group = new THREE.Group();
        this.group.name = `Spot_${id}`;
        this.group.userData.spotInstance = this;
        this.mountNode = new THREE.Group();
        this.group.add(this.mountNode);

        this._instancer = getSpotHousingInstancer(scene);
        this.pickMesh = new THREE.Mesh(this._instancer.pickGeometry, this._instancer.pickMaterial);
        this.pickMesh.name = 'spot-pick';
        this.pickMesh.userData.spotInstance = this;
        this.mountNode.add(this.pickMesh);
        scene.add(this.group);

        this._slot = this._instancer.allocSlot(this);
        this._base = new THREE.Matrix4();
        this._yoke = new THREE.Matrix4();
        this._head = new THREE.Matrix4();
        this._lastHead = new THREE.Matrix4();
        this._lastHead.elements[0] = NaN;
        this._lastBase = new THREE.Matrix4();
        this._lensColor = new THREE.Color();
        this._lastLens = new THREE.Color(-1, -1, -1);

        // État optique courant (lu par le pool de lumières et le batch)
        this.lensPos = new THREE.Vector3();
        this.axis = new THREE.Vector3(0, 1, 0);
        this.right = new THREE.Vector3(1, 0, 0);
        this.up = new THREE.Vector3(0, 0, 1);
        this.flux = 0;
        this.tanHalf = 0.12;
        this.tanLight = 0.2;
        this.focusDist = 10;
        this.frost = 0;
        this.poolWeight = 0;       // part d'éclairage assurée par une SpotLight réelle (0…1)
        this.occluders = new Float32Array(OCCLUDERS_PER_SPOT).fill(-1); // obstacles de la scène dans le cône
        this.occluderCount = 0;
        this.isBeingDragged = false;
        this.dmxDirty = false;     // paramètres modifiés par le DMX (rafraîchir le panneau)
        // Contribution des effets de la console (s'ajoute aux paramètres sans les modifier)
        this.fx = { pan: 0, tilt: 0, dim: 1, color: null };
        this._eff = {};
        this._lastDmxReset = null;

        this.facetCount = 0;
        // Prisme pour le shader des faisceaux : facettes décrites par un générateur (voir SpotShaders.js, T9…T11)
        this.prism = { count: 0, mainW: 1, facetW: 0, x0: 0, y0: 0, cos: 1, sin: 0, dx: 0, dy: 0 };
        this.facets = [];
        for (let i = 0; i < MAX_FACETS; i++) {
            this.facets.push({ axis: new THREE.Vector3(), right: new THREE.Vector3(), weight: 0, gx: 0, gy: 0 });
        }

        this.applyTransform();
        patch.register(this);
    }

    // ── Patch DMX ─────────────────────────────────────────────────────────
    get dmxUniverse() { return this.params.dmxUniverse; }
    get dmxAddress() { return this.params.dmxAddress; }
    get dmxFootprint() { return getFootprint(this.params.dmxMode); }
    get dmxControlled() { return Boolean(this.params.dmxControl); }

    /** Décode les canaux DMX de la lyre (appelé par DmxPatch si l'univers a changé) */
    applyDmx(universe) {
        const { params, reset } = decode(universe, this.params.dmxAddress, this.params.dmxMode);
        for (const k in params) this.params[k] = params[k];
        if (reset && reset !== this._lastDmxReset) this.motion.startReset(reset);
        this._lastDmxReset = reset;
        this.dmxDirty = true;
    }

    // ── Paramètres ────────────────────────────────────────────────────────
    setParam(key, value) {
        if (!(key in SPOT_PARAMS_SCHEMA)) return;
        this.params[key] = value;
        if (PLACEMENT_KEYS.has(key)) this.applyTransform();
        if (PATCH_KEYS.has(key)) this.patch.invalidate(this);
    }

    setParams(obj) {
        let placement = false;
        for (const [k, v] of Object.entries(obj)) {
            if (!(k in SPOT_PARAMS_SCHEMA)) continue;
            this.params[k] = v;
            if (PLACEMENT_KEYS.has(k)) placement = true;
            if (PATCH_KEYS.has(k)) this.patch.invalidate(this);
        }
        if (placement) this.applyTransform();
    }

    /** Routine de calibration : 'panTilt' | 'effects' | 'all' */
    reset(mode) {
        this.motion.startReset(mode);
    }

    applyTransform() {
        const p = this.params;
        this.group.position.set(p.posX, p.posY, p.posZ);
        this.group.rotation.set(p.pitch * DEG, p.yaw * DEG, p.roll * DEG, 'YXZ');
        this.mountNode.rotation.set(p.mount === 'Suspendu' ? Math.PI : 0, 0, 0);
        this.group.updateMatrixWorld(true);
    }

    /** Recopie la pose du groupe (déplacé au gizmo) dans les paramètres */
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

    // ── Mise à jour par frame ─────────────────────────────────────────────
    update(dt) {
        let p = this.params;
        const fx = this.fx;
        if (fx.pan !== 0 || fx.tilt !== 0 || fx.dim !== 1 || fx.color) {
            // Consignes effectives = paramètres de base + effets en cours
            p = Object.assign(this._eff, this.params);
            p.pan += fx.pan;
            p.tilt += fx.tilt;
            p.dimmer *= fx.dim;
            if (fx.color) p.color = fx.color;
        }
        const m = this.motion.update(dt, p);

        // Pose articulée
        this.group.updateMatrixWorld();
        this._base.copy(this.mountNode.matrixWorld);
        _rotY.makeRotationY((p.invertPan ? -1 : 1) * m.pan * DEG);
        _rotX.makeRotationX((p.invertTilt ? -1 : 1) * m.tilt * DEG);
        this._yoke.multiplyMatrices(this._base, _rotY);
        this._head.multiplyMatrices(this._yoke, _pivot).multiply(_rotX);

        if (!this._head.equals(this._lastHead) || !this._base.equals(this._lastBase)) {
            this._lastHead.copy(this._head);
            this._lastBase.copy(this._base);
            this._instancer.writeSlot(this._slot, this._base, this._yoke, this._head,
                p.mount === 'Suspendu' ? this._base : null);
        }

        // Repère optique : lentille, axe du faisceau (+Y tête), droite de la fenêtre (+X tête)
        const e = this._head.elements;
        this.axis.set(e[4], e[5], e[6]).normalize();
        this.right.set(e[0], e[1], e[2]).normalize();
        this.up.crossVectors(this.right, this.axis);
        _lensLocal.set(0, LENS_OFFSET, 0);
        this.lensPos.copy(_lensLocal).applyMatrix4(this._head);

        // Optique
        const tanHalf = Math.tan(Math.max(MIN_ZOOM_DEG, m.zoom) * 0.5 * DEG);
        const margin = 0.03 + m.frost * 0.45 + 0.16;
        const tanCone = tanHalf * (m.iris + margin);
        this.tanHalf = tanHalf;
        this.frost = m.frost;
        this.focusDist = 60 * Math.pow(3 / 60, m.focus);
        this.flux = m.intensity * p.beamIntensity * FLUX_SCALE * (1 - 0.3 * m.frost);
        this.lightFlux = m.intensity * p.lightOutput * (1 - 0.2 * m.frost);

        // Facettes du prisme (axe principal non divisé tant que le prisme n'est pas totalement inséré)
        this._computeFacets(m, tanHalf);
        let maxOff = 0;
        for (let i = 0; i < this.facetCount; i++) {
            const f = this.facets[i];
            maxOff = Math.max(maxOff, Math.hypot(f.gx, f.gy) * tanHalf);
        }
        this.tanLight = tanCone + maxOff;

        // Obstacles de la scène touchés par le cône (murs, toit, régie…) : ombres dans le shader
        this.occluderCount = findConeOccluders(this.lensPos, this.axis, this.tanLight, LENS_RADIUS, SPOT_BEAM_RANGE, this.occluders);

        // Ligne de paramètres GPU
        const r = this.batch.paramsRow(this.row);
        r[0] = m.colorA[0]; r[1] = m.colorA[1]; r[2] = m.colorA[2]; r[3] = this.flux;
        r[4] = m.colorB[0]; r[5] = m.colorB[1]; r[6] = m.colorB[2]; r[7] = m.split;
        r[8] = tanHalf; r[9] = m.iris; r[10] = m.frost; r[11] = this.focusDist;
        r[12] = m.goboFixedPos; r[13] = m.goboRotPos; r[14] = m.goboAngle; r[15] = m.animSlot;
        r[16] = m.animIn; r[17] = m.animAngle; r[18] = 1 - this.poolWeight; r[19] = LENS_RADIUS;
        r[20] = m.blades[0]; r[21] = m.bladeAngles[0]; r[22] = m.blades[1]; r[23] = m.bladeAngles[1];
        r[24] = m.blades[2]; r[25] = m.bladeAngles[2]; r[26] = m.blades[3]; r[27] = m.bladeAngles[3];
        r[28] = m.bladeRot; r[29] = p.lensGlare; r[30] = tanCone; r[31] = LENS_RADIUS / tanCone;
        r[32] = this.occluders[0]; r[33] = this.occluders[1]; r[34] = this.occluders[2]; r[35] = this.occluders[3];
        const pr = this.prism;
        r[36] = pr.count; r[37] = this.tanLight; r[38] = pr.mainW; r[39] = pr.facetW;
        r[40] = pr.x0; r[41] = pr.y0; r[42] = pr.cos; r[43] = pr.sin;
        r[44] = pr.dx; r[45] = pr.dy; r[46] = 0; r[47] = 0;

        // Lentille : s'illumine de la couleur du faisceau (bloom 3x plus puissant)
        const k = Math.min(m.intensity, 1) * Math.min(p.beamIntensity, 2) * 15.0;
        this._lensColor.setRGB(0.012 + m.colorA[0] * k, 0.014 + m.colorA[1] * k, 0.018 + m.colorA[2] * k);
        if (!this._lensColor.equals(this._lastLens)) {
            this._lastLens.copy(this._lensColor);
            this._instancer.writeLens(this._slot, this._lensColor);
        }
    }

    _computeFacets(m, tanHalf) {
        const W = this.axis, R = this.right, U = this.up;
        let n = 0;
        const add = (ox, oy, weight) => {
            const f = this.facets[n++];
            f.axis.copy(W).addScaledVector(R, ox).addScaledVector(U, oy).normalize();
            f.right.copy(R).addScaledVector(f.axis, -R.dot(f.axis)).normalize();
            f.weight = weight;
            f.gx = ox / tanHalf;
            f.gy = oy / tanHalf;
        };
        const type = m.prismType;
        const s = type > 0 ? m.prismIn : 0;
        const pr = this.prism;
        pr.count = 0; pr.mainW = s < 0.999 ? 1 - s : 0; pr.facetW = 0;
        if (s < 0.999) add(0, 0, 1 - s);
        if (s > 0.001) {
            const pa = m.prismAngle;
            if (type === 3) {
                // Prisme linéaire : 4 faisceaux alignés
                const step = 0.09 + tanHalf * 0.7;
                const cx = Math.cos(pa), cy = Math.sin(pa);
                for (let k = 0; k < 4; k++) {
                    const off = (k - 1.5) * step;
                    add(cx * off, cy * off, s / 4);
                }
                pr.count = 4; pr.facetW = s / 4;
                pr.x0 = -1.5 * step * cx / tanHalf; pr.y0 = -1.5 * step * cy / tanHalf;
                pr.cos = 1; pr.sin = 0;
                pr.dx = step * cx / tanHalf; pr.dy = step * cy / tanHalf;
            } else {
                const count = type === 1 ? 3 : 8;
                const dev = type === 1 ? 0.1 + tanHalf * 0.85 : 0.12 + tanHalf * 1.0;
                for (let k = 0; k < count; k++) {
                    const a = pa + (k / count) * Math.PI * 2;
                    add(Math.cos(a) * dev, Math.sin(a) * dev, s / count);
                }
                const step = Math.PI * 2 / count;
                pr.count = count; pr.facetW = s / count;
                pr.x0 = Math.cos(pa) * dev / tanHalf; pr.y0 = Math.sin(pa) * dev / tanHalf;
                pr.cos = Math.cos(step); pr.sin = Math.sin(step);
                pr.dx = 0; pr.dy = 0;
            }
        }
        this.facetCount = n;
    }

    /**
     * Ajoute le faisceau et les éblouissements de la lyre au batch : UN cône (enveloppe des facettes du
     * prisme, dont le shader additionne les images) et un éblouissement par facette
     */
    pushInstances(batch) {
        if (this.flux <= 1e-4) return;
        batch.pushVolume(this.lensPos, this.row, this.axis, SPOT_BEAM_RANGE, this.right, 1, this.prism.count > 0);
        for (let i = 0; i < this.facetCount; i++) {
            const f = this.facets[i];
            batch.pushGlare(this.lensPos, this.row, f.axis, f.weight);
        }
    }

    getPickableObjects() {
        return [this.pickMesh];
    }

    dispose() {
        this.patch.unregister(this);
        this.scene.remove(this.group);
        this._instancer.freeSlot(this._slot);
        const r = this.batch.paramsRow(this.row);
        r.fill(0);
        this.batch.freeRow(this.row);
    }
}
