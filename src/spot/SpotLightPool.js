/**
 * SpotLightPool.js
 * ─────────────────────────────────────────────────────────────
 * Éclairage RÉEL de la scène par les lyres, à coût constant :
 *   - pool FIXE de SpotLight créées au démarrage (jamais ajoutées / retirées →
 *     aucune recompilation des shaders éclairés quand on pose une lyre)
 *   - chaque SpotLight projette une texture (`map`) redessinée à chaque frame avec
 *     la même image de fenêtre que le faisceau : gobos, prisme, couteaux, iris,
 *     couleurs, frost, focus → le motif projeté sur le décor correspond au faisceau
 *   - attribution aux lyres les plus importantes (flux, proximité de la caméra),
 *     avec hystérésis et fondu enchaîné : la lyre qui perd sa lumière réelle
 *     retrouve progressivement sa tache de lumière calculée dans le shader
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { createGateMapMaterial } from './SpotShaders.js';
import { SPOT_BEAM_RANGE } from './SpotFixture.js';
import { LENS_RADIUS } from './SpotHousing.js';

/** Nombre maximal de lumières réelles (chaque texture de projection occupe 1 unité de texture
 *  dans TOUS les matériaux éclairés : on garde 10 unités pour leurs propres textures et ombres) */
export const SPOT_LIGHT_POOL_MAX = 8;
const TEXTURE_UNITS_RESERVED = 10;
const MAP_SIZE = 256;
const LIGHT_SCALE = 20;
const FADE_RATE = 4; // par seconde

const _throwPt = new THREE.Vector3();

export class SpotLightPool {
    constructor(scene, renderer, batch) {
        this.scene = scene;
        this.renderer = renderer;
        this.batch = batch;
        this._mapMaterial = createGateMapMaterial(batch.paramsTexture, batch.goboTexture);
        batch.onParamsTexture(tex => { this._mapMaterial.uniforms.uSpotParams.value = tex; });
        this._quad = new FullScreenQuad(this._mapMaterial);
        this._shadows = false;

        const units = (renderer && renderer.capabilities && renderer.capabilities.maxTextures) || 16;
        this.size = Math.max(2, Math.min(SPOT_LIGHT_POOL_MAX, units - TEXTURE_UNITS_RESERVED));

        this.slots = [];
        for (let i = 0; i < this.size; i++) {
            const rt = new THREE.WebGLRenderTarget(MAP_SIZE, MAP_SIZE, { depthBuffer: false, stencilBuffer: false });
            rt.texture.generateMipmaps = false;
            const light = new THREE.SpotLight(0xffffff, 0, SPOT_BEAM_RANGE, 0.4, 0, 2);
            light.name = 'spot-light-pool-' + i;
            light.userData.isAmbianceInternal = true;
            light.map = rt.texture;
            light.castShadow = false;
            light.shadow.focus = 1;
            light.shadow.mapSize.set(1024, 1024);
            light.shadow.bias = -0.0004;
            light.shadow.normalBias = 0.04;
            light.shadow.camera.near = 0.3;
            light.target.name = 'spot-light-pool-target-' + i;
            light.target.userData.isAmbianceInternal = true;
            scene.add(light);
            scene.add(light.target);
            this.slots.push({ light, rt, fixture: null, weight: 0 });
        }
        this._candidates = [];
    }

    /** Libère immédiatement la lumière d'une lyre supprimée */
    release(fixture) {
        for (const s of this.slots) {
            if (s.fixture === fixture) {
                s.fixture = null;
                s.weight = 0;
                s.light.intensity = 0;
            }
        }
    }

    setShadows(enabled) {
        this._shadows = Boolean(enabled);
    }

    _throwDistance(f) {
        // Distance jusqu'au sol le long de l'axe (sert au score et au flou de mise au point)
        if (f.axis.y < -0.05) return Math.min(80, Math.max(0.5, f.lensPos.y / -f.axis.y));
        return 30;
    }

