/**
 * PatternLane.js — une piste d'un pattern dans l'éditeur (dessin et édition à la souris).
 *
 * Piste à points : clic = ajouter un point (calé sur la grille, Maj = libre), glisser = déplacer,
 * double-clic sur un point = le supprimer, Suppr = supprimer le point sélectionné.
 * Générateur : la courbe du premier projecteur (trait plein) et du dernier (pointillés, décalage).
 * Couleur : bande du dégradé dans le temps, points = couleurs clés.
 */

import { h } from './dom.js';
import { attributeType } from '../attributes.js';
import { sampleTrack } from '../PatternEngine.js';

const PAD = 5;        // marge verticale de la courbe (px)
const HIT = 7;        // rayon de sélection d'un point (px)

function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

const rgbCss = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;

export class PatternLane {
    /**
     * @param {object} o
     * @param {() => object} o.pattern
     * @param {object} o.track
     * @param {() => number} o.snap        pas de la grille (temps), 0 = libre
     * @param {() => string} o.pointColor  couleur d'un nouveau point de couleur
     * @param {(point: object|null) => void} o.onSelectPoint
     * @param {() => void} o.onEdit        modification terminée (sauvegarde)
     */
    constructor({ pattern, track, snap, pointColor, onSelectPoint, onEdit }) {
        this._pattern = pattern;
        this.track = track;
        this._snap = snap;
        this._pointColor = pointColor;
        this._onSelectPoint = onSelectPoint;
        this._onEdit = onEdit;
        this.selectedPoint = null;
        this._drag = null;
        this.canvas = h('canvas', { class: 'lane-canvas', tabindex: '0' });
        this.ctx = this.canvas.getContext('2d');
        this._pal = {
            bg: '#0f0f0f', beat: '#1b1b1b', bar: '#2a2a2a', fill: 'rgba(138, 138, 138, 0.16)',
            line: cssVar('--text-2', '#999'), faint: cssVar('--text-3', '#626262'), accent: cssVar('--accent', '#4d9cff'),
        };
        this._bind();
    }

    get isColor() {
        return attributeType(this.track.attr) === 'color';
    }

    // ── Géométrie ─────────────────────────────────────────────────────────
    resize() {
        const r = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.w = Math.max(1, Math.round(r.width));
        this.h = Math.max(1, Math.round(r.height));
        this.canvas.width = this.w * dpr;
        this.canvas.height = this.h * dpr;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.draw();
    }

    _L() {
        return Math.max(0.25, this._pattern().length || 4);
    }

    _x(t) { return (t / this._L()) * this.w; }
    _t(x) { return Math.max(0, Math.min(this._L() - 1e-6, (x / this.w) * this._L())); }
    _y(v) { return PAD + (1 - v) * (this.h - PAD * 2); }
    _v(y) { return Math.max(0, Math.min(1, 1 - (y - PAD) / (this.h - PAD * 2))); }

    _snapT(t, free) {
        const s = this._snap();
        if (free || !s) return Math.round(t * 1000) / 1000;
        const L = this._L();
        const q = Math.round(t / s) * s;
        return q >= L ? 0 : q;
    }

    _hit(x, y) {
        const tr = this.track;
        if (tr.mode === 'wave') return null;
        let best = null;
        let bestD = HIT * HIT;
        for (const p of tr.points) {
            const px = this._x(p.t);
            const py = this.isColor ? this.h / 2 : this._y(p.v);
            const d = (px - x) ** 2 + (py - y) ** 2;
            if (d <= bestD) { bestD = d; best = p; }
        }
        return best;
    }

