/**
 * DeskView.js — pupitre de la régie
 *
 *   barre du haut : show (sauvegarde), salle, connexion, joueurs, horloge musicale, tempo,
 *                   avance des trames, débit, grand master et blackout
 *   gauche        : groupes, univers
 *   centre        : plan de la scène · liste des projecteurs (patch) · patterns · live · moniteur DMX
 *                   + sélection rapide et prise / reprise de main
 *   bas           : faders — canaux nommés de la sélection, ou canaux bruts d'un univers
 *
 * Raccourcis : B = blackout, T = tap tempo, Espace = lancer / arrêter le pattern affiché,
 * 1…8 (Live) = lancer la scène, Échap = rien de sélectionné, Ctrl+A = tout sélectionner.
 */

import { h, ICONS, fmtClock, fmtRate, pad3 } from './dom.js';
import { DmxMonitor } from './DmxMonitor.js';
import { FaderBank } from './FaderBank.js';
import { PlanView } from './PlanView.js';
import { PatchView } from './PatchView.js';
import { GroupsPanel } from './GroupsPanel.js';
import { PatternsView } from './PatternsView.js';
import { LiveView } from './LiveView.js';
import { ShowBar } from './ShowBar.js';
import { channelsOf, KINDS, KIND_ORDER } from '../fixtureTypes.js';
import { takeControl, releaseControl } from '../FixtureControl.js';
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

const VIEWS = [['plan', 'Plan'], ['patch', 'Patch'], ['patterns', 'Patterns'], ['live', 'Live'], ['dmx', 'Moniteur DMX']];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Nom de canal sans ses précisions entre parenthèses (libellé de fader) */
const shortName = (name) => name.replace(/\s*\(.*\)\s*$/, '').trim() || name;

