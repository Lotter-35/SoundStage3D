/**
 * FixtureControl.js — prise et reprise de main sur des projecteurs.
 *
 * Prendre la main sans changer la lumière : la régie demande à un joueur les valeurs DMX
 * équivalentes aux réglages actuels des projecteurs, les recopie dans ses univers, attend
 * qu'elles soient arrivées chez les joueurs (tick + avance), puis passe les projecteurs en
 * « Piloté par le DMX » (même message que depuis le panneau du jeu, appliqué par tous).
 */

import { fixtureKey } from './fixtureTypes.js';
import { OUTPUT_RATE } from './DmxOutput.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} o
 * @param {import('./RegieClient.js').RegieClient} o.client
 * @param {import('./DmxOutput.js').DmxOutput} o.out
 * @param {object[]} o.fixtures
 * @returns {Promise<{captured: number}>}
 */
export async function takeControl({ client, out, fixtures }) {
    const todo = fixtures.filter((f) => !f.control);
    let captured = 0;
    if (todo.length > 0) {
        const states = await client.requestFixtureState(todo.map(fixtureKey));
        if (states) {
            for (const st of Object.values(states)) {
                if (!st || !Array.isArray(st.values)) continue;
                st.values.forEach((v, i) => out.set(st.universe, st.address + i, v));
                captured++;
            }
            // Laisser partir ces valeurs et leur laisser le temps d'être appliquées chez les joueurs
            await wait(out.lookahead + (2 * 1000) / OUTPUT_RATE + 60);
        }
    }
    sendControl(client, todo, true);
    return { captured };
}

/** Rend la main au jeu : les projecteurs gardent leur dernier état et suivent de nouveau leurs panneaux */
export function releaseControl({ client, fixtures }) {
    sendControl(client, fixtures.filter((f) => f.control), false);
}

function sendControl(client, fixtures, on) {
    const spots = {};
    for (const f of fixtures) {
        if (f.kind === 'spot') spots[f.id] = { dmxControl: on };
        else if (f.kind === 'ledbar') client.sendLighting({ category: 'ledbar_update', id: f.id, data: { dmxControl: on } });
        else if (f.kind === 'strobe') client.sendLighting({ category: 'strobe_update', id: f.id, data: { dmxControl: on } });
        else if (f.kind === 'laser') client.sendLighting({ category: 'laser_param', id: f.id, param: 'dmxControl', value: on });
        else if (f.kind === 'laser2') client.sendLighting({ category: 'laser2_update', id: f.id, data: { dmxControl: on } });
    }
    if (Object.keys(spots).length > 0) client.sendLighting({ category: 'spot_multi', data: spots });
}
