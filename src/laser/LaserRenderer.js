/**
 * LaserRenderer.js
 * ─────────────────────────────────────────────────────────────
 * Gestion des buffers GPU partagés (batching optimal) :
 * - beamGeo / beamsMesh       : tous les faisceaux cylindriques de tous les pods
 * - impactGeo / impactMesh     : tous les halos circulaires d'impact de chaque trait
 * - panImpactGeo / panImpactMesh : tous les quads de la ligne d'impact continue (plan)
 * ─────────────────────────────────────────────────────────────
 * OPTIMISÉ : 0 allocation GC par frame dans les méthodes write*
 */

import * as THREE from 'three';


import {
    TOTAL_MAX_BEAMS,
    TOTAL_MAX_FAN_SEGMENTS,
    ARC_SUBDIVISIONS,
    BEAM_DIVERGENCE
} from './config/laserConstants.js';

export class LaserRenderer {
    constructor(scene, materials) {
        this.scene = scene;

        // ── 1. Buffer Faisceaux Laser (Beam Mesh) ──────────────────────────────
        this.beamGeo = new THREE.BufferGeometry();
        this.beamPositions = new Float32Array(TOTAL_MAX_BEAMS * 4 * 3);
        this.beamUvs       = new Float32Array(TOTAL_MAX_BEAMS * 4 * 2);
        this.beamOrigins   = new Float32Array(TOTAL_MAX_BEAMS * 4 * 3);
        this.beamHits      = new Float32Array(TOTAL_MAX_BEAMS * 4 * 3);
        this.beamSides     = new Float32Array(TOTAL_MAX_BEAMS * 4);
        this.beamIndices   = new Uint16Array(TOTAL_MAX_BEAMS * 6);

        for (let i = 0; i < TOTAL_MAX_BEAMS; i++) {
            const v = i * 4;
            this.beamIndices[i * 6 + 0] = v + 0;
            this.beamIndices[i * 6 + 1] = v + 1;
            this.beamIndices[i * 6 + 2] = v + 2;
            this.beamIndices[i * 6 + 3] = v + 2;
            this.beamIndices[i * 6 + 4] = v + 1;
            this.beamIndices[i * 6 + 5] = v + 3;

            this.beamUvs[v * 2 + 0] = 0; this.beamUvs[v * 2 + 1] = 0;
            this.beamUvs[v * 2 + 2] = 1; this.beamUvs[v * 2 + 3] = 0;
            this.beamUvs[v * 2 + 4] = 0; this.beamUvs[v * 2 + 5] = 1;
            this.beamUvs[v * 2 + 6] = 1; this.beamUvs[v * 2 + 7] = 1;

            this.beamSides[v + 0] = -1; this.beamSides[v + 1] = 1;
            this.beamSides[v + 2] = -1; this.beamSides[v + 3] = 1;
        }

        this.beamGeo.setAttribute('position', new THREE.BufferAttribute(this.beamPositions, 3));
        this.beamGeo.setAttribute('uv', new THREE.BufferAttribute(this.beamUvs, 2));
        this.beamGeo.setAttribute('aOrigin', new THREE.BufferAttribute(this.beamOrigins, 3));
        this.beamGeo.setAttribute('aHitPoint', new THREE.BufferAttribute(this.beamHits, 3));
        this.beamGeo.setAttribute('aSide', new THREE.BufferAttribute(this.beamSides, 1));
        this.beamGeo.setIndex(new THREE.BufferAttribute(this.beamIndices, 1));

        this.beamsMesh = new THREE.Mesh(this.beamGeo, materials.laserShaderMaterial);
        this.beamsMesh.frustumCulled = false;
        this.scene.add(this.beamsMesh);

        // ── 2. Buffer Halos d'Impact Ponctuels ─────────────────────────────────
        this.impactGeo = new THREE.BufferGeometry();
        this.impactPositions = new Float32Array(TOTAL_MAX_BEAMS * 4 * 3);
        this.impactUvs       = new Float32Array(TOTAL_MAX_BEAMS * 4 * 2);
        this.impactIndices   = new Uint16Array(TOTAL_MAX_BEAMS * 6);

        for (let i = 0; i < TOTAL_MAX_BEAMS; i++) {
            const v = i * 4;
            this.impactIndices[i * 6 + 0] = v + 0;
            this.impactIndices[i * 6 + 1] = v + 1;
            this.impactIndices[i * 6 + 2] = v + 2;
            this.impactIndices[i * 6 + 3] = v + 2;
            this.impactIndices[i * 6 + 4] = v + 1;
            this.impactIndices[i * 6 + 5] = v + 3;

            this.impactUvs[v * 2 + 0] = 0; this.impactUvs[v * 2 + 1] = 0;
            this.impactUvs[v * 2 + 2] = 1; this.impactUvs[v * 2 + 3] = 0;
            this.impactUvs[v * 2 + 4] = 0; this.impactUvs[v * 2 + 5] = 1;
            this.impactUvs[v * 2 + 6] = 1; this.impactUvs[v * 2 + 7] = 1;
        }

        this.impactGeo.setAttribute('position', new THREE.BufferAttribute(this.impactPositions, 3));
        this.impactGeo.setAttribute('uv', new THREE.BufferAttribute(this.impactUvs, 2));
        this.impactGeo.setIndex(new THREE.BufferAttribute(this.impactIndices, 1));

        this.impactMesh = new THREE.Mesh(this.impactGeo, materials.impactShaderMaterial);
        this.impactMesh.frustumCulled = false;
        this.scene.add(this.impactMesh);

        // ── 3. Buffer Ligne d'Impact Continue (Plan PAN) ──────────────────────
        this.panImpactGeo = new THREE.BufferGeometry();
        const panImpactMaxQuads = TOTAL_MAX_FAN_SEGMENTS * ARC_SUBDIVISIONS * 2;
        this.panImpactPositions = new Float32Array(panImpactMaxQuads * 4 * 3);
        this.panImpactUvs       = new Float32Array(panImpactMaxQuads * 4 * 2);
        this.panImpactIndices   = new Uint32Array(panImpactMaxQuads * 6);

        for (let i = 0; i < panImpactMaxQuads; i++) {
            const v = i * 4;
            this.panImpactIndices[i * 6 + 0] = v + 0;
            this.panImpactIndices[i * 6 + 1] = v + 1;
            this.panImpactIndices[i * 6 + 2] = v + 2;
            this.panImpactIndices[i * 6 + 3] = v + 2;
            this.panImpactIndices[i * 6 + 4] = v + 1;
            this.panImpactIndices[i * 6 + 5] = v + 3;

            this.panImpactUvs[v * 2 + 0] = 0; this.panImpactUvs[v * 2 + 1] = 0;
            this.panImpactUvs[v * 2 + 2] = 1; this.panImpactUvs[v * 2 + 3] = 0;
            this.panImpactUvs[v * 2 + 4] = 0; this.panImpactUvs[v * 2 + 5] = 1;
            this.panImpactUvs[v * 2 + 6] = 1; this.panImpactUvs[v * 2 + 7] = 1;
        }

        this.panImpactGeo.setAttribute('position', new THREE.BufferAttribute(this.panImpactPositions, 3));
        this.panImpactGeo.setAttribute('uv', new THREE.BufferAttribute(this.panImpactUvs, 2));
        this.panImpactGeo.setIndex(new THREE.BufferAttribute(this.panImpactIndices, 1));

        this.panImpactMesh = new THREE.Mesh(this.panImpactGeo, materials.panImpactShaderMaterial);
        this.panImpactMesh.frustumCulled = false;
        this.scene.add(this.panImpactMesh);

        // ── Vecteurs pré-alloués (0 GC dans les méthodes write*) ──────────────
        this._uVec   = new THREE.Vector3();
        this._vVec   = new THREE.Vector3();
        this._center = new THREE.Vector3();
        this._sdVec  = new THREE.Vector3();
        this._svVec  = new THREE.Vector3();
        this._c1     = new THREE.Vector3();
        this._c2     = new THREE.Vector3();
        this._midVec = new THREE.Vector3();
    }

