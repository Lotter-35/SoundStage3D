/**
 * Controls — Central UI Orchestrator / Facade:
 * - Coordinates specialized sub-modules:
 *   - DspPanels: Audio DSP racks, tooltips, and resets
 *   - WeatherPanel: Ambiance, sky, and day/night cycle
 *   - PlaybackUI: Playback controls, waveform, playlists, and queue
 *   - HudBar: Top HUD buttons, level meters, position display, dropdowns
 * - Preserves 100% backward compatibility with main.js API.
 */
import { DSP_DEFAULTS } from '../config/dsp-defaults.js';
import { DspPanels } from './DspPanels.js';
import { PlaybackUI } from './PlaybackUI.js';
import { HudBar } from './HudBar.js';

export class Controls {
    constructor() {
        // ─── 1. Shared DSP & User State ───
        this.state = {
            input: {
                ...DSP_DEFAULTS.input,
                'measured-lufs': '--',
                'applied-gain': '0.0 dB',
            },
            sub:    { ...DSP_DEFAULTS.sub },
            mid:    { ...DSP_DEFAULTS.mid },
            top:    { ...DSP_DEFAULTS.top },
            fill:   { ...DSP_DEFAULTS.fill },
            master: { ...DSP_DEFAULTS.master },
            env:    { ...DSP_DEFAULTS.env },
            user:   { ...DSP_DEFAULTS.user },
            sine: {
                active: false,
                frequency: 440,
                volume: 50,
            }
        };

        // Load saved user preferences
        try {
            const savedUser = JSON.parse(localStorage.getItem('soundstage3d:user-settings'));
            if (savedUser && typeof savedUser === 'object') {
                if (typeof savedUser['local-volume'] === 'number') this.state.user['local-volume'] = savedUser['local-volume'];
                if (typeof savedUser['grass-distance'] === 'number') this.state.user['grass-distance'] = savedUser['grass-distance'];
                if (typeof savedUser['mouse-sensitivity'] === 'number') this.state.user['mouse-sensitivity'] = savedUser['mouse-sensitivity'];
            }
        } catch (_) {}

        // Multi-player flag
        this._suppressMpSend = false;

        // Callback references
        this._callbacks = {};

        // ─── 2. Instantiate Sub-Modules ───
        this.dspPanels = new DspPanels(this.state, {
            onMasterDsp:     (p, v) => this._callbacks.onMasterDsp && this._callbacks.onMasterDsp(p, v),
            onEnvDsp:        (p, v) => this._callbacks.onEnvDsp && this._callbacks.onEnvDsp(p, v),
            onUserDsp:       (p, v) => this._callbacks.onUserDsp && this._callbacks.onUserDsp(p, v),
            onGrassChange:   (v)    => this._callbacks.onGrassChange && this._callbacks.onGrassChange(v),
            onInputDsp:      (p, v) => this._callbacks.onInputDsp && this._callbacks.onInputDsp(p, v),
            onTopDsp:        (p, v) => this._callbacks.onTopDsp && this._callbacks.onTopDsp(p, v),
            onMidDsp:        (p, v) => this._callbacks.onMidDsp && this._callbacks.onMidDsp(p, v),
            onFillDsp:       (p, v) => this._callbacks.onFillDsp && this._callbacks.onFillDsp(p, v),
            onSubDsp:        (p, v) => this._callbacks.onSubDsp && this._callbacks.onSubDsp(p, v),
            onSineToggle:    (v)    => {
                this._updatePlayButtonState();
                if (this._callbacks.onSineToggle) this._callbacks.onSineToggle(v);
            },
            onSineFrequency: (v)    => this._callbacks.onSineFrequency && this._callbacks.onSineFrequency(v),
            onSineVolume:    (v)    => this._callbacks.onSineVolume && this._callbacks.onSineVolume(v),
            onResetAllDsp:   ()     => this._callbacks.onResetAllDsp && this._callbacks.onResetAllDsp(),
        });

        this.weatherPanel = null;

        this.playbackUI = new PlaybackUI({
            callbacks: {
                onSeek:                (t)       => this._callbacks.onSeek && this._callbacks.onSeek(t),
                onSkip:                (s)       => this._callbacks.onSkip && this._callbacks.onSkip(s),
                onPrev:                ()        => this._callbacks.onPrev && this._callbacks.onPrev(),
                onNext:                ()        => this._callbacks.onNext && this._callbacks.onNext(),
                onPlayPause:           ()        => this._callbacks.onPlayPause && this._callbacks.onPlayPause(),
                onShuffleToggle:       (sh)      => this._callbacks.onShuffleToggle && this._callbacks.onShuffleToggle(sh),
                onPlaylistLoad:        (id)      => this._callbacks.onPlaylistLoad && this._callbacks.onPlaylistLoad(id),
                onPlaylistSave:        (n, id, t)=> this._callbacks.onPlaylistSave && this._callbacks.onPlaylistSave(n, id, t),
                onPlaylistRename:      (id, n)   => this._callbacks.onPlaylistRename && this._callbacks.onPlaylistRename(id, n),
                onPlaylistDelete:      (id)      => this._callbacks.onPlaylistDelete && this._callbacks.onPlaylistDelete(id),
                onPlaylistRefresh:     ()        => this._callbacks.onPlaylistRefresh && this._callbacks.onPlaylistRefresh(),
                onPlaylistTrackAdd:    (tr)      => this._callbacks.onPlaylistTrackAdd && this._callbacks.onPlaylistTrackAdd(tr),
                onPlaylistTrackPlay:   (id, i, tr)=> this._callbacks.onPlaylistTrackPlay && this._callbacks.onPlaylistTrackPlay(id, i, tr),
                onPlaylistTracksChange:(id, tr)  => this._callbacks.onPlaylistTracksChange && this._callbacks.onPlaylistTracksChange(id, tr),
                onPlaylistFilesAdd:    (id, fs)  => this._callbacks.onPlaylistFilesAdd && this._callbacks.onPlaylistFilesAdd(id, fs),
                onPlaylistQueueAll:    (id)      => this._callbacks.onPlaylistQueueAll && this._callbacks.onPlaylistQueueAll(id),
                onManualQueueClear:    ()        => this._callbacks.onManualQueueClear && this._callbacks.onManualQueueClear(),
                onManualQueueRemove:   (idx)     => this._callbacks.onManualQueueRemove && this._callbacks.onManualQueueRemove(idx),
                onManualQueueReorder:  (f, t)    => this._callbacks.onManualQueueReorder && this._callbacks.onManualQueueReorder(f, t),
                onContextQueueSelect:  (idx)     => this._callbacks.onContextQueueSelect && this._callbacks.onContextQueueSelect(idx),
                onContextQueueRemove:  (idx)     => this._callbacks.onContextQueueRemove && this._callbacks.onContextQueueRemove(idx),
                onContextQueueReorder: (f, t)    => this._callbacks.onContextQueueReorder && this._callbacks.onContextQueueReorder(f, t),
                onQueueAdd:            (fs)      => this._callbacks.onQueueAdd && this._callbacks.onQueueAdd(fs),
                onPlayButtonStateChange: ()      => this._updatePlayButtonState(),
            }
        });

        this.hudBar = new HudBar({
            onEnter:          (f)     => this._callbacks.onEnter && this._callbacks.onEnter(f),
            onChangeMp3:      (f)     => this._callbacks.onChangeMp3 && this._callbacks.onChangeMp3(f),
            onPlayPause:      ()      => this._callbacks.onPlayPause && this._callbacks.onPlayPause(),
            onMicToggle:      ()      => this._callbacks.onMicToggle && this._callbacks.onMicToggle(),
            onCameraToggle:   ()      => this._callbacks.onCameraToggle && this._callbacks.onCameraToggle(),
            onInvite:         ()      => this._callbacks.onInvite && this._callbacks.onInvite(),
            onSpectrumToggle: (on)    => this._callbacks.onSpectrumToggle && this._callbacks.onSpectrumToggle(on),
            onHrtfToggle:     (on)    => this._callbacks.onHrtfToggle && this._callbacks.onHrtfToggle(on),
            onHrtfBrightness: (db)    => this._callbacks.onHrtfBrightness && this._callbacks.onHrtfBrightness(db),
            onConesToggle:    (b, v)  => this._callbacks.onConesToggle && this._callbacks.onConesToggle(b, v),
            onSineBtnClick:   ()      => {
                const vis = this.dspPanels.toggleSine();
                if (this.hudBar.sineBtn) this.hudBar.sineBtn.classList.toggle('active', vis);
            },
            onDspBtnClick:    ()      => {
                const vis = this.dspPanels.toggleDsp();
                if (this.hudBar.dspBtn) this.hudBar.dspBtn.classList.toggle('active', vis);
            },
            onResetAllDsp:    ()      => this.dspPanels.resetAllDsp(),
        });

        // ─── 3. Compatibility Aliases & Expositions ───
        this.guis = this.dspPanels.guis;
        this.guis.weather = null;

        // Common DOM element references
        this.overlay = this.hudBar.overlay;
        this.hud = this.hudBar.hud;
        this.enterBtn = this.hudBar.enterBtn;
        this.playBtn = this.hudBar.playBtn;
        this.changeMp3Btn = this.hudBar.changeMp3Btn;
        this.micBtn = this.hudBar.micBtn;
        this.dspBtn = this.hudBar.dspBtn;
        this.inviteBtn = this.hudBar.inviteBtn;
        this.mpStatusEl = this.hudBar.mpStatusEl;
        this.envBtn = null;
        this.positionDisplay = this.hudBar.positionDisplay;

        this._updatePlayButtonState();
    }

