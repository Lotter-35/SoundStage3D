/**
 * GroupsPanel.js — groupes de projecteurs.
 * Clic = sélectionner le groupe (Maj ajoute), double-clic sur le nom = renommer,
 * « Créer » = nouveau groupe avec la sélection, ↻ = remplacer par la sélection, × = supprimer.
 */

import { h, ICONS } from './dom.js';

export class GroupsPanel {
    /** @param {{store: import('../FixtureStore.js').FixtureStore}} o */
    constructor({ store }) {
        this.store = store;
        this._version = -1;
        this.list = h('div', { class: 'group-list' });
        this.el = h('div', { class: 'panel groups' }, [
            h('div', { class: 'panel-head' }, [
                h('span', { class: 'title', text: 'Groupes' }),
                h('span', { class: 'grow' }),
                h('button', {
                    class: 'btn', text: 'Créer', title: 'Nouveau groupe avec la sélection',
                    onclick: () => {
                        const g = this.store.createGroup();
                        if (g) this._rename(g.id);
                    },
                }),
            ]),
            this.list,
        ]);
    }

    frame() {
        if (this.store.version === this._version || this._editing) return;
        this._version = this.store.version;
        this._render();
    }

    _render() {
        const store = this.store;
        if (store.groups.length === 0) {
            this.list.replaceChildren(h('div', { class: 'group-empty dim', text: 'Sélectionne des projecteurs puis « Créer ».' }));
            return;
        }
        const sel = store.selection;
        this.list.replaceChildren(...store.groups.map((g) => {
            const keys = store.groupKeys(g);
            const active = keys.length > 0 && keys.length === sel.size && keys.every((k) => sel.has(k));
            return h('div', {
                class: `group-row${active ? ' sel' : ''}`,
                'data-id': g.id,
                onclick: (e) => store.recallGroup(g.id, e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'set'),
            }, [
                h('span', { class: 'name', text: g.name, ondblclick: (e) => { e.stopPropagation(); this._rename(g.id); } }),
                h('span', { class: 'count mono', text: String(keys.length) }),
                h('button', { class: 'btn icon ghost', html: ICONS.refresh, title: 'Remplacer par la sélection', 'aria-label': 'Remplacer par la sélection',
                    onclick: (e) => { e.stopPropagation(); store.updateGroup(g.id); } }),
                h('button', { class: 'btn icon ghost', html: ICONS.close, title: 'Supprimer le groupe', 'aria-label': 'Supprimer le groupe',
                    onclick: (e) => { e.stopPropagation(); store.deleteGroup(g.id); } }),
            ]);
        }));
    }

    _rename(id) {
        this._version = -1;
        this._render();
        const row = this.list.querySelector(`[data-id="${id}"]`);
        const g = this.store.groups.find((x) => x.id === id);
        if (!row || !g) return;
        const nameEl = row.querySelector('.name');
        const input = h('input', { class: 'field', value: g.name, maxlength: '40', spellcheck: 'false' });
        this._editing = true;
        const done = (save) => {
            if (!this._editing) return;
            this._editing = false;
            if (save && input.value.trim()) this.store.renameGroup(id, input.value.trim());
            this._version = -1;
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') done(true);
            if (e.key === 'Escape') done(false);
        });
        input.addEventListener('blur', () => done(true));
        input.addEventListener('click', (e) => e.stopPropagation());
        nameEl.replaceWith(input);
        input.focus();
        input.select();
    }
}
