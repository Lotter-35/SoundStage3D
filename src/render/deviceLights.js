/**
 * deviceLights.js — Test de performance : retire de la scène les lumières Three.js des appareils
 * (pools des lasers, des stroboscopes et des lyres / barres LED), ombres comprises.
 *
 * Les lumières sont vraiment retirées (pas masquées) : les shaders éclairés sont recompilés sans elles.
 * Les lumières de base (soleil, ambiance, ciel, rebonds de la GI, lumières posées à la main) restent.
 * Les faisceaux, nappes, halos et la fumée restent affichés ; les lyres gardent la tache de lumière
 * calculée par leur shader. Remettre les lumières recompile à nouveau les shaders (gel attendu).
 */

export class DeviceLights {
    constructor() {
        /** @type {{light: THREE.Light, parent: THREE.Object3D|null}[]} */
        this._entries = [];
        this._onChange = [];
        this.removed = false;
    }

    /** @param {THREE.Light[]} lights */
    addLights(lights) {
        for (const light of lights) if (light) this._entries.push({ light, parent: null });
    }

    /** @param {(removed: boolean) => void} fn appelé après chaque changement */
    onChange(fn) {
        this._onChange.push(fn);
    }

    /** @param {boolean} removed */
    setRemoved(removed) {
        removed = Boolean(removed);
        if (removed === this.removed) return;
        this.removed = removed;
        for (const e of this._entries) {
            const { light } = e;
            const target = light.target && light.target.isObject3D ? light.target : null;
            if (removed) {
                e.parent = light.parent;
                if (light.parent) light.parent.remove(light);
                if (target && target.parent) target.parent.remove(target);
            } else if (e.parent) {
                e.parent.add(light);
                if (target && !target.parent) e.parent.add(target);
                e.parent = null;
            }
        }
        for (const fn of this._onChange) fn(removed);
    }
}
