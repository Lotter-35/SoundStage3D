/**
 * modelDropLoader.js — Glisser-déposer de modèles 3D dans la fenêtre
 * ─────────────────────────────────────────────────────────────────────────────
 * Importe à la volée n'importe quel modèle 3D glissé-déposé dans le navigateur (.glb, .gltf, .obj, .fbx)
 * et le fait spawner directement devant le joueur/caméra.
 *
 * Permet de sélectionner les modèles déposés par clic, de les manipuler avec un Gizmo 3D (TransformControls),
 * et de basculer de mode avec les raccourcis 'G' (déplacer) et 'R' (pivoter).
 *
 * Aucun texte ni menu UI n'est ajouté.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { installGizmoSnap } from '../ui/gizmoSnap.js';

let _isInitialized = false;
const _mixers = [];
const _clock = new THREE.Clock();
let _animating = false;

let _scene = null;
let _camera = null;
let _renderer = null;
let _listener = null;
let _transformControls = null;

const _droppedModels = [];
let _selectedModel = null;
let _isDraggingGizmo = false;
let _dragEndTime = 0;
let _lastModelPick = 0;

const _raycaster = new THREE.Raycaster();
const _mouse = new THREE.Vector2();

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
 * Sélectionne un modèle 3D déposé et active son gizmo
 * @param {THREE.Object3D} model
 */
export function selectDroppedModel(model) {
    if (!model) {
        deselectDroppedModel();
        return;
    }
    _selectedModel = model;
    _lastModelPick = performance.now();

    if (_transformControls) {
        _transformControls.attach(model);
        _transformControls.visible = true;
        _transformControls.enabled = true;
    }

    // Déverrouille le curseur pour permettre la manipulation immédiate
    if (_listener && _listener.controls && _listener.controls.isLocked) {
        _listener.unlock();
    }
}

/**
 * Désélectionne le modèle actuellement sélectionné et masque le gizmo
 */
export function deselectDroppedModel() {
    if (!_selectedModel) return;
    _selectedModel = null;
    if (_transformControls) {
        _transformControls.detach();
        _transformControls.visible = false;
        _transformControls.enabled = false;
    }
}

/** Vrai si le gizmo est en cours de manipulation */
export function isModelGizmoDragging() {
    return Boolean(_isDraggingGizmo || (_transformControls && _transformControls.dragging));
}

/** Vrai (une seule fois) si le dernier clic vient de sélectionner un modèle déposé */
export function consumeModelPick() {
    const picked = performance.now() - (_lastModelPick || -1e9) < 2000;
    _lastModelPick = 0;
    return picked;
}

/** Vrai si le modèle est sélectionné ou le gizmo actif pour garder le curseur de souris libre */
export function shouldKeepCursorForModel() {
    if (_isDraggingGizmo) return true;
    if (performance.now() - (_dragEndTime || 0) < 400) return true;
    if (!_transformControls) return false;
    return Boolean(_transformControls.dragging || _transformControls.axis !== null || _selectedModel);
}

/**
 * Initialise le gizmo 3D et ses écouteurs
 */
