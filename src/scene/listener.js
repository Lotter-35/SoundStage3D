/**
 * Listener — Contrôles FPS/TPS + synchronisation avec l'écouteur binaural Web Audio API.
 *
 * Supporte :
 * - Mode Personnage 3D (par défaut) : Vue 3ème personne (TPS) ou 1ère personne (FPS)
 * - Mode Vol libre (F) : Déplacement 6-axes dans toute la scène
 * - Déplacement ZQSD / WASD / Flèches
 * - Course (Shift) et Saut physique avec gravité (Espace)
 * - Orientation orbitale fluide à la souris et zoom molette (TPS)
 * - Bascule de caméra instantanée (V ou bouton HUD)
 * - Anti-décrochage / protection glitch pointeur
 * - Synchronisation Web Audio API (position et orientation de la tête) sans claquements
 */
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { Character3D } from './character3D.js';
import { resolveCollision } from './collision.js';
import { EmoteMenu } from '../ui/EmoteMenu.js';
import { DanceManager } from './DanceManager.js';

const WALK_SPEED     = 4.0; // m/s — vitesse naturelle de marche
const SPRINT_SPEED   = 8.5; // m/s — course avec Shift
const FLY_SPEED      = 18;  // m/s — vitesse en vol libre
const VERTICAL_SPEED = 15;  // m/s — vitesse verticale en vol libre
const PLAYER_HEIGHT  = 1.7; // hauteur d'écoute et des yeux en mètres

const BOUNDS = {
    minX: -100, maxX: 100,
    minY: 0,    maxY: 40,
    minZ: -50,  maxZ: 200,
};

// Position de référence de la régie FOH
const FOH = new THREE.Vector3(0, 1.7, 50);

export class Listener {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {HTMLElement} domElement — élément d'écoute pour le pointer lock
     * @param {THREE.Scene} [scene] — scène Three.js pour le maillage du personnage 3D
     */
    constructor(camera, domElement, scene = null) {
        this.camera = camera;
        this.scene = scene;
        this.controls = new PointerLockControls(camera, domElement);
        this.controls.pointerSpeed = 1.0;

        // Position de départ à la régie FOH
        camera.position.set(FOH.x, FOH.y, FOH.z);

        // État des touches de déplacement
        this.move = { forward: false, backward: false, left: false, right: false, up: false, down: false };
        this.velocity = new THREE.Vector3();
        this._currentSpeed = new THREE.Vector2(0, 0);

        // Mode Personnage activé par défaut (expérience 3D avec personnage visible)
        this.characterMode = true;
        this.isFlying = false;
        this.isSitting = false;
        this._onModeChange = null;
        this._onCameraModeChange = null;

        // Personnage 3D animé et caméra 3ème personne
        this._character3D = new Character3D(scene, camera, domElement);
        this._character3D.isThirdPerson = true;
        this._character3D.snapToGround(FOH, 0);

        // Menu d'Emotes & Danses (Touche 'T')
        this.emoteMenu = new EmoteMenu(this, this._character3D);

        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);

        // Vecteurs réutilisés pour éviter toute allocation par frame
        this._direction = new THREE.Vector3();
        this._forward = new THREE.Vector3();
        this._up = new THREE.Vector3();
        this._audioListenerInitialized = false;

        // Protection anti-saccade lors du verrouillage/déverrouillage de la souris
        this._suppressMouseUntil = 0;
        this._suppressMouse = (durationMs = 150) => {
            this._suppressMouseUntil = performance.now() + durationMs;
        };

        // Délégation directe des mouvements souris sans interférence
        this.controls.disconnect();
        const origOnMouseMove = this.controls._onMouseMove;
        this.controls._onMouseMove = (e) => {
            if (!this.controls.isLocked) return;
            if (performance.now() < this._suppressMouseUntil) return;
            if (Math.abs(e.movementX) > 250 || Math.abs(e.movementY) > 250) return;

            if (this.characterMode && this._character3D.isThirdPerson) {
                // En 3ème personne : orbite autour du personnage
                this._character3D.handleMouseMove(e.movementX, e.movementY, this.controls.pointerSpeed || 1.0);
            } else {
                // En 1ère personne ou vol libre : orientation classique PointerLock
                origOnMouseMove(e);
            }
        };
        this.controls.connect();

        this.controls.addEventListener('lock', () => {
            this._suppressMouse(100);
        });

