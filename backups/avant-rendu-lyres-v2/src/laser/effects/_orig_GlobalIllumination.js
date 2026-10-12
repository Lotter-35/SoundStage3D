/**
 * GlobalIllumination.js
 * ─────────────────────────────────────────────────────────────
 * Illumination globale (GI) d'impact sur les murs et le sol :
 * - Pool fixe de MAX_IMPACT_LIGHTS PointLights (coût GPU fixe et maîtrisé)
 * - Échantillonnage uniforme le long de la ligne d'impact de chaque boîtier
 * - Répartition homogène de la lumière sans hotspot central artificiel
 * - Option désactivable pour préserver les performances sur les petites configs
 * ─────────────────────────────────────────────────────────────
 * OPTIMISÉ : couleur setColor sans allocation GC
 */

import { MAX_PODS } from '../config/constants.js';
import { params } from '../config/params.js';

export const MAX_IMPACT_LIGHTS = MAX_PODS;

export class GlobalIllumination {
    /**
     * @param {THREE.Scene} scene
     */
    constructor(scene) {
        this.scene = scene;
        this.impactLights = [];

        // Pool fixe de lumières ponctuelles d'impact
        for (let i = 0; i < MAX_IMPACT_LIGHTS; i++) {
            const light = new THREE.PointLight(
                new THREE.Color(params.color),
                0,
                params.giImpactDistance,
                2.0
            );
            light.intensity = 0;
            this.scene.add(light);
            this.impactLights.push(light);
        }

        // Couleur pré-allouée — pas de new THREE.Color() dans setColor()
        this._tmpColor = new THREE.Color();
    }

    /**
     * Éteint instantanément toutes les lumières d'impact du pool.
     */
    turnOffAll() {
        for (let i = 0; i < MAX_IMPACT_LIGHTS; i++) {
            if (this.impactLights[i].intensity !== 0) {
                this.impactLights[i].intensity = 0;
            }
        }
    }

    /** Met à jour la couleur de toutes les lumières sans allocation */
    setColor(color) {
        this._tmpColor.set(color);
        for (let i = 0; i < MAX_IMPACT_LIGHTS; i++) {
            this.impactLights[i].color.copy(this._tmpColor);
        }
    }

    /**
     * Met à jour la position et l'intensité des lumières d'impact réparties.
     * @param {Array<Array<THREE.Vector3>>} allPodHitPoints Points d'impact par pod
     * @param {Array<Array<THREE.Vector3>>} allPodHitNormals Normales de surface par pod
     * @param {number} effectiveBeamPower Puissance effective faisceau
     * @param {number} effectivePanPower Puissance effective plan
     * @param {THREE.Color} giColor Couleur calculée pour la GI (objet partagé — lire seulement)
     * @param {number} nBeamsPerPod Nombre de faisceaux par pod
     */
    update(allPodHitPoints, allPodHitNormals, effectiveBeamPower, effectivePanPower, giColor, nBeamsPerPod) {
        if (!params.enableImpactLights || params.giImpactIntensity <= 0.001) {
            this.turnOffAll();
            return;
        }

        const isBeamVisible = params.beamWidth > 0.01;
        const isPanActive   = params.laserPan && params.spread > 0 && nBeamsPerPod > 1;

        let impactLightIdx = 0;
        const activePods = Math.max(1, params.numPods);
        const lightsPerPod = Math.max(1, Math.floor(MAX_IMPACT_LIGHTS / activePods));

        for (let p = 0; p < MAX_PODS; p++) {
            if (p >= params.numPods) {
                for (let l = 0; l < lightsPerPod && impactLightIdx < MAX_IMPACT_LIGHTS; l++) {
                    this.impactLights[impactLightIdx++].intensity = 0;
                }
                continue;
            }

            const podHits  = allPodHitPoints[p];
            const podNorms = allPodHitNormals[p];
            const n = (podHits && podHits.length) || 0;

            if (n === 0 || (!isBeamVisible && !isPanActive)) {
                for (let l = 0; l < lightsPerPod && impactLightIdx < MAX_IMPACT_LIGHTS; l++) {
                    this.impactLights[impactLightIdx++].intensity = 0;
                }
                continue;
            }

            // Intensité totale calculée pour ce pod
            let totalIntensity;
            if (isPanActive) {
                totalIntensity = (effectivePanPower * 1.5 + effectiveBeamPower * 0.3)
                                * params.giImpactIntensity * Math.sqrt(n);
            } else {
                totalIntensity = effectiveBeamPower * params.giImpactIntensity * 2.5 * Math.sqrt(n);
            }

            const numSamples = Math.min(lightsPerPod, n, MAX_IMPACT_LIGHTS - impactLightIdx);
            const perLightIntensity = totalIntensity / numSamples;

            for (let l = 0; l < numSamples; l++) {
                const sampleIdx = numSamples === 1
                    ? Math.floor(n / 2)
                    : Math.round(l * (n - 1) / (numSamples - 1));

                const hit  = podHits[sampleIdx];
                const norm = podNorms[sampleIdx];

                const light = this.impactLights[impactLightIdx++];
                light.position.copy(hit).addScaledVector(norm, 0.30);
                light.color.copy(giColor);
                light.distance = params.giImpactDistance;
                light.intensity = perLightIntensity;
            }
        }

        // Éteindre les lumières restantes non utilisées
        for (; impactLightIdx < MAX_IMPACT_LIGHTS; impactLightIdx++) {
            this.impactLights[impactLightIdx].intensity = 0;
        }
    }
}