    /**
     * Écrit un faisceau laser individuel dans le buffer GPU beamGeo.
     */
    writeBeam(beamIdx, origin, hit) {
        const v = beamIdx * 4;
        const origArr = this.beamOrigins;
        const hitArr  = this.beamHits;
        const posArr  = this.beamPositions;

        for (let k = 0; k < 4; k++) {
            const idx3 = (v + k) * 3;
            origArr[idx3 + 0] = origin.x;
            origArr[idx3 + 1] = origin.y;
            origArr[idx3 + 2] = origin.z;

            hitArr[idx3 + 0] = hit.x;
            hitArr[idx3 + 1] = hit.y;
            hitArr[idx3 + 2] = hit.z;

            posArr[idx3 + 0] = (k === 0 || k === 2) ? 0 : 0.5;
            posArr[idx3 + 1] = (k < 2) ? 0 : 1;
            posArr[idx3 + 2] = 0;
        }
    }

    /**
     * Écrit le halo d'impact ponctuel d'un faisceau dans impactGeo.
     * Opération 100% inline — 0 allocation.
     */
    writePointImpact(beamIdx, origin, hit, normal, beamWidth) {
        const hitDistX = hit.x - origin.x;
        const hitDistY = hit.y - origin.y;
        const hitDistZ = hit.z - origin.z;
        const hitDist = Math.sqrt(hitDistX * hitDistX + hitDistY * hitDistY + hitDistZ * hitDistZ);

        const divergenceFactor = 1.0 + (hitDist * 0.008) * BEAM_DIVERGENCE;
        const beamRadius = (0.022 + 0.025 * beamWidth) * divergenceFactor;

        const cx = hit.x + normal.x * 0.015;
        const cy = hit.y + normal.y * 0.015;
        const cz = hit.z + normal.z * 0.015;

        let ux, uy, uz, vx, vy, vz;
        if (Math.abs(normal.x) > 0.5) {
            ux = 0; uy = 0; uz = 1;
            vx = 0; vy = 1; vz = 0;
        } else if (Math.abs(normal.y) > 0.5) {
            ux = 1; uy = 0; uz = 0;
            vx = 0; vy = 0; vz = 1;
        } else {
            ux = 1; uy = 0; uz = 0;
            vx = 0; vy = 1; vz = 0;
        }

        const idx12 = beamIdx * 12;
        const arr = this.impactPositions;
        arr[idx12 + 0]  = cx - ux * beamRadius - vx * beamRadius;
        arr[idx12 + 1]  = cy - uy * beamRadius - vy * beamRadius;
        arr[idx12 + 2]  = cz - uz * beamRadius - vz * beamRadius;

        arr[idx12 + 3]  = cx + ux * beamRadius - vx * beamRadius;
        arr[idx12 + 4]  = cy + uy * beamRadius - vy * beamRadius;
        arr[idx12 + 5]  = cz + uz * beamRadius - vz * beamRadius;

        arr[idx12 + 6]  = cx - ux * beamRadius + vx * beamRadius;
        arr[idx12 + 7]  = cy - uy * beamRadius + vy * beamRadius;
        arr[idx12 + 8]  = cz - uz * beamRadius + vz * beamRadius;

        arr[idx12 + 9]  = cx + ux * beamRadius + vx * beamRadius;
        arr[idx12 + 10] = cy + uy * beamRadius + vy * beamRadius;
        arr[idx12 + 11] = cz + uz * beamRadius + vz * beamRadius;
    }

