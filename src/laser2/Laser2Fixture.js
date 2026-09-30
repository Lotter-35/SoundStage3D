/**
 * Laser2Fixture.js
 * ─────────────────────────────────────────────────────────────
 * Un nouveau laser posé dans la scène, côté jeu (fil principal) :
 *   - paramètres (panneau, réseau multijoueur, DMX)
 *   - placement (gizmo), repère monde, boîtier instancié + lentille à la couleur émise
 *   - la simulation et la géométrie sont calculées par le cœur (core/, dans un Web Worker) :
 *     le laser lui envoie ses réglages quand ils changent et reçoit sa géométrie prête à dessiner
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { LASER2_PARAMS_SCHEMA, HARDWARE_PRESETS, defaultLaser2Params } from './config/laser2Params.js';
import { decode as decodeDmx, getFootprint } from './Laser2Profile.js';
import { getLaser2HousingInstancer, APERTURE_Z, BODY } from './Laser2Housing.js';

const DEG = Math.PI / 180;
const PLACEMENT_KEYS = new Set(['posX', 'posY', 'posZ', 'yaw', 'pitch', 'roll']);
const PATCH_KEYS = new Set(['dmxUniverse', 'dmxAddress', 'dmxMode', 'dmxControl']);
const EMPTY = new Float32Array(0);

export class Laser2Fixture {
    /**
     * @param {object} o
     * @param {string} o.id
     * @param {number} o.number
     * @param {THREE.Scene} o.scene
     * @param {object} [o.params]
     */
    constructor({ id, number, scene, params = {} }) {
        this.id = id;
        this.number = number;
        this.isLaser2 = true;
        this.scene = scene;
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

        this.isBeingDragged = false;
        this.dmxDirty = false;

        // Repère monde du laser
        this.origin = new THREE.Vector3();
        this.right = new THREE.Vector3();
        this.up = new THREE.Vector3();
        this.fwd = new THREE.Vector3();

        // État envoyé au cœur de calcul
        this._dirtyParams = true;
        this._dirtyTransform = true;
        this.docKey = '';
        this.docReady = false;

        // Géométrie reçue du cœur (vues sur le tampon partagé)
        this.beamData = EMPTY;
        this.sheetData = EMPTY;
        this.impactData = EMPTY;
        this.beamN = 0;
        this.sheetN = 0;
        this.impactN = 0;
        this.stats = { points: 0, frameHz: 0, window: 0, beams: 0, sheets: 0, frames: 1 };
        this.preview = null;

        this.applyTransform();
    }

    get displayName() { return `Laser #${this.number}`; }

    // ── Patch DMX (patch commun avec les lyres, barres LED, strobes) ──────
    get dmxUniverse() { return this.params.dmxUniverse; }
    get dmxAddress() { return this.params.dmxAddress; }
    get dmxFootprint() { return getFootprint(this.params.dmxMode); }
    get dmxControlled() { return Boolean(this.params.dmxControl); }

    /** Trame DMX : les canaux du laser deviennent ses réglages (le panneau suit) */
    applyDmx(universe) {
        const { params } = decodeDmx(universe, this.params.dmxAddress, this.params.dmxMode);
        for (const k in params) this.params[k] = params[k];
        this._dirtyParams = true;
        this.dmxDirty = true;
    }

    /** Branché au patch par le gestionnaire */
    attachPatch(patch) {
        this.patch = patch;
        if (patch) patch.register(this);
    }

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
            if (PATCH_KEYS.has(k) && this.patch) this.patch.invalidate(this);
        }
        this._dirtyParams = true;
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
        this._dirtyTransform = true;
    }

    /** Repère envoyé au cœur : sortie du faisceau, axes droite / haut / avant */
    transformArray() {
        const o = this.origin, r = this.right, u = this.up, f = this.fwd;
        return [o.x, o.y, o.z, r.x, r.y, r.z, u.x, u.y, u.z, f.x, f.y, f.z];
    }

    getPlacement() {
        const p = this.params;
        return { posX: p.posX, posY: p.posY, posZ: p.posZ, yaw: p.yaw, pitch: p.pitch, roll: p.roll };
    }

    getPickableObjects() {
        return [this.pickMesh];
    }

    /** Géométrie calculée par le cœur pour ce laser */
    applyResult(item) {
        this.beamData = item.beamData; this.beamN = item.beamN;
        this.sheetData = item.sheetData; this.sheetN = item.sheetN;
        this.impactData = item.impactData; this.impactN = item.impactN;
        if (item.stats) this.stats = item.stats;
        const l = item.lens;
        this._instancer.lensColor(this._slot, l[0], l[1], l[2]);
    }

    dispose() {
        if (this.patch) this.patch.unregister(this);
        this.scene.remove(this.group);
        if (this._slot) this._instancer.free(this._slot);
        this._slot = null;
        this.beamN = 0;
        this.sheetN = 0;
        this.impactN = 0;
    }
}
