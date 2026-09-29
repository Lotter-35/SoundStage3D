/**
 * StrobeLightPool.js
 * ─────────────────────────────────────────────────────────────
 * Éclairage RÉEL de la scène par les stroboscopes, à coût constant :
 *   - pool FIXE de SpotLight créées au démarrage (jamais ajoutées / retirées : poser ou supprimer
 *     un stroboscope ne change plus le nombre de lumières, donc ne recompile plus aucun shader)
 *   - SHADOW_LIGHTS lumières avec ombre portée, attribuées aux stroboscopes les plus puissants
 *     (qu'ils soient loin ou proches) ; PLAIN_LIGHTS lumières sans ombre pour les autres
 *     et pour le remplissage qui dose l'intensité des ombres (shadowIntensity < 1)
 *   - un stroboscope sans lumière réelle garde son écran émissif et son bloom
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';

// Chaque lumière réelle alourdit le shader de TOUS les matériaux éclairés (~1,2 ms/lumière à ombre et ~0,25 ms/lumière simple
// en 1080p, ×4 en 4K) même éteinte : le pool reste volontairement petit.
export const STROBE_SHADOW_LIGHTS = 1;
export const STROBE_PLAIN_LIGHTS = 3;

const SHADOW_MAP_SIZE = 1024; // 4x moins de pixels à rendre ; le filtre doux compense la finesse
const FADE_RATE = 8;     // par seconde : fondu lors d'un changement d'attribution
const HOLD_BONUS = 1.3;  // un stroboscope déjà éclairé garde sa lumière (pas de va-et-vient)

export class StrobeLightPool {
    /** @param {THREE.Scene} scene */
    constructor(scene) {
        this.scene = scene;
        this.shadowSlots = [];
        this.plainSlots = [];
        for (let i = 0; i < STROBE_SHADOW_LIGHTS; i++) this.shadowSlots.push(this._makeSlot(true, i));
        for (let i = 0; i < STROBE_PLAIN_LIGHTS; i++) this.plainSlots.push(this._makeSlot(false, i));
        this._ranked = [];
        this._wantShadow = new Set();
        this._wantPlain = new Set();
        this._color = new THREE.Color();
    }

    _makeSlot(shadow, index) {
        const light = new THREE.SpotLight(0xffffff, 0);
        light.name = (shadow ? 'strobe-pool-shadow-' : 'strobe-pool-') + index;
        light.userData.isAmbianceInternal = true;
        light.angle = 1.40;
        light.penumbra = 0.8;
        light.decay = 1.0;
        light.castShadow = shadow;
        if (shadow) {
            light.shadow.bias = -0.00012;
            light.shadow.normalBias = 0.03;
            light.shadow.camera.near = 1.0; // plan proche éloigné : la profondeur est bien plus précise, le biais peut rester minuscule (pas de fuite de lumière au pied des objets)
            light.shadow.camera.far = 100;
            light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
            // Carte d'ombre redessinée uniquement quand la lumière est utilisée (voir update)
            light.shadow.autoUpdate = false;
        }
        light.target.name = light.name + '-target';
        light.target.userData.isAmbianceInternal = true;
        this.scene.add(light);
        this.scene.add(light.target);
        return { light, strobe: null, weight: 0, shadow };
    }

    /** Libère immédiatement les lumières d'un stroboscope supprimé */
    release(strobe) {
        for (const s of this.shadowSlots) if (s.strobe === strobe) this._clearSlot(s);
        for (const s of this.plainSlots) if (s.strobe === strobe) this._clearSlot(s);
    }

    _clearSlot(s) {
        s.strobe = null;
        s.weight = 0;
        s.light.intensity = 0;
        if (s.shadow) s.light.shadow.autoUpdate = false;
    }

    _holds(strobe) {
        for (const s of this.shadowSlots) if (s.strobe === strobe && s.weight > 0) return true;
        for (const s of this.plainSlots) if (s.strobe === strobe && s.weight > 0) return true;
        return false;
    }

    /**
     * @param {Iterable<import('./StrobeLight.js').StrobeLight>} strobes
     * @param {THREE.Camera} camera
     * @param {number} dt
     */
    update(strobes, camera, dt) {
        // 1. Classement par importance : puissance × portée, atténuée par la distance à la caméra
        //    relativement à la portée (un strobo puissant et à longue portée reste prioritaire même loin)
        const ranked = this._ranked;
        ranked.length = 0;
        for (const st of strobes) {
            const power = st.getEffectiveIntensity();
            if (power <= 0.001) continue;
            const range = st.getEffectiveLightDistance();
            const d = camera.position.distanceTo(st.group.position);
            let score = power * range / (1 + d / range);
            if (this._holds(st)) score *= HOLD_BONUS;
            st._poolScore = score;
            st._poolPower = power;
            ranked.push(st);
        }
        ranked.sort((a, b) => b._poolScore - a._poolScore);

        // 2. Besoins : ombre pour les plus puissants qui la demandent, lumière simple pour les autres
        //    (et pour le remplissage d'un stroboscope à ombre dont l'intensité d'ombre est < 1)
        const wantShadow = this._wantShadow;
        const wantPlain = this._wantPlain;
        wantShadow.clear();
        wantPlain.clear();
        for (const st of ranked) {
            const p = st.params;
            const weight = p.shadowIntensity !== undefined ? p.shadowIntensity : 1.0;
            if (p.castShadow && weight > 0.001 && wantShadow.size < this.shadowSlots.length) {
                wantShadow.add(st);
                if (weight < 0.999 && wantPlain.size < this.plainSlots.length) wantPlain.add(st);
            } else if (wantPlain.size < this.plainSlots.length) {
                wantPlain.add(st);
            }
        }

        const step = dt * FADE_RATE;
        this._assign(this.shadowSlots, wantShadow, step);
        this._assign(this.plainSlots, wantPlain, step);

        // 3. Réglage des lumières
        for (const s of this.shadowSlots) this._apply(s, true);
        for (const s of this.plainSlots) this._apply(s, false);
    }

    _assign(slots, wanted, step) {
        for (const s of slots) {
            if (!s.strobe) continue;
            if (wanted.has(s.strobe)) {
                s.weight = Math.min(1, s.weight + step);
            } else {
                s.weight = Math.max(0, s.weight - step);
                if (s.weight === 0) this._clearSlot(s);
            }
        }
        for (const st of wanted) {
            if (slots.some(s => s.strobe === st)) continue;
            const free = slots.find(s => s.strobe === null);
            if (!free) break;
            free.strobe = st;
            free.weight = Math.min(1, step);
        }
    }

    _apply(s, isShadowSlot) {
        const st = s.strobe;
        const light = s.light;
        if (!st || s.weight <= 0 || !st.flash) {
            light.intensity = 0;
            if (isShadowSlot) light.shadow.autoUpdate = false;
            return;
        }

        const p = st.params;
        const total = st._poolPower;
        const shadowWeight = THREE.MathUtils.clamp(p.shadowIntensity !== undefined ? p.shadowIntensity : 1.0, 0, 1);
        const hasShadowSlot = this.shadowSlots.some(o => o.strobe === st && o.weight > 0);

        let power;
        if (isShadowSlot) power = total * shadowWeight;
        else power = hasShadowSlot ? total * (1 - shadowWeight) : total;
        if (power <= 0.001) {
            light.intensity = 0;
            if (isShadowSlot) light.shadow.autoUpdate = false;
            return;
        }

        const dist = st.getEffectiveLightDistance();
        st.getLightSetup(light.position, light.target.position);
        light.target.updateMatrixWorld();
        light.distance = dist;
        light.color.copy(this._color.set(p.color));
        light.intensity = power * s.weight;

        if (isShadowSlot) {
            // Douceur des bords d'ombre : rayon de filtre en texels (voir scene/softShadows.js)
            const soft = THREE.MathUtils.clamp(p.shadowSoftness !== undefined ? p.shadowSoftness : 0.5, 0, 1);
            light.shadow.radius = soft <= 0.02 ? 1 : 1 + soft * 4;
            const far = Math.max(100.0, dist);
            if (light.shadow.camera.far !== far) {
                light.shadow.camera.far = far;
                light.shadow.camera.updateProjectionMatrix();
            }
            light.shadow.autoUpdate = true;
        }
    }

    dispose() {
        for (const s of this.shadowSlots.concat(this.plainSlots)) {
            this.scene.remove(s.light);
            this.scene.remove(s.light.target);
            if (s.light.shadow && s.light.shadow.map) s.light.shadow.map.dispose();
        }
        this.shadowSlots.length = 0;
        this.plainSlots.length = 0;
    }
}
