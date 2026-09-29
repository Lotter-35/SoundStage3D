/**
 * SpotHousing.js
 * ─────────────────────────────────────────────────────────────
 * Modèle 3D d'une lyre Spot (moving head), en 3 corps articulés :
 *   - SOCLE  : boîtier, pieds, poignées, écran LCD, panneau de commande, roulement
 *   - LYRE   : plateau + 2 bras avec capots, tourne en PAN autour de l'axe vertical
 *   - TÊTE   : corps conique à ailettes, bague avant, lentille émissive, capot arrière
 *              ventilé, moyeux de tilt — tourne en TILT autour de l'axe des bras
 *   - ACCROCHE (montage suspendu uniquement) : omégas, crochet, tube de structure
 *
 * OPTIMISÉ : toutes les lyres de la scène sont dessinées par des InstancedMesh partagés
 * (1 draw call par couple corps × matériau, quel que soit le nombre de lyres).
 * La lentille reçoit une couleur par instance (couleur et intensité du faisceau, bloom).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { enableLightsBloom } from '../laser/LaserManager.js';

/** Hauteur de l'axe de tilt au-dessus du socle */
export const TILT_PIVOT_Y = 0.58;
/** Distance pivot de tilt → face de la lentille, le long de l'axe du faisceau */
export const LENS_OFFSET = 0.222;
/** Rayon de la lentille de sortie */
export const LENS_RADIUS = 0.112;

function buildMaterials() {
    return {
        body:   new THREE.MeshStandardMaterial({ color: 0x17191d, roughness: 0.55, metalness: 0.35 }),
        trim:   new THREE.MeshStandardMaterial({ color: 0x2e333c, roughness: 0.28, metalness: 0.82 }),
        rubber: new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.92, metalness: 0.0 }),
        fin:    new THREE.MeshStandardMaterial({ color: 0x202329, roughness: 0.38, metalness: 0.65 }),
        grille: new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.7, metalness: 0.3 }),
        gloss:  new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.12, metalness: 0.9 }),
        truss:  new THREE.MeshStandardMaterial({ color: 0x8a94a2, roughness: 0.28, metalness: 0.75 }),
        lcd:    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 0.62, 1.4), toneMapped: false }),
        lens:   new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    };
}

