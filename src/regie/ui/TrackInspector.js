/**
 * TrackInspector.js — réglages de la piste sélectionnée dans l'éditeur de patterns :
 * cible, attribut, mode (points / générateur), ordre et décalage entre projecteurs,
 * point sélectionné, forme d'onde, valeurs ou couleurs, muet, suppression.
 */

import { h } from './dom.js';
import { attributesFor, attributeLabel, attributeType } from '../attributes.js';
import { SHAPES, ORDERS, INTERPS } from '../PatternEngine.js';
import { kindTargetOptions } from '../targets.js';

export const SWATCHES = ['#ffffff', '#ff1a1a', '#ff6a00', '#ffd000', '#9dff00', '#00ff4c',
    '#00ffd5', '#00b3ff', '#1a3cff', '#8c1aff', '#ff1ad9', '#000000'];

const pct = (v) => Math.round((v ?? 0) * 100);

function select(options, value, onchange) {
    const el = h('select', { class: 'field', onchange: () => onchange(el.value) },
        options.map(([v, label]) => h('option', { value: v, text: label })));
    el.value = value;
    return el;
}

function seg(options, value, onchange) {
    const wrap = h('span', { class: 'seg' });
    for (const [v, label] of options) {
        wrap.appendChild(h('button', { class: v === value ? 'on' : '', text: label, onclick: () => onchange(v) }));
    }
    return wrap;
}

function number(value, { min, max, step, suffix }, onchange) {
    const el = h('input', { class: 'field num', type: 'number', min: String(min), max: String(max), step: String(step), value: String(value) });
    el.addEventListener('change', () => {
        const v = Math.max(min, Math.min(max, Number(el.value)));
        if (!Number.isFinite(v)) return;
        el.value = String(v);
        onchange(v);
    });
    return suffix ? h('span', { class: 'group' }, [el, h('span', { class: 'dim', text: suffix })]) : el;
}

function range(value, onchange) {
    const out = h('span', { class: 'mono range-value', text: `${value} %` });
    const el = h('input', { class: 'range', type: 'range', min: '0', max: '100', step: '1', value: String(value) });
    el.addEventListener('input', () => { out.textContent = `${el.value} %`; onchange(Number(el.value), false); });
    el.addEventListener('change', () => onchange(Number(el.value), true));
    return h('span', { class: 'group' }, [el, out]);
}

function colorField(value, onchange) {
    const input = h('input', { class: 'color', type: 'color', value });
    input.addEventListener('input', () => onchange(input.value, false));
    input.addEventListener('change', () => onchange(input.value, true));
    const sw = h('div', { class: 'swatches' }, SWATCHES.map((c) => h('button', {
        class: 'swatch', style: `background:${c}`, title: c, 'aria-label': c,
        onclick: () => { input.value = c; onchange(c, true); },
    })));
    return h('div', { class: 'color-field' }, [input, sw]);
}

const row = (label, control) => h('div', { class: 'insp-row' }, [h('span', { class: 'insp-label', text: label }), control]);
const section = (title) => h('div', { class: 'insp-section', text: title });

export class TrackInspector {
    /**
     * @param {object} o
     * @param {import('../FixtureStore.js').FixtureStore} o.store
     * @param {import('../PatternEngine.js').PatternEngine} o.engine
     * @param {(final: boolean) => void} o.onChange  réglage modifié (final = fin du geste : sauvegarde)
     * @param {(track: object) => void} o.onDelete
     */
    constructor({ store, engine, onChange, onDelete }) {
        this.store = store;
        this.engine = engine;
        this._onChange = onChange;
        this._onDelete = onDelete;
        this.track = null;
        this.point = null;
        this.newPointColor = '#ff1a1a'; // couleur des nouveaux points d'une piste de couleur
        this.body = h('div', { class: 'insp-body' });
        this.el = h('div', { class: 'panel inspector' }, [
            h('div', { class: 'panel-head' }, [h('span', { class: 'title', text: 'Piste' })]),
            this.body,
        ]);
        this.render();
    }

    setTrack(track) {
        this.track = track;
        this.point = null;
        this.render();
    }

    setPoint(point) {
        this.point = point;
        this.render();
    }

    _changed(final = true, rebuild = false) {
        this._onChange(final);
        if (rebuild) this.render();
    }

