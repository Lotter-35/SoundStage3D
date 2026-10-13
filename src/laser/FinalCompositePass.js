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
 *      + taches de lumière des lyres (pleine résolution, ou ½ + remontée bilatérale ; rebond de la GI inclus)
 *      + reflets des faisceaux sur le plateau (¼ ou ⅛, remontée bilatérale)
 *      + faisceaux SS Depth et halo atmosphérique (remontée bilatérale 3×3 guidée par la profondeur)
 *   2. × transmittance + lumière diffusée du brouillard (bilatéral)
 *   3. + bloom lasers + bloom lampes
 *   4. conversion sRGB quand elle écrit directement à l'écran (équivalent de OutputPass)
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { costDebug } from '../render/costDebug.js';

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
            // faisceaux SS Depth (+ halo) : image réduite, a = profondeur linéaire du pixel réduit
            uSSOn:     { value: 0 },
            tSS:       { value: dummy },
            uSSScale:  { value: new THREE.Vector2(1, 1) },
            uSSTexel:  { value: new THREE.Vector2(1, 1) },
            uSSSharp:  { value: 1.5 },
            uSSFull:   { value: 0 },        // image SS déjà en pleine résolution (retouche des bords)
            // taches de lumière des lyres : a = profondeur linéaire ; div 1 = pleine résolution
            uPoolOn:   { value: 0 },
            tPool:     { value: dummy },
            uPoolScale: { value: new THREE.Vector2(1, 1) },
            uPoolDiv:  { value: 1 },
            uPoolSharp: { value: 1.5 },
            // reflets des faisceaux : image réduite, a = profondeur linéaire
            uReflOn:   { value: 0 },
            tRefl:     { value: dummy },
            uReflScale: { value: new THREE.Vector2(1, 1) },
            uReflSharp: { value: 1.5 },
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
            // vue « coût des lyres » (render/costDebug.js) : effets producteurs de coût (1) ou non (0)
            uCostOn:   { value: 0 },
            uAdd0Cost: { value: 0 },
            uAdd1Cost: { value: 0 },
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
            uniform int uSSOn;
            uniform sampler2D tSS;
            uniform vec2 uSSScale;
            uniform vec2 uSSTexel;
            uniform float uSSSharp;
            uniform int uSSFull;
            uniform int uPoolOn;
            uniform sampler2D tPool;
            uniform vec2 uPoolScale;
            uniform int uPoolDiv;
            uniform float uPoolSharp;
            uniform int uReflOn;
            uniform sampler2D tRefl;
            uniform vec2 uReflScale;
            uniform float uReflSharp;
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

            // Remontée bilatérale jointe 3×3 guidée par la profondeur (a = profondeur linéaire de l'image réduite).
            // Poids spatial = tente bilinéaire (net) + un plancher sur l'anneau 3×3 (repli quand les 2×2 texels
            // les plus proches sont à une autre profondeur) ; poids de profondeur = exp(−écart relatif² × netteté).
            // Aucun texel à la bonne profondeur : texel de profondeur la plus proche (bord net sur les objets).
            vec3 bilateralUp(sampler2D tex, vec2 suv, vec3 quick, float cz, float sharpness) {
                float sharp = 35.0 * sharpness;
                ivec2 size = textureSize(tex, 0);
                vec2 pos = suv * vec2(size) - 0.5;
                ivec2 c0 = ivec2(floor(pos + 0.5));
                vec2 f = pos - vec2(c0);
                vec3 sum = vec3(0.0);
                float wSum = 0.0;
                vec3 best = quick;
                float bestRel = 1e9;
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        vec4 s = texelFetch(tex, clamp(c0 + ivec2(dx, dy), ivec2(0), size - 1), 0);
                        vec2 d = abs(vec2(float(dx), float(dy)) - f);
                        float ws = max(0.0, 1.0 - d.x) * max(0.0, 1.0 - d.y) + 0.02;
                        float rel = abs(cz - s.a) / max(cz, 0.5);
                        float w = ws * exp(-rel * rel * sharp);
                        sum += s.rgb * w;
                        wSum += w;
                        if (rel < bestRel) { bestRel = rel; best = s.rgb; }
                    }
                }
                return wSum > 1e-3 ? sum / wSum : best;
            }

            uniform int uCostOn;
            uniform int uAdd0Cost;
            uniform int uAdd1Cost;

            // Carte de chaleur du travail par pixel, échelle logarithmique : ≈ 2 bleu, 10 vert, 40 jaune, 200 rouge,
            // 1000 blanc (unités : voir render/costDebug.js)
            vec3 heat(float w) {
                float x = clamp(log2(1.0 + w) / 10.0, 0.0, 1.0);
                vec3 c = mix(vec3(0.0, 0.1, 0.6), vec3(0.0, 0.8, 0.2), smoothstep(0.0, 0.2, x));
                c = mix(c, vec3(1.0, 0.9, 0.0), smoothstep(0.2, 0.45, x));
                c = mix(c, vec3(1.0, 0.1, 0.0), smoothstep(0.45, 0.75, x));
                c = mix(c, vec3(1.0), smoothstep(0.75, 1.0, x));
                return w > 0.05 ? c : vec3(0.0);
            }

            void main() {
                vec4 base = texture2D(tDiffuse, vUv);
                vec3 col = uCostOn == 1 ? vec3(0.0) : base.rgb;
                float z0 = -1.0;

                // 1. Effets additifs (nappes laser, faisceaux des lyres)
                if (uAdd0On == 1 && (uCostOn == 0 || uAdd0Cost == 1)) col += additive(tAdd0, uAdd0Res, uAdd0Depth, z0);
                if (uAdd1On == 1 && (uCostOn == 0 || uAdd1Cost == 1)) col += additive(tAdd1, uAdd1Res, uAdd1Depth, z0);

                // 1 bis. Taches de lumière des lyres (avant le brouillard : la transmittance s'applique)
                if (uPoolOn == 1) {
                    if (uPoolDiv == 1) {
                        col += texelFetch(tPool, ivec2(gl_FragCoord.xy), 0).rgb;
                    } else {
                        vec2 puv = vUv * uPoolScale;
                        vec3 quick = texture2D(tPool, puv).rgb;
                        if (quick.r + quick.g + quick.b > 0.0) {
                            if (z0 < 0.0) z0 = linZ(vUv);
                            col += bilateralUp(tPool, puv, quick, max(z0, 0.1), uPoolSharp);
                        }
                    }
                }

                // 1 bis'. Reflets des faisceaux sur le plateau (même remontée bilatérale)
                if (uReflOn == 1 && uCostOn == 0) {
                    vec2 ruv = vUv * uReflScale;
                    vec3 quick = texture2D(tRefl, ruv).rgb;
                    if (quick.r + quick.g + quick.b > 0.0) {
                        if (z0 < 0.0) z0 = linZ(vUv);
                        col += bilateralUp(tRefl, ruv, quick, max(z0, 0.1), uReflSharp);
                    }
                }

                // 1 ter. Faisceaux SS Depth (+ halo) : remontée bilatérale jointe 3×3 guidée par la profondeur
                if (uSSOn == 1 && uSSFull == 1) {
                    col += texelFetch(tSS, ivec2(gl_FragCoord.xy), 0).rgb;
                } else if (uSSOn == 1) {
                    vec2 suv = vUv * uSSScale;
                    vec3 quick = texture2D(tSS, suv).rgb;
                    if (quick.r + quick.g + quick.b > 0.0) {
                        if (z0 < 0.0) z0 = linZ(vUv);
                        col += bilateralUp(tSS, suv, quick, max(z0, 0.1), uSSSharp);
                    }
                }

                // Vue « coût des lyres » : travail cumulé (× 100) en carte de chaleur sur la scène assombrie
                if (uCostOn == 1) {
                    vec3 gray = vec3(dot(base.rgb, vec3(0.3, 0.6, 0.1))) * 0.15;
                    vec3 o = heat(col.r * 100.0) + gray;
                    gl_FragColor = vec4(o, 1.0);
                    if (uToScreen == 1) gl_FragColor = sRGBTransferOETF(gl_FragColor);
                    return;
                }

                // 2. Brouillard de salle : sur-échantillonnage bilatéral (même profondeur que le pixel)
                if (uHazeOn == 1) {
                    float dc = z0 >= 0.0 ? z0 : linZ(vUv);
                    vec2 p = vUv * uHazeSize - 0.5;
                    vec2 i0 = floor(p);
                    vec2 f = p - i0;
                    vec4 acc = vec4(0.0);
                    float wsum = 0.0;
                    vec4 nearest = vec4(0.0, 0.0, 0.0, 1.0);
                    float nearestZ = 1e9;
                    float bestDiff = 1e20;
                    for (int j = 0; j < 2; j++) {
                        for (int i = 0; i < 2; i++) {
                            vec2 uv = (i0 + vec2(float(i), float(j)) + 0.5) / uHazeSize;
                            vec4 h = texture2D(tHaze, uv);
                            float zt = linZ(uv);
                            float diff = abs(zt - dc) / max(dc, 0.1);
                            float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
                            float w = wb * exp(-diff * 30.0) + 1e-5 * wb;
                            acc += h * w;
                            wsum += w;
                            if (diff < bestDiff) { bestDiff = diff; nearest = h; nearestZ = zt; }
                        }
                    }
                    vec4 hz = bestDiff > 0.1 && wsum < 0.05 ? nearest : acc / max(wsum, 1e-6);
                    // Détail fin au premier plan (câbles, barres de la tour) : aucun texel basse résolution n'est à sa profondeur.
                    // Le brouillard du texel le plus proche est alors ramené à la distance du pixel (milieu supposé homogène :
                    // transmittance^(z pixel / z texel)) au lieu d'appliquer tout le brouillard du fond, qui effaçait le détail.
                    if (bestDiff > 0.1 && wsum < 0.05 && dc < nearestZ) {
                        float r = clamp(dc / max(nearestZ, 0.1), 0.0, 1.0);
                        float t2 = pow(max(nearest.a, 1e-4), r);
                        hz = vec4(nearest.rgb * (1.0 - t2) / max(1.0 - nearest.a, 1e-4), t2);
                    }
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
        u.uSSOn.value = 0;
        u.uPoolOn.value = 0;
        u.uReflOn.value = 0;
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
                u[`u${k}Cost`].value = p.costProducer ? 1 : 0;
                add++;
            } else if (o.kind === 'ss') {
                u.uSSOn.value = 1;
                u.tSS.value = o.texture;
                u.uSSScale.value.copy(o.scale);
                u.uSSTexel.value.copy(o.texel);
                u.uSSSharp.value = o.sharpness;
                u.uSSFull.value = o.full ? 1 : 0;
            } else if (o.kind === 'pool') {
                u.uPoolOn.value = 1;
                u.tPool.value = o.texture;
                u.uPoolScale.value.copy(o.scale);
                u.uPoolDiv.value = o.div;
                u.uPoolSharp.value = o.sharpness;
            } else if (o.kind === 'refl') {
                u.uReflOn.value = 1;
                u.tRefl.value = o.texture;
                u.uReflScale.value.copy(o.scale);
                u.uReflSharp.value = o.sharpness;
            } else if (o.kind === 'haze') {
                u.uHazeOn.value = 1;
                u.tHaze.value = o.texture;
                u.uHazeSize.value.copy(o.res);
            }
        }

        u.uCostOn.value = costDebug.on ? 1 : 0;
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
