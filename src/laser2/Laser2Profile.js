/**
 * Laser2Profile.js
 * ─────────────────────────────────────────────────────────────
 * Personnalité DMX du nouveau laser (« fixture profile ») : DMX (octets) ⇄ paramètres du laser.
 * Mode Standard : 36 canaux (dimmer et positions en 16 bits). Utilisé par le jeu ET par la régie.
 *
 *  1 Mode            0-9 éteint · 10-59 motifs internes · 60-109 fichier ILDA · 110-159 ILDA live
 *                    (en attendant : fichier ILDA) · 160-209 mire de test · 210-255 motifs internes
 *  2-3 Dimmer        4 Obturateur / strobe (0-19 fermé, 50-99 strobe, reste ouvert)
 *  5 Banque          tranches de 10 : banque 1 = 0-9, banque 2 = 10-19… (banques internes ou ILDA selon le mode)
 *  6 Motif           numéro dans la banque (0 = premier)
 *  7 Image / lecture 0-127 image fixe n° · 128-255 lecture en boucle, lente → rapide
 *  8 Vitesse de dessin (kpps)        9-10 Tracé début / fin       11 Pointillés
 *  12-13 Taille X / Y                14 Zoom automatique (pulse / avant-arrière + vitesse)
 *  15-18 Position X / Y (16 bits)    19-21 Rotation Z / X / Y (angle ou rotation continue)
 *  22-25 Balayage X, Y, vitesse, forme         26 Vague
 *  27 Couleur (RGB, macros, effets)  28-30 Rouge / Vert / Bleu      31 Vitesse de l'effet couleur
 *  32 Nombre de faisceaux            33 Ouverture                   34 Faisceaux ↔ nappe
 *  35 Réseau de diffraction          36 Fonctions (128-255 : masquage du public)
 *
 * decode(universe, address, mode) → { params }      encode(params, mode) → Uint8Array
 * ─────────────────────────────────────────────────────────────
 */

import {
    PATTERN_BANKS, SWEEP_SHAPES, GRATINGS, DMX_MODES, hexToRgb,
} from './config/laser2Params.js';
import { ildaLibrary } from './ilda/IldaLibrary.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round = Math.round;
const _rgb = [0, 0, 0];
const pct = (v) => (v / 255) * 100;
const enc = (p100) => round(clamp(p100 / 100, 0, 1) * 255);

const listDec = (list, v) => list[Math.min(list.length - 1, Math.floor(v * list.length / 256))];
const listEnc = (list, value) => Math.min(255, round((Math.max(0, list.indexOf(value)) + 0.5) * 256 / list.length));

const COLOR_MACROS = [
    ['Rouge', '#ff0000'], ['Vert', '#00ff00'], ['Bleu', '#0000ff'], ['Jaune', '#ffff00'],
    ['Cyan', '#00ffff'], ['Magenta', '#ff00ff'], ['Blanc', '#ffffff'], ['Orange', '#ff6000'],
];
const COLOR_FX = [['Segments', 72], ['Arc-en-ciel défilant', 118], ['Chenillard', 164], ['Aléatoire par point', 210]];

function rgbToHex(r, g, b) {
    const c = (x) => clamp(round(x), 0, 255).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
}

// Angle (0-127) ou rotation continue horaire (128-191) / anti-horaire (192-255), lente → rapide
function decRot(v, o, angleKey, speedKey) {
    if (v < 128) { o[angleKey] = Math.min(180, -180 + (v / 126) * 360); o[speedKey] = 0; return; }
    o[speedKey] = v < 192 ? 3 + ((v - 128) / 63) * 97 : -(3 + ((v - 192) / 63) * 97);
}
function encRot(angle, speed) {
    if (Math.abs(speed) < 1) return round(clamp((angle + 180) / 360, 0, 1) * 126);   // 63 = 0°
    if (speed > 0) return clamp(128 + round(((speed - 3) / 97) * 63), 128, 191);
    return clamp(192 + round(((-speed - 3) / 97) * 63), 192, 255);
}

