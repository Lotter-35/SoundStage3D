/**
 * dirShadowCache.js — Ombre du soleil : le décor fixe n'est plus redessiné dans la carte d'ombre à chaque image.
 *
 * Seuls les personnages (joueur et avatars, maillages animés) bougent parmi les objets qui projettent
 * une ombre ; le décor (scène, enceintes, matériel DJ…) représente l'essentiel des ~160 000 triangles.
 *
 *  1. Décor fixe : dessiné dans la carte comme le fait three.js (matériau de profondeur « emballée »,
 *     faces arrière des matériaux simple face, les deux faces sinon, découpage par la caméra de l'ombre)
 *     quand c'est nécessaire — soleil recentré ou déplacé, taille de la carte changée, objet du décor
 *     ajouté / déplacé — puis recopié dans une cible cache.
 *  2. À chaque image : la carte est restaurée depuis le cache (couleur + profondeur), puis seuls les
 *     personnages y sont dessinés, de la même façon.
 *
 * Rendu identique ; coût d'une image : une recopie 2048² + les personnages, au lieu de tout le décor.
 */
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */`
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
    }
`;

// Faces rendues dans la carte d'ombre selon la face du matériau (règle de three.js WebGLShadowMap)
const SHADOW_SIDE = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };

export class DirShadowCache {
    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.Scene} scene
     * @param {THREE.DirectionalLight} light
     */
    constructor(renderer, scene, light) {
        this.renderer = renderer;
        this.scene = scene;
        this.light = light;
        this.cache = null;
        this._dirty = true;
        this._lastCam = new THREE.Matrix4();
        this._lastProj = new THREE.Matrix4();
        this._sig = NaN;
        this._dynamic = [];
        this._static = [];
        this._hadDynamic = false;
        // Scène « relais » : doublures légères des objets (même géométrie, même matrice monde partagée,
        // même squelette / mêmes instances, sans enfants) pour un seul appel de rendu avec découpage
        this._proxy = new THREE.Scene();
        this._proxy.matrixWorldAutoUpdate = false;
        this._doubles = new WeakMap();
        this._clearColor = new THREE.Color();

        this._copyMat = new THREE.ShaderMaterial({
            uniforms: { tSrc: { value: null } },
            vertexShader: VERT,
            fragmentShader: /* glsl */`
                uniform sampler2D tSrc;
                varying vec2 vUv;
                void main() { gl_FragColor = texture2D(tSrc, vUv); }
            `,
            depthTest: false,
            depthWrite: false,
        });
        this._restoreMat = new THREE.ShaderMaterial({
            uniforms: { tSrc: { value: null } },
            vertexShader: VERT,
            fragmentShader: /* glsl */`
                #include <packing>
                uniform sampler2D tSrc;
                varying vec2 vUv;
                void main() {
                    vec4 c = texture2D(tSrc, vUv);
                    gl_FragColor = c;
                    gl_FragDepth = unpackRGBAToDepth(c);
                }
            `,
            depthTest: true,
            depthWrite: true,
            depthFunc: THREE.AlwaysDepth,
        });
        this._copyQuad = new FullScreenQuad(this._copyMat);
        this._restoreQuad = new FullScreenQuad(this._restoreMat);
        this._depthMats = {};
        for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) {
            this._depthMats[side] = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side });
        }
    }

    /** Force le recalcul du décor fixe (ex. modèle ajouté) */
    markDirty() {
        this._dirty = true;
    }

    /** Objets animés qui projettent une ombre (personnages) et empreinte du décor fixe */
    _scan() {
        const dyn = this._dynamic;
        const stat = this._static;
        dyn.length = 0;
        stat.length = 0;
        let sig = 0, n = 0;
        this.scene.traverseVisible(o => {
            if (!o.isMesh || !o.castShadow) return;
            if (o.isSkinnedMesh) { dyn.push(o); return; }
            stat.push(o);
            const e = o.matrixWorld.elements;
            n++;
            sig += (e[12] * 1.3 + e[13] * 2.7 + e[14] * 3.1 + e[0] + e[5] * 0.7 + e[10] * 0.3) * ((n % 7) + 1);
        });
        return sig + n * 1000;
    }

    /** À appeler à chaque image, juste avant le rendu */
    update(mainCamera) {
        const light = this.light;
        const shadow = light && light.shadow;
        if (!shadow || !light.castShadow || !light.visible || !this.renderer.shadowMap.enabled) return;
        const r = this.renderer;

        // three.js ne redessine plus cette carte d'ombre : c'est ce cache qui s'en charge
        shadow.autoUpdate = false;
        shadow.needsUpdate = false;

        light.updateMatrixWorld();
        light.target.updateMatrixWorld();
        shadow.updateMatrices(light);
        if (!shadow.camera.matrixWorld.equals(this._lastCam) || !shadow.camera.projectionMatrix.equals(this._lastProj)) {
            this._dirty = true;
            this._lastCam.copy(shadow.camera.matrixWorld);
            this._lastProj.copy(shadow.camera.projectionMatrix);
        }

        // Liste des personnages et empreinte du décor (un objet du décor déplacé → décor recalculé)
        const sig = this._scan();
        if (sig !== this._sig) this._dirty = true;
        this._sig = sig;
        const size = shadow.mapSize;
        if (!shadow.map || !this.cache || this.cache.width !== size.x || this.cache.height !== size.y) this._dirty = true;

        const prevTarget = r.getRenderTarget();
        const prevAutoClear = r.autoClear;
        const prevShadowAuto = r.shadowMap.autoUpdate;
        const prevShadowNeeds = r.shadowMap.needsUpdate;
        try {
            if (this._dirty) {
                this._renderStatic();
                this._dirty = false;
            } else if (this._dynamic.length > 0 || this._hadDynamic) {
                // Carte = décor fixe (cache) + personnages de cette image
                r.setRenderTarget(shadow.map);
                this._restoreMat.uniforms.tSrc.value = this.cache.texture;
                this._restoreQuad.render(r);
            }
            if (this._dynamic.length > 0) this._drawDynamic();
            this._hadDynamic = this._dynamic.length > 0;
        } finally {
            r.shadowMap.autoUpdate = prevShadowAuto;
            r.shadowMap.needsUpdate = prevShadowNeeds;
            r.autoClear = prevAutoClear;
            r.setRenderTarget(prevTarget);
        }
    }

    /** Matériau de profondeur de l'objet (une entrée par matériau pour les objets multi-matériaux) */
    _depthFor(material) {
        if (Array.isArray(material)) return material.map(m => this._depthFor(m));
        const side = (material && material.shadowSide !== null && material.shadowSide !== undefined)
            ? material.shadowSide
            : SHADOW_SIDE[material ? material.side : THREE.FrontSide];
        return this._depthMats[side] || this._depthMats[THREE.BackSide];
    }

    /** Doublure d'un objet pour la carte d'ombre (créée une fois, suit l'original) */
    _double(o) {
        let d = this._doubles.get(o);
        if (!d || d.geometry !== o.geometry) {
            if (o.isInstancedMesh) {
                d = new THREE.InstancedMesh(o.geometry, this._depthMats[THREE.BackSide], o.instanceMatrix.count);
                d.instanceMatrix = o.instanceMatrix;
            } else if (o.isSkinnedMesh) {
                d = new THREE.SkinnedMesh(o.geometry, this._depthMats[THREE.BackSide]);
                d.bindMode = o.bindMode;
            } else {
                d = new THREE.Mesh(o.geometry, this._depthMats[THREE.BackSide]);
            }
            d.matrixAutoUpdate = false;
            d.matrixWorldAutoUpdate = false;
            d.matrixWorld = o.matrixWorld; // même matrice monde (référence partagée)
            this._doubles.set(o, d);
        }
        if (o.isInstancedMesh) d.count = o.count;
        if (o.isSkinnedMesh && (d.skeleton !== o.skeleton || !d.bindMatrix.equals(o.bindMatrix))) d.bind(o.skeleton, o.bindMatrix);
        if (o.isSkinnedMesh) d.bindMatrixInverse.copy(o.bindMatrixInverse); // mode « attached » : suit la matrice monde
        d.frustumCulled = o.frustumCulled;
        d.material = this._depthFor(o.material);
        return d;
    }

    /** Dessine une liste d'objets dans la carte d'ombre courante (un seul appel de rendu) */
    _drawList(list) {
        if (list.length === 0) return;
        const proxy = this._proxy;
        const kids = [];
        for (const o of list) kids.push(this._double(o));
        proxy.children = kids;
        try {
            this.renderer.render(proxy, this.light.shadow.camera);
        } finally {
            proxy.children = [];
        }
    }

    _ensureMap() {
        const shadow = this.light.shadow;
        const size = shadow.mapSize;
        if (shadow.map && (shadow.map.width !== size.x || shadow.map.height !== size.y)) {
            shadow.map.dispose();
            shadow.map = null;
        }
        if (!shadow.map) {
            // Même cible que celle créée par three.js (WebGLShadowMap) pour une ombre PCF
            shadow.map = new THREE.WebGLRenderTarget(size.x, size.y, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
                format: THREE.RGBAFormat,
            });
            shadow.map.texture.name = this.light.name + '.shadowMap';
            shadow.camera.updateProjectionMatrix();
        }
    }

    /** Décor fixe seul, puis recopié dans le cache */
    _renderStatic() {
        const r = this.renderer;
        const shadow = this.light.shadow;
        this._ensureMap();
        r.shadowMap.autoUpdate = false;
        r.shadowMap.needsUpdate = false;
        r.autoClear = false;
        r.getClearColor(this._clearColor);
        const clearAlpha = r.getClearAlpha();
        r.setRenderTarget(shadow.map);
        r.setClearColor(0xffffff, 1); // profondeur maximale partout (comme three.js)
        r.clear(true, true, true);
        r.setClearColor(this._clearColor, clearAlpha);
        this._drawList(this._static);

        const size = shadow.mapSize;
        if (!this.cache || this.cache.width !== size.x || this.cache.height !== size.y) {
            if (this.cache) this.cache.dispose();
            this.cache = new THREE.WebGLRenderTarget(size.x, size.y, {
                minFilter: THREE.NearestFilter,
                magFilter: THREE.NearestFilter,
                depthBuffer: false,
                stencilBuffer: false,
            });
            this.cache.texture.generateMipmaps = false;
        }
        r.setRenderTarget(this.cache);
        this._copyMat.uniforms.tSrc.value = shadow.map.texture;
        this._copyQuad.render(r);
    }

    /** Personnages dessinés par-dessus le décor fixe */
    _drawDynamic() {
        const r = this.renderer;
        r.shadowMap.autoUpdate = false;
        r.shadowMap.needsUpdate = false;
        r.autoClear = false;
        // Matrices de l'image courante (le personnage a bougé depuis la dernière mise à jour de la scène)
        for (const o of this._dynamic) {
            let root = o;
            while (root.parent && root.parent !== this.scene) root = root.parent;
            root.updateWorldMatrix(true, true);
        }
        r.setRenderTarget(this.light.shadow.map);
        this._drawList(this._dynamic);
    }

    dispose() {
        if (this.cache) this.cache.dispose();
        this._copyMat.dispose();
        this._restoreMat.dispose();
        this._copyQuad.dispose();
        this._restoreQuad.dispose();
        for (const m of Object.values(this._depthMats)) m.dispose();
    }
}
