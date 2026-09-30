/**
 * RoomsView.js — écran d'accueil de la régie : choix de la salle à piloter
 */

import { h } from './dom.js';

const REFRESH = 3000;

export const OUTDATED_TEXT = 'Le serveur de jeu (port 8068) tourne avec une ancienne version qui ne connaît pas la régie : redémarre-le.';

export class RoomsView {
    /**
     * @param {object} o
     * @param {import('../RegieClient.js').RegieClient} o.client
     * @param {(roomId: string) => void} o.onOpen
     * @param {string} [o.error]
     */
    constructor({ client, onOpen, error = '' }) {
        this.client = client;
        this.onOpen = onOpen;
        this._timer = null;

        this.list = h('div', { class: 'rooms-list' });
        this.code = h('input', {
            class: 'field', placeholder: 'Code ou nom de la salle', maxlength: '32', spellcheck: 'false',
            onkeydown: (e) => { if (e.key === 'Enter') this._openCode(); },
        });
        this.error = h('div', { class: 'rooms-error', text: error });
        this.el = h('div', { class: 'rooms' }, [
            h('div', { class: 'rooms-box' }, [
                h('div', { class: 'rooms-head' }, [
                    h('div', { class: 'rooms-title', text: 'Régie lumière' }),
                    h('div', { class: 'rooms-sub', text: 'Choisis la salle à piloter.' }),
                ]),
                this.list,
                h('div', { class: 'rooms-foot' }, [
                    this.code,
                    h('button', { class: 'btn', text: 'Ouvrir', onclick: () => this._openCode() }),
                ]),
                this.error,
            ]),
        ]);
    }

    mount(parent) {
        parent.replaceChildren(this.el);
        this._refresh();
        this._timer = setInterval(() => this._refresh(), REFRESH);
        this.code.focus();
    }

    unmount() {
        clearInterval(this._timer);
        this._timer = null;
    }

    _openCode() {
        const id = this.code.value.trim().toUpperCase();
        if (!id) {
            this.error.textContent = 'Entre le code de la salle.';
            return;
        }
        this.onOpen(id);
    }

    async _refresh() {
        let rooms;
        try {
            rooms = await this.client.listRooms();
        } catch (e) {
            this._lastKey = null;
            const text = e && e.message === 'outdated' ? OUTDATED_TEXT : 'Serveur injoignable.';
            this.list.replaceChildren(h('div', { class: 'rooms-empty', text }));
            return;
        }
        if (!this._timer) return;
        rooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        // Liste inchangée : on ne la reconstruit pas (un clic en cours ne tombe pas dans le vide)
        const key = JSON.stringify(rooms.map((r) => [r.id, r.players, r.trackName]));
        if (key === this._lastKey) return;
        this._lastKey = key;
        if (rooms.length === 0) {
            this.list.replaceChildren(h('div', { class: 'rooms-empty', text: 'Aucune salle ouverte : lance le jeu pour en créer une.' }));
            return;
        }
        this.list.replaceChildren(...rooms.map((r) => h('div', { class: 'room-row', onclick: () => this.onOpen(r.id) }, [
            h('span', { class: 'mono', text: r.id }),
            h('span', { class: 'dim', text: `${r.players} joueur${r.players > 1 ? 's' : ''}` }),
            h('span', { class: 'track', text: r.trackName || '' }),
        ])));
    }
}
