/**
 * main.js — Entry point. Orchestrates Three.js scene, audio engine, and render loop.
 */
import * as THREE from 'three';

import { createStage } from './scene/stage.js?v=180';
import { Listener } from './scene/listener.js?v=154';
import { createHitboxVisualizer } from './scene/collision.js?v=154';
import { createSkybox, updateSkybox } from './scene/skybox.js';
import { createVegetation, updateVegetation, setGrassQuality } from './scene/vegetation.js?v=2';

import { AudioEngine } from './audio/audioEngine.js?v=96';
import { Crossover } from './audio/crossover.js';
import { SpeakerSystem } from './audio/speakers.js';
import { createSaturation, createCompressor } from './audio/effects.js';
import { SineGenerator } from './audio/sineGenerator.js';
import { InputStage } from './audio/inputStage.js';
import { MicrophoneInput } from './audio/microphone.js';
import { VoiceReceiver } from './audio/voiceReceiver.js';

import { Controls } from './ui/controls.js?v=158';
import { AmbiancePanel } from './ui/AmbiancePanel.js?v=179';
import { makeDraggable } from './ui/draggable.js';
import { DSP_DEFAULTS } from './config/dsp-defaults.js';
import { saveLastAudio, loadLastAudio } from './audio/audioStorage.js';
import { setupAudioDebugProbes } from './audio/debugProbes.js';
import { MultiplayerClient } from './multiplayer/MultiplayerClient.js?v=148';
import { DanceManager } from './scene/DanceManager.js';
import { loadStageSpeakers } from './scene/speakerModels.js?v=180';
import { LaserManager } from './laser/LaserManager.js?v=179';

// Nettoyage des clés orphelines / doublons du localStorage
try {
    localStorage.removeItem('soundstage3d:master-uncapped-fps');
    localStorage.removeItem('soundstage3d:master-mouse-sensitivity');
    localStorage.removeItem('soundstage_dance_loop_settings');
} catch (e) {}

// ─── Three.js setup ──────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

// Build 3D stage
const { coneContainer, coneGroups, dirLight, lights } = createStage(scene);
if (dirLight && dirLight.shadow) {
    const maxTex = renderer.capabilities.maxTextureSize || 4096;
    const shadowRes = Math.min(4096, maxTex);
    dirLight.shadow.mapSize.set(shadowRes, shadowRes);
}

// ─── Skybox ───────────────────────────────────────────────────────
// Fond couleur fallback (avant que le GLB soit prêt)
scene.background = new THREE.Color(0x87ceeb);
let skybox = null;
skybox = await createSkybox(scene);

// ─── Vegetation (instanced grass) ────────────────────────────────
await createVegetation(scene);

// ─── Animations Catalog (chargement initial de dances.json) ─────
await DanceManager.refreshCatalog(true);

// ─── Stage Speakers (Subwoofers GLB & Line Arrays GLB) ──────────
await loadStageSpeakers(scene);

// ─── Listener (FPS controls + 3D Animated Character) ─────────────
const listener = new Listener(camera, document.body, scene);

// ─── Ambiance & Éclairage 3D ─────────────────────────────────────
const ambiancePanel = new AmbiancePanel({
    scene,
    camera,
    renderer,
    listener,
    initialLights: lights,
    skybox,
});

// ─── Laser System ─────────────────────────────────────────────────
const laserManager = new LaserManager({ scene, renderer, camera });
ambiancePanel.setLaserManager(laserManager);

// ─── Audio ───────────────────────────────────────────────────────
const audioEngine = new AudioEngine();
let inputStage = null;
let crossover = null;
let speakerSystem = null;
let sineGenerator = null;
let micInput = null;
let voiceReceiver = null;
let _musicWasPlayingBeforeSine = false;
let _currentAudioFileName = '';
let effects = null; // keep reference to prevent GC
let audioReady = false;
let _isSwitchingTrack = false;
let _isNewTrackStarting = false;

// ─── UI ──────────────────────────────────────────────────────────
const controls = new Controls();
controls.ambiancePanel = ambiancePanel;

// ─── Playback & Spotify Queue State ──────────────────────────────
let _isShuffle = false;
try {
    _isShuffle = localStorage.getItem('soundstage3d:playback-shuffle') === 'true';
} catch (_) {}
controls.setShuffleState(_isShuffle);

const _localAudioFileCache = new Map();
const _decodedAudioBuffers = new Map(); // id or name -> AudioBuffer
const _decodingPromises = new Map();   // id or name -> Promise<AudioBuffer>

let _currentPlayingTrack = null; // { id, name, file, url, uploadedBy, loading }
let _manualQueue = [];           // Priority queue ("À suivre dans la file d'attente"), NEVER affected by shuffle
let _contextPlaylistId = null;
let _currentActivePlaylistId = null;
let _contextPlaylistName = '';
let _contextPlaylistTracks = []; // Full original list of tracks from active playlist context
let _contextQueue = [];          // Upcoming tracks from context ("À suivre"), affected by shuffle
let _localQueueVersion = 0;

// Array shuffle helper (Fisher-Yates) — random without repeats
function shuffleArray(arr) {
    const res = [...arr];
    for (let i = res.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [res[i], res[j]] = [res[j], res[i]];
    }
    return res;
}

// Restore context queue tracks to their original sequence in the active playlist
function restoreContextQueueOrder(contextQueue, playlistTracks) {
    if (!playlistTracks || playlistTracks.length === 0) return [...contextQueue];
    const orderMap = new Map();
    playlistTracks.forEach((t, idx) => {
        if (t.id) orderMap.set(t.id, idx);
        if (t.name) orderMap.set(t.name, idx);
    });
    return [...contextQueue].sort((a, b) => {
        const idxA = orderMap.has(a.id) ? orderMap.get(a.id) : (orderMap.has(a.name) ? orderMap.get(a.name) : 999999);
        const idxB = orderMap.has(b.id) ? orderMap.get(b.id) : (orderMap.has(b.name) ? orderMap.get(b.name) : 999999);
        return idxA - idxB;
    });
}

// Convert a track from playlist or raw format to a standard queue item
function formatPlaylistTrackForQueue(t) {
    if (!t) return null;
    const isDecoded = _decodedAudioBuffers.has(t.id) || _decodedAudioBuffers.has(t.name);
    return {
        id: t.id,
        name: t.name,
        url: t.url || (t.id ? `/audio/track/${t.id}` : null),
        uploadedBy: t.uploadedBy,
        file: _localAudioFileCache.get(t.id) || _localAudioFileCache.get(t.name) || null,
        loading: !isDecoded
    };
}

// Find index of a track in a playlist by ID or name
function findTrackIndexInPlaylist(track, playlistTracks) {
    if (!track || !playlistTracks || playlistTracks.length === 0) return -1;
    if (track.id) {
        const idx = playlistTracks.findIndex(t => t.id && t.id === track.id);
        if (idx !== -1) return idx;
    }
    if (track.name) {
        const idx = playlistTracks.findIndex(t => t.name && t.name === track.name);
        if (idx !== -1) return idx;
    }
    return -1;
}

function syncQueueToUI() {
    controls.updateQueue({
        currentTrack: _currentPlayingTrack,
        manualQueue: _manualQueue,
        contextQueue: _contextQueue,
        contextName: _contextPlaylistName,
        contextPlaylistId: _contextPlaylistId,
        isShuffle: _isShuffle
    });
}

function updateQueueUI() {
    syncQueueToUI();
}

function setBufferOnEngine(buf) {
    if (typeof audioEngine.setAudioBuffer === 'function') {
        audioEngine.setAudioBuffer(buf || null);
    } else {
        audioEngine.buffer = buf || null;
    }
    audioEngine.startOffset = 0;
    if (controls && typeof controls.setAudioBuffer === 'function') {
        controls.setAudioBuffer(buf || null);
    }
    controls.setHasTrack(Boolean(buf));
}

async function getOrDecodeAudioBuffer(file, trackId = null) {
    if (!file) return null;
    const key = trackId || file.name;
    if (_decodedAudioBuffers.has(key)) return _decodedAudioBuffers.get(key);
    if (_decodedAudioBuffers.has(file.name)) return _decodedAudioBuffers.get(file.name);

    if (_decodingPromises.has(key)) {
        return await _decodingPromises.get(key);
    }
    if (_decodingPromises.has(file.name)) {
        return await _decodingPromises.get(file.name);
    }

    const promise = (async () => {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            const ctx = audioEngine.ctx || new AudioCtx();
            const arrayBuf = await file.arrayBuffer();
            const audioBuf = await ctx.decodeAudioData(arrayBuf);
            if (trackId) _decodedAudioBuffers.set(trackId, audioBuf);
            _decodedAudioBuffers.set(file.name, audioBuf);
            console.log(`[Audio] Pre-decoded track in memory: ${file.name}`);

            const allTracks = [_currentPlayingTrack, ..._manualQueue, ..._contextQueue].filter(Boolean);
            for (const item of allTracks) {
                if ((trackId && item.id === trackId) || item.name === file.name) {
                    item.loading = false;
                }
            }
            syncQueueToUI();
            return audioBuf;
        } catch (err) {
            console.warn('[Audio] Failed to decode track:', file.name, err);
            const allTracks = [_currentPlayingTrack, ..._manualQueue, ..._contextQueue].filter(Boolean);
            for (const item of allTracks) {
                if ((trackId && item.id === trackId) || item.name === file.name) {
                    item.loading = false;
                }
            }
            syncQueueToUI();
            return null;
        } finally {
            _decodingPromises.delete(key);
            _decodingPromises.delete(file.name);
        }
    })();

    _decodingPromises.set(key, promise);
    _decodingPromises.set(file.name, promise);
    return await promise;
}

function preloadAndDecodeAudio(file, trackId = null) {
    getOrDecodeAudioBuffer(file, trackId);
}

// ─── Dynamic Priority Queue Audio Downloader & Prefetcher ─────────
let _currentPrefetchAbortController = null;
let _currentPrefetchItem = null;
let _prefetchLoopRunning = false;
let _prefetchWakeupResolver = null;

function getUpcomingPlaybackQueue() {
    return [..._manualQueue, ..._contextQueue].filter(Boolean);
}

function startBackgroundPrefetch() {
    const queue = getUpcomingPlaybackQueue();

    // 1. Si un téléchargement réseau est en cours, vérifier s'il est toujours pertinent
    if (_currentPrefetchItem && _currentPrefetchAbortController) {
        const stillInQueue = queue.some(t => 
            (t.id && t.id === _currentPrefetchItem.id) || t.name === _currentPrefetchItem.name
        );

        if (!stillInQueue) {
            // Le morceau a été supprimé de la file d'attente : annulation immédiate du téléchargement
            console.log(`[Prefetch] Morceau retiré de la file, annulation immédiate du téléchargement : ${_currentPrefetchItem.name}`);
            try {
                _currentPrefetchAbortController.abort();
            } catch (_) {}
            _currentPrefetchAbortController = null;
            _currentPrefetchItem = null;
        } else {
            // Le morceau est toujours dans la file, mais un autre morceau a-t-il été placé devant lui ?
            const firstNeeded = queue.find(item => {
                if (!item) return false;
                return !(_decodedAudioBuffers.has(item.id) || _decodedAudioBuffers.has(item.name));
            });

            if (firstNeeded && ((firstNeeded.id && firstNeeded.id !== _currentPrefetchItem.id) || firstNeeded.name !== _currentPrefetchItem.name)) {
                // L'ordre a changé : un autre morceau doit être joué avant, interruption et bascule immédiate
                console.log(`[Prefetch] Réorganisation détectée : priorité donnée à "${firstNeeded.name}", interruption de "${_currentPrefetchItem.name}"`);
                try {
                    _currentPrefetchAbortController.abort();
                } catch (_) {}
                _currentPrefetchAbortController = null;
                _currentPrefetchItem = null;
            }
        }
    }

    // 2. Réveiller la boucle de téléchargement si elle est en pause
    if (_prefetchWakeupResolver) {
        const r = _prefetchWakeupResolver;
        _prefetchWakeupResolver = null;
        r();
    }

    // 3. Démarrer la boucle de téléchargement si elle n'est pas déjà active
    if (!_prefetchLoopRunning) {
        _runPrefetchLoop();
    }
}

