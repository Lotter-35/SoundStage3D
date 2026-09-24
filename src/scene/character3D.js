/**
 * Character3D — Gestion complète du personnage 3D animé et de la caméra 3ème personne.
 *
 * Conception modulaire, propre et performante :
 * - Chargement asynchrone du modèle GLB (Xbot.glb avec squelette et animations).
 * - Machine à états d'animations avec cross-fade fluide (Idle, Walk, Run).
 * - Physique au sol (gravité, saut naturel avec vélocité verticale).
 * - Caméra 3ème personne orbitale avec bras virtuel fluide, collision sol et zoom molette.
 * - Bascule instantanée 1ère personne ↔ 3ème personne via la touche 'V' ou bouton HUD.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { getGroundHeight } from './collision.js';
import { DanceManager } from './DanceManager.js';

const MODEL_PATH = 'src/assets/models/Ybot.fbx';

// Constantes physiques
const PLAYER_EYE_HEIGHT = 1.7; // hauteur des yeux en mètres (vue 1ère personne)
const GRAVITY = 18;            // m/s²
const JUMP_VELOCITY = 5.2;     // m/s — impulsion de saut
const MODEL_SCALE = 1.0;       // échelle du modèle (1.80m de haut)

// Paramètres de la caméra 3ème personne
const DEFAULT_DISTANCE = 3.5;  // distance caméra ↔ personnage en mètres
const MIN_DISTANCE = 1.2;
const MAX_DISTANCE = 8.0;
const PITCH_MIN = -Math.PI / 2.5; // -72° (regarder vers le haut)
const PITCH_MAX = Math.PI / 3;    // +60° (regarder vers le bas)
const CAMERA_SMOOTHING = 16.0;   // réactivité du suivi fluide (lerp)

// Vitesse de lecture des animations de locomotion (évite le glissement des pieds / sliding)
const WALK_ANIM_SPEED          = 1.55;  // 1.55x pour synchroniser les pas avec la vitesse physique de 4.0 m/s
const RUN_ANIM_SPEED           = 1.35;  // 1.35x pour synchroniser la foulée avec le sprint de 8.5 m/s
const WALK_BACKWARD_ANIM_SPEED = 1.30;  // 1.30x pour la marche arrière ralentie à 2.4 m/s

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
        this.isSitting = false;

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
        this.currentDanceId = null;
        this.danceRestartCounter = 0;
        this.isLoaded = false;

        // États spéciaux pour l'animation Dying & relevage Standing Up
        this.isDead = false;
        this.isGettingUp = false;
        this.isFrozenGround = false; // Vrai dès que le corps touche le sol lors de Dying
        this._dyingStartTime = 0;

        // Vecteurs et objets réutilisés (Zero GC allocation par frame)
        this._targetCameraPos = new THREE.Vector3();
        this._characterTarget = new THREE.Vector3();
        this._moveDir = new THREE.Vector3();
        this._lookDir = new THREE.Vector3();

        // Callbacks
        this._onCameraModeChange = null;
        this._onDanceStop = null;

        // Écouteur de molette pour le zoom caméra
        this._onWheel = this._onWheel.bind(this);
        window.addEventListener('wheel', this._onWheel, { passive: true });

        // Démarrer le chargement du modèle
        this._loadModel();
    }

    /**
     * Charge le modèle 3D .glb ou .fbx avec son animation idle intégrée.
     */
    async _loadModel() {
        try {
            console.log('[Character3D] Chargement du modèle 3D :', MODEL_PATH);
            const isFbx = MODEL_PATH.toLowerCase().endsWith('.fbx');
            let loadedScene, animations = [];

            if (isFbx) {
                const fbxLoader = new FBXLoader();
                const fbx = await fbxLoader.loadAsync(MODEL_PATH);
                loadedScene = fbx;
                animations = fbx.animations || [];
                // Dans Three.js, les FBX Mixamo/Blender sont généralement en centimètres (scale 0.01 = 1 mètre)
                const fbxScale = 0.01 * MODEL_SCALE;
                loadedScene.scale.set(fbxScale, fbxScale, fbxScale);
            } else {
                const gltfLoader = new GLTFLoader();
                const gltf = await gltfLoader.loadAsync(MODEL_PATH);
                loadedScene = gltf.scene;
                animations = gltf.animations || [];
                loadedScene.scale.set(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE);
            }

            this.model = loadedScene;

            // Activer les ombres portées et reçues sur tous les sous-meshes
            this.model.traverse((node) => {
                if (node.isMesh) {
                    node.castShadow = true;
                    node.receiveShadow = true;
                    node.frustumCulled = false;
                    if (node.material) {
                        if (Array.isArray(node.material)) {
                            node.material.forEach(m => { m.roughness = 0.8; });
                        } else {
                            node.material.roughness = 0.8;
                        }
                    }
                }
            });

            // Position et orientation initiale (regarde nativement vers +Z, donc +PI pour regarder la scène)
            this.model.position.copy(this.position);
            this.model.rotation.y = this.heading + Math.PI;
            this.model.visible = this.isThirdPerson && this.enabled;
            this.scene.add(this.model);

            // Initialiser l'AnimationMixer
            this.mixer = new THREE.AnimationMixer(this.model);
            this.mixer.addEventListener('finished', (e) => {
                // Fin de l'animation de relevage Standing Up
                if (this.actions['standing_up'] && e.action === this.actions['standing_up']) {
                    this.isGettingUp = false;
                    this.isDead = false;
                    this.isFrozenGround = false;
                    this.currentDanceId = null;
                    if (this.actions['idle']) {
                        this._fadeToAction('idle', 0.2);
                    }
                    if (this._onDanceStop) {
                        try { this._onDanceStop(); } catch (err) {}
                    }
                    if (this._onDanceChange) {
                        try { this._onDanceChange(null); } catch (err) {}
                    }
                    return;
                }

                // Pour Dying : ne pas appeler stopDance() en fin d'animation afin de rester figé au sol sur la dernière frame !
                if (this.currentDanceId && this.currentDanceId.toLowerCase().includes('dying')) {
                    this.isDead = true;
                    this.isFrozenGround = true;
                    return;
                }

                if (this.currentDanceId && e.action === this.actions[this.currentDanceId]) {
                    this.stopDance();
                }
            });

            // Charger l'animation idle intégrée dans le modèle Ybot
            if (animations && animations.length > 0) {
                for (const clip of animations) {
                    const name = clip.name.toLowerCase();
                    // Retirer les tracks de position pour éviter tout drift de Root Motion
                    clip.tracks = clip.tracks.filter(t => !t.name.toLowerCase().includes('position'));
                    const action = this.mixer.clipAction(clip);
                    this.actions[name] = action;
                }
                // Enregistrer explicitement la première animation intégrée sous la clé 'idle'
                const idleClip = animations[0];
                idleClip.name = 'idle';
                const idleAction = this.mixer.clipAction(idleClip);
                this.actions['idle'] = idleAction;
            }

            // Charger les animations de locomotion : marche (Standard Walk), course (Running) et marche arrière (walking-backward)
            const fbxLoader = new FBXLoader();
            const locoFiles = [
                {
                    name: 'walk',
                    files: [
                        'src/assets/animations/Standard Walk.fbx',
                        'src/assets/animations/locomotion/walking.fbx'
                    ]
                },
                {
                    name: 'run',
                    files: [
                        'src/assets/animations/Running.fbx',
                        'src/assets/animations/locomotion/running.fbx'
                    ]
                },
                {
                    name: 'walk-backward',
                    files: [
                        'src/assets/animations/locomotion/walking-backward.fbx',
                        'src/assets/animations/walking-backward.fbx'
                    ]
                },
                {
                    name: 'sitting',
                    files: [
                        'src/assets/animations/locomotion/sitting.fbx'
                    ]
                },
                {
                    name: 'standing_up',
                    files: [
                        'src/assets/animations/dance/Standing Up.fbx',
                        'src/assets/animations/Standing Up.fbx'
                    ]
                }
            ];

            await Promise.all(locoFiles.map(async ({ name, files }) => {
                for (const file of files) {
                    try {
                        const animFbx = await fbxLoader.loadAsync(file);
                        if (animFbx.animations && animFbx.animations.length > 0) {
                            const rawClip = animFbx.animations[0];
                            const clip = DanceManager._retargetClip(rawClip, this.model, animFbx);
                            clip.name = name;

                            // IMPÉRATIF : Supprimer les pistes de position sur la marche et la course (Root Motion).
                            // Pour 'sitting' et 'standing_up', DanceManager._retargetClip conserve déjà uniquement la hauteur Y des Hips
                            // et recentre X et Z, ce qui permet au personnage d'être au niveau du sol sans glisser ni flotter !
                            if (name !== 'sitting' && name !== 'standing_up') {
                                clip.tracks = clip.tracks.filter(t => !t.name.toLowerCase().includes('position'));
                            }

                            const action = this.mixer.clipAction(clip);
                            if (name === 'sitting' || name === 'standing_up') {
                                action.clampWhenFinished = true;
                                if (name === 'standing_up') {
                                    action.setLoop(THREE.LoopOnce, 1);
                                }
                            }
                            const animSpeed = (name === 'walk') ? WALK_ANIM_SPEED : (name === 'run') ? RUN_ANIM_SPEED : (name === 'walk-backward') ? WALK_BACKWARD_ANIM_SPEED : 1.0;
                            action.setEffectiveTimeScale(animSpeed);
                            this.actions[name] = action;
                            console.log(`[Character3D] Animation locomotion '${name}' chargée (${clip.tracks.length} pistes, vitesse ${animSpeed}x) depuis ${file}`);
                            break;
                        }
                    } catch (e) {
                        console.warn(`[Character3D] Erreur chargement animation locomotion '${name}' depuis ${file} :`, e);
                    }
                }
            }));

            // Démarrer l'animation idle par défaut
            const defaultAnim = this.actions['idle'] || Object.values(this.actions)[0];
            if (defaultAnim) {
                defaultAnim.play();
                this.currentActionName = 'idle';
            }

            this.isLoaded = true;
            console.log('[Character3D] Modèle 3D chargé avec succès ! Animations disponibles :', Object.keys(this.actions));

            if (this._colorHex) {
                this.setColor(this._colorHex);
            }

            if (this.isThirdPerson && this.enabled) {
                this._snapCamera();
            }
        } catch (err) {
            console.error('[Character3D] Erreur de chargement du modèle 3D :', err);
        }
    }

    /**
     * Applique une teinte de couleur au modèle du joueur.
     * @param {string|number} hex
     */
    setColor(hex) {
        this._colorHex = hex;
        if (!this.model) return;
        const tint = new THREE.Color(hex);
        this.model.traverse((node) => {
            if (node.isMesh && node.material) {
                const applyTint = (mat) => {
                    const m = mat.clone();
                    m.color.multiply(tint);
                    m.roughness = 0.8;
                    return m;
                };
                node.material = Array.isArray(node.material)
                    ? node.material.map(applyTint)
                    : applyTint(node.material);
            }
        });
    }

    /**
     * Détermine si la caméra est orientée dans les 180° devant le personnage (arc frontal).
     * @returns {boolean}
     */
    isCameraFacingFront() {
        let diff = (this.orbitYaw - this.heading) % (Math.PI * 2);
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        return Math.abs(diff) <= (Math.PI / 2); // true si dans les 180° devant [-90°, +90°]
    }

    /**
     * Zoom caméra à la molette (en mode 3ème personne).
     */
    _onWheel(e) {
        if (!this.isThirdPerson || !this.enabled) return;
        // Désactiver le zoom caméra si la molette est utilisée sur une interface ou une liste
        if (e.target && (
            e.target.closest('#playback-bar-wrap, #pb-queue-container, .emote-window, #emote-window, .lil-gui, #hud, #overlay, #chat-container') ||
            (e.target !== document.getElementById('canvas') && e.target !== document.body)
        )) {
            return;
        }
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
        const animSpeed = (newActionName === 'walk') ? WALK_ANIM_SPEED : (newActionName === 'run') ? RUN_ANIM_SPEED : (newActionName === 'walk-backward') ? WALK_BACKWARD_ANIM_SPEED : 1.0;
        nextAction.setEffectiveTimeScale(animSpeed);
        nextAction.setEffectiveWeight(1);
        if (previousAction) {
            nextAction.crossFadeFrom(previousAction, duration, true);
        }
        nextAction.play();

        this.currentActionName = newActionName;
    }

    /**
     * Joue une animation de danse Mixamo (en boucle, rejouable instantanément si spam).
     * @param {string} danceId
     * @param {boolean} [restart=false]
     */
    async playDance(danceId, restart = false) {
        if (!this.model || !this.mixer) return;
        const info = DanceManager.getInfo(danceId);
        if (!info) return;
        const normId = info.id;

        // Basculer automatiquement en vue 3ème personne pour voir son personnage danser
        if (!this.isThirdPerson) {
            this.toggleCameraView(true);
        }

        // Mettre à jour l'identifiant de la danse immédiatement pour que l'UI reflète le choix sans délai
        const previousDanceId = this.currentDanceId;
        this.currentDanceId = normId;
        this.currentActionName = normId;
        if (this._onDanceChange) {
            try { this._onDanceChange(normId); } catch (e) {}
        }

        // Si la danse est déjà en cours et qu'on re-clique / spam la touche :
        // réinitialiser le temps et rejouer dès la frame 0
        if (previousDanceId === normId && this.actions[normId]) {
            const action = this.actions[normId];
            action.reset();
            action.play();
            this.danceRestartCounter++;
            return;
        }

        let action = this.actions[normId];
        if (!action) {
            const clip = await DanceManager.loadClip(normId, this.model);
            if (!clip || !this.mixer) {
                this.currentDanceId = null;
                if (this._onDanceChange) {
                    try { this._onDanceChange(null); } catch (e) {}
                }
                return;
            }
            action = this.mixer.clipAction(clip);
            this.actions[normId] = action;
        }

        // Si entre-temps une autre danse a été demandée, ne pas écraser
        if (this.currentDanceId !== normId) return;

        const isDying = normId.toLowerCase().includes('dying');
        if (isDying) {
            this.isDead = true;
            this.isGettingUp = false;
            this.isFrozenGround = false;
            this._dyingStartTime = performance.now();
        } else {
            this.isDead = false;
            this.isGettingUp = false;
            this.isFrozenGround = false;
        }

        const isLoop = isDying ? false : DanceManager.isLoop(normId);
        if (isLoop) {
            action.setLoop(THREE.LoopRepeat);
            action.clampWhenFinished = false;
        } else {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true; // Empêche de revenir brutalement en T-pose (reste au sol)
        }

        const speed = DanceManager.getSpeed(normId);
        action.setEffectiveTimeScale(speed);
        action.setEffectiveWeight(1);
        action.reset();

        // Stopper/fondu de l'ancienne action
        for (const [key, act] of Object.entries(this.actions)) {
            if (key !== normId && act.isRunning()) {
                act.fadeOut(0.2);
            }
        }
        action.fadeIn(0.2);
        action.play();

        this.currentActionName = normId;
        this.currentDanceId = normId;
        this.danceRestartCounter++;
        if (this._onDanceChange) {
            try { this._onDanceChange(normId); } catch (e) {}
        }
    }

    /**
     * Déclenche l'animation Standing Up si le personnage est au sol (Dying),
     * puis revient à la normale une fois l'animation terminée.
     */
    standUp() {
        if (!this.isDead || this.isGettingUp) return;
        this.isGettingUp = true;
        this.isDead = false;
        this.isFrozenGround = false;
        const prevDanceId = this.currentDanceId;
        this.currentDanceId = null;

        if (this._onDanceStop) {
            try { this._onDanceStop(); } catch (e) {}
        }
        if (this._onDanceChange) {
            try { this._onDanceChange(null); } catch (e) {}
        }

        if (prevDanceId && this.actions[prevDanceId]) {
            this.actions[prevDanceId].fadeOut(0.2);
        }

        const standAction = this.actions['standing_up'];
        if (standAction) {
            standAction.reset();
            standAction.setLoop(THREE.LoopOnce, 1);
            standAction.clampWhenFinished = true;
            standAction.fadeIn(0.2);
            standAction.play();
            this.currentActionName = 'standing_up';
        } else {
            // Si jamais l'animation n'était pas chargée, revenir proprement à idle
            this.isGettingUp = false;
            this.isDead = false;
            if (this.actions['idle']) {
                this.actions['idle'].reset();
                this.actions['idle'].fadeIn(0.2);
                this.actions['idle'].play();
                this.currentActionName = 'idle';
            }
        }
    }

    /**
     * Arrête la danse ou l'animation en cours (y compris Dying à n'importe quel moment)
     * et revient immédiatement à la posture normale (idle/marche) en skippant tout.
     */
    stopDance() {
        if (!this.currentDanceId && !this.isDead && !this.isGettingUp) return;
        const prevDanceId = this.currentDanceId;
        const prevAction = prevDanceId ? this.actions[prevDanceId] : null;
        const standAction = this.actions['standing_up'];
        this.currentDanceId = null;
        this.isDead = false;
        this.isGettingUp = false;
        this.isFrozenGround = false;

        if (prevAction) {
            prevAction.fadeOut(0.2);
        }
        if (standAction && standAction.isRunning()) {
            standAction.fadeOut(0.2);
        }

        this.currentActionName = '';

        if (this.actions['idle']) {
            this.actions['idle'].reset();
            this.actions['idle'].fadeIn(0.25);
            this.actions['idle'].play();
            this.currentActionName = 'idle';
        }

        if (this._onDanceChange) {
            try { this._onDanceChange(null); } catch (e) {}
        }
        if (this._onDanceStop) {
            try { this._onDanceStop(); } catch (e) {}
        }
    }

    /**
     * Nettoie tous les clips et actions de danse mis en cache pour forcer le rechargement immédiat
     */
    clearDanceActions() {
        this.stopDance();
        const keepKeys = new Set(['idle', 'walk', 'run', 'walk-backward', 'sitting', 'standing_up']);
        for (const [key, action] of Object.entries(this.actions)) {
            if (!keepKeys.has(key)) {
                try {
                    action.stop();
                    if (this.mixer) this.mixer.uncacheAction(action.getClip(), this.model);
                } catch (e) {}
                delete this.actions[key];
            }
        }
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
        const floorY = getGroundHeight(this.position.x, this.position.z);

        if (this.isFlying) {
            // En mode vol, pas de gravité terrestre ; la hauteur y est gérée par les contrôles
            this.onGround = false;
            this.verticalVelocity = 0;
            if (this.position.y < floorY) {
                this.position.y = floorY;
            }
        } else {
            if (jumpInput && this.onGround) {
                this.verticalVelocity = JUMP_VELOCITY;
                this.onGround = false;
            }

            if (!this.onGround) {
                this.verticalVelocity -= GRAVITY * dt;
                this.position.y += this.verticalVelocity * dt;

                // Collision avec le sol ou la scène
                if (this.position.y <= floorY) {
                    this.position.y = floorY;
                    this.verticalVelocity = 0;
                    this.onGround = true;
                }
            } else {
                // Au sol : si le relief monte sous les pieds (ex: marches/rampe d'escalier), on monte
                if (this.position.y < floorY) {
                    this.position.y = floorY;
                } else if (this.position.y > floorY + 0.35) {
                    // Si on a marché dans le vide (chute du bord de scène), on commence à tomber avec gravité
                    this.onGround = false;
                    this.verticalVelocity = 0;
                } else {
                    this.position.y = floorY;
                }
            }
        }

        // ── 2. Orientation du personnage ─────────────────────────────
        const vx = horizontalVelocity ? horizontalVelocity.x : 0;
        const vz = horizontalVelocity ? horizontalVelocity.y : 0;
        const speedSq = vx * vx + vz * vz;
        const currentSpeed = Math.sqrt(speedSq);

        if (isMoving && currentSpeed > 0.1) {
            // Déplacement standard : l'angle d'orientation pointe vers la direction de marche (fait demi-tour en reculant)
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
                // Détecter l'impact au sol lors de Dying pour bloquer le mouvement après 0.5s de chute (15 frames à 30fps)
                if (this.isDead && this.currentDanceId && this.currentDanceId.toLowerCase().includes('dying')) {
                    const dyingAction = this.actions[this.currentDanceId];
                    if (dyingAction) {
                        const elapsed = (performance.now() - (this._dyingStartTime || 0)) / 1000;
                        // 0.5 seconde de chute autorisant le déplacement (correspond à 15 frames sur du 30 fps)
                        if (elapsed >= 0.5 || dyingAction.time >= 0.5) {
                            this.isFrozenGround = true;
                        }
                    }
                }

                if (this.currentDanceId) {
                    // Si une danse est active, elle tourne en boucle et continue de jouer
                    // même si le joueur se déplace avec ZQSD / WASD !
                } else if (this.isGettingUp) {
                    // En train de se relever (Standing Up) : attendre la fin de l'animation
                } else if (this.isFlying) {
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
                } else if (this.isSitting && this.actions['sitting']) {
                    // Assis au sol (touche Ctrl)
                    this._fadeToAction('sitting', 0.2);
                } else if (isMoving && currentSpeed > 0.1) {
                    // Au sol et en déplacement : sprint (> 6.0 m/s) ou marche
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
    }

    /** Nettoyage des ressources */
    dispose() {
        window.removeEventListener('wheel', this._onWheel);
        if (this.model) {
            this.scene.remove(this.model);
        }
        if (this.mixer) {
            this.mixer.stopAllAction();
        }
    }
}
