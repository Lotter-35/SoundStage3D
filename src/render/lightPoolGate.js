/**
 * lightPoolGate.js — Masque les pools de lumières (lasers, strobes, lyres) quand la scène n'a aucun appareil.
 *
 * Les pools restent dans la scène à intensité 0 pour que poser un appareil ne recompile rien. Éteintes,
 * elles ne coûtent presque plus rien (skipDarkLights.js), mais chaque pixel éclairé parcourt encore leurs
 * boucles : ~0,8 ms en 4K pour les 14 lumières dans une scène vide.
 *
 * Deux états seulement : pools affichés dès qu'il y a au moins un appareil, masqués quand il n'y en a
 * aucun. Changer le nombre de lumières change les shaders : la variante « pools masqués » est préparée
 * pendant l'écran de chargement (compilée PUIS dessinée une fois hors écran — sous Windows, ANGLE finit
 * de préparer les shaders au premier dessin). Ensuite la bascule est instantanée (shaders en cache).
 * Rendu identique (des lumières éteintes n'ajoutaient rien).
 */

export class LightPoolGate {
    /**
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     * @param {() => (THREE.WebGLRenderTarget|null)} getTarget cible dans laquelle la scène est rendue
     *        (les variantes de shaders dépendent de la cible : espace couleur)
     * @param {() => boolean} inUse vrai si au moins un appareil (laser, strobe, lyre) est dans la scène
     */
    constructor(renderer, scene, camera, getTarget, inUse) {
        this.renderer = renderer;
        this.scene = scene;
        this.camera = camera;
        this.getTarget = getTarget;
        this.inUse = inUse;
        this.lights = [];
        this.shown = true;
        this._ready = false; // variante « pools masqués » préparée
    }

    /** @param {THREE.Light[]} lights */
    addPool(lights) {
        for (const l of lights) if (l) this.lights.push(l);
    }

    _apply(visible) {
        this.shown = visible;
        for (const l of this.lights) l.visible = visible;
    }

    /**
     * Prépare la variante « pools masqués » (à appeler pendant l'écran de chargement) :
     * compilation en parallèle, puis un dessin hors écran pour finir la préparation des shaders.
     */
    async prewarm() {
        const r = this.renderer;
        const target = this.getTarget();
        if (!target || typeof r.compileAsync !== 'function') return;
        const prevTarget = r.getRenderTarget();
        const was = this.shown;
        try {
            this._apply(false);
            r.setRenderTarget(target);
            const job = r.compileAsync(this.scene, this.camera);
            r.setRenderTarget(prevTarget);
            this._apply(was);
            await job;
            // Dessin hors écran de la variante (l'image affichée n'est pas touchée)
            this._apply(false);
            const shadowAuto = r.shadowMap.autoUpdate;
            r.shadowMap.autoUpdate = false;
            r.setRenderTarget(target);
            r.render(this.scene, this.camera);
            r.shadowMap.autoUpdate = shadowAuto;
            this._ready = true;
        } catch (e) {
            console.warn('[LightPoolGate] préparation impossible :', e);
        } finally {
            r.setRenderTarget(prevTarget);
            this._apply(was);
        }
    }

    /** À appeler à chaque image (un seul test tant que rien ne change) */
    update() {
        if (!this._ready) return; // tant que la variante n'est pas prête, on garde les pools (aucun gel)
        const want = Boolean(this.inUse());
        if (want !== this.shown) this._apply(want);
    }
}
