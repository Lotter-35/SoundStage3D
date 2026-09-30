/**
 * IldaParser.js
 * ─────────────────────────────────────────────────────────────
 * Lecture des fichiers ILDA (ILDA Image Data Transfer Format) :
 *   - format 0 : 3D, couleur indexée      - format 4 : 3D, couleur vraie (RGB)
 *   - format 1 : 2D, couleur indexée      - format 5 : 2D, couleur vraie (RGB)
 *   - format 2 : palette (remplace la palette des images indexées qui suivent)
 * Coordonnées 16 bits signées → [-1, 1] ; statut : bit 6 = point masqué, bit 7 = dernier point.
 * La coordonnée Z des formats 3D est ignorée (projection orthogonale, comme les DAC).
 *
 * Résultat : une liste d'images LaserFrame (même format que le générateur de motifs).
 * ─────────────────────────────────────────────────────────────
 */

import { LaserFrame } from '../Laser2Patterns.js';

/** Palette ILDA par défaut (64 couleurs, norme ILDA) */
const DEFAULT_PALETTE = [
    [255, 0, 0], [255, 16, 0], [255, 32, 0], [255, 48, 0], [255, 64, 0], [255, 80, 0], [255, 96, 0], [255, 112, 0],
    [255, 128, 0], [255, 144, 0], [255, 160, 0], [255, 176, 0], [255, 192, 0], [255, 208, 0], [255, 224, 0], [255, 240, 0],
    [255, 255, 0], [224, 255, 0], [192, 255, 0], [160, 255, 0], [128, 255, 0], [96, 255, 0], [64, 255, 0], [32, 255, 0],
    [0, 255, 0], [0, 255, 36], [0, 255, 73], [0, 255, 109], [0, 255, 146], [0, 255, 182], [0, 255, 219], [0, 255, 255],
    [0, 227, 255], [0, 198, 255], [0, 170, 255], [0, 142, 255], [0, 113, 255], [0, 85, 255], [0, 56, 255], [0, 28, 255],
    [0, 0, 255], [32, 0, 255], [64, 0, 255], [96, 0, 255], [128, 0, 255], [160, 0, 255], [192, 0, 255], [224, 0, 255],
    [255, 0, 255], [255, 32, 255], [255, 64, 255], [255, 96, 255], [255, 128, 255], [255, 160, 255], [255, 192, 255], [255, 224, 255],
    [255, 255, 255], [255, 224, 224], [255, 192, 192], [255, 160, 160], [255, 128, 128], [255, 96, 96], [255, 64, 64], [255, 32, 32],
];

const RECORD_SIZE = { 0: 8, 1: 6, 2: 3, 4: 10, 5: 8 };
const MAX_POINTS = 60000;

/**
 * @param {ArrayBuffer} buffer contenu du fichier .ild
 * @returns {{ frames: LaserFrame[], name: string }}
 */
export function parseIlda(buffer) {
    const v = new DataView(buffer);
    const frames = [];
    let palette = DEFAULT_PALETTE;
    let name = '';
    let o = 0;
    while (o + 32 <= v.byteLength) {
        if (v.getUint8(o) !== 0x49 || v.getUint8(o + 1) !== 0x4C || v.getUint8(o + 2) !== 0x44 || v.getUint8(o + 3) !== 0x41) break; // « ILDA »
        const format = v.getUint8(o + 7);
        const count = v.getUint16(o + 24);
        if (!name) name = ascii(v, o + 8, 8);
        o += 32;
        const size = RECORD_SIZE[format];
        if (size === undefined) break;                 // format inconnu : fin de lecture
        if (count === 0) break;                        // en-tête de fin de fichier
        if (o + count * size > v.byteLength) break;    // fichier tronqué

        if (format === 2) {
            palette = [];
            for (let i = 0; i < count; i++) {
                const p = o + i * 3;
                palette.push([v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2)]);
            }
            o += count * size;
            continue;
        }

        const f = new LaserFrame(Math.min(count, MAX_POINTS));
        const is3D = format === 0 || format === 4;
        const n = Math.min(count, MAX_POINTS);
        for (let i = 0; i < n; i++) {
            const p = o + i * size;
            const x = v.getInt16(p) / 32768;
            const y = v.getInt16(p + 2) / 32768;
            const sp = p + (is3D ? 6 : 4);
            const status = v.getUint8(sp);
            let r = 0, g = 0, b = 0;
            if (!(status & 0x40)) {
                if (format === 4 || format === 5) {
                    b = v.getUint8(sp + 1) / 255;
                    g = v.getUint8(sp + 2) / 255;
                    r = v.getUint8(sp + 3) / 255;
                } else {
                    const c = palette[v.getUint8(sp + 1)] || palette[0] || [255, 255, 255];
                    r = c[0] / 255; g = c[1] / 255; b = c[2] / 255;
                }
            }
            f.push(x, y, r, g, b);
        }
        if (f.n === 0) f.push(0, 0, 0, 0, 0);
        frames.push(f);
        o += count * size;
    }
    return { frames, name: name.trim() };
}

function ascii(v, o, n) {
    let s = '';
    for (let i = 0; i < n && o + i < v.byteLength; i++) {
        const c = v.getUint8(o + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}
