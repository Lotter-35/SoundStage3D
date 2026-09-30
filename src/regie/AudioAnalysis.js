/**
 * AudioAnalysis.js — analyse du morceau en cours pour la timeline du show :
 *   - forme d'onde (min / max par tranche) ;
 *   - tempo (BPM) et position du premier temps, estimés sur l'enveloppe des attaques
 *     (basses et médiums), par autocorrélation puis recherche de la phase.
 * Le fichier audio vient du serveur (même adresse que pour les joueurs) ; le résultat est
 * gardé en mémoire le temps de la page.
 */

const PEAKS = 16384;        // tranches de la forme d'onde
const HOP = 512;            // pas de l'enveloppe (≈ 11,6 ms à 44,1 kHz)
const MIN_BPM = 70;
const MAX_BPM = 180;

const _cache = new Map();

/**
 * @param {string} url
 * @returns {Promise<{duration: number, sampleRate: number, peaks: Float32Array, bpm: number, offset: number, confidence: number}>}
 */
export function analyzeTrack(url) {
    if (!_cache.has(url)) {
        const p = run(url).catch((e) => { _cache.delete(url); throw e; });
        _cache.set(url, p);
    }
    return _cache.get(url);
}

async function run(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    // Contexte hors ligne minimal : il ne sert qu'à décoder (pas de son joué)
    const ctx = new Ctx(1, 1, 44100);
    const audio = await ctx.decodeAudioData(bytes);
    const mono = mixdown(audio);
    const peaks = computePeaks(mono);
    const { bpm, offset, confidence } = detectTempo(mono, audio.sampleRate);
    return { duration: audio.duration, sampleRate: audio.sampleRate, peaks, bpm, offset, confidence };
}

function mixdown(audio) {
    const n = audio.length;
    const out = new Float32Array(n);
    const chans = audio.numberOfChannels;
    for (let c = 0; c < chans; c++) {
        const d = audio.getChannelData(c);
        for (let i = 0; i < n; i++) out[i] += d[i] / chans;
    }
    return out;
}

