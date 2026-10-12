/**
 * Stage — 3D scene geometry: ground, stage structure, speaker markers, lighting.
 * All speaker visuals (boxes, markers, cones) are generated from SPEAKER_DEFS
 * so that changing positions in speakers.js is the only thing needed.
 */
import * as THREE from 'three';
import { SPEAKER_DEFS } from '../audio/speakers.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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
    // Filtrage anisotrope : herbe nette vue en biais jusqu'à l'horizon (three.js plafonne au max du GPU)
    grassTex.anisotropy = 16;
    const groundMat = new THREE.MeshStandardMaterial({
        map: grassTex,
        roughness: 0.95,
        metalness: 0,
    });
    // Anti-répétition : chaque tuile reçoit un décalage / une orientation aléatoires, fondus entre tuiles
    // (technique « texture no-tile » d'Inigo Quilez, 4 lectures), + grandes taches de variation de couleur
    // (herbe plus jaune / plus sombre sur ~30 m) : plus de quadrillage visible de loin.
    groundMat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', `#include <common>
                vec4 ss3dHash4(vec2 p) {
                    vec4 p4 = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
                    p4 += dot(p4, p4.wzxy + 33.33);
                    return fract((p4.xxyz + p4.yzzw) * p4.zywx);
                }
                float ss3dNoise(vec2 p) {
                    vec2 i = floor(p), f = fract(p);
                    vec2 u = f * f * (3.0 - 2.0 * f);
                    float a = ss3dHash4(i).x, b = ss3dHash4(i + vec2(1.0, 0.0)).x;
                    float c = ss3dHash4(i + vec2(0.0, 1.0)).x, d = ss3dHash4(i + vec2(1.0, 1.0)).x;
                    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
                }
                vec4 ss3dNoTile(sampler2D samp, vec2 uv) {
                    vec2 iuv = floor(uv), fuv = fract(uv);
                    vec4 ofa = ss3dHash4(iuv + vec2(0.0, 0.0));
                    vec4 ofb = ss3dHash4(iuv + vec2(1.0, 0.0));
                    vec4 ofc = ss3dHash4(iuv + vec2(0.0, 1.0));
                    vec4 ofd = ss3dHash4(iuv + vec2(1.0, 1.0));
                    vec2 ddx = dFdx(uv), ddy = dFdy(uv);
                    ofa.zw = sign(ofa.zw - 0.5); ofb.zw = sign(ofb.zw - 0.5);
                    ofc.zw = sign(ofc.zw - 0.5); ofd.zw = sign(ofd.zw - 0.5);
                    vec2 uva = uv * ofa.zw + ofa.xy; vec2 uvb = uv * ofb.zw + ofb.xy;
                    vec2 uvc = uv * ofc.zw + ofc.xy; vec2 uvd = uv * ofd.zw + ofd.xy;
                    vec2 b = smoothstep(0.25, 0.75, fuv);
                    return mix(mix(textureGrad(samp, uva, ddx * ofa.zw, ddy * ofa.zw),
                                   textureGrad(samp, uvb, ddx * ofb.zw, ddy * ofb.zw), b.x),
                               mix(textureGrad(samp, uvc, ddx * ofc.zw, ddy * ofc.zw),
                                   textureGrad(samp, uvd, ddx * ofd.zw, ddy * ofd.zw), b.x), b.y);
                }`)
            .replace('#include <map_fragment>', `vec4 sampledDiffuseColor = ss3dNoTile( map, vMapUv );
                // Variation de couleur à grande échelle (1 unité de vMapUv = 5 m)
                float ss3dN1 = ss3dNoise(vMapUv * 0.16) * 0.65 + ss3dNoise(vMapUv * 0.41 + 7.3) * 0.35;
                float ss3dN2 = ss3dNoise(vMapUv * 0.09 + 3.1);
                vec3 ss3dTint = mix(vec3(1.0), vec3(1.10, 1.04, 0.72), smoothstep(0.45, 0.85, ss3dN1) * 0.55);
                ss3dTint *= mix(0.86, 1.08, ss3dN2);
                sampledDiffuseColor.rgb *= ss3dTint;
                diffuseColor *= sampledDiffuseColor;`);
    };
    groundMat.customProgramCacheKey = () => 'ss3d-ground-notile-v2';
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
    // Enfoncée de 5 cm dans le sol (dessus inchangé à y = 3) pour qu'aucune lumière ne passe sous la plateforme
    const stageGeo = new THREE.BoxGeometry(30, 3.05, 10);
    if (stageGeo.attributes.uv) stageGeo.setAttribute('uv2', stageGeo.attributes.uv.clone());
    const stageMatSidesX = createSceneMaterial(3.33, 1.0);
    const stageMatTop = createSceneMaterial(10.0, 3.33);
    const stageMatSidesZ = createSceneMaterial(10.0, 1.0);
    const stageMesh = new THREE.Mesh(stageGeo, [
        stageMatSidesX, stageMatSidesX, stageMatTop, stageMatTop, stageMatSidesZ, stageMatSidesZ
    ]);
    stageMesh.name = 'stagePlatform';
    stageMesh.position.set(0, 1.475, -5);
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
            // Chaque marche s'enfonce de 5 cm dans le sol et de 5 cm dans la marche voisine (côté scène)
            const overlap = 0.05;
            const stepGeo = new THREE.BoxGeometry(stepWidthX + overlap, h + overlap, stairDepthZ);
            const stepMesh = new THREE.Mesh(stepGeo, stepMat);
            stepMesh.position.set(x + (isLeft ? overlap / 2 : -overlap / 2), (h - overlap) / 2, centerZ);
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
    // Enfoncée de 5 cm dans la scène (dessus inchangé à y = 3.95)
    const djTableGeo = new THREE.BoxGeometry(3.6, 1.0, 1.0);
    const djTable = new THREE.Mesh(djTableGeo, djTableMat);
    djTable.position.set(0, 3.0 + 0.95 - 0.5, -5.0);
    djTable.castShadow = true;
    djTable.receiveShadow = true;
    djGroup.add(djTable);

    // Modèle 3D : 2 CDJ-3000 + table de mixage DJM-A9 posés sur la table.
    // Le modèle est en mètres (1.41 x 0.44 m), origine au centre du mixeur, base à y≈0.
    // Retourné de 180° : câbles et faces arrière côté public (+z), commandes côté DJ.
    const DJ_GEAR_SCALE = 1.5;
    const DJ_TABLE_TOP_Y = 3.0 + 0.95;
    new GLTFLoader().load(
        'src/assets/models/CDJ_300_DJM_A9.glb',
        (gltf) => {
            const gear = gltf.scene;
            gear.name = 'dj-gear-cdj-djm';
            gear.scale.setScalar(DJ_GEAR_SCALE);
            gear.rotation.y = Math.PI;
            gear.position.set(0, DJ_TABLE_TOP_Y + 0.006, -5.0);
            gear.traverse((node) => {
                if (node.isMesh) {
                    node.castShadow = true;
                    node.receiveShadow = true;
                }
            });
            djGroup.add(gear);
        },
        undefined,
        (err) => console.warn('[Stage] Chargement du matériel DJ impossible :', err)
    );

    scene.add(djGroup);

    // --- Stage back wall (1.5m d'épaisseur pour blocage physique total de la lumière sans fuite) ---
    // Enfoncé de 5 cm dans le sol et dans la scène (face avant inchangée à y > 3)
    const backWallGeo = new THREE.BoxGeometry(30, 20.05, 1.55);
    if (backWallGeo.attributes.uv) backWallGeo.setAttribute('uv2', backWallGeo.attributes.uv.clone());
    const wallMatSidesX = createSceneMaterial(0.5, 6.67);
    const wallMatTopBottom = createSceneMaterial(10.0, 0.5);
    const wallMatFace = createSceneMaterial(10.0, 6.67);
    const backWall = new THREE.Mesh(backWallGeo, [
        wallMatSidesX, wallMatSidesX, wallMatTopBottom, wallMatTopBottom, wallMatFace, wallMatFace
    ]);
    backWall.name = 'stageBackWall';
    backWall.position.set(0, 9.975, -10.725);
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
    const trussGeo = new THREE.BoxGeometry(0.4, 20.05, 0.4);
    if (trussGeo.attributes.uv) trussGeo.setAttribute('uv2', trussGeo.attributes.uv.clone());
    const trussMat = createSceneMaterial(0.3, 6.67, { roughness: 0.6, normalScale: 1.0 });
    [[-17, 9.975, 0], [17, 9.975, 0], [-17, 9.975, -10], [17, 9.975, -10]].forEach(([x, y, z]) => {
        const truss = new THREE.Mesh(trussGeo, trussMat);
        truss.position.set(x, y, z);
        truss.castShadow = true;
        truss.receiveShadow = true;
        scene.add(truss);
    });

    // --- Speaker boxes & markers (generated from SPEAKER_DEFS) ---
    const boxGeoCache = {};
    const boxMatCache = {};
    const markerGeoCache = {};
    const markerMatCache = {};

    // Groupe dédié aux bulles / ronds d'émission sonore (masquable en mode F1)
    const soundMarkersGroup = new THREE.Group();
    soundMarkersGroup.name = 'sound-markers-group';
    soundMarkersGroup.visible = false; // Masqué par défaut (bouton « Ronds émission son » dans Ambiance)
    scene.add(soundMarkersGroup);

    for (const def of SPEAKER_DEFS) {
        const vis = BUS_VISUAL[def.bus] || BUS_VISUAL.top;
        const p = def.position;
        const busKey = def.bus;

        // Visual box pour mids et fills (les subs et tops sont remplacés par les modèles 3D GLB)
        if (def.bus === 'mid' || def.bus === 'fill') {
            if (!boxGeoCache[busKey]) {
                boxGeoCache[busKey] = new THREE.BoxGeometry(...vis.boxGeo);
                boxMatCache[busKey] = new THREE.MeshStandardMaterial({
                    color: vis.boxColor,
                    roughness: 0.7,
                    metalness: 0.2,
                });
            }
            const box = new THREE.Mesh(boxGeoCache[busKey], boxMatCache[busKey]);
            box.position.set(p.x, p.y, p.z);
            if (def.orientation) {
                box.rotation.y = Math.atan2(def.orientation.x, def.orientation.z);
                box.rotation.x = Math.asin(-def.orientation.y / Math.sqrt(
                    def.orientation.x ** 2 + def.orientation.y ** 2 + def.orientation.z ** 2
                )) * 0.3;
            }
            box.castShadow = true;
            box.receiveShadow = true;
            scene.add(box);
        }

        // Bulles de couleurs au niveau des émetteurs son
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
        soundMarkersGroup.add(marker);
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
    // Point de spawn (FOH) : toujours visible, indépendant du bouton « Ronds émission son »
    scene.add(fohMarker);

    // --- Lighting ---
    const ambientLight = new THREE.AmbientLight(0x98ddbc, 0.1);
    ambientLight.name = 'Ambiance Générale';
    scene.add(ambientLight);

    // Hemisphere light for sky/ground color bleed (maintenue active avec intensité minime pour pré-compiler le shader Three.js)
    const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x4a7a2a, 1.0);
    hemiLight.name = 'Ciel / Sol';
    hemiLight.visible = true;
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xfff5e0, 3.0);
    dirLight.name = 'Soleil Principal';
    dirLight.position.set(32, 45, 38);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 10;
    dirLight.shadow.camera.far = 200;
    dirLight.shadow.camera.left = -60;
    dirLight.shadow.camera.right = 60;
    dirLight.shadow.camera.top = 60;
    dirLight.shadow.camera.bottom = -60;
    dirLight.shadow.bias = -0.0003;
    dirLight.shadow.normalBias = 0.02;
    dirLight.shadow.camera.updateProjectionMatrix();
    scene.add(dirLight);
    scene.add(dirLight.target);


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
            coneGroups[bus].visible = false; // chaque bus caché par défaut : seul le bus coché dans le menu Cônes s'affiche
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
            // Subs : diffusion rasante (atténués au-dessus, cf. SUB_ELEV_* dans speakers.js) → dôme aplati
            if (bus === 'sub') sphere.scale.y = 0.4;
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

    const initialLights = [ambientLight, hemiLight, dirLight];
    return { coneContainer, coneGroups, dirLight, lights: initialLights, soundMarkersGroup, fohMarker };
}
