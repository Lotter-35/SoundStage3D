/**
 * LaserPod.js
 * ─────────────────────────────────────────────────────────────
 * Représente un boîtier laser physique (pod) :
 * - Position source (origin, baseOrigin)
 * - Mesh du plan PAN volumétrique (fanMesh)
 * - Éclat sphérique à la source (glowMesh)
 * - Lumière ponctuelle Three.js émise par la source (pointLight)
 * - Déphasage d'oscillation (phase)
 * ─────────────────────────────────────────────────────────────
 */

import { MAX_BEAMS_PER_POD, ARC_SUBDIVISIONS } from '../config/constants.js';
import { params } from '../config/params.js';
import { fanShaderMaterial, podGlowMaterial, podGlowGeo } from './LaserShaders.js';
import { LaserPodHousing } from './LaserPodHousing.js?v=20';

export class LaserPod {
    /**
     * @param {THREE.Scene} scene
     * @param {number} index
     */
    constructor(scene, index) {
        this.scene = scene;
        this.index = index;
        this.phase = index * 0.6;

        this.origin = new THREE.Vector3();
        this.baseOrigin = new THREE.Vector3();

        // 1. Géométrie et Mesh du plan PAN volumétrique
        this.fanGeo = new THREE.BufferGeometry();
        const fanPositions = new Float32Array(MAX_BEAMS_PER_POD * ARC_SUBDIVISIONS * 2 * 9);
        const fanDistRatios = new Float32Array(MAX_BEAMS_PER_POD * ARC_SUBDIVISIONS * 2 * 3);
        const fanLaterals = new Float32Array(MAX_BEAMS_PER_POD * ARC_SUBDIVISIONS * 2 * 3);

        this.fanGeo.setAttribute('position', new THREE.BufferAttribute(fanPositions, 3));
        this.fanGeo.setAttribute('aDistRatio', new THREE.BufferAttribute(fanDistRatios, 1));
        this.fanGeo.setAttribute('aLateral', new THREE.BufferAttribute(fanLaterals, 1));

        this.fanMesh = new THREE.Mesh(this.fanGeo, fanShaderMaterial);
        this.fanMesh.frustumCulled = false;
        this.scene.add(this.fanMesh);

        // 2. Éclat lumineux sphérique à la buse
        this.glowMesh = new THREE.Mesh(podGlowGeo, podGlowMaterial);
        this.glowMesh.frustumCulled = false;
        this.scene.add(this.glowMesh);

        // 3. Lumière ponctuelle Three.js à la source
        this.pointLight = new THREE.PointLight(
            new THREE.Color(params.color),
            0,
            params.giDistance,
            1.8
        );
        this.scene.add(this.pointLight);

        // 4. Modèle 3D complet du boîtier laser (châssis, lyre, optique, etc.)
        this.housing = new LaserPodHousing(scene);
    }

    setBasePosition(x, y, z) {
        this.baseOrigin.set(x, y, z);
    }

    /**
     * Met à jour la position réelle de la source (avec offset d'avancement)
     * et synchronise le mesh glow, le boîtier 3D et la pointLight.
     */
    updateSource(sourceDistanceOffset, giWallOffset, giColor, totalLightPower, giDistance, strobeFactor = 1.0, angle = 0) {
        this.origin.copy(this.baseOrigin);
        this.origin.z += sourceDistanceOffset;

        this.glowMesh.position.copy(this.origin);

        this.pointLight.position.set(
            this.origin.x,
            this.origin.y,
            this.origin.z + giWallOffset
        );
        this.pointLight.color.copy(giColor);
        this.pointLight.intensity = totalLightPower * 2.5;
        this.pointLight.distance = giDistance;

        // Mise à jour spatiale du modèle 3D du boîtier (avec synchronisation de couleur laser)
        this.housing.update(this.origin, angle !== undefined ? angle : params.angle, strobeFactor, giColor);
    }

    setVisible(visible) {
        if (!visible) {
            this.fanMesh.visible = false;
            this.glowMesh.visible = false;
            this.pointLight.visible = false;
            this.housing.setVisible(false);
        } else {
            this.glowMesh.visible = true;
            this.pointLight.visible = true;
            this.housing.setVisible(true);
        }
    }

    dispose() {
        this.scene.remove(this.fanMesh);
        this.scene.remove(this.glowMesh);
        this.scene.remove(this.pointLight);
        this.fanGeo.dispose();
        this.housing.dispose();
    }
}
