/**
 * PostProcessing.js
 * ─────────────────────────────────────────────────────────────
 * Chaîne de post-traitement (EffectComposer) :
 * - Rendu de la scène
 * - UnrealBloomPass (flou lumineux des faisceaux et impacts)
 * - Aberration chromatique personnalisée
 * - Antialiasing sélectionnable (FXAA ou SMAA)
 * ─────────────────────────────────────────────────────────────
 */

import { params } from '../config/params.js';

export class PostProcessing {
    constructor(renderer, scene, camera) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;

        this.composer = new THREE.EffectComposer(renderer);
        this.composer.addPass(new THREE.RenderPass(scene, camera));

        // Passe Bloom
        this.bloomPass = new THREE.UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            params.bloomIntensity,
            params.bloomRadius,
            0.0
        );
        this.composer.addPass(this.bloomPass);

        // Passe Aberration Chromatique
        const chromaShader = {
            uniforms: {
                tDiffuse: { value: null },
                uChroma: { value: params.chroma }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D tDiffuse;
                uniform float uChroma;
                varying vec2 vUv;

                void main() {
                    vec2 uv = vUv;
                    vec2 dist = uv - vec2(0.5);

                    vec2 offset = dist * uChroma * 0.015;
                    float r = texture2D(tDiffuse, uv + offset).r;
                    float g = texture2D(tDiffuse, uv).g;
                    float b = texture2D(tDiffuse, uv - offset).b;

                    gl_FragColor = vec4(r, g, b, 1.0);
                }
            `
        };
        this.chromaPass = new THREE.ShaderPass(chromaShader);
        this.composer.addPass(this.chromaPass);

        // Passes Antialiasing (FXAA & SMAA)
        const pixelRatio = renderer.getPixelRatio();
        this.fxaaPass = new THREE.ShaderPass(THREE.FXAAShader);
        this.fxaaPass.material.uniforms['resolution'].value.x = 1 / (window.innerWidth * pixelRatio);
        this.fxaaPass.material.uniforms['resolution'].value.y = 1 / (window.innerHeight * pixelRatio);
        this.composer.addPass(this.fxaaPass);

        this.smaaPass = new THREE.SMAAPass(
            window.innerWidth * pixelRatio,
            window.innerHeight * pixelRatio
        );
        this.composer.addPass(this.smaaPass);

        this.updateAntialiasing(params.antialiasing);
    }

    updateAntialiasing(mode = params.antialiasing) {
        this.fxaaPass.enabled = (mode === 'FXAA');
        this.smaaPass.enabled = (mode === 'SMAA');
    }

    resize(width, height, pixelRatio) {
        this.composer.setSize(width, height);
        this.fxaaPass.material.uniforms['resolution'].value.x = 1 / (width * pixelRatio);
        this.fxaaPass.material.uniforms['resolution'].value.y = 1 / (height * pixelRatio);
        this.smaaPass.setSize(width * pixelRatio, height * pixelRatio);
    }

    render() {
        this.composer.render();
    }
}
