/**
 * Character — Physique du personnage en mode sol (mode F).
 * Gère uniquement la gravité, les sauts et la hauteur des yeux (caméra stable à 100%).
 */

const PLAYER_HEIGHT = 1.7;  // hauteur des yeux en mètres
const GRAVITY       = 18;   // m/s²
const JUMP_VELOCITY = 4.8;  // m/s — saut naturel

export class Character {
    /**
     * @param {THREE.Camera} camera
     */
    constructor(camera) {
        this.camera = camera;
        this._verticalVelocity = 0;
        this._onGround = true;
    }

    /**
     * Réinitialise le personnage au sol (mode F activé).
     */
    snapToGround() {
        this.camera.position.y = PLAYER_HEIGHT;
        this._verticalVelocity = 0;
        this._onGround = true;
    }

    /**
     * Mise à jour de la physique (gravité et saut, caméra parfaitement stable).
     *
     * @param {number}  dt        — delta time en secondes
     * @param {boolean} jumpInput — touche saut pressée
     */
    update(dt, jumpInput) {
        // ── Saut ──────────────────────────────────────────────────────
        if (jumpInput && this._onGround) {
            this._verticalVelocity = JUMP_VELOCITY;
            this._onGround = false;
        }

        // ── Gravité ───────────────────────────────────────────────────
        if (!this._onGround) {
            this._verticalVelocity -= GRAVITY * dt;
            this.camera.position.y += this._verticalVelocity * dt;

            // Collision avec le sol
            if (this.camera.position.y <= PLAYER_HEIGHT) {
                this.camera.position.y = PLAYER_HEIGHT;
                this._verticalVelocity = 0;
                this._onGround = true;
            }
        } else {
            this.camera.position.y = PLAYER_HEIGHT;
        }
    }

    get onGround() { return this._onGround; }
}
