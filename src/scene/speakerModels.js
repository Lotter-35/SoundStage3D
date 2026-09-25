/**
 * speakerModels.js — Chargement et instanciation des modèles 3D réels d'enceintes de scène :
 * - Subwoofers (subwoofer.glb) : tournés de 90° sur X, empilés par 2 par position, le long du nez de scène
 * - Line Arrays (line-array.glb) : grappes suspendues à gauche et à droite orientées vers le public
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadStageSpeakers(scene) {
    const stageSpeakersGroup = new THREE.Group();
    stageSpeakersGroup.name = 'stage-speakers-group';
    scene.add(stageSpeakersGroup);

    const gltfLoader = new GLTFLoader();
    const cacheBust = Date.now();

    // ─────────────────────────────────────────────────────────────────
    // 1. SUBWOOFERS (subwoofer.glb)
    // ─────────────────────────────────────────────────────────────────
    try {
        const gltfSub = await gltfLoader.loadAsync(`src/assets/models/subwoofer.glb?t=${cacheBust}`);
        const subTemplate = gltfSub.scene;

        // Préparation des matériaux et ombres
        subTemplate.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                if (child.material) {
                    // Correction cruciale : désactiver la transmission de Blender qui rendait le caisson transparent
                    if ('transmission' in child.material) {
                        child.material.transmission = 0;
                    }
                    child.material.transparent = false;
                    child.material.opacity = 1.0;
                    child.material.roughness = 0.75;
                    child.material.metalness = 0.15;
                    if (child.material.map) {
                        child.material.map.colorSpace = THREE.SRGBColorSpace;
                        child.material.needsUpdate = true;
                    }
                    if (child.material.normalMap) {
                        child.material.normalMap.colorSpace = THREE.LinearSRGBColorSpace;
                    }
                    child.material.needsUpdate = true;
                }
            }
        });

        // Échelle du subwoofer pour correspondre aux dimensions réalistes d'un double 18" de festival (~1.8m de large, ~0.74m de haut)
        const subScale = 1.35;
        subTemplate.scale.setScalar(subScale);

        // Rotation de 90° sur X pour orienter la face avec les haut-parleurs vers le public (+Z)
        subTemplate.rotation.x = Math.PI / 2;

        // Calcul précis de la boîte englobante après rotation et échelle
        const subBox = new THREE.Box3().setFromObject(subTemplate);
        const subSize = new THREE.Vector3();
        subBox.getSize(subSize);

        // Décalages géométriques pour l'alignement au sol et contre la scène
        const groundOffsetY = -subBox.min.y; // Hauteur du centre du premier caisson pour que le bas soit à y = 0
        const subHeight = subSize.y;         // Hauteur unitaire d'un caisson (~0.74m)
        const backAlignZ = -subBox.min.z;    // Z du centre pour que l'arrière du caisson soit aligné avec le bord avant de la scène (z = 0)

        // 7 positions de subwoofers au sol (identiques à SUB_DEFS dans speakers.js : -9, -6, -3, 0, 3, 6, 9)
        const subXPositions = [-9, -6, -3, 0, 3, 6, 9];

        for (const xPos of subXPositions) {
            // Pile de 3 caissons superposés
            for (let stackIndex = 0; stackIndex < 3; stackIndex++) {
                const subClone = subTemplate.clone(true);
                const posY = groundOffsetY + stackIndex * subHeight;
                subClone.position.set(xPos, posY, backAlignZ);
                stageSpeakersGroup.add(subClone);
            }
        }

        console.log(`[StageSpeakers] 7 piles de 3 subwoofers chargées (21 caissons), hauteur totale : ${(subHeight * 3).toFixed(2)}m`);
    } catch (err) {
        console.error('[StageSpeakers] Erreur lors du chargement de subwoofer.glb :', err);
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. LINE ARRAYS (line-array.glb)
    // ─────────────────────────────────────────────────────────────────
    try {
        const gltfArray = await gltfLoader.loadAsync(`src/assets/models/line-array.glb?t=${cacheBust}`);
        const arrayTemplate = gltfArray.scene;

        // Préparation des matériaux et ombres
        arrayTemplate.traverse(child => {
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
                        child.material.needsUpdate = true;
                    }
                    if (child.material.normalMap) {
                        child.material.normalMap.colorSpace = THREE.LinearSRGBColorSpace;
                    }
                    child.material.needsUpdate = true;
                }
            }
        });

        // Échelle pour une grappe complète de festival (~3.8m de haut)
        const arrayScale = 1.35;
        arrayTemplate.scale.setScalar(arrayScale);

        // Positions et orientations des 2 grappes suspendues
        const arrayConfigs = [
            {
                name: 'line-array-left',
                x: -12,
                y: 8,
                z: 0,
                yaw: 0.18,   // Légère rotation vers l'intérieur (centre du public)
                tilt: -0.08, // Légère inclinaison vers le bas (arrosage de la fosse)
            },
            {
                name: 'line-array-right',
                x: 12,
                y: 8,
                z: 0,
                yaw: -0.18,  // Légère rotation vers l'intérieur (centre du public)
                tilt: -0.08, // Légère inclinaison vers le bas (arrosage de la fosse)
            }
        ];

        for (const config of arrayConfigs) {
            const arrayClone = arrayTemplate.clone(true);
            arrayClone.name = config.name;
            arrayClone.position.set(config.x, config.y, config.z);
            arrayClone.rotation.y = config.yaw;
            arrayClone.rotation.x = config.tilt;
            stageSpeakersGroup.add(arrayClone);
        }

        console.log('[StageSpeakers] Grappes Line Array gauche et droite chargées et suspendues avec succès');
    } catch (err) {
        console.error('[StageSpeakers] Erreur lors du chargement de line-array.glb :', err);
    }

    return stageSpeakersGroup;
}
