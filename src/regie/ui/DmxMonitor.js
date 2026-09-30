/**
 * DmxMonitor.js — les 512 canaux d'un univers, 32 par ligne (valeur + barre de niveau).
 * Un clic sur un canal place la banque de faders à partir de ce canal.
 */

import { h, pad3, fmtValue } from './dom.js';
import { DMX_UNIVERSE_SIZE } from '../../dmx/DmxProtocol.js';

export class DmxMonitor {
    /**
     * @param {object} o
     * @param {(address: number) => void} o.onPick
     */
    constructor({ onPick }) {
        this.grid = h('div', { class: 'monitor' });
        this._bars = [];
        this._vals = [];
        this._cells = [];
        this._cache = new Int16Array(DMX_UNIVERSE_SIZE).fill(-1);
        this._percent = false;
        this._universe = 1;
        this._bank = [0, -1];
        for (let a = 1; a <= DMX_UNIVERSE_SIZE; a++) {
            const bar = h('div', { class: 'bar' });
            const v = h('div', { class: 'v mono' });
            const cell = h('div', { class: 'cell', onclick: () => onPick(a) }, [bar, h('div', { class: 'a mono', text: pad3(a) }), v]);
            this._bars.push(bar);
            this._vals.push(v);
            this._cells.push(cell);
            this.grid.appendChild(cell);
        }
        this.el = h('div', { class: 'monitor-wrap' }, [this.grid]);
    }

    setUniverse(n) {
        this._universe = n;
        this.invalidate();
    }

    setPercent(on) {
        this._percent = on;
        this.invalidate();
    }

    invalidate() {
        this._cache.fill(-1);
    }

    /** Canaux couverts par la banque de faders (repérés d'un trait) */
    setBank(first, last) {
        const [a0, a1] = this._bank;
        for (let a = a0; a <= a1; a++) if (a >= 1) this._cells[a - 1].classList.remove('bank');
        for (let a = first; a <= last; a++) this._cells[a - 1].classList.add('bank');
        this._bank = [first, last];
    }

    /** @param {Uint8Array|undefined} data */
    render(data) {
        const cache = this._cache;
        for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) {
            const v = data ? data[i] : 0;
            if (cache[i] === v) continue;
            cache[i] = v;
            this._bars[i].style.height = `${(v / 255) * 100}%`;
            this._vals[i].textContent = fmtValue(v, this._percent);
            this._cells[i].classList.toggle('nz', v > 0);
            this._cells[i].title = `Univers ${this._universe} · canal ${i + 1} : ${v} (${Math.round((v / 255) * 100)} %)`;
        }
    }
}