/** Mode du laser : internal | ilda | test | off */
function modeOf(v) {
    if (v < 10) return 'off';
    if (v < 60 || v >= 210) return 'internal';
    if (v < 160) return 'ilda';
    return 'test';
}

const CHANNELS = [
    { name: 'Mode (éteint / motifs / ILDA / ILDA live / mire)',
      dec: (v, o, ctx) => { ctx.mode = modeOf(v); },
      enc: p => (p.source === 'Fichier ILDA' ? 80 : p.pattern === 'Mire ILDA' ? 180 : 30) },
    { name: 'Dimmer', wide: true, intensity: true,
      dec: (v16, o) => { o.dimmer = (v16 / 65535) * 100; },
      enc: p => round(clamp(p.dimmer / 100, 0, 1) * 65535) },
    // Même convention que les lyres et barres LED (0-19 fermé, 50-99 strobe lent → rapide, reste ouvert)
    { name: 'Obturateur / Strobe',
      dec: (v, o) => {
          if (v < 20) o.shutter = 'Fermé';
          else if (v >= 50 && v < 100) { o.shutter = 'Strobe'; o.strobeRate = 0.5 + ((v - 50) / 49) * 24.5; }
          else o.shutter = 'Ouvert';
      },
      enc: p => (p.shutter === 'Fermé' ? 0 : p.shutter === 'Strobe' ? 50 + round(clamp((p.strobeRate - 0.5) / 24.5, 0, 1) * 49) : 255) },
    { name: 'Banque (tranches de 10)', dec: (v, o, ctx) => { ctx.bank = Math.floor(v / 10); }, enc: p => bankOf(p) * 10 + 5 },
    { name: 'Motif (n° dans la banque)', dec: (v, o, ctx) => { ctx.item = v; }, enc: p => itemOf(p) },
    { name: 'Image / lecture (0-127 image fixe, 128-255 boucle lente → rapide)',
      dec: (v, o) => {
          if (v < 128) { o.playMode = 'Image fixe'; o.ildaFrame = v; }
          else { o.playMode = 'Boucle'; o.ildaFps = 1 + ((v - 128) / 127) * 59; }
      },
      enc: p => (p.playMode === 'Image fixe' ? clamp(round(p.ildaFrame), 0, 127) : 128 + round(clamp((p.ildaFps - 1) / 59, 0, 1) * 127)) },
    { name: 'Vitesse de dessin (5 → 60 kpps)', dec: (v, o) => { o.scanRate = 5 + (v / 255) * 55; }, enc: p => round(clamp((p.scanRate - 5) / 55, 0, 1) * 255) },
    { name: 'Tracé : début', dec: (v, o) => { o.drawStart = pct(v); }, enc: p => enc(p.drawStart) },
    { name: 'Tracé : fin (0 = tout)', dec: (v, o) => { o.drawEnd = v === 0 ? 100 : pct(v); }, enc: p => (p.drawEnd >= 100 ? 0 : Math.max(1, enc(p.drawEnd))) },
    { name: 'Pointillés', dec: (v, o) => { o.dots = pct(v); }, enc: p => enc(p.dots) },
    { name: 'Taille X', dec: (v, o) => { o.sizeX = pct(v); }, enc: p => enc(p.sizeX) },
    { name: 'Taille Y', dec: (v, o) => { o.sizeY = pct(v); }, enc: p => enc(p.sizeY) },
    { name: 'Zoom auto (0-9 aucun, 10-127 pulse, 128-255 avant-arrière)',
      dec: (v, o) => {
          if (v < 10) o.zoomFx = 'Aucun';
          else if (v < 128) { o.zoomFx = 'Pulse'; o.zoomFxSpeed = ((v - 10) / 117) * 100; }
          else { o.zoomFx = 'Avant-arrière'; o.zoomFxSpeed = ((v - 128) / 127) * 100; }
      },
      enc: p => (p.zoomFx === 'Pulse' ? 10 + round(clamp(p.zoomFxSpeed / 100, 0, 1) * 117)
          : p.zoomFx === 'Avant-arrière' ? 128 + round(clamp(p.zoomFxSpeed / 100, 0, 1) * 127) : 0) },
    { name: 'Position X', wide: true, dec: (v16, o) => { o.offsetX = -100 + (v16 / 65535) * 200; }, enc: p => round(clamp((p.offsetX + 100) / 200, 0, 1) * 65535) },
    { name: 'Position Y', wide: true, dec: (v16, o) => { o.offsetY = -100 + (v16 / 65535) * 200; }, enc: p => round(clamp((p.offsetY + 100) / 200, 0, 1) * 65535) },
    { name: 'Rotation Z (0-127 angle, 128-191 horaire, 192-255 anti-horaire)', dec: (v, o) => decRot(v, o, 'rotation', 'rotSpeed'), enc: p => encRot(p.rotation, p.rotSpeed) },
    { name: 'Rotation 3D X', dec: (v, o) => decRot(v, o, 'rotX', 'rotXSpeed'), enc: p => encRot(p.rotX, p.rotXSpeed) },
    { name: 'Rotation 3D Y', dec: (v, o) => decRot(v, o, 'rotY', 'rotYSpeed'), enc: p => encRot(p.rotY, p.rotYSpeed) },
    { name: 'Balayage X', dec: (v, o) => { o.sweepX = pct(v); }, enc: p => enc(p.sweepX) },
    { name: 'Balayage Y', dec: (v, o) => { o.sweepY = pct(v); }, enc: p => enc(p.sweepY) },
    { name: 'Vitesse du balayage', dec: (v, o) => { o.sweepSpeed = pct(v); }, enc: p => enc(p.sweepSpeed) },
    { name: 'Forme du balayage', dec: (v, o) => { o.sweepShape = listDec(SWEEP_SHAPES, v); }, enc: p => listEnc(SWEEP_SHAPES, p.sweepShape) },
    { name: 'Vague', dec: (v, o) => { o.waveAmp = pct(v); }, enc: p => enc(p.waveAmp) },
    { name: 'Couleur (0-7 RGB, 8-71 macros, 72-255 effets)',
      dec: (v, o, ctx) => {
          ctx.colorCh = v;
          if (v < 8) o.colorMode = 'Fixe';
          else if (v < 72) { o.colorMode = 'Fixe'; ctx.macro = COLOR_MACROS[Math.min(7, (v - 8) >> 3)][1]; }
          else { let m = COLOR_FX[0][0]; for (const [n, a] of COLOR_FX) if (v >= a) m = n; o.colorMode = m; }
      },
      enc: p => (p.colorMode === 'Fixe' ? 0 : (COLOR_FX.find(c => c[0] === p.colorMode) || COLOR_FX[0])[1] + 5) },
    { name: 'Rouge', dec: (v, o, ctx) => { ctx.r = v; }, enc: p => round(hexToRgb(p.color, _rgb)[0] * 255) },
    { name: 'Vert', dec: (v, o, ctx) => { ctx.g = v; }, enc: p => round(hexToRgb(p.color, _rgb)[1] * 255) },
    { name: 'Bleu', dec: (v, o, ctx) => { ctx.b = v; }, enc: p => round(hexToRgb(p.color, _rgb)[2] * 255) },
    { name: 'Vitesse de l\'effet couleur', dec: (v, o) => { o.colorSpeed = pct(v); }, enc: p => enc(p.colorSpeed) },
    { name: 'Nombre de faisceaux (1 → 64)', dec: (v, o) => { o.beamCount = 1 + round((v / 255) * 63); }, enc: p => round(clamp((p.beamCount - 1) / 63, 0, 1) * 255) },
    { name: 'Ouverture de l\'éventail', dec: (v, o) => { o.fanSpread = pct(v); }, enc: p => enc(p.fanSpread) },
    { name: 'Faisceaux ↔ nappe', dec: (v, o) => { o.fanBlend = pct(v); }, enc: p => enc(p.fanBlend) },
    { name: 'Réseau de diffraction', dec: (v, o) => { o.grating = listDec(GRATINGS, v); }, enc: p => listEnc(GRATINGS, p.grating) },
    { name: 'Fonctions (128-255 masquage du public)', dec: (v, o) => { o.audienceMask = v >= 128; }, enc: p => (p.audienceMask ? 200 : 0) },
];

