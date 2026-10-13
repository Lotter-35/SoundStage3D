/**
 * SpotShadowAtlas.js
 * ─────────────────────────────────────────────────────────────
 * OMBRES STATIQUES des lyres (plan R3) : une « cubemap » de distances par lyre, rangée dans un atlas 2D
 * (6 faces de 128² ou 256² en bloc 3 × 2, voir shadowGLSL.js). Le décor ne bouge pas pendant un show :
 * chaque cubemap est cuite UNE fois, puis seulement quand la lyre est déplacée ou que le décor change.
 *
 * - Centre : pivot de la tête (fixe en pan / tilt) → l'ombre reste juste quel que soit le mouvement.
 * - Cubemap complète (et non une carte dans l'axe du faisceau) : les lyres bougent sans arrêt.
 * - Objets cuits : maillages visibles qui projettent une ombre (castShadow), hors personnages animés
 *   (maillages à squelette) et hors appareils instanciés mobiles (barres LED…) ; ni faisceaux, ni lasers,
 *   ni boîtiers des lyres (ils ne projettent pas d'ombre).
 * - Cuisson étalée : quelques lyres par image (aucun à-coup) ; une lyre en cours de déplacement n'a pas
 *   d'ombre jusqu'à ce qu'elle soit immobile quelques images.
 * - Décor modifié (objet ajouté / déplacé, modèle chargé) : empreinte du décor relevée régulièrement → tout
 *   est recuit progressivement (les anciennes ombres restent affichées en attendant).
 *
 * Pourquoi des cubemaps et pas l'octaédrique : les faces se dessinent directement (rendu perspective
 * standard), la lecture est une sélection de face + 1 lecture ; à résolution égale, 6 × 128² ≈ octaédrique
 * 256² (même densité moyenne) sans passe de reprojection.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import {
    SHADOW_MAX_SLOTS, SHADOW_BLOCKS_PER_ROW, SHADOW_FAR, SHADOW_FACES,
    createShadowUniforms, createShadowInfoTexture,
} from './shadowGLSL.js';

/** Lyres cuites au plus par image */
const BAKES_PER_FRAME = 2;
/** Images d'immobilité avant de cuire une lyre déplacée */
const STABLE_FRAMES = 4;
/** Relevé de l'empreinte du décor : toutes les N images */
const SCAN_PERIOD = 30;
/** Déplacement de la lyre (m) qui invalide sa cubemap */
const MOVE_EPS = 0.02;

const _m = new THREE.Matrix4();
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _r = new THREE.Vector3();
const _b = new THREE.Vector3();

