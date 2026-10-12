/**
 * SpotSelectionHighlight.js
 * ─────────────────────────────────────────────────────────────
 * Anneaux lumineux sous les lyres sélectionnées dans la console
 * (1 InstancedMesh, 1 draw call), visibles uniquement console ouverte.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';

const _ringLocal = new THREE.Matrix4().makeRotationX(-Math.PI / 2).setPosition(0, 0.004, 0);
const _m = new THREE.Matrix4();

export class SpotSelectionHighlight {
    constructor(scene) {
        this.scene = scene;
        this.material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(0.25, 1.1, 1.6),
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
            toneMapped: false,
            side: THREE.DoubleSide,
        });
        this.geometry = new THREE.RingGeometry(0.36, 0.44, 40);
        this.capacity = 0;
        this.mesh = null;
        this._alloc(32);
    }

    _alloc(capacity) {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh.dispose();
        }
        this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
        this.mesh.name = 'spot-selection-rings';
        this.mesh.frustumCulled = false;
        this.mesh.matrixAutoUpdate = false;
        this.mesh.renderOrder = 15;
        this.mesh.count = 0;
        this.mesh.visible = false;
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(this.mesh);
        this.capacity = capacity;
    }

    /**
     * @param {import('../SpotFixture.js').SpotFixture[]} spots lyres sélectionnées
     * @param {boolean} visible
     */
    update(spots, visible) {
        if (!visible || spots.length === 0) {
            this.mesh.visible = false;
            return;
        }
        if (spots.length > this.capacity) this._alloc(Math.max(spots.length, this.capacity * 2));
        spots.forEach((s, i) => {
            _m.multiplyMatrices(s.mountNode.matrixWorld, _ringLocal);
            this.mesh.setMatrixAt(i, _m);
        });
        this.mesh.count = spots.length;
        this.mesh.instanceMatrix.needsUpdate = true;
        this.mesh.visible = true;
    }
}
