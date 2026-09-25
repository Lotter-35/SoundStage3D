/**
 * modelDropLoader.js — Glisser-déposer de modèles 3D dans la fenêtre
 * ─────────────────────────────────────────────────────────────────────────────
 * Importe à la volée n'importe quel modèle 3D glissé-déposé dans le navigateur (.glb, .gltf, .obj, .fbx)
 * et le fait spawner directement devant le joueur/caméra.
 *
 * Mode debug silencieux : aucun texte, overlay ou UI à l'écran, logs uniquement en console.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

let _isInitialized = false;
const _mixers = [];
const _clock = new THREE.Clock();
let _animating = false;

function _ensureAnimationLoop() {
    if (_animating) return;
    _animating = true;

    function _tick() {
        requestAnimationFrame(_tick);
        if (_mixers.length === 0) return;
        const delta = _clock.getDelta();
        for (let i = 0; i < _mixers.length; i++) {
            _mixers[i].update(delta);
        }
    }
    _tick();
}

/**
 * Détecte si un fichier est un modèle 3D supporté
 * @param {File} file
 * @returns {boolean}
 */
function is3DModel(file) {
    if (!file || !file.name) return false;
    const name = file.name.toLowerCase();
    return name.endsWith('.glb') || name.endsWith('.gltf') || name.endsWith('.obj') || name.endsWith('.fbx');
}

/**
 * Initialise les écouteurs de glisser-déposer sur la fenêtre
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {THREE.Camera} options.camera
 */
export function initModelDropLoader({ scene, camera }) {
    if (_isInitialized) return;
    _isInitialized = true;

    // Configuration des loaders
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
    const gltfLoader = new GLTFLoader();
    gltfLoader.setDRACOLoader(dracoLoader);
    const objLoader = new OBJLoader();

    // Empêcher l'ouverture du fichier dans le navigateur lors du survol
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'copy';
        }
    }, false);

    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
    }, false);

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
    }, false);

    // Dépôt de fichier
    window.addEventListener('drop', async (e) => {
        const files = e.dataTransfer?.files;
        if (!files || files.length === 0) return;

        // Si le fichier est un audio et a été déposé sur la playlist, laisser PlaybackUI s'en charger
        const target = e.target;
        if (target && target.closest && target.closest('#pb-playlist-list, #playback-panel')) {
            const hasAudio = Array.from(files).some(f => f.type?.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a)$/i.test(f.name));
            if (hasAudio) return;
        }

        e.preventDefault();
        e.stopPropagation();

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            // Vérification de l'extension ou des magic bytes GLB
            const isModelExt = is3DModel(file);
            let isGlbMagic = false;

            if (!isModelExt && file.size >= 12) {
                try {
                    const slice = await file.slice(0, 4).arrayBuffer();
                    const view = new DataView(slice);
                    isGlbMagic = (view.getUint32(0, false) === 0x676C5446); // 'glTF'
                } catch (_) {}
            }

            if (!isModelExt && !isGlbMagic) continue;

            try {
                const arrayBuffer = await file.arrayBuffer();
                const fileNameLower = file.name.toLowerCase();

                let rootObject = null;
                let animations = [];

                if (fileNameLower.endsWith('.obj')) {
                    // Chargement OBJ
                    const text = new TextDecoder().decode(arrayBuffer);
                    rootObject = objLoader.parse(text);
                } else if (fileNameLower.endsWith('.fbx')) {
                    // Chargement FBX
                    try {
                        const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
                        const fbxLoader = new FBXLoader();
                        rootObject = fbxLoader.parse(arrayBuffer, '');
                        if (rootObject.animations) animations = rootObject.animations;
                    } catch (fbxErr) {
                        console.error('[ModelDropLoader] Erreur FBXLoader :', fbxErr);
                    }
                } else {
                    // Chargement GLB / GLTF (défaut)
                    const gltf = await new Promise((resolve, reject) => {
                        gltfLoader.parse(arrayBuffer, '', resolve, reject);
                    });
                    rootObject = gltf.scene || gltf.scenes?.[0];
                    if (gltf.animations) animations = gltf.animations;
                }

                if (!rootObject) {
                    console.warn('[ModelDropLoader] Aucun objet 3D extrait du fichier :', file.name);
                    continue;
                }

                // Configuration ombres et matériaux
                rootObject.traverse(child => {
                    if (child.isMesh) {
                        child.castShadow = true;
                        child.receiveShadow = true;
                        if (child.material) {
                            if ('transmission' in child.material) {
                                child.material.transmission = 0;
                            }
                            child.material.transparent = false;
                            child.material.opacity = 1.0;
                            if (child.material.map) {
                                child.material.map.colorSpace = THREE.SRGBColorSpace;
                            }
                            child.material.needsUpdate = true;
                        }
                    }
                });

                // Calcul de la boîte englobante pour un placement idéal devant le joueur
                rootObject.updateMatrixWorld(true);
                const box = new THREE.Box3().setFromObject(rootObject);
                const size = new THREE.Vector3();
                box.getSize(size);
                const center = new THREE.Vector3();
                box.getCenter(center);

                // Vecteur directionnel devant la caméra
                const forward = new THREE.Vector3();
                camera.getWorldDirection(forward);

                // Distance de spawn adaptée à la taille du modèle (entre 3m et 15m)
                const maxDim = Math.max(size.x, size.y, size.z);
                const spawnDistance = Math.max(3.0, Math.min(15.0, (maxDim > 0 ? maxDim * 1.4 : 3.5)));

                const targetPos = new THREE.Vector3()
                    .copy(camera.position)
                    .addScaledVector(forward, spawnDistance);

                // Centrage exact du modèle au point de spawn (corrige les éventuels offsets de Blender)
                const centerOffset = center.clone().sub(rootObject.position);
                rootObject.position.copy(targetPos).sub(centerOffset);

                // Faire pivoter le modèle pour qu'il fasse face au joueur
                rootObject.rotation.y = Math.atan2(camera.position.x - targetPos.x, camera.position.z - targetPos.z);

                // Gestion des animations si présentes
                if (animations && animations.length > 0) {
                    const mixer = new THREE.AnimationMixer(rootObject);
                    animations.forEach(clip => {
                        mixer.clipAction(clip).play();
                    });
                    _mixers.push(mixer);
                    _ensureAnimationLoop();
                }

                // Ajout à la scène
                rootObject.name = `dropped-model-${file.name}-${Date.now()}`;
                scene.add(rootObject);

                console.log('[ModelDropLoader] Modèle 3D spawné avec succès devant le joueur :', {
                    nom: file.name,
                    tailleFichier: (file.size / (1024 * 1024)).toFixed(2) + ' Mo',
                    dimensions: {
                        largeurX: +size.x.toFixed(2),
                        hauteurY: +size.y.toFixed(2),
                        profondeurZ: +size.z.toFixed(2)
                    },
                    position: {
                        x: +rootObject.position.x.toFixed(2),
                        y: +rootObject.position.y.toFixed(2),
                        z: +rootObject.position.z.toFixed(2)
                    },
                    animations: animations.length
                });

            } catch (err) {
                console.error('[ModelDropLoader] Erreur lors du chargement du fichier glissé-déposé :', file.name, err);
            }
        }
    }, false);
}
