/**
 * gizmoSnap.js — Aimantation du gizmo (TransformControls) quand Maj est enfoncée pendant le glissement :
 *   - déplacement : la position (axes tirés seulement) se cale sur la grille du MONDE (pas sur la position
 *     de départ : un appareil décentré est recalé) ;
 *   - rotation : l'angle autour de l'axe tourné se cale sur des paliers mesurés par rapport au monde
 *     (un appareil de travers est remis droit).
 * Sélection multiple : le gizmo est au centre du groupe, c'est ce centre qui se cale.
 *
 * Le calage est appliqué juste avant que le gizmo n'annonce le mouvement (« change » / « objectChange ») :
 * tous les écouteurs (synchro, inspecteurs, groupe) reçoivent la position calée.
 */

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _e = new THREE.Euler();
const DEG = Math.PI / 180;
/** Ordre d'Euler dont la 1re rotation est celle de l'axe du monde tourné */
const EULER_ORDER = { X: 'XYZ', Y: 'YXZ', Z: 'ZYX' };

/**
 * @param {import('three/addons/controls/TransformControls.js').TransformControls} tc
 * @param {() => {grid: number, angle: number}} getSettings taille de la grille (m) et palier de rotation (°)
 */
export function installGizmoSnap(tc, getSettings) {
    let shift = false;
    const track = (e) => { shift = e.shiftKey; };
    window.addEventListener('keydown', track, true);
    window.addEventListener('keyup', track, true);
    window.addEventListener('pointermove', track, true);
    window.addEventListener('blur', () => { shift = false; });

    const snap = () => {
        const obj = tc.object;
        if (!obj || !tc.dragging || !shift || !tc.axis) return;
        const { grid, angle } = getSettings();
        if (tc.mode === 'translate') {
            if (!(grid > 0)) return;
            obj.getWorldPosition(_v);
            if (tc.axis.includes('X')) _v.x = Math.round(_v.x / grid) * grid;
            if (tc.axis.includes('Y')) _v.y = Math.round(_v.y / grid) * grid;
            if (tc.axis.includes('Z')) _v.z = Math.round(_v.z / grid) * grid;
            if (obj.parent) obj.parent.worldToLocal(_v);
            obj.position.copy(_v);
            obj.updateMatrixWorld(true);
        } else if (tc.mode === 'rotate') {
            const order = EULER_ORDER[tc.axis];   // rotation libre (E, XYZE) : pas de calage
            const step = angle * DEG;
            if (!order || !(step > 0)) return;
            obj.getWorldQuaternion(_q);
            _e.setFromQuaternion(_q, order);
            const k = tc.axis.toLowerCase();
            _e[k] = Math.round(_e[k] / step) * step;
            _q.setFromEuler(_e);
            if (obj.parent) _q.premultiply(obj.parent.getWorldQuaternion(_pq).invert());
            obj.quaternion.copy(_q);
            obj.updateMatrixWorld(true);
        }
    };

    const dispatch = tc.dispatchEvent.bind(tc);
    tc.dispatchEvent = (event) => {
        if (event && (event.type === 'change' || event.type === 'objectChange')) snap();
        return dispatch(event);
    };
}
