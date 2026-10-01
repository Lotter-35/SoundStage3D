/**
 * MultiplayerClient.js — Frontend WebSocket client for SoundStage3D multiplayer.
 *
 * Usage:
 *   const mp = new MultiplayerClient('ws://localhost:8081');
 *   await mp.connect();          // auto-detects ?room= in URL
 *   mp.role                      // 'master' | 'guest'
 *   mp.roomId                    // e.g. 'ABC123'
 *   mp.onDspUpdate((bus, param, value) => { ... });
 *   mp.onPlayersUpdate((players) => { ... });
 *   mp.sendDsp(bus, param, value);
 *   mp.sendPosition(x, y, z, rotY);
 */
import { ServerClock } from './ServerClock.js?v=2';
import { DMX_PACKET, decodeDmxPacket } from '../dmx/DmxProtocol.js';
import { ildaLive, ILDA_LIVE_PACKET } from '../laser2/ilda/IldaLive.js';

export class MultiplayerClient {
    constructor(wsUrl = 'ws://localhost:8068') {
        this._wsUrl = wsUrl;
        this.httpUrl = wsUrl.replace(/^ws(s?):/, 'http$1:');
        this.publicIp = null;
        this.webPort = 8067;
        this.audioPort = 8068;
        this._ws = null;
        this.role = null;        // 'master' | 'guest'
        this.isFirstInRoom = false;
        this.roomId = null;
        this.clientId = null;    // own server-assigned client ID
        this.dspState = null;    // full DSP snapshot from server on connect
        this.playback = null;
        this.sine = null;
        this.trackName = null;
        this.audioUrl = null;
        this.currentTrack = null;
        this.manualQueue = [];   // priority manual queue
        this.contextQueue = [];  // context upcoming queue
        this.isShuffle = false;
        this.queueVersion = 0;
        this.playlists = [];     // saved playlists on server [{ id, name, trackCount, updatedAt }]
        this.players = [];       // current players list
        this.lightingState = null; // full Lighting & Ambiance snapshot from server
        this.lightingVersion = 1;
        this.connected = false;

        // Reconnexion automatique (serveur redémarré, coupure réseau) : même salle, sans recharger la page
        this._reconnectTimer = null;
        this._reconnectAttempt = 0;
        this._onConnectionState = null;   // (état : 'lost' | 'restored' | 'failed') => void
        this._resumeInfo = null;          // () => { playback, sweepTime } envoyé au serveur en revenant
        this._onResumed = null;           // (message ROOM_CREATED / ROOM_JOINED) => void

        // Callbacks
        this._onDspUpdate = null;
        this._onLightingUpdate = null;
        this._lightingUpdateListeners = [];
        this._onHeartbeatSync = null;
        this._heartbeatListeners = [];
        this._lightingFullSyncListeners = [];
        this._onPlayersUpdate = null;
        this._onAudioTrackChanged = null;
        this._onQueueStateSync = null;
        this._onPlaylistsSync = null;
        this._onIldaIndex = null;
        this._onRoomClosed = null;
        this._onRoomNotFound = null;
        this._onReady = null;    // called when room is created/joined
        this._onVoiceData = null; // (senderId, sampleRate, pcmInt16) => void
        this._cachedClientIdBytes = null;
        this._dmxListeners = [];  // (paquet DMX décodé) => void — trames de la régie lumière
        /** Horloge du serveur (datation des trames DMX) */
        this.clock = new ServerClock((m) => this._send(m));
    }

    /** Heure du serveur estimée (ms) */
    serverNow() {
        return this.clock.now();
    }

    /** Liste des projecteurs de la scène, pour la régie (voir src/dmx/PatchReporter.js) */
    sendPatchReport(fixtures) {
        this._send({ type: 'PATCH_REPORT', fixtures });
    }

    /**
     * Demande de la régie : valeurs DMX équivalentes aux réglages actuels de projecteurs
     * @param {(keys: string[]) => object} cb  renvoie { clé: { universe, address, values } }
     */
    onFixtureStateRequest(cb) {
        this._onFixtureStateRequest = cb;
    }

