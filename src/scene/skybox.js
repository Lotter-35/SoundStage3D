/**
 * Skybox — Charge le modèle GLB skybox et l'intègre dans la scène.
 *
 * Le GLB de Sketchfab utilise KHR_materials_pbrSpecularGlossiness (déprécié).
 * On extrait manuellement la texture et on crée une sphère MeshBasicMaterial
 * pour un rendu fiable sur toutes les versions de Three.js.
 */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as THREE from 'three';

const SKYBOX_PATH = './src/assets/skybox/sky_basic.glb';
const SKY_RADIUS  = 900; // doit être < camera far (1000)

/**
 * Charge la skybox GLB et l'ajoute à la scène.
 * @param {THREE.Scene} scene
 * @returns {Promise<THREE.Object3D>} — la skybox (null si échec)
 */
export async function createSkybox(scene) {
    return new Promise((resolve) => {
        const loader = new GLTFLoader();
        loader.load(
            SKYBOX_PATH,
            (gltf) => {
                // Extraire la première texture trouvée dans le GLB
                let texture = null;
                gltf.scene.traverse((child) => {
                    if (!texture && child.isMesh && child.material) {
                        // Chercher la texture dans les propriétés courantes
                        texture = child.material.map
                              || child.material.emissiveMap
                              || (child.material.userData?.gltfExtensions
                                    ?.KHR_materials_pbrSpecularGlossiness?.diffuseTexture);
                    }
                });

                // Fallback : parcourir les textures du parser
                if (!texture && gltf.parser) {
                    // Les textures sont déjà parsées dans le cache
                    const textures = gltf.parser.json?.textures;
                    if (textures?.length && gltf.parser.associations) {
                        // Parcourir les meshes pour trouver une texture
                        gltf.scene.traverse((child) => {
                            if (!texture && child.isMesh && child.material) {
                                const mat = child.material;
                                // Inspecter toutes les propriétés qui pourraient contenir une texture
                                for (const key of Object.keys(mat)) {
                                    if (mat[key] && mat[key].isTexture) {
                                        texture = mat[key];
                                        break;
                                    }
                                }
                            }
                        });
                    }
                }

                if (!texture) {
                    console.warn('[Skybox] Aucune texture trouvée dans le GLB, fallback couleur.');
                    resolve(null);
                    return;
                }

                // Créer une sphère inversée avec MeshBasicMaterial (ignorer les lumières)
                const geo = new THREE.SphereGeometry(SKY_RADIUS, 64, 32);
                const mat = new THREE.MeshBasicMaterial({
                    map: texture,
                    side: THREE.BackSide,
                    depthWrite: false,
                    fog: false,
                });
                const skyMesh = new THREE.Mesh(geo, mat);
                skyMesh.renderOrder = -1;
                skyMesh.frustumCulled = false;

                // Rotation Y calée visuellement pour aligner le soleil avec la lumière directionnelle
                skyMesh.rotation.y = -1.75;

                scene.add(skyMesh);
                scene.background = null;
                console.log('[Skybox] GLB texture extraite et skybox créée ✓');
                resolve(skyMesh);
            },
            undefined,
            (err) => {
                console.warn('[Skybox] Échec du chargement GLB, fallback couleur.', err);
                resolve(null);
            }
        );
    });
}

/**
 * Synchronise la position de la skybox avec la caméra (à appeler chaque frame).
 * @param {THREE.Object3D} skybox
 * @param {THREE.Camera}   camera
 */
export function updateSkybox(skybox, camera) {
    if (!skybox) return;
    skybox.position.copy(camera.position);
}

/**
 * @deprecated — debug uniquement, ne pas appeler en production.
 * Panneau conservé pour référence future.
 */
function _createSkyboxDebugPanel_unused(skybox) {
    if (!skybox) return;

    const panel = document.createElement('div');
    panel.id = 'skybox-debug';
    panel.style.cssText = `
        position: fixed; bottom: 80px; left: 16px; z-index: 9999;
        background: rgba(0,0,0,0.75); color: #fff; padding: 10px 14px;
        border-radius: 8px; font: 13px monospace; min-width: 240px;
        border: 1px solid rgba(255,255,255,0.2);
    `;
    panel.innerHTML = `<div style="margin-bottom:6px;font-weight:bold;color:#adf">☀ Skybox Debug</div>`;

    const axes = [
        { label: 'Rotation Y (azimut)',  prop: 'y', min: -3.15, max: 3.15, step: 0.01 },
        { label: 'Rotation X (élévation)', prop: 'x', min: -1.57, max: 1.57, step: 0.01 },
        { label: 'Rotation Z (roulis)',  prop: 'z', min: -1.57, max: 1.57, step: 0.01 },
    ];

    for (const ax of axes) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;';

        const lbl = document.createElement('span');
        lbl.style.cssText = 'flex:1;font-size:11px;color:#ccc;';
        lbl.textContent = ax.label;

        const val = document.createElement('span');
        val.style.cssText = 'width:42px;text-align:right;color:#ff9;font-size:12px;';
        val.textContent = skybox.rotation[ax.prop].toFixed(2);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = ax.min;
        slider.max = ax.max;
        slider.step = ax.step;
        slider.value = skybox.rotation[ax.prop];
        slider.style.cssText = 'width:100px;accent-color:#adf;';

        slider.addEventListener('input', () => {
            skybox.rotation[ax.prop] = parseFloat(slider.value);
            val.textContent = parseFloat(slider.value).toFixed(2);
        });

        row.append(lbl, slider, val);
        panel.appendChild(row);
    }

    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:8px;font-size:10px;color:#888;';
    hint.textContent = 'Copie les valeurs → skybox.js pour fixer';
    panel.appendChild(hint);

    document.body.appendChild(panel);
}
