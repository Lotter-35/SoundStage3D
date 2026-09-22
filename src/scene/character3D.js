/**
 * Character3D — Gestion complète du personnage 3D animé et de la caméra 3ème personne.
 *
 * Conception modulaire, propre et performante :
 * - Chargement asynchrone du modèle GLB (Xbot.glb avec squelette et animations).
 * - Machine à états d'animations avec cross-fade fluide (Idle, Walk, Run).
 * - Physique au sol (gravité, saut naturel avec vélocité verticale).
 * - Caméra 3ème personne orbitale avec bras virtuel fluide, collision sol et zoom molette.
 * - Bascule instantanée 1ère personne ↔ 3ème personne via la touche 'V' ou bouton HUD.
 * - Zéro allocation d'objets dans la boucle de rendu pour préserver 60+ FPS constants.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL_PATH = 'src/assets/models/character.glb';

// Constantes physiques
const PLAYER_EYE_HEIGHT = 1.7; // hauteur des yeux en mètres (vue 1ère personne)
const GRAVITY = 18;            // m/s²
const JUMP_VELOCITY = 5.2;     // m/s — impulsion de saut
const MODEL_SCALE = 1.0;       // échelle du modèle Xbot (1.80m de haut)

// Paramètres de la caméra 3ème personne
const DEFAULT_DISTANCE = 3.5;  // distance caméra ↔ personnage en mètres
const MIN_DISTANCE = 1.2;
const MAX_DISTANCE = 8.0;
const PITCH_MIN = -Math.PI / 2.5; // -72° (regarder vers le haut)
const PITCH_MAX = Math.PI / 3;    // +60° (regarder vers le bas)
const CAMERA_SMOOTHING = 16.0;   // réactivité du suivi fluide (lerp)

/**
 * Génère une texture d'ombre portée douce et anatomique pour le personnage (Canvas 2D optimisé).
 * Coût : exécuté 1 seule fois à l'initialisation (zéro impact par frame).
 */
function createCharacterShadowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, 128, 256);
    ctx.fillStyle = '#000000';

    // 1. Tête (cercle diffus avec pénombre)
    ctx.save();
    ctx.filter = 'blur(9px)';
    ctx.beginPath();
    ctx.arc(64, 40, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 2. Épaules et torse (ovales superposés avec flou moyen)
    ctx.save();
    ctx.filter = 'blur(7px)';
    ctx.beginPath();
    ctx.ellipse(64, 75, 24, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(64, 115, 18, 30, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 3. Jambes (deux capsules douces)
    ctx.save();
    ctx.filter = 'blur(5px)';
    ctx.beginPath();
    ctx.ellipse(54, 175, 9, 32, 0.04, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(74, 175, 9, 32, -0.04, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 4. Pieds / Contact Ambient Occlusion (points d'ancrage nets et denses)
    ctx.save();
    ctx.filter = 'blur(2.5px)';
    ctx.beginPath();
    ctx.ellipse(53, 222, 7, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(75, 222, 7, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 5. Dégradé de pénombre physique (l'ombre est plus nette au sol près des pieds, et s'adoucit vers le haut)
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, 'rgba(0,0,0,0.50)');  // Tête plus diffuse
    grad.addColorStop(0.4, 'rgba(0,0,0,0.72)');  // Torse
    grad.addColorStop(0.85, 'rgba(0,0,0,0.95)'); // Jambes
    grad.addColorStop(1.0, 'rgba(0,0,0,1.0)');   // Contact pieds à 100%
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 256);
    ctx.restore();

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
}

export class Character3D {
    /**
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     * @param {HTMLElement} domElement
     */
    constructor(scene, camera, domElement) {
        this.scene = scene;
        this.camera = camera;
        this.domElement = domElement || document.body;

        // État de vue : actif en 3ème personne par défaut
        this.isThirdPerson = true;
        this.enabled = true; // Actif lorsque characterMode est ON

        // Position logique du personnage dans le monde (FOH = 0, 0, 50)
        this.position = new THREE.Vector3(0, 0, 50);
        this.verticalVelocity = 0;
        this.onGround = true;
        this.isFlying = false;

        // Angle d'orientation du personnage (rotation Y en radians)
        // 0 = face à la scène (vers -Z)
        this.heading = 0;
        this.targetHeading = 0;

        // Angle orbital de la caméra (coordonnées sphériques)
        this.orbitYaw = 0;      // 0 = derrière le joueur à +Z, regardant vers -Z
        this.orbitPitch = 0.15; // légère vue plongeante
        this.cameraDistance = DEFAULT_DISTANCE;
        this.targetDistance = DEFAULT_DISTANCE;
        this.invertX = false;
        this.invertY = false;

        // Modèle 3D et animations
        this.model = null;
        this.mixer = null;
        this.actions = {};
        this.currentActionName = 'idle';
        this.isLoaded = false;

        // Ombre portée projetée (ultra-optimisée : 1 quad, 0 ms de coût GPU)
        this.shadowMesh = null;
        this._createShadowMesh();

        // Vecteurs et objets réutilisés (Zero GC allocation par frame)
        this._targetCameraPos = new THREE.Vector3();
        this._characterTarget = new THREE.Vector3();
        this._moveDir = new THREE.Vector3();
        this._lookDir = new THREE.Vector3();

        // Callbacks
        this._onCameraModeChange = null;

        // Écouteur de molette pour le zoom caméra
        this._onWheel = this._onWheel.bind(this);
        window.addEventListener('wheel', this._onWheel, { passive: true });

        // Démarrer le chargement du modèle
        this._loadModel();
    }

    /**
     * Crée le maillage d'ombre portée projetée alignée avec la lumière du soleil.
     */
    _createShadowMesh() {
        const texture = createCharacterShadowTexture();
        const shadowGeo = new THREE.PlaneGeometry(0.9, 1.6);
        shadowGeo.rotateX(-Math.PI / 2);
        shadowGeo.translate(0, 0, -0.8); // Aligne le centre de projection sur les pieds

        // Alignement avec la source lumineuse solaire principale (30, 60, 40)
        this._sunAngle = Math.atan2(-30, -40);

        const shadowMat = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            color: 0x05080c,
            opacity: 0.58,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
            side: THREE.DoubleSide,
        });

        this.shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
        this.shadowMesh.renderOrder = 2; // Rendu prioritaire directement sur le sol
        this.shadowMesh.rotation.y = this._sunAngle;
        this.shadowMesh.position.set(this.position.x, 0.02, this.position.z);
        this.shadowMesh.visible = this.enabled;
        this.scene.add(this.shadowMesh);
    }

    /**
     * Charge le modèle 3D .glb avec ses animations intégrées.
     */
    async _loadModel() {
        const loader = new GLTFLoader();
        try {
            console.log('[Character3D] Chargement du modèle 3D :', MODEL_PATH);
            const gltf = await loader.loadAsync(MODEL_PATH);
            this.model = gltf.scene;
            this.model.scale.set(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);

            // Activer les ombres portées et reçues sur tous les sous-meshes
            this.model.traverse((node) => {
                if (node.isMesh) {
                    node.castShadow = true;
                    node.receiveShadow = true;
                    if (node.material) {
                        node.material.roughness = 0.8;
                    }
                }
            });

            // Position et orientation initiale (Xbot regarde nativement vers +Z, donc +PI pour regarder la scène)
            this.model.position.copy(this.position);
            this.model.rotation.y = this.heading + Math.PI;
            this.model.visible = this.isThirdPerson && this.enabled;
            this.scene.add(this.model);

            // Initialiser l'AnimationMixer
            if (gltf.animations && gltf.animations.length > 0) {
                this.mixer = new THREE.AnimationMixer(this.model);

                // Enregistrer toutes les animations disponibles par leur nom normalisé
                for (const clip of gltf.animations) {
                    const name = clip.name.toLowerCase();
                    const action = this.mixer.clipAction(clip);
                    this.actions[name] = action;
                }

                // Démarrer l'animation idle par défaut
                if (this.actions['idle']) {
                    this.actions['idle'].play();
                    this.currentActionName = 'idle';
                }
            }

            this.isLoaded = true;
            console.log('[Character3D] Modèle 3D chargé avec succès ! Animations disponibles :', Object.keys(this.actions));

            if (this.isThirdPerson && this.enabled) {
                this._snapCamera();
            }
        } catch (err) {
            console.error('[Character3D] Erreur de chargement du modèle character.glb :', err);
        }
    }

    /**
     * Zoom caméra à la molette (en mode 3ème personne).
     */
    _onWheel(e) {
        if (!this.isThirdPerson || !this.enabled) return;
        const delta = Math.sign(e.deltaY) * 0.4;
        this.targetDistance = THREE.MathUtils.clamp(
            this.targetDistance + delta,
            MIN_DISTANCE,
            MAX_DISTANCE
        );
    }

    /**
     * Aligne instantanément la caméra sur sa position orbite calculée (sans lerp).
     */
    _snapCamera() {
        this._characterTarget.set(
            this.position.x,
            this.position.y + 1.45,
            this.position.z
        );
        const cosPitch = Math.cos(this.orbitPitch);
        const sinPitch = Math.sin(this.orbitPitch);
        const sinYaw = Math.sin(this.orbitYaw);
        const cosYaw = Math.cos(this.orbitYaw);
        const camX = this._characterTarget.x + this.cameraDistance * cosPitch * sinYaw;
        const camY = this._characterTarget.y + this.cameraDistance * sinPitch;
        const camZ = this._characterTarget.z + this.cameraDistance * cosPitch * cosYaw;

        this.camera.position.set(camX, Math.max(0.4, camY), camZ);
        this.camera.lookAt(this._characterTarget);
    }

    /**
     * Bascule entre 1ère personne et 3ème personne.
     * @param {boolean} [explicitState]
     */
    toggleCameraView(explicitState) {
        if (typeof explicitState === 'boolean') {
            this.isThirdPerson = explicitState;
        } else {
            this.isThirdPerson = !this.isThirdPerson;
        }

        if (this.model) {
            // Le modèle n'est visible que lorsqu'on est en vue 3ème personne ET mode personnage activé
            this.model.visible = this.isThirdPerson && this.enabled;
        }

        if (this.isThirdPerson && this.enabled) {
            this._snapCamera();
        }

        if (this._onCameraModeChange) {
            this._onCameraModeChange(this.isThirdPerson);
        }
    }

    /** Enregistrer un callback lors du changement de mode de caméra */
    onCameraModeChange(cb) {
        this._onCameraModeChange = cb;
    }

    /**
     * Réinitialise le personnage au sol (aligné sur la position actuelle de la caméra).
     * @param {THREE.Vector3} startPos
     * @param {number} [yaw]
     */
    snapToGround(startPos, yaw = 0) {
        if (startPos) {
            this.position.x = startPos.x;
            this.position.z = startPos.z;
        }
        this.position.y = 0;
        this.verticalVelocity = 0;
        this.onGround = true;
        this.orbitYaw = yaw;
        this.heading = yaw;
        this.targetHeading = yaw;

        if (this.model) {
            this.model.position.copy(this.position);
            this.model.rotation.y = this.heading + Math.PI;
            this.model.visible = this.isThirdPerson && this.enabled;
        }

        if (this.shadowMesh) {
            this.shadowMesh.position.set(this.position.x, 0.02, this.position.z);
            this.shadowMesh.scale.set(1, 1, 1);
            this.shadowMesh.material.opacity = 0.58;
            this.shadowMesh.visible = this.enabled;
        }

        if (this.isThirdPerson && this.enabled) {
            this._snapCamera();
        }
    }

    /**
     * Mettre à jour l'orientation orbitale avec le delta de la souris.
     * @param {number} movementX
     * @param {number} movementY
     * @param {number} sensitivity
     */
    handleMouseMove(movementX, movementY, sensitivity = 1.0) {
        const factor = 0.002 * sensitivity;
        const signX = this.invertX ? -1 : 1;
        const signY = this.invertY ? -1 : 1;
        this.orbitYaw -= movementX * factor * signX;
        this.orbitPitch += movementY * factor * signY;
        this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch, PITCH_MIN, PITCH_MAX);
    }

    /**
     * Transitionne doucement entre deux animations (cross-fade).
     * @param {string} newActionName
     * @param {number} duration — durée de transition en secondes
     */
    _fadeToAction(newActionName, duration = 0.2) {
        if (!this.mixer || this.currentActionName === newActionName) return;

        const previousAction = this.actions[this.currentActionName];
        const nextAction = this.actions[newActionName];

        if (!nextAction) return;

        nextAction.reset();
        nextAction.setEffectiveTimeScale(newActionName === 'walk' ? 1.15 : 1.0);
        nextAction.setEffectiveWeight(1);
        if (previousAction) {
            nextAction.crossFadeFrom(previousAction, duration, true);
        }
        nextAction.play();

        this.currentActionName = newActionName;
    }

    /**
     * Mise à jour globale appelée à chaque frame (y compris lorsque le pointeur est déverrouillé).
     *
     * @param {number} dt — delta time en secondes
     * @param {THREE.Vector2} [horizontalVelocity] — vitesse actuelle (x, z relatif caméra)
     * @param {boolean} [jumpInput=false] — commande de saut (Space)
     * @param {boolean} [isMoving=false] — vrai si le joueur avance/recule/latéral
     */
    update(dt, horizontalVelocity, jumpInput = false, isMoving = false) {
        // ── 1. Physique verticale (Saut & Gravité ou Vol) ───────────
        if (this.isFlying) {
            // En mode vol, pas de gravité terrestre ; la hauteur y est gérée par les contrôles
            this.onGround = false;
            this.verticalVelocity = 0;
            if (this.position.y < 0) {
                this.position.y = 0;
            }
        } else {
            if (jumpInput && this.onGround) {
                this.verticalVelocity = JUMP_VELOCITY;
                this.onGround = false;
            }

            if (!this.onGround) {
                this.verticalVelocity -= GRAVITY * dt;
                this.position.y += this.verticalVelocity * dt;

                // Collision avec le sol (y = 0)
                if (this.position.y <= 0) {
                    this.position.y = 0;
                    this.verticalVelocity = 0;
                    this.onGround = true;
                }
            } else {
                this.position.y = 0;
            }
        }

        // ── 2. Orientation du personnage ─────────────────────────────
        const vx = horizontalVelocity ? horizontalVelocity.x : 0;
        const vz = horizontalVelocity ? horizontalVelocity.y : 0;
        const speedSq = vx * vx + vz * vz;
        const currentSpeed = Math.sqrt(speedSq);

        if (isMoving && currentSpeed > 0.1) {
            // Calculer la direction de déplacement dans le plan XZ mondial
            // vx > 0 (droite), vz > 0 (avant) -> l'angle d'orientation doit pointer vers la direction de marche
            const moveAngle = Math.atan2(-vx, vz);
            this.targetHeading = this.orbitYaw + moveAngle;

            // Interpolation angulaire lisse sans inversion à ±PI
            let diff = this.targetHeading - this.heading;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            this.heading += diff * Math.min(1.0, dt * 14.0);
        }

        // ── 3. Synchronisation du modèle 3D ──────────────────────────
        if (this.model) {
            this.model.position.copy(this.position);
            this.model.rotation.y = this.heading + Math.PI;

            // ── 4. Machine à états d'animations ──────────────────────
            if (this.mixer) {
                if (this.isFlying) {
                    // En vol : courir/planer si déplacement, sinon animation douce en suspension
                    if (isMoving && currentSpeed > 0.1) {
                        if (this.actions['run']) {
                            this._fadeToAction('run', 0.2);
                        } else if (this.actions['walk']) {
                            this._fadeToAction('walk', 0.2);
                        }
                    } else {
                        if (this.actions['idle']) {
                            this._fadeToAction('idle', 0.25);
                        }
                    }
                } else if (!this.onGround) {
                    // En l'air (saut) : déclencher la pose de saut / course dynamique
                    if (this.actions['run']) {
                        this._fadeToAction('run', 0.15);
                    } else if (this.actions['walk']) {
                        this._fadeToAction('walk', 0.15);
                    }
                } else if (isMoving && currentSpeed > 0.2) {
                    // Au sol et en déplacement : sprint si > 6.0 m/s sinon marche
                    if (currentSpeed > 6.0 && this.actions['run']) {
                        this._fadeToAction('run', 0.2);
                    } else if (this.actions['walk']) {
                        this._fadeToAction('walk', 0.2);
                    }
                } else {
                    // À l'arrêt : idle breathing
                    if (this.actions['idle']) {
                        this._fadeToAction('idle', 0.25);
                    }
                }

                // Avancement temporel de l'animation
                this.mixer.update(dt);
            }
        }

        // ── 5. Positionnement de la caméra ───────────────────────────
        this.cameraDistance += (this.targetDistance - this.cameraDistance) * Math.min(1.0, dt * 12.0);

        if (this.isThirdPerson) {
            // Point cible (hauteur de la poitrine / tête du personnage)
            this._characterTarget.set(
                this.position.x,
                this.position.y + 1.45,
                this.position.z
            );

            // Coordonnées sphériques orbitales par rapport au personnage
            const cosPitch = Math.cos(this.orbitPitch);
            const sinPitch = Math.sin(this.orbitPitch);
            const sinYaw = Math.sin(this.orbitYaw);
            const cosYaw = Math.cos(this.orbitYaw);

            const camX = this._characterTarget.x + this.cameraDistance * cosPitch * sinYaw;
            const camY = this._characterTarget.y + this.cameraDistance * sinPitch;
            const camZ = this._characterTarget.z + this.cameraDistance * cosPitch * cosYaw;

            this._targetCameraPos.set(
                camX,
                Math.max(0.4, camY), // Empêcher la caméra de passer sous le sol
                camZ
            );

            // Positionnement direct de la caméra (rigide, sans dérive angulaire lors des strafes)
            this.camera.position.copy(this._targetCameraPos);
            this.camera.lookAt(this._characterTarget);
        } else {
            // Mode 1ère personne : caméra positionnée exactement aux yeux du joueur
            this.camera.position.set(
                this.position.x,
                this.position.y + PLAYER_EYE_HEIGHT,
                this.position.z
            );
        }

        // ── 6. Mise à jour de l'ombre portée projetée ─────────────────
        if (this.shadowMesh) {
            // Détection du niveau du sol (herbe = 0, estrade scène = 3.0)
            let groundY = 0;
            if (this.position.x >= -15 && this.position.x <= 15 && this.position.z >= -10 && this.position.z <= 0) {
                groundY = 3.0;
            }

            const h = Math.max(0, this.position.y - groundY);

            // Masquer l'ombre si on vole trop haut (> 30m) ou si le mode personnage est désactivé
            if (!this.enabled || (this.isFlying && this.position.y > 30)) {
                this.shadowMesh.visible = false;
            } else {
                this.shadowMesh.visible = true;

                // Projection de la position des pieds au sol selon le vecteur solaire (30, 60, 40)
                const shadowX = this.position.x - h * 0.5;
                const shadowZ = this.position.z - h * 0.667;
                const shadowY = groundY + 0.02;

                this.shadowMesh.position.set(shadowX, shadowY, shadowZ);

                // Élargissement et adoucissement physique lorsque le personnage saute
                const scale = 1.0 + Math.min(0.8, h * 0.12);
                this.shadowMesh.scale.set(scale, 1.0, scale);
                this.shadowMesh.material.opacity = Math.max(0.08, 0.58 / (1.0 + h * 0.35));
            }
        }
    }

    /** Nettoyage des ressources */
    dispose() {
        window.removeEventListener('wheel', this._onWheel);
        if (this.model) {
            this.scene.remove(this.model);
        }
        if (this.shadowMesh) {
            this.scene.remove(this.shadowMesh);
            if (this.shadowMesh.geometry) this.shadowMesh.geometry.dispose();
            if (this.shadowMesh.material) {
                if (this.shadowMesh.material.map) this.shadowMesh.material.map.dispose();
                this.shadowMesh.material.dispose();
            }
        }
        if (this.mixer) {
            this.mixer.stopAllAction();
        }
    }
}
