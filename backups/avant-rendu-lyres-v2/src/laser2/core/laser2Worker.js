/**
 * laser2Worker.js — Web Worker des nouveaux lasers.
 * ─────────────────────────────────────────────────────────────
 * Tout le calcul lourd des lasers tourne ici, en parallèle du rendu :
 * simulation des galvos, réduction en faisceaux / nappes, collisions, géométrie monde.
 * Le fil principal envoie les réglages (quand ils changent) et l'heure commune à chaque image,
 * et reçoit la géométrie prête à dessiner dans UN tampon (rendu au worker pour être réutilisé).
 *
 * Messages reçus : init { groups } · set { id, params?, transform?, docKey? } · remove { id }
 *                  doc { key, frames } · frame { t, players, preview, buffer? }
 * Message envoyé : result { buffer, header, preview, ms, prims, shared, tolScale }
 * ─────────────────────────────────────────────────────────────
 */

import { CoreSystem } from './Laser2Core.js';
import { setObstacleGroups, setPlayerCapsules } from './Collision.js';
import { packResult } from './pack.js';

const sys = new CoreSystem();
let spare = null;

self.onmessage = (e) => {
    const m = e.data;
    switch (m.type) {
        case 'init':
            setObstacleGroups(m.groups);
            break;
        case 'set':
            sys.set(m.id, m);
            break;
        case 'remove':
            sys.remove(m.id);
            break;
        case 'doc':
            sys.setDoc(m.key, m.frames);
            break;
        case 'frame': {
            if (m.buffer) spare = m.buffer;
            setPlayerCapsules(m.players);
            const t0 = performance.now();
            sys.update(m.t);
            const { buffer, header } = packResult(sys, spare);
            spare = null;
            const preview = m.preview ? sys.preview(m.preview) : null;
            const transfer = [buffer];
            if (preview) for (const k of ['ux', 'uy', 'ax', 'ay', 'pr', 'pg', 'pb']) transfer.push(preview[k].buffer);
            self.postMessage({
                type: 'result', buffer, header, preview, previewId: m.preview,
                ms: performance.now() - t0, prims: sys.totalPrims, shared: sys.shared, tolScale: sys.tolScale,
            }, transfer);
            break;
        }
        default:
    }
};
