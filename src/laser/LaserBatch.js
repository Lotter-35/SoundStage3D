/**
 * LaserBatch.js
 * ─────────────────────────────────────────────────────────────
 * Rendu GPU BATCHÉ de TOUS les lasers de la scène :
 *   - faisceaux       → 1 InstancedMesh-like (quad instancié)      = 1 draw call
 *   - halos d'impact  → 1 quad instancié                           = 1 draw call
 *   - nappes PAN      → 1 triangle instancié (fumée incluse)       = 1 draw call
 *   - lignes d'impact → 1 quad instancié                           = 1 draw call
 *   - éclats source   → 1 quad instancié                           = 1 draw call
 * soit 5 draw calls quel que soit le nombre de lasers (au lieu de 5 × N).
 *
 * Les paramètres individuels de chaque laser (couleur, puissances, glow, fumée…)
 * sont stockés dans une DataTexture float (1 ligne par laser) lue par les shaders.
 *
 * Chaque LaserShow écrit sa géométrie dans ses propres tableaux (LaserOutput),
 * réutilisables d'une frame à l'autre (cache pour les lasers statiques) ; le batch
 * les concatène puis n'envoie au GPU QUE la portion utilisée des buffers.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import {
    PARAM_TEXELS,
    createBeamMaterial,
    createFanMaterial,
    createPodGlowMaterial,
    createImpactMaterial,
    createPanImpactMaterial
} from './LaserShaders.js';
import { getSmokeNoiseTexture } from './LaserSmokeNoise.js';

// Nombre de floats par instance
export const BEAM_STRIDE       = 7;  // origin.xyz, row, hit.xyz
export const IMPACT_STRIDE     = 8;  // center.xyz, row, normal.xyz, radius
export const FAN_STRIDE        = 7;  // h0.xyz, row, h1.xyz
export const PAN_IMPACT_STRIDE = 10; // c1.xyz, row, c2.xyz, side.xyz

/**
 * Tampon de sortie géométrique d'un laser (croissance automatique, 0 GC en régime établi).
 */
export class LaserOutput {
    constructor() {
        this.beams      = new Float32Array(64 * BEAM_STRIDE);
        this.impacts    = new Float32Array(64 * IMPACT_STRIDE);
        this.fans       = new Float32Array(512 * FAN_STRIDE);
        this.panImpacts = new Float32Array(512 * PAN_IMPACT_STRIDE);
        this.beamCount = 0;
        this.impactCount = 0;
        this.fanCount = 0;
        this.panImpactCount = 0;
        this.glow = false;
    }

    reset() {
        this.beamCount = 0;
        this.impactCount = 0;
        this.fanCount = 0;
        this.panImpactCount = 0;
        this.glow = false;
    }

    _grow(name, needed) {
        const old = this[name];
        let size = old.length;
        while (size < needed) size *= 2;
        const arr = new Float32Array(size);
        arr.set(old);
        this[name] = arr;
        return arr;
    }

    pushBeam(row, ox, oy, oz, hx, hy, hz) {
        let o = this.beamCount * BEAM_STRIDE;
        const a = (o + BEAM_STRIDE > this.beams.length) ? this._grow('beams', o + BEAM_STRIDE) : this.beams;
        a[o++] = ox; a[o++] = oy; a[o++] = oz; a[o++] = row;
        a[o++] = hx; a[o++] = hy; a[o] = hz;
        this.beamCount++;
    }

    pushImpact(row, cx, cy, cz, nx, ny, nz, radius) {
        let o = this.impactCount * IMPACT_STRIDE;
        const a = (o + IMPACT_STRIDE > this.impacts.length) ? this._grow('impacts', o + IMPACT_STRIDE) : this.impacts;
        a[o++] = cx; a[o++] = cy; a[o++] = cz; a[o++] = row;
        a[o++] = nx; a[o++] = ny; a[o++] = nz; a[o] = radius;
        this.impactCount++;
    }

    pushFan(row, h0, h1) {
        let o = this.fanCount * FAN_STRIDE;
        const a = (o + FAN_STRIDE > this.fans.length) ? this._grow('fans', o + FAN_STRIDE) : this.fans;
        a[o++] = h0.x; a[o++] = h0.y; a[o++] = h0.z; a[o++] = row;
        a[o++] = h1.x; a[o++] = h1.y; a[o] = h1.z;
        this.fanCount++;
    }

    pushPanImpact(row, c1x, c1y, c1z, c2x, c2y, c2z, sx, sy, sz) {
        let o = this.panImpactCount * PAN_IMPACT_STRIDE;
        const a = (o + PAN_IMPACT_STRIDE > this.panImpacts.length) ? this._grow('panImpacts', o + PAN_IMPACT_STRIDE) : this.panImpacts;
        a[o++] = c1x; a[o++] = c1y; a[o++] = c1z; a[o++] = row;
        a[o++] = c2x; a[o++] = c2y; a[o++] = c2z;
        a[o++] = sx; a[o++] = sy; a[o] = sz;
        this.panImpactCount++;
    }
}

