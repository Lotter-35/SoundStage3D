/**
 * Laser2Housing.js
 * ─────────────────────────────────────────────────────────────
 * Boîtiers des nouveaux lasers en InstancedMesh (3 draw calls pour TOUS les boîtiers) :
 * caisson, face avant avec sa fenêtre de sortie, lentille émissive qui prend la couleur émise.
 * Repère local : +Z = sortie des faisceaux, Y = haut. La sortie est à (0, 0, APERTURE_Z).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { enableLightsBloom } from '../laser/LaserManager.js';

export const BODY = { w: 0.36, h: 0.17, d: 0.44 };
/** Position de la fenêtre de sortie dans le repère du boîtier */
export const APERTURE_Z = BODY.d / 2 + 0.006;

const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4();
const _s = new THREE.Matrix4();

class Pool {
    constructor(scene, geometry, material, name, withColor) {
        this.scene = scene;
        this.geometry = geometry;
        this.material = material;
        this.name = name;
        this.withColor = withColor;
        this.free = [];
        this.used = 0;
        this.mesh = null;
        this._alloc(16);
    }

    _alloc(capacity) {
        const old = this.mesh;
        const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
        mesh.name = this.name;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.castShadow = !this.withColor;
        mesh.receiveShadow = !this.withColor;
        for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, _hidden);
        if (this.withColor) {
            mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
            mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
            enableLightsBloom(mesh);
        }
        if (old) {
            mesh.instanceMatrix.array.set(old.instanceMatrix.array);
            if (this.withColor) mesh.instanceColor.array.set(old.instanceColor.array);
            this.scene.remove(old);
            old.dispose();
        }
        mesh.count = this.used;
        this.mesh = mesh;
        this.capacity = capacity;
        this.scene.add(mesh);
        this.dirty = true;
    }

    alloc() {
        if (this.free.length) return this.free.pop();
        if (this.used >= this.capacity) this._alloc(this.capacity * 2);
        const i = this.used++;
        this.mesh.count = this.used;
        return i;
    }

    release(i) {
        this.mesh.setMatrixAt(i, _hidden);
        if (this.withColor) this.mesh.instanceColor.setXYZ(i, 0, 0, 0);
        this.free.push(i);
        this.dirty = true;
        this.colorDirty = this.withColor;
    }

    set(i, m) {
        this.mesh.setMatrixAt(i, m);
        this.dirty = true;
    }

    color(i, r, g, b) {
        this.mesh.instanceColor.setXYZ(i, r, g, b);
        this.colorDirty = true;
    }

    flush() {
        if (this.dirty) { this.mesh.instanceMatrix.needsUpdate = true; this.dirty = false; }
        if (this.colorDirty) { this.mesh.instanceColor.needsUpdate = true; this.colorDirty = false; }
    }
}

class Laser2HousingInstancer {
    constructor(scene) {
        const box = new THREE.BoxGeometry(1, 1, 1);
        const disc = new THREE.CircleGeometry(1, 20);
        this.body = new Pool(scene, box, new THREE.MeshStandardMaterial({ color: 0x17181b, metalness: 0.5, roughness: 0.45 }), 'laser2-body', false);
        this.face = new Pool(scene, box, new THREE.MeshStandardMaterial({ color: 0x050506, metalness: 0.3, roughness: 0.2 }), 'laser2-face', false);
        this.lens = new Pool(scene, disc, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 'laser2-lens', true);
        this.pickGeometry = box;
        this.pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
        this._pools = [this.body, this.face, this.lens];
    }

    alloc() {
        return { body: this.body.alloc(), face: this.face.alloc(), lens: this.lens.alloc() };
    }

    free(slot) {
        this.body.release(slot.body);
        this.face.release(slot.face);
        this.lens.release(slot.lens);
    }

    /** Boîtier dans le repère monde `m` du laser */
    write(slot, m) {
        _s.makeScale(BODY.w, BODY.h, BODY.d);
        this.body.set(slot.body, _m.multiplyMatrices(m, _s));
        _s.makeScale(BODY.w * 0.86, BODY.h * 0.78, 0.008).setPosition(0, 0, BODY.d / 2 + 0.001);
        this.face.set(slot.face, _m.multiplyMatrices(m, _s));
        _s.makeScale(0.02, 0.02, 1).setPosition(0, 0, APERTURE_Z);
        this.lens.set(slot.lens, _m.multiplyMatrices(m, _s));
    }

    lensColor(slot, r, g, b) {
        this.lens.color(slot.lens, r, g, b);
    }

    flush() {
        for (const p of this._pools) p.flush();
    }
}

const _instancers = new WeakMap();

export function getLaser2HousingInstancer(scene) {
    let inst = _instancers.get(scene);
    if (!inst) {
        inst = new Laser2HousingInstancer(scene);
        _instancers.set(scene, inst);
    }
    return inst;
}
