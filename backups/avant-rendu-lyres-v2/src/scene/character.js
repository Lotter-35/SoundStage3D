/**
 * Character — Physique du personnage en mode sol (mode F).
 *
 * Gère :
 *   - Gravité et saut réaliste
 *   - View bobbing (oscillation verticale de la caméra lors du déplacement)
 *
 * Conçu pour être facilement étendu : animations, apparence, footsteps, etc.
 */

const PLAYER_HEIGHT = 1.7;  // hauteur des yeux en mètres
const GRAVITY       = 18;   // m/s² (≈ terrestre = 9.8, exagéré pour gameplay = 18)
const JUMP_VELOCITY = 5.0;  // m/s  — saut réaliste (~1.0 m de hauteur)
// Formule : hauteur = v² / (2g) → 4.2² / (2×18) ≈ 0.49 m → ~50 cm, très naturel

// View bobbing
const BOB_FREQ  = 2.2;   // Hz (~1.1 pas/seconde, cadence de marche lente)
const BOB_AMP_Y = 0.032; // mètres — oscillation verticale
const BOB_AMP_X = 0.014; // mètres — légère oscillation latérale (optionnel à l'avenir)

export class Character {
    /**
     * @param {THREE.Camera} camera
     */
    constructor(camera) {
        this.camera = camera;

        // Physique
        this._verticalVelocity = 0;
        this._onGround = true;

        // View bobbing
        this._bobPhase   = 0;
        this._bobCurrent = 0;  // offset Y actuellement appliqué
    }

    /**
     * Réinitialise le personnage au sol (appelé lors de l'activation du mode F).
     */
    snapToGround() {
        this.camera.position.y  = PLAYER_HEIGHT;
        this._verticalVelocity  = 0;
        this._onGround          = true;
        this._bobPhase          = 0;
        this._bobCurrent        = 0;
    }

    /**
     * Mise à jour physique + bobbing. Appelé chaque frame depuis Listener.update().
     *
     * @param {number}  dt        — delta time en secondes
     * @param {boolean} jumpInput — touche saut pressée
     * @param {boolean} isMoving  — le joueur se déplace horizontalement
     */
    update(dt, jumpInput, isMoving) {
        // ── Saut ──────────────────────────────────────────────────────
        if (jumpInput && this._onGround) {
            this._verticalVelocity = JUMP_VELOCITY;
            this._onGround = false;
            this._bobPhase = 0; // réinitialise le cycle au décollage
        }

        // ── Gravité ───────────────────────────────────────────────────
        this._verticalVelocity -= GRAVITY * dt;
        this.camera.position.y += this._verticalVelocity * dt;

        // ── Collision sol ─────────────────────────────────────────────
        if (this.camera.position.y <= PLAYER_HEIGHT) {
            this.camera.position.y = PLAYER_HEIGHT;
            this._verticalVelocity = 0;
            this._onGround = true;
        }

        // ── View bobbing (uniquement au sol, en mouvement) ────────────
        if (isMoving && this._onGround) {
            this._bobPhase += BOB_FREQ * 2 * Math.PI * dt;
            const target = Math.sin(this._bobPhase) * BOB_AMP_Y;
            // Lerp rapide vers la cible pour un démarrage fluide
            this._bobCurrent += (target - this._bobCurrent) * Math.min(1, dt * 18);
        } else {
            // Retour progressif au neutre quand on s'arrête ou on est en l'air
            this._bobCurrent += (0 - this._bobCurrent) * Math.min(1, dt * 10);
            if (Math.abs(this._bobCurrent) < 0.0004) {
                this._bobCurrent = 0;
                this._bobPhase   = 0;
            }
        }

        this.camera.position.y += this._bobCurrent;
    }

    get onGround() { return this._onGround; }
}
