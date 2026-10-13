/**
 * SSDepthPass.js
 * ─────────────────────────────────────────────────────────────
 * Passe de scène des faisceaux « SS Depth » (lyres en mode SS Depth) + halo atmosphérique.
 * Insérée après la passe des faisceaux classiques (SpotVolumePass) ; recomposée par FinalCompositePass
 * (remontée bilatérale 3×3 guidée par la profondeur, avant le brouillard).
 *
 *   1. tri des cônes par tuile (CPU, SSDepthLights.bin, une fois par image : partagé avec les taches de
 *      lumière) avec les matrices de la caméra du rendu ;
 *   2. passe des faisceaux en basse résolution (image / div, div = 2, 3 ou 4) ;
 *   3. halo atmosphérique (si intensité > 0) à la même résolution, ajouté aux faisceaux (il lit aussi les
 *      taches de lumière de LightPoolPass) ;
 *   4. retouche des bords en pleine résolution (pixels dont les voisins réduits diffèrent : faisceaux
 *      recalculés exactement ; ailleurs remontée bilatérale) ;
 *   5. sortie différée { kind: 'ss', full: true } lue par la passe finale (1 lecture par pixel).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createSSBeamMaterial, createSSHaloMaterial, createHaloSourceMaterial } from './SSDepthShaders.js';
import { gpuPassTimer } from '../../render/GpuPassTimer.js';

export class SSDepthPass extends Pass {
    /**
     * @param {import('./SSDepthLights.js').SSDepthLights} lights
     * @param {import('../SpotBatch.js').SpotBatch} batch
     * @param {THREE.PerspectiveCamera} camera
     * @param {object} [shadowUniforms] uniformes partagés des ombres statiques (SpotShadowAtlas.uniforms)
     */
    constructor(lights, batch, camera, shadowUniforms) {
        super();
        this.lights = lights;
        this.batch = batch;
        this.camera = camera;
        this.needsSwap = false;
        this.profileSelf = true;       // sections de mesure GPU propres (faisceaux, halo)
        this.deferred = false;         // passe à true par LaserManager.addScenePass
        this.sceneDepth = null;        // { texture } : profondeur de la scène
        this.classicPass = null;       // SpotVolumePass : ses faisceaux entrent dans le halo
        this.poolPass = null;          // LightPoolPass : ses taches entrent dans le halo
        this.splash = true;            // tache simple sur la surface (passe des taches désactivée)
        this.div = 3;
        this.sharpness = 1.5;
        this.refine = true;            // retouche des bords en pleine résolution
        this.haloIntensity = 0.5;
        this.haloRadius = 1.0;
        this.haze = 0.6;
        this.phaseG = 0.72;
        this._width = 1;
        this._height = 1;
        const opts = {
            type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
        };
        this.beamTarget = new THREE.WebGLRenderTarget(1, 1, opts);
        this.haloTarget = new THREE.WebGLRenderTarget(1, 1, opts);
        // Scène + faisceaux + taches réduits, avec mipmaps (lecture floutée par le halo)
        // Retouche des bords en pleine résolution (sortie lue par la passe finale)
        this.refineTarget = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        });
        this.haloSrcTarget = new THREE.WebGLRenderTarget(1, 1, {
            ...opts, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true,
        });
        this.beamMaterial = createSSBeamMaterial(shadowUniforms);
        // Même code de faisceaux, en pleine résolution sur les bords ; uniformes communs partagés
        this.refineMaterial = createSSBeamMaterial(shadowUniforms, { refine: true });
        for (const k of Object.keys(this.beamMaterial.uniforms)) {
            if (!['tLow', 'tBeamLow', 'uLowScale', 'uSharp'].includes(k)) this.refineMaterial.uniforms[k] = this.beamMaterial.uniforms[k];
        }
        this._refineQuad = new FullScreenQuad(this.refineMaterial);
        this.haloMaterial = createSSHaloMaterial();
        this.haloSrcMaterial = createHaloSourceMaterial();
        this._haloSrcQuad = new FullScreenQuad(this.haloSrcMaterial);
        this._beamQuad = new FullScreenQuad(this.beamMaterial);
        this._haloQuad = new FullScreenQuad(this.haloMaterial);
        this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
        this._black.needsUpdate = true;
        this._out = { kind: 'ss', texture: null, scale: new THREE.Vector2(1, 1), texel: new THREE.Vector2(1, 1), sharpness: 1.5, full: true };
        this._hasOut = false;
        this._fullSize = new THREE.Vector2(1, 1);
        this._lowSize = new THREE.Vector2(1, 1);
    }

    /** Image à recomposer, ou null */
    deferredOutput() {
        return this._hasOut ? this._out : null;
    }

    /** @param {number} div diviseur de résolution (2, 3 ou 4) */
    setDivisor(div) {
        const d = Math.max(1, Math.min(8, Math.round(div) || 3));
        if (d === this.div) return;
        this.div = d;
        this.setSize(this._width, this._height);
    }

    get lowWidth() { return this.beamTarget.width; }
    get lowHeight() { return this.beamTarget.height; }

    setSize(width, height) {
        this._width = width;
        this._height = height;
        const w = Math.max(1, Math.ceil(width / this.div));
        const h = Math.max(1, Math.ceil(height / this.div));
        this.beamTarget.setSize(w, h);
        this.haloTarget.setSize(w, h);
        this.haloSrcTarget.setSize(w, h);
        this.refineTarget.setSize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
        this._fullSize.set(width, height);
        this._lowSize.set(w, h);
        this._out.scale.set(width / (this.div * w), height / (this.div * h));
        this._out.texel.set(1 / w, 1 / h);
    }

    render(renderer, writeBuffer, readBuffer) {
        this._hasOut = false;
        const depth = this.sceneDepth && this.sceneDepth.texture;
        if (!depth) return;
        const cam = this.camera;
        const timer = gpuPassTimer.enabled ? gpuPassTimer : null;

        // Tri des cônes par tuile (matrices de la caméra mises à jour par le rendu de la scène)
        this.lights.ensureBinned(cam);

        const u = this.beamMaterial.uniforms;
        u.uDepth.value = depth;
        u.uSpotParams.value = this.batch.paramsTexture;
        u.uGobos.value = this.batch.goboTexture;
        u.uGateAtlas.value = this.batch.gateAtlas.texture;
        u.uSSLights.value = this.lights.lightsTexture;
        u.uSSTiles.value = this.lights.tilesTexture;
        u.uFull.value.copy(this._fullSize);
        u.uDiv.value = this.div;
        u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
        u.uCamRot.value.setFromMatrix4(cam.matrixWorld);
        const p = cam.projectionMatrix.elements;
        u.uProjK.value.set(1 / p[0], 1 / p[5], p[8], p[9]);
        u.uNear.value = cam.near;
        u.uFar.value = cam.far;
        u.uHazeK.value = this.haze * 0.035;
        u.uPhaseG.value = this.phaseG;
        u.uSplashOn.value = this.splash ? 1 : 0;

        const oldAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        if (timer) timer.begin('Faisceaux SS');
        renderer.setRenderTarget(this.beamTarget);
        this._beamQuad.render(renderer);
        if (timer) timer.end();

        let out = this.beamTarget.texture;
        if (this.haloIntensity > 0.005) {
            const hs = this.haloSrcMaterial.uniforms;
            hs.tScene.value = readBuffer.texture;
            const classic = this.classicPass && this.classicPass.enabled && this.classicPass.deferredOutput
                ? this.classicPass.deferredOutput() : null;
            hs.tClassic.value = classic ? classic.texture : this._black;
            hs.uClassicOn.value = classic ? 1 : 0;
            const pool = this.poolPass && this.poolPass.enabled ? this.poolPass.deferredOutput() : null;
            hs.tPool.value = pool ? pool.texture : this._black;
            hs.uPoolOn.value = pool ? 1 : 0;
            if (pool) hs.uPoolScale.value.copy(pool.scale);
            hs.uFull.value.copy(this._fullSize);
            hs.uDiv.value = this.div;
            hs.tSS.value = this.beamTarget.texture;
            const h = this.haloMaterial.uniforms;
            h.tSrc.value = this.haloSrcTarget.texture;
            h.tSS.value = this.beamTarget.texture;
            h.uFull.value.copy(this._fullSize);
            h.uLow.value.copy(this._lowSize);
            h.uDiv.value = this.div;
            h.uIntensity.value = this.haloIntensity;
            h.uRadius.value = this.haloRadius;
            if (timer) timer.begin('Halo SS');
            renderer.setRenderTarget(this.haloSrcTarget);
            this._haloSrcQuad.render(renderer);
            renderer.setRenderTarget(this.haloTarget);
            this._haloQuad.render(renderer);
            if (timer) timer.end();
            out = this.haloTarget.texture;
        }
        // Retouche des bords en pleine résolution
        this._out.full = this.refine;
        this._out.texture = out;
        if (this.refine) {
            const r = this.refineMaterial.uniforms;
            r.tLow.value = out;
            r.tBeamLow.value = this.beamTarget.texture;
            r.uLowScale.value.copy(this._out.scale);
            r.uSharp.value = this.sharpness;
            if (timer) timer.begin('Bords des faisceaux SS');
            renderer.setRenderTarget(this.refineTarget);
            this._refineQuad.render(renderer);
            if (timer) timer.end();
            this._out.texture = this.refineTarget.texture;
        }
        renderer.autoClear = oldAutoClear;

        this._out.sharpness = this.sharpness;
        this._hasOut = true;
        if (!this.deferred) {
            // Sans passe finale (cas de secours) : rien n'est recomposé
            this._hasOut = false;
        }
    }

    dispose() {
        this.beamTarget.dispose();
        this.haloTarget.dispose();
        this.haloSrcTarget.dispose();
        this.refineTarget.dispose();
        this.refineMaterial.dispose();
        this._refineQuad.dispose();
        this.haloSrcMaterial.dispose();
        this._haloSrcQuad.dispose();
        this.beamMaterial.dispose();
        this.haloMaterial.dispose();
        this._beamQuad.dispose();
        this._haloQuad.dispose();
        this._black.dispose();
    }
}