// Pièces : [corps, matériau, géométrie, x, y, z, rx, ry, rz]
function buildParts() {
    const P = [];
    const add = (body, mat, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
        P.push({ body, mat, geo, x, y, z, rx, ry, rz });
    const HP = Math.PI / 2;

    // ── SOCLE ──
    add('base', 'body', new THREE.BoxGeometry(0.44, 0.15, 0.34), 0, 0.095, 0);
    add('base', 'trim', new THREE.BoxGeometry(0.40, 0.02, 0.30), 0, 0.18, 0);
    for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) add('base', 'rubber', new THREE.CylinderGeometry(0.026, 0.03, 0.02, 8), sx * 0.18, 0.01, sz * 0.13);
        // Poignées latérales
        add('base', 'trim', new THREE.BoxGeometry(0.03, 0.028, 0.22), sx * 0.238, 0.13, 0);
        add('base', 'trim', new THREE.BoxGeometry(0.018, 0.05, 0.02), sx * 0.228, 0.11, 0.1);
        add('base', 'trim', new THREE.BoxGeometry(0.018, 0.05, 0.02), sx * 0.228, 0.11, -0.1);
    }
    // Panneau avant : écran LCD, boutons, grille de ventilation
    add('base', 'gloss', new THREE.BoxGeometry(0.13, 0.065, 0.004), 0.08, 0.115, 0.171);
    add('base', 'lcd', new THREE.PlaneGeometry(0.11, 0.048), 0.08, 0.115, 0.1735);
    for (let i = 0; i < 4; i++) add('base', 'rubber', new THREE.BoxGeometry(0.016, 0.016, 0.008), -0.045 - i * 0.03, 0.125, 0.172);
    add('base', 'grille', new THREE.BoxGeometry(0.26, 0.035, 0.004), -0.03, 0.055, 0.171);
    add('base', 'grille', new THREE.BoxGeometry(0.30, 0.05, 0.004), 0, 0.09, -0.171);
    // Roulement de pan
    add('base', 'trim', new THREE.CylinderGeometry(0.13, 0.14, 0.03, 24), 0, 0.205, 0);

    // ── LYRE (pan) ──
    add('yoke', 'body', new THREE.BoxGeometry(0.46, 0.05, 0.17), 0, 0.245, 0);
    for (const sx of [-1, 1]) {
        add('yoke', 'body', new THREE.BoxGeometry(0.055, 0.34, 0.15), sx * 0.2025, 0.44, 0);
        add('yoke', 'body', new THREE.CylinderGeometry(0.075, 0.075, 0.055, 18), sx * 0.2025, TILT_PIVOT_Y, 0, 0, 0, HP);
        add('yoke', 'trim', new THREE.BoxGeometry(0.008, 0.26, 0.11), sx * 0.2335, 0.43, 0);
        add('yoke', 'trim', new THREE.CylinderGeometry(0.05, 0.05, 0.01, 16), sx * 0.235, TILT_PIVOT_Y, 0, 0, 0, HP);
    }

    // ── TÊTE (tilt), origine au pivot, faisceau le long de +Y ──
    const hy = (y) => y; // lisibilité : coordonnées relatives au pivot
    add('head', 'body', new THREE.CylinderGeometry(0.145, 0.128, 0.40, 28, 1), 0, hy(-0.01), 0);
    add('head', 'trim', new THREE.CylinderGeometry(0.156, 0.152, 0.036, 28), 0, hy(0.20), 0);
    add('head', 'gloss', new THREE.RingGeometry(LENS_RADIUS - 0.002, 0.14, 28), 0, hy(0.2185), 0, -HP);
    add('head', 'lens', new THREE.CircleGeometry(LENS_RADIUS, 28), 0, hy(LENS_OFFSET - 0.0035), 0, -HP);
    add('head', 'body', new THREE.CylinderGeometry(0.118, 0.10, 0.05, 20), 0, hy(-0.235), 0);
    add('head', 'grille', new THREE.CircleGeometry(0.088, 16), 0, hy(-0.2605), 0, HP);
    // Ailettes de refroidissement
    const nFins = 12;
    for (let i = 0; i < nFins; i++) {
        const a = (i / nFins) * Math.PI * 2;
        const r = 0.139;
        P.push({
            body: 'head', mat: 'fin', geo: new THREE.BoxGeometry(0.01, 0.24, 0.03),
            x: Math.cos(a) * r, y: -0.05, z: Math.sin(a) * r, rx: 0, ry: HP - a, rz: 0,
        });
    }
    // Moyeux de tilt
    for (const sx of [-1, 1]) add('head', 'trim', new THREE.CylinderGeometry(0.062, 0.062, 0.03, 16), sx * 0.16, 0, 0, 0, 0, HP);

    // ── ACCROCHE (suspendu) : sous le socle, donc au-dessus une fois retourné ──
    for (const sz of [-1, 1]) add('rig', 'trim', new THREE.BoxGeometry(0.36, 0.014, 0.05), 0, -0.007, sz * 0.1);
    add('rig', 'trim', new THREE.BoxGeometry(0.05, 0.03, 0.26), 0, -0.029, 0);
    add('rig', 'body', new THREE.CylinderGeometry(0.036, 0.036, 0.05, 12), 0, -0.068, 0);
    add('rig', 'truss', new THREE.CylinderGeometry(0.025, 0.025, 1.6, 12), 0, -0.118, 0, 0, 0, HP);
    return P;
}

const _tmpM = new THREE.Matrix4();
const _tmpQ = new THREE.Quaternion();
const _tmpE = new THREE.Euler();
const _tmpV = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

class SpotHousingInstancer {
    constructor(scene) {
        this.scene = scene;
        this.materials = buildMaterials();
        const parts = buildParts();

        // Fusion par (corps, matériau)
        const groups = new Map();
        for (const p of parts) {
            const key = p.body + ':' + p.mat;
            _tmpE.set(p.rx, p.ry, p.rz);
            _tmpQ.setFromEuler(_tmpE);
            _tmpV.set(p.x, p.y, p.z);
            _tmpM.compose(_tmpV, _tmpQ, _one);
            p.geo.applyMatrix4(_tmpM);
            // Normalise les attributs (certaines géométries n'ont pas d'uv identiques)
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(p.geo);
        }
        this._merged = new Map();
        for (const [key, geos] of groups) {
            const merged = mergeGeometries(geos.map(g => (g.index ? g.toNonIndexed() : g)), false);
            this._merged.set(key, merged);
            geos.forEach(g => g.dispose());
        }

        // Volume de sélection (invisible) : boîte englobante de la lyre
        this.pickGeometry = new THREE.BoxGeometry(0.5, 0.86, 0.42);
        this.pickGeometry.translate(0, 0.43, 0);
        this.pickMaterial = new THREE.MeshBasicMaterial({ visible: false });

        this.zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
        this.slots = [];
        this.capacity = 0;
        this.meshes = null;
        this._count = 0;
        this._dirty = false;
        this._dirtyColor = false;
        this._build(16);
    }

