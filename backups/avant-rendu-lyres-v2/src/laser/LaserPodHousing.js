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
 * OPTIMISÉ : tous les boîtiers de la scène sont dessinés par des InstancedMesh partagés
 * (1 draw call par matériau pour N lasers, 0 allocation GC par frame).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';


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


// ── Description des pièces du boîtier (espace local, identique au modèle d'origine) ──
// NOTE ESSENTIELLE SUR LE POSITIONNEMENT :
// Le point d'émission laser (pod.origin) est en (0, 0, 0) dans l'espace local.
// Les faisceaux et la nappe PAN se propagent vers Z >= 0.
// TOUTES les pièces opaques du boîtier sont donc strictement placées à Z <= -0.035m :
// aucune géométrie ne peut occlure ou découper le faisceau / la nappe.
const HALF_PI = Math.PI / 2;
function buildPartList() {
    const parts = [];
    const add = (geo, mat, x, y, z, rx = 0, rz = 0) => parts.push({ geo, mat, x, y, z, rx, rz });

    // 1. Corps principal du boîtier (centre à Z = -0.266m, face avant à Z = -0.056m)
    add('chassisGeo', 'chassisMat', 0, 0, -0.266);
    // 2. Cornières de protection sur les 4 arêtes verticales
    add('cornerGeo', 'bumperMat', -0.25, 0, -0.07);
    add('cornerGeo', 'bumperMat',  0.25, 0, -0.07);
    add('cornerGeo', 'bumperMat', -0.25, 0, -0.46);
    add('cornerGeo', 'bumperMat',  0.25, 0, -0.46);
    // 3. Façade avant découpée
    add('frontPlateGeo', 'frontPlateMat', 0, 0, -0.050);
    // 4. Cadre de la fenêtre de sortie optique
    add('apertureFrameGeo', 'frameMat', 0, 0, -0.043);
    // Vitre optique additive synchronisée avec le laser (pièce dynamique)
    add('apertureHoleGeo', 'glass', 0, 0, -0.049);
    // Volet de sécurité mécanique (safety shutter)
    add('shutterGeo', 'shutterMat', 0, 0.073, -0.042);
    // 5. Étiquette Danger Laser
    add('hazardGeo', 'hazardMat', -0.15, 0.01, -0.043);
    // 6. LEDs indicatrices : verte (interlock) et rouge (émission, pièce dynamique)
    add('ledGeo', 'greenLedMat', -0.15, -0.065, -0.043);
    add('ledGeo', 'redLed', -0.10, -0.065, -0.043);
    // 7. Ailettes de refroidissement sur les deux flancs
    for (const fy of [-0.07, -0.02, 0.03, 0.08]) {
        add('finGeo', 'finMat', -0.255, fy, -0.266);
        add('finGeo', 'finMat',  0.255, fy, -0.266);
    }
    // 8. Lyre de fixation (bras, barre, volants de serrage, crochet, truss)
    add('yokeArmGeo', 'yokeMat', -0.275, 0.11, -0.266);
    add('yokeArmGeo', 'yokeMat',  0.275, 0.11, -0.266);
    add('yokeBarGeo', 'yokeMat', 0, 0.245, -0.266);
    add('knobGeo', 'knobMat', -0.295, 0.01, -0.266, 0, HALF_PI);
    add('knobGeo', 'knobMat',  0.295, 0.01, -0.266, 0, HALF_PI);
    add('clampGeo', 'yokeMat', 0, 0.28, -0.266);
    add('trussTubeGeo', 'trussMat', 0, 0.32, -0.266, 0, HALF_PI);
    // 9. Panneau technique arrière (ventilation et connectique)
    add('fanGrilleGeo', 'connectorMat', -0.12, 0.02, -0.482, HALF_PI);
    add('connectorGeo', 'connectorMat',  0.10, -0.04, -0.482, HALF_PI);
    add('connectorGeo', 'connectorMat',  0.15, -0.04, -0.482, HALF_PI);
    add('connectorGeo', 'connectorMat',  0.12,  0.04, -0.482, HALF_PI);
    return parts;
}

function transformedPart(res, part) {
    const geo = res.geometries[part.geo].clone();
    const m = new THREE.Matrix4().compose(
        new THREE.Vector3(part.x, part.y, part.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(part.rx, 0, part.rz)),
        new THREE.Vector3(1, 1, 1)
    );
    geo.applyMatrix4(m);
    return geo;
}

