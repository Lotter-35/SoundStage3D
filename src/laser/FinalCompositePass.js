/**
 * FinalCompositePass.js
 * ─────────────────────────────────────────────────────────────
 * Passe finale unique du composer : remplace les recompositions plein écran successives
 * (nappes laser, faisceaux des lyres, brouillard de salle, mélange des deux blooms, sortie écran).
 *
 * Les passes d'effets (« producteurs ») calculent toujours leur image réduite, mais ne la recomposent
 * plus elles-mêmes : cette passe lit l'image de la scène UNE fois et applique, dans le même ordre
 * qu'avant et avec les mêmes formules :
 *   1. + nappes et faisceaux (sur-échantillonnage sensible à la profondeur)
 *   2. × transmittance + lumière diffusée du brouillard (bilatéral)
 *   3. + bloom lasers + bloom lampes
 *   4. conversion sRGB quand elle écrit directement à l'écran (équivalent de OutputPass)
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

function createFinalCompositeMaterial(dummy) {
    return new THREE.ShaderMaterial({
        uniforms: {
            tDiffuse:  { value: null },
            tDepth:    { value: null },
            uNear:     { value: 0.1 },
            uFar:      { value: 1000 },
            // 2 effets additifs (nappes, faisceaux)
            uAdd0On:   { value: 0 },
            tAdd0:     { value: dummy },
            uAdd0Res:  { value: new THREE.Vector2(1, 1) },
            uAdd0Depth: { value: 0 },
            uAdd1On:   { value: 0 },
            tAdd1:     { value: dummy },
            uAdd1Res:  { value: new THREE.Vector2(1, 1) },
            uAdd1Depth: { value: 0 },
            // brouillard
            uHazeOn:   { value: 0 },
            tHaze:     { value: dummy },
            uHazeSize: { value: new THREE.Vector2(1, 1) },
            // blooms (mêmes noms que l'ancienne passe de mélange)
            laserBloomTexture:   { value: dummy },
            lightsBloomTexture:  { value: dummy },
            uLaserBloomEnabled:  { value: 0 },
            uLightsBloomEnabled: { value: 0 },
            // sortie écran
            uToScreen: { value: 0 },
        },
        vertexShader: /* glsl */`
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `,
        fragmentShader: /* glsl */`
            precision highp float;
            #include <packing>
            uniform sampler2D tDiffuse;
            uniform highp sampler2D tDepth;
            uniform float uNear;
            uniform float uFar;
            uniform int uAdd0On;
            uniform sampler2D tAdd0;
            uniform vec2 uAdd0Res;
            uniform int uAdd0Depth;
            uniform int uAdd1On;
            uniform sampler2D tAdd1;
            uniform vec2 uAdd1Res;
            uniform int uAdd1Depth;
            uniform int uHazeOn;
            uniform sampler2D tHaze;
            uniform vec2 uHazeSize;
            uniform sampler2D laserBloomTexture;
            uniform sampler2D lightsBloomTexture;
            uniform float uLaserBloomEnabled;
            uniform float uLightsBloomEnabled;
            uniform int uToScreen;
            varying vec2 vUv;

            float linZ(vec2 uv) {
                return -perspectiveDepthToViewZ(texture2D(tDepth, uv).r, uNear, uFar);
            }

            // Sur-échantillonnage sensible à la profondeur (identique aux anciennes recompositions des
            // nappes et des faisceaux) : 4 texels pondérés par leur écart de profondeur avec le pixel
            vec3 depthAware(sampler2D tex, vec2 res, float z0) {
                vec2 pos = vUv * res - 0.5;
                vec2 base0 = floor(pos);
                vec2 f = pos - base0;
                vec3 acc = vec3(0.0);
                float wSum = 0.0;
                for (int i = 0; i < 4; i++) {
                    vec2 o = vec2(float(i & 1), float(i >> 1));
                    vec2 uv = (base0 + o + 0.5) / res;
                    float bw = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y);
                    float dz = abs(linZ(uv) - z0) / max(z0, 0.25);
                    float w = bw / (0.002 + dz);
                    acc += texture2D(tex, uv).rgb * w;
                    wSum += w;
                }
                return acc / max(wSum, 1e-6);
            }

            vec3 additive(sampler2D tex, vec2 res, int useDepth, inout float z0) {
                // Lecture filtrée unique : rien autour de ce pixel → aucun calcul de profondeur
                vec3 quick = texture2D(tex, vUv).rgb;
                if (quick.r + quick.g + quick.b <= 0.0) return vec3(0.0);
                if (useDepth == 0) return quick;
                if (z0 < 0.0) z0 = linZ(vUv);
                return depthAware(tex, res, z0);
            }

            void main() {
                vec4 base = texture2D(tDiffuse, vUv);
                vec3 col = base.rgb;
                float z0 = -1.0;

                // 1. Effets additifs (nappes laser, faisceaux des lyres)
                if (uAdd0On == 1) col += additive(tAdd0, uAdd0Res, uAdd0Depth, z0);
                if (uAdd1On == 1) col += additive(tAdd1, uAdd1Res, uAdd1Depth, z0);

                // 2. Brouillard de salle : sur-échantillonnage bilatéral (même profondeur que le pixel)
                if (uHazeOn == 1) {
                    float dc = z0 >= 0.0 ? z0 : linZ(vUv);
                    vec2 p = vUv * uHazeSize - 0.5;
                    vec2 i0 = floor(p);
                    vec2 f = p - i0;
                    vec4 acc = vec4(0.0);
                    float wsum = 0.0;
                    vec4 nearest = vec4(0.0, 0.0, 0.0, 1.0);
                    float bestDiff = 1e20;
                    for (int j = 0; j < 2; j++) {
                        for (int i = 0; i < 2; i++) {
                            vec2 uv = (i0 + vec2(float(i), float(j)) + 0.5) / uHazeSize;
                            vec4 h = texture2D(tHaze, uv);
                            float diff = abs(linZ(uv) - dc) / max(dc, 0.1);
                            float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
                            float w = wb * exp(-diff * 30.0) + 1e-5 * wb;
                            acc += h * w;
                            wsum += w;
                            if (diff < bestDiff) { bestDiff = diff; nearest = h; }
                        }
                    }
                    vec4 hz = bestDiff > 0.1 && wsum < 0.05 ? nearest : acc / max(wsum, 1e-6);
                    col = col * hz.a + hz.rgb;
                }

                // 3. Blooms
                if (uLaserBloomEnabled > 0.5) col += texture2D(laserBloomTexture, vUv).rgb;
                if (uLightsBloomEnabled > 0.5) col += texture2D(lightsBloomTexture, vUv).rgb;

                gl_FragColor = vec4(col, base.a);
                // 4. Sortie écran (OutputPass : pas de tone mapping, espace sRGB)
                if (uToScreen == 1) gl_FragColor = sRGBTransferOETF(gl_FragColor);
            }
        `,
        depthTest: false,
        depthWrite: false,
    });
}