/**
 * Buffer d'instances dynamique (InstancedInterleavedBuffer) à croissance automatique.
 */
class DynamicInstanceStream {
    constructor(geometry, stride, layout, initialCapacity) {
        this.geometry = geometry;
        this.stride = stride;
        this.layout = layout; // [{ name, offset, size }]
        this.capacity = 0;
        this.count = 0;
        this._alloc(initialCapacity);
    }

    _alloc(capacity) {
        const array = new Float32Array(capacity * this.stride);
        if (this.buffer) array.set(this.buffer.array.subarray(0, this.count * this.stride));
        // Libère l'ancien buffer GL (sinon fuite lors du remplacement des attributs)
        if (this.buffer) this.geometry.dispose();
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

    append(src, instanceCount) {
        if (instanceCount <= 0) return;
        const needed = this.count + instanceCount;
        if (needed > this.capacity) {
            let cap = this.capacity;
            while (cap < needed) cap *= 2;
            this._alloc(cap);
        }
        this.buffer.array.set(src.subarray(0, instanceCount * this.stride), this.count * this.stride);
        this.count = needed;
    }

    end() {
        this.geometry.instanceCount = this.count;
        if (this.count > 0) {
            // N'envoie au GPU QUE la portion utilisée du buffer
            this.buffer.clearUpdateRanges();
            this.buffer.addUpdateRange(0, this.count * this.stride);
            this.buffer.needsUpdate = true;
        }
    }
}

function makeQuadGeometry(withSide) {
    const geo = new THREE.InstancedBufferGeometry();
    // Ordre des sommets identique aux anciens quads CPU : (0,0) (1,0) (0,1) (1,1)
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    if (withSide) geo.setAttribute('aSide', new THREE.Float32BufferAttribute([-1, 1, -1, 1], 1));
    geo.setIndex([0, 1, 2, 2, 1, 3]);
    geo.instanceCount = 0;
    return geo;
}

export class LaserBatch {
    /**
     * @param {THREE.Scene} scene
     * @param {(obj: THREE.Object3D) => void} enableBloom Active le layer bloom laser
     */
    constructor(scene, enableBloom) {
        this.scene = scene;

        // ── Texture de paramètres (1 ligne par laser) ──────────────────────
        this._rows = 0;
        this._freeRows = [];
        this._maxRows = 0;
        this.paramsTexture = null;
        this._allocParamsTexture(64);

        const noise = getSmokeNoiseTexture();

        // ── Matériaux (1 seul jeu pour toute la scène) ──────────────────────
        this.beamMaterial      = createBeamMaterial(this.paramsTexture);
        this.fanMaterial       = createFanMaterial(this.paramsTexture, noise);
        this.podGlowMaterial   = createPodGlowMaterial(this.paramsTexture);
        this.impactMaterial    = createImpactMaterial(this.paramsTexture);
        this.panImpactMaterial = createPanImpactMaterial(this.paramsTexture);
        this._materials = [this.beamMaterial, this.fanMaterial, this.podGlowMaterial, this.impactMaterial, this.panImpactMaterial];

        // ── 1. Faisceaux ──
        const beamGeo = makeQuadGeometry(true);
        this.beams = new DynamicInstanceStream(beamGeo, BEAM_STRIDE, [
            { name: 'aBeamA', offset: 0, size: 4 },
            { name: 'aBeamB', offset: 4, size: 3 }
        ], 1024);

        // ── 2. Halos d'impact ──
        const impactGeo = makeQuadGeometry(false);
        this.impacts = new DynamicInstanceStream(impactGeo, IMPACT_STRIDE, [
            { name: 'aImpA', offset: 0, size: 4 },
            { name: 'aImpB', offset: 4, size: 4 }
        ], 1024);

        // ── 3. Nappes PAN (triangles instanciés : origine, h0, h1) ──
        const fanGeo = new THREE.InstancedBufferGeometry();
        fanGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
        fanGeo.setAttribute('aCorner', new THREE.Float32BufferAttribute([0, 1, 2], 1));
        fanGeo.instanceCount = 0;
        this.fans = new DynamicInstanceStream(fanGeo, FAN_STRIDE, [
            { name: 'aTriA', offset: 0, size: 4 },
            { name: 'aTriB', offset: 4, size: 3 }
        ], 8192);

        // ── 4. Lignes d'impact du plan ──
        const panImpactGeo = makeQuadGeometry(false);
        this.panImpacts = new DynamicInstanceStream(panImpactGeo, PAN_IMPACT_STRIDE, [
            { name: 'aSegA', offset: 0, size: 4 },
            { name: 'aSegB', offset: 4, size: 3 },
            { name: 'aSegS', offset: 7, size: 3 }
        ], 4096);

        // ── 5. Éclats de source (billboards 1.8 × 1.8) ──
        const glowGeo = new THREE.InstancedBufferGeometry();
        const plane = new THREE.PlaneGeometry(1.8, 1.8);
        glowGeo.setIndex(plane.getIndex());
        glowGeo.setAttribute('position', plane.getAttribute('position'));
        glowGeo.setAttribute('uv', plane.getAttribute('uv'));
        glowGeo.instanceCount = 0;
        this.glows = new DynamicInstanceStream(glowGeo, 1, [{ name: 'aRow', offset: 0, size: 1 }], 64);
        this._glowScratch = new Float32Array(1);

        this.beamsMesh     = this._makeMesh(beamGeo, this.beamMaterial, 'laser-batch-beams');
        this.impactMesh    = this._makeMesh(impactGeo, this.impactMaterial, 'laser-batch-impacts');
        this.fanMesh       = this._makeMesh(fanGeo, this.fanMaterial, 'laser-batch-fans');
        this.panImpactMesh = this._makeMesh(panImpactGeo, this.panImpactMaterial, 'laser-batch-pan-impacts');
        this.glowMesh      = this._makeMesh(glowGeo, this.podGlowMaterial, 'laser-batch-glows');
        this.meshes = [this.beamsMesh, this.impactMesh, this.fanMesh, this.panImpactMesh, this.glowMesh];
        for (const m of this.meshes) enableBloom(m);
    }

