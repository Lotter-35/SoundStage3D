/**
 * FaderBank.js — banque de faders de canaux bruts (une page de canaux consécutifs d'un univers).
 *
 * Fader : clic / glisser sur la piste, molette ±1 par cran (Maj ±10), flèches ±1, Page ±10,
 * Début / Fin = 0 / 255, double-clic = bascule 0 ↔ 255 (d'après la valeur d'avant le double-clic).
 */

import { h, pad3, fmtValue } from './dom.js';

export class FaderBank {
    /**
     * @param {object} o
     * @param {number} o.count
     * @param {(index: number) => number} o.get          valeur du fader n° index (0…255)
     * @param {(index: number, value: number) => void} o.set
     */
    constructor({ count, get, set }) {
        this.count = count;
        this._get = get;
        this._set = set;
        this._percent = false;
        this._faders = [];
        this.el = h('div', { class: 'faders' });
        for (let i = 0; i < count; i++) this._faders.push(this._makeFader(i));
    }

    setPercent(on) {
        this._percent = on;
        this.invalidate();
    }

    invalidate() {
        for (const f of this._faders) f.cache = -1;
    }

    /** @param {number} firstAddress adresse du premier fader */
    setAddresses(firstAddress) {
        this._faders.forEach((f, i) => { f.addr.textContent = pad3(firstAddress + i); });
        this.invalidate();
    }

    render() {
        for (let i = 0; i < this.count; i++) {
            const f = this._faders[i];
            const v = this._get(i);
            if (f.cache === v) continue;
            f.cache = v;
            const pct = (v / 255) * 100;
            f.fill.style.height = `${pct}%`;
            f.cap.style.bottom = `${pct}%`;
            f.val.textContent = fmtValue(v, this._percent);
            f.el.classList.toggle('nz', v > 0);
            f.el.setAttribute('aria-valuenow', String(v));
        }
    }

    _makeFader(i) {
        const fill = h('div', { class: 'fill' });
        const cap = h('div', { class: 'cap' });
        const track = h('div', { class: 'track' }, [fill, cap]);
        const addr = h('div', { class: 'fa mono' });
        const val = h('div', { class: 'fv mono' });
        const el = h('div', {
            class: 'fader', tabindex: '0', role: 'slider',
            'aria-valuemin': '0', 'aria-valuemax': '255',
        }, [addr, track, val]);
        const f = { el, track, fill, cap, addr, val, cache: -1, lastDown: 0, preValue: 0, wheel: 0 };

        const change = (v) => this._set(i, Math.max(0, Math.min(255, Math.round(v))));
        const fromY = (clientY) => {
            const r = track.getBoundingClientRect();
            return (1 - (clientY - r.top) / r.height) * 255;
        };

        track.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            // Valeur d'avant un éventuel double-clic (le premier clic déplace déjà le fader)
            const now = performance.now();
            if (now - f.lastDown > 400) f.preValue = this._get(i);
            f.lastDown = now;
            el.focus();
            track.setPointerCapture(e.pointerId);
            el.classList.add('drag');
            change(fromY(e.clientY));
        });
        track.addEventListener('pointermove', (e) => {
            if (track.hasPointerCapture(e.pointerId)) change(fromY(e.clientY));
        });
        const end = (e) => {
            if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
            el.classList.remove('drag');
        };
        track.addEventListener('pointerup', end);
        track.addEventListener('pointercancel', end);

        el.addEventListener('wheel', (e) => {
            e.preventDefault();
            // Un cran de molette ≈ 100 px ; les petits pas d'un pavé tactile s'accumulent
            const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
            f.wheel -= px;
            const notches = Math.trunc(f.wheel / 100);
            if (notches === 0) return;
            f.wheel -= notches * 100;
            change(this._get(i) + notches * (e.shiftKey ? 10 : 1));
        }, { passive: false });
        el.addEventListener('dblclick', () => {
            const before = performance.now() - f.lastDown < 600 ? f.preValue : this._get(i);
            change(before > 0 ? 0 : 255);
        });
        el.addEventListener('keydown', (e) => {
            const v = this._get(i);
            const keys = {
                ArrowUp: v + 1, ArrowRight: v + 1, ArrowDown: v - 1, ArrowLeft: v - 1,
                PageUp: v + 10, PageDown: v - 10, Home: 0, End: 255,
            };
            if (!(e.key in keys)) return;
            e.preventDefault();
            change(keys[e.key]);
        });

        this.el.appendChild(el);
        return f;
    }
}
