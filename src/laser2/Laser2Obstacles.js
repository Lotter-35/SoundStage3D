/**
 * Laser2Obstacles.js — obstacles de la scène pour les nouveaux lasers (fil principal).
 * Chaque obstacle de la scène est un groupe d'une boîte ; la tour régie FOH est un seul groupe
 * (ses ~80 boîtes ne sont testées que si le rayon touche sa boîte englobante).
 * Le résultat est envoyé au cœur de calcul (Web Worker), qui ne peut pas importer la scène.
 */

import { getStageObstacles } from '../laser/LaserSceneIntersector.js';
import { FOH_TOWER_SOLIDS } from '../scene/fohTower.js';

/** @returns {number[][][]} groupes de boîtes [minX, minY, minZ, maxX, maxY, maxZ] */
export function buildLaser2ObstacleGroups() {
    const groups = [];
    for (const b of getStageObstacles()) groups.push([[b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ]]);
    groups.push(FOH_TOWER_SOLIDS.map(([, x0, x1, y0, y1, z0, z1]) => [x0, y0, z0, x1, y1, z1]));
    return groups;
}
