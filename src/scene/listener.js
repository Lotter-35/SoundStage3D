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

const MOVE_SPEED    = 7;   // m/s
const VERTICAL_SPEED = 8;  // m/s
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

        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
    }

    /** Set mouse look sensitivity. @param {number} value — 0.1 to 3.0 */
    setSensitivity(value) {
        this.controls.pointerSpeed = value;
    }

    lock() {
        this.controls.lock();
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

        // Move in the direction the camera is facing (horizontal only)
        this.controls.moveRight(direction.x * MOVE_SPEED * dt);
        this.controls.moveForward(-direction.z * MOVE_SPEED * dt);

        if (this.characterMode) {
            const isMoving = this.move.forward || this.move.backward || this.move.left || this.move.right;
            this._character.update(dt, this.move.up, isMoving);
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
        const t = this._audioCtxTime; // set externally before calling
        const smooth = 0.03; // 30ms ramp — smooth listener movement

        // Position (smooth ramp to avoid crackling)
        if (audioListener.positionX) {
            audioListener.positionX.setTargetAtTime(p.x, t, smooth);
            audioListener.positionY.setTargetAtTime(p.y, t, smooth);
            audioListener.positionZ.setTargetAtTime(p.z, t, smooth);
        } else {
            audioListener.setPosition(p.x, p.y, p.z);
        }

        // Orientation: forward and up vectors from camera
        const forward = this._forward;
        this.camera.getWorldDirection(forward);

        const up = this._up;
        up.set(0, 1, 0);
        up.applyQuaternion(this.camera.quaternion);

        if (audioListener.forwardX) {
            audioListener.forwardX.setTargetAtTime(forward.x, t, smooth);
            audioListener.forwardY.setTargetAtTime(forward.y, t, smooth);
            audioListener.forwardZ.setTargetAtTime(forward.z, t, smooth);
            audioListener.upX.setTargetAtTime(up.x, t, smooth);
            audioListener.upY.setTargetAtTime(up.y, t, smooth);
            audioListener.upZ.setTargetAtTime(up.z, t, smooth);
        } else {
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