    /** Trames DMX reçues de la régie (déjà décodées, voir src/dmx/DmxProtocol.js) */
    onDmx(cb) {
        this._dmxListeners.push(cb);
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Connect to the WebSocket server and auto-detect room role.
     * - If URL has ?room=XXXX → JOIN that room as guest
     * - Otherwise → CREATE a new room as master
     * Returns a promise that resolves when the room is ready.
     */
    connect() {
        return new Promise((resolve, reject) => {
            const params = new URLSearchParams(window.location.search);
            const roomParam = params.get('room');
            this._openSocket(() => {
                if (roomParam) {
                    this._send({ type: 'JOIN_ROOM', roomId: roomParam.toUpperCase() });
                } else {
                    this._send({ type: 'CREATE_ROOM' });
                }
            }, resolve, reject);
        });
    }

    /** État de la connexion : 'lost' (reconnexion en cours), 'restored', 'failed' (salle introuvable) */
    onConnectionState(cb) {
        this._onConnectionState = cb;
    }

    /** Informations envoyées au serveur en revenant : { playback: { trackId, position, isPlaying }, sweepTime } */
    onResumeInfo(cb) {
        this._resumeInfo = cb;
    }

    /** Salle retrouvée après une reconnexion (nouvel identifiant de joueur, rôle, réglages son…) */
    onResumed(cb) {
        this._onResumed = cb;
    }

    /**
     * Ouvre la connexion. onOpen envoie le premier message (création, entrée ou reprise de salle) ;
     * resolve / reject : promesse de la première connexion (null pendant une reconnexion).
     */
    _openSocket(onOpen, resolve, reject) {
        const ws = new WebSocket(this._wsUrl);
        this._ws = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            this.connected = true;
            this.clock.start();
            onOpen();
        };

        ws.onmessage = async (event) => {
            let data = event.data;
            if (data instanceof Blob) {
                data = await data.arrayBuffer();
            }

            // Paquet binaire : trame DMX de la régie ou flux vocal en direct
            if (data instanceof ArrayBuffer) {
                const bytes = new Uint8Array(data);
                if (bytes.length > 0 && bytes[0] === DMX_PACKET) {
                    const packet = decodeDmxPacket(bytes);
                    if (packet) {
                        for (const cb of this._dmxListeners) {
                            try { cb(packet); } catch (e) { console.error('[MP] DMX', e); }
                        }
                    }
                    return;
                }
                // Image ILDA live (nouveaux lasers)
                if (bytes.length > 0 && bytes[0] === ILDA_LIVE_PACKET) {
                    ildaLive.receive(bytes);
                    return;
                }
                if (bytes.length >= 6 && bytes[0] === 0x01) {
                    const idLen = bytes[1];
                    const pad = (idLen % 2 === 1) ? 1 : 0;
                    const pcmOffset = 6 + idLen + pad;
                    if (bytes.length >= pcmOffset) {
                        const senderId = new TextDecoder().decode(bytes.subarray(2, 2 + idLen));
                        const view = new DataView(data);
                        const sampleRate = view.getUint32(2 + idLen, true);
                        const pcmSamples = new Int16Array(data, pcmOffset, (data.byteLength - pcmOffset) >> 1);
                        if (this._onVoiceData) {
                            this._onVoiceData(senderId, sampleRate, pcmSamples);
                        }
                    }
                }
                return;
            }

            let msg;
            try {
                msg = JSON.parse(data);
            } catch {
                return;
            }
            this._handleMessage(msg, resolve, reject);
        };

        ws.onclose = () => {
            if (this._ws !== ws) return;
            const wasInRoom = this.connected && this.roomId;
            this.connected = false;
            this.clock.stop();
            console.warn('[MP] WebSocket closed');
            // Joueur dans une salle : reconnexion automatique (même salle, sans recharger la page)
            if (this.roomId) {
                if (wasInRoom && this._onConnectionState) this._onConnectionState('lost');
                this._scheduleReconnect();
            }
        };

        ws.onerror = (err) => {
            if (!this.roomId) console.error('[MP] WebSocket error:', err);
            if (reject) reject(err);
        };
    }

