/**
 * testSubwoofers.js — Charge et affiche les trois subwoofers :
 * 1. subwoofer.fbx  (FBX — gauche)
 * 2. subwoofer.glb  (GLB — centre, textures auto-embarquées)
 * 3. subwoofer_test.fbx (FBX — droite)
 * Placés devant le spawn du joueur (z ≈ 46).
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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

    // Chargeur de textures avec espace colorimétrique sRGB pour un rendu fidèle
    const textureLoader = new THREE.TextureLoader();
    const speakerTexture = textureLoader.load('src/assets/models/O5X8J80.jpg');
    speakerTexture.colorSpace = THREE.SRGBColorSpace;
    speakerTexture.wrapS = THREE.RepeatWrapping;
    speakerTexture.wrapT = THREE.RepeatWrapping;

    const fbxLoader = new FBXLoader();
    const gltfLoader = new GLTFLoader();

    // Cache-busting timestamp pour s'assurer que le navigateur recharge les versions fraîches
    const cacheBust = Date.now();

    // Fonction d'application du matériau texturé (FBX uniquement — fallback)
    const applySpeakerMaterial = (model) => {
        model.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;

                // Si le matériau n'a pas déjà de texture valide, appliquer la texture de grille extraite
                if (!child.material.map) {
                    child.material.map = speakerTexture;
                    child.material.needsUpdate = true;
                } else {
                    child.material.map.colorSpace = THREE.SRGBColorSpace;
                    child.material.needsUpdate = true;
                }

                // Ajuster la rugosité / métallicité pour un aspect enceinte acoustique pro
                if (child.material.roughness !== undefined) child.material.roughness = 0.55;
                if (child.material.metalness !== undefined) child.material.metalness = 0.15;
            }
        });
    };

    // ─────────────────────────────────────────────────────────────
    // 1. subwoofer.fbx — FBX gauche (x = -2.9)
    // ─────────────────────────────────────────────────────────────
    try {
        const fbx = await fbxLoader.loadAsync(`src/assets/models/subwoofer.fbx?t=${cacheBust}`);
        fbx.name = 'test-subwoofer-fbx';

        const fbxBox = new THREE.Box3().setFromObject(fbx);
        const fbxSize = new THREE.Vector3();
        fbxBox.getSize(fbxSize);
        if (fbxSize.y > 10) {
            fbx.scale.setScalar(0.01);
            fbxBox.setFromObject(fbx);
            fbxBox.getSize(fbxSize);
        }

        const targetX = -2.9;
        const targetZ = 46.0;
        fbx.position.set(targetX, -fbxBox.min.y, targetZ);
        fbx.rotation.y = Math.PI;

        applySpeakerMaterial(fbx);
        group.add(fbx);

        const fbxLabel = createTextLabel('🔊 subwoofer.fbx', '#38bdf8');
        fbxLabel.position.set(targetX, fbxSize.y + 0.35, targetZ);
        group.add(fbxLabel);

        console.log('[TestSubwoofers] subwoofer.fbx chargé, dimensions :', fbxSize);
    } catch (err) {
        console.warn('[TestSubwoofers] Erreur chargement subwoofer.fbx :', err);
    }

    // ─────────────────────────────────────────────────────────────
    // 2. subwoofer.glb — GLB centre (x = 0) — textures natives glTF
    // ─────────────────────────────────────────────────────────────
    try {
        const gltf = await gltfLoader.loadAsync(`src/assets/models/subwoofer.glb?t=${cacheBust}`);
        const glb = gltf.scene;
        glb.name = 'test-subwoofer-glb';

        const glbBox = new THREE.Box3().setFromObject(glb);
        const glbSize = new THREE.Vector3();
        glbBox.getSize(glbSize);

        // Auto-scale : si le modèle est en centimètres (> 10 unités de haut), passer en mètres
        if (glbSize.y > 10) {
            glb.scale.setScalar(0.01);
            glbBox.setFromObject(glb);
            glbBox.getSize(glbSize);
        }

        const targetX = 0;
        const targetZ = 46.0;
        glb.position.set(targetX, -glbBox.min.y, targetZ);
        glb.rotation.y = Math.PI;

        // Activer ombres et s'assurer que l'espace colorimétrique est correct (glTF = sRGB par défaut)
        glb.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                if (child.material.map) {
                    child.material.map.colorSpace = THREE.SRGBColorSpace;
                    child.material.needsUpdate = true;
                }
            }
        });

        group.add(glb);

        const glbLabel = createTextLabel('✅ subwoofer.glb', '#22c55e');
        glbLabel.position.set(targetX, glbSize.y + 0.35, targetZ);
        group.add(glbLabel);

        console.log('[TestSubwoofers] subwoofer.glb chargé, dimensions :', glbSize);
    } catch (err) {
        console.warn('[TestSubwoofers] Erreur chargement subwoofer.glb :', err);
    }

    // ─────────────────────────────────────────────────────────────
    // 3. subwoofer_test.fbx — FBX droite (x = 2.9)
    // ─────────────────────────────────────────────────────────────
    try {
        const fbxTest = await fbxLoader.loadAsync(`src/assets/models/subwoofer_test.fbx?t=${cacheBust}`);
        fbxTest.name = 'test-subwoofer-test-fbx';

        const testBox = new THREE.Box3().setFromObject(fbxTest);
        const testSize = new THREE.Vector3();
        testBox.getSize(testSize);
        if (testSize.y > 10) {
            fbxTest.scale.setScalar(0.01);
            testBox.setFromObject(fbxTest);
            testBox.getSize(testSize);
        }

        const targetX = 2.9;
        const targetZ = 46.0;
        fbxTest.position.set(targetX, -testBox.min.y, targetZ);
        fbxTest.rotation.y = Math.PI;

        applySpeakerMaterial(fbxTest);
        group.add(fbxTest);

        const testLabel = createTextLabel('🔊 subwoofer_test.fbx', '#a855f7');
        testLabel.position.set(targetX, testSize.y + 0.35, targetZ);
        group.add(testLabel);

        console.log('[TestSubwoofers] subwoofer_test.fbx chargé, dimensions :', testSize);
    } catch (err) {
        console.warn('[TestSubwoofers] Erreur chargement subwoofer_test.fbx :', err);
    }

    return group;
}
