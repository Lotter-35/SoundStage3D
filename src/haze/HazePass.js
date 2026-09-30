/**
 * HazePass.js
 * ─────────────────────────────────────────────────────────────
 * Passe de post-traitement du brouillard de salle, insérée après le rendu de la scène
 * (et après les faisceaux des lyres) :
 *   1. calcule la lumière diffusée + la transmittance dans une cible réduite
 *      (quart / demi / pleine résolution) — le brouillard est doux, la basse résolution ne se voit pas
 *   2. compose : image × transmittance + lumière diffusée
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createHazeCompositeMaterial } from './HazeShaders.js';
import { resolveResolutionScale } from '../render/resolutionScale.js';

export class HazePass extends Pass {
    /**
     * @param {THREE.ShaderMaterial} hazeMaterial
     * @param {THREE.PerspectiveCamera} camera
     * @param {{ texture: THREE.DepthTexture|null }} sceneDepth profondeur de la scène (fournie par le LaserManager)
     */
    constructor(hazeMaterial, camera, sceneDepth) {
        super();
        this.material = hazeMaterial;
        this.camera = camera;
        this.sceneDepth = sceneDepth;
        this.needsSwap = true;
        this.resolutionScale = 0.25;
        this.resolutionSetting = this.resolutionScale;
        this.resolutionFactor = 1;
        this._w = 1;
        this._h = 1;
        this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
        this.target.texture.generateMipmaps = false;
        this._quad = new FullScreenQuad(hazeMaterial);
        this._composite = createHazeCompositeMaterial();
        this._compQuad = new FullScreenQuad(this._composite);
        this._fwd = new THREE.Vector3();

        // Recomposition différée : le brouillard est appliqué par la passe finale unique
        this.deferred = false;
        this._out = { kind: 'haze', texture: this.target.texture, res: new THREE.Vector2(1, 1) };
        this._hasOut = false;
    }

    /** Image à recomposer (mode différé) */
    deferredOutput() {
        return this._hasOut ? this._out : null;
    }

    /** @param {number|'auto'} s échelle par axe (ou 'auto' : selon la taille de l'image), × factor */
    setResolutionScale(s, factor = 1) {
        this.resolutionSetting = s;
        this.resolutionFactor = factor;
        this.setSize(this._w, this._h);
    }

    setSize(width, height) {
        this._w = width;
        this._h = height;
        this.resolutionScale = resolveResolutionScale(this.resolutionSetting, width, height) * this.resolutionFactor;
        this.target.setSize(Math.max(1, Math.round(width * this.resolutionScale)), Math.max(1, Math.round(height * this.resolutionScale)));
    }

    render(renderer, writeBuffer, readBuffer) {
        this._hasOut = false;
        const depth = (this.sceneDepth && this.sceneDepth.texture) || readBuffer.depthTexture;
        const u = this.material.uniforms;
        const cam = this.camera;
        u.uDepth.value = depth;
        u.uInvProj.value.copy(cam.projectionMatrixInverse);
        u.uCamWorld.value.copy(cam.matrixWorld);
        cam.getWorldDirection(this._fwd);
        u.uCamFwd.value.copy(this._fwd);
        u.uNear.value = cam.near;
        u.uFar.value = cam.far;

        renderer.setRenderTarget(this.target);
        this._quad.render(renderer);

        this.needsSwap = !this.deferred;
        if (this.deferred) {
            this._out.texture = this.target.texture;
            this._out.res.set(this.target.width, this.target.height);
            this._hasOut = true;
            return;
        }

        this._composite.uniforms.tDiffuse.value = readBuffer.texture;
        const cu = this._composite.uniforms;
        cu.tHaze.value = this.target.texture;
        cu.uDepth.value = depth;
        cu.uNear.value = cam.near;
        cu.uFar.value = cam.far;
        cu.uHazeSize.value.set(this.target.width, this.target.height);
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this._compQuad.render(renderer);
    }

    dispose() {
        this.target.dispose();
        this._composite.dispose();
        this._quad.dispose();
        this._compQuad.dispose();
    }
}
