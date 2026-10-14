/**
 * SceneAlbedo.js
 * ─────────────────────────────────────────────────────────────
 * ALBÉDO RÉEL de la scène pour la passe des taches de lumière (LightPoolPass) : la scène redessinée sans
 * éclairage, chaque matériau éclairé remplacé par un MeshBasicMaterial de même couleur, même texture, mêmes
 * couleurs de sommets / d'instances (squelettes et instances gérés par three.js) → couleur linéaire du
 * matériau par pixel (a = 1 : pixel couvert).
 *
 * Sans elle, la passe des taches devinait le matériau à partir de la position et de la normale (pelouse, lino
 * noir, lino satiné) : un personnage orange sous une lyre blanche ressortait gris pâle, alors qu'une SpotLight
 * three.js (qui utilise le vrai matériau) le rend orange.
 *
 * Seuls les maillages OPAQUES à matériau éclairé (Standard, Physical, Lambert, Phong, Toon) QUI TOUCHENT un cône
 * de lyre (sphère englobante / tronc du cône, test large) sont dessinés : coût CPU d'un rendu de la scène
 * limité aux objets éclairés. Le reste (faisceaux, lasers, matériaux sans éclairage, transparents, lignes,
 * points, gizmos, objets hors des cônes) est masqué le temps du rendu : là, la passe des taches garde son
 * classement par position (rebond de la GI hors des cônes : couleur devinée, comme avant).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { gpuPassTimer } from '../../render/GpuPassTimer.js';
import { SS_GEO } from '../ssdepth/SSDepthLights.js';

const _s = new THREE.Sphere();

const LIT = m => m && (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial);

export class SceneAlbedo {
    /** @param {THREE.Scene} scene @param {THREE.Camera} camera */
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.target = new THREE.WebGLRenderTarget(1, 1, {
            type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
        });
        /** @type {WeakMap<THREE.Material, THREE.MeshBasicMaterial>} */
        this._basic = new WeakMap();
        this._swapped = [];   // [objet, matériau d'origine]
        this._hidden = [];
        this._black = new THREE.Color(0, 0, 0);
        this._clear = new THREE.Color();
    }

    setSize(w, h) {
        this.target.setSize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    }

    get texture() { return this.target.texture; }

    /** Matériau sans éclairage équivalent (mis à jour à chaque image : couleur ou texture animées) */
    _basicFor(m) {
        let b = this._basic.get(m);
        if (!b) {
            b = new THREE.MeshBasicMaterial();
            b.fog = false;
            b.toneMapped = false;
            this._basic.set(m, b);
        }
        b.color.copy(m.color);
        if (b.map !== m.map) { b.map = m.map; b.needsUpdate = true; }
        if (b.vertexColors !== m.vertexColors) { b.vertexColors = m.vertexColors; b.needsUpdate = true; }
        if (b.alphaTest !== m.alphaTest) { b.alphaTest = m.alphaTest; b.needsUpdate = true; }
        b.side = m.side;
        return b;
    }

    /**
     * L'objet (sphère englobante monde) touche-t-il un des n cônes ? Tronc du cône réduit à un segment (début →
     * bout le plus lointain) épaissi du plus grand de ses rayons : large, jamais trop serré
     */
    _inCones(o, geo, n) {
        if (o.isInstancedMesh) {
            if (o.instanceMatrix.usage === THREE.DynamicDrawUsage) return true;   // instances mobiles
            if (!o.boundingSphere) o.computeBoundingSphere();
            _s.copy(o.boundingSphere);
        } else {
            const g = o.geometry;
            if (!g) return true;
            if (!g.boundingSphere) g.computeBoundingSphere();
            _s.copy(g.boundingSphere);
        }
        _s.applyMatrix4(o.matrixWorld);
        if (o.isSkinnedMesh) _s.radius *= 1.5;   // pose de liaison : les membres animés en sortent
        const cx = _s.center.x, cy = _s.center.y, cz = _s.center.z, R = _s.radius;
        if (!(R < Infinity)) return true;
        for (let i = 0; i < n; i++) {
            const k = i * SS_GEO;
            const e = geo[k + 19] > 0.5 ? 14 : 4;
            const ax = geo[k], ay = geo[k + 1], az = geo[k + 2];
            const dx = geo[k + e] - ax, dy = geo[k + e + 1] - ay, dz = geo[k + e + 2] - az;
            const l2 = dx * dx + dy * dy + dz * dz;
            let t = l2 > 0 ? ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + dx * t - cx, py = ay + dy * t - cy, pz = az + dz * t - cz;
            const r = Math.max(geo[k + 3], geo[k + e + 3]) + R;
            if (px * px + py * py + pz * pz <= r * r) return true;
        }
        return false;
    }

    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {Float32Array} geo géométrie des cônes (SSDepthLights._geo) @param {number} n nombre de cônes
     */
    render(renderer, geo, n) {
        const scene = this.scene;
        const swapped = this._swapped, hidden = this._hidden;
        scene.traverseVisible(o => {
            if (o === scene || !(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
            const mat = o.material;
            const ok = o.isMesh && (Array.isArray(mat)
                ? mat.every(m => LIT(m) && !m.transparent)
                : LIT(mat) && !mat.transparent) && this._inCones(o, geo, n);
            if (!ok) { hidden.push(o); return; }
            swapped.push(o, mat);
            o.material = Array.isArray(mat) ? mat.map(m => this._basicFor(m)) : this._basicFor(mat);
        });
        for (const o of hidden) o.visible = false;

        const bg = scene.background, fog = scene.fog, ov = scene.overrideMaterial;
        const shadowAuto = renderer.shadowMap.autoUpdate;
        const autoClear = renderer.autoClear;
        renderer.getClearColor(this._clear);
        const clearAlpha = renderer.getClearAlpha();
        const timer = gpuPassTimer.enabled ? gpuPassTimer : null;
        if (timer) timer.begin('Albédo de la scène');
        try {
            scene.background = null;
            scene.fog = null;
            scene.overrideMaterial = null;
            renderer.shadowMap.autoUpdate = false;   // pas de nouveau rendu des ombres three.js
            renderer.autoClear = false;
            renderer.setRenderTarget(this.target);
            renderer.setClearColor(this._black, 0);
            renderer.clear(true, true, false);
            renderer.render(scene, this.camera);
        } finally {
            if (timer) timer.end();
            for (let i = 0; i < swapped.length; i += 2) swapped[i].material = swapped[i + 1];
            for (const o of hidden) o.visible = true;
            swapped.length = 0;
            hidden.length = 0;
            scene.background = bg;
            scene.fog = fog;
            scene.overrideMaterial = ov;
            renderer.shadowMap.autoUpdate = shadowAuto;
            renderer.autoClear = autoClear;
            renderer.setClearColor(this._clear, clearAlpha);
        }
    }

    dispose() {
        this.target.dispose();
    }
}