    /**
     * Écrit un quad de la ligne d'impact continue dans panImpactGeo.
     * Opération 100% inline — 0 allocation.
     */
    writePanImpactQuad(segmentIdx, origin, h0, n0, h1, lineHalfWidth) {
        // Direction du segment h0 → h1
        const sdx = h1.x - h0.x;
        const sdy = h1.y - h0.y;
        const sdz = h1.z - h0.z;
        const sdLen = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz);
        if (sdLen < 0.001) return false;
        const sdInv = 1.0 / sdLen;
        const sdNx = sdx * sdInv;
        const sdNy = sdy * sdInv;
        const sdNz = sdz * sdInv;

        // Vecteur perpendiculaire dans le plan d'impact : cross(sd, n0)
        const svx = sdNy * n0.z - sdNz * n0.y;
        const svy = sdNz * n0.x - sdNx * n0.z;
        const svz = sdNx * n0.y - sdNy * n0.x;
        const svLenSq = svx * svx + svy * svy + svz * svz;
        if (svLenSq < 1e-6) return false;
        const svInv = 1.0 / Math.sqrt(svLenSq);
        const svNx = svx * svInv;
        const svNy = svy * svInv;
        const svNz = svz * svInv;

        // Milieu du segment pour la divergence
        const midX = (h0.x + h1.x) * 0.5 - origin.x;
        const midY = (h0.y + h1.y) * 0.5 - origin.y;
        const midZ = (h0.z + h1.z) * 0.5 - origin.z;
        const midDist = Math.sqrt(midX * midX + midY * midY + midZ * midZ);
        const divFact = 1.0 + (midDist * 0.008) * BEAM_DIVERGENCE;
        const hw = lineHalfWidth * divFact;

        // Points C1, C2 décalés de la normale de surface
        const c1x = h0.x + n0.x * 0.012;
        const c1y = h0.y + n0.y * 0.012;
        const c1z = h0.z + n0.z * 0.012;
        const c2x = h1.x + n0.x * 0.012;
        const c2y = h1.y + n0.y * 0.012;
        const c2z = h1.z + n0.z * 0.012;

        const qi = segmentIdx * 12;
        const arr = this.panImpactPositions;

        arr[qi + 0]  = c1x - svNx * hw;  arr[qi + 1]  = c1y - svNy * hw;  arr[qi + 2]  = c1z - svNz * hw;
        arr[qi + 3]  = c1x + svNx * hw;  arr[qi + 4]  = c1y + svNy * hw;  arr[qi + 5]  = c1z + svNz * hw;
        arr[qi + 6]  = c2x - svNx * hw;  arr[qi + 7]  = c2y - svNy * hw;  arr[qi + 8]  = c2z - svNz * hw;
        arr[qi + 9]  = c2x + svNx * hw;  arr[qi + 10] = c2y + svNy * hw;  arr[qi + 11] = c2z + svNz * hw;
        return true;
    }

    /**
     * Marque les attributs modifiés et applique les drawRanges.
     */
    finalizeFrame(globalBeamCount, globalFanSegmentCount) {
        this.beamGeo.attributes.position.needsUpdate  = true;
        this.beamGeo.attributes.aOrigin.needsUpdate   = true;
        this.beamGeo.attributes.aHitPoint.needsUpdate = true;
        this.beamGeo.setDrawRange(0, globalBeamCount * 6);

        this.impactGeo.attributes.position.needsUpdate = true;
        this.impactGeo.setDrawRange(0, globalBeamCount * 6);

        this.panImpactGeo.attributes.position.needsUpdate = true;
        this.panImpactGeo.setDrawRange(0, globalFanSegmentCount * 6);
    }
}
