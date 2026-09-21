/**
 * Listener — FPS-style movement controls + AudioContext listener sync.
 *
 * Uses PointerLockControls for mouse look.
 * WASD / Arrow keys for horizontal movement.
 * Space / Shift for vertical movement.
 */
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { Character } from './character.js';

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
     */
    constructor(camera, domElement) {
        this.camera = camera;
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
        this._character = new Character(camera);

        this._onKeyDown = this._onKeyDown.bind(this);
        this._onKeyUp = this._onKeyUp.bind(this);

        // Pre-allocated vectors to avoid GC pressure in per-frame methods
        this._direction = new THREE.Vector3();
        this._forward = new THREE.Vector3();
        this._up = new THREE.Vector3();

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
            origOnMouseMove(e);
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
                if (this.characterMode) this._character.snapToGround();
                if (this._onModeChange) this._onModeChange(this.characterMode);
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

        // Move in the direction the camera is facing (horizontal only)
        this.controls.moveRight(this._currentSpeed.x * dt);
        this.controls.moveForward(this._currentSpeed.y * dt);

        if (this.characterMode) {
            this._character.update(dt, this.move.up);
        } else {
            // Free-fly vertical movement (world Y)
            if (this.move.up)   this.camera.position.y += VERTICAL_SPEED * dt;
            if (this.move.down) this.camera.position.y -= VERTICAL_SPEED * dt;
        }

        // Clamp to bounds
        const p = this.camera.position;
        p.x = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, p.x));
        p.y = Math.max(BOUNDS.minY, Math.min(BOUNDS.maxY, p.y));
        p.z = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, p.z));
    }

    /**
     * Sync the Web Audio API listener with the Three.js camera.
     * @param {AudioListener} audioListener — ctx.listener
     */
    syncAudioListener(audioListener) {
        const p = this.camera.position;

        // Position: update WebAudio listener position
        if (audioListener.positionX) {
            audioListener.positionX.value = p.x;
            audioListener.positionY.value = p.y;
            audioListener.positionZ.value = p.z;
        }
        if (audioListener.setPosition) {
            audioListener.setPosition(p.x, p.y, p.z);
        }

        // Orientation: forward (-Z) and up (+Y) vectors derived strictly from camera quaternion.
        // Guaranteed to be normalized (|v| = 1) and orthogonal (forward · up = 0) with zero lag.
        const forward = this._forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const up = this._up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);

        if (audioListener.forwardX) {
            audioListener.forwardX.value = forward.x;
            audioListener.forwardY.value = forward.y;
            audioListener.forwardZ.value = forward.z;
            audioListener.upX.value = up.x;
            audioListener.upY.value = up.y;
            audioListener.upZ.value = up.z;
        }
        if (audioListener.setOrientation) {
            audioListener.setOrientation(
                forward.x, forward.y, forward.z,
                up.x, up.y, up.z
            );
        }
    }

    /** Get current position as plain object */
    get position() {
        const p = this.camera.position;
        return { x: p.x, y: p.y, z: p.z };
    }

    /** Distance to FOH reference point */
    get distanceToFOH() {
        return this.camera.position.distanceTo(FOH);
    }
}
