/**
 * DanceManager.js — Gestionnaire dynamique d'animations de danse et emotes.
 *
 * Fonctionnalités :
 * - Détection et catalogue 100% dynamiques depuis le dossier src/assets/animations/dance/
 * - Retargeting automatique des bones (mixamorig) vers le squelette de Ybot / character.
 * - Chargement paresseux (lazy loading) et mise en cache des AnimationClips.
 * - Gestion des 9 slots configurables (touches 1 à 9) avec nettoyage automatique si une danse est supprimée.
 */

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export let DANCE_CATALOG = [];

const DEFAULT_SLOTS = [null, null, null, null, null, null, null, null, null];

class DanceManagerClass {
    constructor() {
        this.loader = new FBXLoader();
        this.catalog = [];
        this.clipCache = new Map();         // danceId -> AnimationClip
        this.loadingPromises = new Map();   // danceId -> Promise<AnimationClip>
        this.slots = this._loadSlots();
        this.listeners = new Set();
        this.catalogListeners = new Set();

        // Charger immédiatement le catalogue dynamique au démarrage
        this.refreshCatalog();
    }

    clearCache() {
        this.clipCache.clear();
        this.loadingPromises.clear();
        this.cacheVersion = Date.now();
    }

    /**
     * Charge directement le catalogue depuis le fichier statique dances.json.
     * Si l'utilisateur actualise la page ou clique sur Actualiser, le fichier dances.json
     * est rechargé avec un cache-buster, sans passer par aucune API ni watcher.
     */
    async refreshCatalog(forceClearCache = false) {
        if (forceClearCache) {
            this.clearCache();
        }
        try {
            const cacheBuster = `?t=${Date.now()}`;
            const res = await fetch(`src/assets/animations/dance/dances.json${cacheBuster}`, { cache: 'no-store' });
            if (res && res.ok) {
                const data = await res.json();
                if (Array.isArray(data)) {
                    this.setCatalog(data);
                    return this.catalog;
                }
            }
            this.setCatalog([]);
        } catch (err) {
            console.warn('[DanceManager] Impossible de charger dances.json :', err);
            this.setCatalog([]);
        }
        return this.catalog;
    }

    setCatalog(newCatalog) {
        this.catalog = Array.isArray(newCatalog) ? newCatalog : [];
        DANCE_CATALOG = this.catalog;
        const validIds = new Set(this.catalog.map(d => d.id));
        for (const id of this.clipCache.keys()) {
            if (!validIds.has(id)) {
                this.clipCache.delete(id);
                this.loadingPromises.delete(id);
            }
        }
        this._cleanSlots();
        this._notifyCatalog();
    }

    onCatalogChange(cb) {
        this.catalogListeners.add(cb);
        return () => this.catalogListeners.delete(cb);
    }

    _notifyCatalog() {
        for (const cb of this.catalogListeners) {
            try { cb(this.catalog); } catch (e) { console.error(e); }
        }
    }

    _loadSlots() {
        try {
            const saved = localStorage.getItem('soundstage_dance_slots');
            if (saved) {
                const parsed = JSON.parse(saved);
                if (Array.isArray(parsed) && parsed.length === 9) {
                    return parsed;
                }
            }
        } catch (e) {
            console.warn('[DanceManager] Failed to load slots from localStorage:', e);
        }
        return [...DEFAULT_SLOTS];
    }

    _cleanSlots() {
        const validIds = new Set(this.catalog.map(d => d.id));
        let changed = false;
        for (let i = 0; i < this.slots.length; i++) {
            if (this.slots[i] && !validIds.has(this.slots[i])) {
                this.slots[i] = null;
                changed = true;
            }
        }
        if (changed) this.saveSlots();
    }

    saveSlots() {
        try {
            localStorage.setItem('soundstage_dance_slots', JSON.stringify(this.slots));
        } catch (e) {
            console.warn('[DanceManager] Failed to save slots to localStorage:', e);
        }
        this._notify();
    }

    getSlot(index) { // index 1..9
        return this.slots[index - 1] || null;
    }

    setSlot(index, danceId) { // index 1..9
        if (index < 1 || index > 9) return;

        // Si cette danse est déjà assignée à un autre slot, libérer cet ancien slot
        if (danceId) {
            for (let i = 0; i < this.slots.length; i++) {
                if (this.slots[i] === danceId) {
                    this.slots[i] = null;
                }
            }
        }

        this.slots[index - 1] = danceId || null;
        this.saveSlots();
    }

