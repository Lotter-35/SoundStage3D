/**
 * dom.js — petites aides DOM de la régie (création d'éléments, icônes, formats)
 */

export function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
}

/** Icônes au trait (SVG), héritent de la couleur du texte */
export const ICONS = {
    play: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1.2v7.6L8.6 5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1.5h2v7H2zM6 1.5h2v7H6z" fill="currentColor"/></svg>',
    left: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    right: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6 4.5 9.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
};

export const pad3 = (n) => String(n).padStart(3, '0');

/** 0…255 → texte selon le mode d'affichage (valeur brute ou pourcentage) */
export function fmtValue(v, percent) {
    return percent ? String(Math.round((v / 255) * 100)) : String(v);
}

/** Secondes → mm:ss.d */
export function fmtClock(sec) {
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}

/** Octets par seconde → « 1,2 Ko/s » */
export function fmtRate(bytesPerSec) {
    return `${(bytesPerSec / 1024).toFixed(1).replace('.', ',')} Ko/s`;
}
