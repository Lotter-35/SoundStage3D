/**
 * StrobeHousingInstancer.js
 * ─────────────────────────────────────────────────────────────
 * Boîtiers de TOUS les stroboscopes dessinés en 5 appels (maillages instanciés partagés) au lieu de
 * 7 maillages par stroboscope (350 appels pour 50 strobes, répétés à chaque rendu de la scène).
 *
 *  - châssis, cadre avant, écran émissif, bras de l'étrier (×2), molettes (×2)
 *  - mêmes géométries, dimensions et matériaux qu'avant (géométries unitaires mises à l'échelle)
 *  - couleur / éclat de l'écran de chaque stroboscope : couleur d'instance (flash compris)
 *  - l'écran reste sur le layer du bloom des lampes (activé seulement si un stroboscope flashe)
 *
 * Chaque StrobeLight garde son groupe (position, orientation, gizmo) et une boîte invisible pour la
 * sélection à la souris ; l'instancieur recopie à chaque image la matrice monde du groupe.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { enableLightsBloom, disableLightsBloom } from '../laser/LaserManager.js';

const FRAME_THICK = 0.035;
const ARM_THICK = 0.025;
const OFF_COLOR = new THREE.Color(0x18181a); // réflecteur éteint

const _m = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _q = new THREE.Quaternion();

function makePart(geometry, material, capacity, name) {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.count = 0;
    mesh.frustumCulled = false; // instances réparties partout : la sphère de la géométrie unitaire ne vaut rien
    mesh.userData.isAmbianceInternal = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
}

class StrobeHousingInstancer {
    constructor(scene) {
        this.scene = scene;
        this.strobes = new Set();
        this.capacity = 0;

        this.materials = {
            chassis: new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.45, metalness: 0.85 }),
            frame:   new THREE.MeshStandardMaterial({ color: 0x222226, roughness: 0.35, metalness: 0.90 }),
            bracket: new THREE.MeshStandardMaterial({ color: 0x2e2e32, roughness: 0.40, metalness: 0.88 }),
            screen:  new THREE.MeshBasicMaterial({ color: 0xffffff }),
        };
        const knob = new THREE.CylinderGeometry(1, 1, 1, 16);
        knob.rotateZ(Math.PI / 2); // axe le long de X, comme les molettes d'origine
        this.geometries = {
            box: new THREE.BoxGeometry(1, 1, 1),
            plane: new THREE.PlaneGeometry(1, 1),
            knob,
        };
        this.parts = null;
        this._grow(64);
    }

    _grow(capacity) {
        const old = this.parts;
        if (old) {
            disableLightsBloom(old.screen);
            for (const m of Object.values(old)) { this.scene.remove(m); m.dispose(); }
        }
        const g = this.geometries, mt = this.materials;
        this.capacity = capacity;
        this.parts = {
            chassis: makePart(g.box, mt.chassis, capacity, 'strobe-housing-chassis'),
            frame:   makePart(g.box, mt.frame, capacity, 'strobe-housing-frame'),
            screen:  makePart(g.plane, mt.screen, capacity, 'strobe-housing-screen'),
            arms:    makePart(g.box, mt.bracket, capacity * 2, 'strobe-housing-arms'),
            knobs:   makePart(g.knob, mt.bracket, capacity * 2, 'strobe-housing-knobs'),
        };
        this.parts.chassis.receiveShadow = true;
        this.parts.screen.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        this.parts.screen.instanceColor.setUsage(THREE.DynamicDrawUsage);
        enableLightsBloom(this.parts.screen);
        for (const m of Object.values(this.parts)) this.scene.add(m);
    }

    add(strobe) {
        this.strobes.add(strobe);
        if (this.strobes.size > this.capacity) this._grow(this.capacity * 2);
    }

    remove(strobe) {
        this.strobes.delete(strobe);
    }

    _put(mesh, index, world, x, y, z, sx, sy, sz) {
        _pos.set(x, y, z);
        _scale.set(sx, sy, sz);
        _local.compose(_pos, _q.identity(), _scale);
        _m.multiplyMatrices(world, _local);
        mesh.setMatrixAt(index, _m);
    }

    /** Recopie la position / taille / couleur de chaque stroboscope dans les instances (à chaque image) */
    update() {
        const P = this.parts;
        let nBox = 0, nArm = 0, nScreen = 0;
        let anyFlash = false;
        for (const s of this.strobes) {
            const p = s.params;
            s.group.updateWorldMatrix(true, false);
            const world = s.group.matrixWorld;
            const w = p.width, h = p.height, d = p.depth;
            const isFlat = (p.showHousing === false) || (w <= 0.05);
            if (isFlat) {
                // Plan seul : uniquement la surface émissive
                const effW = w > 0.05 ? w : Math.max(0.5, h);
                this._put(P.screen, nScreen, world, 0, 0, 0, effW, Math.max(0.05, h), 1);
            } else {
                this._put(P.chassis, nBox, world, 0, 0, 0, w, h, d);
                this._put(P.frame, nBox, world, 0, 0, d * 0.5 + FRAME_THICK * 0.5, w + 0.03, h + 0.03, FRAME_THICK);
                nBox++;
                this._put(P.screen, nScreen, world, 0, 0, d * 0.5 + FRAME_THICK + 0.002,
                    Math.max(0.05, w - 0.04), Math.max(0.05, h - 0.04), 1);
                const armX = w * 0.5 + ARM_THICK * 0.5 + 0.01;
                const knobX = w * 0.5 + ARM_THICK + 0.015;
                this._put(P.arms, nArm, world, -armX, 0, 0, ARM_THICK, h * 0.85, d * 1.15);
                this._put(P.knobs, nArm, world, -knobX, 0, 0, 0.03, 0.032, 0.032);
                nArm++;
                this._put(P.arms, nArm, world, armX, 0, 0, ARM_THICK, h * 0.85, d * 1.15);
                this._put(P.knobs, nArm, world, knobX, 0, 0, 0.03, 0.032, 0.032);
                nArm++;
            }
            P.screen.setColorAt(nScreen, s.flash ? s.screenColor : OFF_COLOR);
            if (s.flash) anyFlash = true;
            nScreen++;
        }
        P.chassis.count = nBox;
        P.frame.count = nBox;
        P.arms.count = nArm;
        P.knobs.count = nArm;
        P.screen.count = nScreen;
        for (const m of Object.values(P)) {
            m.visible = m.count > 0;
            if (m.count > 0) m.instanceMatrix.needsUpdate = true;
        }
        if (nScreen > 0) P.screen.instanceColor.needsUpdate = true;
        // Bloom des lampes : seulement si au moins un écran est allumé (sinon la passe peut être sautée)
        if (anyFlash) P.screen.layers.enable(2);
        else P.screen.layers.disable(2);
    }
}

const _instancers = new WeakMap();

/** Instancieur partagé de la scène (créé au premier stroboscope) */
export function getStrobeHousingInstancer(scene) {
    let inst = _instancers.get(scene);
    if (!inst) {
        inst = new StrobeHousingInstancer(scene);
        _instancers.set(scene, inst);
    }
    return inst;
}
