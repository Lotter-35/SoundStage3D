/**
 * Laser2Batch.js
 * ─────────────────────────────────────────────────────────────
 * Rendu batché de TOUS les nouveaux lasers : 3 draw calls (faisceaux, nappes, impacts), quel que soit
 * le nombre de lasers. Chaque laser écrit ses instances dans ses propres tableaux (réutilisés
 * d'une image à l'autre) ; le batch les concatène et n'envoie au GPU que la portion utilisée.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { createLaser2BeamMaterial, createLaser2SheetMaterial, createLaser2ImpactMaterial, LASER2_UNIFORMS } from './Laser2Shaders.js';
import { enableLaserBloom } from '../laser/LaserManager.js';

import { BEAM_STRIDE, SHEET_STRIDE, IMPACT_STRIDE } from './core/strides.js';
export { BEAM_STRIDE, SHEET_STRIDE, IMPACT_STRIDE };

class InstanceStream {
    constructor(geometry, stride, layout, capacity) {
        this.geometry = geometry;
        this.stride = stride;
        this.layout = layout;
        this.count = 0;
        this._alloc(capacity);
    }

    _alloc(capacity) {
        const array = new Float32Array(capacity * this.stride);
        if (this.buffer) {
            array.set(this.buffer.array.subarray(0, this.count * this.stride));
            this.geometry.dispose();
        }
        this.buffer = new THREE.InstancedInterleavedBuffer(array, this.stride, 1);
        this.buffer.setUsage(THREE.DynamicDrawUsage);
        for (const [name, offset, size] of this.layout) {
            this.geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(this.buffer, size, offset));
        }
        this.capacity = capacity;
    }

    begin() {
        this.count = 0;
    }

    append(src, n) {
        if (n <= 0) return;
        const need = this.count + n;
        if (need > this.capacity) {
            let cap = this.capacity;
            while (cap < need) cap *= 2;
            this._alloc(cap);
        }
        this.buffer.array.set(src.subarray(0, n * this.stride), this.count * this.stride);
        this.count = need;
    }

    end() {
        this.geometry.instanceCount = this.count;
        if (this.count > 0) {
            this.buffer.clearUpdateRanges();
            this.buffer.addUpdateRange(0, this.count * this.stride);
            this.buffer.needsUpdate = true;
        }
    }
}

export class Laser2Batch {
    constructor(scene) {
        this.scene = scene;

        const beamGeo = new THREE.InstancedBufferGeometry();
        beamGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
        beamGeo.setAttribute('aCorner', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
        beamGeo.setIndex([0, 1, 2, 2, 1, 3]);
        beamGeo.instanceCount = 0;
        this.beams = new InstanceStream(beamGeo, BEAM_STRIDE, [['aO', 0, 4], ['aE', 4, 4], ['aC', 8, 4], ['aG', 12, 1], ['aS', 13, 4]], 256);

        const sheetGeo = new THREE.InstancedBufferGeometry();
        sheetGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
        sheetGeo.setAttribute('aCornerId', new THREE.Float32BufferAttribute([0, 1, 2], 1));
        sheetGeo.instanceCount = 0;
        this.sheets = new InstanceStream(sheetGeo, SHEET_STRIDE, [['aO', 0, 4], ['aA', 4, 4], ['aB', 8, 4], ['aC', 12, 4], ['aG', 16, 1], ['aS', 17, 4]], 512);

        const impGeo = new THREE.InstancedBufferGeometry();
        impGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
        impGeo.setAttribute('aCorner', new THREE.Float32BufferAttribute([-1, 0, 1, 0, -1, 1, 1, 1], 2));
        impGeo.setIndex([0, 1, 2, 2, 1, 3]);
        impGeo.instanceCount = 0;
        this.impacts = new InstanceStream(impGeo, IMPACT_STRIDE, [['aP0', 0, 4], ['aP1', 4, 4], ['aN', 8, 3], ['aC', 11, 3]], 256);

        this.beamMaterial = createLaser2BeamMaterial();
        this.sheetMaterial = createLaser2SheetMaterial();
        this.impactMaterial = createLaser2ImpactMaterial();

        this.beamMesh = new THREE.Mesh(beamGeo, this.beamMaterial);
        this.sheetMesh = new THREE.Mesh(sheetGeo, this.sheetMaterial);
        this.impactMesh = new THREE.Mesh(impGeo, this.impactMaterial);
        this.impactMesh.name = 'laser2-impacts';
        for (const m of [this.sheetMesh, this.beamMesh, this.impactMesh]) {
            m.frustumCulled = false;
            m.renderOrder = 5;
            scene.add(m);
            enableLaserBloom(m);
        }
        this.beamMesh.name = 'laser2-beams';
        this.sheetMesh.name = 'laser2-sheets';
        this._size = new THREE.Vector2();
    }

    /**
     * @param {Iterable<{beamData: Float32Array, beamN: number, sheetData: Float32Array, sheetN: number, impactData: Float32Array, impactN: number}>} fixtures
     * @param {THREE.PerspectiveCamera} camera
     * @param {THREE.WebGLRenderer} renderer
     */
    assemble(fixtures, camera, renderer) {
        this.beams.begin();
        this.sheets.begin();
        this.impacts.begin();
        for (const f of fixtures) {
            this.beams.append(f.beamData, f.beamN);
            this.sheets.append(f.sheetData, f.sheetN);
            this.impacts.append(f.impactData, f.impactN);
        }
        this.beams.end();
        this.sheets.end();
        this.impacts.end();
        this.beamMesh.visible = this.beams.count > 0;
        this.sheetMesh.visible = this.sheets.count > 0;
        this.impactMesh.visible = this.impacts.count > 0;

        // Taille d'un pixel à 1 m de profondeur
        if (camera && renderer) {
            renderer.getDrawingBufferSize(this._size);
            const f = camera.projectionMatrix.elements[5];
            LASER2_UNIFORMS.uPixelK.value = 2 / (f * Math.max(1, this._size.y));
        }
    }

    dispose() {
        for (const m of [this.beamMesh, this.sheetMesh, this.impactMesh]) {
            this.scene.remove(m);
            m.geometry.dispose();
            m.material.dispose();
        }
    }
}