        this.controls.addEventListener('unlock', () => {
            this._suppressMouse(200);
            this.resetMovement();
        });

        window.addEventListener('blur', () => {
            this._suppressMouse(200);
            this.resetMovement();
        });

        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
    }

    /** Réinitialise les entrées de mouvement */
    resetMovement() {
        this.move.forward = false;
        this.move.backward = false;
        this.move.left = false;
        this.move.right = false;
        this.move.up = false;
        this.move.down = false;
        if (this._currentSpeed) this._currentSpeed.set(0, 0);
    }

    /** Régler la sensibilité de la souris */
    setSensitivity(value) {
        this.controls.pointerSpeed = value;
    }

    setInvertPitch(invert) {
        if (this._character3D) this._character3D.invertY = Boolean(invert);
    }

    setInvertYaw(invert) {
        if (this._character3D) this._character3D.invertX = Boolean(invert);
    }

    lock() {
        this._suppressMouse(100);
        this.controls.lock();
    }

    unlock() {
        this._suppressMouse(200);
        this.resetMovement();
        if (this.controls.isLocked) {
            this.controls.unlock();
        }
    }

    get isLocked() {
        return this.controls.isLocked;
    }

    onLockChange(cb) {
        this.controls.addEventListener('lock', () => cb(true));
        this.controls.addEventListener('unlock', () => cb(false));
    }

    /**
     * Identifiant du mode de caméra actuel : 'thirdPerson' | 'firstPerson'
     */
    get cameraMode() {
        return this._character3D.isThirdPerson ? 'thirdPerson' : 'firstPerson';
    }

    /**
     * Bascule entre le mode de vol (F) et le mode sol tout en gardant la même perspective (1ère ou 3ème personne).
     */
    toggleFly() {
        this.isFlying = !this.isFlying;
        this._character3D.isFlying = this.isFlying;
        if (this.isFlying) {
            // Ne peut pas être assis en vol
            this.isSitting = false;
            this._character3D.isSitting = false;
        } else {
            // Revenir au sol doucement si on était en vol
            this._character3D.onGround = false;
        }
        if (this._onCameraModeChange) {
            this._onCameraModeChange(this.cameraMode, this.isFlying);
        }
    }

    /**
     * Fait défiler les modes de vue : 3ème personne <-> 1ère personne
     */
    cycleCameraMode() {
        if (this._character3D.isThirdPerson) {
            this.setCameraMode('firstPerson');
        } else {
            this.setCameraMode('thirdPerson');
        }
    }

    /**
     * Définit explicitement le mode de caméra (3ème ou 1ère personne).
     * @param {'thirdPerson'|'firstPerson'} mode
     */
    setCameraMode(mode) {
        if (mode === 'thirdPerson') {
            this.characterMode = true;
            this._character3D.enabled = true;
            this._character3D.toggleCameraView(true);
            const camEuler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
            this._character3D.orbitYaw = this._character3D.orbitYaw || camEuler.y;
        } else { // 'firstPerson'
            this.characterMode = true;
            this._character3D.enabled = true;
            this._character3D.toggleCameraView(false);
            this.camera.position.set(
                this._character3D.position.x,
                this._character3D.position.y + PLAYER_HEIGHT,
                this._character3D.position.z
            );
            this.camera.rotation.set(0, this._character3D.orbitYaw, 0, 'YXZ');
        }

        if (this._onCameraModeChange) {
            this._onCameraModeChange(this.cameraMode, this.isFlying);
        }
        if (this._onModeChange) {
            this._onModeChange(this.characterMode);
        }
    }

    onCameraModeChange(cb) {
        this._onCameraModeChange = cb;
    }

    onModeChange(cb) {
        this._onModeChange = cb;
    }

    _onKeyDown(e) {
        // Empêcher les raccourcis navigateur Ctrl+S (sauvegarder la page) et Ctrl+D (ajouter aux favoris)
        if (e.ctrlKey || e.metaKey) {
            if (e.code === 'KeyS' || e.code === 'KeyD') {
                e.preventDefault();
            }
        }

        // Ignorer les raccourcis si l'utilisateur saisit du texte dans un champ (recherche d'emotes, chat, etc.)
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
            if (e.code === 'Escape' && this.emoteMenu && this.emoteMenu.isOpen) {
                this.emoteMenu.close();
            }
            return;
        }

        // Fermer le menu d'emotes si Escape
        if (e.code === 'Escape') {
            if (this.emoteMenu && this.emoteMenu.isOpen) {
                this.emoteMenu.close();
                return;
            }
        }

        if (e.code === 'Tab') {
            e.preventDefault();
            if (this.controls.isLocked) {
                this.unlock();
            } else {
                this.lock();
            }
            return;
        }

        // Touche T : Ouvrir / Fermer le menu d'emotes et danses
        if (e.code === 'KeyT') {
            e.preventDefault();
            if (this.emoteMenu) {
                this.emoteMenu.toggle();
            }
            return;
        }

        // Touche X : Arrêter la danse en cours et revenir à la normale
        if (e.code === 'KeyX') {
            if (this._character3D) {
                this._character3D.stopDance();
            }
            if (this.emoteMenu) {
                this.emoteMenu.updateActiveHighlight();
            }
            return;
        }

        // Touches 1 à 9 : Déclencher les danses (compatibilité totale AZERTY & QWERTY + Pavé numérique)
        const DIGIT_MAP = {
            'Digit1': 1, 'Numpad1': 1,
            'Digit2': 2, 'Numpad2': 2,
            'Digit3': 3, 'Numpad3': 3,
            'Digit4': 4, 'Numpad4': 4,
            'Digit5': 5, 'Numpad5': 5,
            'Digit6': 6, 'Numpad6': 6,
            'Digit7': 7, 'Numpad7': 7,
            'Digit8': 8, 'Numpad8': 8,
            'Digit9': 9, 'Numpad9': 9,
        };
        const AZERTY_KEY_MAP = {
            '&': 1, '1': 1,
            'é': 2, '2': 2,
            '"': 3, '3': 3,
            "'": 4, '4': 4,
            '(': 5, '5': 5,
            '-': 6, '6': 6,
            'è': 7, '7': 7,
            '_': 8, '8': 8,
            'ç': 9, '9': 9,
        };

        const slot = DIGIT_MAP[e.code] || AZERTY_KEY_MAP[e.key];
        if (slot >= 1 && slot <= 9) {
            const danceId = DanceManager.getSlot(slot);
            if (danceId && this._character3D) {
                // restart = true permet de rejouer immédiatement depuis la frame 0 si on spamme la touche
                this._character3D.playDance(danceId, true);
                if (this.emoteMenu) {
                    this.emoteMenu.updateActiveHighlight();
                }
            }
            return;
        }

        switch (e.code) {
            case 'KeyW': case 'KeyZ': case 'ArrowUp':    this.move.forward = true; break;
            case 'KeyS':              case 'ArrowDown':  this.move.backward = true; break;
            case 'KeyA': case 'KeyQ': case 'ArrowLeft':  this.move.left = true; break;
            case 'KeyD':              case 'ArrowRight': this.move.right = true; break;
            case 'Space':                                 this.move.up = true; break;
            case 'ShiftLeft': case 'ShiftRight':          this.move.down = true; break;

            case 'KeyF':
                // Basculer en mode vol tout en restant dans la vue courante (1ère ou 3ème personne)
                this.toggleFly();
                break;

            case 'ControlLeft':
            case 'ControlRight':
                // Touche Ctrl : S'asseoir au sol / se relever (inopérant en mode vol)
                if (!this.isFlying) {
                    this.isSitting = !this.isSitting;
                    this._character3D.isSitting = this.isSitting;
                    if (this.isSitting) {
                        // Arrêter immédiatement la course ou la marche
                        this._currentSpeed.set(0, 0);
                        if (this._character3D.currentDanceId) {
                            this._character3D.stopDance();
                        }
                    }
                }
                break;

            case 'KeyV':
                // Basculer entre 3ème personne et 1ère personne
                if (this._character3D.isThirdPerson) {
                    this.setCameraMode('firstPerson');
                } else {
                    this.setCameraMode('thirdPerson');
                }
                break;
        }
    }

    _onKeyUp(e) {
        if (e.code === 'Tab') {
            e.preventDefault();
            return;
        }

        switch (e.code) {
            case 'KeyW': case 'KeyZ': case 'ArrowUp':    this.move.forward = false; break;
            case 'KeyS':              case 'ArrowDown':  this.move.backward = false; break;
            case 'KeyA': case 'KeyQ': case 'ArrowLeft':  this.move.left = false; break;
            case 'KeyD':              case 'ArrowRight': this.move.right = false; break;
            case 'Space':                                 this.move.up = false; break;
            case 'ShiftLeft': case 'ShiftRight':          this.move.down = false; break;
        }
    }

    /**
     * Mise à jour globale appelée à chaque frame du rendu Three.js.
     * @param {number} dt — delta time en secondes
     */
    update(dt) {
        if (this.characterMode) {
            let isMoving = false;
            let jumpInput = false;

            if (this.controls.isLocked) {
                const direction = this._direction;
                direction.set(0, 0, 0);

                if (this.move.forward)  direction.z -= 1;
                if (this.move.backward) direction.z += 1;
                if (this.move.left)     direction.x -= 1;
                if (this.move.right)    direction.x += 1;

                direction.normalize();
                isMoving = this.move.forward || this.move.backward || this.move.left || this.move.right;
                jumpInput = this.move.up;

                // Si le personnage est figé au sol (Dying terminé / au sol) ou en train de se relever (Standing Up)
                if (this._character3D?.isFrozenGround || this._character3D?.isGettingUp) {
                    if (this._character3D.isDead && this._character3D.isFrozenGround && (isMoving || jumpInput)) {
                        // Le joueur a touché le sol et appuie sur une commande de mouvement : se relever
                        this._character3D.standUp();
                        if (this.emoteMenu) {
                            this.emoteMenu.updateActiveHighlight();
                        }
                    }
                    // Bloquer tout déplacement horizontal et saut une fois au sol ou en cours de relevage
                    direction.set(0, 0, 0);
                    isMoving = false;
                    jumpInput = false;
                    this._currentSpeed.set(0, 0);
                }

                // Si le personnage est assis et qu'une touche de déplacement ou de saut est pressée : se relever
                if (this.isSitting) {
                    if (isMoving || jumpInput) {
                        this.isSitting = false;
                        this._character3D.isSitting = false;
                    } else {
                        // Rester immobile pendant qu'on est assis
                        direction.set(0, 0, 0);
                        isMoving = false;
                    }
                }

                // En vol : vitesse FLY_SPEED, au sol : marche normale ou sprint (Shift)
                let moveSpeed;
                if (this.isFlying) {
                    moveSpeed = FLY_SPEED;
                } else {
                    moveSpeed = this.move.down ? SPRINT_SPEED : WALK_SPEED;
                }

                // Accélération fluide
                const targetX = direction.x * moveSpeed;
                const targetZ = -direction.z * moveSpeed;
                const accelRate = 14;
                this._currentSpeed.x += (targetX - this._currentSpeed.x) * Math.min(1, dt * accelRate);
                this._currentSpeed.y += (targetZ - this._currentSpeed.y) * Math.min(1, dt * accelRate);

                // Déplacement horizontal selon l'orientation de la caméra
                let forwardX, forwardZ, rightX, rightZ;

                if (this._character3D.isThirdPerson) {
                    const yaw = this._character3D.orbitYaw;
                    forwardX = -Math.sin(yaw);
                    forwardZ = -Math.cos(yaw);
                    rightX = Math.cos(yaw);
                    rightZ = -Math.sin(yaw);
                } else {
                    const camDir = this._forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
                    camDir.y = 0;
                    camDir.normalize();
                    forwardX = camDir.x;
                    forwardZ = camDir.z;
                    rightX = -camDir.z;
                    rightZ = camDir.x;
                }

                const dx = (rightX * this._currentSpeed.x + forwardX * this._currentSpeed.y) * dt;
                const dz = (rightZ * this._currentSpeed.x + forwardZ * this._currentSpeed.y) * dt;

                const curX = this._character3D.position.x;
                const curY = this._character3D.position.y;
                const curZ = this._character3D.position.z;

                let nextX = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, curX + dx));
                let nextZ = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, curZ + dz));

                // Résolution des collisions avec glissement fluide
                const resolved = resolveCollision(curX, curZ, nextX, nextZ, curY, this.isFlying);
                this._character3D.position.x = resolved.x;
                this._character3D.position.z = resolved.z;

                // Gestion de la hauteur en mode vol : Espace = monter, Shift = descendre
                if (this.isFlying) {
                    if (this.move.up) {
                        this._character3D.position.y += VERTICAL_SPEED * dt;
                    }
                    if (this.move.down) {
                        this._character3D.position.y -= VERTICAL_SPEED * dt;
                    }
                    this._character3D.position.y = Math.max(BOUNDS.minY, Math.min(BOUNDS.maxY, this._character3D.position.y));
                }
            } else {
                // Ralentissement naturel si la souris est libérée
                this._currentSpeed.x += (0 - this._currentSpeed.x) * Math.min(1, dt * 14);
                this._currentSpeed.y += (0 - this._currentSpeed.y) * Math.min(1, dt * 14);
            }

            if (Math.abs(this._currentSpeed.x) < 0.001) this._currentSpeed.x = 0;
            if (Math.abs(this._currentSpeed.y) < 0.001) this._currentSpeed.y = 0;

            // Toujours mettre à jour le personnage (animation idle/run/vol, gravité/altitude, caméra fluide)
            this._character3D.update(dt, this._currentSpeed, jumpInput, isMoving);
        }
    }

    /**
     * Synchronise l'écouteur Web Audio API avec le joueur.
     * Utilise setTargetAtTime pour éliminer tout gresillement ou cliquetis lors des rotations rapides de la tête.
     * @param {AudioListener} audioListener — ctx.listener
     * @param {AudioContext} [audioCtx]
     */
    syncAudioListener(audioListener, audioCtx) {
        // En mode personnage, l'écouteur binaural est aux oreilles du personnage
        const p = this.position;
        const forward = this._forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const up = this._up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);

        const ctx = audioCtx || audioListener.context;
        const t = ctx ? ctx.currentTime : (this._audioCtxTime || 0);

        if (!this._audioListenerInitialized) {
            this._audioListenerInitialized = true;
            if (audioListener.positionX) {
                audioListener.positionX.setValueAtTime(p.x, t);
                audioListener.positionY.setValueAtTime(p.y, t);
                audioListener.positionZ.setValueAtTime(p.z, t);
            } else if (audioListener.setPosition) {
                audioListener.setPosition(p.x, p.y, p.z);
            }
            if (audioListener.forwardX) {
                audioListener.forwardX.setValueAtTime(forward.x, t);
                audioListener.forwardY.setValueAtTime(forward.y, t);
                audioListener.forwardZ.setValueAtTime(forward.z, t);
                audioListener.upX.setValueAtTime(up.x, t);
                audioListener.upY.setValueAtTime(up.y, t);
                audioListener.upZ.setValueAtTime(up.z, t);
            } else if (audioListener.setOrientation) {
                audioListener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
            }
            return;
        }

        const tc = 0.04; // 40ms smoothing

        if (audioListener.positionX) {
            audioListener.positionX.setTargetAtTime(p.x, t, tc);
            audioListener.positionY.setTargetAtTime(p.y, t, tc);
            audioListener.positionZ.setTargetAtTime(p.z, t, tc);
        } else if (audioListener.setPosition) {
            audioListener.setPosition(p.x, p.y, p.z);
        }

        if (audioListener.forwardX) {
            audioListener.forwardX.setTargetAtTime(forward.x, t, tc);
            audioListener.forwardY.setTargetAtTime(forward.y, t, tc);
            audioListener.forwardZ.setTargetAtTime(forward.z, t, tc);
            audioListener.upX.setTargetAtTime(up.x, t, tc);
            audioListener.upY.setTargetAtTime(up.y, t, tc);
            audioListener.upZ.setTargetAtTime(up.z, t, tc);
        } else if (audioListener.setOrientation) {
            audioListener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
        }
    }

    /** Position d'écoute audio courante (oreilles du personnage ou caméra) */
    get position() {
        if (this.characterMode && this._character3D) {
            return {
                x: this._character3D.position.x,
                y: this._character3D.position.y + PLAYER_HEIGHT,
                z: this._character3D.position.z,
            };
        }
        const p = this.camera.position;
        return { x: p.x, y: p.y, z: p.z };
    }

    /** Distance au point de référence de la régie FOH */
    get distanceToFOH() {
        if (this.characterMode && this._character3D) {
            const p = this._character3D.position;
            const dx = p.x - FOH.x;
            const dy = (p.y + PLAYER_HEIGHT) - FOH.y;
            const dz = p.z - FOH.z;
            return Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        return this.camera.position.distanceTo(FOH);
    }

    /** Orientation heading (rotation Y du modèle en radians) */
    get heading() {
        if (this.characterMode && this._character3D) {
            return this._character3D.heading;
        }
        return this.camera.rotation.y;
    }
}
