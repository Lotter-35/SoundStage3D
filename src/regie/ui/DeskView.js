/**
 * DeskView.js — pupitre de la régie (étape 1 : sortie DMX brute)
 *
 *   barre du haut : salle, connexion et aller-retour, joueurs, horloge musicale,
 *                   avance des trames, débit de sortie
 *   gauche        : univers
 *   centre        : moniteur DMX de l'univers choisi
 *   bas           : banque de 24 faders de canaux
 */

import { h, ICONS, fmtClock, fmtRate, pad3 } from './dom.js';
import { DmxMonitor } from './DmxMonitor.js';
import { FaderBank } from './FaderBank.js';
import { DMX_UNIVERSE_SIZE, DMX_MAX_UNIVERSE } from '../../dmx/DmxProtocol.js';

export const FADER_COUNT = 24;
const LAST_BANK_START = DMX_UNIVERSE_SIZE - FADER_COUNT + 1;

const STATUS_TEXT = {
    idle: 'Déconnecté',
    connecting: 'Connexion…',
    open: 'Connexion…',
    joined: 'Connecté',
    lost: 'Reconnexion…',
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class DeskView {
    /**
     * @param {object} o
     * @param {import('../RegieClient.js').RegieClient} o.client
     * @param {import('../DmxOutput.js').DmxOutput} o.out
     * @param {object} o.prefs          réglages de la page (sauvegardés par main.js)
     * @param {() => void} o.savePrefs
     * @param {() => void} o.onLeave    retour au choix de la salle
     */
    constructor({ client, out, prefs, savePrefs, onLeave }) {
        this.client = client;
        this.out = out;
        this.prefs = prefs;
        this._savePrefs = savePrefs;
        this._onLeave = onLeave;
        this._raf = 0;
        this._lastVersion = -1;
        this._lastStats = 0;

        this.universe = clamp(prefs.universe | 0 || 1, 1, DMX_MAX_UNIVERSE);
        this.bankStart = clamp(prefs.bankStart | 0 || 1, 1, LAST_BANK_START);
        if (!Array.isArray(prefs.universes) || prefs.universes.length === 0) prefs.universes = [1, 2, 3, 4];

        this.monitor = new DmxMonitor({ onPick: (a) => this.setBankStart(a) });
        this.faders = new FaderBank({
            count: FADER_COUNT,
            get: (i) => out.get(this.universe, this.bankStart + i),
            set: (i, v) => out.set(this.universe, this.bankStart + i, v),
        });

        this.el = h('div', { class: 'desk' }, [this._buildTopBar(), this._buildSide(), this._buildMonitor(), this._buildBank()]);
        this._applyPercent();
        this.setUniverse(this.universe);
        this.setBankStart(this.bankStart);
    }

    // ── Construction ──────────────────────────────────────────────────────
    _buildTopBar() {
        this.$room = h('span', { class: 'mono' });
        this.$led = h('span', { class: 'led' });
        this.$status = h('span');
        this.$rtt = h('span', { class: 'mono dim' });
        this.$players = h('span', { class: 'mono' });
        this.$play = h('span', { class: 'play-state', html: ICONS.pause });
        this.$clock = h('span', { class: 'mono' });
        this.$track = h('span', { class: 'track dim' });
        this.$rate = h('span', { class: 'mono' });
        this.$lookahead = h('input', {
            class: 'field num', type: 'number', min: '0', max: '1000', step: '10',
            value: String(this.out.lookahead),
            title: 'Les trames sont calculées avec cette avance et affichées à la même heure chez tous les joueurs. Plus que le délai réseau, sinon elles arrivent en retard.',
            onchange: () => {
                const v = clamp(Math.round(Number(this.$lookahead.value) || 0), 0, 1000);
                this.$lookahead.value = String(v);
                this.out.lookahead = v;
                this.prefs.lookahead = v;
                this._savePrefs();
            },
        });
        return h('div', { class: 'topbar' }, [
            h('span', { class: 'brand', text: 'Régie' }),
            h('span', { class: 'sep' }),
            h('span', { class: 'group' }, [h('span', { class: 'dim', text: 'Salle' }), this.$room,
                h('button', { class: 'btn', text: 'Changer', onclick: () => this._leave() })]),
            h('span', { class: 'sep' }),
            h('span', { class: 'group' }, [this.$led, this.$status, this.$rtt]),
            h('span', { class: 'group' }, [h('span', { class: 'dim', text: 'Joueurs' }), this.$players]),
            h('span', { class: 'sep' }),
            h('span', { class: 'group' }, [this.$play, this.$clock, this.$track]),
            h('span', { class: 'grow' }),
            h('span', { class: 'group' }, [h('span', { class: 'dim', text: 'Avance' }), this.$lookahead, h('span', { class: 'dim', text: 'ms' })]),
            h('span', { class: 'group' }, [h('span', { class: 'dim', text: 'Sortie' }), this.$rate]),
        ]);
    }

    _buildSide() {
        this.$uniList = h('div', { class: 'uni-list' });
        return h('div', { class: 'panel side' }, [
            h('div', { class: 'panel-head' }, [h('span', { class: 'title', text: 'Univers' })]),
            this.$uniList,
            h('button', { class: 'btn uni-add', text: 'Ajouter', onclick: () => this._addUniverse() }),
        ]);
    }

    _buildMonitor() {
        this.$uniTitle = h('span', { class: 'mono' });
        this.$raw = h('button', { text: '0–255', onclick: () => this._setPercent(false) });
        this.$pct = h('button', { text: '%', onclick: () => this._setPercent(true) });
        return h('div', { class: 'panel' }, [
            h('div', { class: 'panel-head' }, [
                h('span', { class: 'title', text: 'Moniteur DMX' }),
                this.$uniTitle,
                h('span', { class: 'grow' }),
                h('span', { class: 'seg' }, [this.$raw, this.$pct]),
            ]),
            this.monitor.el,
        ]);
    }

    _buildBank() {
        this.$bankRange = h('span', { class: 'mono' });
        this.$bankAddr = h('input', {
            class: 'field num', type: 'number', min: '1', max: String(LAST_BANK_START),
            title: 'Adresse du premier fader',
            onchange: () => this.setBankStart(Number(this.$bankAddr.value) || 1),
        });
        return h('div', { class: 'panel bank' }, [
            h('div', { class: 'panel-head' }, [
                h('span', { class: 'title', text: 'Faders' }),
                this.$bankRange,
                h('button', { class: 'btn icon', html: ICONS.left, title: 'Canaux précédents', 'aria-label': 'Canaux précédents',
                    onclick: () => this.setBankStart(this.bankStart - FADER_COUNT) }),
                h('button', { class: 'btn icon', html: ICONS.right, title: 'Canaux suivants', 'aria-label': 'Canaux suivants',
                    onclick: () => this.setBankStart(this.bankStart + FADER_COUNT) }),
                h('span', { class: 'dim', text: 'Adresse' }),
                this.$bankAddr,
                h('span', { class: 'grow' }),
                h('button', { class: 'btn', text: 'Mettre à zéro', title: 'Met à zéro les canaux de cette banque',
                    onclick: () => { for (let i = 0; i < FADER_COUNT; i++) this.out.set(this.universe, this.bankStart + i, 0); } }),
            ]),
            this.faders.el,
        ]);
    }

    // ── Actions ───────────────────────────────────────────────────────────
    setUniverse(n) {
        this.universe = clamp(n, 1, DMX_MAX_UNIVERSE);
        if (!this.prefs.universes.includes(this.universe)) this.prefs.universes.push(this.universe);
        this.prefs.universe = this.universe;
        this._savePrefs();
        this.$uniTitle.textContent = `Univers ${this.universe}`;
        this.monitor.setUniverse(this.universe);
        this.faders.invalidate();
        this._updateBankLabels();
        this._renderUniverses();
    }

    setBankStart(address) {
        this.bankStart = clamp(Math.round(address), 1, LAST_BANK_START);
        this.prefs.bankStart = this.bankStart;
        this._savePrefs();
        this.$bankAddr.value = String(this.bankStart);
        this.faders.setAddresses(this.bankStart);
        this.monitor.setBank(this.bankStart, this.bankStart + FADER_COUNT - 1);
        this._updateBankLabels();
    }

    _updateBankLabels() {
        if (!this.$bankRange) return;
        this.$bankRange.textContent = `U${this.universe} · ${pad3(this.bankStart)}–${pad3(this.bankStart + FADER_COUNT - 1)}`;
    }

    _addUniverse() {
        const shown = new Set([...this.prefs.universes, ...this.out.universes.keys()]);
        let n = 1;
        while (shown.has(n) && n < DMX_MAX_UNIVERSE) n++;
        if (shown.has(n)) return;
        this.setUniverse(n);
    }

    _setPercent(on) {
        this.prefs.percent = on;
        this._savePrefs();
        this._applyPercent();
    }

    _applyPercent() {
        const on = Boolean(this.prefs.percent);
        this.$raw.classList.toggle('on', !on);
        this.$pct.classList.toggle('on', on);
        this.monitor.setPercent(on);
        this.faders.setPercent(on);
    }

    _leave() {
        this._onLeave();
    }

    // ── Affichage ─────────────────────────────────────────────────────────
    _renderUniverses() {
        const numbers = [...new Set([...this.prefs.universes, ...this.out.universes.keys()])].sort((a, b) => a - b);
        this.$uniList.replaceChildren(...numbers.map((n) => {
            const data = this.out.universes.get(n);
            let used = 0;
            if (data) for (let i = 0; i < DMX_UNIVERSE_SIZE; i++) if (data[i]) used++;
            return h('div', { class: `uni-row${n === this.universe ? ' sel' : ''}`, onclick: () => this.setUniverse(n) }, [
                h('span', { text: `Univers ${n}` }),
                h('span', { class: `count mono${used ? ' live' : ''}`, text: String(used), title: 'Canaux non nuls' }),
            ]);
        }));
    }

    mount(parent) {
        parent.replaceChildren(this.el);
        const loop = () => {
            this._raf = requestAnimationFrame(loop);
            this._frame();
        };
        loop();
    }

    unmount() {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
    }

    _frame() {
        const c = this.client;
        const out = this.out;
        if (out.version !== this._lastVersion) {
            this._lastVersion = out.version;
            this.monitor.render(out.universes.get(this.universe));
            this.faders.render();
        }

        this.$room.textContent = c.roomId || '—';
        this.$status.textContent = STATUS_TEXT[c.status] || c.status;
        this.$led.className = `led ${c.status === 'joined' ? 'ok' : c.status === 'idle' ? 'bad' : 'warn'}`;
        this.$players.textContent = String(c.playerCount);
        const playing = Boolean(c.playback && c.playback.isPlaying);
        if (this._playing !== playing) {
            this._playing = playing;
            this.$play.innerHTML = playing ? ICONS.play : ICONS.pause;
            this.$play.classList.toggle('on', playing);
        }
        this.$clock.textContent = fmtClock(c.musicTime());
        this.$track.textContent = c.trackName || 'Aucun morceau';

        const now = performance.now();
        if (now - this._lastStats > 250) {
            this._lastStats = now;
            this._renderUniverses();
            this.$rtt.textContent = c.clock.rtt !== null ? `${Math.round(c.clock.rtt)} ms` : '';
            this.$rate.textContent = fmtRate(out.stats.outBytesPerSec);
            this.$rate.title = `${Math.round(out.stats.outPacketsPerSec)} trames/s en sortie · ${fmtRate(out.stats.inBytesPerSec)} reçus des autres régies`;
        }
    }
}