    /** Nouvelle tentative : 1 s, puis de plus en plus espacées (5 s au plus), tant que le joueur reste dans le jeu */
    _scheduleReconnect() {
        if (this._reconnectTimer) return;
        const delay = [1000, 1500, 2500, 4000][this._reconnectAttempt] || 5000;
        this._reconnectAttempt++;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._openSocket(() => {
                let info = {};
                try { info = (this._resumeInfo && this._resumeInfo()) || {}; } catch (e) { console.warn('[MP] Reprise :', e); }
                this._send({ type: 'RESUME_ROOM', roomId: this.roomId, playback: info.playback || null, sweepTime: info.sweepTime });
            }, null, null);
        }, delay);
    }

    /** Send a DSP change (master only — server will reject if guest) */
    sendDsp(bus, param, value) {
        this._send({ type: 'DSP_CHANGE', bus, param, value });
    }

    /** Send a lighting or ambiance change to sync with others */
    sendLighting(data) {
        this._send({ type: 'LIGHTING_CHANGE', ...data });
    }

    /** Send current player position and animation state (throttled by caller) */
    sendPosition(x, y, z, rotY = 0, anim = 'idle', onGround = true, isFlying = false) {
        this._send({ type: 'PLAYER_POS', x, y, z, rotY, anim, onGround, isFlying });
    }

    /** Register callback for DSP updates received from server */
    onDspUpdate(cb) {
        this._onDspUpdate = cb;
    }

    /** Register callback for lighting/ambiance updates */
    onLightingUpdate(cb) {
        if (!this._lightingUpdateListeners) this._lightingUpdateListeners = [];
        this._lightingUpdateListeners.push(cb);
        this._onLightingUpdate = cb;
    }

    /** Register callback for 2-second periodic server heartbeat sync (audio + sweep + lighting) */
    onHeartbeatSync(cb) {
        if (!this._heartbeatListeners) this._heartbeatListeners = [];
        this._heartbeatListeners.push(cb);
        this._onHeartbeatSync = cb;
    }

    /** Register callback for full lighting state synchronization */
    onLightingFullSync(cb) {
        if (!this._lightingFullSyncListeners) this._lightingFullSyncListeners = [];
        this._lightingFullSyncListeners.push(cb);
    }

    /** Request full lighting state from server */
    requestLightingState() {
        this._send({ type: 'GET_LIGHTING_STATE' });
    }

    /** Register callback for player list updates */
    onPlayersUpdate(cb) {
        this._onPlayersUpdate = cb;
    }

    /**
     * Send a one-shot action to all other players (e.g. play/pause, seek, sine toggle).
     * The sender applies it locally first; others receive and apply via onAction().
     * @param {string} action - action name ('play_pause', 'seek', 'sine_toggle', ...)
     * @param {Object} [data]  - extra payload
     */
    sendAction(action, data = {}) {
        this._send({ type: 'SYNC_ACTION', action, data });
    }

    /** Register callback for incoming actions from other players */
    onAction(cb) { this._onAction = cb; }

    /**
     * Upload an audio file to the multiplayer server for this room.
     * The server broadcasts QUEUE_SYNC / AUDIO_TRACK_CHANGED to all clients (unless addToQueue is false).
     * @param {File|Blob} file
     * @param {string} [trackId]
     * @param {boolean} [addToQueue=true]
     */
    async uploadAudioFile(file, trackId = null, addToQueue = true) {
        const httpBase = this.httpUrl || `http://${window.location.hostname || 'localhost'}:8068`;
        let url = `${httpBase}/upload?name=${encodeURIComponent(file.name || 'track.mp3')}&clientId=${encodeURIComponent(this.clientId || '')}`;
        if (this.roomId) {
            url += `&room=${encodeURIComponent(this.roomId)}`;
        }
        if (trackId) {
            url += `&trackId=${encodeURIComponent(trackId)}`;
        }
        if (!addToQueue) {
            url += `&addToQueue=false`;
        }
        const headers = {
            'Content-Type': file.type || 'audio/mpeg',
            'X-Client-Id': this.clientId || '',
            'X-File-Name': encodeURIComponent(file.name || 'track.mp3'),
            'X-Add-To-Queue': addToQueue ? 'true' : 'false',
        };
        if (this.roomId) {
            headers['X-Room-Id'] = this.roomId;
        }
        if (trackId) {
            headers['X-Track-Id'] = trackId;
        }
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: file,
        });
        return res.json();
    }

    /** Register callback when structured queue state syncs (two-tier Spotify queue) */
    onQueueStateSync(cb) {
        this._onQueueStateSync = cb;
    }

    /** Add track to manual priority queue */
    sendManualQueueAdd(track) {
        this._send({ type: 'QUEUE_MANUAL_ADD', track });
    }

    /** Add multiple tracks to manual priority queue */
    sendManualQueueAddBatch(tracks) {
        this._send({ type: 'QUEUE_MANUAL_ADD_BATCH', tracks });
    }

    /** Remove track from manual priority queue */
    sendManualQueueRemove(index) {
        this._send({ type: 'QUEUE_MANUAL_REMOVE', index });
    }

    /** Reorder manual priority queue */
    sendManualQueueReorder(fromIdx, toIdx) {
        this._send({ type: 'QUEUE_MANUAL_REORDER', fromIdx, toIdx });
    }

    /** Clear manual priority queue */
    sendManualQueueClear() {
        this._send({ type: 'QUEUE_MANUAL_CLEAR' });
    }

    /** Remove track from context queue ("À suivre") */
    sendContextQueueRemove(index) {
        this._send({ type: 'QUEUE_CONTEXT_REMOVE', index });
    }

    /** Reorder context queue ("À suivre") */
    sendContextQueueReorder(fromIdx, toIdx) {
        this._send({ type: 'QUEUE_CONTEXT_REORDER', fromIdx, toIdx });
    }

    /** Select and play a track from context queue ("À suivre") */
    sendContextQueueSelect(index) {
        this._send({ type: 'QUEUE_CONTEXT_SELECT', index });
    }

    /** Toggle shuffle mode and sync context queue */
    sendShuffleToggle(isShuffle, contextQueue = null) {
        this._send({ type: 'QUEUE_SHUFFLE_TOGGLE', isShuffle, contextQueue });
    }

    /** Advance to next track in queue (auto = fin naturelle du morceau : le serveur applique « répéter le morceau ») */
    sendQueueNext(auto = false) {
        this._send({ type: 'QUEUE_NEXT', auto: Boolean(auto) });
    }

    /** Mode répéter partagé par toute la salle : 'off' | 'all' | 'one' */
    sendRepeatSet(mode) {
        this._send({ type: 'QUEUE_REPEAT_SET', mode });
    }

    /** Supprimer définitivement des morceaux du serveur (et de toutes les playlists) */
    sendTrackDelete(trackIds) {
        this._send({ type: 'TRACK_DELETE', trackIds });
    }

    /** Durée mesurée localement d'un morceau dont le serveur ne connaît pas la durée */
    sendTrackDuration(trackId, duration) {
        this._send({ type: 'TRACK_DURATION', trackId, duration });
    }

    /** Action de lecture refusée par le serveur (ex. pause pendant le chargement d'un morceau) */
    onActionRejected(cb) { this._onActionRejected = cb; }

    /** Message d'erreur du serveur */
    onServerError(cb) { this._onServerError = cb; }

    /** Go to previous track or restart current track */
    sendQueuePrev() {
        this._send({ type: 'QUEUE_PREV' });
    }

    /** Periodic lightweight heartbeat check to verify queue sync */
    sendQueueCheckSync(version) {
        this._send({ type: 'QUEUE_CHECK_SYNC', version });
    }

    /** Request full queue state snapshot from server */
    requestQueueState() {
        this._send({ type: 'QUEUE_STATE_GET' });
    }

    /** Register callback for playlist list updates from server */
    /** Bibliothèque ILDA du serveur modifiée (fichier ajouté, modifié ou supprimé) */
    onIldaIndex(cb) {
        this._onIldaIndex = cb;
    }

    onPlaylistsSync(cb) {
        this._onPlaylistsSync = cb;
    }

    /** Ask server to save or update a playlist */
    sendPlaylistSave(name, playlistId = null, tracks = null) {
        this._send({ type: 'PLAYLIST_SAVE', name, playlistId, tracks });
    }

    /** Ask server to load a saved playlist into the room queue */
    sendPlaylistLoad(playlistId, startIndex = 0, shuffle = false) {
        this._send({ type: 'PLAYLIST_LOAD', playlistId, startIndex, shuffle });
    }

    /** Ask server to rename a playlist */
    sendPlaylistRename(playlistId, newName) {
        this._send({ type: 'PLAYLIST_RENAME', playlistId, newName });
    }

    /** Ask server to delete a playlist */
    sendPlaylistDelete(playlistId) {
        this._send({ type: 'PLAYLIST_DELETE', playlistId });
    }

    /** Request playlist list from server */
    requestPlaylists() {
        this._send({ type: 'PLAYLISTS_GET' });
    }

    /** Register callback when a new audio track has been uploaded to the room */
    onAudioTrackChanged(cb) {
        this._onAudioTrackChanged = cb;
    }

    /** Notify server that this client has loaded the audio track and is ready for simultaneous playback */
    sendTrackBufferReady() {
        this._send({ type: 'TRACK_BUFFER_READY' });
    }

    /** Register callback for simultaneous playback start triggered by server */
    onStartPlaybackSync(cb) {
        this._onStartPlaybackSync = cb;
    }

    /**
     * Send real-time microphone audio chunk to the room.
     * @param {number} sampleRate
     * @param {Int16Array} pcmInt16Array
     */
    sendVoiceData(sampleRate, pcmInt16Array) {
        if (!this._ws || this._ws.readyState !== WebSocket.OPEN || !this.roomId) return;
        if (!this._cachedClientIdBytes) {
            this._cachedClientIdBytes = new TextEncoder().encode(this.clientId || '');
        }
        const idBytes = this._cachedClientIdBytes;
        const pad = (idBytes.length % 2 === 1) ? 1 : 0;
        const pcmOffset = 6 + idBytes.length + pad;
        const totalLen = pcmOffset + pcmInt16Array.byteLength;
        const packet = new Uint8Array(totalLen);
        packet[0] = 0x01; // Voice packet type
        packet[1] = idBytes.length;
        packet.set(idBytes, 2);
        const view = new DataView(packet.buffer);
        view.setUint32(2 + idBytes.length, sampleRate, true);
        packet.set(new Uint8Array(pcmInt16Array.buffer, pcmInt16Array.byteOffset, pcmInt16Array.byteLength), pcmOffset);
        this._ws.send(packet.buffer);
    }

    /** Register callback for incoming real-time voice stream from other players */
    onVoiceData(cb) {
        this._onVoiceData = cb;
    }

    /** Send current playback state to server (master only → relayed to guests) */
    sendPlaybackSync(currentTime, isPlaying) {
        this._send({ type: 'PLAYBACK_SYNC', currentTime, isPlaying });
    }

    /** Register callback for playback sync received from server (guests only) */
    onPlaybackSync(cb) {
        this._onPlaybackSync = cb;
    }

    /** Register callback for room closure (master left) */
    onRoomClosed(cb) {
        this._onRoomClosed = cb;
    }

    /** Register callback when this client tried to join but room not found */
    onRoomNotFound(cb) {
        this._onRoomNotFound = cb;
    }

    /** Generate the shareable invite URL for this room */
    getInviteUrl() {
        const url = new URL(window.location.href);
        // If host is running on localhost/127.0.0.1 and server provided publicIp, use publicIp
        if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && this.publicIp) {
            url.hostname = this.publicIp;
            url.port = this.webPort ? String(this.webPort) : '8067';
        }
        url.searchParams.set('room', this.roomId);
        // Remove any hash
        url.hash = '';
        return url.toString();
    }

    disconnect() {
        if (this._ws) this._ws.close();
    }

    // ─── Private Methods ──────────────────────────────────────────────────────

    _send(data) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            this._ws.send(JSON.stringify(data));
        }
    }

    /** Salle retrouvée après une reconnexion */
    _resumedRoom(msg) {
        this._reconnectAttempt = 0;
        console.log(`[MP] Reconnecté à ${this.roomId} (${this.role})`);
        if (this._onResumed) {
            try { this._onResumed(msg); } catch (e) { console.error('[MP] Reprise', e); }
        }
        if (this._onConnectionState) this._onConnectionState('restored');
    }

    _handleMessage(msg, resolve, reject) {
        switch (msg.type) {

            case 'ROOM_CREATED':
                this.role = 'master';
                this.isFirstInRoom = true;
                this.roomId = msg.roomId;
                this.persistent = Boolean(msg.persistent); // salle permanente : monde sauvegardé sur le serveur
                this.clientId = msg.clientId;
                this.color = msg.color || '#00d2ff';
                this.publicIp = msg.publicIp || this.publicIp;
                this.webPort = msg.webPort || 8067;
                this.audioPort = msg.audioPort || 8068;
                this.dspState = msg.dspState;
                this.lightingState = msg.lightingState || null;
                this.lightingVersion = msg.lightingVersion || 1;
                this.playback = msg.playback;
                this.sine = msg.sine;
                this.trackName = msg.trackName;
                this.audioUrl = msg.audioUrl;
                this.currentTrack = msg.currentTrack || null;
                this.manualQueue = msg.manualQueue || [];
                this.contextQueue = msg.contextQueue || [];
                this.isShuffle = Boolean(msg.isShuffle);
                this.queueVersion = msg.queueVersion || 1;
                this.loadedPlaylistId = msg.loadedPlaylistId || null;
                this.loadedPlaylistName = msg.loadedPlaylistName || null;
                this.playlists = msg.playlists || [];
                this.players = msg.players;
                this.serverTime = msg.serverTime || Date.now();
                this.sweepTime = msg.sweepTime || 0;
                console.log(`[MP] Room created: ${this.roomId} (id: ${this.clientId}, color: ${this.color}, public IP: ${this.publicIp || 'unknown'})`);
                // L'adresse de la page n'est jamais modifiée : le lien d'invitation est généré à la demande (getInviteUrl)
                if (this._onPlaylistsSync && this.playlists.length > 0) this._onPlaylistsSync(this.playlists);
                if (this._onQueueStateSync) {
                    this._onQueueStateSync({
                        currentTrack: this.currentTrack,
                        manualQueue: this.manualQueue,
                        contextQueue: this.contextQueue,
                        isShuffle: this.isShuffle,
                        repeatMode: msg.repeatMode || 'off',
                        queueVersion: this.queueVersion,
                        loadedPlaylistId: this.loadedPlaylistId,
                        loadedPlaylistName: this.loadedPlaylistName,
                    });
                }
                if (resolve) resolve(this);
                if (msg.resumed) this._resumedRoom(msg);
                break;

            case 'ROOM_JOINED':
                this.role = 'guest';
                this.isFirstInRoom = false;
                this.roomId = msg.roomId;
                this.persistent = Boolean(msg.persistent); // salle permanente : monde sauvegardé sur le serveur
                this.clientId = msg.clientId;
                this.color = msg.color || '#00d2ff';
                this.publicIp = msg.publicIp || this.publicIp;
                this.webPort = msg.webPort || 8067;
                this.audioPort = msg.audioPort || 8068;
                this.dspState = msg.dspState;
                this.lightingState = msg.lightingState || null;
                this.lightingVersion = msg.lightingVersion || 1;
                this.playback = msg.playback;
                this.sine = msg.sine;
                this.trackName = msg.trackName;
                this.audioUrl = msg.audioUrl;
                this.currentTrack = msg.currentTrack || null;
                this.manualQueue = msg.manualQueue || [];
                this.contextQueue = msg.contextQueue || [];
                this.isShuffle = Boolean(msg.isShuffle);
                this.queueVersion = msg.queueVersion || 1;
                this.loadedPlaylistId = msg.loadedPlaylistId || null;
                this.loadedPlaylistName = msg.loadedPlaylistName || null;
                this.playlists = msg.playlists || [];
                this.players = msg.players;
                this.serverTime = msg.serverTime || Date.now();
                this.sweepTime = msg.sweepTime || 0;
                console.log(`[MP] Joined room: ${this.roomId} (id: ${this.clientId}, color: ${this.color}, public IP: ${this.publicIp || 'unknown'})`);
                // L'adresse de la page n'est jamais modifiée : le lien d'invitation est généré à la demande (getInviteUrl)
                if (this._onPlaylistsSync && this.playlists.length > 0) this._onPlaylistsSync(this.playlists);
                if (this._onQueueStateSync) {
                    this._onQueueStateSync({
                        currentTrack: this.currentTrack,
                        manualQueue: this.manualQueue,
                        contextQueue: this.contextQueue,
                        isShuffle: this.isShuffle,
                        repeatMode: msg.repeatMode || 'off',
                        queueVersion: this.queueVersion,
                        loadedPlaylistId: this.loadedPlaylistId,
                        loadedPlaylistName: this.loadedPlaylistName,
                    });
                }
                if (resolve) resolve(this);
                if (msg.resumed) this._resumedRoom(msg);
                break;

            case 'ROOM_NOT_FOUND':
                console.warn(`[MP] Room not found: ${msg.roomId}`);
                // Reconnexion impossible (salle inconnue du serveur) : on arrête d'essayer
                if (!resolve && this.roomId) {
                    if (this._onConnectionState) this._onConnectionState('failed');
                    this.roomId = null;
                    if (this._ws) this._ws.close();
                    break;
                }
                if (this._onRoomNotFound) this._onRoomNotFound(msg.roomId);
                if (reject) reject(new Error(`Room not found: ${msg.roomId}`));
                break;

            case 'DSP_UPDATE':
                // Update local DSP state snapshot
                if (this.dspState && this.dspState[msg.bus]) {
                    this.dspState[msg.bus][msg.param] = msg.value;
                }
                if (this._onDspUpdate) {
                    this._onDspUpdate(msg.bus, msg.param, msg.value);
                }
                break;

            case 'LIGHTING_UPDATE':
            case 'LIGHTING_CHANGE':
                if (msg.version) this.lightingVersion = msg.version;
                if (this._lightingUpdateListeners && this._lightingUpdateListeners.length > 0) {
                    for (const cb of this._lightingUpdateListeners) cb(msg);
                } else if (this._onLightingUpdate) {
                    this._onLightingUpdate(msg);
                }
                break;

            case 'LIGHTING_FULL_SYNC':
                this.lightingState = msg.lightingState || null;
                this.lightingVersion = msg.version || this.lightingVersion;
                if (this._lightingFullSyncListeners) {
                    for (const cb of this._lightingFullSyncListeners) cb(msg);
                }
                break;

            case 'HEARTBEAT_SYNC':
                if (msg.lightingVersion) this.lightingVersion = Math.max(this.lightingVersion || 1, msg.lightingVersion);
                if (this._heartbeatListeners && this._heartbeatListeners.length > 0) {
                    for (const cb of this._heartbeatListeners) cb(msg);
                } else if (this._onHeartbeatSync) {
                    this._onHeartbeatSync(msg);
                }
                break;

            case 'PLAYERS_UPDATE':
                this.players = msg.players;
                if (Array.isArray(msg.players)) {
                    const me = msg.players.find(p => p.id === this.clientId);
                    if (me && me.role) {
                        this.role = me.role;
                    }
                }
                if (this._onPlayersUpdate) {
                    this._onPlayersUpdate(msg.players);
                }
                break;

            case 'PEER_JOINED':
                console.log(`[MP] Peer joined: ${msg.peerId}`);
                break;

            case 'PEER_LEFT':
                console.log(`[MP] Peer left: ${msg.peerId}`);
                break;

            case 'ROOM_CLOSED':
                console.warn('[MP] Room closed by server:', msg.reason);
                if (this._onRoomClosed) this._onRoomClosed(msg.reason);
                break;

            case 'SYNC_ACTION':
                if (this._onAction) this._onAction(msg.action, msg.data ?? {});
                break;

            case 'SYNC_ACTION_REJECTED':
                if (this._onActionRejected) this._onActionRejected(msg.action, msg.reason);
                break;

            case 'PLAYBACK_SYNC':
                if (this._onPlaybackSync) {
                    this._onPlaybackSync(msg.currentTime, msg.isPlaying, msg.serverTimestamp);
                }
                break;

            case 'QUEUE_STATE_SYNC': {
                this.currentTrack = msg.currentTrack || null;
                this.manualQueue = msg.manualQueue || [];
                this.contextQueue = msg.contextQueue || [];
                this.isShuffle = Boolean(msg.isShuffle);
                this.repeatMode = msg.repeatMode || 'off';
                this.queueVersion = msg.queueVersion || 1;
                if (msg.loadedPlaylistId !== undefined) this.loadedPlaylistId = msg.loadedPlaylistId;
                if (msg.loadedPlaylistName !== undefined) this.loadedPlaylistName = msg.loadedPlaylistName;
                console.log(`[MP] Queue state synced (v${this.queueVersion}): manual=${this.manualQueue.length}, context=${this.contextQueue.length}, shuffle=${this.isShuffle}`);
                if (this._onQueueStateSync) {
                    this._onQueueStateSync(msg);
                }
                break;
            }

            case 'PLAYLISTS_SYNC': {
                this.playlists = msg.playlists || [];
                console.log(`[MP] Playlists synced: ${this.playlists.length} playlists`);
                if (this._onPlaylistsSync) {
                    this._onPlaylistsSync(this.playlists, msg.savedPlaylistId, msg.savedPlaylistName, msg.authorId);
                }
                break;
            }

            case 'AUDIO_TRACK_CHANGED': {
                this.trackName = msg.name;
                this.audioUrl = msg.url;
                this.trackId = msg.trackId || null;
                console.log(`[MP] Audio track changed: "${msg.name}" (id: ${msg.trackId || 'none'})`);
                if (this._onAudioTrackChanged) {
                    this._onAudioTrackChanged(msg.name, msg.url, msg.uploadedBy, msg.trackId);
                }
                break;
            }

            case 'START_PLAYBACK_SYNC': {
                console.log(`[MP] Start playback synchronized at ${msg.startTime} (offset: ${msg.startOffset})`);
                if (this._onStartPlaybackSync) {
                    this._onStartPlaybackSync(msg.startTime, msg.startOffset || 0, msg.trackName);
                }
                break;
            }

            case 'PONG':
                this.clock.onPong(msg);
                break;

            case 'ILDA_INDEX':
                if (this._onIldaIndex) this._onIldaIndex(msg.index);
                break;

            case 'FIXTURE_STATE_REQUEST':
                if (this._onFixtureStateRequest) {
                    let states = {};
                    try { states = this._onFixtureStateRequest(msg.keys || []); } catch (e) { console.error('[MP] FIXTURE_STATE', e); }
                    this._send({ type: 'FIXTURE_STATE', regieId: msg.regieId, requestId: msg.requestId, states });
                }
                break;

            case 'ERROR':
                console.error('[MP] Server error:', msg.message);
                if (this._onServerError) this._onServerError(msg.message);
                break;

            default:
                console.warn('[MP] Unknown message type:', msg.type);
        }
    }
}
