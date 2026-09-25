/**
 * LaserPodHousing.js
 * ─────────────────────────────────────────────────────────────
 * Modèle 3D complet d'un boîtier de projecteur laser professionnel
 * (style Kvant Spectrum / Clubmax / RTI) :
 * - Châssis en aluminium anodisé avec renforts d'angle
 * - Platine avant avec fenêtre de tir optique (aperture scanner)
 * - Volet de sécurité mécanique (safety shutter)
 * - Étiquette signalétique Danger Laser Classe 4 (texture procédurale)
 * - LEDs de statut d'émission (verte interlock, rouge active synchronisée)
 * - Ailettes latérales de dissipation thermique (heatsinks)
 * - Lyre de suspension orientable (yoke) avec volants de serrage moletés
 * - Crochet demi-collier et tronçon de structure aluminium (truss)
 * - Panneau technique arrière (connecteurs ILDA, DMX, PowerCON, clé)
 * ─────────────────────────────────────────────────────────────
 * OPTIMISÉ : géométries et matériaux partagés à 100% entre les pods
 * (0 surcoût mémoire, 0 allocation GC par frame).
 */

import * as THREE from 'three';


let _sharedResources = null;

function getSharedResources() {
    if (_sharedResources) return _sharedResources;

    // ── 1. Texture procédurale pour l'étiquette de sécurité Danger Laser
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');

    // Fond jaune sécurité
    ctx.fillStyle = '#ffcc00';
    ctx.fillRect(0, 0, 128, 128);

    // Bordure noire
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, 120, 120);

    // Triangle noir
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.moveTo(64, 18);
    ctx.lineTo(112, 94);
    ctx.lineTo(16, 94);
    ctx.closePath();
    ctx.fill();

    // Symbole laser jaune au cœur du triangle
    ctx.fillStyle = '#ffcc00';
    ctx.beginPath();
    ctx.arc(64, 64, 8, 0, Math.PI * 2);
    ctx.fill();

    // Rayons divergents
    ctx.strokeStyle = '#ffcc00';
    ctx.lineWidth = 3;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
        ctx.beginPath();
        ctx.moveTo(64 + Math.cos(a) * 11, 64 + Math.sin(a) * 11);
        ctx.lineTo(64 + Math.cos(a) * 18, 64 + Math.sin(a) * 18);
        ctx.stroke();
    }

    // Texte "DANGER"
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('DANGER LASER', 64, 116);

    const hazardTexture = new THREE.CanvasTexture(canvas);

    // ── 2. Matériaux partagés
    // Teintes réalistes d'équipements de scène (finition satinée / thermolaquée)
    // avec taux de métal modéré (0.4-0.55) permettant à la lumière ambiante et zénithale
    // de révéler les chanfreins, arêtes et volumes sans jamais être tout noir.
    const chassisMat = new THREE.MeshStandardMaterial({
        color: 0x242832,
        roughness: 0.45,
        metalness: 0.40
    });

    const frontPlateMat = new THREE.MeshStandardMaterial({
        color: 0x1e2128,
        roughness: 0.45,
        metalness: 0.45
    });

    const frameMat = new THREE.MeshStandardMaterial({
        color: 0x444b58,
        roughness: 0.32,
        metalness: 0.55
    });

    const shutterMat = new THREE.MeshStandardMaterial({
        color: 0x3a404c,
        roughness: 0.32,
        metalness: 0.55
    });

    // Fenêtre optique avec rendu additif : brille de la couleur du laser,
    // n'écrit pas dans le Z-buffer et ne bloque JAMAIS la lumière.
    const glassMat = new THREE.MeshBasicMaterial({
        color: 0x0055ff,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthWrite: false
    });

    const bumperMat = new THREE.MeshStandardMaterial({
        color: 0x14161a,
        roughness: 0.88,
        metalness: 0.10
    });

    const finMat = new THREE.MeshStandardMaterial({
        color: 0x22262e,
        roughness: 0.42,
        metalness: 0.50
    });

    const yokeMat = new THREE.MeshStandardMaterial({
        color: 0x323844,
        roughness: 0.38,
        metalness: 0.50
    });

    const trussMat = new THREE.MeshStandardMaterial({
        color: 0x8a94a2,
        roughness: 0.28,
        metalness: 0.75
    });

    const knobMat = new THREE.MeshStandardMaterial({
        color: 0x303642,
        roughness: 0.40,
        metalness: 0.60
    });

    const hazardMat = new THREE.MeshStandardMaterial({
        map: hazardTexture,
        roughness: 0.40,
        metalness: 0.05
    });

    const greenLedMat = new THREE.MeshStandardMaterial({
        color: 0x00ff88,
        emissive: 0x00ff88,
        emissiveIntensity: 1.8,
        roughness: 0.2
    });

    const redLedMat = new THREE.MeshStandardMaterial({
        color: 0xff2222,
        emissive: 0xff2222,
        emissiveIntensity: 2.2,
        roughness: 0.2
    });

    const connectorMat = new THREE.MeshStandardMaterial({
        color: 0x161920,
        roughness: 0.65,
        metalness: 0.40
    });

    // ── 3. Géométries partagées
    // Dimensions du corps : Largeur=0.50m, Hauteur=0.26m, Profondeur=0.42m
    const chassisGeo       = new THREE.BoxGeometry(0.50, 0.26, 0.42);
    const frontPlateGeo    = new THREE.BoxGeometry(0.47, 0.23, 0.012);
    const apertureFrameGeo = new THREE.BoxGeometry(0.22, 0.13, 0.016);
    const apertureHoleGeo  = new THREE.PlaneGeometry(0.19, 0.10);
    const shutterGeo       = new THREE.BoxGeometry(0.24, 0.018, 0.014);
    const cornerGeo        = new THREE.BoxGeometry(0.032, 0.27, 0.032);
    const finGeo           = new THREE.BoxGeometry(0.012, 0.012, 0.35);
    const yokeArmGeo       = new THREE.BoxGeometry(0.025, 0.29, 0.05);
    const yokeBarGeo       = new THREE.BoxGeometry(0.58, 0.025, 0.05);
    const clampGeo         = new THREE.CylinderGeometry(0.038, 0.038, 0.045, 16);
    const knobGeo          = new THREE.CylinderGeometry(0.032, 0.032, 0.025, 16);
    const trussTubeGeo     = new THREE.CylinderGeometry(0.024, 0.024, 1.4, 16);
    const ledGeo           = new THREE.SphereGeometry(0.009, 12, 8);
    const hazardGeo        = new THREE.PlaneGeometry(0.065, 0.065);
    const fanGrilleGeo     = new THREE.CylinderGeometry(0.06, 0.06, 0.01, 16);
    const connectorGeo     = new THREE.CylinderGeometry(0.014, 0.014, 0.02, 12);

    _sharedResources = {
        hazardTexture,
        materials: {
            chassisMat,
            frontPlateMat,
            frameMat,
            shutterMat,
            glassMat,
            bumperMat,
            finMat,
            yokeMat,
            trussMat,
            knobMat,
            hazardMat,
            greenLedMat,
            redLedMat,
            connectorMat
        },
        geometries: {
            chassisGeo,
            frontPlateGeo,
            apertureFrameGeo,
            apertureHoleGeo,
            shutterGeo,
            cornerGeo,
            finGeo,
            yokeArmGeo,
            yokeBarGeo,
            clampGeo,
            knobGeo,
            trussTubeGeo,
            ledGeo,
            hazardGeo,
            fanGrilleGeo,
            connectorGeo
        }
    };

    return _sharedResources;
}

