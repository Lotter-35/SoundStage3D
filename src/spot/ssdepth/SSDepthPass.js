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
 *      bilatérale), avec un BUDGET de temps GPU : son temps est mesuré (requête de minuterie, ou mesures par
 *      passe quand elles sont affichées) et une qualité 0…1 s'ajuste en continu — seuil de contraste d'un
 *      bord et nombre de cônes par tuile au-delà duquel on ne recalcule plus. Au-dessus du budget la qualité
 *      baisse en proportion ; en dessous de 70 % elle remonte doucement ;
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
/** Budget de temps GPU de la retouche des bords (ms) */
const REFINE_BUDGET_MS = 5;

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
        // Budget de la retouche : qualité 0…1, dernier temps mesuré (ms), requêtes de minuterie en attente
        this.refineBudget = REFINE_BUDGET_MS;
        this.refineQuality = 1;
        this.refineMs = 0;
        this._gl = null;
        this._ext = undefined;
        this._queries = [];
        this._freeQueries = [];
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
            this._applyBudget(renderer, timer);
            const r = this.refineMaterial.uniforms;
            r.tBeamLow.value = this.beamTarget.texture;
            r.uLowScale.value.copy(this._out.scale);
            r.uSharp.value = this.sharpness;
            if (timer) timer.begin('Bords des faisceaux SS');
            const q = timer ? null : this._beginQuery();
            renderer.setRenderTarget(this.refineTarget);
            this._refineQuad.render(renderer);
            if (q) this._gl.endQuery(this._ext.TIME_ELAPSED_EXT);
            if (timer) timer.end();
            this._out.texture = this.refineTarget.texture;
        }
        renderer.autoClear = oldAutoClear;

        this._out.sharpness = this.sharpness;
        // Sans passe finale (cas de secours) : rien n'est recomposé
        this._hasOut = this.deferred;
    }

    /** Requête de minuterie autour de la retouche, si aucune autre n'est active (WebGL : une seule à la fois) */
    _beginQuery() {
        const gl = this._gl;
        if (!this._ext || this._queries.length > 8) return null;
        if (gl.getQuery(this._ext.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return null;
        const q = this._freeQueries.pop() || gl.createQuery();
        gl.beginQuery(this._ext.TIME_ELAPSED_EXT, q);
        this._queries.push(q);
        return q;
    }

    /** Dernier temps mesuré de la retouche → qualité (seuil de contraste, cônes par tuile) */
    _applyBudget(renderer, timer) {
        if (this._ext === undefined) {
            this._gl = renderer.getContext();
            this._ext = this._gl.getExtension('EXT_disjoint_timer_query_webgl2') || null;
        }
        let ms = -1;
        if (timer) {
            // Mesures par passe affichées : leur moyenne (mise à jour toutes les 0,5 s)
            const e = timer.results.find(x => x.name === 'Bords des faisceaux SS');
            if (e && e !== this._lastTimerEntry) { ms = e.ms; this._lastTimerEntry = e; }
        } else if (this._ext) {
            const gl = this._gl;
            const disjoint = gl.getParameter(this._ext.GPU_DISJOINT_EXT);
            while (this._queries.length) {
                const q = this._queries[0];
                if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
                this._queries.shift();
                if (!disjoint) ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
                this._freeQueries.push(q);
            }
        }
        if (ms >= 0) {
            this.refineMs = ms;
            const B = this.refineBudget;
            let Q = this.refineQuality;
            if (ms > B) {
                Q *= Math.max(0.6, B / ms);                             // au-dessus : baisse proportionnelle
                if (Q < 0.02) Q = 0;
            } else if (ms < 0.7 * B) {
                Q = Math.min(1, Q * 1.02 + 0.01);                       // marge : remontée douce
            }
            this.refineQuality = Q;
        }
        const Q = this.refineQuality;
        const r = this.refineMaterial.uniforms;
        // Qualité 1 : bords dès 15 % d'écart, 24 cônes par tuile ; vers 0 : seuls les bords très marqués, peu de
        // cônes par tuile ; 0 : remontée bilatérale seule
        r.uEdgeK.value = 0.15 + (1 - Q) * 0.75;
        r.uRefineMax.value = Q <= 0 ? 0 : Math.max(1, Math.round(REFINE_MAX_CONES * Q));
    }

    dispose() {
        this.beamTarget.dispose();
        this.refineTarget.dispose();
        this.beamMaterial.dispose();
        this.refineMaterial.dispose();
        this._beamQuad.dispose();
        this._refineQuad.dispose();
        if (this._gl) for (const q of [...this._queries, ...this._freeQueries]) this._gl.deleteQuery(q);
    }
}