    render() {
        const tr = this.track;
        if (!tr) {
            this.body.replaceChildren(h('div', { class: 'insp-empty dim', text: 'Sélectionne une piste pour la régler.' }));
            return;
        }
        const store = this.store;
        const fixtures = this.engine.targetsOf(tr);
        const isColor = attributeType(tr.attr) === 'color';
        const els = [];

        // ── Cible et attribut ──
        const targetOptions = [...kindTargetOptions(store), ...store.groups.map((g) => [`g:${g.id}`, `${g.name} (${store.groupKeys(g).length})`])];
        let targetValue = tr.target && tr.target.kind ? `k:${tr.target.kind}` : tr.target && tr.target.group ? `g:${tr.target.group}` : 'keys';
        if (targetValue === 'keys') targetOptions.unshift(['keys', `Liste · ${fixtures.length} projecteur${fixtures.length > 1 ? 's' : ''}`]);
        if (store.selection.size) targetOptions.push(['sel', `Sélection actuelle (${store.selection.size})`]);
        els.push(row('Cible', select(targetOptions, targetValue, (v) => {
            if (v === 'sel') tr.target = { keys: store.selected().map((f) => `${f.kind}:${f.id}`) };
            else if (v.startsWith('g:')) tr.target = { group: v.slice(2) };
            else if (v.startsWith('k:')) tr.target = { kind: v.slice(2) };
            this._changed(true, true);
        })));
        const attrs = attributesFor(fixtures);
        if (!attrs.some((a) => a.id === tr.attr)) attrs.unshift({ id: tr.attr, label: attributeLabel(tr.attr) });
        els.push(row('Attribut', select(attrs.map((a) => [a.id, a.label]), tr.attr, (v) => {
            const wasColor = attributeType(tr.attr) === 'color';
            tr.attr = v;
            if (wasColor !== (attributeType(v) === 'color')) tr.points = []; // valeurs ↔ couleurs : points repartent de zéro
            this._changed(true, true);
        })));
        els.push(row('Mode', seg([['points', 'Points'], ['wave', 'Générateur']], tr.mode, (v) => {
            tr.mode = v;
            this._changed(true, true);
        })));

        // ── Répartition entre projecteurs ──
        els.push(section('Entre projecteurs'));
        els.push(row('Ordre', select(ORDERS, tr.order || 'patch', (v) => { tr.order = v; this._changed(true, true); })));
        els.push(row('Décalage', range(pct(tr.spread), (v, final) => { tr.spread = v / 100; this._changed(final); })));

        if (tr.mode === 'wave') {
            els.push(section('Générateur'));
            els.push(row('Forme', select(SHAPES, tr.shape || 'sine', (v) => { tr.shape = v; this._changed(true, true); })));
            els.push(row('Cycles', number(tr.cycles ?? 1, { min: 0.25, max: 64, step: 0.25, suffix: 'par boucle' }, (v) => { tr.cycles = v; this._changed(); })));
            if (isColor) {
                els.push(row('Couleur A', colorField(tr.colorA || '#000000', (v, final) => { tr.colorA = v; this._changed(final); })));
                els.push(row('Couleur B', colorField(tr.colorB || '#ffffff', (v, final) => { tr.colorB = v; this._changed(final); })));
            } else {
                els.push(row('Bas', range(pct(tr.low ?? 0), (v, final) => { tr.low = v / 100; this._changed(final); })));
                els.push(row('Haut', range(pct(tr.high ?? 1), (v, final) => { tr.high = v / 100; this._changed(final); })));
            }
            if (tr.shape === 'square' || tr.shape === 'pulse') {
                els.push(row('Largeur', range(pct(tr.width ?? 0.5), (v, final) => { tr.width = Math.max(0.01, v / 100); this._changed(final); })));
            }
        } else {
            els.push(section('Points'));
            els.push(row('Transition', seg(INTERPS, tr.interp || 'linear', (v) => { tr.interp = v; this._changed(true, true); })));
            const p = this.point && tr.points.includes(this.point) ? this.point : null;
            if (p) {
                els.push(row('Temps', number(p.t, { min: 0, max: 256, step: 0.25 }, (v) => {
                    p.t = v;
                    tr.points.sort((a, b) => a.t - b.t);
                    this._changed();
                })));
                if (isColor) els.push(row('Couleur', colorField(p.c, (v, final) => { p.c = v; this._changed(final); })));
                else els.push(row('Valeur', range(pct(p.v), (v, final) => { p.v = v / 100; this._changed(final); })));
                els.push(row('', h('button', { class: 'btn', text: 'Supprimer le point', onclick: () => {
                    tr.points.splice(tr.points.indexOf(p), 1);
                    this.point = null;
                    this._changed(true, true);
                } })));
            } else if (isColor) {
                els.push(row('Nouveau point', colorField(this.newPointColor, (v) => { this.newPointColor = v; })));
            }
            els.push(h('div', { class: 'insp-help dim', text: 'Clic : ajouter · glisser : déplacer · double-clic ou Suppr : supprimer · Maj : sans grille' }));
        }

        // ── Piste ──
        els.push(section('Piste'));
        els.push(row('', h('span', { class: 'group' }, [
            h('button', { class: tr.mute ? 'btn on' : 'btn', text: tr.mute ? 'Muette' : 'Rendre muette', onclick: () => { tr.mute = !tr.mute; this._changed(true, true); } }),
            h('button', { class: 'btn danger', text: 'Supprimer la piste', onclick: () => this._onDelete(tr) }),
        ])));
        els.push(h('div', { class: 'insp-help dim', text: `${fixtures.length} projecteur${fixtures.length > 1 ? 's' : ''} dans la cible` }));
        this.body.replaceChildren(...els);
    }
}