async function _runPrefetchLoop() {
    if (_prefetchLoopRunning) return;
    _prefetchLoopRunning = true;

    try {
        while (true) {
            const queue = getUpcomingPlaybackQueue();

            // Trouver le tout premier morceau dans l'ordre strict de lecture qui n'est pas encore décodé en mémoire
            const nextItem = queue.find(item => {
                if (!item) return false;
                const isDecoded = _decodedAudioBuffers.has(item.id) || _decodedAudioBuffers.has(item.name);
                return !isDecoded;
            });

            // Si tous les morceaux à venir sont prêts, se mettre en attente
            if (!nextItem) {
                await new Promise(resolve => {
                    _prefetchWakeupResolver = resolve;
                    setTimeout(resolve, 4000);
                });
                _prefetchWakeupResolver = null;

                // Re-vérifier : si toujours rien à charger, mettre fin à la boucle
                const recheck = getUpcomingPlaybackQueue().find(item => {
                    if (!item) return false;
                    return !(_decodedAudioBuffers.has(item.id) || _decodedAudioBuffers.has(item.name));
                });
                if (!recheck) break;
                continue;
            }

            // Récupérer le fichier local s'il existe déjà
            let file = nextItem.file || (nextItem.id && _localAudioFileCache.get(nextItem.id)) || _localAudioFileCache.get(nextItem.name);

            // Si le fichier n'est pas en cache local, le télécharger depuis le serveur
            if (!file) {
                const url = nextItem.url || (nextItem.id ? `/audio/track/${nextItem.id}` : null);
                if (!url) {
                    continue;
                }

                const controller = new AbortController();
                _currentPrefetchAbortController = controller;
                _currentPrefetchItem = nextItem;

                try {
                    const baseUrl = (mp && mp.httpUrl) ? mp.httpUrl : '';
                    const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url}`;
                    
                    const resp = await fetch(fullUrl, { signal: controller.signal });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const blob = await resp.blob();

                    // Vérifier si le morceau est TOUJOURS dans la file après la fin du transfert
                    const currentQueue = getUpcomingPlaybackQueue();
                    const stillWanted = currentQueue.some(t => (t.id && t.id === nextItem.id) || t.name === nextItem.name);
                    if (!stillWanted) {
                        console.log(`[Prefetch] Morceau ignoré après téléchargement car supprimé de la file : ${nextItem.name}`);
                        _currentPrefetchAbortController = null;
                        _currentPrefetchItem = null;
                        continue;
                    }

                    file = new File([blob], nextItem.name, { type: blob.type || 'audio/mpeg' });
                    if (nextItem.id) _localAudioFileCache.set(nextItem.id, file);
                    _localAudioFileCache.set(nextItem.name, file);
                    nextItem.file = file;
                } catch (err) {
                    if (err.name === 'AbortError' || controller.signal.aborted) {
                        // Annulation normale (morceau supprimé ou nouvel ordre prioritaire)
                        _currentPrefetchAbortController = null;
                        _currentPrefetchItem = null;
                        continue;
                    }
                    console.warn('[Prefetch] Erreur de téléchargement en arrière-plan :', nextItem.name, err);
                    nextItem.loading = false;
                    syncQueueToUI();
                    _currentPrefetchAbortController = null;
                    _currentPrefetchItem = null;
                    await new Promise(r => {
                        _prefetchWakeupResolver = r;
                        setTimeout(r, 800);
                    });
                    _prefetchWakeupResolver = null;
                    continue;
                } finally {
                    _currentPrefetchAbortController = null;
                    _currentPrefetchItem = null;
                }
            }

            // Décoder le buffer audio
            if (file) {
                // Re-vérifier s'il est toujours dans la file avant de décoder
                const currentQueue = getUpcomingPlaybackQueue();
                const stillWanted = currentQueue.some(t => (t.id && t.id === nextItem.id) || t.name === nextItem.name);
                if (!stillWanted) {
                    console.log(`[Prefetch] Décodage ignoré car le morceau a été retiré de la file : ${nextItem.name}`);
                    continue;
                }

                _currentPrefetchItem = nextItem;
                try {
                    await getOrDecodeAudioBuffer(file, nextItem.id);
                    nextItem.loading = false;
                    syncQueueToUI();
                    console.log(`[Prefetch] Morceau prêt et décodé en mémoire : ${nextItem.name}`);
                } catch (err) {
                    console.warn('[Prefetch] Erreur de décodage :', nextItem.name, err);
                    nextItem.loading = false;
                    syncQueueToUI();
                } finally {
                    _currentPrefetchItem = null;
                }
            }

            // Pause courte (150ms) entre deux téléchargements pour céder la main à la boucle de rendu
            await new Promise(r => {
                _prefetchWakeupResolver = r;
                setTimeout(r, 150);
            });
            _prefetchWakeupResolver = null;
        }
    } finally {
        _prefetchLoopRunning = false;
        _currentPrefetchAbortController = null;
        _currentPrefetchItem = null;
    }
}

// ─── Multiplayer ─────────────────────────────────────────────────
const mpHost = window.location.hostname || 'localhost';
// Redirection box : port 8067 (web) ➔ port 8068 (audio / websocket)
const mpPort = (window.location.port === '8067') ? '8068' : (window.location.port === '8080' ? '8068' : (window.location.port || '8068'));
const mpProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
const mp = new MultiplayerClient(`${mpProto}://${mpHost}:${mpPort}`);
let playerAvatars = null;
let _mpPosAccum = 0;
const MP_POS_INTERVAL = 1 / 20; // 20 fps position sync

// Try to connect to the multiplayer server. Degrades gracefully if server is offline.
let _mpReady = false;
try {
    await mp.connect();
    _mpReady = true;
    console.log(`[MP] Connected — role: ${mp.role}, room: ${mp.roomId}`);

    // Instantiate player avatars renderer — filter own avatar by server-assigned clientId
    playerAvatars = new PlayerAvatars(scene, mp.clientId);

    // Apply synchronized random player color to local character
    if (mp.color && listener?._character3D) {
        listener._character3D.setColor(mp.color);
    }

    // Apply full DSP state from server (sliders sync to server state)
    if (mp.dspState) {
        controls.applyFullDspState(mp.dspState);
    }

    // Show initial player count
    controls.updateMpStatus(mp.players.length);

    // Listen for DSP updates from server (applies to all peers)
    mp.onDspUpdate((bus, param, value) => {
        controls.applyDspFromServer(bus, param, value);
    });

    // Listen for player position updates
    mp.onPlayersUpdate((players) => {
        controls.updateMpStatus(players.length);
        if (voiceReceiver) {
            const currentIds = new Set(players.map(p => p.id));
            for (const peerId of voiceReceiver.peers.keys()) {
                if (!currentIds.has(peerId)) {
                    voiceReceiver.removePeer(peerId);
                }
            }
        }
        // Note: playerAvatars.update() is called every frame in the render loop with real dt
    });

    // Listen for real-time voice stream from other players
    mp.onVoiceData((senderId, sampleRate, pcm) => {
        if (voiceReceiver) {
            voiceReceiver.receive(senderId, sampleRate, pcm);
        }
    });

    _isNewTrackStarting = false;
    let _pendingPlaybackSync = null;

    function applyPendingPlaybackSync() {
        if (!_pendingPlaybackSync || !audioReady || !audioEngine.buffer) return;
        const { startTime, startOffset, trackName } = _pendingPlaybackSync;
        _pendingPlaybackSync = null;

        const now = Date.now();
        const delayMs = startTime - now;

        const isNewTrack = _isNewTrackStarting || _isSwitchingTrack;
        _isSwitchingTrack = false;
        _isNewTrackStarting = false;
        audioEngine.isLocked = false;
        controls.setPlaybackLocked(false);

        // Si nouveau morceau ou startOffset non défini/inférieur ou égal à 0 : TOUJOURS démarrer à 0:00 !
        if (isNewTrack || !startOffset || startOffset <= 0) {
            audioEngine.seek(0);
            if (delayMs > 0) {
                setTimeout(() => {
                    audioEngine.seek(0);
                    audioEngine.play(inputStage ? inputStage.input : crossover.input);
                    controls.setPlayState(true);
                    const np = document.getElementById('now-playing');
                    if (np) np.textContent = trackName || _currentAudioFileName;
                }, delayMs);
            } else {
                audioEngine.seek(0);
                audioEngine.play(inputStage ? inputStage.input : crossover.input);
                controls.setPlayState(true);
                const np = document.getElementById('now-playing');
                if (np) np.textContent = trackName || _currentAudioFileName;
            }
            return;
        }

        // Sinon (morceau déjà en cours chez les autres joueurs qu'on rejoint) : calage direct sur le timer réel
        const elapsed = Math.max(0, -delayMs / 1000);
        const targetTime = startOffset + elapsed;
        audioEngine.seek(targetTime);
        audioEngine.play(inputStage ? inputStage.input : crossover.input);
        controls.setPlayState(true);
        const np = document.getElementById('now-playing');
        if (np) np.textContent = trackName || _currentAudioFileName;
    }

    _localQueueVersion = 0;

    // Listen for full two-tier queue state updates from server (shared between all players)
    mp.onQueueStateSync((state) => {
        _localQueueVersion = state.queueVersion || 0;

        if (state.currentTrack) {
            const cur = state.currentTrack;
            const isDecoded = _decodedAudioBuffers.has(cur.id) || _decodedAudioBuffers.has(cur.name);
            _currentPlayingTrack = {
                id: cur.id,
                name: cur.name,
                url: cur.url || (cur.id ? `/audio/track/${cur.id}` : null),
                uploadedBy: cur.uploadedBy,
                file: _localAudioFileCache.get(cur.id) || _localAudioFileCache.get(cur.name) || null,
                loading: !isDecoded,
            };
            _currentAudioFileName = cur.name;
        } else {
            _currentPlayingTrack = null;
            _currentAudioFileName = '';
            if (audioReady && !_isSwitchingTrack) {
                audioEngine.stop();
                setBufferOnEngine(null);
                controls.setPlayState(false);
                controls.setHasTrack(false);
            }
        }

        // Priority manual queue ("À suivre dans la file d'attente")
        _manualQueue = (state.manualQueue || []).map(item => {
            const isDecoded = _decodedAudioBuffers.has(item.id) || _decodedAudioBuffers.has(item.name);
            return {
                id: item.id,
                name: item.name,
                url: item.url || (item.id ? `/audio/track/${item.id}` : null),
                uploadedBy: item.uploadedBy,
                file: _localAudioFileCache.get(item.id) || _localAudioFileCache.get(item.name) || null,
                loading: !isDecoded,
            };
        });

        // Context upcoming queue ("À suivre")
        _contextQueue = (state.contextQueue || []).map(item => {
            const isDecoded = _decodedAudioBuffers.has(item.id) || _decodedAudioBuffers.has(item.name);
            return {
                id: item.id,
                name: item.name,
                url: item.url || (item.id ? `/audio/track/${item.id}` : null),
                uploadedBy: item.uploadedBy,
                file: _localAudioFileCache.get(item.id) || _localAudioFileCache.get(item.name) || null,
                loading: !isDecoded,
            };
        });

        if (state.isShuffle !== undefined) {
            _isShuffle = Boolean(state.isShuffle);
            controls.setShuffleState(_isShuffle);
            try { localStorage.setItem('soundstage3d:playback-shuffle', String(_isShuffle)); } catch (_) {}
        }

        if (state.loadedPlaylistId) {
            _contextPlaylistId = state.loadedPlaylistId;
            _contextPlaylistName = state.loadedPlaylistName || 'Playlist';
            const pl = (mp && mp.playlists ? mp.playlists.find(p => p.id === state.loadedPlaylistId) : null) ||
                       (controls._playlists ? controls._playlists.find(p => p.id === state.loadedPlaylistId) : null);
            if (pl && Array.isArray(pl.tracks)) {
                _contextPlaylistTracks = [...pl.tracks];
            }
            controls.updatePlaylists(mp.playlists);
        }

        syncQueueToUI();
        startBackgroundPrefetch();
    });

    // Also keep legacy mp.onQueueSync for backward compatibility
    mp.onQueueSync((queue, currentIndex, addedTrack, loadedPlaylistId, loadedPlaylistName, isNewPlaylistLoad) => {
        if (_localQueueVersion === 0 && queue && queue.length > 0) {
            const mapped = queue.map(item => {
                const isDecoded = _decodedAudioBuffers.has(item.id) || _decodedAudioBuffers.has(item.name);
                return {
                    id: item.id,
                    name: item.name,
                    url: item.url || (item.id ? `/audio/track/${item.id}` : null),
                    uploadedBy: item.uploadedBy,
                    file: _localAudioFileCache.get(item.id) || _localAudioFileCache.get(item.name) || null,
                    loading: !isDecoded,
                };
            });
            if (currentIndex >= 0 && currentIndex < mapped.length) {
                _currentPlayingTrack = mapped[currentIndex];
                _contextQueue = mapped.slice(currentIndex + 1);
            }
            syncQueueToUI();
            startBackgroundPrefetch();
        }
    });

    // Continuous real-time server verification check (every 3 seconds)
    setInterval(() => {
        if (_mpReady && mp && mp.connected && mp.roomId) {
            mp.sendQueueCheckSync(_localQueueVersion);
        }
    }, 3000);

    // Listen for playlist list updates from server
    mp.onPlaylistsSync((playlists, savedId, savedName, authorId) => {
        const isAuthor = Boolean(authorId && authorId === mp.clientId);
        // Si c'est nous qui venons de créer/sauvegarder la playlist, on l'affiche
        // Sinon (pour les autres joueurs), on met juste à jour la liste des playlists sans changer celle affichée
        const selectId = isAuthor ? savedId : null;
        controls.updatePlaylists(playlists, selectId);
        if (savedId && isAuthor) {
            controls.markPlaylistSaved(savedId);
        }
        if (savedName && isAuthor) {
            const np = document.getElementById('now-playing');
            if (np) {
                const old = np.textContent;
                np.textContent = `💾 Playlist "${savedName}" sauvegardée sur le serveur !`;
                setTimeout(() => { if (np.textContent.includes('sauvegardée')) np.textContent = old; }, 3500);
            }
        }
    });
    if (mp.playlists && mp.playlists.length > 0) {
        controls.updatePlaylists(mp.playlists);
    }

    // Listen for audio track change broadcasted by server
    mp.onAudioTrackChanged(async (name, url, uploadedBy, trackId) => {
        console.log(`[MP] Track changed: "${name}" (${url}, id: ${trackId || 'none'})`);

        if (controls.state.sine.active) {
            controls.setSineActive(false);
            if (sineGenerator) sineGenerator.stop();
        }
        _musicWasPlayingBeforeSine = false;
        _currentAudioFileName = name;

        // Immediately stop old audio locally & mark new track starting
        audioEngine.stop();
        audioEngine.seek(0);
        controls.setPlayState(false);
        _isSwitchingTrack = true;
        _isNewTrackStarting = true;
        audioEngine.isLocked = true;
        controls.setPlaybackLocked(true, '⏳ Chargement...');
        const np = document.getElementById('now-playing');
        if (np) np.textContent = `⏳ Chargement : ${name}...`;

        if (!_currentPlayingTrack || _currentPlayingTrack.name !== name) {
            _currentPlayingTrack = {
                id: trackId || ('t_' + Date.now()),
                name: name,
                url: url,
                uploadedBy: uploadedBy,
                file: (trackId && _localAudioFileCache.get(trackId)) || _localAudioFileCache.get(name) || null,
                loading: true
            };
        } else {
            _currentPlayingTrack.loading = true;
        }
        syncQueueToUI();

        try {
            let file = (trackId && _localAudioFileCache.get(trackId)) || _localAudioFileCache.get(name);
            if (!file && url) {
                const fullUrl = url.startsWith('http') ? url : `${mp.httpUrl}${url}`;
                const resp = await fetch(fullUrl);
                const blob = await resp.blob();
                file = new File([blob], name, { type: blob.type || 'audio/mpeg' });
                if (trackId) _localAudioFileCache.set(trackId, file);
                _localAudioFileCache.set(name, file);
                if (_currentPlayingTrack) _currentPlayingTrack.file = file;
            }

            if (!audioReady && file) {
                await initAudio(file, false);
            }

            const buf = await getOrDecodeAudioBuffer(file, trackId);
            if (buf) {
                setBufferOnEngine(buf);
                if (inputStage) inputStage.analyzeBuffer(buf);
                controls.setHasTrack(true);
            }
            if (_currentPlayingTrack) _currentPlayingTrack.loading = false;
            syncQueueToUI();
            if (file) saveLastAudio(file);

            // Si le signal de lecture est déjà arrivé pendant qu'on préparait, synchronisation immédiate
            if (_pendingPlaybackSync) {
                applyPendingPlaybackSync();
            } else {
                if (np) np.textContent = `⏳ Prêt, synchronisation...`;
                controls.setPlaybackLocked(true, '⏳ Synchronisation...');
                mp.sendTrackBufferReady();
            }
        } catch (err) {
            console.error('[MP] Failed to prepare audio track:', err);
            _isSwitchingTrack = false;
            audioEngine.isLocked = false;
            controls.setPlaybackLocked(false);
            if (_currentPlayingTrack) _currentPlayingTrack.loading = false;
            syncQueueToUI();
        }
    });

    // Listen for simultaneous playback start signal coordinated by server
    mp.onStartPlaybackSync((startTime, startOffset, trackName) => {
        _pendingPlaybackSync = { startTime, startOffset, trackName };
        if (!audioReady || !audioEngine.buffer) return;
        applyPendingPlaybackSync();
    });

    // Room closed
    mp.onRoomClosed(() => {
        const overlay = document.getElementById('overlay');
        const msg = document.createElement('div');
        msg.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);color:#fff;font-size:1.5rem;text-align:center;';
        msg.innerHTML = '<div>🔌 La session est terminée.<br><br><button onclick="location.href=location.origin" style="padding:12px 28px;font-size:1rem;border-radius:8px;cursor:pointer;">Créer une nouvelle session</button></div>';
        document.body.appendChild(msg);
    });

    // Playback sync — drift correction between peers
    mp.onPlaybackSync((currentTime, isPlaying, serverTimestamp) => {
        if (!audioReady || controls.state.sine.active || _isSwitchingTrack) return;
        if (!audioEngine.buffer) return;
        const lagMs = serverTimestamp ? (Date.now() - serverTimestamp) : 0;
        const compensated = currentTime + (lagMs / 1000);
        if (isPlaying) {
            // Only seek if drift exceeds 0.5s to prevent stuttering/audio cutting
            if (Math.abs(audioEngine.getCurrentTime() - compensated) > 0.5) {
                audioEngine.seek(compensated);
            }
            if (!audioEngine.isPlaying) {
                audioEngine.play(inputStage ? inputStage.input : crossover?.input);
                controls.setPlayState(audioEngine.isPlaying);
            }
        } else {
            if (audioEngine.isPlaying) {
                audioEngine.pause();
            }
            controls.setPlayState(false);
            if (Math.abs(audioEngine.getCurrentTime() - currentTime) > 0.3) {
                audioEngine.seek(currentTime);
            }
        }
    });

    // ─── SYNC_ACTION — apply one-shot actions from other players ─────────────
    mp.onAction((action, data) => {
        // Immediate notification that someone is uploading/changing a track: stop old audio instantly!
        if (action === 'track_switching') {
            _isSwitchingTrack = true;
            audioEngine.isLocked = true;
            controls.setPlaybackLocked(true, '⏳ Chargement...');
            if (controls.state.sine.active) {
                controls.setSineActive(false);
                if (sineGenerator) sineGenerator.stop();
            }
            _musicWasPlayingBeforeSine = false;
            audioEngine.stop();
            controls.setPlayState(false);
            const np = document.getElementById('now-playing');
            if (np) np.textContent = `⏳ Nouveau morceau : ${data.name || ''}...`;
            return;
        }

        // While switching track, ignore any play/pause or seek actions
        if (_isSwitchingTrack || audioEngine.isLocked) return;

        switch (action) {

            // ── Play / Pause ───────────────────────────────────────────────
            case 'play_pause': {
                if (!audioReady) break;
                if (audioEngine.ctx?.state === 'suspended') audioEngine.ctx.resume();

                if (controls.state.sine.active && sineGenerator) {
                    const shouldPlay = data.isPlaying !== undefined ? data.isPlaying : !sineGenerator.isPlaying;
                    if (shouldPlay) {
                        if (!sineGenerator.isPlaying) sineGenerator.start();
                        controls.setPlayState(true);
                    } else {
                        if (sineGenerator.isPlaying) sineGenerator.stop();
                        controls.setPlayState(false);
                    }
                } else {
                    const shouldPlay = data.isPlaying !== undefined ? data.isPlaying : !audioEngine.isPlaying;
                    if (data.currentTime !== undefined && Math.abs(audioEngine.getCurrentTime() - data.currentTime) > 0.3) {
                        audioEngine.seek(data.currentTime);
                    }
                    if (shouldPlay) {
                        if (!audioEngine.isPlaying) {
                            audioEngine.play(inputStage ? inputStage.input : crossover.input);
                        }
                        controls.setPlayState(true);
                        const np = document.getElementById('now-playing');
                        if (np) np.textContent = _currentAudioFileName;
                    } else {
                        if (audioEngine.isPlaying) {
                            audioEngine.pause();
                        }
                        controls.setPlayState(false);
                        const np = document.getElementById('now-playing');
                        if (np) np.textContent = '';
                    }
                }
                break;
            }

            // ── Seek ───────────────────────────────────────────────────────
            case 'seek': {
                if (!audioReady) break;
                audioEngine.seek(data.currentTime);
                break;
            }

            // ── Skip ───────────────────────────────────────────────────────
            case 'skip': {
                if (!audioReady) break;
                const target = data.currentTime !== undefined
                    ? data.currentTime
                    : Math.max(0, audioEngine.getCurrentTime() + (data.delta || 0));
                audioEngine.seek(target);
                break;
            }

            // ── Prev / Next ────────────────────────────────────────────────
            case 'prev':
            case 'next': {
                if (!audioReady) break;
                audioEngine.seek(0);
                break;
            }

            // ── Sine toggle ────────────────────────────────────────────────
            case 'sine_toggle': {
                if (!audioReady || !sineGenerator) break;
                const active = data.active;
                if (active) {
                    if (audioEngine.isPlaying) {
                        _musicWasPlayingBeforeSine = true;
                        audioEngine.pause();
                    }
                    if (data.frequency) {
                        sineGenerator.setFrequency(data.frequency);
                        controls.applyDspFromServer('sine', 'frequency', data.frequency);
                    }
                    if (data.volume !== undefined) {
                        sineGenerator.setVolume(data.volume);
                        controls.applyDspFromServer('sine', 'volume', data.volume);
                    }
                    sineGenerator.start();
                    controls.setSineActive(true);
                    controls.setPlayState(true);
                    const np = document.getElementById('now-playing');
                    if (np) np.textContent = `🔊 Sinus : ${data.frequency ?? controls.state.sine.frequency} Hz`;
                } else {
                    sineGenerator.stop();
                    controls.setSineActive(false);
                    if (_musicWasPlayingBeforeSine) {
                        audioEngine.play(inputStage ? inputStage.input : crossover.input);
                        controls.setPlayState(true);
                    } else {
                        controls.setPlayState(false);
                        controls.resetMeters();
                    }
                    _musicWasPlayingBeforeSine = false;
                    const np = document.getElementById('now-playing');
                    if (np) np.textContent = _currentAudioFileName || '';
                }
                break;
            }

            // ── Sine frequency ─────────────────────────────────────────────
            case 'sine_freq': {
                if (!sineGenerator) break;
                sineGenerator.setFrequency(data.value);
                // Move slider visually
                controls.applyDspFromServer('sine', 'frequency', data.value);
                const np = document.getElementById('now-playing');
                if (sineGenerator.isPlaying && np) np.textContent = `🔊 Sinus : ${data.value} Hz`;
                break;
            }

            // ── Sine volume ────────────────────────────────────────────────
            case 'sine_vol': {
                if (!sineGenerator) break;
                sineGenerator.setVolume(data.value);
                controls.applyDspFromServer('sine', 'volume', data.value);
                break;
            }

            // ── Track name ─────────────────────────────────────────────────
            case 'track_name': {
                _currentAudioFileName = data.name;
                const np = document.getElementById('now-playing');
                if (np && !controls.state.sine.active) np.textContent = data.name;
                break;
            }

            // ── Reset all DSP ──────────────────────────────────────────────
            case 'reset_all_dsp': {
                controls._suppressMpSend = true;
                controls.resetAllDsp();
                controls._suppressMpSend = false;
                break;
            }

            // ── Stop playback ──────────────────────────────────────────────
            case 'stop_playback': {
                if (audioReady) {
                    audioEngine.stop();
                    setBufferOnEngine(null);
                    controls.setPlayState(false);
                    controls.setHasTrack(false);
                }
                _currentPlayingTrack = null;
                _currentAudioFileName = '';
                _manualQueue = [];
                _contextQueue = [];
                syncQueueToUI();
                const np = document.getElementById('now-playing');
                if (np) np.textContent = '';
                break;
            }
        }
    });


    async function copyToClipboard(text) {
        if (navigator?.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (_) {}
        }
        try {
            const textArea = document.createElement('textarea');
            textArea.value = text;
            textArea.style.position = 'fixed';
            textArea.style.top = '0';
            textArea.style.left = '0';
            textArea.style.opacity = '0';
            textArea.style.pointerEvents = 'none';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            const successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            if (successful) return true;
        } catch (_) {}
        return false;
    }

    controls.onInvite(async () => {
        try {
            const url = mp.getInviteUrl();
            const copied = await copyToClipboard(url);
            if (copied) {
                if (controls.inviteBtn) {
                    const orig = controls.inviteBtn.textContent;
                    controls.inviteBtn.textContent = '✅ Lien copié !';
                    controls.inviteBtn.style.color = '#86efac';
                    setTimeout(() => {
                        controls.inviteBtn.textContent = orig;
                        controls.inviteBtn.style.color = '';
                    }, 2500);
                }
            } else {
                prompt('Copiez ce lien pour inviter :', url);
            }
        } catch (e) {
            console.error('[MP] Erreur lors de l’invitation:', e);
            if (mp && mp.roomId) {
                prompt('Copiez ce lien pour inviter :', window.location.origin + window.location.pathname + '?room=' + mp.roomId);
            }
        }
    });

} catch (err) {
    console.warn('[MP] Multiplayer server unavailable — running in offline mode.', err.message || err);
    // Hide invite button in offline mode
    if (controls.inviteBtn) controls.inviteBtn.classList.add('hidden');
    if (controls.mpStatusEl) controls.mpStatusEl.classList.add('hidden');
}

// Charger les playlists sauvegardées depuis le serveur dès le chargement de la page
async function loadServerPlaylists() {
    try {
        const url = (mp && mp.httpUrl) ? `${mp.httpUrl}/api/playlists` : '/api/playlists';
        const resp = await fetch(url);
        if (resp.ok) {
            const playlists = await resp.json();
            if (Array.isArray(playlists) && playlists.length > 0) {
                controls.updatePlaylists(playlists);
            }
        }
    } catch (e) {
        console.warn('[Playlist] Erreur chargement playlists HTTP:', e);
    }
}
loadServerPlaylists();

async function initAudio(file = null, autoPlay = false) {
    if (audioReady) {
        if (file) {
            _currentAudioFileName = file.name;
            if (controls.state.sine.active) {
                controls.setSineActive(false);
                if (sineGenerator) sineGenerator.stop();
            }
            _musicWasPlayingBeforeSine = false;
            audioEngine.stop();
            audioEngine.seek(0);
            const buf = await getOrDecodeAudioBuffer(file);
            setBufferOnEngine(buf);
            if (inputStage) inputStage.analyzeBuffer(buf);
            controls.setHasTrack(Boolean(buf));
            if (autoPlay && !audioEngine.isLocked) {
                audioEngine.seek(0);
                audioEngine.play(inputStage ? inputStage.input : crossover.input);
                controls.setPlayState(true);
                const np = document.getElementById('now-playing');
                if (np) np.textContent = file.name;
            } else {
                audioEngine.seek(0);
                controls.setPlayState(false);
                const np = document.getElementById('now-playing');
                if (np) np.textContent = '';
            }
        }
        return;
    }

    // Init audio context
    const ctx = audioEngine.init();

    if (file) {
        _currentAudioFileName = file.name;
        const buf = await getOrDecodeAudioBuffer(file);
        setBufferOnEngine(buf);
    }

    // Build Input Stage (Normalisation LUFS, Trim, EQ 3 bandes, Compresseur, Limiteur)
    inputStage = new InputStage(ctx);
    inputStage.onAnalysisUpdate(data => controls.updateInputAnalysis(data));
    if (audioEngine.buffer) {
        inputStage.analyzeBuffer(audioEngine.buffer);
    }

    // Build DSP graph
    crossover = new Crossover(ctx, {
        lowFreq: DSP_DEFAULTS.sub['xover-freq'],
        highFreq: DSP_DEFAULTS.mid['xover-high'] ?? DSP_DEFAULTS.top['xover-freq'],
    });

    // Connect InputStage output to Crossover input
    inputStage.output.connect(crossover.input);

    const subComp = createCompressor(ctx, {
        threshold: DSP_DEFAULTS.sub['comp-threshold'],
        knee:      DSP_DEFAULTS.sub['comp-knee'],
        ratio:     DSP_DEFAULTS.sub['comp-ratio'],
        attack:    DSP_DEFAULTS.sub['comp-attack'],
        release:   DSP_DEFAULTS.sub['comp-release'],
    });
    const subSat = createSaturation(ctx, {
        drive: DSP_DEFAULTS.sub['sat-drive'],
        mix:   DSP_DEFAULTS.sub['sat-mix'],
    });
    const midComp = createCompressor(ctx, {
        threshold: DSP_DEFAULTS.mid['comp-threshold'],
        knee:      DSP_DEFAULTS.mid['comp-knee'],
        ratio:     DSP_DEFAULTS.mid['comp-ratio'],
        attack:    DSP_DEFAULTS.mid['comp-attack'],
        release:   DSP_DEFAULTS.mid['comp-release'],
    });
    const midSat = createSaturation(ctx, {
        drive: DSP_DEFAULTS.mid['sat-drive'],
        mix:   DSP_DEFAULTS.mid['sat-mix'],
    });
    const topComp = createCompressor(ctx, {
        threshold: DSP_DEFAULTS.top['comp-threshold'],
        knee:      DSP_DEFAULTS.top['comp-knee'],
        ratio:     DSP_DEFAULTS.top['comp-ratio'],
        attack:    DSP_DEFAULTS.top['comp-attack'],
        release:   DSP_DEFAULTS.top['comp-release'],
    });
    const topSat = createSaturation(ctx, {
        drive: DSP_DEFAULTS.top['sat-drive'],
        mix:   DSP_DEFAULTS.top['sat-mix'],
    });
    effects = { subComp, subSat, midComp, midSat, topComp, topSat };

    speakerSystem = new SpeakerSystem(
        ctx,
        crossover.subBusOutput,
        crossover.midBusOutput,
        crossover.topBusOutput,
        effects
    );

    // Tone Generator routed into InputStage input
    sineGenerator = new SineGenerator(ctx, inputStage.input);
    sineGenerator.setFrequency(controls.state.sine.frequency);
    sineGenerator.setVolume(controls.state.sine.volume);

    // Live Microphone Input routed into InputStage micGainNode
    micInput = new MicrophoneInput(ctx, inputStage.micGainNode);
    micInput.setVolume(controls.state.input['mic-volume'] ?? 100);
    micInput.onStateChange = (isActive) => {
        controls.setMicActive(isActive);
    };
    micInput.onError = (err) => {
        if (typeof window !== 'undefined' && !window.isSecureContext) {
            alert("🎤 Accès microphone bloqué (HTTP non sécurisé) :\n\n" +
                  "Brave et Chrome bloquent l'accès au micro sur les adresses HTTP par sécurité.\n\n" +
                  "👉 Solution 1 (Test sur ce PC) : Ouvrez le jeu sur http://localhost:8067 ou http://127.0.0.1:8067 au lieu de l'IP externe.\n\n" +
                  "👉 Solution 2 (Connexion externe) : Dans Brave/Chrome, ouvrez brave://flags/#unsafely-treat-insecure-origin-as-secure (ou chrome://flags), ajoutez " + location.origin + ", passez sur 'Enabled' et relancez le navigateur.");
        } else {
            alert("Impossible d'accéder au microphone : " + (err.message || err));
        }
        controls.setMicActive(false);
    };
    micInput.onAudioData = (pcm, sampleRate) => {
        if (_mpReady && micInput.isActive) {
            mp.sendVoiceData(sampleRate, pcm);
        }
    };

    // Voice Receiver for remote player voices routed into InputStage micGainNode
    voiceReceiver = new VoiceReceiver(ctx, inputStage.micGainNode);

    audioReady = true;
    window.__DEBUG = { audioEngine, speakerSystem, listener, sineGenerator, camera, inputStage, micInput, voiceReceiver };

    // Apply initial bus volumes from config
    speakerSystem.setBusVolume('sub', DSP_DEFAULTS.sub['bus-volume'] / 100);
    speakerSystem.setBusVolume('mid', DSP_DEFAULTS.mid['bus-volume'] / 100);
    speakerSystem.setBusVolume('top', DSP_DEFAULTS.top['bus-volume'] / 100);
    speakerSystem.setBusVolume('fill', DSP_DEFAULTS.fill['bus-volume'] / 100);

    // Apply saved user controls (local volume)
    if (controls.state.user?.['local-volume'] !== undefined) {
        speakerSystem.setLocalVolume(controls.state.user['local-volume']);
    }

    // Initialisation des sondes de diagnostic en temps réel
    setupAudioDebugProbes(audioEngine, crossover, effects, speakerSystem);

    controls.setHasTrack(Boolean(audioEngine.buffer));
    if (file) {
        if (autoPlay && !audioEngine.isLocked) {
            audioEngine.play(inputStage.input);
            controls.setPlayState(true);
            const np = document.getElementById('now-playing');
            if (np) np.textContent = file.name;
        } else {
            controls.setPlayState(false);
            const np = document.getElementById('now-playing');
            if (np) np.textContent = '';
        }
    } else {
        controls.setPlayState(false);
        const np = document.getElementById('now-playing');
        if (np) np.textContent = '';
    }
}

// Initialise HUD immédiatement
controls.showHUD();

const isFirstInNewRoom = !_mpReady || Boolean(mp && mp.role === 'master' && mp.isFirstInRoom);

let savedAudioFile = null;
if (!_mpReady) {
    try {
        savedAudioFile = await loadLastAudio();
        if (savedAudioFile) {
            _localAudioFileCache.set(savedAudioFile.name, savedAudioFile);
        }
    } catch (err) {
        console.warn('Failed to load saved audio from IndexedDB:', err);
    }
} else if (isFirstInNewRoom) {
    // Si la salle est neuve et vide, charger le cache pour alimenter la salle
    const hasRoomTrack = Boolean(mp.currentTrack || mp.manualQueue?.length > 0 || mp.contextQueue?.length > 0 || mp.audioUrl);
    if (!hasRoomTrack) {
        try {
            savedAudioFile = await loadLastAudio();
            if (savedAudioFile) {
                _localAudioFileCache.set(savedAudioFile.name, savedAudioFile);
            }
        } catch (err) {
            console.warn('Failed to load saved audio from IndexedDB:', err);
        }
    }
}

// Si le salon multijoueur est actif : synchronisation stricte avec l'état de la salle
if (_mpReady) {
    const hasRoomTrack = Boolean(mp.currentTrack || mp.manualQueue?.length > 0 || mp.contextQueue?.length > 0);

    if (hasRoomTrack) {
        if (mp.currentTrack) {
            const cur = mp.currentTrack;
            const isDecoded = _decodedAudioBuffers.has(cur.id) || _decodedAudioBuffers.has(cur.name);
            _currentPlayingTrack = {
                id: cur.id,
                name: cur.name,
                url: cur.url || (cur.id ? `/audio/track/${cur.id}` : null),
                uploadedBy: cur.uploadedBy,
                file: _localAudioFileCache.get(cur.id) || _localAudioFileCache.get(cur.name) || null,
                loading: !isDecoded,
            };
            _currentAudioFileName = cur.name;
        } else {
            _currentPlayingTrack = null;
            _currentAudioFileName = '';
        }
        if (mp.manualQueue && mp.manualQueue.length > 0) {
            _manualQueue = mp.manualQueue.map(item => {
                const isDecoded = _decodedAudioBuffers.has(item.id) || _decodedAudioBuffers.has(item.name);
                return {
                    id: item.id,
                    name: item.name,
                    url: item.url || (item.id ? `/audio/track/${item.id}` : null),
                    uploadedBy: item.uploadedBy,
                    file: _localAudioFileCache.get(item.id) || _localAudioFileCache.get(item.name) || null,
                    loading: !isDecoded,
                };
            });
        } else {
            _manualQueue = [];
        }
        if (mp.contextQueue && mp.contextQueue.length > 0) {
            _contextQueue = mp.contextQueue.map(item => {
                const isDecoded = _decodedAudioBuffers.has(item.id) || _decodedAudioBuffers.has(item.name);
                return {
                    id: item.id,
                    name: item.name,
                    url: item.url || (item.id ? `/audio/track/${item.id}` : null),
                    uploadedBy: item.uploadedBy,
                    file: _localAudioFileCache.get(item.id) || _localAudioFileCache.get(item.name) || null,
                    loading: !isDecoded,
                };
            });
        } else {
            _contextQueue = [];
        }

        if (mp.isShuffle !== undefined) {
            _isShuffle = Boolean(mp.isShuffle);
            controls.setShuffleState(_isShuffle);
        }
        if (mp.loadedPlaylistId) {
            _contextPlaylistId = mp.loadedPlaylistId;
            _contextPlaylistName = mp.loadedPlaylistName || 'Playlist';
            const pl = (mp.playlists || []).find(p => p.id === mp.loadedPlaylistId) || (controls._playlists || []).find(p => p.id === mp.loadedPlaylistId);
            if (pl && Array.isArray(pl.tracks)) {
                _contextPlaylistTracks = [...pl.tracks];
            }
        }
        _localQueueVersion = mp.queueVersion || 1;
        syncQueueToUI();

        // On ne télécharge IMMÉDIATEMENT que le morceau actif pour entrer dans le jeu tout de suite
        const activeItem = _currentPlayingTrack;
        if (activeItem && activeItem.url) {
            try {
                const fullUrl = activeItem.url.startsWith('http') ? activeItem.url : `${mp.httpUrl}${activeItem.url}`;
                const resp = await fetch(fullUrl);
                if (resp.ok) {
                    const blob = await resp.blob();
                    savedAudioFile = new File([blob], activeItem.name || 'track.mp3', { type: blob.type || 'audio/mpeg' });
                    saveLastAudio(savedAudioFile);
                    if (activeItem.id) _localAudioFileCache.set(activeItem.id, savedAudioFile);
                    _localAudioFileCache.set(savedAudioFile.name, savedAudioFile);
                    activeItem.file = savedAudioFile;
                }
            } catch (err) {
                console.warn('[MP] Failed to load active track:', err);
            }
        }
    } else if (mp.audioUrl) {
        // Salon avec piste unique sans queue
        try {
            const fullUrl = mp.audioUrl.startsWith('http') ? mp.audioUrl : `${mp.httpUrl}${mp.audioUrl}`;
            const resp = await fetch(fullUrl);
            if (resp.ok) {
                const blob = await resp.blob();
                savedAudioFile = new File([blob], mp.trackName || 'track.mp3', { type: blob.type || 'audio/mpeg' });
                saveLastAudio(savedAudioFile);
                if (mp.trackId) _localAudioFileCache.set(mp.trackId, savedAudioFile);
                _localAudioFileCache.set(savedAudioFile.name, savedAudioFile);
            }
        } catch (err) {
            console.warn('[MP] Failed to load initial track from room:', err);
        }
    } else if (!isFirstInNewRoom) {
        // Pas la première personne dans une nouvelle salle et aucun morceau actif : TOUT VIDER !
        savedAudioFile = null;
        _currentPlayingTrack = null;
        _currentAudioFileName = '';
        _manualQueue = [];
        _contextQueue = [];
        syncQueueToUI();
    }
}

try {
    const shouldAutoPlay = Boolean(isFirstInNewRoom && savedAudioFile);
    await initAudio(savedAudioFile, shouldAutoPlay);

    if (savedAudioFile && !_currentPlayingTrack && (!_mpReady || isFirstInNewRoom)) {
        const initialTrackId = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        _localAudioFileCache.set(initialTrackId, savedAudioFile);
        _localAudioFileCache.set(savedAudioFile.name, savedAudioFile);
        _currentPlayingTrack = {
            id: initialTrackId,
            name: savedAudioFile.name,
            file: savedAudioFile,
            loading: false
        };
        _currentAudioFileName = savedAudioFile.name;
        syncQueueToUI();

        // Si première personne dans une nouvelle salle : synchroniser ce morceau initial sur le serveur et le lancer
        if (_mpReady && isFirstInNewRoom) {
            mp.uploadAudioFile(savedAudioFile, initialTrackId).catch(err => {
                console.warn('[MP] Failed to sync saved initial track to room:', err);
            });
        }
    }
} catch (err) {
    console.warn('Failed to initialize audio with saved file:', err);
    if (!audioReady) await initAudio(null);
}

// Synchronisation de l'état audio initial reçu du serveur multijoueur
if (_mpReady) {
    if (mp.trackName && _currentPlayingTrack && mp.playback?.isPlaying) {
        _currentAudioFileName = mp.trackName;
        const np = document.getElementById('now-playing');
        if (np) np.textContent = mp.trackName;
    }

    if (mp.sine && mp.sine.active && sineGenerator) {
        if (audioEngine.isPlaying) audioEngine.pause();
        sineGenerator.setFrequency(mp.sine.frequency);
        sineGenerator.setVolume(mp.sine.volume);
        controls.applyDspFromServer('sine', 'frequency', mp.sine.frequency);
        controls.applyDspFromServer('sine', 'volume', mp.sine.volume);
        sineGenerator.start();
        controls.setSineActive(true);
        controls.setPlayState(true);
        const np = document.getElementById('now-playing');
        if (np) np.textContent = `🔊 Sinus : ${mp.sine.frequency} Hz`;
    } else if (audioReady && audioEngine.buffer) {
        // Notifier le serveur que notre buffer audio est prêt à jouer
        mp.sendTrackBufferReady();

        if (mp.playback && mp.playback.isPlaying) {
            const elapsed = Math.max(0, (Date.now() - (mp.playback.timestamp || Date.now())) / 1000);
            const targetTime = (mp.playback.currentTime || 0) + elapsed;
            audioEngine.seek(targetTime);
            audioEngine.play(inputStage ? inputStage.input : crossover.input);
            controls.setPlayState(audioEngine.isPlaying);
        } else {
            audioEngine.seek(mp.playback?.currentTime || 0);
            audioEngine.pause();
            controls.setPlayState(false);
        }
    }

    // Pré-chargement des morceaux suivants en arrière-plan
    startBackgroundPrefetch();
}

// Déverrouillage automatique du contexte audio sur la première interaction
const unlockAudioContext = () => {
    if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
        audioEngine.ctx.resume().then(() => {
            if (_mpReady && mp?.playback?.isPlaying && audioEngine.buffer) {
                const elapsed = Math.max(0, (Date.now() - (mp.playback.timestamp || Date.now())) / 1000);
                const targetTime = (mp.playback.currentTime || 0) + elapsed;
                audioEngine.seek(targetTime);
                audioEngine.play(inputStage ? inputStage.input : crossover.input);
                controls.setPlayState(audioEngine.isPlaying);
            }
        });
    }
};
window.addEventListener('keydown', unlockAudioContext);
window.addEventListener('pointerdown', unlockAudioContext);
window.addEventListener('click', unlockAudioContext);

// Synchronisation du mode caméra avec le HUD
controls.onCameraToggle(() => {
    listener.cycleCameraMode();
});
listener.onCameraModeChange((mode, isFlying) => {
    controls.setCameraModeLabel(mode, isFlying);
});
controls.setCameraModeLabel(listener.cameraMode, listener.isFlying);
listener.setSensitivity((controls.state.user?.['mouse-sensitivity'] ?? 60) / 100);
listener.setInvertPitch(controls.state.user?.['invert-y'] ?? false);
listener.setInvertYaw(controls.state.user?.['invert-x'] ?? false);
if (controls.state.user?.['grass-distance'] !== undefined) {
    setGrassQuality(controls.state.user['grass-distance']);
}

controls.onEnter(async (file) => {
    await initAudio(file, true);
    listener.lock();
    if (file) saveLastAudio(file);
});

controls.onPlayPause(() => {
    if (!audioReady || _isSwitchingTrack || audioEngine.isLocked) return;
    // If sine generator mode is active
    if (controls.state.sine.active && sineGenerator) {
        if (sineGenerator.isPlaying) {
            sineGenerator.stop();
            controls.setPlayState(false);
            if (_mpReady) mp.sendAction('play_pause', { isPlaying: false });
        } else {
            sineGenerator.start();
            controls.setPlayState(true);
            if (_mpReady) mp.sendAction('play_pause', { isPlaying: true });
        }
    } else {
        if (!_currentPlayingTrack || !audioEngine.buffer) return;
        if (audioEngine.isPlaying) {
            audioEngine.pause();
            controls.setPlayState(false);
            const np = document.getElementById('now-playing');
            if (np) np.textContent = '';
            if (_mpReady) mp.sendAction('play_pause', { isPlaying: false, currentTime: audioEngine.getCurrentTime() });
        } else {
            audioEngine.play(inputStage ? inputStage.input : crossover.input);
            controls.setPlayState(true);
            const np = document.getElementById('now-playing');
            if (np) np.textContent = _currentAudioFileName;
            if (_mpReady) mp.sendAction('play_pause', { isPlaying: true, currentTime: audioEngine.getCurrentTime() });
        }
    }
});

controls.onSeek((targetTime) => {
    if (!audioReady || _isSwitchingTrack || audioEngine.isLocked) return;
    audioEngine.seek(targetTime);
    if (_mpReady) mp.sendAction('seek', { currentTime: targetTime });
});

controls.onSkip((deltaSec) => {
    if (!audioReady || _isSwitchingTrack || audioEngine.isLocked) return;
    const target = Math.max(0, audioEngine.getCurrentTime() + deltaSec);
    audioEngine.seek(target);
    if (_mpReady) mp.sendAction('seek', { currentTime: target });
});

controls.onSineToggle((active) => {
    if (!audioReady || !sineGenerator || _isSwitchingTrack || audioEngine.isLocked) return;
    const np = document.getElementById('now-playing');
    if (active) {
        if (audioEngine.isPlaying) {
            _musicWasPlayingBeforeSine = true;
            audioEngine.pause();
        } else {
            _musicWasPlayingBeforeSine = false;
        }
        sineGenerator.start();
        controls.setPlayState(true);
        if (np) np.textContent = `🔊 Sinus : ${controls.state.sine.frequency} Hz`;
        // Sync: send toggle + current freq + vol so others start in the same state
        if (_mpReady) mp.sendAction('sine_toggle', {
            active: true,
            frequency: controls.state.sine.frequency,
            volume: controls.state.sine.volume ?? 50,
        });
    } else {
        sineGenerator.stop();
        if (_musicWasPlayingBeforeSine) {
            audioEngine.play(inputStage ? inputStage.input : crossover.input);
            controls.setPlayState(true);
            if (np) np.textContent = _currentAudioFileName;
        } else {
            controls.setPlayState(false);
            controls.resetMeters();
            if (np) np.textContent = _currentAudioFileName ? `⏸ ${_currentAudioFileName}` : '';
        }
        if (_mpReady) mp.sendAction('sine_toggle', { active: false });
    }
});

controls.onSineFrequency((freq) => {
    if (!sineGenerator) return;
    sineGenerator.setFrequency(freq);
    if (sineGenerator.isPlaying) {
        const np = document.getElementById('now-playing');
        if (np) np.textContent = `🔊 Sinus : ${freq} Hz`;
    }
    if (_mpReady && !controls._suppressMpSend) mp.sendAction('sine_freq', { value: freq });
});

controls.onSineVolume((vol) => {
    if (!sineGenerator) return;
    sineGenerator.setVolume(vol);
    if (_mpReady && !controls._suppressMpSend) mp.sendAction('sine_vol', { value: vol });
});

controls.onResetAllDsp(() => {
    if (_mpReady && !controls._suppressMpSend) mp.sendAction('reset_all_dsp', {});
});

async function playTrack(track, autoPlay = true) {
    if (!track) return;
    _currentPlayingTrack = {
        id: track.id || ('t_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
        name: track.name || 'Piste audio',
        file: track.file || null,
        url: track.url || null,
        uploadedBy: track.uploadedBy || null,
        loading: true
    };
    _currentAudioFileName = _currentPlayingTrack.name;

    // Couper immédiatement l'ancien audio
    audioEngine.stop();
    audioEngine.seek(0);
    controls.setPlayState(false);
    _isSwitchingTrack = true;
    _isNewTrackStarting = true;
    audioEngine.isLocked = true;
    controls.setPlaybackLocked(true, '⏳ Chargement...');
    const np = document.getElementById('now-playing');
    if (np) np.textContent = `⏳ Chargement : ${_currentPlayingTrack.name}...`;

    syncQueueToUI();

    try {
        let fromServer = false;
        let file = _currentPlayingTrack.file || (track.id && _localAudioFileCache.get(track.id)) || _localAudioFileCache.get(track.name);
        if (!file) {
            let trackUrl = track.url;
            if (!trackUrl && track.id) {
                trackUrl = `/audio/track/${track.id}`;
            }
            if (trackUrl) {
                const baseUrl = (mp && mp.httpUrl) ? mp.httpUrl : '';
                const fullUrl = trackUrl.startsWith('http') ? trackUrl : `${baseUrl}${trackUrl}`;
                const resp = await fetch(fullUrl);
                if (resp.ok) {
                    const blob = await resp.blob();
                    file = new File([blob], track.name, { type: blob.type || 'audio/mpeg' });
                    if (track.id) _localAudioFileCache.set(track.id, file);
                    _localAudioFileCache.set(track.name, file);
                    _currentPlayingTrack.file = file;
                    _currentPlayingTrack.url = trackUrl;
                    fromServer = true;
                }
            }
        }

        if (!audioReady && file) {
            await initAudio(file, false);
        }

        const buf = await getOrDecodeAudioBuffer(file, track.id);
        if (buf) {
            setBufferOnEngine(buf);
            if (inputStage) inputStage.analyzeBuffer(buf);
            controls.setHasTrack(true);
            if (file) saveLastAudio(file);
            _currentPlayingTrack.loading = false;
        }

        // Déverrouiller impérativement avant le démarrage de lecture
        _isSwitchingTrack = false;
        audioEngine.isLocked = false;
        controls.setPlaybackLocked(false);

        if (autoPlay) {
            audioEngine.seek(0);
            audioEngine.play(inputStage ? inputStage.input : crossover.input);
            controls.setPlayState(true);
            if (np) np.textContent = _currentPlayingTrack.name;
        } else {
            audioEngine.seek(0);
            controls.setPlayState(false);
            if (np) np.textContent = _currentPlayingTrack.name;
        }

        if (_mpReady && mp) {
            const isAlreadyOnServer = fromServer || Boolean(track.url) || Boolean(_currentPlayingTrack.url);
            if (file && !isAlreadyOnServer && (!track.id || track.id.startsWith('local_') || track.id.startsWith('q_'))) {
                mp.uploadAudioFile(file, _currentPlayingTrack.id).catch(e => console.warn('[MP] Track sync:', e));
            }
            mp.sendAction('seek', { currentTime: 0 });
            mp.sendTrackBufferReady();
        }
    } catch (err) {
        console.error('[Audio] Error loading track:', err);
    } finally {
        _isSwitchingTrack = false;
        audioEngine.isLocked = false;
        controls.setPlaybackLocked(false);
        if (_currentPlayingTrack) _currentPlayingTrack.loading = false;
        syncQueueToUI();
    }
}

async function playNextInQueue() {
    // En multijoueur : déléguer au serveur pour synchroniser instantanément toute la pièce
    if (_mpReady && mp && mp.roomId) {
        mp.sendQueueNext();
        return;
    }

    audioEngine.stop();
    audioEngine.seek(0);
    controls.setPlayState(false);

    // 1. Priorité absolue : File d'attente manuelle ("À suivre dans la file d'attente")
    if (_manualQueue.length > 0) {
        const next = _manualQueue.shift();
        await playTrack(next, true);
        syncQueueToUI();
        return;
    }

    // 2. File contextuelle locale ("À suivre")
    if (_contextQueue.length > 0) {
        const next = _contextQueue.shift();
        await playTrack(next, true);
        syncQueueToUI();
        return;
    }

    // 3. Bouclage de la playlist active si existante
    if (_contextPlaylistTracks.length > 0) {
        let upcoming = _contextPlaylistTracks.map(formatPlaylistTrackForQueue);
        if (_isShuffle) {
            upcoming = shuffleArray(upcoming);
        }
        const next = upcoming.shift();
        _contextQueue = upcoming;
        await playTrack(next, true);
        syncQueueToUI();
        return;
    }

    // Rien d'autre à jouer
    audioEngine.stop();
    audioEngine.seek(0);
    setBufferOnEngine(null);
    controls.setPlayState(false);
    controls.setHasTrack(false);
    _currentPlayingTrack = null;
    _currentAudioFileName = '';
    syncQueueToUI();
}

async function playPrevInQueue() {
    // Si on a joué plus de 3 secondes, recommencer le morceau actuel
    if (audioEngine.getCurrentTime() > 3) {
        audioEngine.seek(0);
        if (_mpReady && mp) mp.sendAction('seek', { currentTime: 0 });
        return;
    }

    // En multijoueur : déléguer au serveur
    if (_mpReady && mp && mp.roomId) {
        mp.sendQueuePrev();
        return;
    }

    audioEngine.stop();
    audioEngine.seek(0);
    controls.setPlayState(false);

    // Si une playlist contextuelle est active et qu'on a un morceau en cours
    if (_contextPlaylistTracks.length > 0 && _currentPlayingTrack) {
        const curIdx = findTrackIndexInPlaylist(_currentPlayingTrack, _contextPlaylistTracks);
        if (curIdx > 0) {
            const prevTrack = _contextPlaylistTracks[curIdx - 1];
            // Replacer le morceau actuel au tout début de la file contextuelle
            _contextQueue.unshift({ ..._currentPlayingTrack });
            await playTrack(prevTrack, true);
            syncQueueToUI();
            return;
        }
    }

    audioEngine.seek(0);
    if (_mpReady && mp) mp.sendAction('seek', { currentTime: 0 });
}

async function addFilesToQueue(files, playImmediatelyIfEmpty = false) {
    const list = Array.isArray(files) ? files : [files];
    const valid = list.filter(f => f && (f.type?.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a)$/i.test(f.name)));
    if (valid.length === 0) return;

    const items = valid.map(f => {
        const trackId = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        _localAudioFileCache.set(trackId, f);
        _localAudioFileCache.set(f.name, f);
        preloadAndDecodeAudio(f, trackId);
        return {
            id: trackId,
            name: f.name,
            file: f,
            loading: !(_decodedAudioBuffers.has(trackId) || _decodedAudioBuffers.has(f.name))
        };
    });

    if (_mpReady && mp && mp.roomId) {
        // En multijoueur : uploader les fichiers sur le serveur (le serveur diffuse la mise à jour à tous)
        for (const item of items) {
            mp.uploadAudioFile(item.file, item.id, true).catch(err => {
                console.warn('[Queue] Erreur upload fichier vers file multijoueur:', err);
            });
        }
        return;
    }

    const isIdle = !_currentPlayingTrack && !audioEngine.isPlaying && !audioEngine.buffer;
    if (isIdle || playImmediatelyIfEmpty) {
        const first = items.shift();
        if (items.length > 0) {
            _manualQueue.push(...items);
        }
        await playTrack(first, true);
    } else {
        _manualQueue.push(...items);
        syncQueueToUI();
    }
    startBackgroundPrefetch();
}

// ─── Playback & Spotify Queue Event Wiring ───────────────────────

// 1. Bouton Aléatoire (🔀)
controls.onShuffleToggle((isShuffle) => {
    _isShuffle = isShuffle;
    try {
        localStorage.setItem('soundstage3d:playback-shuffle', String(_isShuffle));
    } catch (_) {}

    if (_contextPlaylistTracks && _contextPlaylistTracks.length > 0 && _currentPlayingTrack) {
        const curIdx = findTrackIndexInPlaylist(_currentPlayingTrack, _contextPlaylistTracks);

        if (_isShuffle) {
            // Mode aléatoire activé : charger dans "À suivre" tous les autres morceaux de la playlist
            // (y compris ceux d'avant dans la playlist) dans le désordre
            const otherTracks = _contextPlaylistTracks
                .filter((_, idx) => curIdx !== -1 ? idx !== curIdx : true)
                .map(formatPlaylistTrackForQueue);
            _contextQueue = shuffleArray(otherTracks);
        } else {
            // Mode aléatoire désactivé : revenir aux derniers morceaux de la playlist qui suivent le morceau actuel
            if (curIdx !== -1) {
                _contextQueue = _contextPlaylistTracks.slice(curIdx + 1).map(formatPlaylistTrackForQueue);
            } else {
                _contextQueue = restoreContextQueueOrder(_contextQueue, _contextPlaylistTracks);
            }
        }
    } else if (_contextQueue.length > 0) {
        if (_isShuffle) {
            _contextQueue = shuffleArray(_contextQueue);
        } else {
            _contextQueue = restoreContextQueueOrder(_contextQueue, _contextPlaylistTracks);
        }
    }

    if (_mpReady && mp && mp.roomId) {
        mp.sendShuffleToggle(_isShuffle, _contextQueue);
    }

    syncQueueToUI();
    startBackgroundPrefetch();
});

// 2. Clic sur un morceau dans la vue Playlist -> lecture immédiate + génération de "À suivre"
controls.onPlaylistTrackPlay(async (playlistId, trackIndex, track) => {
    let pl = null;
    if (mp && mp.playlists) {
        pl = mp.playlists.find(p => p.id === playlistId);
    }
    if (!pl && controls._playlists) {
        pl = controls._playlists.find(p => p.id === playlistId);
    }

    _contextPlaylistId = playlistId;
    _contextPlaylistName = (pl && pl.name) ? pl.name : 'Playlist';
    _contextPlaylistTracks = (pl && Array.isArray(pl.tracks)) ? [...pl.tracks] : [];

    let upcoming = [];
    if (_contextPlaylistTracks.length > 0) {
        const clickedIdx = (trackIndex >= 0 && trackIndex < _contextPlaylistTracks.length)
            ? trackIndex
            : findTrackIndexInPlaylist(track, _contextPlaylistTracks);

        if (_isShuffle) {
            // En mode shuffle : charge dans "À suivre" tous les autres morceaux de la playlist (même ceux d'avant) dans le désordre
            const otherTracks = _contextPlaylistTracks
                .filter((_, idx) => idx !== clickedIdx)
                .map(formatPlaylistTrackForQueue);
            upcoming = shuffleArray(otherTracks);
        } else {
            // Sans shuffle : uniquement les derniers morceaux qui suivent dans la playlist
            const afterTracks = (clickedIdx >= 0)
                ? _contextPlaylistTracks.slice(clickedIdx + 1)
                : [];
            upcoming = afterTracks.map(formatPlaylistTrackForQueue);
        }
    }

    _contextQueue = upcoming;

    // Couper immédiatement l'ancien audio et réinitialiser à 0:00
    audioEngine.stop();
    audioEngine.seek(0);
    controls.setPlayState(false);
    _isSwitchingTrack = true;
    _isNewTrackStarting = true;
    audioEngine.isLocked = true;
    controls.setPlaybackLocked(true, '⏳ Chargement...');
    if (_mpReady && mp) mp.sendAction('seek', { currentTime: 0 });

    if (_mpReady && mp && mp.roomId) {
        _currentPlayingTrack = {
            id: track.id,
            name: track.name,
            url: track.url || `/audio/track/${track.id}`,
            uploadedBy: track.uploadedBy,
            file: _localAudioFileCache.get(track.id) || _localAudioFileCache.get(track.name) || null,
            loading: true
        };
        syncQueueToUI();
        mp.sendPlaylistLoad(playlistId, trackIndex, _isShuffle);
    } else {
        await playTrack(track, true);
    }
    startBackgroundPrefetch();
});

// 3. Bouton ➕ sur un morceau de playlist -> ajout UNIQUEMENT de ce morceau à la file manuelle prioritaire
controls.onPlaylistTrackAdd(async (track) => {
    const isDecoded = _decodedAudioBuffers.has(track.id) || _decodedAudioBuffers.has(track.name);
    const item = {
        id: track.id,
        name: track.name,
        url: track.url || `/audio/track/${track.id}`,
        uploadedBy: track.uploadedBy,
        file: _localAudioFileCache.get(track.id) || _localAudioFileCache.get(track.name) || null,
        loading: !isDecoded
    };

    if (_mpReady && mp && mp.roomId) {
        mp.sendManualQueueAdd(item);
        return;
    }

    if (!_currentPlayingTrack && !audioEngine.isPlaying && !audioEngine.buffer) {
        await playTrack(item, true);
    } else {
        _manualQueue.push(item);
        syncQueueToUI();
        startBackgroundPrefetch();
    }
});

// 4. Modification des morceaux dans la vue Playlist (réordonnancement / suppression)
controls.onPlaylistTracksChange((playlistId, tracks) => {
    if (_contextPlaylistId === playlistId) {
        _contextPlaylistTracks = [...tracks];
    }
});

// 4b. Ajout direct de fichiers audio dans la playlist sélectionnée (SANS toucher à la file d'attente)
controls.onPlaylistFilesAdd(async (playlistId, files) => {
    const list = Array.isArray(files) ? files : [files];
    const valid = list.filter(f => f && (f.type?.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a)$/i.test(f.name)));
    if (valid.length === 0) return;

    let pl = controls.getPlaylist(playlistId);
    if (!pl) return;
    if (!Array.isArray(pl.tracks)) pl.tracks = [];

    const isConnected = Boolean(_mpReady && mp);

    for (const f of valid) {
        const trackId = 't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        _localAudioFileCache.set(trackId, f);
        _localAudioFileCache.set(f.name, f);
        preloadAndDecodeAudio(f, trackId);

        const newTrack = {
            id: trackId,
            name: f.name,
            mime: f.type || 'audio/mpeg',
            url: `/audio/track/${trackId}`,
            uploadedBy: (isConnected && mp.clientId) ? mp.clientId : 'local',
            onServer: false,
            uploading: isConnected,
        };

        pl.tracks.push(newTrack);

        // Upload en arrière-plan vers le serveur pour persistance (sans l'ajouter à la file d'attente)
        if (isConnected) {
            mp.uploadAudioFile(f, trackId, false).then(() => {
                newTrack.uploading = false;
                newTrack.onServer = true;
                controls.notifyPlaylistTracksUpdated(playlistId);
                controls.triggerAutoSave();
            }).catch(err => {
                console.warn('[Playlist] Background upload track failed:', err);
                newTrack.uploading = false;
                newTrack.onServer = false;
                controls.notifyPlaylistTracksUpdated(playlistId);
                controls.triggerAutoSave();
            });
        }
    }

    controls.notifyPlaylistTracksUpdated(playlistId);
    controls.triggerAutoSave();

    if (_contextPlaylistId === playlistId) {
        _contextPlaylistTracks = [...pl.tracks];
        startBackgroundPrefetch();
    }
});

// 5. Actions sur la file manuelle prioritaire ("À suivre dans la file d'attente")
controls.onManualQueueClear(() => {
    if (_mpReady && mp && mp.roomId) {
        mp.sendManualQueueClear();
        return;
    }
    _manualQueue = [];
    syncQueueToUI();
    startBackgroundPrefetch();
});

controls.onManualQueueRemove((index) => {
    if (_mpReady && mp && mp.roomId) {
        mp.sendManualQueueRemove(index);
        return;
    }
    if (index >= 0 && index < _manualQueue.length) {
        _manualQueue.splice(index, 1);
        syncQueueToUI();
        startBackgroundPrefetch();
    }
});

controls.onManualQueueReorder((fromIdx, toIdx) => {
    if (_mpReady && mp && mp.roomId) {
        mp.sendManualQueueReorder(fromIdx, toIdx);
        return;
    }
    if (fromIdx >= 0 && fromIdx < _manualQueue.length && toIdx >= 0 && toIdx < _manualQueue.length) {
        const [moved] = _manualQueue.splice(fromIdx, 1);
        _manualQueue.splice(toIdx, 0, moved);
        syncQueueToUI();
        startBackgroundPrefetch();
    }
});

// 6. Actions sur la file contextuelle ("À suivre")
controls.onContextQueueSelect(async (index) => {
    if (_mpReady && mp && mp.roomId) {
        mp.sendContextQueueSelect(index);
        return;
    }
    if (index >= 0 && index < _contextQueue.length) {
        const selected = _contextQueue[index];
        _contextQueue = _contextQueue.slice(index + 1);
        _isSwitchingTrack = true;
        _isNewTrackStarting = true;
        audioEngine.stop();
        audioEngine.seek(0);
        controls.setPlayState(false);
        audioEngine.isLocked = true;
        controls.setPlaybackLocked(true, '⏳ Chargement...');
        await playTrack(selected, true);
        startBackgroundPrefetch();
    }
});

controls.onContextQueueRemove((index) => {
    if (_mpReady && mp && mp.roomId) {
        mp.sendContextQueueRemove(index);
        return;
    }
    if (index >= 0 && index < _contextQueue.length) {
        _contextQueue.splice(index, 1);
        syncQueueToUI();
        startBackgroundPrefetch();
    }
});

controls.onContextQueueReorder((fromIdx, toIdx) => {
    if (_mpReady && mp && mp.roomId) {
        mp.sendContextQueueReorder(fromIdx, toIdx);
        return;
    }
    if (fromIdx >= 0 && fromIdx < _contextQueue.length && toIdx >= 0 && toIdx < _contextQueue.length) {
        const [moved] = _contextQueue.splice(fromIdx, 1);
        _contextQueue.splice(toIdx, 0, moved);
        syncQueueToUI();
        startBackgroundPrefetch();
    }
});

// 7. Navigation Précédent / Suivant
controls.onPrev(async () => {
    if (!audioReady || _isSwitchingTrack || audioEngine.isLocked) return;
    await playPrevInQueue();
});

controls.onNext(async () => {
    if (!audioReady || _isSwitchingTrack || audioEngine.isLocked) return;
    await playNextInQueue();
});

// 8. Gestion des playlists sur le serveur
controls.onPlaylistLoad(async (playlistId) => {
    let pl = null;
    if (mp && mp.playlists) {
        pl = mp.playlists.find(p => p.id === playlistId);
    }
    if (!pl && controls._playlists) {
        pl = controls._playlists.find(p => p.id === playlistId);
    }
    if (!pl && controls.getPlaylist) {
        pl = controls.getPlaylist(playlistId);
    }

    // Déterminer l'index de départ : si shuffle activé et playlist > 1 morceau, commencer par un morceau aléatoire
    const trackCount = (pl && Array.isArray(pl.tracks)) ? pl.tracks.length : (pl && typeof pl.trackCount === 'number' ? pl.trackCount : 0);
    const startIndex = (_isShuffle && trackCount > 1) ? Math.floor(Math.random() * trackCount) : 0;

    if (_mpReady && mp && mp.roomId) {
        mp.sendPlaylistLoad(playlistId, startIndex, _isShuffle);
        return;
    }

    // Solo mode: couper immédiatement l'ancien audio, réinitialiser à 0:00 et verrouiller
    _isSwitchingTrack = true;
    _isNewTrackStarting = true;
    audioEngine.stop();
    audioEngine.seek(0);
    controls.setPlayState(false);
    audioEngine.isLocked = true;
    controls.setPlaybackLocked(true, '⏳ Chargement...');

    if (pl && Array.isArray(pl.tracks) && pl.tracks.length > 0) {
        _contextPlaylistId = pl.id;
        _contextPlaylistName = pl.name || 'Playlist';
        _contextPlaylistTracks = [...pl.tracks];
        const chosenTrack = pl.tracks[startIndex];
        if (_isShuffle) {
            const others = pl.tracks.filter((_, idx) => idx !== startIndex).map(formatPlaylistTrackForQueue);
            _contextQueue = shuffleArray(others);
        } else {
            _contextQueue = pl.tracks.slice(startIndex + 1).map(formatPlaylistTrackForQueue);
        }
        await playTrack(chosenTrack, true);
    }
});

controls.onPlaylistSave((name, playlistId, tracks) => {
    if (_mpReady) {
        mp.sendPlaylistSave(name, playlistId, tracks);
    }
});

controls.onPlaylistRename((playlistId, newName) => {
    if (_mpReady) {
        mp.sendPlaylistRename(playlistId, newName);
    }
});

controls.onPlaylistDelete((playlistId) => {
    if (_mpReady) {
        mp.sendPlaylistDelete(playlistId);
    }
});

controls.onPlaylistRefresh(async () => {
    if (_mpReady && mp) {
        mp.requestPlaylists();
    }
    await loadServerPlaylists();
});

controls.onPlaylistQueueAll(async (playlistId) => {
    const pl = controls.getPlaylist(playlistId);
    if (!pl || !Array.isArray(pl.tracks) || pl.tracks.length === 0) return;

    if (_mpReady && mp && mp.roomId) {
        mp.sendManualQueueAddBatch(pl.tracks);
        const np = document.getElementById('now-playing');
        if (np) {
            const old = np.textContent;
            np.textContent = `➕ ${pl.tracks.length} morceau(x) de "${pl.name}" ajoutés à la suite !`;
            setTimeout(() => { if (np.textContent.includes('ajoutés')) np.textContent = old; }, 3000);
        }
        return;
    }

    const itemsToAdd = [];
    for (const track of pl.tracks) {
        const isDecoded = _decodedAudioBuffers.has(track.id) || _decodedAudioBuffers.has(track.name);
        itemsToAdd.push({
            id: track.id,
            name: track.name,
            file: _localAudioFileCache.get(track.id) || _localAudioFileCache.get(track.name) || track.file || null,
            url: track.url || (track.id ? `/audio/track/${track.id}` : null),
            uploadedBy: track.uploadedBy || (_mpReady && mp && mp.clientId ? mp.clientId : 'local'),
            loading: !isDecoded,
        });
    }

    const isIdle = !_currentPlayingTrack && !audioEngine.isPlaying && !audioEngine.buffer;
    if (isIdle) {
        const first = itemsToAdd.shift();
        if (itemsToAdd.length > 0) {
            _manualQueue.push(...itemsToAdd);
        }
        await playTrack(first, true);
    } else {
        _manualQueue.push(...itemsToAdd);
        syncQueueToUI();
    }
    startBackgroundPrefetch();

    const np = document.getElementById('now-playing');
    if (np) {
        const old = np.textContent;
        np.textContent = `➕ ${pl.tracks.length} morceau(x) de "${pl.name}" ajoutés à la suite !`;
        setTimeout(() => { if (np.textContent.includes('ajoutés')) np.textContent = old; }, 3000);
    }
});

controls.onQueueAdd(async (files) => {
    await addFilesToQueue(files, false);
});

controls.onChangeMp3(async (file) => {
    if (audioEngine.isPlaying || _manualQueue.length > 0 || _contextQueue.length > 0 || audioEngine.buffer) {
        await addFilesToQueue(file, false);
    } else {
        await addFilesToQueue(file, true);
    }
});

// Drag & drop support anywhere on the page: multi-files queueing
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
    e.preventDefault();
    // Si déposé directement dans la section playlist, le drop est géré spécifiquement pour la playlist (sans toucher à la file d'attente)
    if (e.target && e.target.closest && e.target.closest('#pb-pl-section')) {
        return;
    }
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) {
        await addFilesToQueue(files, false);
    }
});


