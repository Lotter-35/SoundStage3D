/**
 * Stage — 3D scene geometry: ground, stage structure, speaker markers, lighting.
 * All speaker visuals (boxes, markers, cones) are generated from SPEAKER_DEFS
 * so that changing positions in speakers.js is the only thing needed.
 */
import * as THREE from 'three';
import { SPEAKER_DEFS } from '../audio/speakers.js';

// Visual config per bus type
const BUS_VISUAL = {
    sub:  { color: 0xff4444, markerSize: 0.6, boxGeo: [2.5, 2, 2],   boxColor: 0x1a1a1a, coneColor: 0xff2222, coneLength: 25 },
    mid:  { color: 0x44ff88, markerSize: 0.7, boxGeo: [1.4, 1.0, 0.9], boxColor: 0x1a2a1a, coneColor: 0x33ff66, coneLength: 60 },
    top:  { color: 0x44aaff, markerSize: 0.8, boxGeo: [1.2, 0.5, 0.8], boxColor: 0x222222, coneColor: 0xff3300, coneLength: 80 },
    fill: { color: 0xffaa44, markerSize: 0.4, boxGeo: [1.0, 0.6, 0.5], boxColor: 0x2a2a1a, coneColor: 0xffaa33, coneLength: 30 },
};

export function createStage(scene) {
    // --- Ground plane with grass texture ---
    const groundGeo = new THREE.PlaneGeometry(400, 400);
    const loader = new THREE.TextureLoader();
    const grassTex = loader.load('src/assets/textures/grass.jpg');
    grassTex.wrapS = THREE.RepeatWrapping;
    grassTex.wrapT = THREE.RepeatWrapping;
    grassTex.repeat.set(80, 80);
    grassTex.colorSpace = THREE.SRGBColorSpace;
    const groundMat = new THREE.MeshStandardMaterial({
        map: grassTex,
        roughness: 0.95,
        metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    scene.add(ground);

    // --- Textures PBR de la scène (sol, mur de fond, poteaux, toit, marches) ---
    const sceneTextureLoader = new THREE.TextureLoader();

    const sceneDiffMap = sceneTextureLoader.load('src/assets/textures/scene/textures/linoleum_black_diff_4k.jpg');
    sceneDiffMap.wrapS = THREE.RepeatWrapping;
    sceneDiffMap.wrapT = THREE.RepeatWrapping;
    sceneDiffMap.colorSpace = THREE.SRGBColorSpace;

    const sceneNorMap = sceneTextureLoader.load('src/assets/textures/scene/textures/linoleum_brown_nor.jpg');
    sceneNorMap.wrapS = THREE.RepeatWrapping;
    sceneNorMap.wrapT = THREE.RepeatWrapping;

    const sceneRoughMap = sceneTextureLoader.load('src/assets/textures/scene/textures/linoleum_brown_rough.jpg');
    sceneRoughMap.wrapS = THREE.RepeatWrapping;
    sceneRoughMap.wrapT = THREE.RepeatWrapping;

    /**
     * Génère un matériau PBR réaliste avec la texture de scène linoleum_brown pour chaque élément
     * @param {number} repeatX - Répétitions horizontales
     * @param {number} repeatY - Répétitions verticales
     * @param {object} [options]
     */
    function createSceneMaterial(repeatX = 1, repeatY = 1, options = {}) {
        const diff = sceneDiffMap.clone();
        diff.repeat.set(repeatX, repeatY);
        diff.needsUpdate = true;

        const nor = sceneNorMap.clone();
        nor.repeat.set(repeatX, repeatY);
        nor.needsUpdate = true;

        const rough = sceneRoughMap.clone();
        rough.repeat.set(repeatX, repeatY);
        rough.needsUpdate = true;

        const mat = new THREE.MeshStandardMaterial({
            map: diff,
            normalMap: nor,
            normalScale: new THREE.Vector2(options.normalScale || 0.85, options.normalScale || 0.85),
            roughnessMap: rough,
            roughness: options.roughness !== undefined ? options.roughness : 0.65,
            metalness: options.metalness !== undefined ? options.metalness : 0.08,
        });

        mat.customProgramCacheKey = () => `sceneMat_${repeatX}_${repeatY}`;
        mat.onBeforeCompile = (shader) => {
            shader.fragmentShader = shader.fragmentShader.replace(
                '#include <lights_fragment_end>',
                `
                #include <lights_fragment_end>
                // Réactivité dynamique aux éclairages et spots proches :
                reflectedLight.directDiffuse *= 1.35;
                reflectedLight.directSpecular *= 1.25;
                `
            );
        };
        return mat;
    }

    // --- Stage platform ---
    const stageGeo = new THREE.BoxGeometry(30, 3, 10);
    if (stageGeo.attributes.uv) stageGeo.setAttribute('uv2', stageGeo.attributes.uv.clone());
    const stageMatSidesX = createSceneMaterial(3.33, 1.0);
    const stageMatTop = createSceneMaterial(10.0, 3.33);
    const stageMatSidesZ = createSceneMaterial(10.0, 1.0);
    const stageMesh = new THREE.Mesh(stageGeo, [
        stageMatSidesX, stageMatSidesX, stageMatTop, stageMatTop, stageMatSidesZ, stageMatSidesZ
    ]);
    stageMesh.name = 'stagePlatform';
    stageMesh.position.set(0, 1.5, -5);
    stageMesh.castShadow = true;
    stageMesh.receiveShadow = true;
    scene.add(stageMesh);

    // --- Stairs on both sides (left & right) ---
    const stepMat = createSceneMaterial(1.2, 1.2);
    function buildStaircase(isLeft) {
        const group = new THREE.Group();
        const signX = isLeft ? -1 : 1;
        const numSteps = 10;
        const totalRise = 3.0;
        const stairDepthZ = 2.4;
        const runX = 3.8;
        const stepWidthX = runX / numSteps; // 0.38m
        const stepHeightY = totalRise / numSteps; // 0.30m
        const startX = signX * 18.8; // base on grass
        const endX = signX * 15.0;   // top flush with stage floor
        const centerZ = -5.0;        // centered on stage depth [-10, 0]

        const railMat = new THREE.MeshStandardMaterial({
            color: 0x555555,
            roughness: 0.4,
            metalness: 0.8,
        });

        // 10 solid steps climbing towards the stage
        for (let i = 0; i < numSteps; i++) {
            const h = (i + 1) * stepHeightY;
            const x = isLeft ? (startX + (i + 0.5) * stepWidthX) : (startX - (i + 0.5) * stepWidthX);
            const stepGeo = new THREE.BoxGeometry(stepWidthX, h, stairDepthZ);
            const stepMesh = new THREE.Mesh(stepGeo, stepMat);
            stepMesh.position.set(x, h / 2, centerZ);
            stepMesh.castShadow = true;
            stepMesh.receiveShadow = true;
            group.add(stepMesh);
        }

        // Handrails along front (z = -3.8) and back (z = -6.2)
        const halfZ = stairDepthZ / 2;
        [-halfZ, halfZ].forEach(offsetZ => {
            const z = centerZ + offsetZ;
            const postGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.0, 8);

            // Bottom post at ground
            const pBottom = new THREE.Mesh(postGeo, railMat);
            pBottom.position.set(startX, 0.5, z);
            pBottom.castShadow = true;
            pBottom.receiveShadow = true;
            group.add(pBottom);

            // Mid post
            const pMid = new THREE.Mesh(postGeo, railMat);
            pMid.position.set((startX + endX) / 2, totalRise / 2 + 0.5, z);
            pMid.castShadow = true;
            pMid.receiveShadow = true;
            group.add(pMid);

            // Top post at stage floor
            const pTop = new THREE.Mesh(postGeo, railMat);
            pTop.position.set(endX, totalRise + 0.5, z);
            pTop.castShadow = true;
            pTop.receiveShadow = true;
            group.add(pTop);

            // Slanted handrail bar
            const railLen = Math.sqrt(runX * runX + totalRise * totalRise);
            const railGeo = new THREE.CylinderGeometry(0.04, 0.04, railLen, 8);
            const railMesh = new THREE.Mesh(railGeo, railMat);
            railMesh.position.set((startX + endX) / 2, totalRise / 2 + 1.0, z);

            const stairAngle = Math.atan2(totalRise, runX);
            railMesh.rotation.z = isLeft ? (stairAngle - Math.PI / 2) : (Math.PI / 2 - stairAngle);
            railMesh.castShadow = true;
            railMesh.receiveShadow = true;
            group.add(railMesh);
        });

        scene.add(group);
    }
    buildStaircase(true);  // Left staircase
    buildStaircase(false); // Right staircase

    // --- DJ Booth Table on Stage ---
    const djGroup = new THREE.Group();
    const djTableMat = createSceneMaterial(1.5, 1.0, { roughness: 0.55 });
    const djTableGeo = new THREE.BoxGeometry(3.6, 0.95, 1.0);
    const djTable = new THREE.Mesh(djTableGeo, djTableMat);
    djTable.position.set(0, 3.0 + 0.95 / 2, -5.0);
    djTable.castShadow = true;
    djTable.receiveShadow = true;
    djGroup.add(djTable);

    const djDeckMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.4, metalness: 0.7 });
    const djDeckGeo = new THREE.BoxGeometry(3.2, 0.08, 0.7);
    const djDecks = new THREE.Mesh(djDeckGeo, djDeckMat);
    djDecks.position.set(0, 3.0 + 0.95 + 0.04, -5.0);
    djDecks.castShadow = true;
    djDecks.receiveShadow = true;
    djGroup.add(djDecks);

    const djLedMat = new THREE.MeshBasicMaterial({ color: 0x00ffcc });
    const djLedLeft = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 16), djLedMat);
    djLedLeft.position.set(-1.0, 3.0 + 0.95 + 0.09, -5.0);
    djGroup.add(djLedLeft);

    const djLedRight = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.02, 16), djLedMat);
    djLedRight.position.set(1.0, 3.0 + 0.95 + 0.09, -5.0);
    djGroup.add(djLedRight);

    scene.add(djGroup);

    // --- Stage back wall (1.5m d'épaisseur pour blocage physique total de la lumière sans fuite) ---
    const backWallGeo = new THREE.BoxGeometry(30, 20, 1.5);
    if (backWallGeo.attributes.uv) backWallGeo.setAttribute('uv2', backWallGeo.attributes.uv.clone());
    const wallMatSidesX = createSceneMaterial(0.5, 6.67);
    const wallMatTopBottom = createSceneMaterial(10.0, 0.5);
    const wallMatFace = createSceneMaterial(10.0, 6.67);
    const backWall = new THREE.Mesh(backWallGeo, [
        wallMatSidesX, wallMatSidesX, wallMatTopBottom, wallMatTopBottom, wallMatFace, wallMatFace
    ]);
    backWall.name = 'stageBackWall';
    backWall.position.set(0, 10, -10.75);
    backWall.castShadow = true;
    backWall.receiveShadow = true;
    scene.add(backWall);

    // --- Stage roof ---
    const roofGeo = new THREE.BoxGeometry(34, 0.3, 14);
    if (roofGeo.attributes.uv) roofGeo.setAttribute('uv2', roofGeo.attributes.uv.clone());
    const roofMatSidesX = createSceneMaterial(4.67, 0.2);
    const roofMatTopBottom = createSceneMaterial(11.3, 4.67);
    const roofMatSidesZ = createSceneMaterial(11.3, 0.2);
    const roof = new THREE.Mesh(roofGeo, [
        roofMatSidesX, roofMatSidesX, roofMatTopBottom, roofMatTopBottom, roofMatSidesZ, roofMatSidesZ
    ]);
    roof.position.set(0, 20, -3);
    roof.castShadow = true;
    roof.receiveShadow = true;
    scene.add(roof);

    // --- Side truss columns ---
    const trussGeo = new THREE.BoxGeometry(0.4, 20, 0.4);
    if (trussGeo.attributes.uv) trussGeo.setAttribute('uv2', trussGeo.attributes.uv.clone());
    const trussMat = createSceneMaterial(0.3, 6.67, { roughness: 0.6, normalScale: 1.0 });
    [[-17, 10, 0], [17, 10, 0], [-17, 10, -10], [17, 10, -10]].forEach(([x, y, z]) => {
        const truss = new THREE.Mesh(trussGeo, trussMat);
        truss.position.set(x, y, z);
        truss.castShadow = true;
        truss.receiveShadow = true;
        scene.add(truss);
    });

    // --- Speaker markers (sphères colorées de position des haut-parleurs) ---
    const markerGeoCache = {};
    const markerMatCache = {};

    for (const def of SPEAKER_DEFS) {
        const vis = BUS_VISUAL[def.bus] || BUS_VISUAL.top;
        const p = def.position;
        const busKey = def.bus;

        if (!markerGeoCache[busKey]) {
            markerGeoCache[busKey] = new THREE.SphereGeometry(vis.markerSize, 12, 10);
            markerMatCache[busKey] = new THREE.MeshBasicMaterial({
                color: vis.color,
                transparent: true,
                opacity: 0.75,
            });
        }
        const marker = new THREE.Mesh(markerGeoCache[busKey], markerMatCache[busKey]);
        marker.position.set(p.x, p.y, p.z);
        scene.add(marker);
    }

    // --- FOH marker ---
    const fohGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.05, 16);
    const fohMat = new THREE.MeshStandardMaterial({
        color: 0xffaa00,
        emissive: 0xffaa00,
        emissiveIntensity: 0.5,
    });
    const fohMarker = new THREE.Mesh(fohGeo, fohMat);
    fohMarker.position.set(0, 0.03, 50);
    scene.add(fohMarker);

    // --- Lighting ---
    const ambientLight = new THREE.AmbientLight(0x99bbdd, 1.0);
    ambientLight.name = 'Ambiance Générale';
    scene.add(ambientLight);

    // Hemisphere light for sky/ground color bleed
    const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x4a7a2a, 0.8);
    hemiLight.name = 'Ciel / Sol';
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xfff5e0, 1.8);
    dirLight.name = 'Soleil Principal';
    dirLight.position.set(30, 60, 40);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 4096;
    dirLight.shadow.mapSize.height = 4096;
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = 300;
    dirLight.shadow.camera.left = -60;
    dirLight.shadow.camera.right = 60;
    dirLight.shadow.camera.top = 60;
    dirLight.shadow.camera.bottom = -60;
    dirLight.shadow.bias = 0.00002;
    dirLight.shadow.normalBias = 0.08;
    dirLight.shadow.radius = 1.8;
    dirLight.shadow.camera.updateProjectionMatrix();
    scene.add(dirLight);
    scene.add(dirLight.target);

    // Stage lights (colored point lights — subtle in daytime)
    const stageLight1 = new THREE.PointLight(0xff3366, 0.5, 30);
    stageLight1.name = 'Projecteur Scène Gauche';
    stageLight1.position.set(-8, 18, -2);
    scene.add(stageLight1);

    const stageLight2 = new THREE.PointLight(0x3366ff, 0.5, 30);
    stageLight2.name = 'Projecteur Scène Droit';
    stageLight2.position.set(8, 18, -2);
    scene.add(stageLight2);

    // --- Sky ---
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 150, 400);

    // --- Propagation cone visualisation (generated from SPEAKER_DEFS) ---
    // Each bus gets its own THREE.Group for independent visibility control
    const coneGroups = {};
    const coneContainer = new THREE.Group();
    coneContainer.visible = false;
    scene.add(coneContainer);

    for (const def of SPEAKER_DEFS) {
        const bus = def.bus;
        if (!coneGroups[bus]) {
            coneGroups[bus] = new THREE.Group();
            coneGroups[bus].visible = true;
            coneContainer.add(coneGroups[bus]);
        }
        const group = coneGroups[bus];
        const vis = BUS_VISUAL[bus] || BUS_VISUAL.top;
        const p = def.position;
        const origin = new THREE.Vector3(p.x, p.y, p.z);

        if (def.omnidirectional) {
            const sphereGeo = new THREE.SphereGeometry(vis.coneLength, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2);
            const sphereMat = new THREE.MeshBasicMaterial({
                color: vis.coneColor, transparent: true, opacity: 0.03,
                side: THREE.DoubleSide, depthWrite: false,
            });
            const sphere = new THREE.Mesh(sphereGeo, sphereMat);
            sphere.position.copy(origin);
            group.add(sphere);
        } else {
            const o = def.orientation;
            const dir = new THREE.Vector3(o.x, o.y, o.z).normalize();
            const innerAngle = (def.coneInner || 60) / 2;
            const outerAngle = (def.coneOuter || 120) / 2;
            const coneLen = vis.coneLength;

            const innerHalf = THREE.MathUtils.degToRad(innerAngle);
            const outerHalf = THREE.MathUtils.degToRad(outerAngle);

            const iRadius = Math.tan(innerHalf) * coneLen;
            const iGeo = new THREE.ConeGeometry(iRadius, coneLen, 32, 1, true);
            const iMat = new THREE.MeshBasicMaterial({
                color: vis.coneColor, transparent: true, opacity: 0.08,
                side: THREE.DoubleSide, depthWrite: false,
            });
            const iMesh = new THREE.Mesh(iGeo, iMat);
            iMesh.position.copy(origin);
            iMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
            iMesh.translateOnAxis(new THREE.Vector3(0, -1, 0), coneLen / 2);
            group.add(iMesh);

            const oRadius = Math.tan(outerHalf) * coneLen;
            const oGeo = new THREE.ConeGeometry(oRadius, coneLen, 32, 1, true);
            const oMat = new THREE.MeshBasicMaterial({
                color: vis.coneColor, transparent: true, opacity: 0.04,
                side: THREE.DoubleSide, depthWrite: false,
            });
            const oMesh = new THREE.Mesh(oGeo, oMat);
            oMesh.position.copy(origin);
            oMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
            oMesh.translateOnAxis(new THREE.Vector3(0, -1, 0), coneLen / 2);
            group.add(oMesh);
        }
    }

    const initialLights = [ambientLight, hemiLight, dirLight, stageLight1, stageLight2];
    return { coneContainer, coneGroups, dirLight, lights: initialLights };
}
