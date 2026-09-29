/**
 * SpotAimTarget.js
 * ─────────────────────────────────────────────────────────────
 * Point de visée de la console :
 *   - repère 3D (anneau + mât lumineux) posé sur la surface visée
 *   - lancer de rayon souris → surface de la scène (sol, scène, décor…)
 *     en ignorant les objets transparents, instanciés massifs (herbe), lasers et lyres ;
 *     à défaut, plan du sol y = 0
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';

const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();

export class SpotAimTarget {
    constructor(scene) {
        this.scene = scene;
        this.position = new THREE.Vector3();
        this.hasTarget = false;
        this.raycaster = new THREE.Raycaster();

        this.group = new THREE.Group();
        this.group.name = 'spot-aim-target';
        this.group.visible = false;
        const mat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(0.2, 1.4, 1.8),
            transparent: true,
            opacity: 0.9,
            depthWrite: false,
            toneMapped: false,
            side: THREE.DoubleSide,
        });
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 48), mat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.03;
        const dot = new THREE.Mesh(new THREE.CircleGeometry(0.08, 20), mat);
        dot.rotation.x = -Math.PI / 2;
        dot.position.y = 0.03;
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.6, 8), mat);
        mast.position.y = 0.8;
        this.group.add(ring, dot, mast);
        this.group.traverse(o => { o.userData.isAimTarget = true; o.renderOrder = 20; });
        scene.add(this.group);
    }

    set(point) {
        this.position.copy(point);
        this.group.position.copy(point);
        this.hasTarget = true;
    }

    setVisible(v) {
        this.group.visible = Boolean(v) && this.hasTarget;
    }

    _pickable(obj) {
        if (!obj.visible || !obj.isMesh) return false;
        const n = obj.name || '';
        if (n.startsWith('spot-') || n.startsWith('laser-') || obj.userData.isAimTarget) return false;
        if (obj.isInstancedMesh && obj.count > 64) return false; // herbe, végétation…
        const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (!m || m.visible === false || m.transparent || m.blending === THREE.AdditiveBlending) return false;
        let p = obj.parent;
        while (p) {
            if (!p.visible || p.isTransformControls) return false;
            p = p.parent;
        }
        return true;
    }

    /**
     * Surface visée sous le pointeur.
     * @param {number} clientX
     * @param {number} clientY
     * @param {HTMLElement} canvas
     * @param {THREE.Camera} camera
     * @returns {THREE.Vector3|null}
     */
    pick(clientX, clientY, canvas, camera) {
        const r = canvas.getBoundingClientRect();
        _ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
        this.raycaster.setFromCamera(_ndc, camera);
        this.raycaster.far = 400;
        const candidates = [];
        this.scene.traverseVisible(o => { if (this._pickable(o)) candidates.push(o); });
        const hits = this.raycaster.intersectObjects(candidates, false);
        if (hits.length) return hits[0].point.clone();
        if (this.raycaster.ray.intersectPlane(_plane, _hit)) return _hit.clone();
        return null;
    }
}