export class LaserPodHousing {
    /**
     * @param {THREE.Scene} scene
     */
    constructor(scene) {
        this.scene = scene;
        this.group = new THREE.Group();

        this._buildModel();
        this.scene.add(this.group);
    }

    _buildModel() {
        const res = getSharedResources();
        const { materials: m, geometries: g } = res;

        // NOTE ESSENTIELLE SUR LE POSITIONNEMENT :
        // Le point d'émission laser (pod.origin) est en (0, 0, 0) dans l'espace local.
        // Les faisceaux et la nappe PAN se propagent vers Z >= 0.
        // TOUTES les pièces opaques du boîtier sont donc strictement placées à Z <= -0.035m.
        // Cela garantit un dégagement optique absolu : aucune géométrie ne peut venir
        // occlure ou découper le faisceau / la nappe, éliminant ainsi toute "bande noire" !

        // ── 1. Corps principal du boîtier (centre à Z = -0.266m, face avant à Z = -0.056m)
        const chassis = new THREE.Mesh(g.chassisGeo, m.chassisMat);
        chassis.position.set(0, 0, -0.266);
        this.group.add(chassis);

        // ── 2. Cornières de protection sur les 4 arêtes verticales
        const cornerOffsets = [
            [-0.25, 0, -0.07],
            [ 0.25, 0, -0.07],
            [-0.25, 0, -0.46],
            [ 0.25, 0, -0.46]
        ];
        for (const [cx, cy, cz] of cornerOffsets) {
            const corner = new THREE.Mesh(g.cornerGeo, m.bumperMat);
            corner.position.set(cx, cy, cz);
            this.group.add(corner);
        }

        // ── 3. Façade avant découpée (Z = -0.050m)
        const frontPlate = new THREE.Mesh(g.frontPlateGeo, m.frontPlateMat);
        frontPlate.position.set(0, 0, -0.050);
        this.group.add(frontPlate);

        // ── 4. Fenêtre de sortie optique (Aperture scanner) centrée sur X=0, Y=0
        const apertureFrame = new THREE.Mesh(g.apertureFrameGeo, m.frameMat);
        apertureFrame.position.set(0, 0, -0.043);
        this.group.add(apertureFrame);

        // Vitre optique avec shader additif synchronisé avec le laser
        this.apertureMesh = new THREE.Mesh(g.apertureHoleGeo, m.glassMat.clone());
        this.apertureMesh.position.set(0, 0, -0.049);
        this.group.add(this.apertureMesh);

        // Volet de sécurité mécanique (safety shutter) situé au-dessus de la fenêtre
        const shutter = new THREE.Mesh(g.shutterGeo, m.shutterMat);
        shutter.position.set(0, 0.073, -0.042);
        this.group.add(shutter);

        // ── 5. Étiquette Danger Laser sur la gauche de la façade
        const hazardDecal = new THREE.Mesh(g.hazardGeo, m.hazardMat);
        hazardDecal.position.set(-0.15, 0.01, -0.043);
        this.group.add(hazardDecal);

        // ── 6. LEDs indicatrices de statut
        // LED verte (Power & Interlock armé)
        const powerLed = new THREE.Mesh(g.ledGeo, m.greenLedMat);
        powerLed.position.set(-0.15, -0.065, -0.043);
        this.group.add(powerLed);

        // LED rouge (Émission active / clignotement synchronisé)
        this.emissionLed = new THREE.Mesh(g.ledGeo, m.redLedMat.clone());
        this.emissionLed.position.set(-0.10, -0.065, -0.043);
        this.group.add(this.emissionLed);

        // ── 7. Ailettes de refroidissement (heatsinks) sur les deux flancs
        const finYOffsets = [-0.07, -0.02, 0.03, 0.08];
        for (const fy of finYOffsets) {
            // Flanc gauche
            const finL = new THREE.Mesh(g.finGeo, m.finMat);
            finL.position.set(-0.255, fy, -0.266);
            this.group.add(finL);

            // Flanc droit
            const finR = new THREE.Mesh(g.finGeo, m.finMat);
            finR.position.set(0.255, fy, -0.266);
            this.group.add(finR);
        }

        // ── 8. Lyre de fixation métallique (Yoke / Étrier)
        // Bras gauche
        const armL = new THREE.Mesh(g.yokeArmGeo, m.yokeMat);
        armL.position.set(-0.275, 0.11, -0.266);
        this.group.add(armL);

        // Bras droit
        const armR = new THREE.Mesh(g.yokeArmGeo, m.yokeMat);
        armR.position.set(0.275, 0.11, -0.266);
        this.group.add(armR);

        // Barre supérieure
        const yokeBar = new THREE.Mesh(g.yokeBarGeo, m.yokeMat);
        yokeBar.position.set(0, 0.245, -0.266);
        this.group.add(yokeBar);

        // Volants de serrage moletés sur les pivots gauche et droit
        const knobL = new THREE.Mesh(g.knobGeo, m.knobMat);
        knobL.rotation.z = Math.PI / 2;
        knobL.position.set(-0.295, 0.01, -0.266);
        this.group.add(knobL);

        const knobR = new THREE.Mesh(g.knobGeo, m.knobMat);
        knobR.rotation.z = Math.PI / 2;
        knobR.position.set(0.295, 0.01, -0.266);
        this.group.add(knobR);

        // Crochet demi-collier sur la barre
        const clampMesh = new THREE.Mesh(g.clampGeo, m.yokeMat);
        clampMesh.position.set(0, 0.28, -0.266);
        this.group.add(clampMesh);

        // Tronçon de structure aluminium (truss tube)
        const trussTube = new THREE.Mesh(g.trussTubeGeo, m.trussMat);
        trussTube.rotation.z = Math.PI / 2;
        trussTube.position.set(0, 0.32, -0.266);
        this.group.add(trussTube);

        // ── 9. Panneau technique arrière (ventilation et connectique)
        const fanGrille = new THREE.Mesh(g.fanGrilleGeo, m.connectorMat);
        fanGrille.rotation.x = Math.PI / 2;
        fanGrille.position.set(-0.12, 0.02, -0.482);
        this.group.add(fanGrille);

        const dmxIn = new THREE.Mesh(g.connectorGeo, m.connectorMat);
        dmxIn.rotation.x = Math.PI / 2;
        dmxIn.position.set(0.10, -0.04, -0.482);
        this.group.add(dmxIn);

        const dmxOut = new THREE.Mesh(g.connectorGeo, m.connectorMat);
        dmxOut.rotation.x = Math.PI / 2;
        dmxOut.position.set(0.15, -0.04, -0.482);
        this.group.add(dmxOut);

        const powerIn = new THREE.Mesh(g.connectorGeo, m.connectorMat);
        powerIn.rotation.x = Math.PI / 2;
        powerIn.position.set(0.12, 0.04, -0.482);
        this.group.add(powerIn);
    }

