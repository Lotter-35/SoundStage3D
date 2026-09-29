/**
 * LaserFanPass.js
 * ─────────────────────────────────────────────────────────────
 * Rendu optimisé des nappes PAN des lasers (fumée volumétrique) :
 *
 *  A. Demi-résolution : les nappes ne sont plus dessinées dans le rendu principal de la scène mais
 *     dans une cible 2× plus petite (en largeur et en hauteur → 4× moins de pixels), avec un test de
 *     profondeur manuel contre la scène, puis ajoutées à l'image par un sur-échantillonnage sensible
 *     à la profondeur (même méthode que les faisceaux des lyres : pas de halo autour des silhouettes).
 *
 *  B. Fumée calculée une seule fois par pixel : une pré-passe (renderMask) calcule le bruit de fumée
 *     de la nappe la plus proche avec écriture de profondeur. Les nappes superposées dans le même plan
 *     échouent au test de profondeur anticipé et ne sont pas exécutées. Les nappes (rendu principal et
 *     bloom) relisent ce masque quand elles sont au même endroit avec les mêmes réglages de bruit.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Recomposition : image de la scène + nappes (demi-résolution) sur-échantillonnées en tenant compte de
 * la profondeur (4 texels pondérés, comme les faisceaux des lyres). Les pixels sans nappe sont
 * simplement recopiés (une seule lecture de test, aucun calcul de profondeur).
 * NB : on écrit dans une nouvelle cible (pas de dessin additif dans l'image de la scène) : three.js
 * invalide les tampons MSAA après leur résolution, les redessiner par-dessus ne serait pas fiable.
 */