    get weatherState() {
        return this.weatherPanel ? this.weatherPanel.weatherState : null;
    }

    get _playlists() {
        return this.playbackUI._playlists;
    }
    set _playlists(val) {
        this.playbackUI._playlists = val;
    }

    _updatePlayButtonState() {
        const hasTrack = this.playbackUI._hasTrack;
        const isLocked = this.playbackUI._isPlaybackLocked;
        const isPlaying = this.playbackUI._isPlaying;
        const lockedText = this.playbackUI._lockedText;
        const canPlay = (hasTrack || Boolean(this.state?.sine?.active)) && !isLocked;

        if (this.hudBar.playBtn) {
            this.hudBar.playBtn.disabled = !canPlay;
            this.hudBar.playBtn.style.opacity = !canPlay ? '0.35' : '';
            this.hudBar.playBtn.style.pointerEvents = !canPlay ? 'none' : '';
            this.hudBar.playBtn.style.cursor = !canPlay ? 'not-allowed' : 'pointer';

            if (isLocked) {
                this.hudBar.playBtn.textContent = lockedText || '⏳ Chargement...';
                this.hudBar.playBtn.title = lockedText || 'Chargement en cours...';
            } else if (!hasTrack && !this.state?.sine?.active) {
                this.hudBar.playBtn.textContent = '▶ Play';
                this.hudBar.playBtn.title = 'Aucune musique chargée';
            } else {
                this.hudBar.playBtn.textContent = isPlaying ? '⏸ Pause' : '▶ Play';
                this.hudBar.playBtn.title = isPlaying ? 'Mettre en pause' : 'Lancer la lecture';
            }
        }
    }