    /**
     * Met à jour la position, l'orientation, le clignotement et la teinte optique du boîtier.
     * @param {THREE.Vector3} origin Position de la source laser
     * @param {number} angleDeg Angle horizontal de visée (degrés)
     * @param {number} strobeFactor Multiplicateur de clignotement [0, 1]
     * @param {THREE.Color|string} [colorHex] Couleur actuelle de l'émission laser
     */
    update(origin, angleDeg = 0, strobeFactor = 1.0, colorHex = null) {
        this.group.position.copy(origin);
        this.group.rotation.y = angleDeg * (Math.PI / 180);

        if (this.emissionLed && this.emissionLed.material) {
            this.emissionLed.material.emissiveIntensity = strobeFactor > 0.01 ? 2.2 : 0.08;
        }

        if (this.apertureMesh && this.apertureMesh.material) {
            if (colorHex) {
                this.apertureMesh.material.color.set(colorHex);
            }
            this.apertureMesh.material.opacity = strobeFactor > 0.01 ? 0.70 : 0.05;
        }
    }

    setVisible(visible) {
        this.group.visible = visible;
    }

    dispose() {
        this.scene.remove(this.group);
        if (this.emissionLed && this.emissionLed.material) {
            this.emissionLed.material.dispose();
        }
        if (this.apertureMesh && this.apertureMesh.material) {
            this.apertureMesh.material.dispose();
        }
    }
}
