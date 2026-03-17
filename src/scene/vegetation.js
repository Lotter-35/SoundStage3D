/**
 * Vegetation — Instanced grass patches around the camera.
 * Uses a SINGLE InstancedMesh per sub-mesh (constant draw calls regardless of chunk size).
 * A spatial position grid is queried each time the camera moves to update the batch.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const GRASS_URL = 'src/assets/models/grass.glb';
const GROUND_HALF = 190;
const SPACING = 2;            // metres between grass patches
const JITTER = 0.3;
const GRASS_SCALE = 0.15;
const CHUNK_SIZE = 8;         // spatial index resolution (smaller = smoother circle edge)
const VIEW_RADIUS = 60;       // visible radius around camera
const MAX_VISIBLE = 3200;     // max instances in the single batch (sized for π*60²/2²)

function isStageZone(x, z) {
    return false; // no exclusion — grass everywhere including under the stage
}

/** Spatial grid: Map<"ix,iz", Array<{x,z,rotY}>> */
let posGrid = null;
/** Single InstancedMesh per GLB sub-mesh */
let batchMeshes = [];
let _yOffset = 0;
const _dummy = new THREE.Object3D();
const _lastPos = new THREE.Vector2(Infinity, Infinity);
const MOVE_THRESHOLD2 = (CHUNK_SIZE * 0.5) ** 2;

export async function createVegetation(scene) {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(GRASS_URL);
    const root = gltf.scene;

    const meshes = [];
    root.traverse(child => { if (child.isMesh) meshes.push(child); });
    if (meshes.length === 0) return;

    root.updateMatrixWorld(true);
    for (const m of meshes) m.geometry.applyMatrix4(m.matrixWorld);

    const bbox = new THREE.Box3();
    for (const m of meshes) {
        m.geometry.computeBoundingBox();
        bbox.union(m.geometry.boundingBox);
    }
    _yOffset = -bbox.min.y;

    // Build spatial position grid (pure data, no Three.js objects)
    posGrid = new Map();
    for (let cx = -GROUND_HALF; cx < GROUND_HALF; cx += CHUNK_SIZE) {
        for (let cz = -GROUND_HALF; cz < GROUND_HALF; cz += CHUNK_SIZE) {
            const positions = [];
            for (let gx = cx; gx < cx + CHUNK_SIZE; gx += SPACING) {
                for (let gz = cz; gz < cz + CHUNK_SIZE; gz += SPACING) {
                    const x = gx + (Math.random() - 0.5) * JITTER * 2;
                    const z = gz + (Math.random() - 0.5) * JITTER * 2;
                    if (isStageZone(x, z)) continue;
                    positions.push({ x, z, rotY: Math.random() * Math.PI * 2 });
                }
            }
            if (positions.length === 0) continue;
            const ix = Math.round((cx + CHUNK_SIZE / 2) / CHUNK_SIZE);
            const iz = Math.round((cz + CHUNK_SIZE / 2) / CHUNK_SIZE);
            posGrid.set(`${ix},${iz}`, positions);
        }
    }

    // ONE InstancedMesh per GLB sub-mesh — constant draw calls forever
    for (const srcMesh of meshes) {
        const instanced = new THREE.InstancedMesh(
            srcMesh.geometry, srcMesh.material.clone(), MAX_VISIBLE);
        instanced.count = 0;
        instanced.material.side = THREE.DoubleSide;
        instanced.castShadow = false;
        instanced.receiveShadow = true;
        scene.add(instanced);
        batchMeshes.push(instanced);
    }
}

/**
 * Refresh the batch when the camera moves. O(visible chunks) work, constant draw calls.
 * @param {THREE.Camera} camera
 */
export function updateVegetation(camera) {
    if (!posGrid) return;
    const px = camera.position.x;
    const pz = camera.position.z;

    const ddx = px - _lastPos.x;
    const ddz = pz - _lastPos.y;
    if (ddx * ddx + ddz * ddz < MOVE_THRESHOLD2) return;
    _lastPos.set(px, pz);

    // Collect all positions within VIEW_RADIUS — test each grass position individually
    const r2 = VIEW_RADIUS * VIEW_RADIUS;
    const halfG = Math.ceil(VIEW_RADIUS / CHUNK_SIZE) + 1;
    const originX = Math.round(px / CHUNK_SIZE);
    const originZ = Math.round(pz / CHUNK_SIZE);

    const visible = [];
    for (let dx = -halfG; dx <= halfG; dx++) {
        for (let dz = -halfG; dz <= halfG; dz++) {
            const positions = posGrid.get(`${originX + dx},${originZ + dz}`);
            if (!positions) continue;
            for (const p of positions) {
                if (visible.length >= MAX_VISIBLE) break;
                // Per-position circle test → perfect circle edge
                const ex = p.x - px, ez = p.z - pz;
                if (ex * ex + ez * ez < r2) visible.push(p);
            }
        }
    }

    const count = visible.length;
    for (const instanced of batchMeshes) {
        for (let i = 0; i < count; i++) {
            const p = visible[i];
            _dummy.position.set(p.x, _yOffset * GRASS_SCALE, p.z);
            _dummy.rotation.set(0, p.rotY, 0);
            _dummy.scale.setScalar(GRASS_SCALE);
            _dummy.updateMatrix();
            instanced.setMatrixAt(i, _dummy.matrix);
        }
        instanced.count = count;
        instanced.instanceMatrix.needsUpdate = true;
    }
}
