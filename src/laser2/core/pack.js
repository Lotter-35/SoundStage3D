/**
 * pack.js — emballage de la géométrie de tous les lasers dans un seul tampon (envoi worker → jeu),
 * et lecture côté jeu (vues sans copie).
 */

import { BEAM_STRIDE, SHEET_STRIDE, IMPACT_STRIDE } from './strides.js';

/**
 * @param {import('./Laser2Core.js').CoreSystem} sys
 * @param {ArrayBuffer|null} spare tampon rendu par le jeu (réutilisé s'il est assez grand)
 * @returns {{ buffer: ArrayBuffer, header: object[] }}
 */
export function packResult(sys, spare) {
    let total = 0;
    for (const c of sys.cores.values()) {
        total += c.beamN * BEAM_STRIDE + c.sheetN * SHEET_STRIDE + c.impactN * IMPACT_STRIDE;
    }
    const bytes = Math.max(4, total * 4);
    const buffer = spare && spare.byteLength >= bytes ? spare : new ArrayBuffer(Math.ceil(total * 1.3 + 16) * 4);
    const f = new Float32Array(buffer);
    const header = [];
    let o = 0;
    for (const c of sys.cores.values()) {
        const s = c.scanner ? c.scanner.stats : null;
        const h = {
            id: c.id,
            b: o, bn: c.beamN,
            s: 0, sn: c.sheetN,
            i: 0, in: c.impactN,
            lens: [c.lens[0], c.lens[1], c.lens[2]],
            stats: s ? { points: s.points, frameHz: s.frameHz, window: s.window, beams: s.beams, sheets: s.sheets, frames: s.frames } : null,
        };
        f.set(c.beamData.subarray(0, c.beamN * BEAM_STRIDE), o);
        o += c.beamN * BEAM_STRIDE;
        h.s = o;
        f.set(c.sheetData.subarray(0, c.sheetN * SHEET_STRIDE), o);
        o += c.sheetN * SHEET_STRIDE;
        h.i = o;
        f.set(c.impactData.subarray(0, c.impactN * IMPACT_STRIDE), o);
        o += c.impactN * IMPACT_STRIDE;
        header.push(h);
    }
    return { buffer, header };
}

/** Vues (sans copie) sur la géométrie d'un laser dans le tampon reçu */
export function viewsOf(buffer, h) {
    const f = new Float32Array(buffer);
    return {
        beamData: f.subarray(h.b, h.b + h.bn * BEAM_STRIDE),
        sheetData: f.subarray(h.s, h.s + h.sn * SHEET_STRIDE),
        impactData: f.subarray(h.i, h.i + h.in * IMPACT_STRIDE),
    };
}
