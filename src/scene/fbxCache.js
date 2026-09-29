/**
 * fbxCache.js — Chargement FBX partagé (téléchargé et analysé une seule fois)
 *
 * Le modèle Ybot et les animations de locomotion servent à la fois au joueur local
 * (Character3D) et aux avatars des autres joueurs (PlayerAvatars) : chacun part du même
 * objet analysé et le clone (SkeletonUtils) au lieu de relancer téléchargement + analyse.
 * Les objets renvoyés sont des GABARITS : ne jamais les ajouter tels quels à la scène.
 */
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export const YBOT_PATH = 'src/assets/models/Ybot.fbx';

const _loader = new FBXLoader();
const _cache = new Map();

/** @returns {Promise<THREE.Group>} gabarit FBX partagé (à cloner) */
export function loadFbxShared(path) {
    let p = _cache.get(path);
    if (!p) {
        p = _loader.loadAsync(path);
        p.catch(() => _cache.delete(path)); // un échec ne reste pas en cache : nouvel essai possible
        _cache.set(path, p);
    }
    return p;
}
