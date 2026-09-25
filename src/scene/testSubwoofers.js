/**
 * testSubwoofers.js — Charge et affiche les deux modèles de subwoofer (FBX et OBJ)
 * pour test visuel juste devant le spawn du joueur (FOH x=0, z=50).
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

function createTextLabel(text, borderColor = '#38bdf8') {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 75;
    const ctx = canvas.getContext('2d');

    // Fond badge semi-transparent
    ctx.fillStyle = 'rgba(10, 15, 28, 0.88)';
    if (ctx.roundRect) {
        ctx.roundRect(6, 6, 288, 63, 14);
    } else {
        ctx.rect(6, 6, 288, 63);
    }
    ctx.fill();

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Texte
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 150, 39);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 999;
    sprite.scale.set(1.3, 0.325, 1);
    return sprite;
}

export async function loadTestSubwoofers(scene) {
    const group = new THREE.Group();
    group.name = 'test-subwoofers-group';
    scene.add(group);

    // 1. Charger subwoofer.fbx
    try {
        const fbxLoader = new FBXLoader();
        const fbx = await fbxLoader.loadAsync('src/assets/models/subwoofer.fbx');
        fbx.name = 'test-subwoofer-fbx';

        // Auto-scale si nécessaire
        const fbxBox = new THREE.Box3().setFromObject(fbx);
        const fbxSize = new THREE.Vector3();
        fbxBox.getSize(fbxSize);
        if (fbxSize.y > 10) {
            fbx.scale.setScalar(0.01);
            fbxBox.setFromObject(fbx);
            fbxBox.getSize(fbxSize);
        }

        // Poser au sol à gauche du spawn joueur (Spawn joueur à x=0, z=50)
        const targetX = -1.35;
        const targetZ = 46.0;
        fbx.position.set(targetX, -fbxBox.min.y, targetZ);

        // Orienter vers le joueur pour qu'il voie directement la façade du caisson
        fbx.rotation.y = Math.PI;

        fbx.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        group.add(fbx);

        // Label au-dessus du subwoofer FBX
        const fbxLabel = createTextLabel('🔊 Subwoofer (.fbx)', '#38bdf8');
        fbxLabel.position.set(targetX, fbxSize.y + 0.35, targetZ);
        group.add(fbxLabel);

        console.log('[TestSubwoofers] subwoofer.fbx chargé avec succès, dimensions :', fbxSize);
    } catch (err) {
        console.warn('[TestSubwoofers] Erreur chargement subwoofer.fbx :', err);
    }

    // 2. Charger subwoofer.obj
    try {
        const objLoader = new OBJLoader();
        const obj = await objLoader.loadAsync('src/assets/models/subwoofer.obj');
        obj.name = 'test-subwoofer-obj';

        // Auto-scale si nécessaire
        const objBox = new THREE.Box3().setFromObject(obj);
        const objSize = new THREE.Vector3();
        objBox.getSize(objSize);
        if (objSize.y > 10) {
            obj.scale.setScalar(0.01);
            objBox.setFromObject(obj);
            objBox.getSize(objSize);
        }

        // Poser au sol à droite du spawn joueur
        const targetX = 1.35;
        const targetZ = 46.0;
        obj.position.set(targetX, -objBox.min.y, targetZ);

        // Orienter vers le joueur
        obj.rotation.y = Math.PI;

        // Matériau caisson sono sobre PBR noir pour le OBJ (qui n'a pas de fichier .mtl)
        const speakerMat = new THREE.MeshStandardMaterial({
            color: 0x1e1e24,
            roughness: 0.65,
            metalness: 0.12,
        });

        obj.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                if (!child.material || child.material.name === 'default' || !child.material.map) {
                    child.material = speakerMat;
                }
            }
        });

        group.add(obj);

        // Label au-dessus du subwoofer OBJ
        const objLabel = createTextLabel('🔊 Subwoofer (.obj)', '#a855f7');
        objLabel.position.set(targetX, objSize.y + 0.35, targetZ);
        group.add(objLabel);

        console.log('[TestSubwoofers] subwoofer.obj chargé avec succès, dimensions :', objSize);
    } catch (err) {
        console.warn('[TestSubwoofers] Erreur chargement subwoofer.obj :', err);
    }

    return group;
}
