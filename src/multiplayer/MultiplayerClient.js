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
        this.queue = [];         // current shared queue [{ id, name, url, uploadedBy }]
        this.currentQueueIndex = -1;
        this.currentTrack = null;
        this.manualQueue = [];   // priority manual queue
        this.contextQueue = [];  // context upcoming queue
        this.isShuffle = false;
        this.queueVersion = 0;
        this.playlists = [];     // saved playlists on server [{ id, name, trackCount, updatedAt }]
        this.players = [];       // current players list
        this.lightingState = null; // full Lighting & Ambiance snapshot from server
        this.connected = false;

        // Callbacks
        this._onDspUpdate = null;
        this._onLightingUpdate = null;
        this._onPlayersUpdate = null;
        this._onAudioTrackChanged = null;
        this._onQueueSync = null;
        this._onQueueStateSync = null;
        this._onPlaylistsSync = null;
        this._onRoomClosed = null;
        this._onRoomNotFound = null;
        this._onReady = null;    // called when room is created/joined
        this._onVoiceData = null; // (senderId, sampleRate, pcmInt16) => void
        this._cachedClientIdBytes = null;
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

            this._ws = new WebSocket(this._wsUrl);
            this._ws.binaryType = 'arraybuffer';

            this._ws.onopen = () => {
                this.connected = true;
                if (roomParam) {
                    this._send({ type: 'JOIN_ROOM', roomId: roomParam.toUpperCase() });
                } else {
                    this._send({ type: 'CREATE_ROOM' });
                }
            };

            this._ws.onmessage = async (event) => {
                let data = event.data;
                if (data instanceof Blob) {
                    data = await data.arrayBuffer();
                }

                // Paquet binaire : flux vocal en direct
                if (data instanceof ArrayBuffer) {
                    const bytes = new Uint8Array(data);
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

            this._ws.onclose = () => {
                this.connected = false;
                console.warn('[MP] WebSocket closed');
            };

            this._ws.onerror = (err) => {
                console.error('[MP] WebSocket error:', err);
                reject(err);
            };
        });
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
        this._onLightingUpdate = cb;
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

    /** Register callback when shared audio queue changes (legacy) */
    onQueueSync(cb) {
        this._onQueueSync = cb;
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

    /** Advance to next track in queue */
    sendQueueNext() {
        this._send({ type: 'QUEUE_NEXT' });
    }

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

    /** Reorder items in the shared queue */
    sendQueueReorder(fromIdx, toIdx) {
        this._send({ type: 'QUEUE_REORDER', fromIdx, toIdx });
    }

    /** Remove an item from the shared queue */
    sendQueueRemove(index) {
        this._send({ type: 'QUEUE_REMOVE', index });
    }

    /** Request to play a specific track from the shared queue */
    sendQueuePlayIndex(index) {
        this._send({ type: 'QUEUE_PLAY_INDEX', index });
    }

    /** Ask server to add a track from saved storage to the room queue */
    sendQueueAddTrack(track) {
        this._send({ type: 'QUEUE_ADD_TRACK', track });
    }

    /** Ask server to add multiple tracks from a playlist to the room queue */
    sendQueueAddTracks(tracks) {
        this._send({ type: 'QUEUE_ADD_TRACKS', tracks });
    }

    /** Register callback for playlist list updates from server */
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

    _handleMessage(msg, resolve, reject) {
        switch (msg.type) {

            case 'ROOM_CREATED':
                this.role = 'master';
                this.isFirstInRoom = true;
                this.roomId = msg.roomId;
                this.clientId = msg.clientId;
                this.color = msg.color || '#00d2ff';
                this.publicIp = msg.publicIp || this.publicIp;
                this.webPort = msg.webPort || 8067;
                this.audioPort = msg.audioPort || 8068;
                this.dspState = msg.dspState;
                this.lightingState = msg.lightingState || null;
                this.playback = msg.playback;
                this.sine = msg.sine;
                this.trackName = msg.trackName;
                this.audioUrl = msg.audioUrl;
                this.queue = msg.queue || [];
                this.currentQueueIndex = msg.currentQueueIndex !== undefined ? msg.currentQueueIndex : -1;
                this.currentTrack = msg.currentTrack || null;
                this.manualQueue = msg.manualQueue || [];
                this.contextQueue = msg.contextQueue || [];
                this.isShuffle = Boolean(msg.isShuffle);
                this.queueVersion = msg.queueVersion || 1;
                this.loadedPlaylistId = msg.loadedPlaylistId || null;
                this.loadedPlaylistName = msg.loadedPlaylistName || null;
                this.playlists = msg.playlists || [];
                this.players = msg.players;
                console.log(`[MP] Room created: ${this.roomId} (id: ${this.clientId}, color: ${this.color}, public IP: ${this.publicIp || 'unknown'})`);
                if (this._onPlaylistsSync && this.playlists.length > 0) this._onPlaylistsSync(this.playlists);
                if (this._onQueueStateSync) {
                    this._onQueueStateSync({
                        currentTrack: this.currentTrack,
                        manualQueue: this.manualQueue,
                        contextQueue: this.contextQueue,
                        isShuffle: this.isShuffle,
                        queueVersion: this.queueVersion,
                        loadedPlaylistId: this.loadedPlaylistId,
                        loadedPlaylistName: this.loadedPlaylistName,
                    });
                }
                if (resolve) resolve(this);
                break;

            case 'ROOM_JOINED':
                this.role = 'guest';
                this.isFirstInRoom = false;
                this.roomId = msg.roomId;
                this.clientId = msg.clientId;
                this.color = msg.color || '#00d2ff';
                this.publicIp = msg.publicIp || this.publicIp;
                this.webPort = msg.webPort || 8067;
                this.audioPort = msg.audioPort || 8068;
                this.dspState = msg.dspState;
                this.lightingState = msg.lightingState || null;
                this.playback = msg.playback;
                this.sine = msg.sine;
                this.trackName = msg.trackName;
                this.audioUrl = msg.audioUrl;
                this.queue = msg.queue || [];
                this.currentQueueIndex = msg.currentQueueIndex !== undefined ? msg.currentQueueIndex : -1;
                this.currentTrack = msg.currentTrack || null;
                this.manualQueue = msg.manualQueue || [];
                this.contextQueue = msg.contextQueue || [];
                this.isShuffle = Boolean(msg.isShuffle);
                this.queueVersion = msg.queueVersion || 1;
                this.loadedPlaylistId = msg.loadedPlaylistId || null;
                this.loadedPlaylistName = msg.loadedPlaylistName || null;
                this.playlists = msg.playlists || [];
                this.players = msg.players;
                console.log(`[MP] Joined room: ${this.roomId} (id: ${this.clientId}, color: ${this.color}, public IP: ${this.publicIp || 'unknown'})`);
                if (this._onPlaylistsSync && this.playlists.length > 0) this._onPlaylistsSync(this.playlists);
                if (this._onQueueStateSync) {
                    this._onQueueStateSync({
                        currentTrack: this.currentTrack,
                        manualQueue: this.manualQueue,
                        contextQueue: this.contextQueue,
                        isShuffle: this.isShuffle,
                        queueVersion: this.queueVersion,
                        loadedPlaylistId: this.loadedPlaylistId,
                        loadedPlaylistName: this.loadedPlaylistName,
                    });
                }
                if (resolve) resolve(this);
                break;

            case 'ROOM_NOT_FOUND':
                console.warn(`[MP] Room not found: ${msg.roomId}`);
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
                if (this._onLightingUpdate) {
                    this._onLightingUpdate(msg);
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
                this.queueVersion = msg.queueVersion || 1;
                if (msg.loadedPlaylistId !== undefined) this.loadedPlaylistId = msg.loadedPlaylistId;
                if (msg.loadedPlaylistName !== undefined) this.loadedPlaylistName = msg.loadedPlaylistName;
                if (msg.queue) this.queue = msg.queue;
                if (msg.currentIndex !== undefined) this.currentQueueIndex = msg.currentIndex;
                console.log(`[MP] Queue state synced (v${this.queueVersion}): manual=${this.manualQueue.length}, context=${this.contextQueue.length}, shuffle=${this.isShuffle}`);
                if (this._onQueueStateSync) {
                    this._onQueueStateSync(msg);
                }
                break;
            }

            case 'QUEUE_SYNC': {
                this.queue = msg.queue || [];
                this.currentQueueIndex = msg.currentIndex !== undefined ? msg.currentIndex : -1;
                if (msg.loadedPlaylistId !== undefined) this.loadedPlaylistId = msg.loadedPlaylistId;
                if (msg.loadedPlaylistName !== undefined) this.loadedPlaylistName = msg.loadedPlaylistName;
                console.log(`[MP] Queue synced: ${this.queue.length} tracks (current index: ${this.currentQueueIndex})`);
                if (this._onQueueSync) {
                    this._onQueueSync(this.queue, this.currentQueueIndex, msg.addedTrack, msg.loadedPlaylistId, msg.loadedPlaylistName, Boolean(msg.isNewPlaylistLoad));
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
                // Heartbeat response — no-op
                break;

            case 'ERROR':
                console.error('[MP] Server error:', msg.message);
                break;

            default:
                console.warn('[MP] Unknown message type:', msg.type);
        }
    }
}