controls.onGrassChange((distance) => {
    setGrassQuality(distance);
});

// ─── Camera View HUD Toggle is handled via controls.onCameraToggle and listener.cycleCameraMode ───

// ─── FFT Frequency Spectrum Visualizer (Headphone Output) ───
const spectrumCanvas = document.getElementById('spectrum-visualizer');
const spectrumCtx = spectrumCanvas ? spectrumCanvas.getContext('2d') : null;
let spectrumRunning = false;
let spectrumAnimId = null;

function spectrumStart() {
    if (!audioReady || !spectrumCanvas || !spectrumCtx) return;
    spectrumCanvas.classList.remove('hidden');
    const analyser = speakerSystem.getHeadphoneAnalyser();
    const binCount = analyser.frequencyBinCount;
    const freqData = new Float32Array(binCount);
    const sampleRate = speakerSystem.ctx.sampleRate;
    const W = spectrumCanvas.width;
    const H = spectrumCanvas.height;

    // Peak hold memory for each horizontal pixel column
    const peakY = new Float32Array(W).fill(H);
    const peakDecaySpeed = 0.6; // pixels dropped per frame

    spectrumRunning = true;

    // Precalculate frequency for each pixel column (logarithmic: 20 Hz to 20 kHz)
    const minFreq = 20;
    const maxFreq = 20000;
    const logMin = Math.log10(minFreq);
    const logMax = Math.log10(maxFreq);
    const logRange = logMax - logMin;

    const colFreqs = new Float32Array(W);
    const colBins = new Float32Array(W);
    for (let x = 0; x < W; x++) {
        const f = minFreq * Math.pow(maxFreq / minFreq, x / (W - 1));
        colFreqs[x] = f;
        colBins[x] = (f * analyser.fftSize) / sampleRate;
    }

    // Grid frequencies to label
    const gridFreqs = [
        { f: 20, label: '20' },
        { f: 50, label: '50' },
        { f: 100, label: '100' },
        { f: 250, label: '250' },
        { f: 500, label: '500' },
        { f: 1000, label: '1k' },
        { f: 2000, label: '2k' },
        { f: 5000, label: '5k' },
        { f: 10000, label: '10k' },
        { f: 20000, label: '20k' },
    ];

    // Additional intermediate ticks without labels
    const tickFreqs = [
        30, 40, 60, 70, 80, 90,
        150, 200, 300, 400, 600, 700, 800, 900,
        1500, 3000, 4000, 6000, 7000, 8000, 9000,
        12000, 15000, 18000
    ];

    // dB grid lines (-84 dB to 0 dB)
    const minDb = -84;
    const maxDb = 0;
    const dbRange = maxDb - minDb;
    const gridDbs = [0, -12, -24, -36, -48, -60, -72];

    const paddingTop = 24;
    const paddingBottom = 20;
    const usableH = H - paddingTop - paddingBottom;

    function draw() {
        if (!spectrumRunning) return;
        spectrumAnimId = requestAnimationFrame(draw);

        analyser.getFloatFrequencyData(freqData);

        spectrumCtx.clearRect(0, 0, W, H);

        // 1. Draw horizontal dB grid lines & labels
        spectrumCtx.lineWidth = 1;
        spectrumCtx.font = '9px monospace';
        for (const db of gridDbs) {
            const normY = (maxDb - db) / dbRange;
            const y = paddingTop + normY * usableH;

            spectrumCtx.strokeStyle = db === 0 ? 'rgba(255, 70, 70, 0.45)' : 'rgba(255, 255, 255, 0.08)';
            spectrumCtx.beginPath();
            spectrumCtx.moveTo(0, y);
            spectrumCtx.lineTo(W, y);
            spectrumCtx.stroke();

            spectrumCtx.fillStyle = db === 0 ? 'rgba(255, 90, 90, 0.7)' : 'rgba(255, 255, 255, 0.30)';
            spectrumCtx.textAlign = 'right';
            spectrumCtx.fillText(`${db} dB`, W - 6, y - 3);
        }

        // 2. Draw vertical frequency ticks & grid lines
        for (const tf of tickFreqs) {
            const x = ((Math.log10(tf) - logMin) / logRange) * W;
            spectrumCtx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
            spectrumCtx.beginPath();
            spectrumCtx.moveTo(x, paddingTop);
            spectrumCtx.lineTo(x, H - paddingBottom);
            spectrumCtx.stroke();
        }

        for (const gf of gridFreqs) {
            const x = ((Math.log10(gf.f) - logMin) / logRange) * W;
            spectrumCtx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            spectrumCtx.beginPath();
            spectrumCtx.moveTo(x, paddingTop);
            spectrumCtx.lineTo(x, H - paddingBottom);
            spectrumCtx.stroke();

            spectrumCtx.fillStyle = 'rgba(255, 255, 255, 0.50)';
            spectrumCtx.textAlign = 'center';
            spectrumCtx.fillText(gf.label, x, H - 6);
        }

        // 3. Compute spectrum Y coordinates across pixel columns
        let peakMaxDb = -120;
        let peakMaxFreq = 0;
        const colY = new Float32Array(W);

        for (let x = 0; x < W; x++) {
            const binFloat = colBins[x];
            const bin0 = Math.max(0, Math.min(binCount - 1, Math.floor(binFloat)));
            const bin1 = Math.min(binCount - 1, bin0 + 1);
            const frac = binFloat - bin0;

            const val = freqData[bin0] * (1 - frac) + freqData[bin1] * frac;
            if (val > peakMaxDb) {
                peakMaxDb = val;
                peakMaxFreq = colFreqs[x];
            }

            const clampedVal = Math.max(minDb, Math.min(maxDb, val));
            const normY = (maxDb - clampedVal) / dbRange;
            colY[x] = paddingTop + normY * usableH;

            // Update peak-hold line
            if (colY[x] < peakY[x]) {
                peakY[x] = colY[x];
            } else {
                peakY[x] = Math.min(H - paddingBottom, peakY[x] + peakDecaySpeed);
            }
        }

        // 4. Draw filled spectrum area with luminous multi-stop vertical gradient
        const grad = spectrumCtx.createLinearGradient(0, paddingTop, 0, H - paddingBottom);
        grad.addColorStop(0.00, 'rgba(0, 245, 255, 0.50)');  // Neon cyan
        grad.addColorStop(0.30, 'rgba(0, 160, 255, 0.35)');  // Electric blue
        grad.addColorStop(0.70, 'rgba(140, 50, 255, 0.20)'); // Electric violet
        grad.addColorStop(1.00, 'rgba(10, 15, 30, 0.02)');   // Transparent deep

        spectrumCtx.beginPath();
        spectrumCtx.moveTo(0, H - paddingBottom);
        for (let x = 0; x < W; x++) {
            spectrumCtx.lineTo(x, colY[x]);
        }
        spectrumCtx.lineTo(W, H - paddingBottom);
        spectrumCtx.closePath();
        spectrumCtx.fillStyle = grad;
        spectrumCtx.fill();

        // 5. Draw peak hold line
        spectrumCtx.beginPath();
        spectrumCtx.strokeStyle = 'rgba(255, 215, 60, 0.65)';
        spectrumCtx.lineWidth = 1.2;
        for (let x = 0; x < W; x++) {
            if (x === 0) spectrumCtx.moveTo(x, peakY[x]);
            else spectrumCtx.lineTo(x, peakY[x]);
        }
        spectrumCtx.stroke();

        // 6. Draw bright spectrum top stroke line
        spectrumCtx.beginPath();
        spectrumCtx.strokeStyle = '#00f0ff';
        spectrumCtx.lineWidth = 1.8;
        spectrumCtx.shadowColor = '#00f0ff';
        spectrumCtx.shadowBlur = 4;
        for (let x = 0; x < W; x++) {
            if (x === 0) spectrumCtx.moveTo(x, colY[x]);
            else spectrumCtx.lineTo(x, colY[x]);
        }
        spectrumCtx.stroke();
        spectrumCtx.shadowBlur = 0; // reset shadow

        // 7. Title badge & Peak readout
        spectrumCtx.fillStyle = '#00e5ff';
        spectrumCtx.font = 'bold 10px "SF Mono", monospace';
        spectrumCtx.textAlign = 'left';
        spectrumCtx.fillText('📊 RTA FFT • SORTIE CASQUE', 8, 15);

        if (peakMaxDb > -80) {
            const freqFmt = peakMaxFreq >= 1000 ? `${(peakMaxFreq / 1000).toFixed(1)} kHz` : `${Math.round(peakMaxFreq)} Hz`;
            spectrumCtx.fillStyle = '#ffdf60';
            spectrumCtx.textAlign = 'right';
            spectrumCtx.fillText(`Pic : ${freqFmt} (${peakMaxDb.toFixed(1)} dB)`, W - 60, 15);
        }
    }

    draw();
}