function _initGizmo(scene, camera, domElement) {
    if (_transformControls) return;

    _transformControls = new TransformControls(camera, domElement);
    _transformControls.size = 0.85;
    _transformControls.setMode('translate');
    _transformControls.visible = false;
    _transformControls.enabled = false;
    scene.add(_transformControls);

    // Aimantation (Shift enfoncé : pas de 0.25m et rotation par 15°)
    installGizmoSnap(_transformControls, () => ({ grid: 0.25, angle: 15 }));

    _transformControls.addEventListener('dragging-changed', (event) => {
        _isDraggingGizmo = Boolean(event.value);
        if (!event.value) {
            _dragEndTime = performance.now();
        }
        if (_listener && _listener.controls) {
            if (event.value) {
                _listener.resetMovement?.();
                _listener.controls.enabled = false;
            } else {
                _listener.controls.enabled = true;
            }
        }
    });

    // Clic pour sélectionner un modèle déposé ou désélectionner
    domElement.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return; // Clic gauche seulement

        // Si le gizmo est déjà survolé ou manipulé, laisser TransformControls gérer
        if (_transformControls && (_transformControls.dragging || _transformControls.axis !== null)) {
            return;
        }

        // Si la souris est verrouillée en vue FPS, ignorer la sélection
        if (_listener && _listener.controls && _listener.controls.isLocked) return;

        // Si un drag de gizmo vient de se terminer, ne pas interpréter comme un clic
        if (performance.now() - (_dragEndTime || 0) < 120) return;

        const rect = domElement.getBoundingClientRect();
        _mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        _mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        _raycaster.setFromCamera(_mouse, camera);

        // Collecter les meshes des modèles déposés actifs
        const meshes = [];
        for (const m of _droppedModels) {
            if (!m.parent) continue;
            m.traverse((child) => {
                if (child.isMesh && child.visible) {
                    meshes.push(child);
                }
            });
        }

        if (meshes.length === 0) {
            if (_selectedModel) deselectDroppedModel();
            return;
        }

        const hits = _raycaster.intersectObjects(meshes, false);
        if (hits.length > 0) {
            let hit = hits[0].object;
            while (hit && hit.parent && hit.parent !== scene && !hit.userData?.isDroppedModel) {
                hit = hit.parent;
            }
            if (hit && hit.userData?.isDroppedModel) {
                selectDroppedModel(hit);
                return;
            }
        }

        // Clic dans le vide : désélectionner le modèle
        if (_selectedModel) {
            deselectDroppedModel();
        }
    });

    // Raccourcis clavier : G (translate), R (rotate), Échap (désélectionner)
    window.addEventListener('keydown', (e) => {
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        if (e.key === 'Escape') {
            if (_selectedModel) {
                deselectDroppedModel();
                return;
            }
        }

        if (!_selectedModel || !_transformControls) return;

        if (e.key === 'g' || e.key === 'G') {
            _transformControls.setMode('translate');
        } else if (e.key === 'r' || e.key === 'R') {
            _transformControls.setMode('rotate');
        }
    });
}

/**
 * Initialise les écouteurs de glisser-déposer sur la fenêtre
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {THREE.Camera} options.camera
 * @param {THREE.WebGLRenderer} [options.renderer]
 * @param {object} [options.listener]
 */
export function initModelDropLoader({ scene, camera, renderer, listener }) {
    if (_isInitialized) return;
    _isInitialized = true;

    _scene = scene;
    _camera = camera;
    _renderer = renderer;
    _listener = listener;

    const domElement = renderer?.domElement || window;
    _initGizmo(scene, camera, domElement);

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

                // Conteneur racine avec pivot exactement au centre géométrique du modèle
                const modelRoot = new THREE.Group();
                modelRoot.name = `dropped-model-${file.name}-${Date.now()}`;
                modelRoot.userData.isDroppedModel = true;
                modelRoot.userData.modelName = file.name;

                // Centrage exact du modèle au sein de modelRoot
                const centerOffset = center.clone().sub(rootObject.position);
                rootObject.position.sub(centerOffset);
                modelRoot.add(rootObject);

                modelRoot.position.copy(targetPos);
                modelRoot.rotation.y = Math.atan2(camera.position.x - targetPos.x, camera.position.z - targetPos.z);

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
                scene.add(modelRoot);
                _droppedModels.push(modelRoot);

                // Sélectionner immédiatement le modèle pour afficher le gizmo
                selectDroppedModel(modelRoot);

                console.log('[ModelDropLoader] Modèle 3D spawné avec succès devant le joueur :', {
                    nom: file.name,
                    tailleFichier: (file.size / (1024 * 1024)).toFixed(2) + ' Mo',
                    dimensions: {
                        largeurX: +size.x.toFixed(2),
                        hauteurY: +size.y.toFixed(2),
                        profondeurZ: +size.z.toFixed(2)
                    },
                    position: {
                        x: +modelRoot.position.x.toFixed(2),
                        y: +modelRoot.position.y.toFixed(2),
                        z: +modelRoot.position.z.toFixed(2)
                    },
                    animations: animations.length
                });

            } catch (err) {
                console.error('[ModelDropLoader] Erreur lors du chargement du fichier glissé-déposé :', file.name, err);
            }
        }
    }, false);
}