/** Banque DMX (index) des réglages courants */
function bankOf(p) {
    if (p.source === 'Fichier ILDA') {
        const e = ildaLibrary.entry(p.ildaFile);
        return e ? Math.max(0, ildaLibrary.bankNames.indexOf(e.bank)) : 0;
    }
    return Math.max(0, PATTERN_BANKS.findIndex(b => b.patterns.includes(p.pattern)));
}
function itemOf(p) {
    if (p.source === 'Fichier ILDA') {
        const e = ildaLibrary.entry(p.ildaFile);
        return e ? Math.max(0, ildaLibrary.filesOf(e.bank).findIndex(f => f.path === p.ildaFile)) : 0;
    }
    const b = PATTERN_BANKS.find(x => x.patterns.includes(p.pattern));
    return b ? Math.max(0, b.patterns.indexOf(p.pattern)) : 0;
}

export const STANDARD_FOOTPRINT = CHANNELS.reduce((n, c) => n + (c.wide ? 2 : 1), 0);

export function getFootprint() {
    return STANDARD_FOOTPRINT;
}

/** Canaux pour le moniteur du panneau et la régie : { address, name, intensity?, fine?, fineAddress? } */
export function describeChannels(mode, startAddress) {
    const out = [];
    let a = startAddress;
    for (const c of CHANNELS) {
        const ch = { address: a++, name: c.name };
        if (c.intensity) ch.intensity = true;
        out.push(ch);
        if (c.wide) {
            ch.fineAddress = a;
            out.push({ address: a++, name: c.name + ' fine', fine: true, intensity: Boolean(c.intensity) || undefined });
        }
    }
    return out;
}

