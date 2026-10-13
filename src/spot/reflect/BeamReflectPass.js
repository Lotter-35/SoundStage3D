/**
 * BeamReflectPass.js
 * ─────────────────────────────────────────────────────────────
 * Passe de scène des REFLETS DES FAISCEAUX (plan R6, voir BeamReflectShaders.js) : faisceaux SS Depth vus en
 * reflet dans le dessus brillant du plateau, en ¼ ou ⅛ de résolution, floutés (rugosité du lino) puis
 * remontés en pleine résolution par FinalCompositePass (remontée bilatérale guidée par la profondeur,
 * avant le brouillard) — sortie différée { kind: 'refl' }.
 *
 * Choix des cônes : un rayon réfléchi peut toucher n'importe quel faisceau, les listes des tuiles de l'écran
 * ne servent pas. Mesuré (SwiftShader, ¼) : boucle sur tous les faisceaux dans chaque tuile 1,55 × plus lente
 * que des listes triées en miroir du plan du plateau (9 lyres vues sur le plateau ; 1,2 × avec 50 lyres et peu
 * de plateau à l'écran), et une liste globale serait tronquée à 128 cônes (50 lyres à prisme = 450 cônes) →
 * tri en miroir (SSReflectBins, même code CPU que le tri des faisceaux, 0,1 à 0,3 ms pour 50 lyres).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createBeamReflectMaterial, createReflectBlurMaterial } from './BeamReflectShaders.js';
import { SSReflectBins } from './SSReflectBins.js';
import { gpuPassTimer } from '../../render/GpuPassTimer.js';

/** Dessus du plateau (stage.js : boîte de 3,05 m centrée à 1,475 m) */
export const STAGE_DECK_Y = 3.0;

export class BeamReflectPass extends Pass {
    /**
     * @param {import('../ssdepth/SSDepthLights.js').SSDepthLights} lights
     * @param {import('../SpotBatch.js').SpotBatch} batch
     * @param {THREE.PerspectiveCamera} camera
     * @param {object} shadowUniforms uniformes partagés des ombres statiques
     */
    constructor(lights, batch, camera, shadowUniforms) {
        super();
        this.lights = lights;
        this.batch = batch;
        this.camera = camera;
        this.needsSwap = false;
        this.profileSelf = true;
        this.enabled = false;
        this.deferred = false;
        this.sceneDepth = null;
        this.planeY = STAGE_DECK_Y;
        this.div = 4;
        this.gain = 1;
        this.haze = 0.6;
        this.phaseG = 0.72;
        this.sharpness = 1.5;
        this.bins = new SSReflectBins(lights);
        this._width = 1;
        this._height = 1;
        const opts = {
            type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
        };
        this.target = new THREE.WebGLRenderTarget(1, 1, opts);
        this.blurTarget = new THREE.WebGLRenderTarget(1, 1, opts);
        this.material = createBeamReflectMaterial(shadowUniforms);
        this.blurMaterial = createReflectBlurMaterial();
        this._quad = new FullScreenQuad(this.material);
        this._blurQuad = new FullScreenQuad(this.blurMaterial);
        this._out = { kind: 'refl', texture: null, scale: new THREE.Vector2(1, 1), sharpness: 1.5 };
        this._hasOut = false;
    }

    deferredOutput() {
        return this._hasOut ? this._out : null;
    }

    /** @param {number} div diviseur de résolution (4 = ¼, 8 = ⅛) */
    setDivisor(div) {
        this.div = Math.max(2, Math.min(16, Math.round(div) || 4));
        this.setSize(this._width, this._height);
    }

    /** Caméra au-dessus du plateau : sinon son dessus n'est pas visible, rien à refléter */
    cameraSeesDeck() {
        return this.camera.matrixWorld.elements[13] > this.planeY + 0.05;
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
        const w = Math.max(1, Math.ceil(width / this.div)), h = Math.max(1, Math.ceil(height / this.div));
        this.target.setSize(w, h);
        this.blurTarget.setSize(w, h);
        this._out.scale.set(width / (this.div * w), height / (this.div * h));
    }

    render(renderer) {
        this._hasOut = false;
        const depth = this.sceneDepth && this.sceneDepth.texture;
        if (!depth || !this.deferred || !this.cameraSeesDeck()) return;
        const cam = this.camera;
        this.bins.ensureBinned(cam, this.planeY);
        if (this.bins.visible === 0) return;

        const u = this.material.uniforms;
        u.uDepth.value = depth;
        u.uSpotParams.value = this.batch.paramsTexture;
        u.uGobos.value = this.batch.goboTexture;
        u.uGateAtlas.value = this.batch.gateAtlas.texture;
        u.uSSLights.value = this.lights.lightsTexture;
        u.uReflTiles.value = this.bins.texture;
        u.uFull.value.set(this._width, this._height);
        u.uDiv.value = this.div;
        u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
        u.uCamRot.value.setFromMatrix4(cam.matrixWorld);
        const p = cam.projectionMatrix.elements;
        u.uProjK.value.set(1 / p[0], 1 / p[5], p[8], p[9]);
        u.uNear.value = cam.near;
        u.uFar.value = cam.far;
        u.uHazeK.value = this.haze * 0.035;
        u.uPhaseG.value = this.phaseG;
        u.uPlaneY.value = this.planeY;
        u.uGain.value = this.gain;

        const timer = gpuPassTimer.enabled ? gpuPassTimer : null;
        const oldAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        if (timer) timer.begin('Reflets des faisceaux');
        renderer.setRenderTarget(this.target);
        this._quad.render(renderer);
        // Flou de rugosité : même largeur à l'écran quelle que soit la résolution (pas de 1,5 texel en ¼)
        this.blurMaterial.uniforms.tSrc.value = this.target.texture;
        this.blurMaterial.uniforms.uStep.value = Math.max(0.5, 6 / this.div);
        renderer.setRenderTarget(this.blurTarget);
        this._blurQuad.render(renderer);
        if (timer) timer.end();
        renderer.autoClear = oldAutoClear;

        this._out.texture = this.blurTarget.texture;
        this._out.sharpness = this.sharpness;
        this._hasOut = true;
    }

    dispose() {
        this.target.dispose();
        this.blurTarget.dispose();
        this.material.dispose();
        this.blurMaterial.dispose();
        this._quad.dispose();
        this._blurQuad.dispose();
        this.bins.dispose();
    }
}