    /**
     * @param {Iterable<import('./SpotFixture.js').SpotFixture>} fixtures
     * @param {THREE.Camera} camera
     * @param {boolean} enabled Éclairage réel activé
     * @param {number} dt
     */
    update(fixtures, camera, enabled, dt) {
        const K = this.slots.length;

        // 1. Candidats triés par score (les lyres déjà éclairées sont favorisées : pas de clignotement)
        const cand = this._candidates;
        cand.length = 0;
        if (enabled) {
            for (const f of fixtures) {
                if (f.lightFlux <= 0.002) continue;
                // Une SpotLight réelle traverserait les murs : si le cône touche la structure de la scène,
                // la lyre garde sa tache de lumière calculée par le shader (qui gère l'occlusion)
                if (f.occluderCount > 0) continue;
                const t = this._throwDistance(f);
                _throwPt.copy(f.lensPos).addScaledVector(f.axis, t);
                const d = camera.position.distanceTo(_throwPt);
                let score = f.lightFlux / (1 + d / 25);
                if (this.slots.some(s => s.fixture === f && s.weight > 0)) score *= 1.3;
                f._poolScore = score;
                f._throw = t;
                cand.push(f);
            }
            cand.sort((a, b) => b._poolScore - a._poolScore);
            if (cand.length > K) cand.length = K;
        }

        // 2. Fondus : les lumières qui ne sont plus méritées s'éteignent, les autres s'allument
        const step = dt * FADE_RATE;
        for (const s of this.slots) {
            if (s.fixture && !cand.includes(s.fixture)) {
                s.weight = Math.max(0, s.weight - step);
                if (s.weight === 0) s.fixture = null;
            } else if (s.fixture) {
                s.weight = Math.min(1, s.weight + step);
            }
        }
        for (const f of cand) {
            if (this.slots.some(s => s.fixture === f)) continue;
            const free = this.slots.find(s => s.fixture === null);
            if (!free) break;
            free.fixture = f;
            free.weight = Math.min(1, step);
        }

        // 3. Poids d'éclairage réel par lyre (la tache calculée par le shader prend le relais)
        for (const f of fixtures) f.poolWeight = 0;
        for (const s of this.slots) if (s.fixture) s.fixture.poolWeight = s.weight;

        // 4. Configuration des lumières + dessin de leur texture de projection
        const r = this.renderer;
        const oldTarget = r.getRenderTarget();
        let i = 0;
        for (const s of this.slots) {
            const light = s.light;
            const f = s.fixture;
            const wantShadow = this._shadows && i < 2;
            if (light.castShadow !== wantShadow) light.castShadow = wantShadow;
            i++;
            if (!f || s.weight <= 0) {
                light.intensity = 0;
                continue;
            }
            light.position.copy(f.lensPos);
            light.target.position.copy(f.lensPos).add(f.axis);
            light.shadow.camera.up.copy(f.up);
            light.updateMatrixWorld();
            light.target.updateMatrixWorld();
            light.angle = Math.min(1.25, Math.atan(f.tanLight) * 1.02);
            // Ouverture effective à la distance de projection (la lentille a une taille) : un zoom à 0°
            // donne une tache de la taille de la lentille, pas une intensité infinie
            const tanEff = f.tanHalf + LENS_RADIUS / Math.max(1, f._throw || this._throwDistance(f));
            light.intensity = LIGHT_SCALE * f.lightFlux * s.weight / (Math.PI * tanEff * tanEff);

            const u = this._mapMaterial.uniforms;
            const throwDist = f._throw || this._throwDistance(f);
            u.uRow.value = f.row;
            u.uScale.value = Math.tan(light.angle) / f.tanHalf;
            u.uBlur.value = f.frost * 0.42 + Math.min(0.14, Math.abs(Math.log((throwDist + 0.5) / f.focusDist)) * 0.035);
            u.uFacetCount.value = f.facetCount;
            for (let k = 0; k < f.facetCount; k++) {
                const fc = f.facets[k];
                u.uFacets.value[k].set(fc.gx, fc.gy, fc.weight);
            }
            r.setRenderTarget(s.rt);
            this._quad.render(r);
        }
        r.setRenderTarget(oldTarget);
    }

    dispose() {
        for (const s of this.slots) {
            this.scene.remove(s.light);
            this.scene.remove(s.light.target);
            s.rt.dispose();
        }
        this._mapMaterial.dispose();
        this._quad.dispose();
    }
}