function spectrumStop() {
    spectrumRunning = false;
    if (spectrumAnimId) cancelAnimationFrame(spectrumAnimId);
    if (spectrumCanvas) spectrumCanvas.classList.add('hidden');
}

controls.onSpectrumToggle((enabled) => {
    if (enabled) spectrumStart(); else spectrumStop();
});

controls.onHrtfToggle((enabled) => {
    if (!audioReady) return;
    speakerSystem.setPanningModel(enabled ? 'HRTF' : 'equalpower');
});

controls.onHrtfBrightness((db) => {
    if (!audioReady) return;
    speakerSystem.setHrtfBrightness(db);
});

controls.onConesToggle((bus, visible) => {
    if (bus === 'all') {
        coneContainer.visible = visible;
        for (const g of Object.values(coneGroups)) g.visible = visible;
    } else if (coneGroups[bus]) {
        coneGroups[bus].visible = visible;
        // Ensure container is visible if any bus is on
        coneContainer.visible = Object.values(coneGroups).some(g => g.visible);
    }
});

controls.onMasterDsp((param, value) => {
    if (!audioReady || !speakerSystem) return;
    speakerSystem.setMasterDspParam(param, value);
    if (_mpReady && !controls._suppressMpSend) mp.sendDsp('master', param, value);
});

