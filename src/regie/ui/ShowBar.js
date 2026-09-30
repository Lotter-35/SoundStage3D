/**
 * ShowBar.js — éléments de la barre du haut liés au show et au tempo :
 *   - menu du show : show courant, état de la sauvegarde, liste des shows, nouveau, dupliquer,
 *     renommer, supprimer ;
 *   - tempo : BPM (enregistré dans le show), tap tempo (touche T), voyants des temps.
 */

import { h, ICONS } from './dom.js';

const STATUS = {
    idle: ['', ''],
    loading: ['Chargement…', ''],
    saved: ['Enregistré', 'ok'],
    dirty: ['Modifié', 'warn'],
    saving: ['Enregistrement…', 'warn'],
    error: ['Non enregistré', 'bad'],
};

export class ShowBar {
    /**
     * @param {object} o
     * @param {import('../ShowStore.js').ShowStore} o.shows
     * @param {import('../TempoClock.js').TempoClock} o.tempo
     */
    constructor({ shows, tempo }) {
        this.shows = shows;
        this.tempo = tempo;
        this._menuOpen = false;
        this._confirm = 0;

        this.$name = h('span', { class: 'show-name' });
        this.$status = h('span', { class: 'tag' });
        this.$btn = h('button', { class: 'btn show-btn', title: 'Shows : ouvrir, créer, renommer…', onclick: (e) => { e.stopPropagation(); this.toggleMenu(); } }, [
            h('span', { class: 'dim', text: 'Show' }), this.$name, h('span', { class: 'chev', html: ICONS.down }),
        ]);
        // Menu posé sur la page (la barre du haut défile et le couperait), placé sous le bouton
        this.$menu = h('div', { class: 'menu', style: 'display:none', onclick: (e) => e.stopPropagation() });
        document.body.appendChild(this.$menu);
        this.showEl = h('span', { class: 'group show-group' }, [this.$btn, this.$status]);

        this.$bpm = h('input', { class: 'field num bpm', type: 'number', min: '20', max: '300', step: '0.1', title: 'Tempo (temps par minute), enregistré dans le show' });
        this.$bpm.addEventListener('change', () => this._setBpm(Number(this.$bpm.value)));
        this.$bpm.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.$bpm.blur(); });
        this.$leds = [0, 1, 2, 3].map(() => h('span', { class: 'beat' }));
        this.tempoEl = h('span', { class: 'group' }, [
            h('span', { class: 'dim', text: 'BPM' }), this.$bpm,
            h('button', { class: 'btn', text: 'Tap', title: 'Tap tempo : tapote au rythme (touche T)', onclick: () => this.tap() }),
            h('span', { class: 'beats' }, this.$leds),
        ]);

        this._onDoc = () => this.closeMenu();
        document.addEventListener('click', this._onDoc);
    }

    tap() {
        const bpm = this.tempo.tap();
        if (this.shows.show && this.shows.show.bpm !== bpm) {
            this.shows.show.bpm = bpm;
            this.shows.touch();
        }
    }

    _setBpm(v) {
        if (!Number.isFinite(v)) return;
        this.tempo.setBpm(v);
        if (this.shows.show) {
            this.shows.show.bpm = this.tempo.bpm;
            this.shows.touch();
        }
    }

    // ── Menu des shows ────────────────────────────────────────────────────
    toggleMenu() {
        if (this._menuOpen) this.closeMenu();
        else this.openMenu();
    }

    async openMenu() {
        this._menuOpen = true;
        const r = this.$btn.getBoundingClientRect();
        this.$menu.style.left = `${Math.round(r.left)}px`;
        this.$menu.style.top = `${Math.round(r.bottom + 4)}px`;
        this.$menu.style.display = '';
        this._renderMenu();
        await this.shows.refreshList();
        if (this._menuOpen) this._renderMenu();
    }

    closeMenu() {
        if (!this._menuOpen) return;
        this._menuOpen = false;
        this.$menu.style.display = 'none';
    }

    _renderMenu(renaming = false) {
        const shows = this.shows;
        const cur = shows.show;
        const rows = shows.list.map((s) => h('div', {
            class: `menu-row${cur && s.id === cur.id ? ' sel' : ''}`,
            onclick: async () => { this.closeMenu(); if (!cur || s.id !== cur.id) await shows.open(s.id); },
        }, [
            h('span', { class: 'name', text: s.name }),
            h('span', { class: 'count mono', text: `${s.patterns} pat.` }),
        ]));
        const actions = [];
        if (renaming && cur) {
            const input = h('input', { class: 'field', value: cur.name, maxlength: '60', spellcheck: 'false' });
            const done = (save) => {
                if (save && input.value.trim()) shows.rename(input.value.trim());
                this._renderMenu();
            };
            input.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') done(true);
                if (e.key === 'Escape') done(false);
            });
            actions.push(input, h('button', { class: 'btn', text: 'OK', onclick: () => done(true) }));
            setTimeout(() => { input.focus(); input.select(); }, 0);
        } else {
            actions.push(
                h('button', { class: 'btn', text: 'Nouveau', onclick: async () => { this.closeMenu(); await shows.create(); } }),
                h('button', { class: 'btn', text: 'Dupliquer', onclick: async () => { this.closeMenu(); await shows.duplicate(); } }),
                h('button', { class: 'btn', text: 'Renommer', onclick: () => this._renderMenu(true) }),
            );
            const del = h('button', { class: 'btn danger', text: 'Supprimer' });
            del.addEventListener('click', async () => {
                if (!cur) return;
                const now = performance.now();
                if (now - this._confirm > 3000) {
                    this._confirm = now;
                    del.textContent = 'Confirmer la suppression';
                    return;
                }
                this.closeMenu();
                await shows.remove(cur.id);
            });
            actions.push(del);
        }
        this.$menu.replaceChildren(
            h('div', { class: 'menu-title dim', text: 'Shows enregistrés sur le serveur' }),
            h('div', { class: 'menu-list' }, rows.length ? rows : [h('div', { class: 'group-empty dim', text: 'Aucun show.' })]),
            h('div', { class: 'menu-actions' }, actions),
        );
    }

    // ── Affichage ─────────────────────────────────────────────────────────
    frame() {
        const shows = this.shows;
        this.$name.textContent = shows.show ? shows.show.name : '—';
        const [text, cls] = STATUS[shows.status] || STATUS.idle;
        this.$status.textContent = text;
        this.$status.className = `tag${cls ? ` ${cls}` : ''}`;
        this.$status.title = shows.error || '';
        this.$status.style.display = text ? '' : 'none';
        if (document.activeElement !== this.$bpm) this.$bpm.value = String(this.tempo.bpm);
        const beat = this.tempo.beatNow();
        const i = Math.floor(beat) % 4;
        const flash = beat - Math.floor(beat) < 0.2;
        this.$leds.forEach((el, k) => {
            el.classList.toggle('on', k === (i + 4) % 4);
            el.classList.toggle('flash', k === (i + 4) % 4 && flash);
        });
    }

    dispose() {
        document.removeEventListener('click', this._onDoc);
        this.$menu.remove();
    }
}