export class SpotShadowAtlas {
    /** @param {THREE.WebGLRenderer} renderer @param {THREE.Scene} scene */
    constructor(renderer, scene) {
        this.renderer = renderer;
        this.scene = scene;
        this.size = 0;                 // texels par face (0 = ombres désactivées)
        this.uniforms = createShadowUniforms();
        this.infoTexture = createShadowInfoTexture();
        this.uniforms.uShadowInfo.value = this.infoTexture;
        this.atlas = null;
        this._bakeRT = null;
        this._rows = 0;                // lignes de blocs allouées
        /** @type {Map<object, {slot:number, origin:THREE.Vector3, want:THREE.Vector3, stable:number, dirty:boolean, valid:boolean}>} */
        this._slots = new Map();
        this._free = Array.from({ length: SHADOW_MAX_SLOTS }, (_, i) => SHADOW_MAX_SLOTS - 1 - i);
        this.bakedCount = 0;           // cubemaps cuites depuis le début (statistique)
        this._frame = 0;
        this._sig = NaN;

        // Scène relais : doublures des objets du décor (même géométrie, même matrice monde)
        this._proxy = new THREE.Scene();
        this._proxy.matrixWorldAutoUpdate = false;
        this._static = [];
        this._doubles = new WeakMap();
        this._distMat = new THREE.ShaderMaterial({
            uniforms: { uOrigin: { value: new THREE.Vector3() } },
            vertexShader: /* glsl */`
                varying vec3 vW;
                void main() {
                    vec4 wp = vec4(position, 1.0);
                    #ifdef USE_INSTANCING
                    wp = instanceMatrix * wp;
                    #endif
                    wp = modelMatrix * wp;
                    vW = wp.xyz;
                    gl_Position = projectionMatrix * viewMatrix * wp;
                }
            `,
            fragmentShader: /* glsl */`
                uniform vec3 uOrigin;
                varying vec3 vW;
                void main() { gl_FragColor = vec4(length(vW - uOrigin), 0.0, 0.0, 1.0); }
            `,
            side: THREE.DoubleSide,
        });
        this._cam = new THREE.PerspectiveCamera(90, 1, 0.05, 300);
        this._copyMat = new THREE.ShaderMaterial({
            uniforms: { tSrc: { value: null } },
            vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
            fragmentShader: 'uniform highp sampler2D tSrc; varying vec2 vUv; void main() { gl_FragColor = texture2D(tSrc, vUv); }',
            depthTest: false,
            depthWrite: false,
        });
        this._copyQuad = new FullScreenQuad(this._copyMat);
        this._far = new THREE.Color().setRGB(SHADOW_FAR, SHADOW_FAR, SHADOW_FAR, THREE.LinearSRGBColorSpace);
        this._clear = new THREE.Color();
    }

    get slotCount() { return this._slots.size; }

    /** Résolution des faces : 0 (désactivées), 128 ou 256 — option locale */
    setSize(size) {
        size = size > 0 ? Math.round(size) : 0;
        if (size === this.size) return;
        this.size = size;
        this._disposeTargets();
        this.uniforms.uShadowSize.value = 0;
        for (const s of this._slots.values()) { s.dirty = true; s.valid = false; }
        this._writeInfo();
        if (size > 0) this._allocAtlas(Math.max(1, Math.ceil(this._slots.size / SHADOW_BLOCKS_PER_ROW)));
    }

    /** Recuit tout (décor modifié) */
    invalidateAll() {
        for (const s of this._slots.values()) s.dirty = true;
    }

    /** Lyre supprimée : son emplacement est libéré */
    release(fixture) {
        const s = this._slots.get(fixture);
        if (!s) return;
        this._slots.delete(fixture);
        this._free.push(s.slot);
        this._setInfo(s.slot, null);
        fixture.shadowSlot = -1;
    }

    _allocAtlas(rows) {
        const S = this.size;
        const maxTex = (this.renderer.capabilities && this.renderer.capabilities.maxTextureSize) || 4096;
        const maxRows = Math.max(1, Math.floor(maxTex / (2 * S)));
        rows = Math.min(rows, maxRows, Math.ceil(SHADOW_MAX_SLOTS / SHADOW_BLOCKS_PER_ROW));
        if (this.atlas && rows <= this._rows) return;
        if (this.atlas) this.atlas.dispose();
        this._rows = rows;
        this.atlas = new THREE.WebGLRenderTarget(SHADOW_BLOCKS_PER_ROW * 3 * S, rows * 2 * S, {
            format: THREE.RedFormat, type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        });
        this.uniforms.uShadowAtlas.value = this.atlas.texture;
        // Contenu perdu : tout est recuit
        for (const s of this._slots.values()) { s.dirty = true; s.valid = false; }
        this._writeInfo();
        if (!this._bakeRT) {
            this._bakeRT = new THREE.WebGLRenderTarget(3 * S, 2 * S, {
                format: THREE.RedFormat, type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false,
                minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
            });
        }
    }

    _disposeTargets() {
        if (this.atlas) this.atlas.dispose();
        if (this._bakeRT) this._bakeRT.dispose();
        this.atlas = null;
        this._bakeRT = null;
        this._rows = 0;
    }