function createFanCompositeMaterial() {
    return new THREE.ShaderMaterial({
        uniforms: {
            tDiffuse: { value: null },
            tFans:   { value: null },
            tDepth:  { value: null },
            uFanRes: { value: new THREE.Vector2(1, 1) },
            uNear:   { value: 0.1 },
            uFar:    { value: 1000 },
            uUseDepth: { value: 1 },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            #include <packing>
            uniform sampler2D tDiffuse;
            uniform sampler2D tFans;
            uniform highp sampler2D tDepth;
            uniform vec2 uFanRes;
            uniform float uNear;
            uniform float uFar;
            uniform float uUseDepth;
            varying vec2 vUv;

            float linZ(vec2 uv) {
                return -perspectiveDepthToViewZ(texture2D(tDepth, uv).r, uNear, uFar);
            }

            void main() {
                vec4 base = texture2D(tDiffuse, vUv);
                // Lecture filtrée unique : aucune nappe autour de ce pixel → simple recopie
                vec3 quick = texture2D(tFans, vUv).rgb;
                if (quick.r + quick.g + quick.b <= 0.0) {
                    gl_FragColor = base;
                    return;
                }
                vec3 fans;
                if (uUseDepth > 0.5) {
                    vec2 pos = vUv * uFanRes - 0.5;
                    vec2 base0 = floor(pos);
                    vec2 f = pos - base0;
                    float z0 = linZ(vUv);
                    vec3 acc = vec3(0.0);
                    float wSum = 0.0;
                    for (int i = 0; i < 4; i++) {
                        vec2 o = vec2(float(i & 1), float(i >> 1));
                        vec2 uv = (base0 + o + 0.5) / uFanRes;
                        float bw = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y);
                        float dz = abs(linZ(uv) - z0) / max(z0, 0.25);
                        float w = bw / (0.002 + dz);
                        acc += texture2D(tFans, uv).rgb * w;
                        wSum += w;
                    }
                    fans = acc / max(wSum, 1e-6);
                } else {
                    fans = quick;
                }
                gl_FragColor = vec4(base.rgb + fans, base.a);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}

export const FAN_RESOLUTION_SCALE = 0.25;
const FAN_RENDER_LAYER = 1; // layer bloom laser, sur lequel la nappe reste (le layer 0 lui est retiré)

export class LaserFanPass extends Pass {
    /**
     * @param {import('./LaserBatch.js').LaserBatch} batch
     * @param {THREE.Camera} camera
     * @param {{ texture: THREE.Texture|null }} sceneDepth profondeur de la scène (témoin du composer)
     */
    constructor(batch, camera, sceneDepth) {
        super();
        this.batch = batch;
        this.camera = camera;
        this.sceneDepth = sceneDepth;
        this.needsSwap = true;
        this.enabled = false;
        this.resolutionScale = FAN_RESOLUTION_SCALE;
        this._width = 1;
        this._height = 1;

        // Nappes (lumière additive, demi-résolution)
        this.fanTarget = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType,
            depthBuffer: false,
            stencilBuffer: false,
        });
        this.fanTarget.texture.generateMipmaps = false;

        // Masque de fumée partagé : float 32 (signature + profondeur encodées dans alpha), avec profondeur
        this.maskTarget = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.FloatType,
            depthBuffer: true,
            stencilBuffer: false,
            minFilter: THREE.NearestFilter,
            magFilter: THREE.NearestFilter,
        });
        this.maskTarget.texture.generateMipmaps = false;
        this.maskReady = false;

        this._composite = createFanCompositeMaterial();
        this._quad = new FullScreenQuad(this._composite);
        this._clear = new THREE.Color();
        this._black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
        this._black.needsUpdate = true;
    }

    setResolutionScale(scale) {
        this.resolutionScale = scale;
        this.setSize(this._width, this._height);
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
        const w = Math.max(1, Math.round(width * this.resolutionScale));
        const h = Math.max(1, Math.round(height * this.resolutionScale));
        this.fanTarget.setSize(w, h);
        this.maskTarget.setSize(w, h);
        this.batch.fanMaterial.uniforms.uInvRes.value.set(1 / w, 1 / h);
        this._composite.uniforms.uFanRes.value.set(w, h);
    }

    get hasFans() {
        return Boolean(this.batch.fanMesh.visible && this.batch.fans.count > 0);
    }

    /** Rendu isolé du mesh des nappes dans la cible courante (sans ombres, sans fond) */
    _renderFans(renderer, material) {
        const mesh = this.batch.fanMesh;
        const cam = this.camera;
        const oldMat = mesh.material;
        const oldMask = cam.layers.mask;
        const shadowMap = renderer.shadowMap;
        const oldShadowAuto = shadowMap.autoUpdate;
        shadowMap.autoUpdate = false;
        if (material) mesh.material = material;
        cam.layers.set(FAN_RENDER_LAYER);
        renderer.render(mesh, cam);
        cam.layers.mask = oldMask;
        mesh.material = oldMat;
        shadowMap.autoUpdate = oldShadowAuto;
    }

    /**
     * B. Pré-passe : masque de fumée (1 calcul de bruit par pixel pour la nappe la plus proche).
     * À appeler AVANT les passes de bloom, qui relisent aussi ce masque.
     */
    renderMask(renderer) {
        const fanU = this.batch.fanMaterial.uniforms;
        if (!this.hasFans) {
            this.maskReady = false;
            fanU.uUseMask.value = 0;
            return;
        }
        const oldTarget = renderer.getRenderTarget();
        const oldAutoClear = renderer.autoClear;
        renderer.getClearColor(this._clear);
        const oldAlpha = renderer.getClearAlpha();
        renderer.autoClear = false;
        renderer.setRenderTarget(this.maskTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, false);
        this._renderFans(renderer, this.batch.fanMaskMaterial);
        renderer.setClearColor(this._clear, oldAlpha);
        renderer.autoClear = oldAutoClear;
        renderer.setRenderTarget(oldTarget);

        this.maskReady = true;
        fanU.uMask.value = this.maskTarget.texture;
        fanU.uUseMask.value = 1;
    }

    /** A. Nappes en demi-résolution, ajoutées à l'image de la scène */
    render(renderer, writeBuffer, readBuffer) {
        const depth = (this.sceneDepth && this.sceneDepth.texture) || readBuffer.depthTexture;
        const cu = this._composite.uniforms;
        cu.tDiffuse.value = readBuffer.texture;
        if (!this.hasFans || !depth) {
            // Rien à ajouter : simple recopie (la passe échange ses cibles)
            cu.tFans.value = this._black;
            cu.uUseDepth.value = 0;
            renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
            this._quad.render(renderer);
            return;
        }
        const cam = this.camera;
        const u = this.batch.fanMaterial.uniforms;
        u.uSceneDepth.value = depth;
        u.uUseSceneDepth.value = 1;
        u.uNear.value = cam.near;
        u.uFar.value = cam.far;

        renderer.getClearColor(this._clear);
        const oldAlpha = renderer.getClearAlpha();
        const oldAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.setRenderTarget(this.fanTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        this._renderFans(renderer, null);
        renderer.setClearColor(this._clear, oldAlpha);
        u.uUseSceneDepth.value = 0;

        cu.tFans.value = this.fanTarget.texture;
        cu.tDepth.value = depth;
        cu.uNear.value = cam.near;
        cu.uFar.value = cam.far;
        cu.uUseDepth.value = this.resolutionScale < 0.999 ? 1 : 0;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this._quad.render(renderer);
        renderer.autoClear = oldAutoClear;
    }

    dispose() {
        this.fanTarget.dispose();
        this._black.dispose();
        this.maskTarget.dispose();
        this._composite.dispose();
        this._quad.dispose();
    }
}