    // ─── Playback & Playlist API ───
    setPlayState(isPlaying) {
        this.playbackUI.setPlayState(isPlaying);
        this._updatePlayButtonState();
        if (!isPlaying) {
            this.resetMeters();
        }
    }

    setHasTrack(hasTrack) {
        this.playbackUI.setHasTrack(hasTrack);
        this._updatePlayButtonState();
    }

    setTrackName(name = '') {
        const np = document.getElementById('now-playing');
        if (np) np.textContent = name;
    }

    setPlaybackLocked(locked, text = '') {
        this.playbackUI.setPlaybackLocked(locked, text);
        if (this.hudBar.changeMp3Btn) {
            this.hudBar.changeMp3Btn.disabled = Boolean(locked);
            this.hudBar.changeMp3Btn.style.opacity = locked ? '0.5' : '';
            this.hudBar.changeMp3Btn.style.pointerEvents = locked ? 'none' : '';
            this.hudBar.changeMp3Btn.style.cursor = locked ? 'not-allowed' : 'pointer';
        }
        if (this.hudBar.sineBtn) {
            this.hudBar.sineBtn.disabled = Boolean(locked);
            this.hudBar.sineBtn.style.opacity = locked ? '0.5' : '';
            this.hudBar.sineBtn.style.pointerEvents = locked ? 'none' : '';
        }
        this._updatePlayButtonState();
    }