    // ── Interactions ──────────────────────────────────────────────────────
    _local(e) {
        const r = this.canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    _select(p) {
        this.selectedPoint = p;
        this._onSelectPoint(p);
        this.draw();
    }

    _bind() {
        const c = this.canvas;
        c.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || this.track.mode === 'wave') return;
            const [x, y] = this._local(e);
            c.focus();
            let p = this._hit(x, y);
            if (!p) {
                const t = this._snapT(this._t(x), e.shiftKey);
                const pts = this.track.points;
                // un seul point par temps : le point existant est repris
                p = pts.find((q) => Math.abs(q.t - t) < 1e-6);
                if (!p) {
                    p = this.isColor ? { t, c: this._pointColor() } : { t, v: Math.round(this._v(y) * 1000) / 1000 };
                    pts.push(p);
                    pts.sort((a, b) => a.t - b.t);
                }
            }
            try { c.setPointerCapture(e.pointerId); } catch (_) { /* événement synthétique */ }
            this._drag = { p, moved: false };
            this._select(p);
        });
        c.addEventListener('pointermove', (e) => {
            const d = this._drag;
            if (!d) return;
            const [x, y] = this._local(e);
            const pts = this.track.points;
            const t = this._snapT(this._t(x), e.shiftKey);
            if (!pts.some((q) => q !== d.p && Math.abs(q.t - t) < 1e-6)) d.p.t = t;
            if (!this.isColor) d.p.v = Math.round(this._v(y) * 1000) / 1000;
            pts.sort((a, b) => a.t - b.t);
            d.moved = true;
            this._onSelectPoint(d.p);
            this.draw();
        });
        const end = () => {
            if (!this._drag) return;
            this._drag = null;
            this._onEdit();
        };
        c.addEventListener('pointerup', end);
        c.addEventListener('pointercancel', end);
        c.addEventListener('dblclick', (e) => {
            const [x, y] = this._local(e);
            const p = this._hit(x, y);
            if (p) this.deletePoint(p);
        });
        c.addEventListener('keydown', (e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedPoint) {
                e.preventDefault();
                e.stopPropagation();
                this.deletePoint(this.selectedPoint);
            }
        });
    }

    deletePoint(p) {
        const pts = this.track.points;
        const i = pts.indexOf(p);
        if (i < 0) return;
        pts.splice(i, 1);
        this._select(null);
        this._onEdit();
    }

    // ── Dessin ────────────────────────────────────────────────────────────
    draw() {
        if (!this.w) return;
        const g = this.ctx;
        const P = this._pal;
        const { w, h } = this;
        const L = this._L();
        const tr = this.track;
        g.fillStyle = P.bg;
        g.fillRect(0, 0, w, h);

        // Grille : pas de la grille, temps, mesures (4 temps)
        const snap = this._snap();
        g.lineWidth = 1;
        if (snap && snap < 1 && (snap / L) * w >= 6) {
            g.strokeStyle = '#151515';
            for (let t = snap; t < L; t += snap) {
                const x = Math.round(this._x(t)) + 0.5;
                g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
            }
        }
        for (let b = 1; b < L; b++) {
            const x = Math.round(this._x(b)) + 0.5;
            g.strokeStyle = b % 4 === 0 ? P.bar : P.beat;
            g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
        }

        if (tr.mute) g.globalAlpha = 0.35;
        if (this.isColor) this._drawColor(g, L);
        else this._drawScalar(g, L);
        g.globalAlpha = 1;
    }

    _drawScalar(g, L) {
        const P = this._pal;
        const tr = this.track;
        const { w, h } = this;
        const hasCurve = tr.mode === 'wave' || tr.points.length > 0;
        if (hasCurve) {
            // Premier projecteur : aire + trait
            g.beginPath();
            g.moveTo(0, h);
            for (let x = 0; x <= w; x += 2) {
                const v = sampleTrack(tr, (x / w) * L, L, 0, 1);
                g.lineTo(x, this._y(v ?? 0));
            }
            g.lineTo(w, h);
            g.closePath();
            g.fillStyle = P.fill;
            g.fill();
            g.beginPath();
            for (let x = 0; x <= w; x += 2) {
                const v = sampleTrack(tr, (x / w) * L, L, 0, 1);
                if (x === 0) g.moveTo(x, this._y(v ?? 0)); else g.lineTo(x, this._y(v ?? 0));
            }
            g.strokeStyle = P.line;
            g.stroke();
            // Dernier projecteur (décalage) en pointillés
            if ((tr.spread || 0) > 0) {
                const n = 8;
                g.beginPath();
                for (let x = 0; x <= w; x += 2) {
                    const v = sampleTrack(tr, (x / w) * L, L, n - 1, n);
                    if (x === 0) g.moveTo(x, this._y(v ?? 0)); else g.lineTo(x, this._y(v ?? 0));
                }
                g.setLineDash([3, 3]);
                g.strokeStyle = P.faint;
                g.stroke();
                g.setLineDash([]);
            }
        }
        if (tr.mode !== 'wave') {
            for (const p of tr.points) {
                const x = this._x(p.t);
                const y = this._y(p.v);
                const sel = p === this.selectedPoint;
                g.fillStyle = sel ? P.accent : '#d4d4d4';
                g.fillRect(Math.round(x) - 3, Math.round(y) - 3, 6, 6);
            }
            if (!tr.points.length) this._hint(g, 'Clic : ajouter un point');
        }
    }

    _drawColor(g, L) {
        const tr = this.track;
        const { w, h } = this;
        const hasCurve = tr.mode === 'wave' || tr.points.length > 0;
        const top = 8;
        const bh = h - 16;
        if (hasCurve) {
            for (let x = 0; x < w; x += 2) {
                const c = sampleTrack(tr, (x / w) * L, L, 0, 1);
                if (!c) continue;
                g.fillStyle = rgbCss(c);
                g.fillRect(x, top, 2, bh);
            }
        }
        if (tr.mode !== 'wave') {
            for (const p of tr.points) {
                const x = Math.round(this._x(p.t));
                const sel = p === this.selectedPoint;
                g.fillStyle = p.c;
                g.fillRect(x - 5, h / 2 - 5, 10, 10);
                g.lineWidth = sel ? 2 : 1;
                g.strokeStyle = sel ? this._pal.accent : '#0c0c0c';
                g.strokeRect(x - 5.5, h / 2 - 5.5, 11, 11);
                g.lineWidth = 1;
            }
            if (!tr.points.length) this._hint(g, 'Clic : ajouter une couleur');
        }
    }

    _hint(g, text) {
        g.fillStyle = this._pal.faint;
        g.font = '11px "Segoe UI", system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.fillText(text, 10, this.h / 2);
    }
}