    _build(capacity) {
        const old = this.meshes;
        const meshes = {};
        for (const [key, geo] of this._merged) {
            const [, matKey] = key.split(':');
            const im = new THREE.InstancedMesh(geo, this.materials[matKey], capacity);
            im.name = 'spot-housing-' + key;
            im.frustumCulled = false;
            im.matrixAutoUpdate = false;
            im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            im.count = 0;
            // Ombres portées : seulement les gros volumes (les petits détails sont rendus 5× par frame sinon)
            if (matKey !== 'lens' && matKey !== 'lcd') im.receiveShadow = true;
            if (matKey === 'lens') {
                im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
                im.instanceColor.setUsage(THREE.DynamicDrawUsage);
            }
            if (old && old[key]) {
                im.instanceMatrix.array.set(old[key].instanceMatrix.array);
                if (old[key].instanceColor) im.instanceColor.array.set(old[key].instanceColor.array);
                this.scene.remove(old[key]);
                old[key].dispose();
            }
            if (matKey === 'lens' || matKey === 'lcd') enableLightsBloom(im);
            this.scene.add(im);
            meshes[key] = im;
        }
        this.meshes = meshes;
        this._list = Object.entries(meshes).map(([key, im]) => ({ body: key.split(':')[0], im }));
        this.capacity = capacity;
        this._dirty = true;
        this._dirtyColor = true;
        for (const { im } of this._list) im.count = this._count;
    }

    allocSlot(owner) {
        let slot = this.slots.indexOf(null);
        if (slot === -1) {
            slot = this.slots.length;
            this.slots.push(null);
            if (slot >= this.capacity) this._build(this.capacity * 2);
        }
        this.slots[slot] = owner;
        this.hideSlot(slot);
        this._count = Math.max(this._count, slot + 1);
        for (const { im } of this._list) im.count = this._count;
        return slot;
    }

    freeSlot(slot) {
        this.slots[slot] = null;
        this.hideSlot(slot);
        while (this._count > 0 && this.slots[this._count - 1] === null) this._count--;
        for (const { im } of this._list) im.count = this._count;
    }

    hideSlot(slot) {
        for (const { im } of this._list) im.setMatrixAt(slot, this.zeroMatrix);
        this._dirty = true;
    }

    /** Écrit les matrices monde des 4 corps d'une lyre */
    writeSlot(slot, base, yoke, head, rig) {
        for (const { body, im } of this._list) {
            const m = body === 'base' ? base : body === 'yoke' ? yoke : body === 'head' ? head : rig;
            im.setMatrixAt(slot, m || this.zeroMatrix);
        }
        this._dirty = true;
    }

    writeLens(slot, color) {
        const lens = this.meshes['head:lens'];
        if (lens) {
            lens.setColorAt(slot, color);
            this._dirtyColor = true;
        }
    }

    flush() {
        if (this._count === 0) return;
        if (this._dirty) {
            for (const { im } of this._list) {
                im.instanceMatrix.clearUpdateRanges();
                im.instanceMatrix.addUpdateRange(0, this._count * 16);
                im.instanceMatrix.needsUpdate = true;
            }
            this._dirty = false;
        }
        if (this._dirtyColor) {
            const c = this.meshes['head:lens'].instanceColor;
            c.clearUpdateRanges();
            c.addUpdateRange(0, this._count * 3);
            c.needsUpdate = true;
            this._dirtyColor = false;
        }
    }
}

const _instancers = new WeakMap();
export function getSpotHousingInstancer(scene) {
    let inst = _instancers.get(scene);
    if (!inst) {
        inst = new SpotHousingInstancer(scene);
        _instancers.set(scene, inst);
    }
    return inst;
}
