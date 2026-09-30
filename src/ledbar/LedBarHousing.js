/**
 * LedBarHousing.js
 * ─────────────────────────────────────────────────────────────
 * Modèle 3D des barres LED, rendu en InstancedMesh (≈ 5 draw calls pour TOUTES les barres) :
 *   - corps de la barre (tourne en tilt 360° autour de son axe long)
 *   - face avant noire + lentilles des LED (émissives, couleur de chaque pixel, bloom)
 *   - étrier fixe : 2 bras moteurs aux extrémités + embase + collier de fixation
 * La longueur suit le nombre de LED (8 / 16 / 32) : les pièces sont des boîtes unitaires
 * mises à l'échelle par leur matrice d'instance.
 *
 * Repère local de la tête : X = axe long (axe de tilt), +Z = direction des faisceaux, Y = haut.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { enableLightsBloom } from '../laser/LaserManager.js';

/** Pas entre deux LED (m) : 16 LED ≈ 1 m */
export const PIXEL_PITCH = 0.0625;
/** Rayon d'une lentille de LED (m) */
export const LED_LENS_RADIUS = 0.022;
export const BODY_HEIGHT = 0.1;
export const BODY_DEPTH = 0.11;
/** Longueur du corps pour n LED */
export const bodyLength = (n) => n * PIXEL_PITCH + 0.06;

const _m = new THREE.Matrix4();
const _s = new THREE.Matrix4();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);

/** Groupe d'instances d'une pièce, avec emplacements libres réutilisés */
class InstancePool {
    constructor(scene, geometry, material, capacity, name, withColor = false) {
        this.scene = scene;
        this.geometry = geometry;
        this.material = material;
        this.name = name;
        this.withColor = withColor;
        this.free = [];
        this.used = 0;
        this.mesh = null;
        this._alloc(capacity);
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
    }

    setMatrix(i, m) {
        this.mesh.setMatrixAt(i, m);
        this.dirty = true;
    }

    setColor(i, r, g, b) {
        this.mesh.instanceColor.setXYZ(i, r, g, b);
        this.colorDirty = true;
    }

    flush() {
        if (this.dirty) {
            this.mesh.instanceMatrix.needsUpdate = true;
            this.dirty = false;
        }
        if (this.colorDirty) {
            this.mesh.instanceColor.needsUpdate = true;
            this.colorDirty = false;
        }
    }
}

class LedBarHousingInstancer {
    constructor(scene) {
        const box = new THREE.BoxGeometry(1, 1, 1);
        const body = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, metalness: 0.55, roughness: 0.42 });
        const yoke = new THREE.MeshStandardMaterial({ color: 0x2a2c30, metalness: 0.6, roughness: 0.38 });
        const face = new THREE.MeshStandardMaterial({ color: 0x050506, metalness: 0.2, roughness: 0.18 });
        const lens = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
        const disc = new THREE.CircleGeometry(1, 18);

        this.body = new InstancePool(scene, box, body, 8, 'ledbar-body');
        this.face = new InstancePool(scene, box, face, 8, 'ledbar-face');
        this.yoke = new InstancePool(scene, box, yoke, 32, 'ledbar-yoke');
        this.lens = new InstancePool(scene, disc, lens, 128, 'ledbar-lenses', true);
        this.pickGeometry = box;
        this.pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
        this._pools = [this.body, this.face, this.yoke, this.lens];
    }

    /** Réserve les instances d'une barre de n LED */
    allocBar(n) {
        return {
            n,
            body: this.body.alloc(),
            face: this.face.alloc(),
            yoke: [this.yoke.alloc(), this.yoke.alloc(), this.yoke.alloc(), this.yoke.alloc()],
            lens: Array.from({ length: n }, () => this.lens.alloc()),
        };
    }

    freeBar(slot) {
        this.body.release(slot.body);
        this.face.release(slot.face);
        for (const i of slot.yoke) this.yoke.release(i);
        for (const i of slot.lens) this.lens.release(i);
    }

    /** Étrier fixe (repère `base` : pivot du tilt à l'origine) */
    writeYoke(slot, base) {
        const L = bodyLength(slot.n);
        const put = (idx, x, y, z, sx, sy, sz) => {
            _s.makeScale(sx, sy, sz).setPosition(x, y, z);
            this.yoke.setMatrix(idx, _m.multiplyMatrices(base, _s));
        };
        const armX = L / 2 + 0.03;
        put(slot.yoke[0], -armX, -0.085, 0, 0.05, 0.25, 0.1);                 // bras moteur gauche
        put(slot.yoke[1], armX, -0.085, 0, 0.05, 0.25, 0.1);                  // bras moteur droit
        put(slot.yoke[2], 0, -0.215, 0, L + 0.13, 0.05, 0.14);                // embase
        put(slot.yoke[3], 0, -0.215, -0.11, 0.16, 0.09, 0.09);                // collier de fixation
    }

    /** Corps + face avant (repère `head` : tête après tilt) */
    writeHead(slot, head) {
        const L = bodyLength(slot.n);
        _s.makeScale(L, BODY_HEIGHT, BODY_DEPTH);
        this.body.setMatrix(slot.body, _m.multiplyMatrices(head, _s));
        _s.makeScale(L - 0.02, BODY_HEIGHT * 0.8, 0.004).setPosition(0, 0, BODY_DEPTH / 2 + 0.001);
        this.face.setMatrix(slot.face, _m.multiplyMatrices(head, _s));
        for (let i = 0; i < slot.n; i++) {
            _s.makeScale(LED_LENS_RADIUS, LED_LENS_RADIUS, 1).setPosition(pixelOffsetX(i, slot.n), 0, BODY_DEPTH / 2 + 0.004);
            this.lens.setMatrix(slot.lens[i], _m.multiplyMatrices(head, _s));
        }
    }

    writeLens(slot, i, r, g, b) {
        this.lens.setColor(slot.lens[i], r, g, b);
    }

    flush() {
        for (const p of this._pools) p.flush();
    }
}

/** Position le long de la barre de la LED i (m) */
export function pixelOffsetX(i, n) {
    return (i - (n - 1) / 2) * PIXEL_PITCH;
}

const _instancers = new WeakMap();

export function getLedBarHousingInstancer(scene) {
    let inst = _instancers.get(scene);
    if (!inst) {
        inst = new LedBarHousingInstancer(scene);
        _instancers.set(scene, inst);
    }
    return inst;
}
