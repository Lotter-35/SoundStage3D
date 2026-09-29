/**
 * OptionsPanel.js
 * ─────────────────────────────────────────────────────────────
 * Panneau « ⚙️ Options » (bouton de la barre du bas) : toutes les préférences
 * propres à ce joueur. Rien n'est envoyé au serveur ; tout est sauvegardé localement
 * (voir ClientOptions.js).
 * ─────────────────────────────────────────────────────────────
 */

import GUI from 'lil-gui';
import { makeDraggable } from './draggable.js';
import { clientOptions, CLIENT_OPTIONS_SCHEMA, OPTION_FOLDERS } from './ClientOptions.js';

export class OptionsPanel {
    /** @param {HTMLElement|null} button bouton de la barre du bas */
    constructor(button) {
        this.button = button;
        this.wrap = document.createElement('div');
        this.wrap.id = 'options-panel-wrap';
        this.wrap.className = 'hidden';
        this.container = document.createElement('div');
        this.container.id = 'options-panel';
        this.wrap.appendChild(this.container);
        document.body.appendChild(this.wrap);
        for (const ev of ['pointerdown', 'mousedown', 'click', 'wheel']) this.wrap.addEventListener(ev, e => e.stopPropagation());

        this.gui = null;
        this.controllers = {};
        this._values = { ...clientOptions.values };

        if (button) button.addEventListener('click', () => this.toggle());
    }

    get isOpen() {
        return !this.wrap.classList.contains('hidden');
    }

    toggle(force) {
        const open = force !== undefined ? Boolean(force) : !this.isOpen;
        this.wrap.classList.toggle('hidden', !open);
        if (this.button) this.button.classList.toggle('active', open);
        if (open) this._build();
        else if (this.gui) { this.gui.destroy(); this.gui = null; }
        return open;
    }

    _resetAll() {
        clientOptions.resetAll();
        this._refresh();
    }

    _refresh() {
        Object.assign(this._values, clientOptions.values);
        for (const c of Object.values(this.controllers)) {
            try { c.updateDisplay(); } catch (_) {}
        }
    }

    _build() {
        if (this.gui) this.gui.destroy();
        this.controllers = {};
        Object.assign(this._values, clientOptions.values);
        const title = '⚙️ Options';
        this.gui = new GUI({ container: this.container, title, autoPlace: false, width: 340 });

        const titleEl = this.gui.domElement.querySelector('.title');
        if (titleEl) {
            titleEl.textContent = '';
            const text = document.createElement('span');
            text.className = 'lil-panel-title-text';
            text.textContent = title;
            const reset = document.createElement('span');
            reset.className = 'lil-panel-reset-btn';
            reset.textContent = '↺ Tout reset';
            reset.title = 'Remettre toutes les options par défaut';
            reset.addEventListener('click', (e) => { e.stopPropagation(); this._resetAll(); });
            const close = document.createElement('span');
            close.className = 'lil-panel-close-btn';
            close.textContent = '✕';
            close.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(false); });
            for (const el of [reset, close]) ['mousedown', 'pointerdown'].forEach(ev => el.addEventListener(ev, e => e.stopPropagation()));
            titleEl.append(text, reset, close);
            makeDraggable(this.wrap, titleEl, 'options');
        }

        const folders = {};
        for (const f of OPTION_FOLDERS) folders[f.id] = this.gui.addFolder(f.title);

        const v = this._values;
        for (const [key, s] of Object.entries(CLIENT_OPTIONS_SCHEMA)) {
            const folder = folders[s.folder];
            let ctrl;
            if (s.options) ctrl = folder.add(v, key, s.options);
            else if (typeof s.value === 'boolean') ctrl = folder.add(v, key);
            else ctrl = folder.add(v, key, s.min, s.max, s.step);
            if (key === 'mouseSensitivity') ctrl.max(Infinity);
            ctrl.name(s.label).onChange(val => clientOptions.set(key, val));
            if (s.hint) ctrl.domElement.title = s.hint;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'lil-reset-btn';
            btn.textContent = '↺';
            btn.title = 'Valeur par défaut';
            btn.addEventListener('click', (e) => { e.stopPropagation(); ctrl.setValue(s.value); });
            (ctrl.domElement.querySelector('.widget') || ctrl.domElement).appendChild(btn);
            this.controllers[key] = ctrl;
        }

        const resetBox = { reset: () => this._resetAll() };
        this.gui.add(resetBox, 'reset').name('↺ Réinitialiser toutes les options');
    }
}