/** Min / max par tranche, entrelacés [min0, max0, min1, max1…] */
function computePeaks(x) {
    const out = new Float32Array(PEAKS * 2);
    const size = x.length / PEAKS;
    for (let k = 0; k < PEAKS; k++) {
        const a = Math.floor(k * size);
        const b = Math.min(x.length, Math.floor((k + 1) * size));
        let lo = 0;
        let hi = 0;
        for (let i = a; i < b; i++) {
            const v = x[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        out[k * 2] = lo;
        out[k * 2 + 1] = hi;
    }
    return out;
}

/**
 * Tempo et premier temps :
 *   1. enveloppe d'énergie (basses renforcées) et attaques = hausse du log de l'énergie, lissées ;
 *   2. tempo grossier par autocorrélation sur 70–180 BPM (légère préférence autour de 120) ;
 *   3. affinage conjoint du tempo et de la phase : « peigne » de temps qui recueille le plus
 *      d'attaques (pas de 0,1 puis 0,01 BPM) ;
 *   4. premier temps de mesure : parmi les 4 temps, celui où les basses sont les plus fortes
 *      (la grosse caisse et la basse marquent le plus souvent le début de mesure).
 */
function detectTempo(x, sr) {
    const k = 1 - Math.exp((-2 * Math.PI * 200) / sr);
    const frames = Math.floor(x.length / HOP);
    const env = new Float32Array(frames);
    const low = new Float32Array(frames); // énergie des basses (linéaire) : temps forts
    let lp = 0;
    for (let f = 0; f < frames; f++) {
        let eLow = 0;
        let eAll = 0;
        const base = f * HOP;
        for (let i = 0; i < HOP; i++) {
            const v = x[base + i];
            lp += k * (v - lp);
            eLow += lp * lp;
            eAll += v * v;
        }
        env[f] = Math.log(1e-9 + eLow * 4 + eAll * 0.5);
        low[f] = eLow;
    }
    let flux = new Float32Array(frames);
    for (let f = 1; f < frames; f++) flux[f] = Math.max(0, env[f] - env[f - 1]);
    // Moyenne glissante retirée (garde les pics d'attaque), puis lissage léger
    const win = 16;
    const hp = new Float32Array(frames);
    let acc = 0;
    for (let f = 0; f < frames; f++) {
        acc += flux[f] - (f >= win ? flux[f - win] : 0);
        hp[f] = Math.max(0, flux[f] - acc / Math.min(win, f + 1));
    }
    flux = hp;
    for (let pass = 0; pass < 2; pass++) {
        const sm = new Float32Array(frames);
        for (let f = 1; f < frames - 1; f++) sm[f] = 0.25 * flux[f - 1] + 0.5 * flux[f] + 0.25 * flux[f + 1];
        flux = sm;
    }

    const fps = sr / HOP;
    // 2. Tempo grossier (autocorrélation)
    const lagMin = Math.floor((60 / MAX_BPM) * fps);
    const lagMax = Math.ceil((60 / MIN_BPM) * fps);
    let best = lagMin;
    let bestScore = -Infinity;
    let sum = 0;
    let bestRaw = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
        let s = 0;
        for (let f = lag; f < frames; f++) s += flux[f] * flux[f - lag];
        s /= frames - lag;
        const bpm = (60 * fps) / lag;
        const w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
        sum += s;
        if (s * w > bestScore) { bestScore = s * w; best = lag; bestRaw = s; }
    }
    const coarse = (60 * fps) / best;
    const confidence = sum > 0 ? Math.min(1, (bestRaw * (lagMax - lagMin + 1)) / sum / 4) : 0;

    // 3. Peigne : score moyen des attaques aux temps (interpolation linéaire entre trames)
    const comb = (bpm, phase) => {
        const period = (60 / bpm) * fps;
        let s = 0;
        let n = 0;
        for (let t = phase; t < frames - 1; t += period) {
            const i = Math.floor(t);
            const fr = t - i;
            s += flux[i] * (1 - fr) + flux[i + 1] * fr;
            n++;
        }
        return n ? s / n : 0;
    };
    const search = (b0, b1, step, phases, around) => {
        let res = { bpm: coarse, phase: 0, score: -Infinity };
        for (let bpm = b0; bpm <= b1 + 1e-9; bpm += step) {
            const period = (60 / bpm) * fps;
            const pa = around === undefined ? 0 : around - period / 8;
            const pb = around === undefined ? period : around + period / 8;
            for (let p = 0; p < phases; p++) {
                const phase = pa + ((pb - pa) * p) / phases;
                if (phase < 0) continue;
                const sc = comb(bpm, phase);
                if (sc > res.score) res = { bpm, phase, score: sc };
            }
        }
        return res;
    };
    const lo = Math.max(MIN_BPM, coarse * 0.97);
    const hi = Math.min(MAX_BPM, coarse * 1.03);
    let r = search(lo, hi, 0.1, 48);
    r = search(r.bpm - 0.12, r.bpm + 0.12, 0.01, 40, r.phase);
    // Les morceaux ont le plus souvent un tempo entier : on y cale une estimation toute proche
    let bpm = Math.round(r.bpm * 100) / 100;
    if (Math.abs(bpm - Math.round(bpm)) <= 0.06) bpm = Math.round(bpm);
    const period = (60 / bpm) * fps;

    // 4. Premier temps de mesure : le temps (sur 4) aux basses les plus fortes (juste après l'attaque)
    const span = Math.max(2, Math.round(period / 4));
    let bestBeat = 0;
    let bestBeatScore = -Infinity;
    for (let m = 0; m < 4; m++) {
        let s = 0;
        for (let t = r.phase + m * period; t < frames - span; t += period * 4) {
            const i = Math.round(t);
            for (let j = 0; j < span; j++) s += low[i + j];
        }
        if (s > bestBeatScore) { bestBeatScore = s; bestBeat = m; }
    }
    // Trame d'attaque → début de la trame (l'attaque commence dans la trame où l'énergie monte)
    const offset = ((r.phase + bestBeat * period) * HOP) / sr;
    return { bpm, offset: Math.round(offset * 1000) / 1000, confidence, coarse: Math.round(coarse * 10) / 10 };
}
