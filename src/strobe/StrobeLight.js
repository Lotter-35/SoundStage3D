/**
 * StrobeLight.js
 * ─────────────────────────────────────────────────────────────
 * Projecteur Stroboscope 3D professionnel pour SoundStage3D :
 * - Boîtier physique 3D réaliste (châssis métallique noir de scène, étrier de fixation, cadre avant),
 *   dessiné avec ceux de tous les stroboscopes par StrobeHousingInstancer (5 appels au total).
 * - Écran frontal émissif ultra-lumineux (blanc pur par défaut, bloom layer).
 * - Éclairage réel de la scène délégué au StrobeLightPool (pool fixe de SpotLight partagé) :
 *   ce fichier ne crée aucune lumière, il fournit l'état du flash et la géométrie du faisceau.
 * - Normalisation de la puissance : la puissance lumineuse reste constante quelle que soit la taille du boîtier !
 * - Animation stroboscopique temps réel fluide (fréquence Hz, durée de flash, mode aléatoire).
 * - Orientation complète (Angle, Tilt, Roll) et compatibilité Gizmo TransformControls.
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { getStrobeHousingInstancer } from './StrobeHousingInstancer.js';

// Boîte invisible de sélection à la souris (partagée : jamais dessinée, seulement lancée de rayons)
const _pickMaterial = new THREE.MeshBasicMaterial({ visible: false });

export class StrobeLight {
    /**
     * @param {object} options
     * @param {number} options.id Identifiant unique
     * @param {THREE.Scene} options.scene
     * @param {THREE.Vector3} [options.position]
     * @param {object} [options.params]
     */
    constructor({ id, number, scene, position = new THREE.Vector3(0, 8, -5), params = {}, emit = null }) {
        this.id = id;
        this.number = number !== undefined ? number : id; // numéro d'affichage (local)
        this.scene = scene;
        // Émission multijoueur (fournie par le StrobeManager) — inactive pendant la construction
        this._emit = emit;
        this._ready = false;

        // Paramètres par défaut
        this.params = {
            // ── Éclairage ──
            power:           45.0,        // Puissance lumineuse (0 à 100)
            color:           '#ffffff',   // Blanc éclatant ultra-lumineux par défaut
            emissivePower:   3.5,         // Éclat de l'écran frontal (Bloom, 0 à 100)
            castShadow:      true,        // Ombres portées dynamiques
            shadowIntensity: 1.0,         // Intensité des ombres (obscurité du noir)
            shadowSoftness:  0.5,         // Douceur des bords d'ombre (0 = net, 1 = très flou)
            distanceFactor:  10.0,        // Facteur multiplicateur de portée (la portée s'adapte à la taille du stroboscope)

            // ── Dimensions du boîtier ──
            showHousing:     true,        // Boîtier 3D complet (si false ou width<=0, uniquement plan 2D)
            width:           1.20,        // Largeur (0 à 50 mètres)
            height:          0.38,        // Hauteur (0.10 à 50 mètres)
            depth:           0.24,        // Profondeur / Épaisseur (mètres)

            // ── Effet Stroboscope ──
            strobeEnabled:   true,        // Stroboscope activé (si false, lumière continue)
            strobeSpeed:     12.0,        // Fréquence stroboscopique (Hz : 0.5 à 30 Hz)
            pulseWidth:      50.0,        // Durée du flash (% de la période : 1% à 100%)
            strobeRandom:    false,       // Mode éclairs aléatoires

            // ── Position & Orientation ──
            posX:            position.x,
            posY:            position.y,
            posZ:            position.z,
            angle:           0,           // Angle horizontal (-180° à 180°)
            tilt:            0,           // Légère plongée vers la scène / public (-90° à 90°)
            roll:            0,           // Rotation axiale (-180° à 180°)
            ...params
        };

        // État interne de l'animation
        this._strobeTimer = 0;
        this.flash = false;
        this._randomNextFlash = 0;
        this._randomFlashDuration = 0;

        // Groupe racine pour la position, la rotation et le Gizmo
        this.group = new THREE.Group();
        this.group.name = `Strobe_${this.id}`;
        this.group.userData.isStrobeFixture = true;
        this.group.userData.strobeId = this.id;
        this.group.userData.strobeInstance = this;

        // Boîte de sélection (invisible) ; le boîtier visible est dessiné par l'instancieur partagé
        this.pickMesh = null;
        this.flash = false;
        this.screenColor = new THREE.Color();
        this._instancer = getStrobeHousingInstancer(scene);

        // Construction initiale
        this._buildMeshes();

        // Position & Orientation initiales
        this.setPosition(this.params.posX, this.params.posY, this.params.posZ);
        this.setRotation(this.params.angle, this.params.tilt, this.params.roll);

        this.scene.add(this.group);
        this._instancer.add(this);
        this._ready = true;
    }

    /** Envoie une modification aux autres joueurs (ignoré pendant l'application d'un message reçu) */
    _sync(data) {
        if (this._ready && this._emit) this._emit({ category: 'strobe_update', id: this.id, data });
    }

    /**
     * Calcule la portée effective de la lumière :
     * La portée de base est calculée automatiquement à partir de la taille du stroboscope
     * (largeur / hauteur), puis modulée par le slider de portée relative 'distanceFactor'.
     */
    getEffectiveLightDistance() {
        const span = Math.max(0.2, Math.max(this.params.width || 1.2, this.params.height || 0.38));
        // Base de portée liée à la taille physique du projecteur :
        // 1.2m -> ~36m, 5m -> ~72m, 10m -> ~120m, 50m -> ~500m
        const baseDistance = 25.0 + span * 9.5;
        const factor = (this.params.distanceFactor !== undefined)
            ? this.params.distanceFactor
            : ((this.params.lightDistance !== undefined && this.params.lightDistance <= 10.0) ? this.params.lightDistance : 1.0);
        return Math.max(2.0, baseDistance * factor);
    }

    /**
     * Calcule la puissance lumineuse effective :
     * Suit une échelle purement logarithmique selon la surface (largeur x hauteur) du stroboscope :
     * Plus le stroboscope est grand, plus la lumière est puissante, tout en restant parfaitement
     * maîtrisée et naturelle même à des tailles géantes (ex: 50m).
     */
    getEffectiveIntensity() {
        const p = this.params;
        const standardArea = 1.20 * 0.38; // 0.456 m² (taille physique de référence)
        const area = Math.max(0.02, p.width) * Math.max(0.02, p.height);
        const ratio = area / standardArea;

        // Fonction logarithmique normalisée : log(1 + c * ratio) / log(1 + c)
        // - À taille standard (ratio = 1.0) : multiplicateur = 1.0x (valeur nominale exacte)
        // - À taille moyenne (ex: 5m x 2m) : ~3.5x
        // - À taille maximale (50m x 50m) : ~9.8x (au lieu de 600x+, évitant toute surexposition aveuglante)
        const c = 1.5;
        const logMultiplier = Math.max(0.1, Math.log(1.0 + c * ratio) / Math.log(1.0 + c));

        return p.power * 2.0 * logMultiplier;
    }

    /**
     * Position monde de la source du faisceau (devant la face émissive) et de sa cible, pour le pool de lumières
     * @param {THREE.Vector3} outPos
     * @param {THREE.Vector3} outTarget
     */
    getLightSetup(outPos, outTarget) {
        const w = this.params.width;
        const isFlat = (this.params.showHousing === false) || (w <= 0.05);
        const d = isFlat ? 0.01 : this.params.depth;
        const frameThick = isFlat ? 0.0 : 0.035;
        const zFront = d * 0.5 + frameThick + 0.01;
        this.group.updateWorldMatrix(true, false);
        outPos.set(0, 0, zFront).applyMatrix4(this.group.matrixWorld);
        outTarget.set(0, 0, zFront + this.getEffectiveLightDistance()).applyMatrix4(this.group.matrixWorld);
    }

    /**
     * Construit / reconstruit la boîte de sélection du stroboscope (le boîtier visible est instancié et
     * suit automatiquement les dimensions, voir StrobeHousingInstancer)
     */
    _buildMeshes() {
        const w = this.params.width;
        const h = this.params.height;
        const d = this.params.depth;
        const isFlat = (this.params.showHousing === false) || (w <= 0.05);

        if (this.pickMesh) {
            this.group.remove(this.pickMesh);
            this.pickMesh.geometry.dispose();
            this.pickMesh = null;
        }
        let geo;
        if (isFlat) {
            const effW = w > 0.05 ? w : Math.max(0.5, h);
            geo = new THREE.BoxGeometry(effW, Math.max(0.05, h), 0.02);
        } else {
            // Enveloppe du châssis, du cadre avant et de l'étrier
            const frontZ = d * 0.5 + 0.035;
            geo = new THREE.BoxGeometry(w + 0.12, h + 0.03, Math.max(d * 1.15, d * 0.5 + frontZ));
            geo.translate(0, 0, (frontZ - d * 0.5) * 0.5);
        }
        this.pickMesh = new THREE.Mesh(geo, _pickMaterial);
        this.pickMesh.name = 'strobe-pick';
        this.pickMesh.userData.strobeInstance = this;
        this.group.add(this.pickMesh);
    }

    /**
     * Applique une valeur de paramètre
     */
    setParam(key, value) {
        this.params[key] = value;

        switch (key) {
            case 'color':
                break; // lue à chaque image (couleur d'instance de l'écran)

            case 'width':
            case 'height':
            case 'depth':
            case 'showHousing':
                this._buildMeshes();
                break;

            case 'castShadow':
            case 'shadowIntensity':
            case 'shadowSoftness':
            case 'distanceFactor':
            case 'lightDistance':
                // Lus en temps réel par le StrobeLightPool
                break;

            case 'angle':
            case 'tilt':
            case 'roll':
                this.setRotation(this.params.angle, this.params.tilt, this.params.roll);
                break;

            case 'posX':
            case 'posY':
            case 'posZ':
                this.setPosition(this.params.posX, this.params.posY, this.params.posZ);
                return; // synchronisé par setPosition
        }
        if (key === 'angle' || key === 'tilt' || key === 'roll') return; // synchronisé par setRotation
        this._sync({ [key]: value });
    }

    /**
     * Règle la position dans l'espace 3D
     */
    setPosition(x, y, z) {
        this.params.posX = x;
        this.params.posY = y;
        this.params.posZ = z;
        this.group.position.set(x, y, z);
        this._sync({ posX: x, posY: y, posZ: z });
    }

    /**
     * Règle l'orientation (Yaw / Pitch / Roll en degrés)
     */
    setRotation(angleDeg, tiltDeg, rollDeg) {
        this.params.angle = angleDeg;
        this.params.tilt = tiltDeg;
        this.params.roll = rollDeg;

        const euler = new THREE.Euler(
            THREE.MathUtils.degToRad(tiltDeg),
            THREE.MathUtils.degToRad(angleDeg),
            THREE.MathUtils.degToRad(rollDeg),
            'YXZ'
        );
        this.group.quaternion.setFromEuler(euler);
        this._sync({ angle: angleDeg, tilt: tiltDeg, roll: rollDeg });
    }

    /**
     * Synchronise les paramètres d'angle depuis le Gizmo TransformControls
     */
    syncRotationFromGizmo() {
        const euler = new THREE.Euler().setFromQuaternion(this.group.quaternion, 'YXZ');
        this.params.tilt  = Math.round(THREE.MathUtils.radToDeg(euler.x) * 10) / 10;
        this.params.angle = Math.round(THREE.MathUtils.radToDeg(euler.y) * 10) / 10;
        this.params.roll  = Math.round(THREE.MathUtils.radToDeg(euler.z) * 10) / 10;
        this._sync({ angle: this.params.angle, tilt: this.params.tilt, roll: this.params.roll });
    }

    /**
     * Synchronise la position depuis le Gizmo TransformControls
     */
    syncPositionFromGizmo() {
        this.params.posX = Math.round(this.group.position.x * 100) / 100;
        this.params.posY = Math.round(this.group.position.y * 100) / 100;
        this.params.posZ = Math.round(this.group.position.z * 100) / 100;
        this._sync({ posX: this.params.posX, posY: this.params.posY, posZ: this.params.posZ });
    }

    /**
     * Met à jour le clignotement du stroboscope chaque frame
     * @param {number} dt Delta time en secondes
     */
    update(dt) {
        const p = this.params;
        let isFlash = false;

        if (!p.strobeEnabled) {
            // Mode continu (lumière allumée en permanence)
            isFlash = true;
        } else {
            this._strobeTimer += dt;

            if (p.strobeRandom) {
                // Mode stroboscopique aléatoire (éclairs d'orage)
                if (this._strobeTimer > this._randomNextFlash) {
                    this._randomFlashDuration = 0.025 + Math.random() * 0.04;
                    const interval = (Math.random() * 0.45 + 0.05) / Math.max(0.1, p.strobeSpeed / 6);
                    this._randomNextFlash = this._strobeTimer + interval;
                }
                const timeInFlash = this._randomNextFlash - this._strobeTimer;
                isFlash = timeInFlash < this._randomFlashDuration;
            } else {
                // Mode stroboscopique régulier (cadence précise en Hz)
                const freq = Math.max(0.1, p.strobeSpeed);
                const period = 1.0 / freq;
                const phase = (this._strobeTimer % period) / period;
                const dutyCycle = Math.max(0.01, Math.min(1.0, p.pulseWidth / 100));
                isFlash = (dutyCycle >= 0.999) || (phase < dutyCycle);
            }
        }

        this.flash = isFlash;

        // L'éclairage réel (intensité, ombre) est appliqué par le StrobeLightPool à partir de `flash` ;
        // l'écran (couleur × éclat pendant le flash, réflecteur éteint sinon) par l'instancieur des boîtiers
        if (isFlash) this.screenColor.set(p.color).multiplyScalar(Math.max(1.0, p.emissivePower || 2.0));
    }

    /**
     * Retourne tous les meshes du projecteur pour le raycasting de sélection
     */
    getPickableObjects() {
        return this.pickMesh ? [this.pickMesh] : [];
    }

    /**
     * Nettoyage complet
     */
    dispose() {
        this._instancer.remove(this);
        if (this.group.parent) {
            this.group.parent.remove(this.group);
        }
        if (this.pickMesh) this.pickMesh.geometry.dispose();
    }
}
