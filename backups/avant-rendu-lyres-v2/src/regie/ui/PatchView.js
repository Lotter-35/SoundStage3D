/**
 * PatchView.js — liste des projecteurs de la salle (patch DMX).
 * Clic = sélection (Ctrl bascule, Maj étend jusqu'à la ligne cliquée).
 */

import { h, pad3 } from './dom.js';
import { KINDS, fixtureKey, fixtureName } from '../fixtureTypes.js';

export class PatchView {
    /** @param {{store: import('../FixtureStore.js').FixtureStore}} o */
    constructor({ store }) {
        this.store = store;
        this._anchor = null;
        this._version = -1;
        this.body = h('tbody');
        this.el = h('div', { class: 'patch' }, [
            h('table', { class: 'patch-table' }, [
                h('thead', {}, [h('tr', {}, [
                    h('th', { class: 'num', text: 'N°' }),
                    h('th', { text: 'Nom' }),
                    h('th', { text: 'Type' }),
                    h('th', { class: 'num', text: 'Adresse' }),
                    h('th', { class: 'num', text: 'Canaux' }),
                    h('th', { text: 'Mode' }),
                    h('th', { text: 'Pilotage' }),
                    h('th', { class: 'num', text: 'Position (x, z)' }),
                ])]),
                this.body,
            ]),
        ]);
    }

    frame() {
        if (this.store.version === this._version) return;
        this._version = this.store.version;
        this._render();
    }

    _render() {
        const store = this.store;
        if (store.fixtures.length === 0) {
            this.body.replaceChildren(h('tr', {}, [h('td', { class: 'empty', colspan: '8', text: 'Aucun projecteur reçu du jeu pour l’instant.' })]));
            return;
        }
        this.body.replaceChildren(...store.fixtures.map((f) => {
            const key = fixtureKey(f);
            const last = f.address + f.footprint - 1;
            return h('tr', {
                class: store.selection.has(key) ? 'sel' : '',
                onpointerdown: (e) => this._click(e, key),
            }, [
                h('td', { class: 'num mono', text: String(f.number) }),
                h('td', { text: fixtureName(f) }),
                h('td', { class: 'dim', text: (KINDS[f.kind] || { label: f.kind }).label }),
                h('td', { class: 'num mono', text: `${f.universe}.${pad3(f.address)}–${pad3(last)}` }),
                h('td', { class: 'num mono dim', text: String(f.footprint) }),
                h('td', { class: 'dim', text: f.mode || '' }),
                h('td', {}, [h('span', { class: f.control ? 'tag on' : 'tag', text: f.control ? 'Régie' : 'Jeu' })]),
                h('td', { class: 'num mono dim', text: `${f.x.toFixed(1)}, ${f.z.toFixed(1)}` }),
            ]);
        }));
    }

    _click(e, key) {
        if (e.button !== 0) return;
        const store = this.store;
        if (e.shiftKey && this._anchor && store.byKey.has(this._anchor)) {
            const keys = store.fixtures.map(fixtureKey);
            const a = keys.indexOf(this._anchor);
            const b = keys.indexOf(key);
            store.select(keys.slice(Math.min(a, b), Math.max(a, b) + 1), e.ctrlKey ? 'add' : 'set');
            return;
        }
        this._anchor = key;
        store.select([key], e.ctrlKey || e.metaKey ? 'toggle' : 'set');
    }
}
