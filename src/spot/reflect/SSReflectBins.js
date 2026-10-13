/**
 * SSReflectBins.js
 * ─────────────────────────────────────────────────────────────
 * Listes de cônes par tuile pour les REFLETS DES FAISCEAUX (plan R6) sur le plateau brillant.
 *
 * Un rayon réfléchi par un plan horizontal y = h est exactement le rayon de vue prolongé sous le plan puis
 * retourné : un point X vu en reflet par un pixel est l'image miroir M·X vue par la caméra à travers ce
 * même pixel. Les cônes sont donc triés par tuile avec la vue « caméra × miroir » (mêmes projection et
 * découpage que SSDepthLights : _project / _raster), une fois par image, faisceaux SS Depth seulement.
 * Les surfaces brillantes à une autre hauteur que le plan (marches, table) ne sont pas reflétées.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { SS_TILE_COUNT, SS_TILE_TEXELS, SS_MAX_PER_TILE, SS_GEO, SS_FLAG_BEAM } from '../ssdepth/SSDepthLights.js';

export class SSReflectBins {
    /** @param {import('../ssdepth/SSDepthLights.js').SSDepthLights} lights */
    constructor(lights) {
        this.lights = lights;
        this._data = new Uint16Array(SS_TILE_COUNT * SS_TILE_TEXELS * 4);
        this._counts = new Uint16Array(SS_TILE_COUNT);
        this.texture = new THREE.DataTexture(this._data, SS_TILE_TEXELS, SS_TILE_COUNT, THREE.RGBAIntegerFormat, THREE.UnsignedShortType);
        this.texture.internalFormat = 'RGBA16UI';
        this.texture.minFilter = THREE.NearestFilter;
        this.texture.magFilter = THREE.NearestFilter;
        this.texture.generateMipmaps = false;
        this.texture.needsUpdate = true;
        this.visible = 0;          // cônes reflétés présents dans au moins une tuile
        this._binnedId = -1;
        /** Mesure : tous les faisceaux dans chaque tuile (boucle globale, sans tri en miroir) */
        this.allCones = false;
        this._mirror = new THREE.Matrix4();
        this._view = new THREE.Matrix4();
    }

    /** Tri une seule fois par image (même cônes, même caméra) */
    ensureBinned(camera, planeY) {
        const id = this.lights._collectId;
        if (this._binnedId === id) return;
        this._binnedId = id;
        this.bin(camera, planeY);
    }

    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {number} planeY hauteur du plan brillant (m)
     */
    bin(camera, planeY) {
        const L = this.lights;
        const counts = this._counts, data = this._data;
        counts.fill(0);
        // Miroir du plan y = h : (x, y, z) → (x, 2h − y, z), puis vue de la caméra
        this._mirror.set(1, 0, 0, 0, 0, -1, 0, 2 * planeY, 0, 0, 1, 0, 0, 0, 0, 1);
        this._view.multiplyMatrices(camera.matrixWorldInverse, this._mirror);
        const v = this._view.elements;
        const p = camera.projectionMatrix.elements;
        const near = camera.near;
        const geo = L._geo;
        let visible = 0;
        for (let li = 0; li < L.count; li++) {
            if (!(geo[li * SS_GEO + 18] & SS_FLAG_BEAM)) continue;
            if (this.allCones) {
                for (let t = 0; t < SS_TILE_COUNT; t++) {
                    const c = counts[t];
                    if (c >= SS_MAX_PER_TILE) continue;
                    data[(t * SS_TILE_TEXELS + 1 + (c >> 2)) * 4 + (c & 3)] = li;
                    counts[t] = c + 1;
                }
                visible++;
            } else if (L._project(li, 4, v, p, near) && L._raster(li, counts, data)) visible++;
        }
        for (let t = 0; t < SS_TILE_COUNT; t++) data[t * SS_TILE_TEXELS * 4] = counts[t];
        this.visible = visible;
        this.texture.needsUpdate = true;
    }

    dispose() {
        this.texture.dispose();
    }
}
