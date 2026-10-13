/**
 * LightPoolPass.js
 * ─────────────────────────────────────────────────────────────
 * Passe de scène des TACHES DE LUMIÈRE des lyres (voir LightPoolShaders.js). Remplace les 8 SpotLight
 * three.js de l'ancien SpotLightPool : toutes les lyres éclairent le décor (gobos, couleurs, prisme, ombres
 * statiques, reflets), pour un coût qui ne dépend que des pixels touchés par un cône.
 *
 * Ajoute aussi le rebond de la lumière indirecte (grille de GI) sur le décor quand la GI est active ; elle
 * tourne alors même sans tache (option « Taches de lumière » désactivée : GI seule).
 *
 * Insérée avant la passe SS Depth (le halo y lit les taches) ; sortie différée { kind: 'pool' } ajoutée par
 * FinalCompositePass avant le brouillard (pleine résolution : lecture directe ; ½ : remontée bilatérale).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createLightPoolMaterial } from './LightPoolShaders.js';
import { gpuPassTimer } from '../../render/GpuPassTimer.js';

/** « Auto » : pleine résolution jusqu'en 1080p, ½ au-delà (1440p, 4K) */
const AUTO_FULL_MAX_HEIGHT = 1100;

export class LightPoolPass extends Pass {
    /**
     * @param {import('../ssdepth/SSDepthLights.js').SSDepthLights} lights
     * @param {import('../SpotBatch.js').SpotBatch} batch
     * @param {THREE.PerspectiveCamera} camera
     * @param {object} shadowUniforms uniformes partagés des ombres statiques
     * @param {object} [giUniforms] uniformes partagés de la grille de GI
     */
    constructor(lights, batch, camera, shadowUniforms, giUniforms) {
        super();
        this.lights = lights;
        this.batch = batch;
        this.camera = camera;
        this.needsSwap = false;
        this.profileSelf = true;       // section de mesure GPU propre
        this.deferred = false;
        this.sceneDepth = null;
        this.resolution = 'auto';      // 'auto' | 1 | 2 (diviseur)
        this.div = 1;
        this.sharpness = 1.5;
        this.pools = true;             // taches de lumière (sinon : GI seule)
        this.giGain = 0;               // rebond de la GI sur le décor (0 = rien)
        this._width = 1;
        this._height = 1;
        this.target = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
        });
        this.material = createLightPoolMaterial(shadowUniforms, giUniforms);
        this._quad = new FullScreenQuad(this.material);
        this._out = { kind: 'pool', texture: null, scale: new THREE.Vector2(1, 1), div: 1, sharpness: 1.5 };
        this._hasOut = false;
    }

    /** Texture de la pelouse (albédo du sol), prise au matériau du sol de la scène */
    setGrassTexture(tex) {
        this.material.uniforms.uGrass.value = tex || null;
        this.material.uniforms.uGrassOn.value = tex ? 1 : 0;
    }

    deferredOutput() {
        return this._hasOut ? this._out : null;
    }

    /** @param {'auto'|number} res 'auto', 1 (pleine) ou 2 (½) */
    setResolution(res) {
        this.resolution = res;
        this.setSize(this._width, this._height);
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
        const div = this.resolution === 'auto' ? (height > AUTO_FULL_MAX_HEIGHT ? 2 : 1) : Math.max(1, Math.round(this.resolution) || 1);
        this.div = div;
        const w = Math.max(1, Math.ceil(width / div)), h = Math.max(1, Math.ceil(height / div));
        this.target.setSize(w, h);
        this._out.scale.set(width / (div * w), height / (div * h));
        this._out.div = div;
    }

    render(renderer, writeBuffer, readBuffer) {
        this._hasOut = false;
        const depth = this.sceneDepth && this.sceneDepth.texture;
        if (!depth || !this.deferred) return;
        const cam = this.camera;
        this.lights.ensureBinned(cam);
        const pools = this.pools && this.lights.poolVisible > 0;
        if (!pools && !(this.giGain > 0)) return;

        const u = this.material.uniforms;
        u.uDepth.value = depth;
        u.uSpotParams.value = this.batch.paramsTexture;
        u.uGobos.value = this.batch.goboTexture;
        u.uGateAtlas.value = this.batch.gateAtlas.texture;
        u.uSSLights.value = this.lights.lightsTexture;
        u.uPoolTiles.value = this.lights.poolTilesTexture;
        u.uFull.value.set(this._width, this._height);
        u.uDiv.value = this.div;
        u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
        u.uCamRot.value.setFromMatrix4(cam.matrixWorld);
        const p = cam.projectionMatrix.elements;
        u.uProjK.value.set(1 / p[0], 1 / p[5], p[8], p[9]);
        u.uNear.value = cam.near;
        u.uFar.value = cam.far;
        u.uPoolsOn.value = pools ? 1 : 0;
        u.uGIGain.value = this.giGain;

        const timer = gpuPassTimer.enabled ? gpuPassTimer : null;
        const oldAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        if (timer) timer.begin('Taches de lumière');
        renderer.setRenderTarget(this.target);
        this._quad.render(renderer);
        if (timer) timer.end();
        renderer.autoClear = oldAutoClear;

        this._out.texture = this.target.texture;
        this._out.sharpness = this.sharpness;
        this._hasOut = true;
    }

    dispose() {
        this.target.dispose();
        this.material.dispose();
        this._quad.dispose();
    }
}