    _setInfo(slot, s) {
        const d = this.infoTexture.image.data;
        const o = slot * 4;
        if (s && s.valid && this.size > 0) {
            d[o] = s.origin.x; d[o + 1] = s.origin.y; d[o + 2] = s.origin.z; d[o + 3] = 1;
        } else {
            d[o + 3] = 0;
        }
        this.infoTexture.needsUpdate = true;
    }

    _writeInfo() {
        const d = this.infoTexture.image.data;
        for (let i = 0; i < SHADOW_MAX_SLOTS; i++) d[i * 4 + 3] = 0;
        for (const s of this._slots.values()) this._setInfo(s.slot, s);
        this.infoTexture.needsUpdate = true;
    }

    /** Objets du décor qui projettent une ombre + empreinte (position, nombre) */
    _scan() {
        const list = this._static;
        list.length = 0;
        let sig = 0, n = 0;
        this.scene.traverseVisible(o => {
            if (!o.isMesh || !o.castShadow || o.isSkinnedMesh) return;
            if (o.isInstancedMesh && o.instanceMatrix.usage === THREE.DynamicDrawUsage) return;   // appareils mobiles
            list.push(o);
            const e = o.matrixWorld.elements;
            n++;
            sig += (e[12] * 1.3 + e[13] * 2.7 + e[14] * 3.1 + e[0] + e[5] * 0.7 + e[10] * 0.3) * ((n % 7) + 1);
        });
        return sig + n * 1000;
    }

    _double(o) {
        let d = this._doubles.get(o);
        if (!d || d.geometry !== o.geometry) {
            if (o.isInstancedMesh) {
                d = new THREE.InstancedMesh(o.geometry, this._distMat, o.instanceMatrix.count);
                d.instanceMatrix = o.instanceMatrix;
            } else {
                d = new THREE.Mesh(o.geometry, this._distMat);
            }
            d.matrixAutoUpdate = false;
            d.matrixWorldAutoUpdate = false;
            d.matrixWorld = o.matrixWorld;
            this._doubles.set(o, d);
        }
        if (o.isInstancedMesh) d.count = o.count;
        d.frustumCulled = o.frustumCulled;
        d.material = Array.isArray(o.material) ? o.material.map(() => this._distMat) : this._distMat;
        return d;
    }

    /**
     * À appeler à chaque image après la mise à jour des lyres (shadowOrigin à jour) : emplacements,
     * invalidations et cuisson de quelques cubemaps.
     * @param {Iterable<import('../SpotFixture.js').SpotFixture>} fixtures
     */
    update(fixtures) {
        if (this.size <= 0) {
            for (const f of fixtures) f.shadowSlot = -1;
            return;
        }
        this._frame++;
        // 1. Emplacements et déplacements
        let infoDirty = false;
        for (const f of fixtures) {
            let s = this._slots.get(f);
            if (!s) {
                if (this._free.length === 0) { f.shadowSlot = -1; continue; }
                s = { slot: this._free.pop(), origin: new THREE.Vector3(), want: f.shadowOrigin.clone(), stable: 0, dirty: true, valid: false };
                this._slots.set(f, s);
                const rows = Math.ceil((s.slot + 1) / SHADOW_BLOCKS_PER_ROW);
                if (rows > this._rows) this._allocAtlas(rows);
            }
            if (s.want.distanceToSquared(f.shadowOrigin) > 1e-6) {
                s.want.copy(f.shadowOrigin);
                s.stable = 0;
            } else {
                s.stable++;
            }
            if (s.origin.distanceTo(s.want) > MOVE_EPS) {
                s.dirty = true;
                if (s.valid) { s.valid = false; infoDirty = true; }
            }
            f.shadowSlot = s.valid && this._blockFits(s.slot) ? s.slot : -1;
        }
        if (infoDirty) this._writeInfo();

        // 2. Décor modifié ? (relevé espacé : parcours de la scène)
        if (this._frame % SCAN_PERIOD === 1 || this._static.length === 0) {
            const sig = this._scan();
            if (sig !== this._sig) {
                if (!Number.isNaN(this._sig)) this.invalidateAll();
                this._sig = sig;
            }
        }

        // 3. Cuisson : jamais cuites d'abord, puis les autres
        let budget = BAKES_PER_FRAME;
        for (const pass of [0, 1]) {
            for (const s of this._slots.values()) {
                if (budget <= 0) break;
                if (!s.dirty || s.stable < STABLE_FRAMES || !this._blockFits(s.slot)) continue;
                if ((pass === 0) === s.valid) continue;
                this._bake(s);
                budget--;
            }
        }
    }

