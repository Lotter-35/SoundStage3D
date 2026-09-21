/**
 * Listener — FPS-style movement controls + AudioContext listener sync.
 *
 * Uses PointerLockControls for mouse look.
 * WASD / Arrow keys for horizontal movement.
 * Space / Shift for vertical movement.
 */
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { Character3D } from './character3D.js';

const WALK_SPEED    = 5.0; // m/s — vitesse naturelle de marche en mode personnage
const FLY_SPEED     = 18;  // m/s — speed when in free-fly mode
const VERTICAL_SPEED = 15; // m/s — vertical speed in free-fly mode
const PLAYER_HEIGHT  = 1.7; // eye height in m

const BOUNDS = {
    minX: -100, maxX: 100,
    minY: 0,    maxY: 40,
    minZ: -50,  maxZ: 200,
};

// FOH reference position
const FOH = new THREE.Vector3(0, 1.7, 50);

export class Listener {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {HTMLElement} domElement — the canvas or overlay element for pointer lock
     * @param {THREE.Scene} [scene] — Three.js scene for 3D character mesh
     */
    constructor(camera, domElement, scene = null) {
        this.camera = camera;
        this.scene = scene;
        this.controls = new PointerLockControls(camera, domElement);
        this.controls.pointerSpeed = 1.0; // default sensitivity

        // Start at FOH position
        camera.position.set(FOH.x, FOH.y, FOH.z);

        // Movement state
        this.move = { forward: false, backward: false, left: false, right: false, up: false, down: false };
        this.velocity = new THREE.Vector3();
        this._currentSpeed = new THREE.Vector2(0, 0); // smooth velocity interpolation

        // Character mode (F to toggle)
        this.characterMode = false;
        this._onModeChange = null;

        // 3D Animated Character & Third-person camera system
        this._character3D = new Character3D(scene, camera, domElement);

        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);

        // Pre-allocated vectors to avoid GC pressure in per-frame methods
        this._direction = new THREE.Vector3();
        this._forward = new THREE.Vector3();
        this._up = new THREE.Vector3();
        this._audioListenerInitialized = false;

        // Anti-teleport / mouse delta glitch protection (especially when unlocking or pressing Tab/Alt-Tab)
        this._suppressMouseUntil = 0;
        this._suppressMouse = (durationMs = 150) => {
            this._suppressMouseUntil = performance.now() + durationMs;
        };

        // Wrap PointerLockControls' internal onMouseMove directly so we never intercept or cancel global mousemove events
        this.controls.disconnect();
        const origOnMouseMove = this.controls._onMouseMove;
        this.controls._onMouseMove = (e) => {
            if (!this.controls.isLocked) return;
            if (performance.now() < this._suppressMouseUntil) return;
            if (Math.abs(e.movementX) > 200 || Math.abs(e.movementY) > 200) return;

            if (this.characterMode && this._character3D.isThirdPerson) {
                // In 3rd person character mode: mouse controls orbital camera around character
                this._character3D.handleMouseMove(e.movementX, e.movementY, this.controls.pointerSpeed || 1.0);
            } else {
                // In 1st person or fly mode: standard pointer lock camera rotation
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

    /** Reset all directional movement inputs */
    resetMovement() {
        this.move.forward = false;
        this.move.backward = false;
        this.move.left = false;
        this.move.right = false;
        this.move.up = false;
        this.move.down = false;
        if (this._currentSpeed) this._currentSpeed.set(0, 0);
    }

    /** Set mouse look sensitivity. @param {number} value — 0.1 to 3.0 */
    setSensitivity(value) {
        this.controls.pointerSpeed = value;
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

    /** Register a callback when pointer lock changes */
    onLockChange(cb) {
        this.controls.addEventListener('lock', () => cb(true));
        this.controls.addEventListener('unlock', () => cb(false));
    }

    _onKeyDown(e) {
        if (e.code === 'Tab') {
            e.preventDefault();
            if (this.controls.isLocked) {
                this.unlock();
            } else {
                this.lock();
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
                this.characterMode = !this.characterMode;
                if (this.characterMode) {
                    const camEuler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
                    this._character3D.snapToGround(this.camera.position, camEuler.y);
                } else {
                    // Leaving character mode: ensure 3rd person model is hidden in free-fly
                    if (this._character3D.model) this._character3D.model.visible = false;
                }
                if (this._onModeChange) this._onModeChange(this.characterMode);
                break;
            case 'KeyV':
                if (this.characterMode) {
                    this._character3D.toggleCameraView();
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
     * Update position based on input. Call once per frame.
     * @param {number} dt — delta time in seconds
     */
    /** Register callback when mode changes */
    onModeChange(cb) { this._onModeChange = cb; }

    update(dt) {
        if (!this.controls.isLocked) return;

        const direction = this._direction;
        direction.set(0, 0, 0);

        if (this.move.forward)  direction.z -= 1;
        if (this.move.backward) direction.z += 1;
        if (this.move.left)     direction.x -= 1;
        if (this.move.right)    direction.x += 1;

        direction.normalize();
        const isMoving = this.move.forward || this.move.backward || this.move.left || this.move.right;

        // Choose speed based on mode: fly faster, walk slower
        const moveSpeed = this.characterMode ? WALK_SPEED : FLY_SPEED;

        // Smooth horizontal acceleration and deceleration (removes abrupt start/stop jolts)
        const targetX = direction.x * moveSpeed;
        const targetZ = -direction.z * moveSpeed;
        const accelRate = this.characterMode ? 12 : 16;
        this._currentSpeed.x += (targetX - this._currentSpeed.x) * Math.min(1, dt * accelRate);
        this._currentSpeed.y += (targetZ - this._currentSpeed.y) * Math.min(1, dt * accelRate);

        if (Math.abs(this._currentSpeed.x) < 0.001) this._currentSpeed.x = 0;
        if (Math.abs(this._currentSpeed.y) < 0.001) this._currentSpeed.y = 0;

        if (this.characterMode) {
            // Character Mode: move logical character position according to camera look direction
            // Calculate forward and right vectors projected onto horizontal XZ plane
            let forwardX, forwardZ, rightX, rightZ;

            if (this._character3D.isThirdPerson) {
                // In 3rd person: move relative to orbit yaw
                const yaw = this._character3D.orbitYaw;
                forwardX = -Math.sin(yaw);
                forwardZ = -Math.cos(yaw);
                rightX = Math.cos(yaw);
                rightZ = -Math.sin(yaw);
            } else {
                // In 1st person: move relative to camera facing direction
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

            this._character3D.position.x = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, this._character3D.position.x + dx));
            this._character3D.position.z = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, this._character3D.position.z + dz));

            // Update character physics, animations, and camera placement
            this._character3D.update(dt, this._currentSpeed, this.move.up, isMoving);
        } else {
            // Free-fly vertical & horizontal movement (world Y)
            this.controls.moveRight(this._currentSpeed.x * dt);
            this.controls.moveForward(this._currentSpeed.y * dt);
            if (this.move.up)   this.camera.position.y += VERTICAL_SPEED * dt;
            if (this.move.down) this.camera.position.y -= VERTICAL_SPEED * dt;

            // Clamp camera position to world bounds
            const p = this.camera.position;
            p.x = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, p.x));
            p.y = Math.max(BOUNDS.minY, Math.min(BOUNDS.maxY, p.y));
            p.z = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, p.z));
        }
    }

