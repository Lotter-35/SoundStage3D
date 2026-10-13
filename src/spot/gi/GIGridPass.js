/**
 * GIGridPass.js
 * ─────────────────────────────────────────────────────────────
 * LUMIÈRE INDIRECTE (GI, plan R5) : grille 3D de la salle (comme le banc C++ : 48 × 16 × 64), éclairée par
 * la lumière des lyres renvoyée par le décor (un rebond), mise à jour par TRANCHES et lissée dans le temps.
 * Lue par le décor (LightPoolShaders : rebond × albédo) et par le brouillard de salle (HazeShaders).
 *
 * Par image :
 *   1. lumières virtuelles : K rayons par cône de lyre (budget total fixe, K = budget / cônes, 2 à 16),
 *      arrêtés sur le décor par la cubemap de distances de la lyre (GIShaders.js) — une petite texture ;
 *   2. 1/div des couches z de la grille (div = 4 en Haute, 8 en Basse), une couche par dessin ; mélange
 *      alpha (nouvelle valeur × α + ancienne × (1 − α)) : une lyre qui bouge ne fait pas scintiller la GI.
 *
 * Choix de la texture 3D (WebGL3DRenderTarget, RGBA16F) plutôt qu'un atlas 2D de couches : la lecture est
 * le chemin chaud (chaque pixel du décor, chaque tranche du brouillard) et le filtrage trilinéaire matériel
 * la fait en 1 lecture (atlas 2D : 2 lectures + interpolation en z à la main) ; l'écriture couche par
 * couche ne coûte qu'un dessin par couche (16 par image au plus) sur une cible minuscule (48 × 16).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createVPLMaterial, createGIGridMaterial, GI_MAX_VPL_PER_CONE, GI_MAX_BEAM_PTS } from './GIShaders.js';
import { createGIUniforms } from './giGLSL.js';
import { SS_MAX_LIGHTS } from '../ssdepth/SSDepthLights.js';
import { gpuPassTimer } from '../../render/GpuPassTimer.js';

/** Qualités (option locale « Qualité GI ») : taille de la grille, couches par image (1/div), budget de
 *  lumières virtuelles, lissage temporel (α par mise à jour d'une cellule) */
export const GI_QUALITIES = {
    low:  { dims: [32, 12, 40], div: 8, vpl: 192, alpha: 0.6 },
    high: { dims: [48, 16, 64], div: 4, vpl: 512, alpha: 0.5 },
};

/** Volume couvert : plateau, mur du fond, toit et 50 m de public (m) */
export const GI_BOUNDS_MIN = [-24, -0.5, -12];
export const GI_BOUNDS_SIZE = [48, 22, 64];

export class GIGridPass extends Pass {
    /**
     * @param {import('../ssdepth/SSDepthLights.js').SSDepthLights} lights
     * @param {import('../SpotBatch.js').SpotBatch} batch
     * @param {object} shadowUniforms uniformes partagés des ombres statiques
     */
    constructor(lights, batch, shadowUniforms) {
        super();
        this.lights = lights;
        this.batch = batch;
        this.needsSwap = false;
        this.profileSelf = true;
        this.enabled = false;
        /** Uniformes de lecture partagés par le décor et le brouillard */
        this.uniforms = createGIUniforms();
        this.uniforms.uGIMin.value.fromArray(GI_BOUNDS_MIN);
        this.uniforms.uGISize.value.fromArray(GI_BOUNDS_SIZE);
        /** Vrai quand la grille contient de la lumière (les lecteurs peuvent la lire) */
        this.active = false;
        this.quality = null;
        this.grid = null;
        this.gain = 60;
        this.hazeK = 0.6 * 0.035;      // densité de la fumée des faisceaux (lumière diffusée autour d'eux)
        this.vplCount = 0;
        this.layersPerFrame = 0;
        this._frame = 0;
        this._fill = 0;
        this._hasLight = false;
        this.vplTarget = new THREE.WebGLRenderTarget(2 * (GI_MAX_VPL_PER_CONE + GI_MAX_BEAM_PTS), SS_MAX_LIGHTS, {
            type: THREE.FloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        });
        this.vplMaterial = createVPLMaterial(shadowUniforms);
        this.gridMaterial = createGIGridMaterial();
        this._vplQuad = new FullScreenQuad(this.vplMaterial);
        this._gridQuad = new FullScreenQuad(this.gridMaterial);
    }

