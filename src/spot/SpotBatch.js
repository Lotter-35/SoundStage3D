/**
 * SpotBatch.js
 * ─────────────────────────────────────────────────────────────
 * Rendu GPU BATCHÉ de toutes les lyres :
 *   - faisceaux volumétriques → 1 cône instancié par lyre (enveloppe des facettes du prisme),
 *     rendu dans une scène dédiée par SpotVolumePass (demi-résolution, profondeur de la scène).
 *     3 variantes du shader, 1 draw call chacune : lyres sans prisme, lyres à prisme, barres LED
 *     (le code du prisme ou des barres alourdirait le shader de toutes les lyres)
 *   - éblouissements de lentille → 1 billboard instancié dans la scène (bloom lampes)
 * Les paramètres de chaque lyre sont dans une DataTexture float (SPOT_TEXELS texels / lyre).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { getSmokeNoiseTexture } from '../laser/LaserSmokeNoise.js';
import { resolveResolutionScale } from '../render/resolutionScale.js';
import { enableLightsBloom } from '../laser/LaserManager.js';
import { getGoboTexture } from './SpotGoboLibrary.js';
import {
    SPOT_TEXELS, createVolumeMaterial, createCompositeMaterial, createGlareMaterial,
    createGateAtlasMaterial, GATE_ATLAS_SIDE, GATE_ATLAS_TILE, createBeamResolveMaterial
} from './SpotShaders.js?v=4';

const GATE_TILES = GATE_ATLAS_SIDE * GATE_ATLAS_SIDE;

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
    // Décalé d'un demi-segment : aucune arête dans les plans de symétrie du faisceau. Une caméra exactement
    // dans un tel plan (point d'apparition face à la lyre centrale) voyait l'arête passer par le centre des
    // pixels et la colonne n'était couverte par aucun triangle (trait vertical sombre d'un pixel).
    let src = new THREE.CylinderGeometry(1, 1, 1, 32, 1, false, Math.PI / 32);
    src.rotateX(Math.PI / 2);
    src.translate(0, 0, 0.5);
    // Sommets de la couture (angle 0 et 2π) fusionnés : maillage étanche
    src.deleteAttribute('normal');
    src.deleteAttribute('uv');
    src = mergeVertices(src, 1e-5);
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
        // Variantes du shader : uniformes partagés (réglages, profondeur, vent… écrits une seule fois)
        this.volumeScene = new THREE.Scene();
        const variant = (options) => {
            const m = createVolumeMaterial(this.paramsTexture, this.goboTexture, getSmokeNoiseTexture(), options);
            m.uniforms = this.volumeMaterial.uniforms;
            return m;
        };
        this._plain = this._makeVolumeLayer(this.volumeMaterial, 64);
        this._prism = this._makeVolumeLayer(variant({ prism: true }), 16);
        this._bars = this._makeVolumeLayer(variant({ bar: true }), 8);
        this._layers = [this._plain, this._prism, this._bars];

        // ── Atlas de l'image de fenêtre (gobos, animation, couteaux, couleurs) : une tuile par lyre ──
        const size = GATE_ATLAS_SIDE * GATE_ATLAS_TILE;
        this.gateAtlas = new THREE.WebGLRenderTarget(size, size, {
            depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true,
        });
        this.volumeMaterial.uniforms.uGateAtlas.value = this.gateAtlas.texture;
        this._gateMaterial = createGateAtlasMaterial(this.paramsTexture, this.goboTexture);
        this._materials.push(this._gateMaterial);
        const quad = new THREE.PlaneGeometry(2, 2);
        const gateGeo = new THREE.InstancedBufferGeometry();
        gateGeo.setIndex(quad.getIndex());
        gateGeo.setAttribute('position', quad.getAttribute('position'));
        this._gateInfo = new THREE.InstancedBufferAttribute(new Float32Array(GATE_TILES * 2), 2);
        this._gateInfo.setUsage(THREE.DynamicDrawUsage);
        gateGeo.setAttribute('aInfo', this._gateInfo);
        gateGeo.instanceCount = 0;
        this._gateMesh = new THREE.Mesh(gateGeo, this._gateMaterial);
        this._gateMesh.frustumCulled = false;
        this._gateScene = new THREE.Scene();
        this._gateScene.add(this._gateMesh);
        this._gateCamera = new THREE.Camera();
        this._freeTiles = Array.from({ length: GATE_TILES }, (_, i) => GATE_TILES - 1 - i);
        this._gateJobs = 0;

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

    _makeVolumeLayer(material, capacity) {
        const geo = makeConeGeometry();
        const stream = new InstanceStream(geo, VOLUME_STRIDE, [
            { name: 'iLens', offset: 0, size: 4 },
            { name: 'iAxis', offset: 4, size: 4 },
            { name: 'iRight', offset: 8, size: 4 },
        ], capacity);
        const mesh = new THREE.Mesh(geo, material);
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        this.volumeScene.add(mesh);
        return { stream, mesh };
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

    /** Tuile de l'atlas de fenêtre (−1 : atlas plein, l'image est alors calculée dans le shader) */
    allocTile() {
        return this._freeTiles.length ? this._freeTiles.pop() : -1;
    }

    freeTile(tile) {
        if (tile >= 0) this._freeTiles.push(tile);
    }

    /** Dessine les tuiles des lyres à gobo de cette image (1 draw call ; mipmaps pour le flou) */
    renderGateAtlas(renderer) {
        if (!renderer || this._gateJobs === 0) return;
        const prev = renderer.getRenderTarget();
        const auto = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(this.gateAtlas);
        renderer.render(this._gateScene, this._gateCamera);
        renderer.setRenderTarget(prev);
        renderer.autoClear = auto;
    }

    allocRow() {
        if (this._freeRows.length > 0) return this._freeRows.pop();
        if (this._rows >= this._maxRows) this._allocParamsTexture(this._maxRows * 2);
        return this._rows++;
    }

    /** Réserve n lignes CONSÉCUTIVES (LED d'une barre, lues à la suite par le shader) ; retourne la 1re */
    allocBlock(n) {
        while (this._rows + n > this._maxRows) this._allocParamsTexture(this._maxRows * 2);
        const first = this._rows;
        this._rows += n;
        return first;
    }

    freeRow(row) {
        this._freeRows.push(row);
    }

    paramsRow(row) {
        const n = SPOT_TEXELS * 4;
        return this.paramsTexture.image.data.subarray(row * n, row * n + n);
    }

    /** Nombre de volumes à dessiner (lyres + barres LED) */
    get volumeCount() {
        return this._plain.stream.count + this._prism.stream.count + this._bars.stream.count;
    }

    /** Assemble les faisceaux et éblouissements de toutes les lyres */
    assemble(fixtures, sources = null) {
        if (!Array.isArray(fixtures)) fixtures = [...fixtures];   // parcourue deux fois (faisceaux, atlas)
        for (const l of this._layers) l.stream.begin();
        this.glares.begin();
        // Projecteurs dont le faisceau est affiché (un faisceau à prisme compte pour un)
        let n = 0;
        for (const f of fixtures) {
            const before = this.volumeCount;
            f.pushInstances(this);
            if (this.volumeCount > before) n++;
        }
        if (sources) {
            for (const s of sources) {
                const before = this.volumeCount;
                s.pushInstances(this);
                if (this.volumeCount > before) n++;
            }
        }
        this.volumeSources = n;
        // Lyres dont l'image de fenêtre passe par l'atlas cette image
        let jobs = 0;
        const info = this._gateInfo.array;
        for (const f of fixtures) {
            if (!f.needsGate || f.gateTile < 0) continue;
            info[jobs * 2] = f.gateTile;
            info[jobs * 2 + 1] = f.row;
            jobs++;
        }
        this._gateJobs = jobs;
        this._gateMesh.geometry.instanceCount = jobs;
        if (jobs > 0) {
            this._gateInfo.clearUpdateRanges();
            this._gateInfo.addUpdateRange(0, jobs * 2);
            this._gateInfo.needsUpdate = true;
        }
        for (const l of this._layers) {
            l.stream.end();
            l.mesh.visible = l.stream.count > 0;
        }
        this.glares.end();
        this.paramsTexture.needsUpdate = true;
        this.glareMesh.visible = this.glares.count > 0;
    }

    /** weight < 0 : volume d'une barre LED (voir LedBarFixture.pushInstances) ; prism : lyre à prisme */
    pushVolume(lens, row, axis, length, right, weight, prism = false) {
        const stream = weight < 0 ? this._bars.stream : prism ? this._prism.stream : this._plain.stream;
        const o = stream.push();
        const a = stream.array;
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
        const meshes = [...this._layers.map(l => l.mesh), this.glareMesh];
        const vis = meshes.map(m => m.visible);
        for (const m of meshes) m.visible = true;
        try { renderer.compile(this.volumeScene, camera); } catch (_) {}
        try { renderer.compile(this.glareMesh, camera); } catch (_) {}
        meshes.forEach((m, i) => { m.visible = vis[i]; });
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
        this.resolutionSetting = this.resolutionScale;
        this.resolutionFactor = 1;
        this._width = 1;
        this._height = 1;
        this.volumeTarget = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType,
            depthBuffer: false,
            stencilBuffer: false,
        });
        this.volumeTarget.texture.generateMipmaps = false;
        // Lissage temporel (calcul rapide) : deux historiques en alternance
        this.temporal = true;
        const histOpts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
        this._hist = [new THREE.WebGLRenderTarget(1, 1, histOpts), new THREE.WebGLRenderTarget(1, 1, histOpts)];
        this._histIdx = 0;
        this._histValid = false;
        this._resolve = createBeamResolveMaterial();
        this._resolveQuad = new FullScreenQuad(this._resolve);
        this._frame = 0;
        this._lastCamPos = new THREE.Vector3();
        this._lastCamQuat = new THREE.Quaternion();
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

    /** @param {number|'auto'} scale échelle par axe (ou 'auto' : selon la taille de l'image), × factor */
    setResolutionScale(scale, factor = 1) {
        this.resolutionSetting = scale;
        this.resolutionFactor = factor;
        this.setSize(this._width, this._height);
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
        this.resolutionScale = resolveResolutionScale(this.resolutionSetting, width, height) * this.resolutionFactor;
        const w = Math.max(1, Math.round(width * this.resolutionScale));
        const h = Math.max(1, Math.round(height * this.resolutionScale));
        this.volumeTarget.setSize(w, h);
        for (const t of this._hist) t.setSize(w, h);
        this._resolve.uniforms.uTexel.value.set(1 / w, 1 / h);
        this._histValid = false;
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

        if (hasDepth && this.batch.volumeCount > 0) {
            u.uDepth.value = depth;
            u.uNear.value = cam.near;
            u.uFar.value = cam.far;
            cam.getWorldDirection(this._fwd);
            u.uCamFwd.value.copy(this._fwd);
            this._frame = (this._frame + 1) % 1024;
            // Échantillons décalés d'une image à l'autre seulement avec le lissage temporel (sinon : scintillement)
            u.uFrame.value = this.temporal ? this._frame : 0;

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
            let beams = this.volumeTarget.texture;
            if (this.temporal) {
                // Mouvement de la caméra : historique moins gardé (pas de traînée en tournant la tête)
                const turn = this._lastCamQuat.angleTo(cam.quaternion);
                const move = this._lastCamPos.distanceTo(cam.position);
                this._lastCamQuat.copy(cam.quaternion);
                this._lastCamPos.copy(cam.position);
                const ru = this._resolve.uniforms;
                ru.uAlpha.value = Math.min(1, 0.22 + turn * 6 + move * 0.6);
                ru.tCur.value = this.volumeTarget.texture;
                ru.tHist.value = this._hist[1 - this._histIdx].texture;
                ru.uValid.value = this._histValid ? 1 : 0;
                const write = this._hist[this._histIdx];
                renderer.setRenderTarget(write);
                this._resolveQuad.render(renderer);
                this._histIdx = 1 - this._histIdx;
                this._histValid = true;
                beams = write.texture;
            }
            this._composite.uniforms.tVolume.value = beams;
            this._composite.uniforms.tDepth.value = depth;
            this._composite.uniforms.uNear.value = cam.near;
            this._composite.uniforms.uFar.value = cam.far;
            this._composite.uniforms.uUseDepth.value = this.resolutionScale < 0.999 ? 1 : 0;
            if (this.deferred) {
                this._out.texture = beams;
                this._out.useDepth = this.resolutionScale < 0.999;
                this._hasOut = true;
                return;
            }
        } else {
            this._histValid = false;
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
        for (const t of this._hist) t.dispose();
        this._resolveQuad.dispose();
        this._composite.dispose();
        this._quad.dispose();
    }
}