    _blockFits(slot) {
        return Math.floor(slot / SHADOW_BLOCKS_PER_ROW) < this._rows;
    }

    _bake(s) {
        const r = this.renderer;
        const S = this.size;
        const rt = this._bakeRT;
        if (!rt || !this.atlas) return;
        if (this._static.length === 0) this._sig = this._scan();
        s.origin.copy(s.want);
        this._distMat.uniforms.uOrigin.value.copy(s.origin);

        const prevTarget = r.getRenderTarget();
        const prevAutoClear = r.autoClear;
        const prevShadowAuto = r.shadowMap.autoUpdate;
        r.getClearColor(this._clear);
        const prevAlpha = r.getClearAlpha();
        const proxy = this._proxy;
        try {
            r.shadowMap.autoUpdate = false;
            r.autoClear = false;
            rt.scissorTest = false;
            rt.viewport.set(0, 0, 3 * S, 2 * S);
            r.setRenderTarget(rt);
            r.setClearColor(this._far, 1);
            r.clear(true, true, false);
            const kids = [];
            for (const o of this._static) kids.push(this._double(o));
            proxy.children = kids;
            const cam = this._cam;
            cam.position.copy(s.origin);
            for (let f = 0; f < 6; f++) {
                const [fw, up] = SHADOW_FACES[f];
                _f.set(fw[0], fw[1], fw[2]);
                _u.set(up[0], up[1], up[2]);
                _r.crossVectors(_f, _u);
                _b.copy(_f).negate();
                _m.makeBasis(_r, _u, _b);
                cam.quaternion.setFromRotationMatrix(_m);
                cam.updateMatrixWorld();
                const x = (f % 3) * S, y = Math.floor(f / 3) * S;
                rt.viewport.set(x, y, S, S);
                rt.scissor.set(x, y, S, S);
                rt.scissorTest = true;
                r.setRenderTarget(rt);
                r.render(proxy, cam);
            }
            proxy.children = [];
            // Recopie dans le bloc de la lyre
            const a = this.atlas;
            const bx = (s.slot % SHADOW_BLOCKS_PER_ROW) * 3 * S, by = Math.floor(s.slot / SHADOW_BLOCKS_PER_ROW) * 2 * S;
            a.viewport.set(bx, by, 3 * S, 2 * S);
            a.scissor.set(bx, by, 3 * S, 2 * S);
            a.scissorTest = true;
            r.setRenderTarget(a);
            this._copyMat.uniforms.tSrc.value = rt.texture;
            this._copyQuad.render(r);
            a.scissorTest = false;
            a.viewport.set(0, 0, a.width, a.height);
            rt.scissorTest = false;
            rt.viewport.set(0, 0, rt.width, rt.height);
        } finally {
            proxy.children = [];
            r.setClearColor(this._clear, prevAlpha);
            r.shadowMap.autoUpdate = prevShadowAuto;
            r.autoClear = prevAutoClear;
            r.setRenderTarget(prevTarget);
        }
        s.dirty = false;
        s.valid = true;
        this.bakedCount++;
        this.uniforms.uShadowSize.value = S;
        this._setInfo(s.slot, s);
    }

    dispose() {
        this._disposeTargets();
        this.infoTexture.dispose();
        this._distMat.dispose();
        this._copyMat.dispose();
        this._copyQuad.dispose();
    }
}