    /** @param {'off'|'low'|'high'} q qualité (option locale) */
    setQuality(q) {
        const Q = GI_QUALITIES[q] || null;
        if (Q === this.quality) return;
        this.quality = Q;
        if (this.grid) { this.grid.dispose(); this.grid = null; }
        this.active = false;
        this._hasLight = false;
        if (!Q) { this.uniforms.uGI.value = null; return; }
        const [nx, ny, nz] = Q.dims;
        const grid = new THREE.WebGL3DRenderTarget(nx, ny, nz, {
            type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
        });
        // three r160 : la texture 3D de la cible ignore les options (type à poser à la main)
        const t = grid.texture;
        t.type = THREE.HalfFloatType;
        t.format = THREE.RGBAFormat;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
        t.generateMipmaps = false;
        this.grid = grid;
        this.uniforms.uGI.value = t;
        this.uniforms.uGIEdge.value.set(0.5 / nx, 0.5 / ny, 0.5 / nz);
        const u = this.gridMaterial.uniforms;
        u.uMin.value.fromArray(GI_BOUNDS_MIN);
        u.uCell.value.set(GI_BOUNDS_SIZE[0] / nx, GI_BOUNDS_SIZE[1] / ny, GI_BOUNDS_SIZE[2] / nz);
        u.uR0.value = 0.35 * u.uCell.value.lengthSq();
        this._cleared = false;
    }

    /** Lumière effacée (GI désactivée puis réactivée : pas de reste d'une ancienne image) */
    reset() {
        this._hasLight = false;
        this.active = false;
    }

    /** Texture de la pelouse (albédo du sol) */
    setGrassTexture(tex) {
        this.vplMaterial.uniforms.uGrass.value = tex || null;
        this.vplMaterial.uniforms.uGrassOn.value = tex ? 1 : 0;
    }

    /** Couches de la grille remises à zéro (aucune lumière) */
    _clear(renderer) {
        const nz = this.quality.dims[2];
        const old = renderer.getClearColor(new THREE.Color());
        const oldA = renderer.getClearAlpha();
        renderer.setClearColor(0x000000, 0);
        for (let z = 0; z < nz; z++) {
            renderer.setRenderTarget(this.grid, z);
            renderer.clear(true, false, false);
        }
        renderer.setClearColor(old, oldA);
    }

    render(renderer) {
        const Q = this.quality;
        if (!Q || !this.grid) { this.active = false; return; }
        const n = Math.min(this.lights.count, SS_MAX_LIGHTS);
        const oldAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        if (n === 0) {
            // Plus aucune lyre allumée : grille vidée une fois, plus rien à lire
            if (this._hasLight || !this._cleared) { this._clear(renderer); this._cleared = true; }
            this._hasLight = false;
            this.active = false;
            this.vplCount = 0;
            renderer.autoClear = oldAutoClear;
            return;
        }
        if (!this._hasLight) {
            // Première lumière (ou grille neuve) : un cycle complet sans lissage
            this._fill = Q.div;
            this._hasLight = true;
        }
        const timer = gpuPassTimer.enabled ? gpuPassTimer : null;
        // Budget : ⅗ sur le décor, ⅖ le long des faisceaux
        const K = Math.max(2, Math.min(GI_MAX_VPL_PER_CONE, Math.floor(Q.vpl * 0.6 / n)));
        const M = this.hazeK > 0 ? Math.max(1, Math.min(GI_MAX_BEAM_PTS, Math.floor(Q.vpl * 0.4 / n))) : 0;
        this.vplCount = (K + M) * n;

        // 1. Lumières virtuelles (K par cône)
        const v = this.vplMaterial.uniforms;
        v.uSpotParams.value = this.batch.paramsTexture;
        v.uGobos.value = this.batch.goboTexture;
        v.uGateAtlas.value = this.batch.gateAtlas.texture;
        v.uSSLights.value = this.lights.lightsTexture;
        v.uK.value = K;
        v.uM.value = M;
        v.uHazeK.value = this.hazeK;
        v.uSpin.value = (this._frame * 0.618034 % 1) * 6.2831853;
        v.uGain.value = this.gain;
        if (timer) timer.begin('GI (lumières virtuelles)');
        this.vplTarget.viewport.set(0, 0, 2 * (K + M), n);
        renderer.setRenderTarget(this.vplTarget);
        this._vplQuad.render(renderer);

        // 2. Couches de la grille : 1/div par image, lissées dans le temps
        if (timer) timer.begin('GI (grille)');
        const g = this.gridMaterial.uniforms;
        g.uVPL.value = this.vplTarget.texture;
        g.uCones.value = n;
        g.uK.value = K;
        g.uM.value = M;
        g.uAlpha.value = this._fill > 0 ? 1 : Q.alpha;
        const nz = Q.dims[2];
        const phase = this._frame % Q.div;
        let layers = 0;
        for (let z = phase; z < nz; z += Q.div) {
            g.uZ.value = z;
            renderer.setRenderTarget(this.grid, z);
            this._gridQuad.render(renderer);
            layers++;
        }
        if (timer) timer.end();
        this.layersPerFrame = layers;
        if (this._fill > 0) this._fill--;
        this._frame++;
        this.active = true;
        renderer.autoClear = oldAutoClear;
    }

    dispose() {
        if (this.grid) this.grid.dispose();
        this.vplTarget.dispose();
        this.vplMaterial.dispose();
        this.gridMaterial.dispose();
        this._vplQuad.dispose();
        this._gridQuad.dispose();
    }
}