controls.onEnvDsp((param, value) => {
    if (!audioReady || !speakerSystem) return;
    speakerSystem.setEnvDspParam(param, value);
    if (_mpReady && !controls._suppressMpSend) mp.sendDsp('env', param, value);
});

controls.onUserDsp((param, value) => {
    if (param === 'mouse-sensitivity') {
        listener.setSensitivity(value / 100);
        return;
    }
    if (param === 'invert-y') {
        listener.setInvertPitch(value);
        return;
    }
    if (param === 'invert-x') {
        listener.setInvertYaw(value);
        return;
    }
    if (param === 'local-volume') {
        if (audioReady && speakerSystem) {
            speakerSystem.setLocalVolume(value);
        }
        return;
    }
    if (param === 'grass-distance') {
        setGrassQuality(value);
        return;
    }
});

controls.onInputDsp((param, value) => {
    if (!audioReady || !inputStage) return;
    inputStage.setParam(param, value);
    if (param === 'mic-volume' && micInput) {
        micInput.setVolume(value);
    }
    if (_mpReady && !controls._suppressMpSend) mp.sendDsp('input', param, value);
});

controls.onMicToggle(async () => {
    if (!audioReady || !micInput) {
        if (!audioReady) {
            await initAudio(null);
        }
    }
    if (micInput) {
        await micInput.toggle();
    }
});

