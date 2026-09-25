/**
 * testSubwoofers.js — Charge et affiche le subwoofer FBX
 * pour test visuel devant le spawn du joueur (FOH x=0, z=50).
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

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

    // Charger subwoofer.fbx
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

        // Centré devant le spawn joueur (Spawn joueur à x=0, z=50)
        const targetX = 0;
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

    return group;
}
