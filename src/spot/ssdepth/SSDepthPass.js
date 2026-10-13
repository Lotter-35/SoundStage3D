/**
 * SSDepthPass.js
 * ─────────────────────────────────────────────────────────────
 * Passe de scène des faisceaux « SS Depth » (lyres en mode SS Depth).
 * Insérée après la passe des faisceaux classiques (SpotVolumePass) ; recomposée par FinalCompositePass
 * (avant le brouillard).
 *
 *   1. tri des cônes par tuile (CPU, SSDepthLights.bin, une fois par image : partagé avec les taches de
 *      lumière) avec les matrices de la caméra du rendu ;
 *   2. passe des faisceaux en basse résolution (image / div, div = 2, 3 ou 4) ;
 *   3. retouche des bords en pleine résolution (pixels dont les voisins réduits diffèrent : faisceaux
 *      recalculés exactement, seulement dans les tuiles où passent peu de cônes ; ailleurs remontée
 *      bilatérale) ;
 *   4. sortie différée { kind: 'ss', full: true } lue par la passe finale (1 lecture par pixel).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createSSBeamMaterial } from './SSDepthShaders.js';
import { gpuPassTimer } from '../../render/GpuPassTimer.js';

/** Retouche des bords : au-delà de ce nombre de cônes dans la tuile, remontée bilatérale seulement
 *  (recalculer des centaines de cônes sur chaque bord coûtait plusieurs ms ; le détail ne s'y voit pas) */
const REFINE_MAX_CONES = 24;

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
        this.profileSelf = true;       // sections de mesure GPU propres (faisceaux, bords)
        this.deferred = false;         // passe à true par LaserManager.addScenePass
        this.sceneDepth = null;        // { texture } : profondeur de la scène
        this.splash = true;            // tache simple sur la surface (passe des taches désactivée)
        this.div = 3;
        this.sharpness = 1.5;
        this.refine = true;            // retouche des bords en pleine résolution
        this.haze = 0.6;
        this.phaseG = 0.72;
        this._width = 1;
        this._height = 1;
        this.beamTarget = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
        });
        // Retouche des bords en pleine résolution (sortie lue par la passe finale)
        this.refineTarget = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        });
        this.beamMaterial = createSSBeamMaterial(shadowUniforms);
        // Même code de faisceaux, en pleine résolution sur les bords ; uniformes communs partagés
        this.refineMaterial = createSSBeamMaterial(shadowUniforms, { refine: true });
        for (const k of Object.keys(this.beamMaterial.uniforms)) {
            if (!['tBeamLow', 'uLowScale', 'uSharp', 'uRefineMax'].includes(k)) this.refineMaterial.uniforms[k] = this.beamMaterial.uniforms[k];
        }
        this.refineMaterial.uniforms.uRefineMax.value = REFINE_MAX_CONES;
        this._beamQuad = new FullScreenQuad(this.beamMaterial);
        this._refineQuad = new FullScreenQuad(this.refineMaterial);
        this._out = { kind: 'ss', texture: null, scale: new THREE.Vector2(1, 1), texel: new THREE.Vector2(1, 1), sharpness: 1.5, full: true };
        this._hasOut = false;
        this._fullSize = new THREE.Vector2(1, 1);
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
        this.refineTarget.setSize(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
        this._fullSize.set(width, height);
        this._out.scale.set(width / (this.div * w), height / (this.div * h));
        this._out.texel.set(1 / w, 1 / h);
    }

    render(renderer) {
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

        // Retouche des bords en pleine résolution
        this._out.full = this.refine;
        this._out.texture = this.beamTarget.texture;
        if (this.refine) {
            const r = this.refineMaterial.uniforms;
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
        // Sans passe finale (cas de secours) : rien n'est recomposé
        this._hasOut = this.deferred;
    }

    dispose() {
        this.beamTarget.dispose();
        this.refineTarget.dispose();
        this.beamMaterial.dispose();
        this.refineMaterial.dispose();
        this._beamQuad.dispose();
        this._refineQuad.dispose();
    }
}