export class DeskView {
    /**
     * @param {object} o
     * @param {import('../RegieClient.js').RegieClient} o.client
     * @param {import('../DmxOutput.js').DmxOutput} o.out
     * @param {import('../FixtureStore.js').FixtureStore} o.store
     * @param {import('../ShowStore.js').ShowStore} o.shows
     * @param {import('../TempoClock.js').TempoClock} o.tempo
     * @param {import('../PatternEngine.js').PatternEngine} o.engine
     * @param {object} o.prefs          réglages de la page (sauvegardés par main.js)
     * @param {() => void} o.savePrefs
     * @param {() => void} o.onLeave    retour au choix de la salle
     */
    constructor({ client, out, store, shows, tempo, engine, prefs, savePrefs, onLeave }) {
        this.client = client;
        this.out = out;
        this.store = store;
        this.shows = shows;
        this.tempo = tempo;
        this.engine = engine;
        this.prefs = prefs;
        this._savePrefs = savePrefs;
        this._onLeave = onLeave;
        this._raf = 0;
        this._lastVersion = -1;
        this._lastStats = 0;
        this._storeVersion = -1;

        this.universe = clamp(prefs.universe | 0 || 1, 1, DMX_MAX_UNIVERSE);
        this.bankStart = clamp(prefs.bankStart | 0 || 1, 1, LAST_BANK_START);
        this.view = VIEWS.some(([id]) => id === prefs.view) ? prefs.view : 'plan';
        this.bankMode = prefs.bankMode === 'raw' ? 'raw' : 'selection';
        if (!Array.isArray(prefs.universes) || prefs.universes.length === 0) prefs.universes = [1, 2, 3, 4];

        this.monitor = new DmxMonitor({ onPick: (a) => { this.setBankMode('raw'); this.setBankStart(a); } });
        this.faders = new FaderBank();
        this.plan = new PlanView({ store, out });
        this.patch = new PatchView({ store });
        this.groups = new GroupsPanel({ store });
        this.showBar = new ShowBar({ shows, tempo });
        this.patterns = new PatternsView({
            store, shows, engine, prefs, savePrefs,
            now: () => client.clock.now(),
            playTime: () => client.clock.now() + out.lookahead,
        });
        this.live = new LiveView({
            shows, engine, tempo,
            now: () => client.clock.now(),
            playTime: () => client.clock.now() + out.lookahead,
        });

        this.el = h('div', { class: 'desk' }, [this._buildTopBar(), this._buildSide(), this._buildCenter(), this._buildBank()]);
        this._applyPercent();
        this.setUniverse(this.universe);
        this.setBankStart(this.bankStart);
        this.setView(this.view);
        this.setBankMode(this.bankMode);

        this._onKey = (e) => this._key(e);
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
        this.$gmValue = h('span', { class: 'mono gm-value' });
        this.$gm = h('input', {
            class: 'gm', type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(this.out.master * 100)),
            title: 'Grand master : intensité de tous les projecteurs patchés',
            oninput: () => { this.out.master = Number(this.$gm.value) / 100; },
        });
        this.$bo = h('button', {
            class: 'btn bo', text: 'Blackout', title: 'Éteint tous les projecteurs patchés (touche B)',
            onclick: () => { this.out.blackout = !this.out.blackout; },
        });
        return h('div', { class: 'topbar' }, [
            h('span', { class: 'brand', text: 'Régie' }),
            h('span', { class: 'sep' }),
            this.showBar.showEl,
            h('span', { class: 'sep' }),
            h('span', { class: 'group' }, [h('span', { class: 'dim', text: 'Salle' }), this.$room,
                h('button', { class: 'btn', text: 'Changer', onclick: () => this._onLeave() })]),
            h('span', { class: 'sep' }),
            h('span', { class: 'group' }, [this.$led, this.$status, this.$rtt]),
            h('span', { class: 'group' }, [h('span', { class: 'dim', text: 'Joueurs' }), this.$players]),
            h('span', { class: 'sep' }),
            h('span', { class: 'group' }, [this.$play, this.$clock, this.$track]),
            h('span', { class: 'grow' }),
            this.showBar.tempoEl,
            h('span', { class: 'sep' }),
            h('span', { class: 'group' }, [h('span', { class: 'dim', text: 'Avance' }), this.$lookahead, h('span', { class: 'dim', text: 'ms' })]),
            h('span', { class: 'group' }, [h('span', { class: 'dim', text: 'Sortie' }), this.$rate]),
            h('span', { class: 'sep' }),
            h('span', { class: 'group' }, [h('span', { class: 'dim', text: 'Master' }), this.$gm, this.$gmValue]),
            this.$bo,
        ]);
    }

    _buildSide() {
        this.$uniList = h('div', { class: 'uni-list' });
        return h('div', { class: 'side' }, [
            this.groups.el,
            h('div', { class: 'panel universes' }, [
                h('div', { class: 'panel-head' }, [
                    h('span', { class: 'title', text: 'Univers' }),
                    h('span', { class: 'grow' }),
                    h('button', { class: 'btn', text: 'Ajouter', onclick: () => this._addUniverse() }),
                ]),
                this.$uniList,
            ]),
        ]);
    }

    _buildCenter() {
        this.$viewBtns = new Map();
        const seg = h('span', { class: 'seg' }, VIEWS.map(([id, label]) => {
            const b = h('button', { text: label, onclick: () => this.setView(id) });
            this.$viewBtns.set(id, b);
            return b;
        }));
        const quick = h('span', { class: 'quick' }, [
            h('button', { class: 'btn', text: 'Tout', title: 'Tout sélectionner (Ctrl+A)', onclick: () => this.store.selectKind(null) }),
            ...KIND_ORDER.map((k) => h('button', {
                class: 'btn', text: KINDS[k].plural, title: `Sélectionner tous les ${KINDS[k].plural.toLowerCase()} (Maj : ajouter)`,
                onclick: (e) => this.store.selectKind(k, e.shiftKey),
            })),
            h('button', { class: 'btn', text: 'Aucun', title: 'Rien de sélectionné (Échap)', onclick: () => this.store.clearSelection() }),
        ]);
        this.$uniTitle = h('span', { class: 'mono dim' });
        this.$selCount = h('span', { class: 'dim' });
        this.$take = h('button', { class: 'btn', text: 'Prendre la main', title: 'La régie pilote la sélection (la lumière actuelle est reprise telle quelle)', onclick: () => this._take() });
        this.$release = h('button', { class: 'btn', text: 'Rendre la main', title: 'Les projecteurs sélectionnés suivent de nouveau leurs panneaux dans le jeu', onclick: () => this._release() });
        this.$centerBody = h('div', { class: 'center-body' });
        return h('div', { class: 'panel center' }, [
            h('div', { class: 'panel-head' }, [seg, this.$uniTitle, quick, h('span', { class: 'grow' }), this.$selCount, this.$take, this.$release]),
            this.$centerBody,
        ]);
    }

    _buildBank() {
        this.$modeSel = h('button', { text: 'Sélection', onclick: () => this.setBankMode('selection') });
        this.$modeRaw = h('button', { text: 'Canaux', onclick: () => this.setBankMode('raw') });
        this.$bankInfo = h('span', { class: 'dim' });
        this.$bankRange = h('span', { class: 'mono' });
        this.$bankAddr = h('input', {
            class: 'field num', type: 'number', min: '1', max: String(LAST_BANK_START),
            title: 'Adresse du premier fader',
            onchange: () => this.setBankStart(Number(this.$bankAddr.value) || 1),
        });
        this.$rawTools = h('span', { class: 'group' }, [
            this.$bankRange,
            h('button', { class: 'btn icon', html: ICONS.left, title: 'Canaux précédents', 'aria-label': 'Canaux précédents',
                onclick: () => this.setBankStart(this.bankStart - FADER_COUNT) }),
            h('button', { class: 'btn icon', html: ICONS.right, title: 'Canaux suivants', 'aria-label': 'Canaux suivants',
                onclick: () => this.setBankStart(this.bankStart + FADER_COUNT) }),
            h('span', { class: 'dim', text: 'Adresse' }),
            this.$bankAddr,
        ]);
        this.$raw = h('button', { text: '0–255', onclick: () => this._setPercent(false) });
        this.$pct = h('button', { text: '%', onclick: () => this._setPercent(true) });
        return h('div', { class: 'panel bank' }, [
            h('div', { class: 'panel-head' }, [
                h('span', { class: 'title', text: 'Faders' }),
                h('span', { class: 'seg' }, [this.$modeSel, this.$modeRaw]),
                this.$bankInfo,
                this.$rawTools,
                h('span', { class: 'grow' }),
                h('span', { class: 'seg' }, [this.$raw, this.$pct]),
                h('button', { class: 'btn', text: 'Mettre à zéro', title: 'Met à zéro les faders affichés',
                    onclick: () => { for (const d of this.faders._defs) d.set(0); } }),
            ]),
            this.faders.el,
        ]);
    }

    // ── Vues ──────────────────────────────────────────────────────────────
    setView(id) {
        this.view = id;
        this.prefs.view = id;
        this._savePrefs();
        for (const [k, b] of this.$viewBtns) b.classList.toggle('on', k === id);
        const el = { plan: this.plan.el, patch: this.patch.el, patterns: this.patterns.el, live: this.live.el }[id] || this.monitor.el;
        this.$centerBody.replaceChildren(el);
        this.$uniTitle.style.display = id === 'dmx' ? '' : 'none';
        if (id === 'plan') this.plan.invalidate();
        this.monitor.invalidate();
        this._lastVersion = -1;
    }

    setBankMode(mode) {
        this.bankMode = mode;
        this.prefs.bankMode = mode;
        this._savePrefs();
        this.$modeSel.classList.toggle('on', mode === 'selection');
        this.$modeRaw.classList.toggle('on', mode === 'raw');
        this.$rawTools.style.display = mode === 'raw' ? '' : 'none';
        this.$bankInfo.style.display = mode === 'selection' ? '' : 'none';
        this._rebuildFaders();
    }

    _rebuildFaders() {
        if (this.bankMode === 'raw') {
            const defs = [];
            for (let i = 0; i < FADER_COUNT; i++) {
                const a = this.bankStart + i;
                defs.push({
                    label: pad3(a),
                    title: `Univers ${this.universe} · canal ${a}`,
                    get: () => this.out.get(this.universe, a),
                    set: (v) => this.out.set(this.universe, a, v),
                });
            }
            this.faders.setFaders(defs, false);
        } else {
            const defs = this._selectionFaders();
            this.faders.setFaders(defs, true);
            const n = this.store.selection.size;
            this.$bankInfo.textContent = n === 0
                ? 'Sélectionne des projecteurs sur le plan ou dans le patch'
                : `${n} projecteur${n > 1 ? 's' : ''} · ${defs.length} canaux`;
        }
        this._lastVersion = -1;
    }

    /**
     * Un fader par nom de canal présent dans la sélection ; il règle ce canal sur tous les
     * projecteurs sélectionnés qui l'ont (16 bits : octet fin réglé avec, 0…255 → 0…65535)
     */
    _selectionFaders() {
        const byName = new Map();
        for (const f of this.store.selected()) {
            for (const c of channelsOf(f)) {
                if (c.fine) continue;
                let d = byName.get(c.name);
                if (!d) {
                    d = { name: c.name, targets: [] };
                    byName.set(c.name, d);
                }
                d.targets.push({ u: f.universe, a: c.address, fa: c.fineAddress || 0 });
            }
        }
        const out = this.out;
        return [...byName.values()].map((d) => ({
            label: shortName(d.name),
            title: `${d.name} · ${d.targets.length} projecteur${d.targets.length > 1 ? 's' : ''}`,
            get: () => out.get(d.targets[0].u, d.targets[0].a),
            set: (v) => {
                for (const t of d.targets) {
                    out.set(t.u, t.a, v);
                    if (t.fa) out.set(t.u, t.fa, v);
                }
            },
        }));
    }

    // ── Actions ───────────────────────────────────────────────────────────
    setUniverse(n) {
        this.universe = clamp(n, 1, DMX_MAX_UNIVERSE);
        if (!this.prefs.universes.includes(this.universe)) this.prefs.universes.push(this.universe);
        this.prefs.universe = this.universe;
        this._savePrefs();
        this.$uniTitle.textContent = `Univers ${this.universe}`;
        this.monitor.setUniverse(this.universe);
        this._updateBankLabels();
        if (this.bankMode === 'raw') this._rebuildFaders();
        this._renderUniverses();
        this._lastVersion = -1;
    }

    setBankStart(address) {
        this.bankStart = clamp(Math.round(address), 1, LAST_BANK_START);
        this.prefs.bankStart = this.bankStart;
        this._savePrefs();
        this.$bankAddr.value = String(this.bankStart);
        this.monitor.setBank(this.bankStart, this.bankStart + FADER_COUNT - 1);
        this._updateBankLabels();
        if (this.bankMode === 'raw') this._rebuildFaders();
    }

    _updateBankLabels() {
        if (!this.$bankRange) return;
        this.$bankRange.textContent = `U${this.universe} · ${pad3(this.bankStart)}–${pad3(this.bankStart + FADER_COUNT - 1)}`;
    }

    _addUniverse() {
        const shown = new Set(this._universeNumbers());
        let n = 1;
        while (shown.has(n) && n < DMX_MAX_UNIVERSE) n++;
        if (shown.has(n)) return;
        this.setUniverse(n);
        this.setView('dmx');
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

    async _take() {
        const fixtures = this.store.selected();
        if (fixtures.length === 0) return;
        this.$take.textContent = 'Capture…';
        try {
            await takeControl({ client: this.client, out: this.out, fixtures });
        } finally {
            this.$take.textContent = 'Prendre la main';
        }
    }

    _release() {
        releaseControl({ client: this.client, fixtures: this.store.selected() });
    }

    _key(e) {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (t && (t.tagName === 'SELECT' || t.tagName === 'BUTTON') && (e.key === ' ' || e.key === 'Enter')) return;
        const plain = !(e.ctrlKey || e.metaKey || e.altKey);
        if ((e.key === 'b' || e.key === 'B') && plain) {
            this.out.blackout = !this.out.blackout;
            e.preventDefault();
        } else if ((e.key === 't' || e.key === 'T') && plain) {
            this.showBar.tap();
            e.preventDefault();
        } else if (plain && this.view === 'live' && /^Digit[1-8]$/.test(e.code) && !this.live.editing) {
            // Touches de la rangée des chiffres (même place en AZERTY et en QWERTY)
            this.live.launchScene(Number(e.code.slice(5)) - 1);
            e.preventDefault();
        } else if (e.key === ' ' && plain && this.view === 'patterns' && this.patterns.pattern) {
            this.engine.toggle(this.patterns.pattern.id, this.client.clock.now() + this.out.lookahead);
            e.preventDefault();
        } else if (e.key === 'Escape') {
            this.store.clearSelection();
        } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
            this.store.selectKind(null);
            e.preventDefault();
        }
    }

    // ── Affichage ─────────────────────────────────────────────────────────
    _universeNumbers() {
        const fixtureUniverses = this.store.fixtures.map((f) => f.universe);
        return [...new Set([...this.prefs.universes, ...this.out.universes.keys(), ...fixtureUniverses])].sort((a, b) => a - b);
    }

    _renderUniverses() {
        const counts = new Map();
        for (const f of this.store.fixtures) counts.set(f.universe, (counts.get(f.universe) || 0) + 1);
        this.$uniList.replaceChildren(...this._universeNumbers().map((n) => {
            const nFix = counts.get(n) || 0;
            return h('div', {
                class: `uni-row${n === this.universe ? ' sel' : ''}`,
                onclick: () => { this.setUniverse(n); this.setView('dmx'); },
            }, [
                h('span', { text: `Univers ${n}` }),
                h('span', { class: `count mono${nFix ? ' live' : ''}`, text: nFix ? `${nFix} proj.` : '—', title: 'Projecteurs patchés dans cet univers' }),
            ]);
        }));
    }

    _onStoreChange() {
        const n = this.store.selection.size;
        const sel = this.store.selected();
        const controlled = sel.filter((f) => f.control).length;
        this.$selCount.textContent = n === 0 ? 'Aucune sélection' : `${n} sélectionné${n > 1 ? 's' : ''}${controlled ? ` · ${controlled} à la régie` : ''}`;
        this.$take.disabled = n === 0 || controlled === n;
        this.$release.disabled = controlled === 0;
        if (this.bankMode === 'selection') this._rebuildFaders();
        this._renderUniverses();
        this.plan.invalidate();
    }

    mount(parent) {
        parent.replaceChildren(this.el);
        document.addEventListener('keydown', this._onKey);
        const loop = (now) => {
            this._raf = requestAnimationFrame(loop);
            this._frame(now || performance.now());
        };
        loop(performance.now());
    }

    unmount() {
        cancelAnimationFrame(this._raf);
        this._raf = 0;
        document.removeEventListener('keydown', this._onKey);
        this.plan.dispose();
        this.patterns.dispose();
        this.showBar.dispose();
    }

    _frame(now) {
        const c = this.client;
        const out = this.out;
        if (this.store.version !== this._storeVersion) {
            this._storeVersion = this.store.version;
            this._onStoreChange();
        }
        if (out.version !== this._lastVersion) {
            this._lastVersion = out.version;
            if (this.view === 'dmx') this.monitor.render(out.output(this.universe));
            this.faders.render();
            this.plan.invalidate();
        }
        if (this.view === 'plan') this.plan.frame(now);
        else if (this.view === 'patch') this.patch.frame();
        else if (this.view === 'patterns') this.patterns.frame();
        else if (this.view === 'live') this.live.frame();
        this.groups.frame();
        this.showBar.frame();

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
        this.$bo.classList.toggle('on', out.blackout);
        this.$gmValue.textContent = `${Math.round(out.master * 100)} %`;

        if (now - this._lastStats > 250) {
            this._lastStats = now;
            this.$rtt.textContent = c.clock.rtt !== null ? `${Math.round(c.clock.rtt)} ms` : '';
            this.$rate.textContent = fmtRate(out.stats.outBytesPerSec);
            this.$rate.title = `${Math.round(out.stats.outPacketsPerSec)} trames/s en sortie · ${fmtRate(out.stats.inBytesPerSec)} reçus des autres régies`;
        }
    }
}
