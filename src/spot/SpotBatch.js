/**
 * SpotBatch.js
 * ─────────────────────────────────────────────────────────────
 * Rendu GPU BATCHÉ de toutes les lyres :
 *   - faisceaux volumétriques → 1 cône instancié (1 instance par facette de prisme),
 *     rendu dans une scène dédiée par SpotVolumePass (demi-résolution, profondeur de la scène)
 *   - éblouissements de lentille → 1 billboard instancié dans la scène (bloom lampes)
 * Les paramètres de chaque lyre sont dans une DataTexture float (SPOT_TEXELS texels / lyre).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { getSmokeNoiseTexture } from '../laser/LaserSmokeNoise.js';
import { enableLightsBloom } from '../laser/LaserManager.js';
import { getGoboTexture } from './SpotGoboLibrary.js';
import {
    SPOT_TEXELS, createVolumeMaterial, createCompositeMaterial, createGlareMaterial
} from './SpotShaders.js?v=2';

export const VOLUME_STRIDE = 12; // lentille.xyz, ligne | axe.xyz, longueur | droite.xyz, poids
export const GLARE_STRIDE = 8;   // lentille.xyz, ligne | axe.xyz, poids

class InstanceStream {
    constructor(geometry, stride, layout, capacity) {
        this.geometry = geometry;
        this.stride = stride;
        this.layout = layout;
        this.count = 0;
        this.capacity = 0;
        this.buffer = null;
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
        for (const { name, offset, size } of this.layout) {
            this.geometry.setAttribute(name, new THREE.InterleavedBufferAttribute(this.buffer, size, offset));
        }
        this.capacity = capacity;
    }

    begin() {
        this.count = 0;
    }

    /** Réserve une instance et retourne l'offset (en floats) où écrire */
    push() {
        if (this.count >= this.capacity) this._alloc(this.capacity * 2);
        return (this.count++) * this.stride;
    }

    get array() {
        return this.buffer.array;
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

function makeConeGeometry() {
    // Cylindre unitaire fermé : xy = direction radiale (rayon 1), z ∈ [0, 1] = fraction de la portée
    const src = new THREE.CylinderGeometry(1, 1, 1, 32, 1, false);
    src.rotateX(Math.PI / 2);
    src.translate(0, 0, 0.5);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex(src.getIndex());
    geo.setAttribute('position', src.getAttribute('position'));
    geo.instanceCount = 0;
    return geo;
}

export class SpotBatch {
    constructor(scene) {
        this.scene = scene;
        this._rows = 0;
        this._freeRows = [];
        this._maxRows = 0;
        this.paramsTexture = null;
        this._materials = [];
        this._allocParamsTexture(32);

        this.goboTexture = getGoboTexture();
        this.volumeMaterial = createVolumeMaterial(this.paramsTexture, this.goboTexture, getSmokeNoiseTexture());
        this.glareMaterial = createGlareMaterial(this.paramsTexture);
        this._materials = [this.volumeMaterial, this.glareMaterial];

        // ── Faisceaux (scène dédiée, rendue par SpotVolumePass) ──
        this.volumeScene = new THREE.Scene();
        const coneGeo = makeConeGeometry();
        this.volumes = new InstanceStream(coneGeo, VOLUME_STRIDE, [
            { name: 'iLens', offset: 0, size: 4 },
            { name: 'iAxis', offset: 4, size: 4 },
            { name: 'iRight', offset: 8, size: 4 },
        ], 64);
        this.volumeMesh = new THREE.Mesh(coneGeo, this.volumeMaterial);
        this.volumeMesh.frustumCulled = false;
        this.volumeMesh.matrixAutoUpdate = false;
        this.volumeScene.add(this.volumeMesh);

        // ── Éblouissements de lentille (scène principale, bloom lampes) ──
        const plane = new THREE.PlaneGeometry(1, 1);
        const glareGeo = new THREE.InstancedBufferGeometry();
        glareGeo.setIndex(plane.getIndex());
        glareGeo.setAttribute('position', plane.getAttribute('position'));
        glareGeo.setAttribute('uv', plane.getAttribute('uv'));
        glareGeo.instanceCount = 0;
        this.glares = new InstanceStream(glareGeo, GLARE_STRIDE, [
            { name: 'iLens', offset: 0, size: 4 },
            { name: 'iAxis', offset: 4, size: 4 },
        ], 32);
        this.glareMesh = new THREE.Mesh(glareGeo, this.glareMaterial);
        this.glareMesh.name = 'spot-batch-glares';
        this.glareMesh.frustumCulled = false;
        this.glareMesh.matrixAutoUpdate = false;
        this.glareMesh.renderOrder = 10;
        enableLightsBloom(this.glareMesh);
        scene.add(this.glareMesh);
    }

    _allocParamsTexture(rows) {
        const data = new Float32Array(SPOT_TEXELS * rows * 4);
        if (this.paramsTexture) data.set(this.paramsTexture.image.data);
        const tex = new THREE.DataTexture(data, SPOT_TEXELS, rows, THREE.RGBAFormat, THREE.FloatType);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        const old = this.paramsTexture;
        this.paramsTexture = tex;
        this._maxRows = rows;
        for (const m of this._materials) m.uniforms.uSpotParams.value = tex;
        if (this._onParamsTexture) this._onParamsTexture(tex);
        if (old) old.dispose();
    }

    /** Rappel quand la texture de paramètres est réallouée (matériaux de projection) */
    onParamsTexture(cb) {
        this._onParamsTexture = cb;
    }

    allocRow() {
        if (this._freeRows.length > 0) return this._freeRows.pop();
        if (this._rows >= this._maxRows) this._allocParamsTexture(this._maxRows * 2);
        return this._rows++;
    }

    freeRow(row) {
        this._freeRows.push(row);
    }

    paramsRow(row) {
        const n = SPOT_TEXELS * 4;
        return this.paramsTexture.image.data.subarray(row * n, row * n + n);
    }

    /** Assemble les faisceaux et éblouissements de toutes les lyres */
    assemble(fixtures) {
        this.volumes.begin();
        this.glares.begin();
        for (const f of fixtures) f.pushInstances(this);
        this.volumes.end();
        this.glares.end();
        this.paramsTexture.needsUpdate = true;
        this.volumeMesh.visible = this.volumes.count > 0;
        this.glareMesh.visible = this.glares.count > 0;
    }

    pushVolume(lens, row, axis, length, right, weight) {
        const o = this.volumes.push();
        const a = this.volumes.array;
        a[o] = lens.x; a[o + 1] = lens.y; a[o + 2] = lens.z; a[o + 3] = row;
        a[o + 4] = axis.x; a[o + 5] = axis.y; a[o + 6] = axis.z; a[o + 7] = length;
        a[o + 8] = right.x; a[o + 9] = right.y; a[o + 10] = right.z; a[o + 11] = weight;
    }

    pushGlare(lens, row, axis, weight) {
        const o = this.glares.push();
        const a = this.glares.array;
        a[o] = lens.x; a[o + 1] = lens.y; a[o + 2] = lens.z; a[o + 3] = row;
        a[o + 4] = axis.x; a[o + 5] = axis.y; a[o + 6] = axis.z; a[o + 7] = weight;
    }

    compile(renderer, camera) {
        for (const [scene, mesh] of [[this.volumeScene, this.volumeMesh], [this.scene, this.glareMesh]]) {
            const was = mesh.visible;
            mesh.visible = true;
            try { renderer.compile(scene === this.scene ? mesh : scene, camera); } catch (_) {}
            mesh.visible = was;
        }
    }
}

/**
 * Passe de post-traitement insérée juste après le rendu de la scène :
 * 1. rend les cônes de faisceau dans une cible (demi-résolution par défaut) en lisant la
 *    profondeur de la scène (arrêt exact des faisceaux sur les objets)
 * 2. ajoute le résultat à l'image de la scène
 */
export class SpotVolumePass extends Pass {
    constructor(batch, camera) {
        super();
        this.batch = batch;
        this.camera = camera;
        this.needsSwap = true;
        this.resolutionScale = 0.5;
        this._width = 1;
        this._height = 1;
        this.volumeTarget = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType,
            depthBuffer: false,
            stencilBuffer: false,
        });
        this.volumeTarget.texture.generateMipmaps = false;
        this._composite = createCompositeMaterial();
        this._quad = new FullScreenQuad(this._composite);
        this._fwd = new THREE.Vector3();
        this._clear = new THREE.Color();
        this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
        this._black.needsUpdate = true;

        // Recomposition différée : l'image des faisceaux est ajoutée par la passe finale unique
        this.deferred = false;
        this._out = { kind: 'add', texture: null, res: this._composite.uniforms.uVolRes.value, useDepth: true };
        this._hasOut = false;
    }

    /** Image à recomposer (mode différé), ou null s'il n'y a rien à ajouter */
    deferredOutput() {
        return this._hasOut ? this._out : null;
    }

    setResolutionScale(scale) {
        this.resolutionScale = scale;
        this.setSize(this._width, this._height);
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
        const w = Math.max(1, Math.round(width * this.resolutionScale));
        const h = Math.max(1, Math.round(height * this.resolutionScale));
        this.volumeTarget.setSize(w, h);
        this.batch.volumeMaterial.uniforms.uInvRes.value.set(1 / w, 1 / h);
        this._composite.uniforms.uVolRes.value.set(w, h);
    }

    render(renderer, writeBuffer, readBuffer) {
        const u = this.batch.volumeMaterial.uniforms;
        const cam = this.camera;
        const depth = (this.sceneDepth && this.sceneDepth.texture) || readBuffer.depthTexture;
        const hasDepth = Boolean(depth);
        this.needsSwap = !this.deferred;
        this._hasOut = false;

        if (hasDepth && this.batch.volumeMesh.visible) {
            u.uDepth.value = depth;
            u.uNear.value = cam.near;
            u.uFar.value = cam.far;
            cam.getWorldDirection(this._fwd);
            u.uCamFwd.value.copy(this._fwd);

            renderer.getClearColor(this._clear);
            const oldAlpha = renderer.getClearAlpha();
            const oldAutoClear = renderer.autoClear;
            const shadowMap = renderer.shadowMap;
            const oldShadowAuto = shadowMap.autoUpdate;
            shadowMap.autoUpdate = false;
            renderer.autoClear = false;
            renderer.setRenderTarget(this.volumeTarget);
            renderer.setClearColor(0x000000, 0);
            renderer.clear(true, false, false);
            renderer.render(this.batch.volumeScene, cam);
            renderer.setClearColor(this._clear, oldAlpha);
            renderer.autoClear = oldAutoClear;
            shadowMap.autoUpdate = oldShadowAuto;
            this._composite.uniforms.tVolume.value = this.volumeTarget.texture;
            this._composite.uniforms.tDepth.value = depth;
            this._composite.uniforms.uNear.value = cam.near;
            this._composite.uniforms.uFar.value = cam.far;
            this._composite.uniforms.uUseDepth.value = this.resolutionScale < 0.999 ? 1 : 0;
            if (this.deferred) {
                this._out.texture = this.volumeTarget.texture;
                this._out.useDepth = this.resolutionScale < 0.999;
                this._hasOut = true;
                return;
            }
        } else {
            if (this.deferred) return;
            this._composite.uniforms.uUseDepth.value = 0;
            // Rien à ajouter : simple recopie
            this._composite.uniforms.tVolume.value = this._black;
        }

        this._composite.uniforms.tDiffuse.value = readBuffer.texture;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this._quad.render(renderer);
    }

    dispose() {
        this.volumeTarget.dispose();
        this._composite.dispose();
        this._quad.dispose();
    }
}
