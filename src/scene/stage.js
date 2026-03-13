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
    // --- Ground plane ---
    const groundGeo = new THREE.PlaneGeometry(400, 400);
    const groundMat = new THREE.MeshStandardMaterial({
        color: 0x4a7a2a,
        roughness: 0.95,
        metalness: 0,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    scene.add(ground);

    // --- Stage platform ---
    const stageGeo = new THREE.BoxGeometry(30, 3, 10);
    const stageMat = new THREE.MeshStandardMaterial({
        color: 0x1a1a1a,
        roughness: 0.8,
        metalness: 0.2,
    });
    const stageMesh = new THREE.Mesh(stageGeo, stageMat);
    stageMesh.position.set(0, 1.5, -5);
    stageMesh.castShadow = true;
    stageMesh.receiveShadow = true;
    scene.add(stageMesh);

    // --- Stage back wall ---
    const backWallGeo = new THREE.BoxGeometry(30, 20, 0.5);
    const backWallMat = new THREE.MeshStandardMaterial({
        color: 0x111111,
        roughness: 0.9,
        metalness: 0.1,
    });
    const backWall = new THREE.Mesh(backWallGeo, backWallMat);
    backWall.position.set(0, 10, -10);
    backWall.castShadow = true;
    scene.add(backWall);

    // --- Stage roof ---
    const roofGeo = new THREE.BoxGeometry(34, 0.3, 14);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    const roof = new THREE.Mesh(roofGeo, roofMat);
    roof.position.set(0, 20, -3);
    roof.castShadow = true;
    scene.add(roof);

    // --- Side truss columns ---
    const trussGeo = new THREE.BoxGeometry(0.4, 20, 0.4);
    const trussMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.6 });
    [[-17, 10, 0], [17, 10, 0], [-17, 10, -10], [17, 10, -10]].forEach(([x, y, z]) => {
        const truss = new THREE.Mesh(trussGeo, trussMat);
        truss.position.set(x, y, z);
        truss.castShadow = true;
        scene.add(truss);
    });

    // --- Speaker boxes & markers (generated from SPEAKER_DEFS) ---
    for (const def of SPEAKER_DEFS) {
        const vis = BUS_VISUAL[def.bus] || BUS_VISUAL.top;
        const p = def.position;

        // Visual box
        const boxGeo = new THREE.BoxGeometry(...vis.boxGeo);
        const boxMat = new THREE.MeshStandardMaterial({ color: vis.boxColor, roughness: 0.7, metalness: 0.2 });
        const box = new THREE.Mesh(boxGeo, boxMat);
        box.position.set(p.x, p.y, p.z);
        if (def.bus === 'top') box.rotation.x = -0.08;
        if (def.orientation) {
            box.rotation.y = Math.atan2(def.orientation.x, def.orientation.z);
            box.rotation.x = Math.asin(-def.orientation.y / Math.sqrt(
                def.orientation.x ** 2 + def.orientation.y ** 2 + def.orientation.z ** 2
            )) * 0.3;
        }
        box.castShadow = true;
        scene.add(box);

        // For top bus (line arrays), add extra stacked boxes
        if (def.bus === 'top') {
            for (let i = 1; i < 8; i++) {
                const extraBox = new THREE.Mesh(boxGeo, boxMat);
                extraBox.position.set(p.x, p.y + 4 - i * 0.6, p.z);
                extraBox.rotation.x = -0.08;
                extraBox.castShadow = true;
                scene.add(extraBox);
            }
        }

        // Emissive marker sphere
        const markerGeo = new THREE.SphereGeometry(vis.markerSize, 16, 16);
        const markerMat = new THREE.MeshStandardMaterial({
            color: vis.color,
            emissive: vis.color,
            emissiveIntensity: 0.6,
            transparent: true,
            opacity: 0.7,
        });
        const marker = new THREE.Mesh(markerGeo, markerMat);
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
    scene.add(ambientLight);

    // Hemisphere light for sky/ground color bleed
    const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x4a7a2a, 0.8);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xfff5e0, 1.8);
    dirLight.position.set(30, 60, 40);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 512;
    dirLight.shadow.mapSize.height = 512;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 150;
    dirLight.shadow.camera.left = -60;
    dirLight.shadow.camera.right = 60;
    dirLight.shadow.camera.top = 60;
    dirLight.shadow.camera.bottom = -60;
    scene.add(dirLight);

    // Stage lights (colored point lights — subtle in daytime)
    const stageLight1 = new THREE.PointLight(0xff3366, 0.5, 30);
    stageLight1.position.set(-8, 18, -2);
    scene.add(stageLight1);

    const stageLight2 = new THREE.PointLight(0x3366ff, 0.5, 30);
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

    return { coneContainer, coneGroups };
}
