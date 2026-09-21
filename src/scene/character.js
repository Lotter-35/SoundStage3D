/**
 * Character — Physique du personnage et effet de pas (Head Bobbing) cinématique.
 *
 * Gère :
 *   - Hauteur de base physique découplée de l'effet visuel (aucun à-coup de collision au sol)
 *   - Effet de pas doux et organique avec amorti naturel
 *   - Saut réaliste avec compression douce à l'atterrissage
 */

const PLAYER_HEIGHT = 1.7;  // hauteur des yeux en mètres
const GRAVITY       = 18;   // m/s²
const JUMP_VELOCITY = 4.8;  // m/s — saut naturel (~0.6m)

// View bobbing cinématique et doux
const BOB_FREQ  = 1.8;      // Hz (~1.8 pas par seconde, rythme naturel)
const BOB_AMP_Y = 0.014;    // mètres — oscillation verticale douce (1.4 cm)
const BOB_AMP_X = 0.007;    // mètres — légère oscillation latérale

export class Character {
    /**
     * @param {THREE.Camera} camera
     */
    constructor(camera) {
        this.camera = camera;

        // Base physique indépendante (pour ne jamais heurter la collision au sol pendant le bobbing)
        this._baseY = PLAYER_HEIGHT;
        this._verticalVelocity = 0;
        this._onGround = true;

        // View bobbing
        this._bobPhase = 0;
        this._bobCurrentY = 0;
        this._bobCurrentX = 0;
        this._landingDip = 0; // amorti doux à l'atterrissage
    }

    /**
     * Réinitialise le personnage au sol (mode F activé).
     */
    snapToGround() {
        this._baseY = PLAYER_HEIGHT;
        this._verticalVelocity = 0;
        this._onGround = true;
        this._bobPhase = 0;
        this._bobCurrentY = 0;
        this._bobCurrentX = 0;
        this._landingDip = 0;
        this.camera.position.y = PLAYER_HEIGHT;
    }

    /**
     * Mise à jour physique + bobbing.
     *
     * @param {number}  dt            — delta time en secondes
     * @param {boolean} jumpInput     — touche saut pressée
     * @param {boolean} isMoving      — le joueur se déplace horizontalement
     * @param {number}  speedFraction — ratio de vitesse actuelle (0..1)
     */
    update(dt, jumpInput, isMoving, speedFraction = 1.0) {
        // ── Saut ──────────────────────────────────────────────────────
        if (jumpInput && this._onGround) {
            this._verticalVelocity = JUMP_VELOCITY;
            this._onGround = false;
        }

        // ── Gravité et physique sur la hauteur de base ────────────────
        if (!this._onGround) {
            this._verticalVelocity -= GRAVITY * dt;
            this._baseY += this._verticalVelocity * dt;

            // Collision avec le sol
            if (this._baseY <= PLAYER_HEIGHT) {
                const impact = Math.abs(this._verticalVelocity);
                this._baseY = PLAYER_HEIGHT;
                this._verticalVelocity = 0;
                this._onGround = true;
                // Léger amorti d'atterrissage progressif
                this._landingDip = Math.min(0.035, impact * 0.007);
            }
        }

        // Résorption douce de l'amorti d'atterrissage
        if (this._landingDip > 0.0005) {
            this._landingDip += (0 - this._landingDip) * Math.min(1, dt * 10);
        } else {
            this._landingDip = 0;
        }

        // ── Effet de pas doux et progressif ───────────────────────────
        if (isMoving && this._onGround && speedFraction > 0.05) {
            // Avancement de phase proportionnel à la vitesse
            this._bobPhase += BOB_FREQ * 2 * Math.PI * dt * speedFraction;

            // Courbe en cloche douce (2 pas par cycle complet)
            const targetY = Math.sin(this._bobPhase * 2) * BOB_AMP_Y;
            const targetX = Math.sin(this._bobPhase) * BOB_AMP_X;

            // Lissage très doux pour éliminer tout à-coup
            this._bobCurrentY += (targetY - this._bobCurrentY) * Math.min(1, dt * 10);
            this._bobCurrentX += (targetX - this._bobCurrentX) * Math.min(1, dt * 8);
        } else {
            // Retour fluide au repos
            this._bobCurrentY += (0 - this._bobCurrentY) * Math.min(1, dt * 7);
            this._bobCurrentX += (0 - this._bobCurrentX) * Math.min(1, dt * 7);
            if (Math.abs(this._bobCurrentY) < 0.0002) {
                this._bobCurrentY = 0;
                this._bobCurrentX = 0;
                this._bobPhase = 0;
            }
        }

        // Hauteur finale = base physique + décalage doux - amorti
        this.camera.position.y = this._baseY + this._bobCurrentY - this._landingDip;
    }

    get onGround() { return this._onGround; }
}