/**
 * Instancieur partagé : dessine TOUS les boîtiers de la scène avec 1 InstancedMesh
 * par matériau (15 draw calls au total au lieu de 27 par laser).
 * Les matériaux et la géométrie sont exactement ceux du modèle d'origine.
 */
class HousingInstancer {
    constructor(scene) {
        this.scene = scene;
        const res = getSharedResources();
        const parts = buildPartList();

        // Regroupement des pièces par matériau → 1 géométrie fusionnée par matériau
        const byMat = new Map();
        const all = [];
        for (const part of parts) {
            const geo = transformedPart(res, part);
            all.push(geo.clone());
            if (!byMat.has(part.mat)) byMat.set(part.mat, []);
            byMat.get(part.mat).push(geo);
        }
        this._merged = new Map();
        for (const [mat, geos] of byMat) {
            this._merged.set(mat, mergeGeometries(geos, false));
            geos.forEach(g => g.dispose());
        }
        // Géométrie complète (invisible) utilisée pour la sélection au clic
        this.pickGeometry = mergeGeometries(all, false);
        all.forEach(g => g.dispose());
        this.pickMaterial = new THREE.MeshBasicMaterial({ visible: false });

        // Matériaux dynamiques
        this._glassMat = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 1.0,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        this._redOnMat = res.materials.redLedMat.clone();
        this._redOnMat.emissiveIntensity = 2.2;
        this._redOffMat = res.materials.redLedMat.clone();
        this._redOffMat.emissiveIntensity = 0.08;
        this._resMaterials = res.materials;

        this.capacity = 0;
        this.slots = [];      // LaserPodHousing | null
        this.meshes = null;   // { key: InstancedMesh }
        this._count = 0;
        this._dirtyMatrices = false;
        this._dirtyColors = false;
        this.zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
        this._build(32);
    }

    _materialFor(key) {
        if (key === 'glass') return this._glassMat;
        return this._resMaterials[key];
    }

    _build(capacity) {
        const old = this.meshes;
        const meshes = {};
        const add = (key, geo, mat) => {
            const im = new THREE.InstancedMesh(geo, mat, capacity);
            im.name = 'laser-housing-' + key;
            im.frustumCulled = false;
            im.matrixAutoUpdate = false;
            im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            im.count = 0;
            if (key === 'glass') {
                im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
                im.instanceColor.setUsage(THREE.DynamicDrawUsage);
            }
            if (old && old[key]) {
                im.instanceMatrix.array.set(old[key].instanceMatrix.array);
                if (old[key].instanceColor) im.instanceColor.array.set(old[key].instanceColor.array);
                this.scene.remove(old[key]);
                old[key].dispose();
            }
            this.scene.add(im);
            meshes[key] = im;
        };
        for (const [key, geo] of this._merged) {
            if (key === 'redLed') {
                add('redLedOn', geo, this._redOnMat);
                add('redLedOff', geo, this._redOffMat);
            } else {
                add(key, geo, this._materialFor(key));
            }
        }
        this.meshes = meshes;
        this._meshList = Object.values(meshes);
        this.capacity = capacity;
        this._dirtyMatrices = true;
        this._dirtyColors = true;
        this._applyCount();
    }

    allocSlot(housing) {
        let slot = this.slots.indexOf(null);
        if (slot === -1) {
            slot = this.slots.length;
            this.slots.push(null);
            if (slot >= this.capacity) this._build(this.capacity * 2);
        }
        this.slots[slot] = housing;
        this.writeSlot(slot, this.zeroMatrix, false, null);
        this._count = Math.max(this._count, slot + 1);
        this._applyCount();
        return slot;
    }

    freeSlot(slot) {
        this.slots[slot] = null;
        this.writeSlot(slot, this.zeroMatrix, false, null);
        while (this._count > 0 && this.slots[this._count - 1] === null) this._count--;
        this._applyCount();
    }

    _applyCount() {
        for (const im of this._meshList) im.count = this._count;
    }

    /** Écrit la matrice monde d'un boîtier dans toutes les pièces instanciées */
    writeSlot(slot, matrix, emitting, glassColor) {
        const m = this.meshes;
        for (const key in m) {
            if (key === 'redLedOn') m[key].setMatrixAt(slot, emitting ? matrix : this.zeroMatrix);
            else if (key === 'redLedOff') m[key].setMatrixAt(slot, emitting ? this.zeroMatrix : matrix);
            else m[key].setMatrixAt(slot, matrix);
        }
        if (glassColor) {
            m.glass.setColorAt(slot, glassColor);
            this._dirtyColors = true;
        }
        this._dirtyMatrices = true;
    }