controls.onSubDsp((param, value) => {
    if (!audioReady) return;
    speakerSystem.setSubDspParam(param, value, { crossover, effects });
    if (_mpReady && !controls._suppressMpSend) mp.sendDsp('sub', param, value);
});

controls.onMidDsp((param, value) => {
    if (!audioReady) return;
    speakerSystem.setMidDspParam(param, value, { crossover, effects });
    if (_mpReady && !controls._suppressMpSend) mp.sendDsp('mid', param, value);
});

controls.onTopDsp((param, value) => {
    if (!audioReady) return;
    speakerSystem.setTopDspParam(param, value, { crossover, effects });
    if (_mpReady && !controls._suppressMpSend) mp.sendDsp('top', param, value);
});

controls.onFillDsp((param, value) => {
    if (!audioReady) return;
    speakerSystem.setFillDspParam(param, value);
    if (_mpReady && !controls._suppressMpSend) mp.sendDsp('fill', param, value);
});

// ─── Pointer lock ↔ overlay management ──────────────────────────
listener.onLockChange((locked) => {
    if (!locked && audioReady) {
        // Show a small message, but don't go back to start screen
        // User can click canvas to re-lock
    }
});

// Re-lock on canvas click and ensure audio context is active
canvas.addEventListener('click', () => {
    // Si le panneau Ambiance est ouvert ou qu'un gizmo 3D est en cours de manipulation, ne pas verrouiller la souris
    if (ambiancePanel && (ambiancePanel.isOpen || ambiancePanel.isDraggingGizmo)) {
        return;
    }
    if (!audioReady) {
        initAudio();
    }
    if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
        audioEngine.ctx.resume();
    }
    if (!listener.isLocked) {
        listener.lock();
    }
});