    _makeMesh(geometry, material, name) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = name;
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        this.scene.add(mesh);
        return mesh;
    }

    _allocParamsTexture(rows) {
        const data = new Float32Array(PARAM_TEXELS * rows * 4);
        if (this.paramsTexture) data.set(this.paramsTexture.image.data);
        const tex = new THREE.DataTexture(data, PARAM_TEXELS, rows, THREE.RGBAFormat, THREE.FloatType);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        const old = this.paramsTexture;
        this.paramsTexture = tex;
        this._maxRows = rows;
        if (this._materials) {
            for (const m of this._materials) m.uniforms.uLaserParams.value = tex;
        }
        if (old) old.dispose();
    }

    /** Réserve une ligne de paramètres pour un nouveau laser */
    allocRow() {
        if (this._freeRows.length > 0) return this._freeRows.pop();
        if (this._rows >= this._maxRows) this._allocParamsTexture(this._maxRows * 2);
        return this._rows++;
    }

    freeRow(row) {
        this._freeRows.push(row);
    }

    /** Accès direct aux floats d'une ligne (PARAM_TEXELS × 4 floats) */
    paramsRow(row) {
        const n = PARAM_TEXELS * 4;
        return this.paramsTexture.image.data.subarray(row * n, row * n + n);
    }

    /**
     * Assemble les sorties de tous les lasers dans les buffers GPU partagés.
     * @param {Iterable<import('./LaserShow.js').LaserShow>} lasers
     */
    assemble(lasers, smokeState) {
        this.beams.begin();
        this.impacts.begin();
        this.fans.begin();
        this.panImpacts.begin();
        this.glows.begin();

        for (const laser of lasers) {
            if (!laser.renderable) continue;
            const out = laser.output;
            if (laser._drawBeams) this.beams.append(out.beams, out.beamCount);
            if (laser._drawImpacts) this.impacts.append(out.impacts, out.impactCount);
            if (laser._drawFan) {
                this.fans.append(out.fans, out.fanCount);
                this.panImpacts.append(out.panImpacts, out.panImpactCount);
            }
            if (out.glow) {
                this._glowScratch[0] = laser.row;
                this.glows.append(this._glowScratch, 1);
            }
        }

        this.beams.end();
        this.impacts.end();
        this.fans.end();
        this.panImpacts.end();
        this.glows.end();

        // Paramètres par laser (≈ 150 octets / laser)
        this.paramsTexture.needsUpdate = true;

        if (smokeState) {
            this.fanMaterial.uniforms.uTime.value = smokeState.time || 0;
            if (smokeState.wind) this.fanMaterial.uniforms.uWind.value.copy(smokeState.wind);
        }

        this.beamsMesh.visible     = this.beams.count > 0;
        this.impactMesh.visible    = this.impacts.count > 0;
        this.fanMesh.visible       = this.fans.count > 0;
        this.panImpactMesh.visible = this.panImpacts.count > 0;
        this.glowMesh.visible      = this.glows.count > 0;
    }

    /** Objets de rendu du batch (pour le masquage dans les passes de bloom) */
    getMeshes() {
        return this.meshes;
    }

    /** Précompilation des shaders (évite tout gel au premier affichage) */
    compile(renderer, camera) {
        for (const m of this.meshes) {
            const wasVisible = m.visible;
            m.visible = true;
            try { renderer.compile(m, camera); } catch (_) {}
            m.visible = wasVisible;
        }
    }

    dispose() {
        for (const m of this.meshes) {
            this.scene.remove(m);
            m.geometry.dispose();
        }
        for (const m of this._materials) m.dispose();
        this.paramsTexture.dispose();
    }
}