    setAudioBuffer(buffer) {
        this.playbackUI.setAudioBuffer(buffer);
    }

    updatePlayback(currentTime, duration, isPlaying, trackName, hasTrackExplicit) {
        this.playbackUI.updatePlayback(currentTime, duration, isPlaying, trackName, hasTrackExplicit);
        this._updatePlayButtonState();
    }

    updateQueue(options) {
        return this.playbackUI.updateQueue(options);
    }

    updatePlaylists(playlists, activeId = null) {
        this.playbackUI.updatePlaylists(playlists, activeId);
    }

    markPlaylistSaved(playlistId) {
        this.playbackUI.markPlaylistSaved(playlistId);
    }

    triggerAutoSave() {
        this.playbackUI.triggerAutoSave();
    }

    notifyPlaylistTracksUpdated(playlistId) {
        this.playbackUI.notifyPlaylistTracksUpdated(playlistId);
    }

    getPlaylist(playlistId) {
        return this.playbackUI.getPlaylist(playlistId);
    }

    setShuffleState(isShuffle) {
        this.playbackUI.setShuffleState(isShuffle);
    }

    // ─── Environment / Weather API ───
    setEnvironmentManager(mgr) {
        if (this.weatherPanel) this.weatherPanel.setEnvironmentManager(mgr);
    }

    setAoCallback(cb) {
        if (this.weatherPanel) this.weatherPanel.setAoCallback(cb);
    }

    setPostProcessingCallback(cb) {
        if (this.weatherPanel) this.weatherPanel.setPostProcessingCallback(cb);
    }

    // ─── DSP Racks API ───
    applyDspFromServer(bus, param, value) {
        this.dspPanels.applyDspFromServer(bus, param, value);
    }

    applyFullDspState(serverDsp) {
        this.dspPanels.applyFullDspState(serverDsp);
    }

    resetBus(busKey) {
        this.dspPanels.resetBus(busKey);
    }

    resetSine() {
        this.dspPanels.resetSine();
        this._updatePlayButtonState();
    }

    resetAllDsp() {
        this.dspPanels.resetAllDsp();
    }

    setSineActive(active) {
        this.dspPanels.setSineActive(active);
        this._updatePlayButtonState();
    }

    updateInputAnalysis(data) {
        this.dspPanels.updateInputAnalysis(data);
    }

    // ─── HUD, Meters & Position API ───
    setCameraModeLabel(mode, isFlying = false) {
        this.hudBar.setCameraModeLabel(mode, isFlying);
    }

    setMicActive(active) {
        this.hudBar.setMicActive(active);
    }

    setGuestMode(isGuest) {
        this.hudBar.setGuestMode(isGuest);
    }

    setPlayerCount(count) {
        this.hudBar.setPlayerCount(count);
    }

    updateMpStatus(count) {
        this.setPlayerCount(count);
    }

    showHUD() {
        this.hudBar.showHUD();
    }

    showOverlay() {
        this.hudBar.showOverlay();
    }

    updatePosition(pos, fohDist) {
        this.hudBar.updatePosition(pos, fohDist);
    }

    resetMeters() {
        this.hudBar.resetMeters();
    }

    updateMeters(levels) {
        this.hudBar.updateMeters(levels);
    }