// ─── Resize ──────────────────────────────────────────────────────
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Render loop ─────────────────────────────────────────────────
const clock = new THREE.Clock();
let _meterAccum = 0;
let _posAccum = 0;
let _pbAccum = 0;
const METER_INTERVAL = 1 / 15;  // ~15 fps for meters
const POS_INTERVAL = 1 / 10;    // ~10 fps for position text
const PB_INTERVAL = 1 / 10;     // ~10 fps for playback scrubber

// ─── Debug performance panel ────────────────────────────────────
const debugPanel = document.getElementById('debug-panel');
const debugContent = document.getElementById('debug-content');
const debugBtn = document.getElementById('debug-btn');
let _debugVisible = false;
debugBtn.addEventListener('click', () => {
    _debugVisible = !_debugVisible;
    debugPanel.classList.toggle('hidden', !_debugVisible);
    debugBtn.classList.toggle('active', _debugVisible);
    renderer.info.autoReset = !_debugVisible; // keep stats when debug is on
});
if (debugPanel) {
    makeDraggable(debugPanel, debugPanel, 'debug');
}

// ─── Hitbox visualizer ──────────────────────────────────────────
const hitboxBtn = document.getElementById('hitbox-btn');
const hitboxVisualizer = createHitboxVisualizer(scene);

