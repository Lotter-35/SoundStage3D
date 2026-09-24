/**
 * PlayerAvatars.js — Remote player avatars with smooth movement and animations.
 *
 * Features:
 * - Uses the same character.glb as the local player (SkeletonUtils.clone for independent animation)
 * - Smooth position & rotation interpolation (lerp at ~12Hz convergence)
 * - Automatic animation switching: Idle / Walk / Run based on estimated movement speed
 * - Color-tinted to distinguish each remote player
 * - Filters out the local player by their server-assigned clientId
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { DanceManager } from '../scene/DanceManager.js';

const MODEL_PATH = 'src/assets/models/Ybot.fbx';
const MODEL_SCALE = 1.0;
const EYE_HEIGHT  = 1.7;  // listener position is eye-level; convert to foot position

// Lerp aggressiveness: how fast the avatar catches up to server position
const ROT_SPEED   = 14;

// Couleurs franches et saturées pour distinguer nettement chaque joueur
const AVATAR_COLORS = [
    0x00d2ff, // Cyan électrique
    0xff3d00, // Rouge / Orange vif
    0xa855f7, // Violet néon
    0x22c55e, // Vert émeraude
    0xeab308, // Jaune doré
    0xec4899, // Rose vif
    0x3b82f6, // Bleu roi
    0xf97316, // Orange mandarine
];

// ─── Shared Model (loaded once, cloned per avatar) ─────────────────────────────
let _sharedModel   = null;
let _loadPromise   = null;

function loadSharedModel() {
    if (_sharedModel)  return Promise.resolve(_sharedModel);
    if (_loadPromise) return _loadPromise;
    const isFbx = MODEL_PATH.toLowerCase().endsWith('.fbx');
    if (isFbx) {
        _loadPromise = (async () => {
            const fbxLoader = new FBXLoader();
            const fbx = await fbxLoader.loadAsync(MODEL_PATH);
            const anims = fbx.animations ? [...fbx.animations] : [];

            // Utiliser l'animation idle intégrée dans Ybot
            if (anims.length > 0) {
                anims[0].name = 'idle';
                anims[0].tracks = anims[0].tracks.filter(t => !t.name.toLowerCase().includes('position'));
            }

            // Charger les animations de locomotion (marche, course, marche arrière, sitting) pour les avatars distants
            const locoFiles = [
                { name: 'walk',          files: ['src/assets/animations/Standard Walk.fbx', 'src/assets/animations/locomotion/walking.fbx'] },
                { name: 'run',           files: ['src/assets/animations/Running.fbx', 'src/assets/animations/locomotion/running.fbx'] },
                { name: 'walk-backward', files: ['src/assets/animations/locomotion/walking-backward.fbx', 'src/assets/animations/walking-backward.fbx'] },
                { name: 'sitting',       files: ['src/assets/animations/locomotion/sitting.fbx'] },
            ];

            await Promise.all(locoFiles.map(async ({ name, files }) => {
                for (const file of files) {
                    try {
                        const animFbx = await fbxLoader.loadAsync(file);
                        if (animFbx.animations && animFbx.animations.length > 0) {
                            const rawClip = animFbx.animations[0];
                            const clip = DanceManager._retargetClip(rawClip, fbx, animFbx);
                            clip.name = name;
                            if (name !== 'sitting') {
                                clip.tracks = clip.tracks.filter(t => !t.name.toLowerCase().includes('position'));
                            }
                            anims.push(clip);
                            break;
                        }
                    } catch (e) {
                        console.warn(`[PlayerAvatars] Erreur chargement animation ${name} (${file}) :`, e);
                    }
                }
            }));

            _sharedModel = { scene: fbx, animations: anims };
            return _sharedModel;
        })();
    } else {
        _loadPromise = new GLTFLoader().loadAsync(MODEL_PATH).then(gltf => {
            _sharedModel = { scene: gltf.scene, animations: gltf.animations || [] };
            return _sharedModel;
        });
    }
    return _loadPromise;
}

// ─── Helper: shortest-path angle lerp ─────────────────────────────────────────
function lerpAngle(a, b, t) {
    let d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
    return a + d * Math.min(1, t);
}

// ─── Main class ───────────────────────────────────────────────────────────────
export class PlayerAvatars {
    /**
     * @param {THREE.Scene} scene
     * @param {string} localClientId — server clientId of the local player (skip rendering this one)
     */
    constructor(scene, localClientId) {
        this._scene   = scene;
        this._localId = localClientId;
        /** @type {Map<string, AvatarState>} */
        this._avatars = new Map();
        this._colorIdx = 0;

        loadSharedModel().catch(err => console.warn('[PlayerAvatars] preload failed:', err));
    }

    /**
     * Call every render frame.
     * @param {{ id: string, position:{x,y,z}, rotY:number, anim?:string, onGround?:boolean }[]} players — from mp.players
     * @param {number} dt — seconds since last frame
     */
    update(players, dt) {
        const alive = new Set();

        for (const p of players) {
            if (p.id === this._localId) continue;
            alive.add(p.id);

            const footY = Math.max(0, (p.position?.y ?? EYE_HEIGHT) - EYE_HEIGHT);
            const posX = p.position?.x ?? 0;
            const posZ = p.position?.z ?? 50;

            if (!this._avatars.has(p.id)) {
                this._spawn(p.id, posX, footY, posZ, p.anim, p.color);
            }

            const av = this._avatars.get(p.id);
            if (!av) continue;

            // ── Target from server data ────────────────────────────────────
            av.targetPos.set(posX, footY, posZ);
            av.targetRotY = p.rotY || 0;   // heading of remote character

            // ── Smooth position lerp ───────────────────────────────────────
            // Horizontal lerp at 14 convergence, vertical lerp at 20 convergence for responsive jumps
            const lfXZ = Math.min(1, 14 * dt);
            const lfY  = Math.min(1, 20 * dt);
            av.root.position.x += (av.targetPos.x - av.root.position.x) * lfXZ;
            av.root.position.z += (av.targetPos.z - av.root.position.z) * lfXZ;
            av.root.position.y += (av.targetPos.y - av.root.position.y) * lfY;

            // ── Smooth rotation lerp (shortest path) ─────────────────────
            const rf = Math.min(1, ROT_SPEED * dt);
            // character.glb faces +Z, heading 0 = face toward -Z, so add PI
            const targetModelRotY = av.targetRotY + Math.PI;
            av.root.rotation.y = lerpAngle(av.root.rotation.y, targetModelRotY, rf);

            // ── Synchronized animation from sender ────────────────────────
            const rawAnim = (p.anim && typeof p.anim === 'string') ? p.anim : 'idle';
            if (rawAnim.startsWith('dance:')) {
                const parts = rawAnim.split(':');
                const danceId = parts[1];
                const restartCount = parseInt(parts[2], 10) || 0;
                this._playDance(av, danceId, restartCount);
            } else {
                const targetAnim = rawAnim.toLowerCase();
                av.targetAnim = targetAnim;
                if (av.mixer && targetAnim !== av.currentAnim) {
                    this._crossfade(av, targetAnim, 0.2);
                }
            }

            if (av.mixer) {
                av.mixer.update(dt);
            }

        }

        // ── Remove departed players ────────────────────────────────────────
        for (const id of this._avatars.keys()) {
            if (!alive.has(id)) this._destroy(id);
        }
    }

    dispose() {
        for (const id of [...this._avatars.keys()]) this._destroy(id);
    }

    // ─── Private ───────────────────────────────────────────────────────────────

    async _spawn(playerId, initX = 0, initY = 0, initZ = 50, initAnim = 'idle', playerColor = null) {
        const root = new THREE.Group();
        // Start directly at initial position
        root.position.set(initX, initY, initZ);
        this._scene.add(root);

        /** @type {AvatarState} */
        const av = {
            root,
            mixer: null,
            actions: {},
            currentAnim: initAnim || 'idle',
            targetAnim: initAnim || 'idle',
            targetPos: root.position.clone(),
            targetRotY: 0,
            color: playerColor,
        };
        this._avatars.set(playerId, av);

        try {
            const shared = await loadSharedModel();

            // Check if player disconnected while loading
            if (!this._avatars.has(playerId)) {
                this._scene.remove(root);
                return;
            }

            // SkeletonUtils.clone → independent bones + animation per avatar
            const model = skeletonClone(shared.scene);
            const isFbx = MODEL_PATH.toLowerCase().endsWith('.fbx');
            const scale = (isFbx ? 0.01 : 1.0) * MODEL_SCALE;
            model.scale.set(scale, scale, scale);

            // Color tint vive et naturelle : même finition mate (roughness 0.8) et ombres que le joueur local
            let colorHex = playerColor;
            if (!colorHex) {
                const colorIdx = this._colorIdx % AVATAR_COLORS.length;
                this._colorIdx++;
                colorHex = AVATAR_COLORS[colorIdx];
            }
            const tint = new THREE.Color(colorHex);
            model.traverse(node => {
                if (!node.isMesh) return;
                const applyTint = mat => {
                    const m = mat.clone();
                    // Teinter franchement en multipliant la couleur originale par la teinte choisie
                    m.color.multiply(tint);
                    m.roughness = 0.8;
                    return m;
                };
                node.material = Array.isArray(node.material)
                    ? node.material.map(applyTint)
                    : applyTint(node.material);
                node.castShadow = true;
                node.receiveShadow = true; // Permet de recevoir les ombres comme le joueur local
                node.frustumCulled = false;
            });

            root.add(model);
            av.model = model;
            av.lastDanceRestart = 0;

            // Sauvegarder la bind pose AVANT de démarrer les animations
            const bindPoseQuats = new Map();
            model.traverse(node => {
                if (node.isBone) {
                    const norm = node.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                    bindPoseQuats.set(norm, node.quaternion.clone());
                }
            });
            model.userData.bindPoseQuats = bindPoseQuats;

            // Animation mixer
            if (shared.animations?.length) {
                const mixer = new THREE.AnimationMixer(model);
                mixer.addEventListener('finished', (e) => {
                    if (av.actions[av.currentAnim] === e.action) {
                        this._crossfade(av, 'idle', 0.25);
                    }
                });
                const actions = {};
                for (const clip of shared.animations) {
                    actions[clip.name.toLowerCase()] = mixer.clipAction(clip);
                }

                const startAnim = (av.targetAnim && actions[av.targetAnim]) ? av.targetAnim : 'idle';
                const action = actions[startAnim] ?? actions['idle'] ?? Object.values(actions)[0];
                if (action) {
                    action.setEffectiveTimeScale(startAnim === 'walk' ? 1.55 : startAnim === 'run' ? 1.35 : startAnim === 'walk-backward' ? 1.30 : 1.0);
                    action.play();
                }

                av.mixer = mixer;
                av.actions = actions;
                av.currentAnim = startAnim;
            }
        } catch (err) {
            console.warn(`[PlayerAvatars] Model load failed for ${playerId}, using capsule:`, err);
            this._capsule(root, AVATAR_COLORS[colorIdx]);
        }
    }

    async _playDance(av, danceId, restartCounter = 0) {
        if (!av.mixer || !av.model) return;
        const info = DanceManager.getInfo(danceId);
        if (!info) return;

        let action = av.actions[danceId];
        if (!action) {
            const clip = await DanceManager.loadClip(danceId, av.model);
            if (!clip || !av.mixer) return;
            action = av.mixer.clipAction(clip);
            av.actions[danceId] = action;
        }

        const isDying = danceId.toLowerCase().includes('dying');
        const isLoop = isDying ? false : DanceManager.isLoop(danceId);
        if (isLoop) {
            action.setLoop(THREE.LoopRepeat);
            action.clampWhenFinished = false;
        } else {
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
        }

        const isRestart = av.lastDanceRestart !== restartCounter;
        av.lastDanceRestart = restartCounter;

        const speed = DanceManager.getSpeed(danceId);
        action.setEffectiveTimeScale(speed);

        if (av.currentAnim === danceId) {
            if (isRestart) {
                action.reset();
                action.play();
            }
            return;
        }

        const prev = av.actions[av.currentAnim];
        action.setEffectiveWeight(1);
        action.reset();
        if (prev) {
            action.crossFadeFrom(prev, 0.2, true);
        }
        action.play();
        av.currentAnim = danceId;
        av.targetAnim = danceId;
    }

    _crossfade(av, toName, duration = 0.2) {
        if (!av.mixer || av.currentAnim === toName) return;
        const prev = av.actions[av.currentAnim];
        const next = av.actions[toName];
        if (!next) return;

        next.reset();
        next.setEffectiveTimeScale(toName === 'walk' ? 1.55 : toName === 'run' ? 1.35 : toName === 'walk-backward' ? 1.30 : 1.0);
        next.setEffectiveWeight(1);
        if (prev) {
            next.crossFadeFrom(prev, duration, true);
        }
        next.play();
        av.currentAnim = toName;
    }

    _capsule(root, color) {
        const mat  = new THREE.MeshStandardMaterial({ color });
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.2, 12), mat);
        body.position.y = 0.6;
        root.add(body);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12), mat);
        head.position.y = 1.5;
        root.add(head);
        const noseMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.3, 6), noseMat);
        nose.position.set(0, 1.5, -0.35);
        nose.rotation.x = Math.PI / 2;
        root.add(nose);
    }

    _destroy(id) {
        const av = this._avatars.get(id);
        if (!av) return;
        av.mixer?.stopAllAction();
        av.root.traverse(obj => {
            obj.geometry?.dispose();
            (Array.isArray(obj.material) ? obj.material : [obj.material])
                .forEach(m => m?.dispose());
        });
        this._scene.remove(av.root);
        this._avatars.delete(id);
    }
}