    /**
     * Sync the Web Audio API listener with the Three.js camera.
     * Uses setTargetAtTime de-zippering to prevent audio crackles / clicks during rapid head turns.
     * @param {AudioListener} audioListener — ctx.listener
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
                audioListener.setOrientation(
                    forward.x, forward.y, forward.z,
                    up.x, up.y, up.z
                );
            }
            return;
        }

        // Smooth de-zippering (0.025s time constant): perfectly eliminates rapid head-turn clicking on subwoofers
        const smooth = 0.025;

        // Position: update WebAudio listener position
        if (audioListener.positionX) {
            audioListener.positionX.setTargetAtTime(p.x, t, smooth);
            audioListener.positionY.setTargetAtTime(p.y, t, smooth);
            audioListener.positionZ.setTargetAtTime(p.z, t, smooth);
        } else if (audioListener.setPosition) {
            audioListener.setPosition(p.x, p.y, p.z);
        }

        // Orientation: smooth continuous tracking with zero derivative steps
        if (audioListener.forwardX) {
            audioListener.forwardX.setTargetAtTime(forward.x, t, smooth);
            audioListener.forwardY.setTargetAtTime(forward.y, t, smooth);
            audioListener.forwardZ.setTargetAtTime(forward.z, t, smooth);
            audioListener.upX.setTargetAtTime(up.x, t, smooth);
            audioListener.upY.setTargetAtTime(up.y, t, smooth);
            audioListener.upZ.setTargetAtTime(up.z, t, smooth);
        } else if (audioListener.setOrientation) {
            audioListener.setOrientation(
                forward.x, forward.y, forward.z,
                up.x, up.y, up.z
            );
        }
    }

    /** Get current listener audio position as plain object */
    get position() {
        if (this.characterMode && this._character3D) {
            return {
                x: this._character3D.position.x,
                y: this._character3D.position.y + 1.7, // hauteur d'écoute du personnage
                z: this._character3D.position.z,
            };
        }
        const p = this.camera.position;
        return { x: p.x, y: p.y, z: p.z };
    }

    /** Distance to FOH reference point */
    get distanceToFOH() {
        if (this.characterMode && this._character3D) {
            const p = this._character3D.position;
            const dx = p.x - FOH.x;
            const dy = (p.y + 1.7) - FOH.y;
            const dz = p.z - FOH.z;
            return Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        return this.camera.position.distanceTo(FOH);
    }
}