    /** Envoie au GPU uniquement la portion utilisée, et seulement si quelque chose a changé */
    flush() {
        if (this._count === 0) return;
        if (this._dirtyMatrices) {
            for (const im of this._meshList) {
                im.instanceMatrix.clearUpdateRanges();
                im.instanceMatrix.addUpdateRange(0, this._count * 16);
                im.instanceMatrix.needsUpdate = true;
            }
            this._dirtyMatrices = false;
        }
        if (this._dirtyColors) {
            const c = this.meshes.glass.instanceColor;
            c.clearUpdateRanges();
            c.addUpdateRange(0, this._count * 3);
            c.needsUpdate = true;
            this._dirtyColors = false;
        }
    }
}

const _instancers = new WeakMap();
function getHousingInstancer(scene) {
    let inst = _instancers.get(scene);
    if (!inst) {
        inst = new HousingInstancer(scene);
        _instancers.set(scene, inst);
    }
    return inst;
}

/** Envoie au GPU les instances de boîtiers modifiées (1 fois par frame, après les updates) */
export function flushHousings(scene) {
    const inst = _instancers.get(scene);
    if (inst) inst.flush();
}

export class LaserPodHousing {
    /**
     * @param {THREE.Scene} scene
     */
    constructor(scene) {
        this.scene = scene;
        this._instancer = getHousingInstancer(scene);

        // Groupe de manipulation (gizmo, sélection) : le rendu est assuré par l'instancieur,
        // le groupe ne contient qu'un maillage invisible servant au raycast de sélection.
        this.group = new THREE.Group();
        this.group.name = 'laser-housing';
        this._pickMesh = new THREE.Mesh(this._instancer.pickGeometry, this._instancer.pickMaterial);
        this._pickMesh.name = 'laser-housing-pick';
        this.group.add(this._pickMesh);
        this.scene.add(this.group);

        this._visible = true;
        this._slot = this._instancer.allocSlot(this);
        this._lastMatrix = new THREE.Matrix4();
        this._lastMatrix.elements[0] = NaN; // force la première écriture
        this._lastEmitting = true;
        this._glassColor = new THREE.Color(0x0055ff);
        this._glassOut = new THREE.Color();
        this._lastGlass = new THREE.Color(-1, -1, -1);
    }

    /**
     * Met à jour la position, l'orientation, le clignotement et la teinte optique du boîtier.
     * @param {THREE.Vector3} origin Position de la source laser
     * @param {number} angleDeg Angle horizontal de visée (degrés)
     * @param {number} tiltDeg Inclinaison verticale de visée (degrés, > 0 vers le haut)
     * @param {number} strobeFactor Multiplicateur de clignotement [0, 1]
     * @param {THREE.Color|string} [colorHex] Couleur actuelle de l'émission laser
     */
    update(origin, angleDeg = 0, tiltDeg = 0, rollDeg = 0, strobeFactor = 1.0, colorHex = null) {
        if (!this.isBeingDragged) {
            this.group.position.copy(origin);
            this.group.rotation.set(
                -tiltDeg * (Math.PI / 180),
                angleDeg * (Math.PI / 180),
                rollDeg * (Math.PI / 180),
                'YXZ'
            );
        }
        this.group.updateMatrixWorld();

        if (colorHex) this._glassColor.set(colorHex);
        this._syncInstance(strobeFactor > 0.01);
    }

    _syncInstance(emitting) {
        if (!this._visible) return;
        // Vitre additive : couleur × opacité d'origine (0.70 en émission, 0.05 éteinte)
        const opacity = emitting ? 0.70 : 0.05;
        this._glassOut.copy(this._glassColor).multiplyScalar(opacity);
        const mw = this.group.matrixWorld;
        if (emitting === this._lastEmitting && this._glassOut.equals(this._lastGlass) && mw.equals(this._lastMatrix)) return;

        this._lastMatrix.copy(mw);
        this._lastEmitting = emitting;
        this._lastGlass.copy(this._glassOut);
        this._instancer.writeSlot(this._slot, mw, emitting, this._glassOut);
    }

    setVisible(visible) {
        this.group.visible = visible;
        if (this._visible === visible) return;
        this._visible = visible;
        if (!visible) {
            this._instancer.writeSlot(this._slot, this._instancer.zeroMatrix, false, null);
        } else {
            this._lastMatrix.elements[0] = NaN;
            this._syncInstance(this._lastEmitting);
        }
    }

    dispose() {
        this.scene.remove(this.group);
        this._instancer.freeSlot(this._slot);
    }
}