export class FinalCompositePass extends Pass {
    /**
     * @param {THREE.Camera} camera
     * @param {{ texture: THREE.DepthTexture|null }} sceneDepth profondeur de la scène
     */
    constructor(camera, sceneDepth) {
        super();
        this.camera = camera;
        this.sceneDepth = sceneDepth;
        this.needsSwap = true;
        /** Passes d'effets dont l'image est recomposée ici (dans l'ordre de la chaîne) */
        this.producers = [];
        this._dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
        this._dummy.needsUpdate = true;
        this.material = createFinalCompositeMaterial(this._dummy);
        this._quad = new FullScreenQuad(this.material);
    }

    render(renderer, writeBuffer, readBuffer) {
        const u = this.material.uniforms;
        u.tDiffuse.value = readBuffer.texture;
        u.tDepth.value = (this.sceneDepth && this.sceneDepth.texture) || readBuffer.depthTexture || this._dummy;
        u.uNear.value = this.camera.near;
        u.uFar.value = this.camera.far;

        let add = 0;
        u.uAdd0On.value = 0;
        u.uAdd1On.value = 0;
        u.uHazeOn.value = 0;
        for (const p of this.producers) {
            if (!p.enabled || typeof p.deferredOutput !== 'function') continue;
            const o = p.deferredOutput();
            if (!o) continue;
            if (o.kind === 'add' && add < 2) {
                const k = add === 0 ? 'Add0' : 'Add1';
                u[`u${k}On`].value = 1;
                u[`t${k}`].value = o.texture;
                u[`u${k}Res`].value.copy(o.res);
                u[`u${k}Depth`].value = o.useDepth ? 1 : 0;
                add++;
            } else if (o.kind === 'haze') {
                u.uHazeOn.value = 1;
                u.tHaze.value = o.texture;
                u.uHazeSize.value.copy(o.res);
            }
        }

        const toScreen = this.renderToScreen;
        u.uToScreen.value = toScreen && THREE.ColorManagement.getTransfer(renderer.outputColorSpace) === THREE.SRGBTransfer ? 1 : 0;
        renderer.setRenderTarget(toScreen ? null : writeBuffer);
        this._quad.render(renderer);
    }

    dispose() {
        this.material.dispose();
        this._quad.dispose();
        this._dummy.dispose();
    }
}
