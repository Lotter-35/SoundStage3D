/**
 * PlanView.js — plan de la scène vu de dessus.
 *
 * Chaque projecteur est dessiné à sa position (x, z), la scène en haut et le public en bas,
 * rempli de sa couleur réelle × intensité quand la régie le pilote, en creux sinon.
 * Sélection : clic (Maj ajoute, Ctrl bascule), glisser = lasso, clic dans le vide = rien de sélectionné.
 * Molette = zoom autour du curseur, glisser clic droit ou molette = déplacer, « Cadrer » = tout voir.
 */

import { h } from './dom.js';
import { fixtureKey, fixtureName, decodeFixture, previewColor } from '../fixtureTypes.js';

const GRID = 5;          // pas de la grille (m)
const HIT = 11;          // rayon de sélection au clic (px)
const COLOR_RATE = 100;  // rafraîchissement des couleurs (ms)

function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

export class PlanView {
    /**
     * @param {object} o
     * @param {import('../FixtureStore.js').FixtureStore} o.store
     * @param {import('../DmxOutput.js').DmxOutput} o.out
     */
    constructor({ store, out }) {
        this.store = store;
        this.out = out;
        this.canvas = h('canvas', { class: 'plan-canvas' });
        this.el = h('div', { class: 'plan' }, [
            this.canvas,
            h('div', { class: 'plan-tools' }, [
                h('button', { class: 'btn', text: 'Cadrer', title: 'Voir tous les projecteurs', onclick: () => this.fit() }),
            ]),
            h('div', { class: 'plan-legend faint', text: 'Scène en haut · public en bas · grille 5 m' }),
        ]);
        this.ctx = this.canvas.getContext('2d');
        this.view = { cx: 0, cz: 20, scale: 8 }; // centre (m) et échelle (px/m)
        this._fitted = false;
        this._dirty = true;
        this._lasso = null;
        this._pan = null;
        this._lastColors = 0;
        this._colors = new Map();
        this._palette = {
            bg: cssVar('--bg', '#121212'),
            grid: '#1c1c1c',
            grid2: '#262626',
            text: cssVar('--text-2', '#999'),
            faint: cssVar('--text-3', '#626262'),
            line: cssVar('--line-strong', '#343434'),
            accent: cssVar('--accent', '#4d9cff'),
        };
        this._bindEvents();
        this._ro = new ResizeObserver(() => { this._resize(); });
        this._ro.observe(this.el);
    }

    invalidate() {
        this._dirty = true;
    }

