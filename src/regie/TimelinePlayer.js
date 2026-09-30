/**
 * TimelinePlayer.js — show calé sur la musique : la timeline du morceau en cours.
 *
 * Chaque morceau a sa timeline dans le show (show.timelines, clé = nom du morceau) :
 * BPM et position du premier temps, pistes de clips (un clip = un pattern joué en boucle
 * sur une durée) et repères (intro, montée, drop…).
 *
 * Temps de la timeline = (temps musical − décalage) × BPM / 60, sur l'horloge musicale du
 * serveur : tous les joueurs voient la lumière calée sur leur musique. En pause, la lumière
 * reste celle de la position de lecture (programmation image par image).
 * Timeline armée et morceau en lecture : le tempo de la régie suit le morceau (pads du Live).
 */

import { newId } from './ShowStore.js';

const mod = (a, n) => ((a % n) + n) % n;

export const BEATS_PER_BAR = 4;

export class TimelinePlayer {
    /**
     * @param {object} o
     * @param {import('./ShowStore.js').ShowStore} o.shows
     * @param {import('./RegieClient.js').RegieClient} o.client
     * @param {import('./PatternEngine.js').PatternEngine} o.engine
     * @param {import('./TempoClock.js').TempoClock} o.tempo
     */
    constructor({ shows, client, engine, tempo }) {
        this.shows = shows;
        this.client = client;
        this.engine = engine;
        tempo.follow((t) => {
            const tl = this.armed();
            if (!tl || !(this.client.playback && this.client.playback.isPlaying)) return null;
            return { beat: this.beatAt(tl, t), bpm: tl.bpm };
        });
    }

    /** Nom du morceau en cours (clé de sa timeline) */
    trackKey() {
        const tr = this.client.track;
        return tr && tr.name ? tr.name : null;
    }

    /** Timeline du morceau en cours, ou null */
    current() {
        const show = this.shows.show;
        const key = this.trackKey();
        return show && key && show.timelines ? show.timelines[key] || null : null;
    }

    armed() {
        const tl = this.current();
        return tl && tl.armed !== false ? tl : null;
    }

    /** Temps de la timeline (en temps) à l'heure serveur t */
    beatAt(tl, t) {
        return ((this.client.musicTime(t) - tl.offset) * tl.bpm) / 60;
    }

    timeOfBeat(tl, beat) {
        return tl.offset + (beat * 60) / tl.bpm;
    }

    beatOfTime(tl, time) {
        return ((time - tl.offset) * tl.bpm) / 60;
    }

    /** Clip joué par une piste au temps `beat` (le dernier commencé l'emporte), ou null */
    clipAt(lane, beat) {
        let found = null;
        for (const c of lane.clips) {
            if (beat >= c.start && beat < c.start + c.length && (!found || c.start >= found.start)) found = c;
        }
        return found;
    }

    /** Crée la timeline du morceau en cours à partir de son analyse (BPM, premier temps, durée) */
    create(analysis) {
        const show = this.shows.show;
        const key = this.trackKey();
        if (!show || !key) return null;
        if (!show.timelines) show.timelines = {};
        const tl = {
            trackName: key,
            trackId: this.client.track.id || null,
            duration: analysis ? Math.round(analysis.duration * 1000) / 1000 : 240,
            bpm: analysis ? analysis.bpm : show.bpm || 120,
            offset: analysis ? analysis.offset : 0,
            armed: true,
            lanes: ['Lyres', 'Couleurs', 'Effets'].map((name) => ({ id: newId('l'), name, mute: false, clips: [] })),
            markers: [],
        };
        show.timelines[key] = tl;
        this.shows.touch();
        return tl;
    }

    /**
     * Écrit les clips de la timeline armée à l'heure t (couche sous les patterns du Live)
     * @param {(universe: number) => Uint8Array} frameOf
     * @param {number} t
     */
    apply(frameOf, t) {
        const tl = this.armed();
        if (!tl) return;
        const show = this.shows.show;
        const beat = this.beatAt(tl, t);
        for (const lane of tl.lanes) {
            if (lane.mute) continue;
            const clip = this.clipAt(lane, beat);
            if (!clip) continue;
            const pat = show.patterns.find((p) => p.id === clip.pattern);
            if (!pat) continue;
            const L = Math.max(0.25, pat.length || 4);
            this.engine.applyPattern(pat, mod(beat - clip.start, L), 1, 1, frameOf);
        }
    }
}
