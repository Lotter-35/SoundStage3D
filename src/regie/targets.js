/**
 * targets.js — cibles des pistes de pattern.
 *
 * Une piste vise un groupe du show ({ group }), une liste fixe de projecteurs ({ keys }) ou tous les
 * projecteurs d'un type ({ kind }) : ces dernières cibles suivent la salle (projecteurs ajoutés ou retirés
 * dans le jeu) et rendent les patterns de la bibliothèque utilisables partout.
 */

import { fixtureKey } from './fixtureTypes.js';

export const KIND_TARGETS = [
    ['all', 'Tous les projecteurs'],
    ['spot', 'Toutes les lyres'],
    ['ledbar', 'Toutes les barres LED'],
    ['strobe', 'Tous les strobes'],
    ['laser', 'Tous les lasers'],
    ['laser2', 'Tous les lasers (points / ILDA)'],
];

/**
 * Clés des projecteurs d'un type (ou de tous) présents dans la salle.
 * « Tous les lasers » vise aussi les nouveaux lasers : les patterns laser de la bibliothèque les pilotent.
 */
export function kindTargetKeys(store, kind) {
    return store.fixtures
        .filter((f) => kind === 'all' || f.kind === kind || (kind === 'laser' && f.kind === 'laser2'))
        .map(fixtureKey);
}

/** Options de cible par type, avec le nombre de projecteurs : [valeur, libellé] */
export function kindTargetOptions(store) {
    return KIND_TARGETS.map(([k, label]) => [`k:${k}`, `${label} (${kindTargetKeys(store, k).length})`]);
}

/** Libellé court de la cible d'une piste */
export function targetName(store, target, count) {
    if (target && target.kind) {
        const t = KIND_TARGETS.find(([k]) => k === target.kind);
        if (t) return t[1];
    }
    if (target && target.group) {
        const g = store.groups.find((x) => x.id === target.group);
        if (g) return g.name;
    }
    return `${count} projecteur${count > 1 ? 's' : ''}`;
}