    // ── Vue ───────────────────────────────────────────────────────────────
    _resize() {
        const r = this.el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.w = Math.max(1, r.width);
        this.h = Math.max(1, r.height);
        this.canvas.width = Math.round(this.w * dpr);
        this.canvas.height = Math.round(this.h * dpr);
        this.canvas.style.width = `${this.w}px`;
        this.canvas.style.height = `${this.h}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (!this._fitted && this.store.fixtures.length) this.fit();
        this._dirty = true;
    }

    fit() {
        const list = this.store.fixtures;
        if (!list.length || !this.w) return;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const f of list) {
            x0 = Math.min(x0, f.x); x1 = Math.max(x1, f.x);
            z0 = Math.min(z0, f.z); z1 = Math.max(z1, f.z);
        }
        const margin = 6;
        const sx = this.w / Math.max(10, x1 - x0 + margin * 2);
        const sz = this.h / Math.max(10, z1 - z0 + margin * 2);
        this.view = { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, scale: Math.min(sx, sz) };
        this._fitted = true;
        this._dirty = true;
    }

    toScreen(x, z) {
        const v = this.view;
        return [this.w / 2 + (x - v.cx) * v.scale, this.h / 2 + (z - v.cz) * v.scale];
    }

    toWorld(sx, sy) {
        const v = this.view;
        return [v.cx + (sx - this.w / 2) / v.scale, v.cz + (sy - this.h / 2) / v.scale];
    }

    // ── Interactions ──────────────────────────────────────────────────────
    _hit(sx, sy) {
        let best = null;
        let bestD = HIT * HIT;
        for (const f of this.store.fixtures) {
            const [x, y] = this.toScreen(f.x, f.z);
            const d = (x - sx) ** 2 + (y - sy) ** 2;
            if (d <= bestD) { bestD = d; best = f; }
        }
        return best;
    }

    _local(e) {
        const r = this.canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    _bindEvents() {
        const c = this.canvas;
        c.addEventListener('contextmenu', (e) => e.preventDefault());
        c.addEventListener('pointerdown', (e) => {
            const [sx, sy] = this._local(e);
            c.setPointerCapture(e.pointerId);
            if (e.button === 1 || e.button === 2) {
                this._pan = { sx, sy, cx: this.view.cx, cz: this.view.cz };
                return;
            }
            if (e.button !== 0) return;
            const mode = e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'add' : 'set';
            const f = this._hit(sx, sy);
            if (f) {
                this.store.select([fixtureKey(f)], mode);
                return;
            }
            this._lasso = { x0: sx, y0: sy, x1: sx, y1: sy, mode: mode === 'set' ? 'set' : mode === 'toggle' ? 'toggle' : 'add' };
            this._dirty = true;
        });
        c.addEventListener('pointermove', (e) => {
            const [sx, sy] = this._local(e);
            if (this._pan) {
                this.view.cx = this._pan.cx - (sx - this._pan.sx) / this.view.scale;
                this.view.cz = this._pan.cz - (sy - this._pan.sy) / this.view.scale;
                this._dirty = true;
                return;
            }
            if (this._lasso) {
                this._lasso.x1 = sx;
                this._lasso.y1 = sy;
                this._dirty = true;
                return;
            }
            const f = this._hit(sx, sy);
            const title = f ? `${fixtureName(f)} · U${f.universe}.${String(f.address).padStart(3, '0')}${f.control ? ' · piloté par la régie' : ''}` : '';
            if (c.title !== title) c.title = title;
            c.style.cursor = f ? 'pointer' : 'crosshair';
        });
        const end = (e) => {
            if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
            if (this._pan) { this._pan = null; return; }
            const l = this._lasso;
            if (!l) return;
            this._lasso = null;
            this._dirty = true;
            const xa = Math.min(l.x0, l.x1), xb = Math.max(l.x0, l.x1);
            const ya = Math.min(l.y0, l.y1), yb = Math.max(l.y0, l.y1);
            if (xb - xa < 3 && yb - ya < 3) {
                if (l.mode === 'set') this.store.clearSelection();
                return;
            }
            const keys = [];
            for (const f of this.store.fixtures) {
                const [x, y] = this.toScreen(f.x, f.z);
                if (x >= xa && x <= xb && y >= ya && y <= yb) keys.push(fixtureKey(f));
            }
            this.store.select(keys, l.mode);
        };
        c.addEventListener('pointerup', end);
        c.addEventListener('pointercancel', end);
        c.addEventListener('wheel', (e) => {
            e.preventDefault();
            const [sx, sy] = this._local(e);
            const [wx, wz] = this.toWorld(sx, sy);
            const k = Math.exp(-e.deltaY * 0.0015);
            this.view.scale = Math.max(1.5, Math.min(120, this.view.scale * k));
            // garder le point sous le curseur immobile
            this.view.cx = wx - (sx - this.w / 2) / this.view.scale;
            this.view.cz = wz - (sy - this.h / 2) / this.view.scale;
            this._dirty = true;
        }, { passive: false });
    }

    // ── Dessin ────────────────────────────────────────────────────────────
    _updateColors() {
        const colors = this._colors;
        colors.clear();
        for (const f of this.store.fixtures) {
            if (!f.control) continue;
            const params = decodeFixture(f, this.out.output(f.universe));
            colors.set(fixtureKey(f), previewColor(f, params));
        }
    }

    /** À appeler à chaque image : ne redessine que si nécessaire */
    frame(now) {
        if (!this.w) this._resize();
        if (!this._fitted && this.store.fixtures.length) this.fit();
        if (now - this._lastColors > COLOR_RATE) {
            this._lastColors = now;
            this._updateColors();
            this._dirty = true;
        }
        if (!this._dirty) return;
        this._dirty = false;
        this._draw();
    }

    _draw() {
        const g = this.ctx;
        const C = this._palette;
        const { w, h } = this;
        g.fillStyle = C.bg;
        g.fillRect(0, 0, w, h);

        // Grille (5 m, un trait plus marqué tous les 25 m)
        const [wx0, wz0] = this.toWorld(0, 0);
        const [wx1, wz1] = this.toWorld(w, h);
        g.lineWidth = 1;
        for (let x = Math.ceil(wx0 / GRID) * GRID; x <= wx1; x += GRID) {
            const [sx] = this.toScreen(x, 0);
            g.strokeStyle = x % 25 === 0 ? C.grid2 : C.grid;
            g.beginPath(); g.moveTo(Math.round(sx) + 0.5, 0); g.lineTo(Math.round(sx) + 0.5, h); g.stroke();
        }
        for (let z = Math.ceil(wz0 / GRID) * GRID; z <= wz1; z += GRID) {
            const [, sy] = this.toScreen(0, z);
            g.strokeStyle = z % 25 === 0 ? C.grid2 : C.grid;
            g.beginPath(); g.moveTo(0, Math.round(sy) + 0.5); g.lineTo(w, Math.round(sy) + 0.5); g.stroke();
        }
        // Axe du milieu de scène
        const [ax] = this.toScreen(0, 0);
        g.strokeStyle = C.grid2;
        g.setLineDash([4, 4]);
        g.beginPath(); g.moveTo(Math.round(ax) + 0.5, 0); g.lineTo(Math.round(ax) + 0.5, h); g.stroke();
        g.setLineDash([]);

        // Projecteurs
        g.font = '10px "Cascadia Mono", Consolas, monospace';
        g.textAlign = 'center';
        g.textBaseline = 'top';
        const sel = this.store.selection;
        for (const f of this.store.fixtures) {
            const [x, y] = this.toScreen(f.x, f.z);
            if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
            const key = fixtureKey(f);
            const col = this._colors.get(key);
            const selected = sel.has(key);
            const fill = col ? `rgb(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)})` : null;
            this._glyph(g, f, x, y, fill, selected ? C.accent : (col ? C.line : C.faint), selected);
            g.fillStyle = selected ? C.accent : C.text;
            g.fillText(String(f.number), x, y + 9);
        }

        // Lasso
        const l = this._lasso;
        if (l) {
            g.fillStyle = 'rgba(77, 156, 255, 0.10)';
            g.strokeStyle = C.accent;
            const x = Math.min(l.x0, l.x1), y = Math.min(l.y0, l.y1);
            g.fillRect(x, y, Math.abs(l.x1 - l.x0), Math.abs(l.y1 - l.y0));
            g.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(Math.abs(l.x1 - l.x0)), Math.round(Math.abs(l.y1 - l.y0)));
        }
    }

    /** Forme d'un projecteur : lyre = rond, barre LED = barre orientée, strobe = carré, laser = losange */
    _glyph(g, f, x, y, fill, stroke, selected) {
        g.save();
        g.translate(x, y);
        g.beginPath();
        if (f.kind === 'spot') {
            g.arc(0, 0, 6, 0, Math.PI * 2);
        } else if (f.kind === 'ledbar') {
            g.rotate((-(f.yaw || 0) * Math.PI) / 180);
            g.rect(-9, -3, 18, 6);
        } else if (f.kind === 'strobe') {
            g.rect(-6, -4, 12, 8);
        } else {
            g.moveTo(0, -7); g.lineTo(6, 0); g.lineTo(0, 7); g.lineTo(-6, 0); g.closePath();
        }
        if (fill) {
            g.fillStyle = fill;
            g.fill();
        }
        g.lineWidth = selected ? 2 : 1;
        g.strokeStyle = stroke;
        if (!fill && !selected) g.setLineDash([2, 2]);
        g.stroke();
        g.restore();
    }

    dispose() {
        this._ro.disconnect();
    }
}