/**
 * Décode les canaux d'un laser.
 * @returns {{ params: object }}
 */
export function decode(universe, address) {
    const params = {};
    const ctx = { mode: 'internal', bank: 0, item: 0, r: 0, g: 0, b: 0, macro: null };
    let a = address;
    for (const c of CHANNELS) {
        if (c.wide) { c.dec(universe.get16(a), params, ctx); a += 2; }
        else { c.dec(universe.get(a), params, ctx); a += 1; }
    }
    params.color = ctx.macro || rgbToHex(ctx.r, ctx.g, ctx.b);
    // Contenu : banque + motif, interprétés selon le mode
    if (ctx.mode === 'ilda') {
        params.source = 'Fichier ILDA';
        const banks = ildaLibrary.bankNames;
        const bank = banks[Math.min(ctx.bank, banks.length - 1)];
        const files = bank ? ildaLibrary.filesOf(bank) : [];
        if (files.length) params.ildaFile = files[Math.min(ctx.item, files.length - 1)].path;
    } else {
        params.source = 'Motif interne';
        if (ctx.mode === 'test') params.pattern = 'Mire ILDA';
        else {
            const b = PATTERN_BANKS[Math.min(ctx.bank, PATTERN_BANKS.length - 1)];
            params.pattern = b.patterns[Math.min(ctx.item, b.patterns.length - 1)];
        }
    }
    if (ctx.mode === 'off') params.shutter = 'Fermé';
    return { params };
}

/** Valeurs DMX équivalentes aux réglages courants (moniteur du panneau, reprise de main par la régie) */
export function encode(params) {
    const out = [];
    for (const c of CHANNELS) {
        const v = c.enc(params);
        if (c.wide) out.push((v >> 8) & 255, v & 255);
        else out.push(clamp(v, 0, 255));
    }
    return Uint8Array.from(out);
}

export { DMX_MODES };
