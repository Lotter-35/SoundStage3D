/**
 * Vegetation — Authentic 3D instanced grass system.
 * Uses the genuine 3D grass model exclusively (no flat cardboard/star quads).
 * Smooth radial distance fading seamlessly blends grass into the ground texture.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const GRASS_URL = 'src/assets/models/grass.glb';
const GROUND_HALF = 190;
const SPACING = 2.4;           // distance between patches in metres
const JITTER = 0.4;
const GRASS_SCALE = 0.17;      // slightly larger tufts for dense, natural coverage
const CHUNK_SIZE = 8;

// Distance settings (default OFF for maximum performance on startup)
let VIEW_RADIUS = 0;           // visible radius around camera (metres)
let FADE_START = 0;            // distance at which grass smoothly shrinks into ground texture
let MAX_VISIBLE = 0;           // max instances

function isStageZone(x, z) {
    // Exclude grass from growing inside/under the main stage platform
    return x >= -16 && x <= 16 && z >= -11 && z <= 2;
}

/** Spatial grid: Map<"ix,iz", Array<{x,z,rotY}>> */
let posGrid = null;
let batchMeshes = [];

let _yOffset = 0;
const _dummy = new THREE.Object3D();
const _lastPos = new THREE.Vector2(Infinity, Infinity);
const MOVE_THRESHOLD2 = 2.0 ** 2; // update batch when moved > 2m

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

    // Build spatial position grid
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

    // Single InstancedMesh per GLB sub-mesh — 100% genuine 3D model
    for (const srcMesh of meshes) {
        const mat = srcMesh.material.clone();
        mat.side = THREE.DoubleSide;
        mat.alphaTest = 0.4;
        mat.depthWrite = true;

        const instanced = new THREE.InstancedMesh(srcMesh.geometry, mat, 1200);
        instanced.count = 0;
        instanced.visible = false; // Default OFF: completely skipped by Three.js renderer
        instanced.castShadow = false;
        instanced.receiveShadow = false; // massive fill-rate boost
        scene.add(instanced);
        batchMeshes.push(instanced);
    }
}

/**
 * Change grass density and view distance quality.
 * @param {'high'|'medium'|'low'|'off'} quality
 */
export function setGrassQuality(quality) {
    if (quality === 'off') {
        VIEW_RADIUS = 0;
        FADE_START = 0;
        MAX_VISIBLE = 0;
        for (const m of batchMeshes) {
            m.count = 0;
            m.visible = false;
        }
    } else {
        for (const m of batchMeshes) {
            m.visible = true;
        }
        if (quality === 'low') {
            VIEW_RADIUS = 16;
            FADE_START = 10;
            MAX_VISIBLE = 200;
        } else if (quality === 'medium') {
            VIEW_RADIUS = 26;
            FADE_START = 18;
            MAX_VISIBLE = 450;
        } else if (quality === 'high') {
            VIEW_RADIUS = 34;
            FADE_START = 24;
            MAX_VISIBLE = 750;
        }
    }

    _lastPos.set(Infinity, Infinity);
}

/**
 * Refresh grass batch with smooth radial fade.
 * @param {THREE.Camera} camera
 */
export function updateVegetation(camera) {
    if (!posGrid || batchMeshes.length === 0) return;
    if (VIEW_RADIUS <= 0) {
        for (const m of batchMeshes) {
            if (m.visible) m.visible = false;
        }
        return;
    }

    const px = camera.position.x;
    const pz = camera.position.z;

    const ddx = px - _lastPos.x;
    const ddz = pz - _lastPos.y;
    if (ddx * ddx + ddz * ddz < MOVE_THRESHOLD2) return;
    _lastPos.set(px, pz);

    const halfG = Math.ceil(VIEW_RADIUS / CHUNK_SIZE) + 1;
    const originX = Math.round(px / CHUNK_SIZE);
    const originZ = Math.round(pz / CHUNK_SIZE);
    const r2 = VIEW_RADIUS * VIEW_RADIUS;

    const visible = [];
    for (let dx = -halfG; dx <= halfG; dx++) {
        for (let dz = -halfG; dz <= halfG; dz++) {
            const positions = posGrid.get(`${originX + dx},${originZ + dz}`);
            if (!positions) continue;
            for (const p of positions) {
                if (visible.length >= MAX_VISIBLE) break;
                const ex = p.x - px, ez = p.z - pz;
                const dist2 = ex * ex + ez * ez;
                if (dist2 < r2) {
                    visible.push({ ...p, dist: Math.sqrt(dist2) });
                }
            }
        }
    }

    const count = visible.length;
    for (const instanced of batchMeshes) {
        for (let i = 0; i < count; i++) {
            const p = visible[i];

            // Smooth scale fade at the outer perimeter
            let scale = GRASS_SCALE;
            if (p.dist > FADE_START) {
                const factor = 1 - (p.dist - FADE_START) / (VIEW_RADIUS - FADE_START);
                scale = GRASS_SCALE * Math.max(0.01, factor);
            }

            _dummy.position.set(p.x, _yOffset * scale, p.z);
            _dummy.rotation.set(0, p.rotY, 0);
            _dummy.scale.setScalar(scale);
            _dummy.updateMatrix();
            instanced.setMatrixAt(i, _dummy.matrix);
        }
        instanced.count = count;
        instanced.instanceMatrix.needsUpdate = true;
    }
}
