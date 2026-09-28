/**
 * LaserPod.js
 * ─────────────────────────────────────────────────────────────
 * Représente un boîtier laser physique (pod) :
 * - Position source (origin, baseOrigin)
 * - Modèle 3D du boîtier (instancié, partagé par tous les lasers)
 * - Éclairage émis par la source (lightPosition / lightColor / lightIntensity),
 *   rendu par le pool de lumières agrégées du LaserManager
 * - Déphasage d'oscillation (phase)
 *
 * Le plan PAN, l'éclat de source et les faisceaux sont dessinés par le LaserBatch
 * partagé (1 draw call par type pour tous les lasers).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { LaserPodHousing } from './LaserPodHousing.js?v=3';

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

        // Éclairage de la source (agrégé par le LaserManager dans un pool fixe de PointLight)
        this.lightPosition  = new THREE.Vector3();
        this.lightColor     = new THREE.Color('#0055ff');
        this.lightIntensity = 0;
        this.lightDistance  = 15;
        this.visible = true;

        // Modèle 3D complet du boîtier laser (châssis, lyre, optique, etc.)
        this.housing = new LaserPodHousing(scene);
    }

    setBasePosition(x, y, z) {
        this.baseOrigin.set(x, y, z);
    }

    /**
     * Met à jour la position réelle de la source (avec offset d'avancement)
     * et synchronise le boîtier 3D et les données d'éclairage.
     */
    updateSource(sourceDistanceOffset, giWallOffset, giColor, totalLightPower, giDistance, strobeFactor = 1.0, angle = 0, tilt = 0, roll = 0) {
        this.origin.copy(this.baseOrigin);
        this.origin.z += sourceDistanceOffset;

        this.lightPosition.set(
            this.origin.x,
            this.origin.y,
            this.origin.z + giWallOffset
        );
        this.lightColor.copy(giColor);
        this.lightIntensity = totalLightPower * 2.5;
        this.lightDistance = giDistance;

        // Mise à jour spatiale du modèle 3D du boîtier (avec synchronisation de couleur laser)
        this.housing.update(this.origin, angle !== undefined ? angle : 0, tilt !== undefined ? tilt : 0, roll !== undefined ? roll : 0, strobeFactor, giColor);
    }

    setVisible(visible) {
        this.visible = visible;
        this.housing.setVisible(visible);
    }

    dispose() {
        this.housing.dispose();
    }
}
