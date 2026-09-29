/**
 * StrobeManager.js
 * ─────────────────────────────────────────────────────────────
 * Gestionnaire de l'ensemble des projecteurs stroboscopes de la scène :
 * - Ajout, suppression, duplication, énumération.
 * - Boucle de mise à jour synchronisée (updateAll).
 * - Raycasting pour la sélection 3D (getStrobeObjects / getStrobeFromObject).
 * ─────────────────────────────────────────────────────────────
 */

import * as THREE from 'three';
import { StrobeLight } from './StrobeLight.js?v=13';
import { StrobeLightPool } from './StrobeLightPool.js?v=4';

export class StrobeManager {
    /**
     * @param {object} options
     * @param {THREE.Scene} options.scene
     * @param {THREE.Camera} options.camera
     * @param {THREE.WebGLRenderer} options.renderer
     */
    constructor({ scene, camera, renderer }) {
        this.scene    = scene;
        this.camera   = camera;
        this.renderer = renderer;

        this.lightPool = new StrobeLightPool(scene); // lumières réelles à nombre constant (aucune recompilation à la pose)
        this._strobes = new Map(); // Map<id, StrobeLight>
        this._nextNumber = 1;
        this._emit = null;         // émission multijoueur (branchée par l'AmbiancePanel)
    }

    /** Branche l'envoi réseau (les messages reçus sont appliqués sans renvoi) */
    setSyncEmitter(fn) {
        this._emit = fn;
        for (const s of this._strobes.values()) s._emit = fn;
    }

    /** Identifiant numérique unique entre joueurs (0 est réservé au stroboscope du spawn) */
    _makeId() {
        let id;
        do {
            id = (Math.floor(Date.now() / 10) % 1e9) * 100 + Math.floor(Math.random() * 100) + 1;
        } while (this._strobes.has(id));
        return id;
    }

    /**
     * Ajoute un nouveau stroboscope dans la scène
     * @param {THREE.Vector3} [position]
     * @param {object} [params]
     * @param {number|null} [customId] identifiant imposé (spawn, réseau) — sinon nouveau stroboscope local, annoncé aux autres joueurs
     * @returns {{ id: number, strobe: StrobeLight }}
     */
    addStrobe(position = new THREE.Vector3(0, 8, -5), params = {}, customId = null) {
        const isNew = customId === null || customId === undefined;
        const id = isNew ? this._makeId() : (typeof customId === 'number' ? customId : parseInt(customId, 10));
        if (this._strobes.has(id)) return { id, strobe: this._strobes.get(id) };
        const strobe = new StrobeLight({
            id,
            number: this._nextNumber++,
            scene: this.scene,
            position,
            params,
            emit: this._emit
        });
        this._strobes.set(id, strobe);

        // Annonce aux autres joueurs, après les réglages éventuels faits juste après la création
        if (isNew && this._emit) {
            queueMicrotask(() => {
                if (this._strobes.get(id) === strobe && this._emit) {
                    this._emit({ category: 'strobe_add', data: { id, params: { ...strobe.params } } });
                }
            });
        }

        return { id, strobe };
    }

    /**
     * Supprime un stroboscope
     * @param {number} id
     */
    removeStrobe(id) {
        const numId = typeof id === 'number' ? id : parseInt(id, 10);
        const strobe = this._strobes.get(numId);
        if (strobe) {
            this.lightPool.release(strobe);
            strobe.dispose();
            this._strobes.delete(numId);
            if (this._emit) this._emit({ category: 'strobe_remove', id: numId });
            return true;
        }
        return false;
    }

    /**
     * Duplique un stroboscope existant
     * @param {number} id
     */
    duplicateStrobe(id) {
        const strobe = this.getStrobe(id);
        if (!strobe) return null;

        const newPos = new THREE.Vector3(
            strobe.params.posX + 1.5,
            strobe.params.posY,
            strobe.params.posZ
        );
        const dupParams = { ...strobe.params };
        delete dupParams.posX;
        delete dupParams.posY;
        delete dupParams.posZ;

        return this.addStrobe(newPos, dupParams);
    }

    /**
     * Récupère un stroboscope par son ID
     * @param {number} id
     * @returns {StrobeLight|null}
     */
    getStrobe(id) {
        const numId = typeof id === 'number' ? id : parseInt(id, 10);
        return this._strobes.get(numId) || null;
    }

    /**
     * Retourne tous les stroboscopes actifs
     * @returns {StrobeLight[]}
     */
    getAllStrobes() {
        return Array.from(this._strobes.values());
    }

    /**
     * Nombre de stroboscopes
     */
    get count() {
        return this._strobes.size;
    }

    /**
     * Retourne la liste des meshes cliquables pour le Raycasting dans la scène 3D
     * @returns {THREE.Mesh[]}
     */
    getStrobeObjects() {
        const objects = [];
        for (const strobe of this._strobes.values()) {
            objects.push(...strobe.getPickableObjects());
        }
        return objects;
    }

    /**
     * Retrouve l'instance de StrobeLight à partir d'un mesh cliqué
     * @param {THREE.Object3D} object
     * @returns {StrobeLight|null}
     */
    getStrobeFromObject(object) {
        let cur = object;
        while (cur) {
            if (cur.userData && cur.userData.strobeInstance) {
                return cur.userData.strobeInstance;
            }
            cur = cur.parent;
        }
        return null;
    }

    /**
     * Met à jour tous les stroboscopes actifs pour la frame courante
     * @param {number} dt Delta time
     */
    updateAll(dt) {
        for (const strobe of this._strobes.values()) {
            strobe.update(dt);
        }
        this.lightPool.update(this._strobes.values(), this.camera, dt);
    }

    /**
     * Nettoyage complet
     */
    dispose() {
        for (const strobe of this._strobes.values()) {
            strobe.dispose();
        }
        this._strobes.clear();
        this.lightPool.dispose();
    }
}