    // ─── Callbacks Registration ───
    onEnter(cb)                 { this._callbacks.onEnter = cb; }
    onPlayPause(cb)             { this._callbacks.onPlayPause = cb; }
    onChangeMp3(cb)             { this._callbacks.onChangeMp3 = cb; }
    onSeek(cb)                  { this._callbacks.onSeek = cb; }
    onSkip(cb)                  { this._callbacks.onSkip = cb; }
    onPrev(cb)                  { this._callbacks.onPrev = cb; }
    onNext(cb)                  { this._callbacks.onNext = cb; }
    onShuffleToggle(cb)         { this._callbacks.onShuffleToggle = cb; }

    onCameraToggle(cb)          { this._callbacks.onCameraToggle = cb; }
    onGrassChange(cb)           { this._callbacks.onGrassChange = cb; }
    onSpectrumToggle(cb)        { this._callbacks.onSpectrumToggle = cb; }
    onHrtfToggle(cb)            { this._callbacks.onHrtfToggle = cb; }
    onHrtfBrightness(cb)        { this._callbacks.onHrtfBrightness = cb; }
    onConesToggle(cb)           { this._callbacks.onConesToggle = cb; }
    onInvite(cb)                { this._callbacks.onInvite = cb; }

    onMasterDsp(cb)             { this._callbacks.onMasterDsp = cb; }
    onEnvDsp(cb)                { this._callbacks.onEnvDsp = cb; }
    onUserDsp(cb)               { this._callbacks.onUserDsp = cb; }
    onInputDsp(cb)              { this._callbacks.onInputDsp = cb; }
    onSubDsp(cb)                { this._callbacks.onSubDsp = cb; }
    onMidDsp(cb)                { this._callbacks.onMidDsp = cb; }
    onTopDsp(cb)                { this._callbacks.onTopDsp = cb; }
    onFillDsp(cb)               { this._callbacks.onFillDsp = cb; }
    onSineToggle(cb)            { this._callbacks.onSineToggle = cb; }
    onSineFrequency(cb)         { this._callbacks.onSineFrequency = cb; }
    onSineVolume(cb)            { this._callbacks.onSineVolume = cb; }
    onMicToggle(cb)             { this._callbacks.onMicToggle = cb; }
    onResetAllDsp(cb)           { this._callbacks.onResetAllDsp = cb; }

    onQueueSelect(cb)           { this._callbacks.onQueueSelect = cb; }
    onQueueReorder(cb)          { this._callbacks.onQueueReorder = cb; }
    onQueueAdd(cb)              { this._callbacks.onQueueAdd = cb; }
    onQueueRemove(cb)           { this._callbacks.onQueueRemove = cb; }

    onPlaylistLoad(cb)          { this._callbacks.onPlaylistLoad = cb; }
    onPlaylistSave(cb)          { this._callbacks.onPlaylistSave = cb; }
    onPlaylistRename(cb)        { this._callbacks.onPlaylistRename = cb; }
    onPlaylistDelete(cb)        { this._callbacks.onPlaylistDelete = cb; }
    onPlaylistRefresh(cb)       { this._callbacks.onPlaylistRefresh = cb; }
    onPlaylistTrackAdd(cb)      { this._callbacks.onPlaylistTrackAdd = cb; }
    onPlaylistTrackPlay(cb)     { this._callbacks.onPlaylistTrackPlay = cb; }
    onPlaylistTracksChange(cb)  { this._callbacks.onPlaylistTracksChange = cb; }
    onPlaylistFilesAdd(cb)      { this._callbacks.onPlaylistFilesAdd = cb; }
    onPlaylistQueueAll(cb)      { this._callbacks.onPlaylistQueueAll = cb; }

    onManualQueueClear(cb)      { this._callbacks.onManualQueueClear = cb; }
    onManualQueueRemove(cb)     { this._callbacks.onManualQueueRemove = cb; }
    onManualQueueReorder(cb)    { this._callbacks.onManualQueueReorder = cb; }
    onContextQueueSelect(cb)    { this._callbacks.onContextQueueSelect = cb; }
    onContextQueueRemove(cb)    { this._callbacks.onContextQueueRemove = cb; }
    onContextQueueReorder(cb)   { this._callbacks.onContextQueueReorder = cb; }
}