    isLoop(danceId) {
        if (!danceId) return true;
        const info = this.getInfo(danceId);
        if (info && typeof info.loop === 'boolean') {
            return info.loop;
        }
        return true; // Par défaut : boucle activée
    }

    getSpeed(danceId) {
        if (!danceId) return 1.0;
        const info = this.getInfo(danceId);
        if (info && typeof info.speed === 'number' && info.speed > 0) {
            return info.speed;
        }
        return 1.0;
    }

    onSlotsChange(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    _notify() {
        for (const cb of this.listeners) {
            try { cb(this.slots); } catch (e) { console.error(e); }
        }
    }

    getInfo(danceId) {
        if (!danceId) return null;
        const norm = String(danceId).toLowerCase().trim();
        return this.catalog.find(d => String(d.id).toLowerCase().trim() === norm) || null;
    }

    getAllAnimations() {
        return this.catalog;
    }

    /**
     * Charge et adapte (retarget) un clip FBX depuis src/assets/animations/dance/.
     * @param {string} danceId
     * @param {THREE.Object3D} targetModel
     * @returns {Promise<THREE.AnimationClip|null>}
     */
    async loadClip(danceId, targetModel) {
        const info = this.getInfo(danceId);
        if (!info) {
            console.error(`[DanceManager] Unknown dance ID: ${danceId}`);
            return null;
        }

        if (this.clipCache.has(danceId)) {
            return this.clipCache.get(danceId);
        }

        if (this.loadingPromises.has(danceId)) {
            return this.loadingPromises.get(danceId);
        }

        const promise = (async () => {
            try {
                const buster = this.cacheVersion ? `?t=${this.cacheVersion}` : '';
                const path = `src/assets/animations/dance/${info.file}${buster}`;
                const fbx = await this.loader.loadAsync(path);

                if (!fbx.animations || fbx.animations.length === 0) {
                    console.error(`[DanceManager] No animation in ${path}`);
                    return null;
                }

                const rawClip = fbx.animations[0];
                rawClip.name = danceId;

                // Retarget tracks pour correspondre aux bones du modèle cible (Ybot)
                const clip = this._retargetClip(rawClip, targetModel, fbx);

                this.clipCache.set(danceId, clip);
                return clip;
            } catch (err) {
                console.error(`[DanceManager] Error loading dance ${danceId}:`, err);
                return null;
            } finally {
                this.loadingPromises.delete(danceId);
            }
        })();

        this.loadingPromises.set(danceId, promise);
        return promise;
    }

    /**
     * Retargeting standard direct (1:1 comme dans Blender).
     * Les animations FBX Mixamo et le squelette Ybot partagent
     * la même nomenclature et la même armature Mixamo :
     * - Remap du nom de piste : mixamorigBoneName -> mixamorig:BoneName
     * - Suppression des pistes .scale
     * - Conservation des translations uniquement sur Hips (recentrage X/Z pour éviter le drift)
     * - Quaternions passés directement par défaut sans altération
     */
    _retargetClip(clip, targetModel, sourceFbx) {
        const modelBones = new Set();
        const boneMap = new Map(); // normalized -> actual model bone name

        if (targetModel) {
            targetModel.traverse(node => {
                if (node.name) {
                    modelBones.add(node.name);
                    const norm = node.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                    boneMap.set(norm, node.name);
                }
            });
        }

        const newTracks = [];

        for (const track of clip.tracks) {
            const dotIdx = track.name.lastIndexOf('.');
            if (dotIdx === -1) continue;
            const trackNode = track.name.substring(0, dotIdx);
            const prop = track.name.substring(dotIdx);

            const normTrack = trackNode.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

            let matchedBone = null;
            if (modelBones.has(trackNode)) {
                matchedBone = trackNode;
            } else if (boneMap.has(normTrack)) {
                matchedBone = boneMap.get(normTrack);
            }

            if (!matchedBone) continue;
            if (prop === '.scale') continue;

            const isHips = matchedBone.toLowerCase().includes('hips');
            if (prop === '.position' && !isHips) continue;

            // Renommer la track vers le bone du modèle cible
            track.name = `${matchedBone}${prop}`;

            // Hips.position : conserver Y (figures au sol, sauts), recentrer strictement X et Z
            if (prop === '.position' && isHips) {
                const values = track.values;
                const initialX = values[0];
                const initialZ = values[2];
                for (let i = 0; i < values.length; i += 3) {
                    values[i] = initialX;
                    values[i + 2] = initialZ;
                }
            }

            newTracks.push(track);
        }

        clip.tracks = newTracks;
        return clip;
    }
}

export const DanceManager = new DanceManagerClass();
