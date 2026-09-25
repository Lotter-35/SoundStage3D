/**
 * testSubwoofers.js — Charge et affiche les deux subwoofers FBX :
 * 1. subwoofer.fbx (mis à jour / modifié)
 * 2. subwoofer_test.fbx (nouveau fichier)
 * Placé devant le spawn du joueur (FOH x=0, z=50).
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

function createTextLabel(text, borderColor = '#38bdf8') {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 75;
    const ctx = canvas.getContext('2d');

    // Fond badge semi-transparent
    ctx.fillStyle = 'rgba(10, 15, 28, 0.90)';
    if (ctx.roundRect) {
        ctx.roundRect(6, 6, 308, 63, 14);
    } else {
        ctx.rect(6, 6, 308, 63);
    }
    ctx.fill();

    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Texte
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 160, 39);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 999;
    sprite.scale.set(1.4, 0.33, 1);
    return sprite;
}

export async function loadTestSubwoofers(scene) {
    const group = new THREE.Group();
    group.name = 'test-subwoofers-group';
    scene.add(group);

    const fbxLoader = new FBXLoader();

    // Cache-busting timestamp pour s'assurer que le navigateur recharge les versions fraîches
    const cacheBust = Date.now();

    // 1. Charger subwoofer.fbx (à gauche du spawn : x = -1.35)
    try {
        const fbx = await fbxLoader.loadAsync(`src/assets/models/subwoofer.fbx?t=${cacheBust}`);
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

        const targetX = -1.35;
        const targetZ = 46.0;
        fbx.position.set(targetX, -fbxBox.min.y, targetZ);
        fbx.rotation.y = Math.PI;

        fbx.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        group.add(fbx);

        const fbxLabel = createTextLabel('🔊 subwoofer.fbx', '#38bdf8');
        fbxLabel.position.set(targetX, fbxSize.y + 0.35, targetZ);
        group.add(fbxLabel);

        console.log('[TestSubwoofers] subwoofer.fbx chargé avec succès, dimensions :', fbxSize);
    } catch (err) {
        console.warn('[TestSubwoofers] Erreur chargement subwoofer.fbx :', err);
    }

    // 2. Charger subwoofer_test.fbx (à droite du spawn : x = 1.35)
    try {
        const fbxTest = await fbxLoader.loadAsync(`src/assets/models/subwoofer_test.fbx?t=${cacheBust}`);
        fbxTest.name = 'test-subwoofer-test-fbx';

        // Auto-scale si nécessaire
        const testBox = new THREE.Box3().setFromObject(fbxTest);
        const testSize = new THREE.Vector3();
        testBox.getSize(testSize);
        if (testSize.y > 10) {
            fbxTest.scale.setScalar(0.01);
            testBox.setFromObject(fbxTest);
            testBox.getSize(testSize);
        }

        const targetX = 1.35;
        const targetZ = 46.0;
        fbxTest.position.set(targetX, -testBox.min.y, targetZ);
        fbxTest.rotation.y = Math.PI;

        fbxTest.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });

        group.add(fbxTest);

        const testLabel = createTextLabel('🔊 subwoofer_test.fbx', '#a855f7');
        testLabel.position.set(targetX, testSize.y + 0.35, targetZ);
        group.add(testLabel);

        console.log('[TestSubwoofers] subwoofer_test.fbx chargé avec succès, dimensions :', testSize);
    } catch (err) {
        console.warn('[TestSubwoofers] Erreur chargement subwoofer_test.fbx :', err);
    }

    return group;
}