function toggleHitboxes() {
    const isVis = hitboxVisualizer.toggle();
    if (hitboxBtn) {
        hitboxBtn.classList.toggle('active', isVis);
        hitboxBtn.textContent = isVis ? '📦 Hitbox: ON' : '📦 Hitbox: OFF';
    }
}

if (hitboxBtn) {
    hitboxBtn.addEventListener('click', toggleHitboxes);
}

if (listener) {
    listener.onToggleHitbox = toggleHitboxes;
}

// FPS & render performance tracking
let _debugAccum = 0;
let _frameCount = 0;
let _fps = 0;
let _frameTimeSum = 0;
let _frameTimeMax = 0;
let _frameTimeAvg = 0;
let _renderTimeSum = 0;
let _renderTimeMax = 0;
let _renderTimeAvg = 0;
const DEBUG_INTERVAL = 0.5; // refresh debug every 500ms

function updateFpsCounter(dt, renderMs = 0) {
    const dtMs = dt * 1000;
    _debugAccum += dt;
    _frameCount++;
    _frameTimeSum += dtMs;
    if (dtMs > _frameTimeMax) _frameTimeMax = dtMs;
    _renderTimeSum += renderMs;
    if (renderMs > _renderTimeMax) _renderTimeMax = renderMs;

    if (_debugAccum < DEBUG_INTERVAL) return;

    // Compute FPS & frame render stats
    _fps = Math.round(_frameCount / _debugAccum);
    _frameTimeAvg = _frameTimeSum / _frameCount;
    _renderTimeAvg = _renderTimeSum / _frameCount;

    // Always update the small FPS counter
    const fpsEl = document.getElementById('fps-counter');
    if (fpsEl) fpsEl.textContent = _fps + ' FPS';

    _debugAccum = 0;
    _frameCount = 0;
    _frameTimeSum = 0;
    _frameTimeMax = 0;
    _renderTimeSum = 0;
    _renderTimeMax = 0;
}

function updateDebug(dt) {

    // Renderer info (Three.js)
    const ri = renderer.info;
    const mem = ri.memory;
    const ren = ri.render;

    // Audio context info
    let audioLines = '';
    if (audioReady) {
        const ctx = audioEngine.context;
        const ss = speakerSystem._debugStats;
        const skipPct = ss.totalFrames > 0 ? ((ss.skippedFrames / ss.totalFrames) * 100).toFixed(0) : '0';
        audioLines =
`<span class="dbg-title">── AUDIO ──────────────────────</span>
  Context state    <span class="dbg-val">${ctx.state}</span>
  Sample rate      <span class="dbg-val">${ctx.sampleRate} Hz</span>
  Base latency     <span class="dbg-val">${(ctx.baseLatency * 1000).toFixed(1)} ms</span>
  Output latency   <span class="dbg-val">${(ctx.outputLatency * 1000).toFixed(1)} ms</span>
  Current time     <span class="dbg-val">${ctx.currentTime.toFixed(1)} s</span>
<span class="dbg-title">── SPEAKERS ───────────────────</span>
  Total speakers   <span class="dbg-val">${speakerSystem.speakers.length}</span>
  Updated/frame    <span class="dbg-val">${ss.updatedSpeakers} / ${speakerSystem.speakers.length}</span>  (stagger)
  Skipped frames   <span class="${skipPct > 50 ? 'dbg-val' : 'dbg-warn'}">${skipPct}%</span>  (dirty check)
  Panning model    <span class="dbg-val">${speakerSystem.speakers[0]?.panner.panningModel}</span>
  Spectre FFT      <span class="dbg-val">${spectrumRunning ? 'ON' : 'OFF'}</span>`;

        // Reset frame counters
        ss.skippedFrames = 0;
        ss.totalFrames = 0;
    }

    // JS Memory (Chrome only)
    let memLines = '';
    if (performance.memory) {
        const m = performance.memory;
        memLines =
`<span class="dbg-title">── JS MEMORY ──────────────────</span>
  Heap used        <span class="dbg-val">${(m.usedJSHeapSize / 1048576).toFixed(1)} MB</span>
  Heap total       <span class="dbg-val">${(m.totalJSHeapSize / 1048576).toFixed(1)} MB</span>
  Heap limit       <span class="dbg-val">${(m.jsHeapSizeLimit / 1048576).toFixed(0)} MB</span>
`;
    }

    // FPS color
    const fpsClass = _fps >= 55 ? 'dbg-val' : _fps >= 30 ? 'dbg-warn' : 'dbg-bad';
    const ftClass = _frameTimeAvg <= 8 ? 'dbg-val' : _frameTimeAvg <= 18 ? 'dbg-warn' : 'dbg-bad';
    const ftMaxClass = _frameTimeMax <= 16 ? 'dbg-val' : _frameTimeMax <= 33 ? 'dbg-warn' : 'dbg-bad';
    const vsyncHz = _frameTimeAvg > 0 ? Math.round(1000 / _frameTimeAvg) : 60;

    debugContent.innerHTML =
`<span class="dbg-title">── FRAME & PERFORMANCE ────────</span>
  FPS              <span class="${fpsClass}">${_fps}</span>
  Render (CPU)     <span class="dbg-val">${_renderTimeAvg.toFixed(2)} ms</span>
  Frame tick (rAF) <span class="${ftClass}">${_frameTimeAvg.toFixed(1)} ms</span>  (VSync ~${vsyncHz} Hz)
  Frame tick max   <span class="${ftMaxClass}">${_frameTimeMax.toFixed(1)} ms</span>
  Pixel ratio      <span class="dbg-val">${renderer.getPixelRatio()}</span>
  Resolution       <span class="dbg-val">${renderer.domElement.width}×${renderer.domElement.height}</span>
<span class="dbg-title">── THREE.JS RENDER ────────────</span>
  Draw calls       <span class="dbg-val">${ren.calls}</span>
  Triangles        <span class="dbg-val">${ren.triangles.toLocaleString()}</span>
  Points           <span class="dbg-val">${ren.points}</span>
  Lines            <span class="dbg-val">${ren.lines}</span>
<span class="dbg-title">── THREE.JS MEMORY ────────────</span>
  Geometries       <span class="dbg-val">${mem.geometries}</span>
  Textures         <span class="dbg-val">${mem.textures}</span>
${audioLines}
${memLines}`;

    if (!ri.autoReset) ri.reset();
}

let _lastFrameTime = performance.now();
const _dirLightOffset = new THREE.Vector3(30, 60, 40);

function renderFrame() {
    const now = performance.now();
    const realFrameMs = now - _lastFrameTime;
    _lastFrameTime = now;

    const dt = Math.min(clock.getDelta(), 0.1);

    // Update listener movement
    listener.update(dt);

    if (audioReady) {
        // Protection anti-microcoupure : si l'onglet est en arrière-plan (Alt+Tab) ou si un lagspike 3D survient (> 45ms),
        // on ne surcharge pas Web Audio avec des calculs spatiaux afin de garantir un flux audio continu sans saccade.
        const isTabHidden = document.hidden;
        const isLagSpike = realFrameMs > 45;
        if (!isTabHidden && !isLagSpike) {
            const ctx = audioEngine.context;
            listener._audioCtxTime = ctx.currentTime;
            listener.syncAudioListener(ctx.listener, ctx);
            speakerSystem.update(listener.position);
        }
    }

    // Update HUD (throttled)
    _posAccum += dt;
    if (_posAccum >= POS_INTERVAL) {
        _posAccum = 0;
        controls.updatePosition(listener.position, listener.distanceToFOH);
    }

    // ─── Multiplayer position + playback sync (throttled at 10 fps) ─
    if (_mpReady) {
        _mpPosAccum += dt;
        if (_mpPosAccum >= MP_POS_INTERVAL) {
            _mpPosAccum = 0;
            const pos = listener.position;
            // Use character heading (model direction) not camera yaw — gives correct avatar orientation
            const c3d = listener._character3D;
            let anim = 'idle';
            if (c3d?.currentDanceId) {
                anim = `dance:${c3d.currentDanceId}:${c3d.danceRestartCounter}`;
            } else {
                anim = c3d?.currentActionName || 'idle';
            }
            const onGround = c3d ? c3d.onGround : true;
            const heading = listener.heading;
            mp.sendPosition(pos.x, pos.y, pos.z, heading, anim, onGround, listener.isFlying);

            // Broadcast playback position so all players stay in sync
            if (audioReady && !_isSwitchingTrack && !_isNewTrackStarting && !audioEngine.isLocked && audioEngine.isPlaying) {
                mp.sendPlaybackSync(
                    audioEngine.getCurrentTime(),
                    audioEngine.isPlaying
                );
            }
        }

        // Update remote player avatars every frame with real dt
        if (playerAvatars) {
            // Get latest players list — onPlayersUpdate updates mp.players
            playerAvatars.update(mp.players, dt);
        }
    }

    // Update level meters only when audio is playing (throttled)
    const isAudioPlaying = audioReady && (audioEngine.isPlaying || (sineGenerator && sineGenerator.isPlaying));
    if (isAudioPlaying) {
        _meterAccum += dt;
        if (_meterAccum >= METER_INTERVAL) {
            _meterAccum = 0;
            const levels = speakerSystem.getLevels();
            controls.updateMeters(levels);
        }
    }

    // Update Playback Head Scrubber (throttled)
    _pbAccum += dt;
    if (_pbAccum >= PB_INTERVAL) {
        _pbAccum = 0;
        if (audioReady) {
            const hasActiveTrack = Boolean(_currentPlayingTrack);
            const curTime = hasActiveTrack ? audioEngine.getCurrentTime() : 0;
            const dur = hasActiveTrack ? audioEngine.getDuration() : 0;
            controls.updatePlayback(
                curTime,
                dur,
                audioEngine.isPlaying,
                (audioEngine.isPlaying && hasActiveTrack) ? _currentAudioFileName : '',
                hasActiveTrack
            );

            // Auto-advance track when reaching the end (si une file ou playlist est active)
            if (audioEngine.isPlaying && dur > 0 && curTime >= dur - 0.25 && !_isSwitchingTrack) {
                if (_manualQueue.length > 0 || _contextQueue.length > 0 || _contextPlaylistTracks.length > 0) {
                    _isSwitchingTrack = true;
                    playNextInQueue();
                } else {
                    audioEngine.stop();
                    audioEngine.seek(0);
                    setBufferOnEngine(null);
                    controls.setPlayState(false);
                    controls.setHasTrack(false);
                    _currentPlayingTrack = null;
                    _currentAudioFileName = '';
                    syncQueueToUI();
                    if (_mpReady && mp && mp.roomId) mp.sendQueueNext();
                }
            }
        }
    }

    // Sync skybox with camera position
    updateSkybox(skybox, camera);

    // Show/hide grass chunks near camera
    updateVegetation(camera);

    // Update dynamic shadow camera to follow player directly and smoothly
    if (dirLight && listener) {
        const lp = listener.position;
        dirLight.target.position.set(lp.x, lp.y, lp.z);
        dirLight.target.updateMatrixWorld();
        if (ambiancePanel && ambiancePanel.selectedEntry && ambiancePanel.selectedEntry.light === dirLight && (ambiancePanel.isDraggingGizmo || ambiancePanel.isOpen)) {
            _dirLightOffset.copy(dirLight.position).sub(lp);
        } else {
            dirLight.position.set(lp.x + _dirLightOffset.x, lp.y + _dirLightOffset.y, lp.z + _dirLightOffset.z);
        }
    }

    // Update Ambiance light markers animation
    if (ambiancePanel) {
        ambiancePanel.update(dt);
    }

    // Update all active lasers
    if (laserManager) {
        laserManager.updateAll(dt, clock.getElapsedTime());
    }

    // Update Hitbox Visualizer (player position)
    if (hitboxVisualizer && hitboxVisualizer.isVisible && listener) {
        hitboxVisualizer.update(listener.feetPosition);
    }

    // Render with CPU time benchmark
    const t0 = performance.now();
    renderer.render(scene, camera);
    const renderTime = performance.now() - t0;

    // Debug overlay (throttled internally)
    updateFpsCounter(dt, renderTime);
    if (_debugVisible) updateDebug(dt);
}

function animate() {
    requestAnimationFrame(animate);
    renderFrame();
}

animate();
